const User = require('../models/User');
const { getBotConfig, setBotConfig, deleteBotConfig } = require('../models/BotConfig');
const { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const path = require('path');
const { simulatePull, isArtifactCard, formatCardId, applyXpToEquippedArtifact } = require('../utils/cards');
const { cards } = require('../data/cards');

// Store active drops: drop ID -> { messageId, channelId, userId, expiresAt, card }
const activeDrops = new Map();
const messageCounts = new Map(); // channelId -> current message count towards next drop
const channelThresholds = new Map(); // channelId -> messages required for a drop
const processingDropClaims = new Map(); // dropId -> processing userId (claim in-progress)
let messageListener = null;

// Global decay timer (reduces message count each minute)
let dropIntervalTimer = null;
// Set of configured drop channel IDs
const configuredDropChannels = new Set();
let dropsClient = null; // Discord client reference

async function loadDropChannelIds() {
  try {
    const channels = await getBotConfig('dropChannels');
    if (Array.isArray(channels)) {
      return channels.map(c => ({
        channelId: c.channelId,
        threshold: typeof c.threshold === 'number' ? c.threshold : 100,
        progress: typeof c.progress === 'number' ? c.progress : 0
      }));
    }
  } catch (err) {
    console.error('Error loading drop config from DB:', err);
  }
  return [];
}

async function saveDropChannelIds(channelConfigs) {
  try {
    let channels = [];
    if (Array.isArray(channelConfigs)) {
      if (channelConfigs.length && typeof channelConfigs[0] === 'string') {
        channels = channelConfigs.map(cid => ({ channelId: cid, threshold: channelThresholds.get(cid) || 100, progress: messageCounts.get(cid) || 0 }));
      } else {
        channels = channelConfigs.map(c => {
          if (typeof c === 'string') return { channelId: c, threshold: channelThresholds.get(c) || 100, progress: messageCounts.get(c) || 0 };
          return { channelId: c.channelId, threshold: typeof c.threshold === 'number' ? c.threshold : (channelThresholds.get(c.channelId) || 100), progress: typeof c.progress === 'number' ? c.progress : (messageCounts.get(c.channelId) || 0) };
        });
      }
    } else {
      channels = Array.from(configuredDropChannels).map(cid => ({ channelId: cid, threshold: channelThresholds.get(cid) || 100, progress: messageCounts.get(cid) || 0 }));
    }
    // If the provided list looks like a full replacement of current in-memory
    // configured channels (matching length), perform a replace. Otherwise
    // merge with existing DB entries to avoid accidentally overwriting
    // other configured channels from concurrent operations.
    const isFullReplace = Array.isArray(channels) && channels.length === configuredDropChannels.size;
    if (isFullReplace) {
      await setBotConfig('dropChannels', channels);
    } else {
      // Merge with existing DB entries
      const existing = await loadDropChannelIds().catch(() => []);
      const map = new Map();
      for (const e of existing) map.set(e.channelId, e);
      for (const c of channels) map.set(c.channelId, c);
      await setBotConfig('dropChannels', Array.from(map.values()));
    }
  } catch (err) {
    console.error('Error saving drop config to DB:', err);
  }
}

async function createAttachmentFromUrl(url) {
  if (!url) return null;
  try {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    let fileName;
    try {
      fileName = path.basename(new URL(url).pathname) || 'image.png';
    } catch {
      fileName = 'image.png';
    }
    if (!path.extname(fileName)) {
      const contentType = response.headers.get('content-type');
      if (contentType) {
        if (contentType.includes('png')) fileName += '.png';
        else if (contentType.includes('gif')) fileName += '.gif';
        else if (contentType.includes('jpeg') || contentType.includes('jpg')) fileName += '.jpg';
      }
    }
    return new AttachmentBuilder(buffer, { name: fileName });
  } catch (err) {
    console.error('[drops] createAttachmentFromUrl error for', url, err && err.message ? err.message : err);
    return null;
  }
}

async function clearDropChannelIds() {
  try {
    await deleteBotConfig('dropChannels');
  } catch (err) {
    console.error('Error clearing drop config from DB:', err);
  }
}

/**
 * Initialize drops system - call this from index.js with client
 */
async function initializeDrops(client) {
  dropsClient = client;
  if (!client) return;

  const savedChannels = await loadDropChannelIds();
  if (Array.isArray(savedChannels) && savedChannels.length) {
    for (const entry of savedChannels) {
      try {
        // entry: { channelId, threshold, progress }
        await startDropTimer(client, entry.channelId, entry.threshold, entry.progress || 0, true);
        console.log(`Resumed card drops in channel ${entry.channelId} (threshold=${entry.threshold})`);
      } catch (err) {
        console.error('Unable to resume saved drop channel:', entry.channelId, err.message || err);
      }
    }
  }
}

/**
 * Validate a configured drops channel before starting the timer.
 */
async function validateDropsChannel(client, channelId) {
  if (!client || !channelId) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || (typeof channel.isTextBased === 'function' && !channel.isTextBased())) return null;
    return channel;
  } catch {
    return null;
  }
}

/**
 * Spawn a single drop card in the configured channel
 */
async function _spawnDrop(channelId) {
  if (!dropsClient || !channelId) return;

  try {
    const channel = await validateDropsChannel(dropsClient, channelId);
    if (!channel) {
      console.error(`Error spawning drop: channel ${channelId} is inaccessible or not a text channel. Skipping spawn (channel kept in config).`);
      // Only remove from in-memory set to stop spawning; do NOT save so the
      // channel persists in DB and is retried on next bot restart.
      configuredDropChannels.delete(channelId);
      messageCounts.delete(channelId);
      channelThresholds.delete(channelId);
      return;
    }

    // Choose rank using drop-specific distribution (DROP-only rates)
    const dropRates = [
      ['D', 20],
      ['C', 20],
      ['B', 20],
      ['A', 20],
      ['S', 18],
      ['SS', 1.9],
      ['UR', 0.1]
    ];
    const totalRate = dropRates.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * totalRate;
    let chosenRank = dropRates[dropRates.length - 1][0];
    for (const [rk, wt] of dropRates) {
      r -= wt;
      if (r <= 0) {
        chosenRank = rk;
        break;
      }
    }

    // Prefer non-artifact, non-ship pullable cards of the chosen rank
    let pool = cards.filter(c => c.pullable && !c.artifact && !c.ship && c.rank === chosenRank);
    if (!pool.length) {
      // fallback to any non-artifact non-ship pullable card
      pool = cards.filter(c => c.pullable && !c.artifact && !c.ship);
    }
    if (!pool.length) {
      // ultimate fallback: any non-artifact pullable card
      pool = cards.filter(c => c.pullable && !c.artifact);
    }
    if (!pool.length) return;
    const card = pool[Math.floor(Math.random() * pool.length)];

    const dropId = `drop_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const claimButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`drop_claim:${dropId}`)
        .setLabel('Claim Card')
        .setStyle(ButtonStyle.Secondary)
    );

    const displayEmoji = card && card.ship ? '' : (card && card.emoji ? `${card.emoji} ` : '');
    const dropContent = `A wild **${displayEmoji}${card.character} (${card.rank})** appeared! \`${formatCardId(card.id)}\``;
    const imageUrl = card.image_url;
    let msg;

    if (imageUrl) {
      // Prefer plain message with an attachment where possible. If attachment
      // creation fails (e.g., remote host restrictions), fall back to including
      // the raw URL in the message content so Discord can unfurl it.
      const imageAttachment = await createAttachmentFromUrl(imageUrl).catch(() => null);
      if (imageAttachment) {
        msg = await channel.send({ content: dropContent, components: [claimButton], files: [imageAttachment] });
      } else {
        msg = await channel.send({ content: `${dropContent}\n${imageUrl}`, components: [claimButton] });
      }
    } else {
      msg = await channel.send({ content: dropContent, components: [claimButton] });
    }

    // Store drop info with 10-minute expiration
    const expiresAt = Date.now() + 600000; // 10 minutes
    activeDrops.set(dropId, {
      messageId: msg.id,
      channelId: channel.id,
      card,
      expiresAt
    });

    // Auto-cleanup after 10 minutes
    setTimeout(() => {
      const drop = activeDrops.get(dropId);
      if (drop) {
        try {
          msg.edit({ components: [] }).catch(() => {}); // Remove button
        } catch {}
        activeDrops.delete(dropId);
      }
    }, 600000);
  } catch (err) {
    console.error('Error spawning drop:', err);
  }
}

/**
 * Start the drop spawning timer
 */
async function startDropTimer(client, channelId, threshold = 100, initialProgress = 0, skipPersist = false) {
  const channel = await validateDropsChannel(client, channelId);
  if (!channel) {
    throw new Error('Unable to access drops channel. Make sure the bot has view/send permission in that channel.');
  }

  dropsClient = client;

  // add channel to configured set and persist
  configuredDropChannels.add(channelId);
  // set threshold & initial progress if not present
  channelThresholds.set(channelId, Number.isFinite(Number(threshold)) ? Number(threshold) : 100);
  if (!messageCounts.has(channelId)) {
    messageCounts.set(channelId, Number.isFinite(Number(initialProgress)) ? Number(initialProgress) : 0);
  }
  // persist full channel configs (skip during bot startup to avoid overwriting saved config with partial list)
  if (!skipPersist) {
    saveDropChannelIds(Array.from(configuredDropChannels).map(cid => ({ channelId: cid, threshold: channelThresholds.get(cid) || 100, progress: messageCounts.get(cid) || 0 }))).catch(() => {});
  }

  // ensure previous listener cleared before attaching a new one
  try {
    if (!messageListener) {
      messageListener = (message) => {
        try {
          if (!message || !message.channel) return;
          const cid = message.channel.id;
          if (!configuredDropChannels.has(cid)) return;
          if (message.author && message.author.bot) return;
          const cur = messageCounts.get(cid) || 0;
          const next = cur + 1;
          // Update counter
          messageCounts.set(cid, next);
          // Threshold for this channel
          const thresh = channelThresholds.get(cid) || 100;
          if (next >= thresh) {
            const times = Math.floor(next / thresh);
            messageCounts.set(cid, next - (times * thresh));
            for (let i = 0; i < times; i++) {
              // fire-and-forget spawn for this channel
              _spawnDrop(cid).catch(() => {});
            }
          }
        } catch (err) {
          console.error('Error in drop message listener:', err);
        }
      };
      if (dropsClient && typeof dropsClient.on === 'function') {
        dropsClient.on('messageCreate', messageListener);
      }
    }
  } catch (err) {}

  // Timer: every minute, add 1 to each configured channel's progress (counts toward next drop)
  if (!dropIntervalTimer) {
    dropIntervalTimer = setInterval(() => {
      try {
        for (const cid of Array.from(configuredDropChannels)) {
          try {
            const cur = messageCounts.get(cid) || 0;
            const next = cur + 1;
            messageCounts.set(cid, next);
            const thresh = channelThresholds.get(cid) || 100;
            if (next >= thresh) {
              const times = Math.floor(next / thresh);
              messageCounts.set(cid, next - (times * thresh));
              for (let i = 0; i < times; i++) {
                _spawnDrop(cid).catch(() => {});
              }
            }
          } catch (e) {
            // ignore per-channel errors
          }
        }
      } catch (err) {
        // ignore
      }
    }, 60000);
  }

  return true;
}

/**
 * Stop the drop spawning timer
 */
function stopDropTimer(channelId = null) {
  if (channelId) {
    // remove single channel from configured set
    configuredDropChannels.delete(channelId);
    // persist remaining channels with their thresholds/progress
    saveDropChannelIds(Array.from(configuredDropChannels).map(cid => ({ channelId: cid, threshold: channelThresholds.get(cid) || 100, progress: messageCounts.get(cid) || 0 }))).catch(() => {});
    // remove in-memory entries
    messageCounts.delete(channelId);
    channelThresholds.delete(channelId);
    // if no more channels configured, stop all listeners/timers
    if (configuredDropChannels.size === 0) {
      stopDropTimer();
    }
    return;
  }

  if (dropIntervalTimer) {
    clearInterval(dropIntervalTimer);
    dropIntervalTimer = null;
  }
  // Remove any attached message listener
  try {
    if (messageListener && dropsClient && typeof dropsClient.off === 'function') {
      dropsClient.off('messageCreate', messageListener);
    }
  } catch (err) {}
  messageListener = null;

  configuredDropChannels.clear();
  messageCounts.clear();
  clearDropChannelIds().catch(() => {});
}

/**
 * Handle drop claim button
 */
async function handleDropClaim(interaction, dropId) {
  // If another user is currently processing this drop, tell the caller who
  // is claiming it (treat in-progress as effectively claimed for UX clarity).
  if (processingDropClaims.has(dropId)) {
    const claimerId = processingDropClaims.get(dropId);
    let claimerName = 'Someone';
    try {
      if (dropsClient && dropsClient.users) {
        const u = await dropsClient.users.fetch(claimerId);
        if (u && u.username) claimerName = u.username;
      }
    } catch (e) {}
    return interaction.reply({ content: `**${claimerName}** already claimed this drop.`, ephemeral: true });
  }

  // Lock this drop for processing by this user
  processingDropClaims.set(dropId, interaction.user.id);

  const drop = activeDrops.get(dropId);

  if (!drop) {
    processingDropClaims.delete(dropId);
    return interaction.reply({ content: 'This drop has expired or was already claimed.', ephemeral: true });
  }

  // Check if drop has expired
  if (Date.now() > drop.expiresAt) {
    activeDrops.delete(dropId);
    processingDropClaims.delete(dropId);
    return interaction.reply({ content: 'This drop has expired.', ephemeral: true });
  }

  // If another earlier claim already marked this drop, show friendly message
  if (drop.claimedBy && drop.claimedBy !== interaction.user.id) {
    let claimerName = 'Someone';
    try { if (dropsClient && dropsClient.users) { const u = await dropsClient.users.fetch(drop.claimedBy); if (u && u.username) claimerName = u.username; } } catch (e) {}
    processingDropClaims.delete(dropId);
    return interaction.reply({ content: `**${claimerName}** already claimed this drop.`, ephemeral: true });
  }

  // Mark as claimed by this user immediately to avoid races
  try {
    drop.claimedBy = interaction.user.id;
    activeDrops.set(dropId, drop);
  } catch (e) {}

  try {
    const user = await User.findOne({ userId: interaction.user.id });

    if (!user) {
      return interaction.reply({
        content: 'You need an account first. Run `/start` to register.',
        ephemeral: true
      });
    }

    const { card } = drop;

    // Check if user already owns this card at u1
    const existingEntry = user.ownedCards.find(e => e.cardId === card.id);

    if (existingEntry) {
      // Add XP as duplicate
      existingEntry.xp = (existingEntry.xp || 0) + 100;
      applyXpToEquippedArtifact(user, existingEntry, 100);
      const gained = Math.floor(existingEntry.xp / 100);
      if (gained > 0) {
        existingEntry.level = (existingEntry.level || 1) + gained;
        existingEntry.xp = existingEntry.xp % 100;
      }

      await user.save();

      const text = `**${card.character}** was already in your collection.\n\n+100 XP gained${gained ? ` (+${gained} lvl)` : ''}`;
      // mark drop consumed immediately
      activeDrops.delete(dropId);
      return interaction.reply({ content: text, ephemeral: true });
    } else {
      // Add new card
      user.ownedCards.push({ cardId: card.id, level: 1, xp: 0 });
      if (!user.history.includes(card.id)) {
        user.history.push(card.id);
      }

      await user.save();

      const text = `You got **${card.character}**!\n\nRank: ${card.rank}`;
      // mark drop consumed immediately
      activeDrops.delete(dropId);
      return interaction.reply({ content: text, ephemeral: true });
    }
  } catch (err) {
    console.error('Error claiming drop:', err);
    return interaction.reply({
      content: 'An error occurred while claiming the drop.',
      ephemeral: true
    });
  } finally {
    // Ensure the drop is removed and UI cleared; release processing lock
    try {
      activeDrops.delete(dropId);
    } catch {}
    try {
      const channel = await dropsClient.channels.fetch(drop.channelId);
      const msg = await channel.messages.fetch(drop.messageId);
      await msg.edit({ components: [] });
    } catch {}
    processingDropClaims.delete(dropId);
  }
}

/**
 * Spawn a number of drops immediately in a given channel (owner utility)
 */
async function spawnDrops(client, channelId, amount) {
  if (client) dropsClient = client;
  const channel = await validateDropsChannel(dropsClient, channelId);
  if (!channel) throw new Error('Unable to access drops channel');
  const toSpawn = Math.max(0, parseInt(amount, 10) || 0);
  for (let i = 0; i < toSpawn; i++) {
    // small delay to avoid hammering rate limits
    await _spawnDrop(channelId).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
  }
  return true;
}

module.exports = {
  initializeDrops,
  startDropTimer,
  stopDropTimer,
  handleDropClaim,
  spawnDrops,
  activeDrops,
  // Return a snapshot of configured channels and currently active drop messages
  getDropStatus: function() {
    const configured = Array.from(configuredDropChannels).map(cid => ({ channelId: cid, progress: messageCounts.get(cid) || 0, threshold: channelThresholds.get(cid) || 100 }));
    const actives = [];
    for (const [dropId, val] of activeDrops.entries()) {
      actives.push({
        dropId,
        channelId: val.channelId,
        messageId: val.messageId,
        expiresIn: Math.max(0, (val.expiresAt || 0) - Date.now()),
        cardName: val.card && val.card.character || null,
        rank: val.card && val.card.rank || null
      });
    }
    return { configured, actives };
  }
};
