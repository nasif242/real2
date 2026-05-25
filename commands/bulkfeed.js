const { EmbedBuilder } = require('discord.js');
const User = require('../models/User');
const { searchCards } = require('../utils/cards');
const { levelers } = require('../data/levelers');
const { getMaxLevelForRank } = require('../utils/starLevel');

function normalizeQuery(query) {
  return query ? query.trim().toLowerCase() : '';
}

function splitList(raw) {
  const items = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function parseSegment(segment) {
  const amountMatch = segment.match(/^(?:"([^"]+)"|([^\-]+?))\s*-\s*(\d+)$/i);
  if (amountMatch) {
    const query = (amountMatch[1] || amountMatch[2] || '').trim();
    return { query, amount: parseInt(amountMatch[3], 10) };
  }
  const allMatch = segment.match(/^all(?:\s+(.+))?$/i);
  if (allMatch) {
    const query = (allMatch[1] || '').trim();
    return { query: query || 'all', amount: 'all' };
  }
  const allDashMatch = segment.match(/^(?:"([^"]+)"|([^\-]+?))\s*-\s*all$/i);
  if (allDashMatch) {
    const query = (allDashMatch[1] || allDashMatch[2] || '').trim();
    return { query, amount: 'all' };
  }
  return { query: segment.trim(), amount: 1 };
}

function searchLevelers(query) {
  if (!query) return [];
  const q = query.toLowerCase();
  const matches = levelers.filter(l => {
    if (l.id.toLowerCase() === q) return true;
    if (l.name.toLowerCase() === q) return true;
    if (l.name.toLowerCase().includes(q)) return true;
    if (l.attribute.toLowerCase() === q) return true;
    return false;
  });
  return matches;
}

function findLeveler(query) {
  const q = normalizeQuery(query);
  if (!q) return null;
  const exact = levelers.find(l => l.id.toLowerCase() === q || l.name.toLowerCase() === q);
  if (exact) return exact;
  return searchLevelers(q)[0] || null;
}

function findAllLevelers(query, user) {
  const q = normalizeQuery(query).replace(/levelers?$/, '').trim();
  return levelers.filter(l => {
    if (!q) return true;
    if (l.name.toLowerCase().includes(q)) return true;
    if (l.attribute.toLowerCase().includes(q)) return true;
    return false;
  }).filter(l => user.items.some(item => item.itemId === l.id && item.quantity > 0));
}

function getLevelerXp(leveler, card) {
  if (typeof leveler.xp === 'object') {
    return leveler.xp[card.attribute] || 0;
  }
  return Number(leveler.xp || 0);
}

module.exports = {
  name: 'bulkfeed',
  description: 'Feed multiple levelers to a card at once',
  options: [
    { name: 'query', type: 3, description: 'Levelers and amounts, optionally ending with "to <card>"', required: true },
    { name: 'card', type: 3, description: 'Target card name (optional if using "to <card>")', required: false }
  ],
  async execute({ message, interaction, args }) {
    const raw = message ? args.join(' ') : interaction.options.getString('query');
    const cardOverride = interaction ? interaction.options.getString('card') : null;
    const userId = message ? message.author.id : interaction.user.id;
    const user = await User.findOne({ userId });
    if (!user) {
      const reply = 'You don\'t have an account. Run `op start` or /start to register.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    if (!raw || !raw.trim()) {
      const reply = 'Please specify which levelers to feed and the target card.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    let itemPart = raw;
    let cardQuery = cardOverride || null;
    const hyphenAllMatch = raw.match(/^(.*?)\s*-\s*all\s+(.+)$/i);
    if (hyphenAllMatch) {
      itemPart = hyphenAllMatch[1].trim();
      cardQuery = cardOverride || hyphenAllMatch[2].trim();
    }
    const toMatch = raw.match(/\s+to\s+(.+)$/i);
    if (!cardQuery && toMatch) {
      itemPart = raw.slice(0, toMatch.index).trim();
      cardQuery = cardOverride || toMatch[1].trim();
    }

    if (!cardQuery) {
      const reply = 'Please specify a target card with `to <card>` or the card argument.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const normalizedCard = cardQuery.trim().toLowerCase();
    const cardCandidates = searchCards(normalizedCard).filter(c => !c.artifact && !c.ship);
    const ownedIds = (user.ownedCards || []).map(c => c.cardId);
    const ownedMatches = cardCandidates.filter(c => ownedIds.includes(c.id));
    const targetCard = ownedMatches.length ? ownedMatches[ownedMatches.length - 1] : null;
    if (!targetCard) {
      const reply = `No owned card found matching **${cardQuery}**. Please specify a non-artifact card you own.`;
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const ownedEntry = user.ownedCards.find(c => c.cardId === targetCard.id);
    if (!ownedEntry) {
      const reply = `You don't own ${targetCard.character}.`;
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const segments = splitList(itemPart);
    const requests = segments.map(parseSegment);
    const feedActions = [];

    for (const req of requests) {
      if (!req.query) continue;
      if (req.amount === 'all') {
        const levelerMatches = findAllLevelers(req.query, user);
        if (!levelerMatches.length) continue;
        for (const leveler of levelerMatches) {
          const item = user.items.find(i => i.itemId === leveler.id);
          if (!item || item.quantity <= 0) continue;
          feedActions.push({ leveler, quantity: item.quantity });
        }
        continue;
      }

      const leveler = findLeveler(req.query);
      if (!leveler) {
        const reply = `No leveler found for **${req.query}**.`;
        if (message) return message.channel.send(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }
      const item = user.items.find(i => i.itemId === leveler.id);
      if (!item || item.quantity <= 0) {
        const reply = `You don't have any **${leveler.name}**.`;
        if (message) return message.channel.send(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }
      const quantity = Math.min(item.quantity, req.amount);
      feedActions.push({ leveler, quantity });
    }

    if (!feedActions.length) {
      const reply = 'No valid levelers found to feed.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    let totalXp = 0;
    let levelsGained = 0;
    const feedNotes = [];

    for (const action of feedActions) {
      const xpPer = getLevelerXp(action.leveler, targetCard);
      if (xpPer <= 0) {
        const reply = `${action.leveler.emoji || ''} **${action.leveler.name}** cannot be fed to **${targetCard.character}**.`;
        if (message) return message.channel.send(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }
      const xpGain = xpPer * action.quantity;
      totalXp += xpGain;
      const currentXp = Number(ownedEntry.xp || 0);
      const currentLevel = Number(ownedEntry.level || 1);
      const totalXpNow = currentXp + xpGain;
      const gainedLevels = Math.floor(totalXpNow / 100) - Math.floor(currentXp / 100);
      const maxLevel = getMaxLevelForRank(targetCard.rank);
      const newLevel = Math.min(maxLevel, currentLevel + gainedLevels);
      levelsGained += newLevel - currentLevel;
      ownedEntry.level = newLevel;
      ownedEntry.xp = newLevel >= maxLevel ? 0 : totalXpNow % 100;

      const item = user.items.find(i => i.itemId === action.leveler.id);
      item.quantity -= action.quantity;
      if (item.quantity <= 0) {
        user.items = user.items.filter(i => i.itemId !== action.leveler.id);
      }
      feedNotes.push(`${action.leveler.emoji || ''} **${action.leveler.name}** x${action.quantity} (+${xpGain} XP)`);
    }

    await user.save();

    const embed = new EmbedBuilder()
      .setColor('#FFFFFF')
      .setTitle('Bulk Feed Complete')
      .setDescription(`Fed ${feedActions.length} leveler type(s) to **${targetCard.character}**.`)
      .addFields(
        { name: 'XP Gained', value: `${totalXp} XP`, inline: true },
        { name: 'Levels Gained', value: `${levelsGained}`, inline: true },
        { name: 'Details', value: feedNotes.join('\n') }
      );

    if (message) return message.channel.send({ embeds: [embed] });
    return interaction.reply({ embeds: [embed] });
  }
};
