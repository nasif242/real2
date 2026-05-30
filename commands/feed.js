const { EmbedBuilder } = require('discord.js');
const User = require('../models/User');
const { levelers } = require('../data/levelers');
const { findBestOwnedCard, parseCardAttributes } = require('../utils/cards');
const { applyDefaultEmbedStyle } = require('../utils/embedStyle');
const { getMaxLevelForRank } = require('../utils/starLevel');

// Fuzzy search for levelers - find exact name match first, then partial
function searchLevelers(query) {
  if (!query) return [];
  const q = query.toLowerCase();
  const matches = levelers.filter(l => {
    if (l.id.toLowerCase() === q) return true;
    if (l.name.toLowerCase() === q) return true; // exact match first
    if (l.name.toLowerCase().includes(q)) return true; // partial match
    // support short alias formed by first letter of each word, e.g. "Red Armoured Crab" -> "rac"
    const alias = (l.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(w => w[0]).join('');
    if (alias === q) return true;
    return false;
  });
  return matches;
}

function findFirstLeveler(query) {
  const results = searchLevelers(query);
  return results.length ? results[0] : null;
}

// Find leveler by multi-word matching from remaining args
function findLevelerFromArgs(args) {
  // Try progressively longer combinations
  for (let len = Math.min(3, args.length - 1); len >= 1; len--) {
    const query = args.slice(0, len).join(' ');
    const leveler = findFirstLeveler(query);
    if (leveler) {
      return { leveler, cardArgs: args.slice(len) };
    }
  }
  return null;
}

module.exports = {
  name: 'feed',
  description: 'Feed a leveler to a card to level it up',
  options: [
    { name: 'leveler', type: 3, description: 'Leveler item name', required: true },
    { name: 'card', type: 3, description: 'Card name', required: true },
    { name: 'amount', type: 4, description: 'Amount to feed (default 1)', required: false }
  ],
  async execute({ message, interaction, args }) {
    let leveler, cardQuery, amount = 1;
    const userId = message ? message.author.id : interaction.user.id;

    // Detect attribute / "all" mode (e.g., `op feed STR luffy` or `op feed all luffy`)
    const ATTRS = new Set(['str','dex','qck','psy','int','all']);
    let attributeMode = false;
    let attributeQuery = null;

    if (message) {
      if (args.length < 2) {
        return message.reply('Usage: `op feed <leveler|STR|all> <card> [amount]`');
      }

      const first = args[0] ? String(args[0]).toLowerCase() : '';
      if (ATTRS.has(first)) {
        attributeMode = true;
        attributeQuery = first.toUpperCase();
        cardQuery = args.slice(1).join(' ');
      } else {
        // Find leveler from multi-word args
        const result = findLevelerFromArgs(args);
        if (!result) {
          return message.reply('No leveler found matching those keywords.');
        }
        leveler = result.leveler;
        const cardArgs = result.cardArgs;
        if (cardArgs.length < 1) {
          return message.reply('Please specify a card name.');
        }
        cardQuery = cardArgs.join(' ');
        // If the last token looks like a number treat it as an amount ONLY when
        // there is also a card identifier present before it.
        const lastToken = cardArgs[cardArgs.length - 1];
        if (cardArgs.length > 1 && lastToken && !isNaN(parseInt(lastToken))) {
          amount = parseInt(lastToken);
          cardQuery = cardArgs.slice(0, -1).join(' ');
        }
      }
    } else {
      const levelerQuery = interaction.options.getString('leveler');
      if (levelerQuery && ATTRS.has(levelerQuery.toLowerCase())) {
        attributeMode = true;
        attributeQuery = levelerQuery.toUpperCase();
        cardQuery = interaction.options.getString('card');
      } else {
        leveler = findFirstLeveler(levelerQuery);
        cardQuery = interaction.options.getString('card');
        amount = interaction.options.getInteger('amount') || 1;
      }
    }

    const user = await User.findOne({ userId });
    if (!user) {
      const reply = 'You don\'t have an account. Run `/start` to register.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, flags: 64 });
    }

    if (amount < 1) {
      const reply = 'Amount must be at least 1.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, flags: 64 });
    }

    if (!leveler && !attributeMode) {
      const reply = `No leveler found.`;
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, flags: 64 });
    }

    // Check if user has enough (only for explicit leveler feed)
    let item = null;
    if (!attributeMode) {
      item = user.items.find(i => i.itemId === leveler.id);
      if (!item || item.quantity < amount) {
        const reply = `You don't have enough ${leveler.name}. You have ${item ? item.quantity : 0}.`;
        if (message) return message.reply(reply);
        return interaction.reply({ content: reply, flags: 64 });
      }
    }

    // Find card
    const card = await findBestOwnedCard(userId, cardQuery);
    if (!card) {
      const reply = `No card found matching **${cardQuery}**.`;
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, flags: 64 });
    }

    // Check if target is artifact or ship
    if (card.artifact || card.ship) {
      const type = card.artifact ? 'artifact' : 'ship';
      const reply = `You cannot feed levelers to a ${type}.`;
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, flags: 64 });
    }

    // Check if owned
    const ownedCard = user.ownedCards.find(c => c.cardId === card.id);
    if (!ownedCard) {
      const reply = `You don't own ${card.character}.`;
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, flags: 64 });
    }

    // Attribute mode: feed all matching levelers in inventory
    if (attributeMode) {
      const cardAttrs = parseCardAttributes(card.attribute || '');
      // For explicit attribute (STR/DEX/...), require the card to match that attribute
      if (attributeQuery !== 'ALL' && !cardAttrs.includes(attributeQuery)) {
        const reply = `This card is ${card.attribute}. Use \'op feed ${card.attribute} <card>\' or \'op feed all <card>\' to feed matching levelers.`;
        if (message) return message.reply(reply);
        return interaction.reply({ content: reply, flags: 64 });
      }

      // Collect candidate leveler defs to consume.
      // Rainbow levelers (xp is an object) work for any attribute card and are included.
      const isRainbowLeveler = l => typeof l.xp === 'object' && l.xp !== null;
      const defsToUse = levelers.filter(l => {
        if (isRainbowLeveler(l)) return true; // rainbow levelers always apply
        if (attributeQuery === 'ALL') {
          return (l.attribute === 'ALL') || cardAttrs.includes(l.attribute);
        }
        return l.attribute === attributeQuery || l.attribute === 'ALL';
      });

      let totalXp = 0;
      let consumed = 0;
      const consumedLines = [];
      for (const def of defsToUse) {
        const it = user.items.find(i => i.itemId === def.id && i.quantity > 0);
        if (!it) continue;
        const qty = it.quantity;
        // xp per item for this card
        let xpPer = 0;
        if (typeof def.xp === 'object') {
          if (def.attribute && cardAttrs.includes(def.attribute)) xpPer = Number(def.xp[def.attribute] || 0);
          else if (cardAttrs.length === 1) xpPer = Number(def.xp[cardAttrs[0]] || 0);
          else xpPer = Math.max(...cardAttrs.map(a => Number(def.xp[a] || 0)));
        } else xpPer = Number(def.xp || 0);
        if (!xpPer) continue;
        totalXp += xpPer * qty;
        consumed += qty;
        consumedLines.push(`${def.emoji} ${qty}x ${def.name} (+${xpPer * qty} XP)`);
        // remove items
        it.quantity = 0;
      }
      if (consumed === 0) {
        const reply = `You have no matching levelers to feed to ${card.character}.`;
        if (message) return message.reply(reply);
        return interaction.reply({ content: reply, flags: 64 });
      }

      // Apply XP
      const currentXp = Number(ownedCard.xp) || 0;
      const currentLevel = Number(ownedCard.level) || 1;
      const total = currentXp + totalXp;
      const levelsGained = Math.floor(total / 100);
      const maxLevel = getMaxLevelForRank(card.rank);
      ownedCard.level = Math.min(maxLevel, currentLevel + levelsGained);
      ownedCard.xp = ownedCard.level >= maxLevel ? 0 : total % 100;

      // Clean up consumed items
      user.items = (user.items || []).filter(i => i.quantity > 0);
      await user.save();

      const embed = new EmbedBuilder()
        .setDescription(`**Fed Levelers**\nFed ${consumed} leveler(s) to **${card.character}**.\n\n-# Items consumed:\n${consumedLines.join('\n')}\n\n-# Gained ${totalXp} XP!\n-# Current Level: ${ownedCard.level} (${ownedCard.xp} XP)`);
      applyDefaultEmbedStyle(embed, message ? message.author : interaction.user);
      if (message) return message.reply({ embeds: [embed] });
      return interaction.reply({ embeds: [embed] });
    }

    // Single-leveler mode (original behavior)
    // Validate attribute compatibility
    const cardAttrsSingle = parseCardAttributes(card.attribute || '');
    if (typeof leveler.xp !== 'object' && leveler.attribute !== 'ALL' && !cardAttrsSingle.includes(leveler.attribute)) {
      const reply = `${leveler.emoji} **${leveler.name}** (${leveler.attribute}) cannot be fed to **${card.character}** (${card.attribute}). Only ${leveler.attribute} cards can use this leveler!`;
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, flags: 64 });
    }

    // Calculate XP from the leveler exactly as defined in data/levelers.js
    let xpGain = 0;
    if (typeof leveler.xp === 'object') {
      if (leveler.attribute && cardAttrsSingle.includes(leveler.attribute)) xpGain = (leveler.xp[leveler.attribute] || 0) * amount;
      else if (cardAttrsSingle.length === 1) xpGain = (leveler.xp[cardAttrsSingle[0]] || 0) * amount;
      else xpGain = Math.max(...cardAttrsSingle.map(a => Number(leveler.xp[a] || 0))) * amount;
    } else {
      xpGain = Number(leveler.xp || 0) * amount;
    }

    // Add XP with level cap enforcement
    const currentXp = Number(ownedCard.xp) || 0;
    const currentLevel = Number(ownedCard.level) || 1;
    const normalizedXpGain = Number(xpGain) || 0;
    const totalXp = currentXp + normalizedXpGain;
    const levels = Math.floor(totalXp / 100);
    const maxLevel = getMaxLevelForRank(card.rank);
    ownedCard.level = Math.min(maxLevel, currentLevel + levels);
    ownedCard.xp = ownedCard.level >= maxLevel ? 0 : totalXp % 100;

    // Remove items
    item.quantity -= amount;
    if (item.quantity <= 0) {
      user.items = user.items.filter(i => i.itemId !== leveler.id);
    }

    await user.save();

    const embed = new EmbedBuilder()
      .setDescription(`**XP Awarded**\nFed ${amount}x  ${leveler.emoji} **${leveler.name}** to **${card.character}**.\n\n-# Gained ${xpGain} XP!\n-# Current Level: ${ownedCard.level} (${ownedCard.xp} XP)`);
    applyDefaultEmbedStyle(embed, message ? message.author : interaction.user);

    if (message) return message.reply({ embeds: [embed] });
    return interaction.reply({ embeds: [embed] });
  }
};