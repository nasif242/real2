const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User = require('../models/User');
const { getCardById, formatCardId } = require('../utils/cards');
const { levelers } = require('../data/levelers');

// Local item display mapping (kept in sync with `commands/inventory.js`)
const ITEM_DISPLAY_NAMES = {
  red_shard: 'Red Shard',
  blue_shard: 'Blue Shard',
  green_shard: 'Green Shard',
  yellow_shard: 'Yellow Shard',
  purple_shard: 'Purple Shard'
};
const ITEM_DISPLAY_EMOJIS = {
  red_shard: '<:RedShard:1494106374492131439>',
  blue_shard: '<:Blueshard:1494106500149411980>',
  green_shard: '<:GreenShard:1494106686963581039>',
  yellow_shard: '<:YellowShard:1494106825627406530>',
  purple_shard: '<:PurpleShard:1494106958582776008>'
};

function parseMention(mention) {
  if (!mention) return null;
  const m = mention.match(/^<@!?(\d+)>$/);
  return m ? m[1] : null;
}

function shardCostForRank(rank) {
  switch ((rank || '').toUpperCase()) {
    case 'A': return 1;
    case 'S': return 2;
    case 'SS': return 3;
    case 'UR': return 4;
    default: return 0;
  }
}

function shardIdForAttribute(attr) {
  switch ((attr || '').toUpperCase()) {
    case 'DEX': return 'green_shard';
    case 'STR': return 'red_shard';
    case 'PSY': return 'yellow_shard';
    case 'QCK': return 'blue_shard';
    case 'INT': return 'purple_shard';
    default: return null;
  }
}

function findItemCount(items, itemId) {
  if (!Array.isArray(items)) return 0;
  const it = items.find(i => i.itemId === itemId);
  return it ? (it.quantity || 0) : 0;
}

function removeItem(items, itemId, count) {
  if (!Array.isArray(items) || count <= 0) return items;
  const idx = items.findIndex(i => i.itemId === itemId);
  if (idx === -1) return items;
  items[idx].quantity = (items[idx].quantity || 0) - count;
  if (items[idx].quantity <= 0) items.splice(idx, 1);
  return items;
}

function totalXpFromEntry(entry) {
  const lvl = (entry && typeof entry.level === 'number') ? entry.level : 1;
  const xp = (entry && typeof entry.xp === 'number') ? entry.xp : 0;
  // Treat each physical card copy as worth `level * 100 + xp` XP when
  // converting duplicates into XP. This makes a level 1 copy worth 100 XP
  // (matching duplicate rewards) and preserves higher-level progress.
  return (lvl * 100) + xp;
}

function applyIncomingEntryAsXp(user, incomingEntry) {
  if (!user || !incomingEntry) return false;
  user.ownedCards = user.ownedCards || [];
  const existing = user.ownedCards.find(e => e.cardId === incomingEntry.cardId);
  if (!existing) return false;
  const incomingXp = totalXpFromEntry(incomingEntry);
  existing.xp = (existing.xp || 0) + incomingXp;
  const gained = Math.floor(existing.xp / 100);
  if (gained > 0) {
    existing.level = (existing.level || 1) + gained;
    existing.xp = existing.xp % 100;
  }
  return true;
}

function cardHasArtifactEquipped(user, cardId) {
  if (!user || !Array.isArray(user.ownedCards) || !cardId) return false;
  return user.ownedCards.some(e => {
    const def = getCardById(e.cardId);
    return def && def.artifact && e.equippedTo === cardId;
  });
}

// Simple in-memory session map for pending trades
if (!global.tradeSessions) global.tradeSessions = new Map();

module.exports = {
  name: 'trade',
  description: 'Propose a trade: card-for-card or beli-for-card. Use `*` prefix for beli (e.g. *100)',
  options: [
    { name: 'offer', type: 3, description: 'Offered cardId or *<beli>', required: true },
    { name: 'want', type: 3, description: 'Requested cardId', required: true },
    { name: 'target', type: 6, description: 'Target user', required: true }
  ],

  async execute({ message, interaction, args }) {
    const initiatorId = message ? message.author.id : interaction.user.id;
    const initiatorName = message ? message.author.username : interaction.user.username;
    const rawOffer = message ? args[0] : interaction.options.getString('offer');
    const rawWant = message ? args[1] : interaction.options.getString('want');
    const mention = message ? args[2] : interaction.options.getUser('target')?.id;
    const targetId = message ? parseMention(mention) || mention : mention;

    if (!rawOffer || !rawWant || !targetId) {
      const reply = 'Usage: op trade <offer|*<beli>|<leveler>> <wanted|*<beli>|<leveler>> <@user>'; 
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    if (targetId === initiatorId) {
      const r = 'Cannot trade with yourself.';
      if (message) return message.reply(r);
      return interaction.reply({ content: r, ephemeral: true });
    }

    const initiator = await User.findOne({ userId: initiatorId });
    const target = await User.findOne({ userId: targetId });
    if (!initiator) return (message ? message.reply('You have no account.') : interaction.reply({ content: 'You have no account.', ephemeral: true }));
    if (!target) return (message ? message.reply('Target has no account.') : interaction.reply({ content: 'Target has no account.', ephemeral: true }));

    // helper to find a leveler by id or name (accept id or compact name without spaces)
    function findLeveler(query) {
      if (!query) return null;
      const q = String(query).toLowerCase().replace(/\s+/g, '');
      const exact = levelers.find(l => l.id.toLowerCase() === q || l.name.toLowerCase().replace(/\s+/g, '') === q || l.name.toLowerCase() === q);
      if (exact) return exact;
      // acronym match: first letter of each word e.g. "prp" → "Purple Robber Penguin"
      const acronym = levelers.find(l => l.name.toLowerCase().split(/\s+/).map(w => w[0] || '').join('') === q);
      return acronym || null;
    }

    // Build card acronym index once per trade invocation
    const { cards: allCards } = require('../data/cards');
    function getAcronym(name) {
      return String(name).toLowerCase().split(/\s+/).map(w => w[0] || '').join('');
    }

    function findCardByAcronym(query) {
      const q = query.toLowerCase();
      // Exact acronym match first
      const exact = allCards.filter(c => !c.artifact && !c.ship && !c.boost && getAcronym(c.character || '') === q);
      if (exact.length === 1) return exact[0];
      // If multiple exact matches, prefer non-ship/artifact (already filtered) — return first
      if (exact.length > 1) return exact[0];
      return null;
    }

    // Leveler class keywords matching feed command conventions
    const LEVELER_CLASSES = new Set(['str', 'qck', 'int', 'psy', 'dex', 'all']);

    function parseTradeItem(raw) {
      if (typeof raw === 'string' && raw.startsWith('*')) {
        const amt = parseInt(raw.slice(1).replace(/[^0-9]/g, ''), 10);
        if (isNaN(amt) || amt < 1) return null;
        return { kind: 'beli', amount: amt };
      }

      // Leveler class shorthand (STR, QCK, INT, PSY, DEX, ALL)
      if (typeof raw === 'string' && LEVELER_CLASSES.has(raw.toLowerCase())) {
        return { kind: 'leveler_class', attribute: raw.toUpperCase() };
      }

      // Strip optional trailing quantity (e.g. "prp10" → base="prp", qty=10)
      const qtyMatch = typeof raw === 'string' ? raw.match(/^([a-zA-Z_\-]+?)(\d+)$/) : null;
      const baseRaw = qtyMatch ? qtyMatch[1] : raw;
      const qty = qtyMatch ? parseInt(qtyMatch[2], 10) : 1;

      // leveler? (try both full raw and base)
      const levelerDef = findLeveler(raw) || (qtyMatch ? findLeveler(baseRaw) : null);
      if (levelerDef) return { kind: 'leveler', id: levelerDef.id, def: levelerDef, qty };

      // card by exact id/name?
      const cardDef = getCardById(raw) || (qtyMatch ? getCardById(baseRaw) : null);
      if (cardDef) return { kind: 'card', id: cardDef.id, def: cardDef, qty };

      // card by acronym (e.g. "prp" → purple robber penguin)
      const acronymCard = findCardByAcronym(baseRaw);
      if (acronymCard) return { kind: 'card', id: acronymCard.id, def: acronymCard, qty };

      return null;
    }

    const offered = parseTradeItem(rawOffer);
    const requested = parseTradeItem(rawWant);
    if (!offered || !requested) {
      const r = 'Unable to find offered or requested item. Use a card id/name, leveler id/name, or *<amount> for beli.';
      if (message) return message.reply(r);
      return interaction.reply({ content: r, ephemeral: true });
    }

    const sessionId = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const session = { id: sessionId, initiatorId, targetId, createdAt: Date.now() };

    // Validate ownership / funds depending on kinds
    // card <-> card
    if (offered.kind === 'card' && requested.kind === 'card') {
      const offeredEntry = (initiator.ownedCards || []).find(e => e.cardId === offered.id);
      if (!offeredEntry) {
        const r = `You do not own ${offered.def.emoji || ''} **${offered.def.character || offered.id}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      const targetEntry = (target.ownedCards || []).find(e => e.cardId === requested.id);
      if (!targetEntry) {
        const r = `Target does not own ${requested.def.emoji || ''} **${requested.def.character || requested.id}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      // Prevent trading cards that are on teams
      if ((initiator.team || []).includes(offered.id)) {
        const r = 'You must remove the offered card from your team before trading it.';
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if ((target.team || []).includes(requested.id)) {
        const r = 'Target must remove the requested card from their team before trading.';
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if (cardHasArtifactEquipped(target, requested.id)) {
        const r = 'Target must unequip any artifact attached to this card before trading.';
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if (cardHasArtifactEquipped(initiator, offered.id)) {
        const r = 'You must unequip any artifact attached to this card before trading.';
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }

      session.type = 'card_for_card';
      session.offered = { cardId: offered.id, entry: offeredEntry };
      session.requested = { cardId: requested.id, entry: targetEntry };

      // compute shard requirements for both sides (based on card attribute & rank)
      const offeredShardId = shardIdForAttribute(offered.def.attribute || '');
      const offeredShardCount = shardCostForRank(offered.def.rank || '');
      const requestedShardId = shardIdForAttribute(requested.def.attribute || '');
      const requestedShardCount = shardCostForRank(requested.def.rank || '');
      session.offeredShard = { shardId: offeredShardId, count: offeredShardCount };
      session.requestedShard = { shardId: requestedShardId, count: requestedShardCount };

      if (session.offeredShard.count > 0 && session.offeredShard.shardId) {
        const have = findItemCount(initiator.items || [], session.offeredShard.shardId);
        if (have < session.offeredShard.count) {
          const sname = ITEM_DISPLAY_NAMES[session.offeredShard.shardId] || session.offeredShard.shardId;
          const semoji = ITEM_DISPLAY_EMOJIS[session.offeredShard.shardId] || '';
          const r = `You need ${semoji} ${sname} x${session.offeredShard.count} to offer this card (you have ${have}).`;
          if (message) return message.reply(r);
          return interaction.reply({ content: r, ephemeral: true });
        }
      }
    }
    // beli <-> card (initiator beli buying card)
    else if (offered.kind === 'beli' && requested.kind === 'card') {
      const beliAmt = offered.amount;
      if ((initiator.balance || 0) < beliAmt) {
        const r = `You do not have ¥${beliAmt}.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      const targetEntry = (target.ownedCards || []).find(e => e.cardId === requested.id);
      if (!targetEntry) {
        const r = `Target does not own ${requested.def.emoji || ''} **${requested.def.character || requested.id}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if ((target.team || []).includes(requested.id)) {
        const r = 'Target must remove the requested card from their team before trading.';
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      session.type = 'beli_for_card';
      session.beli = beliAmt;
      session.requested = { cardId: requested.id, entry: targetEntry };
      // compute shard requirement for the requested card (buyer may need shards)
      const shardId = shardIdForAttribute(requested.def.attribute || '');
      const shardCount = shardCostForRank(requested.def.rank || '');
      if (shardCount > 0 && shardId) session.shardReq = { shardId, count: shardCount };
    }
    // card offered, requesting beli (reverse)
    else if (offered.kind === 'card' && requested.kind === 'beli') {
      const requestedAmt = requested.amount;
      const offeredEntry = (initiator.ownedCards || []).find(e => e.cardId === offered.id);
      if (!offeredEntry) {
        const r = `You do not own ${offered.def.emoji || ''} **${offered.def.character || offered.id}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if ((initiator.team || []).includes(offered.id)) {
        const r = 'You must remove the offered card from your team before trading it.';
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if (cardHasArtifactEquipped(initiator, offered.id)) {
        const r = 'You must unequip any artifact attached to this card before trading.';
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      session.type = 'card_for_beli';
      session.offered = { cardId: offered.id, entry: offeredEntry };
      session.requested = { beli: requestedAmt };
    }
    // leveler related trades (no shards)
    else if (offered.kind === 'beli' && requested.kind === 'leveler') {
      const amount = offered.amount;
      const qty = Math.max(1, requested.qty || 1);
      if ((initiator.balance || 0) < amount) {
        const r = `You do not have ¥${amount}.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      const item = (target.items || []).find(i => i.itemId === requested.id && (i.quantity || 0) >= qty);
      if (!item) {
        const r = `Target does not have ${qty}x **${requested.def.name}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      session.type = 'beli_for_leveler';
      session.beli = amount;
      session.qty = qty;
      session.requested = { levelerId: requested.id };
    }
    else if (offered.kind === 'leveler' && requested.kind === 'beli') {
      const qty = Math.max(1, offered.qty || 1);
      const item = (initiator.items || []).find(i => i.itemId === offered.id && (i.quantity || 0) >= qty);
      if (!item) {
        const r = `You do not have ${qty}x **${offered.def.name}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      session.type = 'leveler_for_beli';
      session.qty = qty;
      session.offered = { levelerId: offered.id };
      session.requested = { beli: requested.amount };
    }
    else if (offered.kind === 'leveler' && requested.kind === 'leveler') {
      const offeredQty = Math.max(1, offered.qty || 1);
      const requestedQty = Math.max(1, requested.qty || 1);
      const itemA = (initiator.items || []).find(i => i.itemId === offered.id && (i.quantity || 0) >= offeredQty);
      const itemB = (target.items || []).find(i => i.itemId === requested.id && (i.quantity || 0) >= requestedQty);
      if (!itemA) {
        const r = `You do not have ${offeredQty}x **${offered.def.name}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if (!itemB) {
        const r = `Target does not have ${requestedQty}x **${requested.def.name}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      session.type = 'leveler_for_leveler';
      session.offeredQty = offeredQty;
      session.requestedQty = requestedQty;
      session.offered = { levelerId: offered.id };
      session.requested = { levelerId: requested.id };
    }
    // leveler_class offered for beli: e.g. "trade STR *40 @user"
    else if (offered.kind === 'leveler_class' && requested.kind === 'beli') {
      const attr = offered.attribute;
      // Collect all levelers of this class from the initiator's inventory
      const isRainbow = l => typeof l.xp === 'object' && l.xp !== null;
      const matchingLevelers = levelers.filter(l => {
        if (attr === 'ALL') return true;
        if (isRainbow(l)) return false;
        return l.attribute === attr;
      });
      const snapshot = [];
      for (const def of matchingLevelers) {
        const it = (initiator.items || []).find(i => i.itemId === def.id && (i.quantity || 0) > 0);
        if (it) snapshot.push({ levelerId: def.id, name: def.name, emoji: def.emoji, qty: it.quantity });
      }
      if (!snapshot.length) {
        const r = `You have no ${attr === 'ALL' ? '' : attr + ' '}levelers to trade.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      session.type = 'leveler_class_for_beli';
      session.attribute = attr;
      session.snapshot = snapshot;
      session.requested = { beli: requested.amount };
    }
    // beli offered for leveler class: e.g. "trade *40 STR @user"
    else if (offered.kind === 'beli' && requested.kind === 'leveler_class') {
      const attr = requested.attribute;
      const isRainbow = l => typeof l.xp === 'object' && l.xp !== null;
      const matchingLevelers = levelers.filter(l => {
        if (attr === 'ALL') return true;
        if (isRainbow(l)) return false;
        return l.attribute === attr;
      });
      const snapshot = [];
      for (const def of matchingLevelers) {
        const it = (target.items || []).find(i => i.itemId === def.id && (i.quantity || 0) > 0);
        if (it) snapshot.push({ levelerId: def.id, name: def.name, emoji: def.emoji, qty: it.quantity });
      }
      if (!snapshot.length) {
        const r = `Target has no ${attr === 'ALL' ? '' : attr + ' '}levelers to trade.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if ((initiator.balance || 0) < offered.amount) {
        const r = `You do not have ¥${offered.amount}.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      session.type = 'beli_for_leveler_class';
      session.attribute = attr;
      session.snapshot = snapshot;
      session.beli = offered.amount;
    }
    else {
      const r = 'This combination of trade types is not supported.';
      if (message) return message.reply(r);
      return interaction.reply({ content: r, ephemeral: true });
    }

    // Build confirmation embed for target to accept/decline
    // Build user-friendly display strings from the parsed offer/request
    function formatItemDisplay(item) {
      if (!item) return 'Unknown';
      if (item.kind === 'beli') return `¥${(item.amount || 0).toLocaleString()}`;
      if (item.kind === 'leveler') {
        const qtyLabel = item.qty && item.qty > 1 ? `${item.qty}x ` : '';
        return `${qtyLabel}${item.def?.name || item.id} (leveler)`;
      }
      if (item.kind === 'leveler_class') {
        return `All ${item.attribute} levelers`;
      }
      if (item.kind === 'card') {
        const def = item.def || getCardById(item.id) || {};
        if (def.ship) return `${def.character || item.id} (ship) (${def.rank || ''})`;
        return `${def.emoji || ''} ${def.character || item.id} (${def.rank || ''})`;
      }
      return String(item.id || item.amount || item);
    }

    const offeredDisplay = formatItemDisplay(offered);
    const requestedDisplay = formatItemDisplay(requested);

    const embed = new EmbedBuilder()
      .setTitle('Trade Proposal')
      .setColor('#2b2d31')
      .setDescription(`<@${initiatorId}> proposes a trade to <@${targetId}>`)
      .addFields(
        { name: 'Offered', value: offeredDisplay, inline: true },
        { name: 'Requested', value: requestedDisplay, inline: true }
      )
      .setFooter({ text: 'Accept to complete the trade. Both users will have items updated.' });

    // For class-based leveler trades, show what's in the snapshot
    if (session.type === 'leveler_class_for_beli' || session.type === 'beli_for_leveler_class') {
      const snap = session.snapshot || [];
      const snapDisplay = snap.map(e => `${e.emoji || ''} **${e.name}** x${e.qty}`).join('\n') || 'None';
      embed.addFields({ name: `Levelers (${session.attribute})`, value: snapDisplay, inline: false });
    }

    // If this is a card-for-card trade and either side requires shards, show both sides' requirements
    if (session.type === 'card_for_card' && (session.offeredShard?.count > 0 || session.requestedShard?.count > 0)) {
      const lines = [];
      if (session.offeredShard?.count > 0 && session.offeredShard?.shardId) {
        const sid = session.offeredShard.shardId;
        const sname = ITEM_DISPLAY_NAMES[sid] || sid;
        const semoji = ITEM_DISPLAY_EMOJIS[sid] || '';
        lines.push(`<@${initiatorId}> (offering): ${semoji} ${sname} x${session.offeredShard.count}`);
      } else {
        lines.push(`<@${initiatorId}> (offering): None`);
      }
      if (session.requestedShard?.count > 0 && session.requestedShard?.shardId) {
        const sid = session.requestedShard.shardId;
        const sname = ITEM_DISPLAY_NAMES[sid] || sid;
        const semoji = ITEM_DISPLAY_EMOJIS[sid] || '';
        lines.push(`<@${targetId}> (offering): ${semoji} ${sname} x${session.requestedShard.count}`);
      } else {
        lines.push(`<@${targetId}> (offering): None`);
      }
      embed.addFields({ name: 'Shard Requirements', value: lines.join('\n'), inline: false });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`trade_confirm:${sessionId}`)
        .setLabel('Accept Trade')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`trade_cancel:${sessionId}`)
        .setLabel('Decline')
        .setStyle(ButtonStyle.Secondary)
    );

    // Persist session
    global.tradeSessions.set(sessionId, session);

    const replyContent = `<@${targetId}>, you have a trade proposal:`;
    if (message) return message.channel.send({ content: replyContent, embeds: [embed], components: [row] });
    return interaction.reply({ content: replyContent, embeds: [embed], components: [row] });
  },

  async handleButton(interaction, customId) {
    const parts = customId.split(':');
    const key = parts[0];
    const sessionId = parts[1];
    if (!key.startsWith('trade')) return;
    const session = global.tradeSessions.get(sessionId);
    if (!session) return interaction.reply({ content: 'Trade session expired or not found.', ephemeral: true });

    // Only target can accept/decline
    if (interaction.user.id !== session.targetId) {
      return interaction.reply({ content: 'Only the trade recipient may accept or decline this trade.', ephemeral: true });
    }

    if (key === 'trade_cancel') {
      global.tradeSessions.delete(sessionId);
      return global.safeUpdate(interaction, { content: 'Trade declined.', embeds: [], components: [] });
    }

    // Accept flow
    if (key === 'trade_confirm') {
      // Re-fetch fresh docs to validate
      const initiator = await User.findOne({ userId: session.initiatorId });
      const target = await User.findOne({ userId: session.targetId });
      if (!initiator || !target) {
        global.tradeSessions.delete(sessionId);
        return global.safeUpdate(interaction, { content: 'One of the users no longer has an account. Trade cancelled.', embeds: [], components: [] });
      }

      try {
        if (session.type === 'card_for_card') {
          // verify ownership still holds
          const offeredEntryIndex = (initiator.ownedCards || []).findIndex(e => e.cardId === session.offered.cardId);
          const requestedEntryIndex = (target.ownedCards || []).findIndex(e => e.cardId === session.requested.cardId);
          if (offeredEntryIndex === -1 || requestedEntryIndex === -1) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Either user no longer owns the required card. Trade cancelled.', embeds: [], components: [] });
          }

          // verify both parties still have required shards (if any)
          const offeredShardId = session.offeredShard?.shardId;
          const offeredShardCount = session.offeredShard?.count || 0;
          const requestedShardId = session.requestedShard?.shardId;
          const requestedShardCount = session.requestedShard?.count || 0;

          if (offeredShardCount > 0 && offeredShardId) {
            const have = findItemCount(initiator.items || [], offeredShardId);
            if (have < offeredShardCount) {
              const sname = ITEM_DISPLAY_NAMES[offeredShardId] || offeredShardId;
              const semoji = ITEM_DISPLAY_EMOJIS[offeredShardId] || '';
              global.tradeSessions.delete(sessionId);
              return global.safeUpdate(interaction, { content: `Trade cancelled: <@${session.initiatorId}> lacks required shards (${semoji} ${sname} x${offeredShardCount}).`, embeds: [], components: [] });
            }
          }

          if (requestedShardCount > 0 && requestedShardId) {
            const haveT = findItemCount(target.items || [], requestedShardId);
            if (haveT < requestedShardCount) {
              const sname = ITEM_DISPLAY_NAMES[requestedShardId] || requestedShardId;
              const semoji = ITEM_DISPLAY_EMOJIS[requestedShardId] || '';
                global.tradeSessions.delete(sessionId);
                return global.safeUpdate(interaction, { content: `Trade cancelled: <@${session.targetId}> lacks required shards (${semoji} ${sname} x${requestedShardCount}).`, embeds: [], components: [] });
            }
          }

          // prevent trading if artifacts have been equipped since proposal
          if (cardHasArtifactEquipped(initiator, session.offered.cardId)) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Trade cancelled: Offered card has an artifact equipped. Unequip it first.', embeds: [], components: [] });
          }
          if (cardHasArtifactEquipped(target, session.requested.cardId)) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Trade cancelled: Requested card has an artifact equipped. Target must unequip it first.', embeds: [], components: [] });
          }

          // perform transfers: remove entries
          const offeredEntry = initiator.ownedCards.splice(offeredEntryIndex, 1)[0];
          const requestedEntry = target.ownedCards.splice(requestedEntryIndex, 1)[0];

          // remove shards from initiator -> add to target
          if (offeredShardCount > 0 && offeredShardId) {
            initiator.items = removeItem(initiator.items || [], offeredShardId, offeredShardCount);
            target.items = target.items || [];
            const existingT = target.items.find(i => i.itemId === offeredShardId);
            if (existingT) existingT.quantity = (existingT.quantity || 0) + offeredShardCount;
            else target.items.push({ itemId: offeredShardId, quantity: offeredShardCount });
          }

          // remove shards from target -> add to initiator
          if (requestedShardCount > 0 && requestedShardId) {
            target.items = removeItem(target.items || [], requestedShardId, requestedShardCount);
            initiator.items = initiator.items || [];
            const existingI = initiator.items.find(i => i.itemId === requestedShardId);
            if (existingI) existingI.quantity = (existingI.quantity || 0) + requestedShardCount;
            else initiator.items.push({ itemId: requestedShardId, quantity: requestedShardCount });
          }

          // When recipient already owns the incoming card, convert incoming card's level/xp into XP on existing entry
          if (!applyIncomingEntryAsXp(initiator, requestedEntry)) {
            initiator.ownedCards.push(requestedEntry);
          }
          if (!applyIncomingEntryAsXp(target, offeredEntry)) {
            target.ownedCards.push(offeredEntry);
          }

          await initiator.save();
          await target.save();

          // build completion message with shard details
          const offeredCard = getCardById(session.offered.cardId) || {};
          const requestedCard = getCardById(session.requested.cardId) || {};
          const shardParts = [];
          if (offeredShardCount > 0 && offeredShardId) {
            const sname = ITEM_DISPLAY_NAMES[offeredShardId] || offeredShardId;
            const semoji = ITEM_DISPLAY_EMOJIS[offeredShardId] || '';
            shardParts.push(`<@${session.initiatorId}> -> <@${session.targetId}>: ${semoji} ${sname} x${offeredShardCount}`);
          }
          if (requestedShardCount > 0 && requestedShardId) {
            const sname = ITEM_DISPLAY_NAMES[requestedShardId] || requestedShardId;
            const semoji = ITEM_DISPLAY_EMOJIS[requestedShardId] || '';
            shardParts.push(`<@${session.targetId}> -> <@${session.initiatorId}>: ${semoji} ${sname} x${requestedShardCount}`);
          }

          let completeMsg = `Trade completed: ${offeredCard.character || offeredCard.id} ↔ ${requestedCard.character || requestedCard.id}.`;
          if (shardParts.length) completeMsg += ` Shards exchanged: ${shardParts.join(' | ')}.`;

          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: completeMsg, embeds: [], components: [] });
        }

        if (session.type === 'beli_for_card') {
          // validate buyer still has funds and shards
          const buyer = initiator; // initiator paid beli
          const seller = target;
          if ((buyer.balance || 0) < session.beli) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Buyer no longer has enough Beli. Trade cancelled.', embeds: [], components: [] });
          }

          const shardId = session.shardReq?.shardId;
          const shardCount = session.shardReq?.count || 0;
          if (shardCount > 0 && shardId) {
            const have = findItemCount(buyer.items || [], shardId);
            if (have < shardCount) {
              const sname = ITEM_DISPLAY_NAMES[shardId] || shardId;
              const semoji = ITEM_DISPLAY_EMOJIS[shardId] || '';
              global.tradeSessions.delete(sessionId);
              return global.safeUpdate(interaction, { content: `Buyer lacks required shards (${semoji} ${sname} x${shardCount}). Trade cancelled.`, embeds: [], components: [] });
            }
          }

          // find requested card on seller
          const requestedIndex = (seller.ownedCards || []).findIndex(e => e.cardId === session.requested.cardId);
          if (requestedIndex === -1) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Seller no longer owns the requested card. Trade cancelled.', embeds: [], components: [] });
          }

          // perform transfers: buyer pays seller, shards move, card moves
          buyer.balance = (buyer.balance || 0) - session.beli;
          seller.balance = (seller.balance || 0) + session.beli;

          if (shardCount > 0) {
            // remove from buyer, add to seller
            buyer.items = removeItem(buyer.items || [], shardId, shardCount);
            seller.items = seller.items || [];
            const existing = seller.items.find(i => i.itemId === shardId);
            if (existing) existing.quantity = (existing.quantity || 0) + shardCount;
            else seller.items.push({ itemId: shardId, quantity: shardCount });
          }

          // transfer card
          // prevent trading if seller's card has an artifact equipped
          if (cardHasArtifactEquipped(seller, session.requested.cardId)) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Trade cancelled: Seller has an artifact equipped to that card. Unequip first.', embeds: [], components: [] });
          }

          const requestedEntry = seller.ownedCards.splice(requestedIndex, 1)[0];
          buyer.ownedCards = buyer.ownedCards || [];
          // if buyer already owns the card, convert incoming entry's level/xp into XP on buyer's existing entry
          if (!applyIncomingEntryAsXp(buyer, requestedEntry)) {
            buyer.ownedCards.push(requestedEntry);
          }

          await buyer.save();
          await seller.save();

          const sname = ITEM_DISPLAY_NAMES[shardId] || shardId;
          const semoji = ITEM_DISPLAY_EMOJIS[shardId] || '';
          const shardPart = shardCount ? `${shardCount}x ${semoji} ${sname} ` : '';
          const requestedCard = getCardById(session.requested.cardId) || {};
          const reqName = requestedCard.ship ? `${requestedCard.character} (ship)` : `${requestedCard.emoji || ''} ${requestedCard.character}`;
          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: `Trade completed: ¥${session.beli.toLocaleString()} and ${shardPart}exchanged for ${reqName}.`, embeds: [], components: [] });
        }

        if (session.type === 'card_for_beli') {
          // initiator gives card, target pays beli
          const seller = initiator;
          const buyer = target;
          const beli = session.requested.beli;
          if ((buyer.balance || 0) < beli) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Buyer no longer has enough Beli. Trade cancelled.', embeds: [], components: [] });
          }
          const cardIndex = (seller.ownedCards || []).findIndex(e => e.cardId === session.offered.cardId);
          if (cardIndex === -1) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Seller no longer owns the card. Trade cancelled.', embeds: [], components: [] });
          }
          if (cardHasArtifactEquipped(seller, session.offered.cardId)) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Trade cancelled: Card has an artifact equipped. Unequip first.', embeds: [], components: [] });
          }
          const cardEntry = seller.ownedCards.splice(cardIndex, 1)[0];
          buyer.balance = (buyer.balance || 0) - beli;
          seller.balance = (seller.balance || 0) + beli;
          if (!applyIncomingEntryAsXp(buyer, cardEntry)) buyer.ownedCards.push(cardEntry);
          await initiator.save();
          await target.save();
          const soldCard = getCardById(session.offered.cardId) || {};
          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: `Trade completed: ${soldCard.emoji || ''} **${soldCard.character || 'card'}** sold for ¥${beli.toLocaleString()}.`, embeds: [], components: [] });
        }

        if (session.type === 'beli_for_leveler') {
          // initiator pays beli, target gives leveler
          const qty = session.qty || 1;
          const levelerId = session.requested.levelerId;
          if ((initiator.balance || 0) < session.beli) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Buyer no longer has enough Beli. Trade cancelled.', embeds: [], components: [] });
          }
          const sellerItem = (target.items || []).find(i => i.itemId === levelerId);
          if (!sellerItem || (sellerItem.quantity || 0) < qty) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: `Seller no longer has ${qty}x of that leveler. Trade cancelled.`, embeds: [], components: [] });
          }
          initiator.balance = (initiator.balance || 0) - session.beli;
          target.balance = (target.balance || 0) + session.beli;
          sellerItem.quantity -= qty;
          if (sellerItem.quantity <= 0) target.items = target.items.filter(i => i.itemId !== levelerId);
          const buyerItem = (initiator.items || []).find(i => i.itemId === levelerId);
          if (buyerItem) buyerItem.quantity = (buyerItem.quantity || 0) + qty;
          else initiator.items.push({ itemId: levelerId, quantity: qty });
          initiator.markModified('items'); target.markModified('items');
          await initiator.save();
          await target.save();
          const levDef = levelers.find(l => l.id === levelerId) || { name: levelerId, emoji: '' };
          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: `Trade completed: ¥${session.beli.toLocaleString()} for **${qty > 1 ? qty + 'x ' : ''}${levDef.emoji} ${levDef.name}**.`, embeds: [], components: [] });
        }

        if (session.type === 'leveler_for_beli') {
          // initiator gives leveler, target pays beli
          const qty = session.qty || 1;
          const levelerId = session.offered.levelerId;
          const beli = session.requested.beli;
          if ((target.balance || 0) < beli) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Buyer no longer has enough Beli. Trade cancelled.', embeds: [], components: [] });
          }
          const sellerItem = (initiator.items || []).find(i => i.itemId === levelerId);
          if (!sellerItem || (sellerItem.quantity || 0) < qty) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: `Seller no longer has ${qty}x of that leveler. Trade cancelled.`, embeds: [], components: [] });
          }
          sellerItem.quantity -= qty;
          if (sellerItem.quantity <= 0) initiator.items = initiator.items.filter(i => i.itemId !== levelerId);
          const buyerItem = (target.items || []).find(i => i.itemId === levelerId);
          if (buyerItem) buyerItem.quantity = (buyerItem.quantity || 0) + qty;
          else target.items.push({ itemId: levelerId, quantity: qty });
          target.balance = (target.balance || 0) - beli;
          initiator.balance = (initiator.balance || 0) + beli;
          initiator.markModified('items'); target.markModified('items');
          await initiator.save();
          await target.save();
          const levDef = levelers.find(l => l.id === levelerId) || { name: levelerId, emoji: '' };
          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: `Trade completed: **${qty > 1 ? qty + 'x ' : ''}${levDef.emoji} ${levDef.name}** sold for ¥${beli.toLocaleString()}.`, embeds: [], components: [] });
        }

        if (session.type === 'leveler_class_for_beli') {
          // initiator gives all class levelers, target pays beli
          const beli = session.requested.beli;
          const snapshot = session.snapshot || [];
          if ((target.balance || 0) < beli) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Buyer no longer has enough Beli. Trade cancelled.', embeds: [], components: [] });
          }
          // Verify and transfer all levelers
          const transferred = [];
          for (const entry of snapshot) {
            const sellerItem = (initiator.items || []).find(i => i.itemId === entry.levelerId);
            if (!sellerItem || (sellerItem.quantity || 0) < entry.qty) continue;
            sellerItem.quantity -= entry.qty;
            if (sellerItem.quantity <= 0) initiator.items = initiator.items.filter(i => i.itemId !== entry.levelerId);
            const buyerItem = (target.items || []).find(i => i.itemId === entry.levelerId);
            if (buyerItem) buyerItem.quantity = (buyerItem.quantity || 0) + entry.qty;
            else { target.items = target.items || []; target.items.push({ itemId: entry.levelerId, quantity: entry.qty }); }
            transferred.push(entry);
          }
          if (!transferred.length) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Seller no longer has any of those levelers. Trade cancelled.', embeds: [], components: [] });
          }
          target.balance = (target.balance || 0) - beli;
          initiator.balance = (initiator.balance || 0) + beli;
          initiator.markModified('items'); target.markModified('items');
          await initiator.save();
          await target.save();
          const listStr = transferred.map(e => `${e.emoji || ''} ${e.name} x${e.qty}`).join(', ');
          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: `Trade completed: ${listStr} sold for ¥${beli.toLocaleString()}.`, embeds: [], components: [] });
        }

        if (session.type === 'beli_for_leveler_class') {
          // initiator pays beli, target gives all class levelers
          const beli = session.beli;
          const snapshot = session.snapshot || [];
          if ((initiator.balance || 0) < beli) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Buyer no longer has enough Beli. Trade cancelled.', embeds: [], components: [] });
          }
          const transferred = [];
          for (const entry of snapshot) {
            const sellerItem = (target.items || []).find(i => i.itemId === entry.levelerId);
            if (!sellerItem || (sellerItem.quantity || 0) < entry.qty) continue;
            sellerItem.quantity -= entry.qty;
            if (sellerItem.quantity <= 0) target.items = target.items.filter(i => i.itemId !== entry.levelerId);
            const buyerItem = (initiator.items || []).find(i => i.itemId === entry.levelerId);
            if (buyerItem) buyerItem.quantity = (buyerItem.quantity || 0) + entry.qty;
            else { initiator.items = initiator.items || []; initiator.items.push({ itemId: entry.levelerId, quantity: entry.qty }); }
            transferred.push(entry);
          }
          if (!transferred.length) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Seller no longer has any of those levelers. Trade cancelled.', embeds: [], components: [] });
          }
          initiator.balance = (initiator.balance || 0) - beli;
          target.balance = (target.balance || 0) + beli;
          initiator.markModified('items'); target.markModified('items');
          await initiator.save();
          await target.save();
          const listStr = transferred.map(e => `${e.emoji || ''} ${e.name} x${e.qty}`).join(', ');
          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: `Trade completed: ¥${beli.toLocaleString()} for ${listStr}.`, embeds: [], components: [] });
        }

        if (session.type === 'leveler_for_leveler') {
          const offeredQty = session.offeredQty || 1;
          const requestedQty = session.requestedQty || 1;
          const offeredId = session.offered.levelerId;
          const requestedId = session.requested.levelerId;
          const initItem = (initiator.items || []).find(i => i.itemId === offeredId);
          const targItem = (target.items || []).find(i => i.itemId === requestedId);
          if (!initItem || (initItem.quantity || 0) < offeredQty) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: `<@${session.initiatorId}> no longer has enough of the offered leveler. Trade cancelled.`, embeds: [], components: [] });
          }
          if (!targItem || (targItem.quantity || 0) < requestedQty) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: `<@${session.targetId}> no longer has enough of the requested leveler. Trade cancelled.`, embeds: [], components: [] });
          }
          initItem.quantity -= offeredQty;
          if (initItem.quantity <= 0) initiator.items = initiator.items.filter(i => i.itemId !== offeredId);
          targItem.quantity -= requestedQty;
          if (targItem.quantity <= 0) target.items = target.items.filter(i => i.itemId !== requestedId);
          const initGets = (initiator.items || []).find(i => i.itemId === requestedId);
          if (initGets) initGets.quantity = (initGets.quantity || 0) + requestedQty;
          else initiator.items.push({ itemId: requestedId, quantity: requestedQty });
          const targGets = (target.items || []).find(i => i.itemId === offeredId);
          if (targGets) targGets.quantity = (targGets.quantity || 0) + offeredQty;
          else target.items.push({ itemId: offeredId, quantity: offeredQty });
          initiator.markModified('items'); target.markModified('items');
          await initiator.save();
          await target.save();
          const offDef = levelers.find(l => l.id === offeredId) || { name: offeredId, emoji: '' };
          const reqDef = levelers.find(l => l.id === requestedId) || { name: requestedId, emoji: '' };
          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: `Trade completed: **${offeredQty > 1 ? offeredQty + 'x ' : ''}${offDef.emoji} ${offDef.name}** ↔ **${requestedQty > 1 ? requestedQty + 'x ' : ''}${reqDef.emoji} ${reqDef.name}**.`, embeds: [], components: [] });
        }

        } catch (err) {
        console.error('Trade accept failed:', err);
        global.tradeSessions.delete(sessionId);
        return global.safeUpdate(interaction, { content: 'Trade failed due to an error. Check logs.', embeds: [], components: [] });
      }
    }
  }
};
