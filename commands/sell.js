const { EmbedBuilder } = require('discord.js');
const { findBestOwnedCard, getCardById } = require('../utils/cards');
const User = require('../models/User');
const { levelers } = require('../data/levelers');

const SELL_PRICES = {
  D: 1,
  C: 3,
  B: 5,
  A: 10,
  S: 25,
  SS: 100,
  UR: 250
};

// Fuzzy search for levelers
function searchLevelers(query) {
  if (!query) return [];
  const q = query.toLowerCase();
  const matches = levelers.filter(l => {
    if (l.id.toLowerCase() === q) return true;
    if (l.name.toLowerCase().includes(q)) return true;
    return false;
  });
  return matches;
}

function findFirstLeveler(query) {
  const results = searchLevelers(query);
  return results.length ? results[0] : null;
}

module.exports = {
  name: 'sell',
  description: 'Sell a card for currency based on its rank',
  options: [
    { name: 'query', type: 3, description: 'Card name', required: true }
  ],
  async execute({ message, interaction, args }) {
    const query = interaction ? interaction.options.getString('query') : args.join(' ');
    const userId = message ? message.author.id : interaction.user.id;
    let user = await User.findOne({ userId });
    
    if (!user) {
      const reply = 'You don\'t have an account. Run `op start` or /start to register.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    if (!query) {
      const reply = 'Please specify a card name.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const card = await findBestOwnedCard(userId, query);
    let isLeveler = false;
    let leveler;
    if (!card) {
      leveler = findFirstLeveler(query);
      if (!leveler) {
        const reply = `No card or leveler found matching **${query}**.`;
        if (message) return message.channel.send(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }
      isLeveler = true;
    }

    if (isLeveler) {
      // Sell leveler
      const item = user.items.find(i => i.itemId === leveler.id);
      if (!item || item.quantity < 1) {
        const reply = `You don't have ${leveler.name}.`;
        if (message) return message.channel.send(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }

      item.quantity -= 1;
      if (item.quantity <= 0) {
        user.items = user.items.filter(i => i.itemId !== leveler.id);
      }
      user.balance = (user.balance || 0) + leveler.beli;
      await user.save();

      const embed = new EmbedBuilder()
        .setColor('#FFFFFF')
        .setTitle('Item Sold!')
        .setDescription(`Sold ${leveler.emoji} **${leveler.name}** for **${leveler.beli}** ¥`);

      if (message) return message.channel.send({ embeds: [embed] });
      return interaction.reply({ embeds: [embed] });
    }

    // Sell card
    // Prevent selling favorited cards
    if (Array.isArray(user.favoriteCards) && user.favoriteCards.includes(card.id)) {
      const reply = `You can't sell **${card.character}** because it's favorited.`;
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }
    // Check if card is on team
    if (card.ship) {
      const reply = `You can't sell **${card.character}**.`;
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    if (user.team && user.team.includes(card.id)) {
      const reply = `You can't sell **${card.character}** while they're on your team.`;
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // Find the owned entry
    const ownedEntry = user.ownedCards.find(e => e.cardId === card.id);
    if (!ownedEntry) {
      const reply = `You don't own that card.`;
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // Prevent selling an artifact that is currently equipped
    if (card.artifact && ownedEntry && ownedEntry.equippedTo) {
      const reply = `You must unequip **${card.character}** before selling it.`;
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const price = SELL_PRICES[card.rank] || 0;
    user.ownedCards = user.ownedCards.filter(e => e.cardId !== card.id);
    user.balance = (user.balance || 0) + price;
    await user.save();

    const embed = new EmbedBuilder()
      .setColor('#FFFFFF')
      .setTitle('Card Sold!')
      .setDescription(`Sold **${card.character}** (${card.rank}) for **${price}** ¥`)
      .setThumbnail(card.image_url);

    if (message) return message.channel.send({ embeds: [embed] });
    return interaction.reply({ embeds: [embed] });
  }
};
