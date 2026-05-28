const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { searchCards, buildCardEmbed, getCardFinalStats, getAttributeEmoji, updateShipBalance, buildDurabilityBar, getShipById, getCardById } = require('../utils/cards');
const abilities = require('../utils/abilities');
const { sortedOwnedCards } = require('./collection');
const User = require('../models/User');
const { cards } = require('../data/cards');
const { rods } = require('../data/rods');
const { levelers } = require('../data/levelers');
const crews = require('../data/crews');
const { generateArtifactImage } = require('../utils/artifactImage');

// Helpers to safely send/update interaction payloads and strip undefined fields
function isBuilder(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return typeof obj.toJSON === 'function' || obj instanceof EmbedBuilder || obj instanceof ActionRowBuilder;
}

function cleanPayload(obj) {
  if (obj === undefined || obj === null) return undefined;
  if (Array.isArray(obj)) {
    const arr = obj.map(cleanPayload).filter(x => x !== undefined);
    return arr.length ? arr : undefined;
  }
  if (isBuilder(obj)) return obj;
  if (typeof obj !== 'object') return obj;
  const out = {};
  Object.keys(obj).forEach(k => {
    const v = cleanPayload(obj[k]);
    if (v !== undefined) out[k] = v;
  });
  return Object.keys(out).length ? out : undefined;
}

async function safeReply(interaction, payload) {
  try {
    const cleaned = cleanPayload(payload) || {};
    if (interaction.replied || interaction.deferred) {
      if (typeof interaction.followUp === 'function') return interaction.followUp(cleaned).catch(() => null);
      if (typeof interaction.editReply === 'function') return interaction.editReply(cleaned).catch(() => null);
    }
    return interaction.reply(cleaned).catch(() => null);
  } catch (err) {
    console.error('safeReply error', err);
    try { return interaction.reply({ content: 'An error occurred.', ephemeral: true }); } catch (e) { return null; }
  }
}

async function safeUpdate(interaction, payload) {
  try {
    const cleaned = cleanPayload(payload) || {};
    if (typeof interaction.update === 'function') {
      return interaction.update(cleaned).catch(async () => {
        try { return interaction.reply(cleaned); } catch (e) { return null; }
      });
    }
    if (typeof interaction.editReply === 'function') {
      return interaction.editReply(cleaned).catch(async () => {
        try { return interaction.reply(cleaned); } catch (e) { return null; }
      });
    }
    return safeReply(interaction, cleaned);
  } catch (err) {
    console.error('safeUpdate error', err);
    try { return interaction.reply({ content: 'An error occurred.', ephemeral: true }); } catch (e) { return null; }
  }
}

function makeInfoRow(index, total, cardDef, isOwned) {
  const components = [];
  
  // Only add boost button if card is owned and not a ship
  if (isOwned && !cardDef.ship) {
    components.push(
      new ButtonBuilder()
        .setCustomId(`info_boost:boost`)
        .setLabel('Boosts')
        .setEmoji('<:boosticon:1490506833344073768>')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  if (cardDef && abilities.hasAbility(cardDef)) {
    const btn = abilities.makeAbilityButton(cardDef);
    if (btn) components.push(btn);
  }
  
  return components.length ? new ActionRowBuilder().addComponents(...components) : null;
}

function makeInfoNavRow(userId, index, total) {
  if (total <= 1) return null;
  const prevDisabled = index <= 0;
  const nextDisabled = index >= total - 1;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`info_prev:${userId}:${index}`)
      .setLabel('Previous')
      .setStyle(prevDisabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(prevDisabled),
    new ButtonBuilder()
      .setCustomId(`info_next:${userId}:${index}`)
      .setLabel('Next')
      .setStyle(nextDisabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(nextDisabled)
  );
}

function makeInfoRows(userId, index, total, cardDef, isOwned) {
  const rows = [];
  const navRow = makeInfoNavRow(userId, index, total);
  const boostRow = makeInfoRow(index, total, cardDef, isOwned);
  if (navRow) rows.push(navRow);
  if (boostRow) rows.push(boostRow);
  return rows;
}

function buildBoostEmbed(cardDef, userEntry, user) {
  const lvl = userEntry ? userEntry.level : 1;
  const stats = getCardFinalStats(cardDef, lvl, user);
  const boostEntries = stats.boostEntries || [];
  const statBoosts = stats.statBoosts || {};
  // Calculate level boost percent (0.1% per level)
  const levelBoostPct = Math.round(lvl * 0.1 * 10) / 10;
  // Star level boost (1% per star)
  const starLevel = userEntry ? (userEntry.starLevel || 0) : 0;
  const starBoostPct = starLevel;

  // Always define cardEmoji at the top
  const cardEmoji = cardDef.emoji ? cardDef.emoji + ' ' : '';

  // Compose boost lines with correct emoji and format
  const lines = [];
  // Show all character/crew boosts first, with emoji
  if (boostEntries.length) {
    const { cards } = require('../data/cards');
    boostEntries.forEach(b => {
      if (b.source === 'Levels') return; // skip, will add at end
      // Find the booster card by character name (case-insensitive)
      let emoji = '';
      const boosterCard = cards.find(c => c.character.toLowerCase() === b.source.toLowerCase());
      if (boosterCard && boosterCard.emoji) {
        emoji = boosterCard.emoji + ' ';
      }
      if (b.stat) {
        lines.push(`${emoji}**${b.source}**: \`+${b.pct}%\` ${b.stat}`);
      } else {
        lines.push(`${emoji}**${b.source}**: \`+${b.pct}%\` All stats`);
      }
    });
  }
  // Show level + star boost combined as a single line
  const combinedLevelBoostPct = levelBoostPct + starBoostPct;
  lines.push(`**Levels**: \`+${combinedLevelBoostPct}%\` All stats`);

  // For boost/artifact cards, parse base boost % and show it cleanly
  const isBoostCard = !!(cardDef.boost);
  let baseStats = '';
  let artifactBasePct = 0;
  if (isBoostCard) {
    const _boostRegex = /([\w .'-]+?)(?:,\s*([\w ]+))?\s*\((\d+)%\)/gi;
    let _m;
    const _pcts = [];
    const _statNames = [];
    while ((_m = _boostRegex.exec(cardDef.boost)) !== null) {
      _pcts.push(parseInt(_m[3], 10));
      if (_m[2] && _m[2].trim().toLowerCase() !== 'all') _statNames.push(_m[2].trim());
    }
    if (_pcts.length > 0) {
      artifactBasePct = _pcts[0];
      const statLabel = _statNames.length > 0 ? _statNames[0] : 'All stats';
      baseStats = `**Base boost:** \`${artifactBasePct}%\` ${statLabel}`;
    }
  } else {
    baseStats = `**Base stats:** ${cardDef.power} Power, ${cardDef.health} Health, ${cardDef.speed} Speed, ${cardDef.attack_min} - ${cardDef.attack_max} Attack`;
  }

  // Compose total boost summary
  let totalParts = [];
  if (isBoostCard) {
    const artifactTotal = Math.round((artifactBasePct + combinedLevelBoostPct) * 10) / 10;
    totalParts.push(`\`${artifactTotal}%\` All stats`);
  } else {
    const allStatsTotal = levelBoostPct + starBoostPct + (stats.totalBoostPct || 0);
    if (allStatsTotal > 0) totalParts.push(`\`${allStatsTotal}%\` all stats`);
    Object.entries(statBoosts).forEach(([stat, pct]) => {
      totalParts.push(`\`${pct}%\` ${stat}`);
    });
  }
  const totalBoostLine = `**Total boost:** ${totalParts.join(' + ')}`;

  const embed = new EmbedBuilder()
    .setTitle(`${cardEmoji}${cardDef.character} active boosts`)
    .setColor('#2b2d31')
    .setDescription(`${baseStats}\n${totalBoostLine}`)
    .addFields({ name: 'Active boosts', value: lines.join('\n'), inline: false });

  return embed;
}

async function renderInfoCard(interaction, session, user, index) {
  const cardDef = session.cards[index];
  const userEntry = user?.ownedCards?.find(e => e.cardId === cardDef.id) || null;
  const avatarUrl = interaction.user.displayAvatarURL();
  const embed = buildCardEmbed(cardDef, userEntry, avatarUrl, user);
  const isOwned = userEntry !== null;
  const rows = makeInfoRows(interaction.user.id, index, session.cards.length, cardDef, isOwned);
  session.currentIndex = index;
  // If this is an artifact, generate and attach a consistent image
  let files;
  if (cardDef && cardDef.artifact) {
    try {
      const buf = await generateArtifactImage(cardDef);
      const att = new AttachmentBuilder(buf, { name: `artifact-${cardDef.id}.png` });
      files = [att];
    } catch (e) {
      console.error('Failed to generate artifact image for info render', e);
    }
  }

  return safeUpdate(interaction, { embeds: [embed], components: rows.length ? rows : undefined, files });
}

function normalizeCrewName(name) {
  return name ? name.toLowerCase().replace(/[- ]+/g, '') : '';
}

function getCrewByName(query) {
  if (!query) return null;
  const normalizedQuery = normalizeCrewName(query);
  return crews.find(crew => {
    const normalizedCrewName = normalizeCrewName(crew.name);
    return normalizedCrewName === normalizedQuery || `${normalizedCrewName}pack` === normalizedQuery || normalizedQuery.includes(normalizedCrewName);
  });
}

function parseEmojiUrl(emoji) {
  if (!emoji || typeof emoji !== 'string') return null;
  const match = emoji.match(/<a?:[^:]+:(\d+)>/);
  return match ? `https://cdn.discordapp.com/emojis/${match[1]}.png` : null;
}

const attributeColors = {
  STR: '#ff4b4b',
  DEX: '#33cc33',
  QCK: '#3498ff',
  PSY: '#f5df4d',
  INT: '#9b59b6',
  ALL: '#9fa8da'
};

function getRodByName(query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  return rods.find(r => r.name.toLowerCase() === q || r.id.toLowerCase() === q) || null;
}

function getLevelerByName(query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  return levelers.find(l => l.name.toLowerCase() === q || l.id.toLowerCase() === q) || null;
}

function getShardByName(query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  const shardColors = ['red', 'blue', 'green', 'yellow', 'purple'];
  const matched = shardColors.find(color => q === color || q === `${color} shard`);
  if (matched) {
    return {
      id: `${matched}_shard`,
      color: matched.charAt(0).toUpperCase() + matched.slice(1),
      name: `${matched.charAt(0).toUpperCase() + matched.slice(1)} Shard`
    };
  }
  return null;
}

function getGodTokenInfo(query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  if (q === 'god token' || q === 'godtoken' || q === 'god') {
    return {
      id: 'god_token',
      name: 'God Token'
    };
  }
  return null;
}

function getColaInfo(query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  if (q === 'cola') {
    return {
      id: 'cola',
      name: 'Cola'
    };
  }
  return null;
}

function getRodColor(rodId) {
  switch (rodId) {
    case 'basic_rod': return '#8B4513'; // brown
    case 'gold_rod': return '#FFD700'; // golden
    case 'white_rod': return '#F8F8FF'; // shiny white
    default: return '#FFFFFF';
  }
}

// Durability bar is provided by utils/cards.buildDurabilityBar

function buildRodEmbed(rodDef, discordUser, user) {
  const rodItem = user && user.items?.find(it => it.itemId === rodDef.id);
  const durabilityLabel = rodItem && rodItem.durability !== undefined
    ? `\`${rodItem.durability}/${rodDef.durability}\` uses`
    : `\`${rodDef.durability}\` uses`;

  const embed = new EmbedBuilder()
    .setTitle(rodDef.name)
    .setColor(getRodColor(rodDef.id))
    .setThumbnail(parseEmojiUrl(rodDef.emoji))
    .setDescription(`${rodDef.emoji}`)
    .addFields(
      { name: 'Multiplier', value: `\`${rodDef.multiplier}x\``, inline: true },
      { name: 'Fishing speed', value: `\`${rodDef.multiplier}x\` faster nibble wait`, inline: true },
      { name: 'Rarity bonus', value: `\`${rodDef.multiplier}x\` reward and rarity scaling`, inline: false },
      { name: 'Luck bonus', value: `\`${Math.round((rodDef.luckBonus || 0) * 100)}%\``, inline: true },
      { name: 'Durability', value: durabilityLabel, inline: true },
      { name: 'Cost', value: `${rodDef.cost.toLocaleString()} <:beri:1490738445319016651>`, inline: true }
    );
  
  if (rodItem && rodItem.durability !== undefined) {
    const durabilityBar = buildDurabilityBar(rodItem.durability, rodDef.durability, 'rod');
    embed.addFields({ name: 'Durability Bar', value: `${durabilityBar} (${rodItem.durability}/${rodDef.durability})`, inline: false });
  }
  
  if (discordUser) embed.setAuthor({ name: discordUser.username, iconURL: discordUser.displayAvatarURL() });
  return embed;
}

function buildLevelerEmbed(levelerDef, discordUser, user) {
  const xpValue = typeof levelerDef.xp === 'object'
    ? Object.entries(levelerDef.xp).map(([attr, value]) => `**${attr}**: ${value}`).join('\n')
    : `\`${levelerDef.xp}\``;
  const ownedCount = user && Array.isArray(user.items)
    ? user.items.reduce((sum, item) => item.itemId === levelerDef.id ? sum + (item.quantity || 0) : sum, 0)
    : 0;
  const descLines = [
    `**Owned:** ${ownedCount}x`,
    `**Rank:** ${levelerDef.rank}`,
    `**Attribute:** ${getAttributeEmoji(levelerDef.attribute)}`,
    `**Sell price:** <:beri:1490738445319016651> ${levelerDef.beli}`
  ];
  const embed = new EmbedBuilder()
    .setTitle(levelerDef.name)
    .setColor(attributeColors[levelerDef.attribute] || '#2b2d31')
    .setThumbnail(parseEmojiUrl(levelerDef.emoji))
    .setDescription(descLines.join('\n'))
    .addFields({ name: 'XP awarded', value: xpValue, inline: false });
  if (discordUser) embed.setAuthor({ name: discordUser.username, iconURL: discordUser.displayAvatarURL() });
  return embed;
}

function buildShardEmbed(shardInfo, discordUser, user) {
  const ownedCount = user && Array.isArray(user.items)
    ? user.items.reduce((sum, item) => item.itemId === shardInfo.id ? sum + (item.quantity || 0) : sum, 0)
    : 0;
  const shardEmojis = {
    red_shard: '<:RedShard:1494106374492131439>',
    blue_shard: '<:Blueshard:1494106500149411980>',
    green_shard: '<:GreenShard:1494106686963581039>',
    yellow_shard: '<:YellowShard:1494106825627406530>',
    purple_shard: '<:PurpleShard:1494106958582776008>'
  };
  const shardDescriptions = {
    red_shard: 'Currency used for trading STR attribute cards. Collect these shards to upgrade or trade STR-type cards.',
    blue_shard: 'Currency used for trading QCK attribute cards. Collect these shards to upgrade or trade QCK-type cards.',
    green_shard: 'Currency used for trading DEX attribute cards. Collect these shards to upgrade or trade DEX-type cards.',
    yellow_shard: 'Currency used for trading PSY attribute cards. Collect these shards to upgrade or trade PSY-type cards.',
    purple_shard: 'Currency used for trading INT attribute cards. Collect these shards to upgrade or trade INT-type cards.'
  };
  const attributeMap = {
    red_shard: 'STR',
    blue_shard: 'QCK',
    green_shard: 'DEX',
    yellow_shard: 'PSY',
    purple_shard: 'INT'
  };
  const emoji = shardEmojis[shardInfo.id] || '';
  const attr = attributeMap[shardInfo.id] || 'N/A';
  const desc = shardDescriptions[shardInfo.id] || 'Card trading shard';
  const embed = new EmbedBuilder()
    .setTitle(shardInfo.name)
    .setColor(attributeColors[attr] || '#2b2d31')
    .setThumbnail(emoji.includes(':') ? `https://cdn.discordapp.com/emojis/${emoji.match(/\d+/)[0]}.png` : null)
    .setDescription(desc)
    .addFields(
      { name: 'Attribute', value: `${getAttributeEmoji(attr)} **${attr}**`, inline: true },
      { name: 'Owned', value: `**${ownedCount}x**`, inline: true }
    );
  if (discordUser) embed.setAuthor({ name: discordUser.username, iconURL: discordUser.displayAvatarURL() });
  return embed;
}

function buildGodTokenEmbed(godTokenInfo, discordUser, user) {
  const ownedCount = user && Array.isArray(user.items)
    ? user.items.reduce((sum, item) => item.itemId === godTokenInfo.id ? sum + (item.quantity || 0) : sum, 0)
    : 0;
  const emoji = '<:godtoken:1499957056650608753>';
  const embed = new EmbedBuilder()
    .setTitle(godTokenInfo.name)
    .setColor('#FFD700') // gold color
    .setThumbnail('https://cdn.discordapp.com/emojis/1499957056650608753.png')
    .setDescription('A rare and powerful token that resets all personal cooldowns and pulls when used. One of the most valuable items in the game.')
    .addFields(
      { name: 'Effect', value: 'Resets bounty, trivia, loot, bet cooldowns and restores your pull limit to maximum.', inline: false },
      { name: 'Shop Price', value: '<:beri:1490738445319016651> 2700', inline: true },
      { name: 'Owned', value: `**${ownedCount}x**`, inline: true },
    );
  if (discordUser) embed.setAuthor({ name: discordUser.username, iconURL: discordUser.displayAvatarURL() });
  return embed;
}

function buildColaEmbed(colaInfo, discordUser, user) {
  const ownedCount = user && Array.isArray(user.items)
    ? user.items.reduce((sum, item) => item.itemId === colaInfo.id ? sum + (item.quantity || 0) : sum, 0)
    : 0;
  const emoji = '<:cola:1494106165955792967>';
  const embed = new EmbedBuilder()
    .setTitle(colaInfo.name)
    .setColor('#00CED1') // cyan color
    .setThumbnail('https://cdn.discordapp.com/emojis/1494106165955792967.png')
    .setDescription('Essential fuel for sailing adventures. Use cola to refuel your ship and continue your journey through the story islands.')
    .addFields(
      { name: 'Used For', value: 'Fueling ships for story mode sailing', inline: true },
      { name: 'How to Obtain', value: 'Earned from chest openings (C, B, A chests have 30-40% chance) or purchased from the shop', inline: false },
      { name: 'Shop Price', value: '<:beri:1490738445319016651> 204', inline: true },
      { name: 'Owned', value: `**${ownedCount}x**`, inline: true },
    );
  if (discordUser) embed.setAuthor({ name: discordUser.username, iconURL: discordUser.displayAvatarURL() });
  return embed;
}

function buildPackEmbed(crewDef, discordUser, pageIndex = 0) {
  const normalizedCrewName = normalizeCrewName(crewDef.name);
  const crewCards = cards.filter(c => normalizeCrewName(c.faculty) === normalizedCrewName || (c.artifact && normalizeCrewName(c.faculty).includes('strawhat') && normalizedCrewName.includes('strawhat')));

  // Get unique cards by character for display, sorted by attribute then name
  const uniqueByCharacter = new Map();
  const typeOrder = card => (card.artifact ? 2 : card.ship ? 3 : 1);
  crewCards.forEach(c => {
    const current = uniqueByCharacter.get(c.character);
    if (!current || typeOrder(c) < typeOrder(current)) {
      uniqueByCharacter.set(c.character, c);
    }
  });

  // Attribute order: STR, DEX, QCK, PSY, INT
  const attributeOrder = ['STR', 'DEX', 'QCK', 'PSY', 'INT'];

  // Sort by attribute, then by character name. Artifacts should always come last.
  const sortedCharacters = Array.from(uniqueByCharacter.values())
    .sort((a, b) => {
      const typeOrder = card => (card.artifact ? 2 : card.ship ? 3 : 1);
      const aType = typeOrder(a);
      const bType = typeOrder(b);
      if (aType !== bType) return aType - bType;
      if (aType !== 2 && aType !== 3) {
        const aAttrIdx = attributeOrder.indexOf(a.attribute || 'STR');
        const bAttrIdx = attributeOrder.indexOf(b.attribute || 'STR');
        if (aAttrIdx !== bAttrIdx) return aAttrIdx - bAttrIdx;
      }
      return a.character.localeCompare(b.character);
    });

  // Count ALL cards including duplicates with same character but different titles
  const cardCount = crewCards.length;

  // Define rank colors.
  const rankColors = {
    'D': '#f6efe9',    // Gray
    'C': '#fff6ec',    // Green
    'B': '#c6c6c7',    // Blue
    'A': '#ecf5ff',    // Gold
    'S': '#fff2f0',    // Tomato/Red
    'SS': '#fce6fb',   // Purple
    'UR': '#f1ffff'    // Turquoise
  };

  const rankEmojis = {
    'D': '<:D:1489355343262310401>',
    'C': '<:C:1489355299844235395>',
    'B': '<:B:1489355220848816198>',
    'A': '<:A:1489355161318232093>',
    'S': '<:S:1489355105388261446>',
    'SS': '<:SS:1489355033819054121>',
    'UR': '<:UR:1489354976039927869>'
  };

  const rankColor = crewDef.color || rankColors[crewDef.rank] || '#FFFFFF';
  const rankEmoji = rankEmojis[crewDef.rank] || '';

  // Build character list: hide ship emoji and mark ships with (ship)
  const characterLines = sortedCharacters.map(card => {
    if (card.ship) return `${card.character} (ship)`;
    const emoji = card.emoji || '';
    return `${emoji} ${card.character}`;
  });

  // Join all characters (no limit)
  const characterList = characterLines.join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`${crewDef.icon} ${crewDef.name}`)
    .setColor(rankColor)
    .setDescription(`**Rank:** ${crewDef.rank}\n**Cards:** ${cardCount}`)
    .setImage(crewDef.packImage || '')
    .setAuthor({ name: discordUser.username, iconURL: discordUser.displayAvatarURL() });

  // If the entire list fits in one field, return simple embed and no pages
  const maxFieldLen = 1024;
  if (!characterList) return { embed, pages: null };

  if (characterList.length <= maxFieldLen) {
    embed.addFields({ name: 'Cards', value: characterList, inline: false });
    return { embed, pages: null };
  }

  // Otherwise, split into page chunks (each <= maxFieldLen)
  const linesArr = characterList.split('\n');
  const pages = [];
  let chunk = '';
  for (const line of linesArr) {
    const nextLen = chunk ? chunk.length + 1 + line.length : line.length;
    if (nextLen > maxFieldLen) {
      pages.push(chunk);
      chunk = line;
    } else {
      chunk = chunk ? chunk + '\n' + line : line;
    }
  }
  if (chunk) pages.push(chunk);

  // clamp pageIndex
  const page = Math.max(0, Math.min(pages.length - 1, pageIndex || 0));
  embed.addFields({ name: `Cards (page ${page + 1}/${pages.length})`, value: pages[page], inline: false });
  embed.setFooter({ text: `Page ${page + 1}/${pages.length}` });
  return { embed, pages };
}

module.exports = {
  name: 'info',
  description: 'Show ownership and history of a card or pack info',
  options: [{ name: 'query', type: 3, description: 'Card name or pack name', required: true }],
  async execute({ message, interaction, args }) {
    const query = message ? args.join(' ') : interaction.options.getString('query');
    const userId = message ? message.author.id : interaction.user.id;
    const discordUser = message ? message.author : interaction.user;
    // Load user early so we can special-case queries like "ship" to show the active ship
    const user = await User.findOne({ userId });

    if (!query || !query.trim()) {
      const reply = 'Please state a card.';
      if (message) return message.channel.send(reply);
      return safeReply(interaction, { content: reply, ephemeral: true });
    }

    // If the user asked simply for "ship" (or similar), show their active ship if set
    const qNorm = query.trim().toLowerCase();
    if (['ship', 'my ship', 'active ship', 'activeship', 'myship'].includes(qNorm)) {
      if (!user || !user.activeShip) {
        const reply = 'You have no active ship set. Use `op setship` to set one.';
        if (message) return message.channel.send(reply);
        return safeReply(interaction, { content: reply, ephemeral: true });
      }
      const shipDef = getShipById(user.activeShip) || getCardById(user.activeShip);
      if (!shipDef) {
        const reply = 'Your active ship could not be found.';
        if (message) return message.channel.send(reply);
        return safeReply(interaction, { content: reply, ephemeral: true });
      }
      // ensure ship balance/related fields are up-to-date
      if (shipDef.ship && user && user.activeShip === shipDef.id) {
        updateShipBalance(user);
        await user.save();
      }
      const userEntry = user?.ownedCards?.find(e => e.cardId === shipDef.id) || null;
      const avatarUrl = message ? message.author.displayAvatarURL() : interaction.user.displayAvatarURL();
      const embed = buildCardEmbed(shipDef, userEntry, avatarUrl, user);
      if (message) return message.channel.send({ embeds: [embed] });
      return safeReply(interaction, { embeds: [embed] });
    }
    
    // First, check if query matches a crew/pack name
    const crewDef = getCrewByName(query);
    if (crewDef) {
      const { embed: packEmbed, pages } = buildPackEmbed(crewDef, discordUser, 0);
      if (!pages || pages.length <= 1) {
        if (message) return message.channel.send({ embeds: [packEmbed] });
        return safeReply(interaction, { embeds: [packEmbed] });
      }

      // Paginated pack info: store pages in a session and show navigation buttons
      const userKey = `${userId}_packinfo`;
      if (!global.packInfoSessions) global.packInfoSessions = new Map();
      global.packInfoSessions.set(userKey, { userId, crewDef, pages });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`info_packprev:${userId}:0`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`info_packnext:${userId}:0`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Primary)
      );

      if (message) return message.channel.send({ embeds: [packEmbed], components: [row] });
      return safeReply(interaction, { embeds: [packEmbed], components: [row] });
    }

    // Then check exact rod and leveler names only
    const rodDef = getRodByName(query);
    if (rodDef) {
      const rodEmbed = buildRodEmbed(rodDef, discordUser, user);
      if (message) return message.channel.send({ embeds: [rodEmbed] });
      return safeReply(interaction, { embeds: [rodEmbed] });
    }

    const levelerDef = getLevelerByName(query);
    if (levelerDef) {
      const levelerEmbed = buildLevelerEmbed(levelerDef, discordUser, user);
      if (message) return message.channel.send({ embeds: [levelerEmbed] });
      return safeReply(interaction, { embeds: [levelerEmbed] });
    }

    // Check for shard items
    const shardInfo = getShardByName(query);
    if (shardInfo) {
      const shardEmbed = buildShardEmbed(shardInfo, discordUser, user);
      if (message) return message.channel.send({ embeds: [shardEmbed] });
      return safeReply(interaction, { embeds: [shardEmbed] });
    }

    // Check for god token
    const godTokenInfo = getGodTokenInfo(query);
    if (godTokenInfo) {
      const godTokenEmbed = buildGodTokenEmbed(godTokenInfo, discordUser, user);
      if (message) return message.channel.send({ embeds: [godTokenEmbed] });
      return safeReply(interaction, { embeds: [godTokenEmbed] });
    }

    // Check for cola
    const colaInfo = getColaInfo(query);
    if (colaInfo) {
      const colaEmbed = buildColaEmbed(colaInfo, discordUser, user);
      if (message) return message.channel.send({ embeds: [colaEmbed] });
      return safeReply(interaction, { embeds: [colaEmbed] });
    }

    // Otherwise, fall back to card lookup
    const matches = searchCards(query);
    if (!matches.length) {
      const reply = `No card found matching **${query}**.`;
      if (message) return message.channel.send(reply);
      return safeReply(interaction, { content: reply, ephemeral: true });
    }

    const sortByStrength = (a, b) => {
      const rankOrder = { D: 1, C: 2, B: 3, A: 4, S: 5, SS: 6, UR: 7 };
      const rankA = rankOrder[a.rank] || 0;
      const rankB = rankOrder[b.rank] || 0;
      if (rankA !== rankB) return rankB - rankA;
      const masteryA = a.mastery || 1;
      const masteryB = b.mastery || 1;
      if (masteryA !== masteryB) return masteryB - masteryA;
      if (a.character !== b.character) return a.character.localeCompare(b.character);
      if (a.title && b.title && a.title !== b.title) return a.title.localeCompare(b.title);
      return a.id.localeCompare(b.id);
    };

    let sessionCards = [...matches].sort(sortByStrength);
    // Reorder session cards so the user's preferences appear first:
    // 1) owned favorites (user.favoriteCards in order)
    // 2) wishlist entries (user.wishlistCards in order)
    // 3) team entries (user.team in order)
    if (user) {
      const ordered = [];
      const remaining = sessionCards.slice();

      const pushAndRemove = (idList) => {
        if (!Array.isArray(idList)) return;
        for (const id of idList) {
          const idx = remaining.findIndex(c => c.id === id);
          if (idx !== -1) {
            ordered.push(remaining[idx]);
            remaining.splice(idx, 1);
          }
        }
      };

      // owned favorites first
      pushAndRemove(user.favoriteCards);
      // wishlist next
      pushAndRemove(user.wishlistCards);
      // team next
      pushAndRemove(user.team);

      // append the rest
      sessionCards = [...ordered, ...remaining];
    }

    const cardDef = sessionCards[0];

    if (cardDef.ship && user && user.activeShip === cardDef.id) {
      updateShipBalance(user);
      await user.save();
    }
    const userEntry = user?.ownedCards?.find(e => e.cardId === cardDef.id) || null;

    const currentIndex = 0;
    const session = { userId, cards: sessionCards, currentIndex };
    if (!global.infoSessions) global.infoSessions = new Map();
    global.infoSessions.set(`${userId}_info`, session);

    const avatarUrl = message ? message.author.displayAvatarURL() : interaction.user.displayAvatarURL();
    const embed = buildCardEmbed(cardDef, userEntry, avatarUrl, user);
    const isOwned = userEntry !== null;
    const rows = makeInfoRows(session.userId, currentIndex, session.cards.length, cardDef, isOwned);

    // If artifact, generate an attachment for the embed
    let files;
    if (cardDef && cardDef.artifact) {
      try {
        const buf = await generateArtifactImage(cardDef);
        const att = new AttachmentBuilder(buf, { name: `artifact-${cardDef.id}.png` });
        files = [att];
      } catch (e) {
        console.error('Failed to generate artifact image for info execute', e);
      }
    }

    if (message) return message.channel.send({ embeds: [embed], components: rows.length ? rows : [], files });
    return safeReply(interaction, { embeds: [embed], components: rows.length ? rows : [], files });
  },

  async handleButton(interaction, action, indexPart) {
    // Handle pack info pagination buttons (customId: info_packnext:<ownerId>:<currentPage>)
    if (action && action.startsWith('info_pack')) {
      const parts = interaction.customId.split(':');
      const act = parts[0];
      const ownerId = parts[1];
      const pageStr = parts[2] || '0';
      const currentPage = parseInt(pageStr, 10) || 0;

      const session = global.packInfoSessions?.get(`${ownerId}_packinfo`);
      if (!session || session.userId !== ownerId) {
        return safeReply(interaction, { content: 'Pack info session expired or not your session.', ephemeral: true });
      }
      if (interaction.user.id !== ownerId) {
        return safeReply(interaction, { content: 'This pack info session is not for you.', ephemeral: true });
      }

      let newPage = currentPage;
      if (act === 'info_packnext') newPage = Math.min(session.pages.length - 1, currentPage + 1);
      if (act === 'info_packprev') newPage = Math.max(0, currentPage - 1);

      const packInfo = buildPackEmbed(session.crewDef, interaction.user, newPage);
      const embed = packInfo.embed || packInfo;

      const prevDisabled = newPage <= 0;
      const nextDisabled = newPage >= session.pages.length - 1;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`info_packprev:${ownerId}:${newPage}`)
          .setLabel('Previous')
          .setStyle(prevDisabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(prevDisabled),
        new ButtonBuilder()
          .setCustomId(`info_packnext:${ownerId}:${newPage}`)
          .setLabel('Next')
          .setStyle(nextDisabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(nextDisabled)
      );

      return safeUpdate(interaction, { embeds: [embed], components: [row] });
    }

    const session = global.infoSessions?.get(`${interaction.user.id}_info`);
    if (!session || session.userId !== interaction.user.id) {
      return safeReply(interaction, { content: 'Info session expired or not your session.', ephemeral: true });
    }

    const user = await User.findOne({ userId: interaction.user.id });
    const currentIndex = parseInt(session.currentIndex ?? 0, 10) || 0;

    if (action === 'info_prev' || action === 'info_next') {
      let nextIndex = currentIndex;
      if (action === 'info_prev') nextIndex = Math.max(0, currentIndex - 1);
      if (action === 'info_next') nextIndex = Math.min(session.cards.length - 1, currentIndex + 1);
      return renderInfoCard(interaction, session, user, nextIndex);
    }

    if (action === 'info_boost') {
      const cardDef = session.cards[currentIndex];
      const userEntry = user?.ownedCards?.find(e => e.cardId === cardDef.id) || null;
      const embed = buildBoostEmbed(cardDef, userEntry, user);
      return safeReply(interaction, { embeds: [embed], ephemeral: true });
    }

    return safeReply(interaction, { content: 'Unknown action.', ephemeral: true });
  }
};