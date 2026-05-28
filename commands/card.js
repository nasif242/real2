const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { searchCards } = require('../utils/cards');
const User = require('../models/User');
const { generateArtifactImage } = require('../utils/artifactImage');

function makeComponents(cardDef, userEntry = null) {
  const abilities = require('../utils/abilities');
  const prevAvailable = cardDef.mastery > 1;
  const nextAvailable = cardDef.mastery < cardDef.mastery_total;
  const components = [
    new ButtonBuilder()
      .setCustomId(`mastery_prev:${cardDef.id}`)
      .setLabel('Previous')
      .setStyle(prevAvailable ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!prevAvailable),
    new ButtonBuilder()
      .setCustomId(`mastery_next:${cardDef.id}`)
      .setLabel('Next')
      .setStyle(nextAvailable ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!nextAvailable)
  ];

  if (userEntry && !cardDef.ship) {
    components.push(
      new ButtonBuilder()
        .setCustomId(`info_boost:boost`)
        .setLabel('Boosts')
        .setEmoji('<:boosticon:1490506833344073768>')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  if (abilities.hasAbility(cardDef)) {
    const abilityBtn = abilities.makeAbilityButton(cardDef);
    if (abilityBtn) components.push(abilityBtn);
  }

  return new ActionRowBuilder().addComponents(...components);
}

module.exports = {
  name: 'card',
  description: 'Lookup a card by name',
  options: [{ name: 'query', type: 3, description: 'Card name', required: true }],
  async execute({ message, interaction, args }) {
    const query = message ? args.join(' ') : interaction.options.getString('query');
    const results = searchCards(query);
    if (!results.length) {
      const reply = `No card found matching **${query}**.`;
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }
    const cardDef = results[0];

    // find user state
    let userEntry = null;
    let userDoc = null;
    if (message || interaction) {
      const userId = message ? message.author.id : interaction.user.id;
      const user = await User.findOne({ userId });
      if (user) {
        userDoc = user;
        userEntry = user.ownedCards.find(e => e.cardId === cardDef.id);
      }
    }

    const avatarUrl = message ? message.author.displayAvatarURL() : interaction.user.displayAvatarURL();
    const { buildCardEmbed } = require('../utils/cards');
    const embed = buildCardEmbed(cardDef, userEntry, avatarUrl, userDoc);
    const components = [makeComponents(cardDef, userEntry)];

    // Attach generated artifact image when appropriate
    let files;
    if (cardDef && cardDef.artifact) {
      try {
        const buf = await generateArtifactImage(cardDef);
        files = [new AttachmentBuilder(buf, { name: `artifact-${cardDef.id}.png` })];
      } catch (e) {
        console.error('Failed to generate artifact image for card command', e);
      }
    }

    if (message) return message.channel.send({ embeds: [embed], components, files });
    return interaction.reply({ embeds: [embed], components, files });
  }
};

// export helper so other commands (info) can reuse the mastery navigation
module.exports.makeComponents = makeComponents;