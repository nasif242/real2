const User = require('../models/User');
const { EmbedBuilder } = require('discord.js');
const { getCurrentStock, getPricing } = require('../src/stock');
const crews = require('../data/crews');
const { rods } = require('../data/rods');
const { chests } = require('../data/chests');
const { applyDefaultEmbedStyle } = require('../utils/embedStyle');
const { sanitizeUserRods } = require('../utils/inventoryHelper');

// Simple fuzzy matching function
function fuzzyMatch(query, candidates) {
  const q = query.toLowerCase();
  let best = null;
  let bestScore = -Infinity;

  candidates.forEach(candidate => {
    const c = candidate.toLowerCase();
    let score = 0;

    // Exact match gets highest score
    if (c === q) {
      score = 1000;
    } else if (c.includes(q)) {
      // Substring match
      score = 100;
    } else {
      // Fuzzy match: count matching characters in order
      let qIdx = 0;
      for (let i = 0; i < c.length && qIdx < q.length; i++) {
        if (c[i] === q[qIdx]) {
          score += 10;
          qIdx++;
        }
      }
      // Only consider if we matched at least half the query
      if (qIdx < q.length / 2) {
        score = -1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  });

  return bestScore > 0 ? best : null;
}

const CHEST_ITEMS = chests.reduce((map, chest) => {
  const item = { name: chest.name, cost: chest.price, type: 'item', itemId: chest.id };
  map[chest.name.toLowerCase()] = item;
  chest.aliases.forEach(alias => {
    map[alias.toLowerCase()] = item;
  });
  return map;
}, {});

const SHOP_ITEMS = {
  'reset token': { name: 'Reset Token', cost: 500, type: 'item' },
  'god token': { name: 'God Token', cost: 8000, type: 'item', itemId: 'god_token' },
  'cola': { name: 'Cola', cost: 75, type: 'item', itemId: 'cola' },
  'basic rod': { name: 'Basic Rod', cost: 500, type: 'rod', rod: rods.find(r => r.id === 'basic_rod') },
  ...CHEST_ITEMS
};

// Add rods to shop items (excluding basic which is not purchaseable)
const shopRods = {
  'gold rod': rods.find(r => r.id === 'gold_rod'),
  'white rod': rods.find(r => r.id === 'white_rod'),
  'basic rod': rods.find(r => r.id === 'basic_rod')
};

function getSuggestionEmoji(suggestion) {
  const lowerSuggestion = suggestion.toLowerCase();
  const rod = shopRods[lowerSuggestion];
  return rod?.emoji ? `${rod.emoji} ` : '';
}

module.exports = {
  name: 'buy',
  description: 'Buy an item or pack from the shop',
  options: [{ name: 'item', type: 3, description: 'Item or pack name', required: true }, { name: 'amount', type: 4, description: 'Amount (default 1)', required: false }],
  async execute({ message, interaction, args }) {
    const userId = message ? message.author.id : interaction.user.id;
    let amount = 1;
    let itemQuery;
    if (message) {
      // check if last arg is a number
      const last = args[args.length - 1];
      const parsed = parseInt(last, 10);
      if (!isNaN(parsed)) {
        amount = parsed;
        itemQuery = args.slice(0, -1).join(' ');
      } else {
        itemQuery = args.join(' ');
      }
    } else {
      itemQuery = interaction.options.getString('item');
      amount = interaction.options.getInteger('amount') || 1;
    }

    let user = await User.findOne({ userId });
    if (!user) {
      const reply = 'You don\'t have an account. Run `op start` or /start to register.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    if (sanitizeUserRods(user)) {
      await user.save();
    }

    // Check for rods first
    let rodItem = null;
    const rodNames = Object.keys(shopRods);
    const matchedRod = fuzzyMatch(itemQuery, rodNames);
    if (matchedRod) {
      rodItem = shopRods[matchedRod];
    }

    // Check for shop items
    let item = null;
    let itemKey = fuzzyMatch(itemQuery, Object.keys(SHOP_ITEMS));
    if (itemKey) {
      item = SHOP_ITEMS[itemKey];
    } else if (rodItem) {
      // Rod is a shop item type
      item = { name: rodItem.name, cost: rodItem.cost, type: 'rod', rod: rodItem };
    } else {
      // Check for crew packs
      const stock = getCurrentStock();
      const crewNames = stock.map(c => c.name);
      const matchedCrew = fuzzyMatch(itemQuery, crewNames);
      if (matchedCrew) {
        const crew = stock.find(c => c.name === matchedCrew);
        item = {
          name: `${crew.name} Pack`,
          cost: getPricing()[crew.rank],
          type: 'pack',
          crew: crew
        };
      }
    }

    if (!item) {
      const available = Object.keys(SHOP_ITEMS).concat(rodNames).concat(getCurrentStock().map(c => c.name));
      const suggested = fuzzyMatch(itemQuery, available);
      const suggestionText = suggested ? ` Did you mean **${getSuggestionEmoji(suggested)}${suggested}**?` : '';
      const reply = `**${itemQuery}** is not a valid item. ${suggestionText}`;
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const totalCost = item.cost * amount;

    // ensure packInventory exists
    user.packInventory = user.packInventory || {};

    // Currency check / deduction
    let costCurrency = 'Gems';
    if (item.type === 'pack') {
      // gem purchase
      if ((user.gems || 0) < totalCost) {
        const reply = `You need **${totalCost}** Gems to buy ${amount}x ${item.name}. You only have **${user.gems || 0}** Gems.`;
        if (message) return message.reply(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }
      // For packs, check limit on user
      const currentCount = user.packInventory[item.crew.name] || 0;
      if (currentCount + amount > 5) {
        const reply = `You can only buy up to 5 ${item.crew.name} packs per stock cycle. You already have ${currentCount}.`;
        if (message) return message.reply(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }

      // Ensure per-user localStock key exists (set if missing)
      user.localStock = user.localStock || {};
      if (typeof user.localStock[item.crew.name] === 'undefined') {
        const globalStock = getCurrentStock();
        const match = globalStock.find(s => s.name === item.crew.name);
        const defaultQty = match ? (match.quantity || 0) : 0;
        await User.updateOne({ userId, [`localStock.${item.crew.name}`]: { $exists: false } }, { $set: { [`localStock.${item.crew.name}`]: defaultQty } }).catch(() => {});
      }

      // Atomic update: decrement gems and localStock, increment packInventory
      const upd = await User.updateOne(
        { userId, gems: { $gte: totalCost }, [`localStock.${item.crew.name}`]: { $gte: amount } },
        { $inc: { gems: -totalCost, [`packInventory.${item.crew.name}`]: amount, [`localStock.${item.crew.name}`]: -amount } }
      );
      if (!upd || upd.modifiedCount === 0) {
        const fresh = await User.findOne({ userId });
        if (!fresh || (fresh.gems || 0) < totalCost) {
          const reply = `You need **${totalCost}** Gems to buy ${amount}x ${item.name}. You only have **${fresh ? fresh.gems || 0 : 0}** Gems.`;
          if (message) return message.reply(reply);
          return interaction.reply({ content: reply, ephemeral: true });
        }
        if (!fresh.localStock || (fresh.localStock[item.crew.name] || 0) < amount) {
          const reply = `Not enough stock remaining for ${item.crew.name} packs.`;
          if (message) return message.reply(reply);
          return interaction.reply({ content: reply, ephemeral: true });
        }
        return interaction.reply({ content: 'Purchase failed due to a concurrent update. Please try again.', ephemeral: true });
      }
      // Success - reply and return early (no need to save user document here)
      const successReply = `Successfully purchased **${amount}x ${item.name}** for **${totalCost}** ${costCurrency}!`;
      if (message) return message.reply(successReply);
      return interaction.reply({ content: successReply });
    } else if (item.type === 'rod') {
      // Rod purchase: Rods cost Beli and add to inventory
      if (amount !== 1) {
        const reply = 'You can only purchase 1 rod at a time.';
        if (message) return message.reply(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }
      costCurrency = 'Beli';
      if ((user.balance || 0) < totalCost) {
        const reply = `You need **${totalCost}** Beli to buy ${item.name}. You only have **${user.balance || 0}** Beli.`;
        if (message) return message.reply(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }
      // Check if user already has this rod
      const existingRod = user.items.find(it => it.itemId === item.rod.id);
      if (existingRod) {
        const reply = `You already have the **${item.name}**!`;
        if (message) return message.reply(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }
      user.balance -= totalCost;
      // Add rod to items with durability
      user.items.push({ itemId: item.rod.id, quantity: 1, durability: item.rod.durability });
      // Set as current rod
      user.currentRod = item.rod.id;
    } else {
      // Other items (like chests or reset token) use beli
      costCurrency = 'Beli';
      if ((user.balance || 0) < totalCost) {
        const reply = `You need **${totalCost}** Beli to buy ${amount}x ${item.name}. You only have **${user.balance || 0}** Beli.`;
        if (message) return message.reply(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }
      user.balance -= totalCost;
      if (item.type === 'item' && item.itemId) {
        user.items = user.items || [];
        const existingItem = user.items.find(it => it.itemId === item.itemId);
        if (existingItem) {
          existingItem.quantity += amount;
        } else {
          user.items.push({ itemId: item.itemId, quantity: amount });
        }
      } else if (itemKey === 'reset token') {
        user.resetTokens = (user.resetTokens || 0) + amount;
      }
    }
    await user.save();

    const reply = `Successfully purchased **${amount}x ${item.name}** for **${totalCost}** ${costCurrency}!`;
    if (message) return message.reply(reply);
    return interaction.reply({ content: reply });
  }
};
