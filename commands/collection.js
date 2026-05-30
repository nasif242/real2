const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, AttachmentBuilder } = require('discord.js');
const User = require('../models/User');
const { getCardById, buildCardEmbed, getCardFinalStats } = require('../utils/cards');
const abilities = require('../utils/abilities');
const { generateArtifactImage } = require('../utils/artifactImage');

const RANK_ORDER = { D: 1, C: 2, B: 3, A: 4, S: 5, SS: 6, UR: 7 };

function compareCards(a, b, mode, user) {
  const levelA = a.entry?.level || 1;
  const levelB = b.entry?.level || 1;
  const rankA = RANK_ORDER[a.card.rank] || 0;
  const rankB = RANK_ORDER[b.card.rank] || 0;
  const powerA = typeof a.scaledPower === 'number' ? a.scaledPower : getCardFinalStats(a.card, levelA, user).scaled.power;
  const powerB = typeof b.scaledPower === 'number' ? b.scaledPower : getCardFinalStats(b.card, levelB, user).scaled.power;

  switch (mode) {
    case 'strongest-weakest':
      // Prefer higher rank first, then by boosted power
      if (rankA !== rankB) return rankB - rankA;
      if (powerA !== powerB) return powerB - powerA;
      if (a.card.mastery !== b.card.mastery) return b.card.mastery - a.card.mastery;
      if (levelA !== levelB) return levelB - levelA;
      return a.card.character.localeCompare(b.card.character);
    case 'weakest-strongest':
      // Prefer lower rank first, then by boosted power
      if (rankA !== rankB) return rankA - rankB;
      if (powerA !== powerB) return powerA - powerB;
      if (a.card.mastery !== b.card.mastery) return a.card.mastery - b.card.mastery;
      if (levelA !== levelB) return levelA - levelB;
      return a.card.character.localeCompare(b.card.character);
    case 'highest-level':
      if (levelA !== levelB) return levelB - levelA;
      if (rankA !== rankB) return rankB - rankA;
      return a.card.character.localeCompare(b.card.character);
    case 'lowest-level':
      if (levelA !== levelB) return levelA - levelB;
      if (rankA !== rankB) return rankA - rankB;
      return a.card.character.localeCompare(b.card.character);
    default:
      return compareCards(a, b, 'strongest-weakest', user);
  }
}

function sortAndFilter(items, mode, user) {
  let filtered = Array.isArray(items) ? [...items] : [];
  const attrMap = { dex: 'DEX', str: 'STR', qck: 'QCK', psy: 'PSY', int: 'INT' };
  const { parseCardAttributes } = require('../utils/cards');

  if (mode && mode.endsWith('-only')) {
    const key = mode.split('-')[0];
      if (attrMap[key]) {
      const attr = attrMap[key];
      filtered = filtered.filter(x => {
        const parts = parseCardAttributes(x.card.attribute || '');
        return parts.includes(attr);
      });
      mode = 'strongest-weakest';
    } else if (key === 'ships') {
      filtered = filtered.filter(x => x.card.ship);
      mode = 'strongest-weakest';
    } else if (key === 'artifacts') {
      filtered = filtered.filter(x => x.card.artifact);
      mode = 'strongest-weakest';
    }
  }

  if (['strongest-weakest', 'weakest-strongest', 'highest-level', 'lowest-level'].includes(mode)) {
    filtered.sort((a, b) => compareCards(a, b, mode, user));
  }

  return filtered;
}

function sortedOwnedCards(user) {
  if (!user || !Array.isArray(user.ownedCards) || !user.ownedCards.length) return [];

  // Faster sort: avoid computing full final stats for every card which can
  // be expensive for large collections. Use rank, level and base power as
  // a heuristic to order cards quickly; exact stats will be computed lazily
  // when rendering individual cards.
  const cardsWithDef = user.ownedCards
    .map(entry => {
      const cardDef = getCardById(entry.cardId);
      if (!cardDef) return null;
      const rankWeight = { D: 1, C: 2, B: 3, A: 4, S: 5, SS: 6, UR: 7 }[cardDef.rank] || 0;
      return { card: cardDef, entry, rankWeight, level: entry.level || 1, basePower: cardDef.power || 0 };
    })
    .filter(Boolean);

  // Sort using heuristic: rank desc, level desc, basePower desc, name
  cardsWithDef.sort((a, b) => {
    if (a.rankWeight !== b.rankWeight) return b.rankWeight - a.rankWeight;
    if (a.level !== b.level) return b.level - a.level;
    if (a.basePower !== b.basePower) return b.basePower - a.basePower;
    return a.card.character.localeCompare(b.card.character);
  });

  return sortAndFilter(cardsWithDef.map(c => ({ card: c.card, entry: c.entry })), 'strongest-weakest');
}

function makeNavRow(userId, index, total, cardDef, owned) {
  const prevDisabled = index <= 0;
  const nextDisabled = index >= total - 1;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`collection_prev:${userId}:${index}`)
      .setLabel('Previous')
      .setEmoji({ id: '1489374714379112449' })
      .setStyle(prevDisabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(prevDisabled),
    new ButtonBuilder()
      .setCustomId(`collection_next:${userId}:${index}`)
      .setLabel('Next')
      .setEmoji({ id: '1489374606916714706' })
      .setStyle(nextDisabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(nextDisabled)
  );

  if (owned && cardDef && !cardDef.ship) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`collection_boost:${userId}`)
        .setLabel('Boosts')
        .setEmoji({ id: '1490506833344073768' })
        .setStyle(ButtonStyle.Secondary)
    );
  }

  if (cardDef && abilities.hasAbility(cardDef)) {
    const btn = abilities.makeAbilityButton(cardDef);
    if (btn) row.addComponents(btn);
  }

  return row;
}

function makeSortButton(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`collection_sort:${userId}`)
      .setLabel('Sort/Filter')
      .setEmoji({ id: '1489377118637916270' })
      .setStyle(ButtonStyle.Secondary)
  );
}

function makeSortMenu(userId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`collection_sort_select:${userId}`)
      .setPlaceholder('Choose sort / filter option...')
      .addOptions([
        { label: 'Strongest to weakest', value: 'strongest-weakest' },
        { label: 'Weakest to strongest', value: 'weakest-strongest' },
        { label: 'Highest level to lowest', value: 'highest-level' },
        { label: 'Lowest level to highest', value: 'lowest-level' },
        { label: 'Only DEX', value: 'dex-only' },
        { label: 'Only STR', value: 'str-only' },
        { label: 'Only QCK', value: 'qck-only' },
        { label: 'Only PSY', value: 'psy-only' },
        { label: 'Only INT', value: 'int-only' },
        { label: 'Only Ships', value: 'ships-only' },
        { label: 'Only Artifacts', value: 'artifacts-only' }
      ])
  );
}

function buildCollectionBoostEmbed(cardDef, userEntry, user) {
  const lvl = userEntry ? userEntry.level : 1;
  const stats = getCardFinalStats(cardDef, lvl, user);
  const boostEntries = stats.boostEntries || [];
  const statBoosts = stats.statBoosts || {};
  // Calculate level boost percent
  const levelBoostPct = Math.ceil(lvl / 10); // +1% per 10 levels, rounded up

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
  // Always show level boost last, no emoji
  lines.push(`**Levels**: \`+${levelBoostPct}%\` All stats`);

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
    const artifactTotal = Math.round((artifactBasePct + levelBoostPct) * 10) / 10;
    totalParts.push(`\`${artifactTotal}%\` All stats`);
  } else {
    const allStatsTotal = levelBoostPct + (stats.totalBoostPct || 0);
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

async function renderCard(interaction, session, index) {
  const item = session.cards[index];
  if (!item) {
    return interaction.reply({ content: 'No collection card found.', ephemeral: true });
  }

  const avatarUrl = interaction.user.displayAvatarURL();
  const embed = buildCardEmbed(item.card, item.entry, avatarUrl, session.cachedUser);

  const rowNav = makeNavRow(interaction.user.id, index, session.cards.length, item.card, !!item.entry);
  const rowSort = makeSortButton(interaction.user.id);
  const components = [rowNav, rowSort];

  // Attach generated artifact image when necessary
  let files;
  if (item.card && item.card.artifact) {
    try {
      const buf = await generateArtifactImage(item.card);
      files = [new AttachmentBuilder(buf, { name: `artifact-${item.card.id}.png` })];
    } catch (e) {
      console.error('Failed to generate artifact image for collection render', e);
    }
  }

  if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { embeds: [embed], components, files });
  return global.safeUpdate(interaction, { embeds: [embed], components, files });
}

module.exports = {
  name: 'collection',
  description: 'View your owned card collection (best to worst)',
  async execute({ message, interaction, args }) {
    const userId = message ? message.author.id : interaction.user.id;
    const user = await User.findOne({ userId });
    if (!user) {
      const reply = "You don't have an account. Run `op start` or /start to register.";
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const sorted = sortedOwnedCards(user);
    if (!sorted.length) {
      const reply = 'Your collection is empty.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const FILTER_ALIASES = {
      stw: 'strongest-weakest', wts: 'weakest-strongest',
      htl: 'highest-level', lth: 'lowest-level',
      dex: 'dex-only', str: 'str-only', qck: 'qck-only',
      psy: 'psy-only', spy: 'psy-only', int: 'int-only',
      s: 'ships-only', ships: 'ships-only',
      a: 'artifacts-only', artifacts: 'artifacts-only',
    };
    const filterArg = (args?.[0] || '').toLowerCase();
      const initialMode = FILTER_ALIASES[filterArg] || 'strongest-weakest';
      let initialCards = initialMode !== 'strongest-weakest'
        ? sortAndFilter(sorted, initialMode, user)
        : sorted;

      // If a non-alias arg is provided, treat it as a character or faction query
      if (args && args.length && !FILTER_ALIASES[filterArg]) {
        const { cards: allCards } = require('../data/cards');
        function normalizeFaculty(f) {
          if (!f || f === 'null') return null;
          const t = f.trim();
          if (t.toLowerCase() === 'marines') return 'Marines';
          return t;
        }

        const FACTIONS = [...new Set(allCards.map(c => normalizeFaculty(c.faculty)).filter(Boolean))].sort();
        const query = args.join(' ').toLowerCase().trim();

        // Try faction match first (allow partial match), then character exact then substring
        const matchedFaction = FACTIONS.find(f => f.toLowerCase().includes(query) || query.includes(f.toLowerCase()));
        let matchedIds = new Set();
        if (matchedFaction) {
          allCards.filter(c => normalizeFaculty(c.faculty) === matchedFaction).forEach(c => matchedIds.add(c.id));
        } else {
          // character exact match first
          let matched = allCards.filter(c => c.character.toLowerCase() === query || (Array.isArray(c.alias) && c.alias.some(a => a.toLowerCase() === query)));
          if (!matched.length) {
            matched = allCards.filter(c => c.character.toLowerCase().includes(query) || (Array.isArray(c.alias) && c.alias.some(a => a.toLowerCase().includes(query))));
          }
          matched.forEach(c => matchedIds.add(c.id));
        }

        if (matchedIds.size > 0) {
          initialCards = initialCards.filter(item => matchedIds.has(item.card.id));
        }
      }

    const session = { userId, cards: initialCards, original: sorted, currentIndex: 0, mode: initialMode, cachedUser: user };
    if (!global.collectionSessions) global.collectionSessions = new Map();
    global.collectionSessions.set(`${userId}_collection`, session);

    const firstCard = initialCards[0];
    const avatarUrl = message ? message.author.displayAvatarURL() : interaction.user.displayAvatarURL();
    const embed = buildCardEmbed(firstCard.card, firstCard.entry, avatarUrl, user);
    const rowNav = makeNavRow(userId, 0, initialCards.length, firstCard.card, !!firstCard.entry);
    const rowSort = makeSortButton(userId);
    const components = [rowNav, rowSort];

    // Attach generated artifact image when necessary
    let files;
    if (firstCard.card && firstCard.card.artifact) {
      try {
        const buf = await generateArtifactImage(firstCard.card);
        files = [new AttachmentBuilder(buf, { name: `artifact-${firstCard.card.id}.png` })];
      } catch (e) {
        console.error('Failed to generate artifact image for collection execute', e);
      }
    }

    if (message) {
      return message.channel.send({ embeds: [embed], components, files });
    }

    return interaction.reply({ embeds: [embed], components, files });
  },

  async handleButton(interaction, customId) {
    const [action, uid, indexPart] = customId.split(':');
    const session = global.collectionSessions?.get(`${interaction.user.id}_collection`);
    if (!session || session.userId !== interaction.user.id) {
      return interaction.reply({ content: 'Collection session expired or not your session.', ephemeral: true });
    }

    if (action === 'collection_sort') {
      return global.safeUpdate(interaction, { content: 'Choose sort/filter option:', embeds: [], files: [], components: [makeSortMenu(uid)] });
    }

    if (action === 'collection_sort_select') {
      const mode = interaction.values?.[0] || 'strongest-weakest';
      const filtered = sortAndFilter(session.original, mode, session.cachedUser);
      session.cards = filtered;
      session.currentIndex = 0;
      session.mode = mode;

      if (!filtered.length) {
        return global.safeUpdate(interaction, { content: 'No cards match that filter.', embeds: [], files: [], components: [] });
      }

      try {
        return await renderCard(interaction, session, 0);
      } catch (err) {
        console.error('renderCard error after sort:', err);
        return global.safeUpdate(interaction, { content: 'Failed to render card. Please try again.', embeds: [], files: [], components: [] });
      }
    }

    if (action === 'collection_boost') {
      const item = session.cards[session.currentIndex];
      if (!item) {
        return interaction.reply({ content: 'No card found at current index.', ephemeral: true });
      }
      const embed = buildCollectionBoostEmbed(item.card, item.entry, session.cachedUser);
      if (global && typeof global.safeReply === 'function') return global.safeReply(interaction, { embeds: [embed], ephemeral: true });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    const currentIndex = parseInt(indexPart, 10) || 0;
    let nextIndex = currentIndex;
    if (action === 'collection_next') nextIndex = Math.min(session.cards.length - 1, currentIndex + 1);
    if (action === 'collection_prev') nextIndex = Math.max(0, currentIndex - 1);

    session.currentIndex = nextIndex;

    return renderCard(interaction, session, nextIndex);
  },
  sortedOwnedCards
};