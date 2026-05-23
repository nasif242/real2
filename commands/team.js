const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { searchCards, findBestOwnedCard, getCardFinalStats } = require('../utils/cards');
const { generateTeamImage } = require('../utils/teamImage');
const User = require('../models/User');

function parseTargetIdFromArgs(args) {
  if (!args || args.length === 0) return null;
  const first = args[0];
  const mentionMatch = first.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];
  if (/^\d{17,19}$/.test(first)) return first;
  return null;
}


module.exports = {
  name: 'team',
  description: 'Manage your active team (max 3 cards)',
  options: [
    { name: 'view', type: 1, description: 'View your current team', options: [{ name: 'target', type: 6, description: 'User to view (optional)', required: false }] },
    { name: 'add', type: 1, description: 'Add a card to your active team',
      options: [{ name: 'query', type: 3, description: 'Card name', required: true }] },
    { name: 'remove', type: 1, description: 'Remove a card from your active team',
      options: [{ name: 'query', type: 3, description: 'Card name', required: true }] }
  ],
  async execute({ message, interaction, args }) {
    const currentUserId = message ? message.author.id : interaction.user.id;
    let sub = null;
    let query = '';
    let targetId = currentUserId;
    let targetUser = message ? message.author : interaction.user;

    if (interaction) {
      try {
        sub = interaction.options.getSubcommand();
      } catch (e) {
        sub = null;
      }
      query = interaction.options.getString('query');
      if (sub === 'view') {
        const targetOption = interaction.options.getUser('target');
        if (targetOption) {
          targetId = targetOption.id;
          targetUser = targetOption;
        }
      }
    } else {
      sub = args[0] && args[0].toLowerCase();
      if (sub === 'add' || sub === 'remove') {
        query = args.slice(1).join(' ');
      } else {
        const parsedTarget = parseTargetIdFromArgs(args);
        if (parsedTarget) {
          targetId = parsedTarget;
          targetUser = await message.client.users.fetch(parsedTarget).catch(() => message.author) || targetUser;
          sub = null;
        }
      }
    }

    const userId = (sub === 'add' || sub === 'remove') ? currentUserId : targetId;
    let user = await User.findOne({ userId });
    if (!user) {
      const reply = 'You don\'t have an account. Run `op start` or /start to register.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // ensure team is array
    user.team = user.team || [];

    // show team if using prefix without args or slash with no subcommand or explicit view
    if ((!interaction && !sub) || (interaction && (!sub || sub === 'view'))) {
      const cardDefs = user.team.map(id => require('../data/cards').cards.find(c => c.id === id)).filter(Boolean);
      const totalPower = cardDefs.reduce((sum, card) => {
        const entry = user.ownedCards.find(e => e.cardId === card.id);
        const stats = getCardFinalStats(card, entry?.level || 1, user);
        return sum + (stats.scaled.power || 0);
      }, 0);
      const username = targetUser.username || (message ? message.author.username : interaction.user.username);
      const imageBuffer = await generateTeamImage({
        username,
        totalPower,
        cards: cardDefs,
        backgroundUrl: user.teamBackgroundUrl
      });
      const attachment = new AttachmentBuilder(imageBuffer, { name: 'team.png' });
      let components = [];
      if (targetId === currentUserId) {
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`team_autoteam:${currentUserId}`)
              .setLabel('Auto team')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('<:autoteam:1489632891188019342>')
          );
        components = [row];
      }

      // Add IDs button for owner's view
      if (targetId === currentUserId) {
        // put IDs button on same row as Auto team
        components[0].addComponents(
          new ButtonBuilder()
            .setCustomId('team_ids')
            .setLabel('IDs')
            .setStyle(ButtonStyle.Secondary)
        );
      }
      if (message) {
        return message.channel.send({ content: `${username}'s team`, files: [attachment], components });
      }

      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply();
      }
      return interaction.editReply({ content: `${username}'s team`, files: [attachment], components });
    }

    if (!query && (sub === 'add' || sub === 'remove')) {
      const reply = 'Please specify a card name.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const card = await findBestOwnedCard(userId, query);
    if (!card) {
      const reply = `**"${query}"** Is not in your team.`;
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    if (card.boost || (card.type && String(card.type).toLowerCase() === 'boost')) {
      const reply = 'Boost cards cannot be added to your active team.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    if (card.artifact || card.ship) {
      const reply = card.artifact ? 'Artifacts cannot be added to your active team.' : 'Ships cannot be added to your active team.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const owned = user.ownedCards.some(e => e.cardId === card.id);
    if (!owned) {
      const reply = `You don't own that card.`;
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    let reply;
    if (sub === 'add') {
      if (user.team.includes(card.id)) {
        reply = 'That card is already on your team.';
      } else if (user.team.length >= 3) {
        reply = 'Your team is full!';
      } else {
        user.team.push(card.id);
          await user.save();
        reply = `Added **${card.character}** to your team.`;
      }
    } else if (sub === 'remove') {
      if (!user.team.includes(card.id)) {
        reply = 'That card is not on your team.';
      } else {
        user.team = user.team.filter(id => id !== card.id);
        await user.save();
        reply = `Removed **${card.character}** from your team.`;
      }
    } else {
      // show current team as embed
      const lines = user.team.map(id => {
        const def = require('../data/cards').cards.find(c => c.id === id);
        if (!def) return id;
        return `${def.emoji || '•'} ${def.character} (${def.rank})`;
      });
      const nameList = lines.length ? lines.join('\n') : 'None';
      const avatarUrl = message ? message.author.displayAvatarURL() : interaction.user.displayAvatarURL();
      const embed = new EmbedBuilder()
        .setColor('#FFFFFF')
        .setTitle(`${message ? message.author.username : interaction.user.username}'s Team`)
        .setDescription(nameList)
        .setThumbnail(avatarUrl);
      if (message) return message.channel.send({ embeds: [embed] });
      return interaction.reply({ embeds: [embed] });
    }

    if (message) return message.reply(reply);
    return interaction.reply({ content: reply });
  },

  async handleButton(interaction, rawAction, cardId) {
    if (rawAction === 'team_autoteam') {
      if (cardId && interaction.user.id !== cardId) {
        return interaction.reply({ content: 'This is not your team.', ephemeral: true });
      }
      const userId = interaction.user.id;
      let user = await User.findOne({ userId });
      if (!user) {
        return interaction.reply({ content: 'You don\'t have an account.', ephemeral: true });
      }

      try {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
      } catch (err) {}

      const { selectAutoTeam } = require('../utils/autoteam');
      const selectedIds = selectAutoTeam(user, 3);
      if (!selectedIds || selectedIds.length === 0) {
        try { await interaction.editReply({ content: 'You don\'t have any eligible cards to form a team.' }); } catch (e) {}
        return;
      }
      user.team = selectedIds;
      await user.save();

      // Generate fresh team image and update the message
      const { cards } = require('../data/cards');
      const teamCardDefs = user.team.map(id => cards.find(c => c.id === id)).filter(Boolean);
      const { getCardFinalStats } = require('../utils/cards');
      const totalPower = teamCardDefs.reduce((sum, card) => {
        const entry = user.ownedCards.find(e => e.cardId === card.id);
        const stats = getCardFinalStats(card, entry?.level || 1, user);
        return sum + ((stats && stats.scaled && stats.scaled.power) || 0);
      }, 0);
      const imageBuffer = await generateTeamImage({
        username: interaction.user.username,
        totalPower,
        cards: teamCardDefs,
        backgroundUrl: user.teamBackgroundUrl
      });
      const newAttachment = new AttachmentBuilder(imageBuffer, { name: 'team.png' });
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`team_autoteam:${interaction.user.id}`)
            .setLabel('Auto team')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('<:autoteam:1489632891188019342>'),
          new ButtonBuilder()
            .setCustomId('team_ids')
            .setLabel('IDs')
            .setStyle(ButtonStyle.Secondary)
        );
      try {
        await interaction.editReply({ content: `${interaction.user.username}'s team`, files: [newAttachment], components: [row] });
      } catch (err) {
        console.error('Autoteam image update failed', err);
      }
      return;
    }
    if (rawAction === 'team_ids') {
      const userId = interaction.user.id;
      let user = await User.findOne({ userId });
      if (!user) {
        return interaction.reply({ content: 'You don\'t have an account.', ephemeral: true });
      }

      const { cards } = require('../data/cards');
      const lines = (user.team || []).map(id => {
        const def = cards.find(c => c.id === id);
        const emoji = def ? (def.emoji || '') : '';
        return `${emoji} - ${id}`;
      });
      if (lines.length === 0) lines.push('None');
      lines.push('-# to view info about a card, run /info <card_id>');

      const embed = new EmbedBuilder()
        .setTitle("Card ID's")
        .setDescription(lines.join('\n'))
        .setColor('#B0B0B0');

      // Send as an ephemeral reply so only the clicking user sees it
      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.reply({ embeds: [embed], ephemeral: true });
        } else {
          await interaction.followUp({ embeds: [embed], ephemeral: true });
        }
      } catch (e) {
        // Fallback to channel send if ephemeral reply fails
        try { await interaction.channel.send({ embeds: [embed] }); } catch (e) {}
      }
      return;
    }
  }
};
