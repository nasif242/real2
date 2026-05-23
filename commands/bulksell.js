const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User = require('../models/User');
const { searchCards, getCardById } = require('../utils/cards');
const { levelers } = require('../data/levelers');

const pendingBulkSell = new Map();

function randomKey() {
  return `bulk_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
}

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
    return { type: 'item', query, amount: parseInt(amountMatch[3], 10) };
  }
  // Treat explicit 'all' or 'levelers' as all queries
  const allMatch = segment.match(/^all(?:\s+(.+))?$/i);
  if (allMatch) {
    const query = (allMatch[1] || '').trim();
    return { type: 'all', query };
  }
  const levelersOnly = segment.match(/^levelers?$/i);
  if (levelersOnly) return { type: 'all', query: '' };

  // Default: item with unspecified amount (null) meaning "all matches" unless amount explicitly provided
  return { type: 'item', query: segment.trim(), amount: null };
}

function isRainbowLeveler(l) {
  return typeof l.xp === 'object' && l.xp !== null;
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
  const match = levelers.find(l => l.id.toLowerCase() === q || l.name.toLowerCase() === q) || null;
  if (match && isRainbowLeveler(match)) return null;
  return match;
}

function findMatchingLevelers(query, user) {
  const q = normalizeQuery(query).replace(/levelers?$/, '').trim();
  if (!q) {
    return levelers.filter(l => !isRainbowLeveler(l) && user.items.some(item => item.itemId === l.id && item.quantity > 0));
  }
  return levelers.filter(l => {
    if (isRainbowLeveler(l)) return false;
    if (l.name.toLowerCase().includes(q)) return true;
    if (l.attribute.toLowerCase().includes(q)) return true;
    return false;
  }).filter(l => user.items.some(item => item.itemId === l.id && item.quantity > 0));
}

function findMatchingOwnedCards(query, user) {
  const q = normalizeQuery(query);
  const matched = q ? searchCards(q) : [];
  const ownedIds = user.ownedCards.map(e => e.cardId);
  const candidates = matched.length ? matched.filter(c => ownedIds.includes(c.id)) : [];
  if (candidates.length) {
    return candidates.filter(c => !c.artifact && !c.ship && !(user.team || []).includes(c.id));
  }
  // fallback to all owned cards if query is empty
  if (!q) {
    return user.ownedCards
      .map(entry => getCardById(entry.cardId))
      .filter(c => c && !c.artifact && !c.ship && !(user.team || []).includes(c.id));
  }
  return [];
}

const MAX_CARD_SELL = 20;

function getSellPriceForRank(rank) {
  const r = String(rank || '').toUpperCase();
  const map = { D: 1, C: 3, B: 5, A: 10, S: 25, SS: 100, UR: 250 };
  return map[r] || 0;
}

function buildSellPlan(user, requests) {
  const actions = [];
  let total = 0;
  const lines = [];
  // Helper: parse compact rank/type codes like CFC, CFUR, URFC, FCUR, etc.
  function parseRankTypeCode(raw) {
    if (!raw) return null;
    const norm = String(raw).replace(/\s+/g, '').toUpperCase();
    const ranks = ['UR','SS','S','A','B','C','D'];
    let foundRank = null;
    for (const r of ranks) {
      if (norm.includes(r)) { foundRank = r; break; }
    }
    if (!foundRank) return null;
    const remaining = norm.replace(foundRank, '');
    const typeMap = {
      'FC': 'fighting', 'CF': 'fighting',
      'BC': 'boost', 'CB': 'boost',
      'AC': 'attribute', 'CA': 'attribute'
    };
    if (typeMap[remaining]) return { rank: foundRank, type: typeMap[remaining] };
    return null;
  }

  for (const request of requests) {
    // Check for compact rank/type shorthand (e.g., CFC, URFC, CFUR)
    if (request.type === 'item' && request.query) {
      const rt = parseRankTypeCode(request.query);
      if (rt) {
        const ownedIds = (user.ownedCards || []).map(e => e.cardId);
        const matches = ownedIds
          .map(id => getCardById(id))
          .filter(Boolean)
          .filter(c => {
            if (String(c.rank).toUpperCase() !== String(rt.rank).toUpperCase()) return false;
            // fighting: exclude artifacts, ships, and explicit boost cards
            if (rt.type === 'fighting') return !c.artifact && !c.ship && !(c.boost || (c.type && String(c.type).toLowerCase() === 'boost')) && !(user.team || []).includes(c.id);
            // boost: include cards authored as boost/type boost
            if (rt.type === 'boost') return !!c.boost || (c.type && String(c.type).toLowerCase() === 'boost');
            // attribute: include artifact/type 'attribute' (ask to confirm if different desired)
            if (rt.type === 'attribute') return !!c.artifact || (c.type && String(c.type).toLowerCase() === 'attribute');
            return false;
          });
        for (const card of matches) {
          const price = getSellPriceForRank(card.rank);
          if (price <= 0) continue;
          actions.push({ type: 'card', card, price });
          total += price;
          lines.push(`${card.emoji || ''} **${card.character}** (${card.rank})`);
        }
        continue;
      }
      // Check for simple rank-only queries like 's', 'ss', 'ur', 'a', etc.
      const rankOnlyMatch = String(request.query || '').trim().toUpperCase().match(/^(D|C|B|A|S|SS|UR)$/);
      if (rankOnlyMatch) {
        const wantedRank = rankOnlyMatch[1];
        const ownedIds = (user.ownedCards || []).map(e => e.cardId);
        const matches = ownedIds
          .map(id => getCardById(id))
          .filter(Boolean)
          .filter(c => !c.ship && String(c.rank).toUpperCase() === String(wantedRank).toUpperCase());
        for (const card of matches) {
          const price = getSellPriceForRank(card.rank);
          if (price <= 0) continue;
          actions.push({ type: 'card', card, price });
          total += price;
          lines.push(`${card.emoji || ''} **${card.character}** (${card.rank})`);
        }
        continue;
      }
    }
    if (request.type === 'all') {
      const matches = findMatchingLevelers(request.query, user);
      if (matches.length) {
        for (const leveler of matches) {
          const item = user.items.find(i => i.itemId === leveler.id);
          if (!item || item.quantity <= 0) continue;
          actions.push({ type: 'leveler', leveler, quantity: item.quantity });
          total += leveler.beli * item.quantity;
          lines.push(`${leveler.emoji || ''} **${leveler.name}** x${item.quantity}`);
        }
        continue;
      }
      const cardMatches = findMatchingOwnedCards(request.query, user);
      for (const card of cardMatches) {
        const price = getSellPriceForRank(card.rank);
        if (price <= 0) continue;
        actions.push({ type: 'card', card, price });
        total += price;
        lines.push(`${card.emoji || ''} **${card.character}** (${card.rank})`);
      }
      continue;
    }

    const leveler = findLeveler(request.query);
    if (leveler) {
      const item = user.items.find(i => i.itemId === leveler.id);
      if (!item || item.quantity <= 0) continue;
      // Default to selling all of a leveler when no explicit amount provided
      let quantity;
      if (request.amount === null || request.amount === undefined) quantity = item.quantity;
      else if (request.amount === 'all') quantity = item.quantity;
      else quantity = Math.min(item.quantity, Number(request.amount) || item.quantity);
      actions.push({ type: 'leveler', leveler, quantity });
      total += leveler.beli * quantity;
      lines.push(`${leveler.emoji || ''} **${leveler.name}** x${quantity}`);
      continue;
    }

    const broadLevelers = findMatchingLevelers(request.query, user);
    if (broadLevelers.length) {
      for (const levelerMatch of broadLevelers) {
        const item = user.items.find(i => i.itemId === levelerMatch.id);
        if (!item || item.quantity <= 0) continue;
        let quantity;
        if (request.amount === null || request.amount === undefined) quantity = item.quantity;
        else if (request.amount === 'all') quantity = item.quantity;
        else quantity = Math.min(item.quantity, Number(request.amount) || item.quantity);
        actions.push({ type: 'leveler', leveler: levelerMatch, quantity });
        total += levelerMatch.beli * quantity;
        lines.push(`${levelerMatch.emoji || ''} **${levelerMatch.name}** x${quantity}`);
      }
      continue;
    }

    const cardMatches = findMatchingOwnedCards(request.query, user);
    if (!cardMatches.length) continue;
    // If no explicit amount provided, default to selling all matching cards
      const requested = (request.amount === null || request.amount === undefined) ? cardMatches.length : Math.max(0, Number(request.amount) || 0);
    let remaining = Math.min(requested, cardMatches.length);
    for (const card of cardMatches) {
      if (remaining <= 0) break;
      const price = getSellPriceForRank(card.rank);
      if (price <= 0) continue;
      actions.push({ type: 'card', card, price });
      total += price;
      lines.push(`${card.emoji || ''} **${card.character}** (${card.rank})`);
      remaining -= 1;
    }
  }

  return { actions, total, lines };
}

async function performSell(user, actions) {
  let total = 0;
  const soldLines = [];

  for (const action of actions) {
    if (action.type === 'leveler') {
      const item = user.items.find(i => i.itemId === action.leveler.id);
      if (!item || item.quantity < action.quantity) continue;
      item.quantity -= action.quantity;
      if (item.quantity <= 0) {
        user.items = user.items.filter(i => i.itemId !== action.leveler.id);
      }
      total += action.leveler.beli * action.quantity;
      soldLines.push(`${action.leveler.emoji || ''} **${action.leveler.name}** x${action.quantity}`);
    } else if (action.type === 'card') {
      const ownedIndex = user.ownedCards.findIndex(e => e.cardId === action.card.id);
      if (ownedIndex < 0) continue;
      user.ownedCards.splice(ownedIndex, 1);
      total += action.price;
      soldLines.push(`${action.card.emoji || ''} **${action.card.character}** (${action.card.rank})`);
    }
  }

  user.balance = (user.balance || 0) + total;
  await user.save();
  return { total, soldLines };
}

module.exports = {
  name: 'bulksell',
  description: 'Sell multiple cards or levelers at once',
  options: [{ name: 'query', type: 3, description: 'Items to sell', required: true }],
  async execute({ message, interaction, args }) {
    const raw = message ? args.join(' ') : interaction.options.getString('query');
    const userId = message ? message.author.id : interaction.user.id;
    const user = await User.findOne({ userId });
    if (!user) {
      const reply = 'You don\'t have an account. Run `op start` or /start to register.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    if (!raw || !raw.trim()) {
      const reply = 'Please specify what you want to sell.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const segments = splitList(raw);
    const requests = segments.map(parseSegment);
    const plan = buildSellPlan(user, requests);

    if (!plan.actions.length) {
      const reply = 'No sellable items or cards were found for that query.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const token = randomKey();
    pendingBulkSell.set(token, { userId, requests, createdAt: Date.now() });

    // Limit displayed lines to MAX_CARD_SELL and show "and N more" if applicable,
    // but the plan.actions contains all items that will be sold.
    const displayLimit = MAX_CARD_SELL;
    const displayLines = plan.lines.slice(0, displayLimit);
    if (plan.lines.length > displayLimit) displayLines.push(`and ${plan.lines.length - displayLimit}x more...`);
    const description = `Are you sure you want to sell the following items for **${plan.total}** ¥?\n\n${displayLines.join('\n')}`;
    const embed = new EmbedBuilder()
      .setColor('#FFFFFF')
      .setTitle('Confirm Bulk Sell')
      .setDescription(description);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bulksell_confirm:${token}:yes`)
        .setLabel('Yes')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`bulksell_confirm:${token}:no`)
        .setLabel('No')
        .setStyle(ButtonStyle.Secondary)
    );

    if (message) return message.channel.send({ embeds: [embed], components: [row] });
    return interaction.reply({ embeds: [embed], components: [row] });
  },

  async handleButton(interaction, action, token) {
    const session = pendingBulkSell.get(token);
    if (!session) {
      return interaction.reply({ content: 'That sell confirmation has expired.', ephemeral: true });
    }
    if (interaction.user.id !== session.userId) {
      return interaction.reply({ content: 'Only the original user can confirm this sell.', ephemeral: true });
    }

    if (action === 'no') {
      pendingBulkSell.delete(token);
      if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { content: 'Bulk sell cancelled.', embeds: [], components: [] });
      return global.safeUpdate(interaction, { content: 'Bulk sell cancelled.', embeds: [], components: [] });
    }

    const user = await User.findOne({ userId: session.userId });
    if (!user) {
      pendingBulkSell.delete(token);
      if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { content: 'Your account could not be found.', embeds: [], components: [] });
      return global.safeUpdate(interaction, { content: 'Your account could not be found.', embeds: [], components: [] });
    }

    const plan = buildSellPlan(user, session.requests);
    if (!plan.actions.length) {
      pendingBulkSell.delete(token);
      if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { content: 'Nothing could be sold. Your inventory may have changed.', embeds: [], components: [] });
      return global.safeUpdate(interaction, { content: 'Nothing could be sold. Your inventory may have changed.', embeds: [], components: [] });
    }

    const result = await performSell(user, plan.actions);
    pendingBulkSell.delete(token);

    const embed = new EmbedBuilder()
      .setColor('#FFFFFF')
      .setTitle('Bulk Sell Completed');

    // Limit sold lines display and show "and Nx more..." if necessary
    const soldDisplayLimit = MAX_CARD_SELL;
    const soldLinesDisplay = result.soldLines.slice(0, soldDisplayLimit);
    if (result.soldLines.length > soldDisplayLimit) soldLinesDisplay.push(`and ${result.soldLines.length - soldDisplayLimit}x more...`);
    embed.setDescription(`Sold ${result.soldLines.length} item(s) for **${result.total}** ¥.\n\n${soldLinesDisplay.join('\n')}`);

    if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { embeds: [embed], components: [] });
    return global.safeUpdate(interaction, { embeds: [embed], components: [] });
  }
};
