const User = require('../models/User');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const duelCmd = require('./duel');
const { OWNER_ID } = require('../config');
const { getNextPullResetDate } = require('../src/stock');

function formatRelativeTime(futureDate) {
  const now = new Date();
  const diff = futureDate - now;
  if (diff <= 0) return 'now';
  
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  const hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
  
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatAmount(value) {
  const absValue = Math.abs(value);
  const str = absValue.toString();
  if (str.length < 5) return value.toString();
  const formatted = str.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return value < 0 ? `-${formatted}` : formatted;
}

module.exports = {
  name: 'bounty',
  description: 'Claim a bounty on a random player',
  async execute({ message, interaction }) {
    const userId = message ? message.author.id : interaction.user.id;
    const discordUser = message ? message.author : interaction.user;
    const username = message ? message.author.username : interaction.user.username;
    const avatarUrl = message ? message.author.displayAvatarURL() : interaction.user.displayAvatarURL();

    // Owner is immune to cooldowns
    if (userId === OWNER_ID) {
      let requester = await User.findOne({ userId });
      if (!requester) {
        const reply = 'You don\'t have an account. Run `op start` or /start to register.';
        if (message) return message.channel.send(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }
      requester.activeBountyTarget = null;
      requester.bountyCooldownUntil = null;
      await requester.save();
    }

    let requester = await User.findOne({ userId });
    if (!requester) {
      const reply = 'You don\'t have an account. Run `op start` or /start to register.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // Prefer showing an active bounty if present. Use `activeBountyTarget` first; if missing,
    // fall back to `lastBountyTarget` while its expiry (bountyCooldownUntil) is still in the future.
    let activeTargetId = requester.activeBountyTarget || null;
    if (!activeTargetId && requester.lastBountyTarget && requester.bountyCooldownUntil && new Date(requester.bountyCooldownUntil) > new Date()) {
      activeTargetId = requester.lastBountyTarget;
    }

    if (activeTargetId) {
      const targetId = String(activeTargetId).trim();
      // If expiry passed, clear active target so user can claim a new one
      if (requester.bountyCooldownUntil && new Date(requester.bountyCooldownUntil) <= new Date()) {
        requester.activeBountyTarget = null;
        requester.bountyCooldownUntil = null;
        await requester.save();
      } else if (!targetId || targetId === userId) {
        requester.activeBountyTarget = null;
        requester.bountyCooldownUntil = null;
        await requester.save();
      } else {
        // Fetch stored opponent data if available to show bounty
        const opponentDoc = await User.findOne({ userId: targetId }).catch(() => null);
        const targetBounty = (opponentDoc && opponentDoc.bounty) ? opponentDoc.bounty : 100;
        const baseBeli = Math.ceil(targetBounty / 100000) || 1;
        const rewardBeli = baseBeli * 2; // 2x as advertised

        const expiresAt = requester.bountyCooldownUntil ? new Date(requester.bountyCooldownUntil) : new Date(Date.now() + 24 * 60 * 60 * 1000);
        const targetDiscord = await (message ? message.client.users.fetch(targetId) : interaction.client.users.fetch(targetId)).catch(() => null);
        const targetName = targetDiscord ? targetDiscord.username : 'Unknown';

        const embed = new EmbedBuilder()
          .setColor('#FFFFFF')
          .setTitle('Active Bounty')
          .setDescription(`Your current bounty target is **${targetName}**.`)
          .addFields(
            { name: 'Rewards', value: `• Bounty: <:bounty:1490738541448400976>${formatAmount(targetBounty)}\n• Beli: <:beri:1490738445319016651>${formatAmount(rewardBeli)}`, inline: false }
          )
          .setImage('https://i.pinimg.com/1200x/65/7c/06/657c066ce2b36625b6d56398128150fb.jpg')
          .setFooter({ text: 'Expires' })
          .setTimestamp(expiresAt)
          .setAuthor({ name: username, iconURL: avatarUrl });

        const infoButton = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('bounty:info')
            .setLabel('View Target Info')
            .setStyle(ButtonStyle.Primary)
        );

        if (message) {
          return message.channel.send({ embeds: [embed], components: [infoButton] });
        }
        return interaction.reply({ embeds: [embed], components: [infoButton], ephemeral: true });
      }
    }
    // If there's a cooldown remaining (but no active target), block new claims until cooldown ends
    if (requester.bountyCooldownUntil && requester.bountyCooldownUntil > new Date()) {
      const timeLeft = formatRelativeTime(new Date(requester.bountyCooldownUntil));
      const reply = `You can not claim a new bounty until your cooldown of ${timeLeft} resets.`;
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const requesterBounty = requester.bounty || 100;

    // Find opponents with bounty between 0.5x and 2x, inclusive
    const minBounty = Math.ceil(requesterBounty / 2);
    const maxBounty = Math.floor(requesterBounty * 2);

    // Exclude self and the last assigned bounty target to avoid giving the same target twice in a row
    const excludeIds = [userId];
    if (requester.lastBountyTarget) excludeIds.push(requester.lastBountyTarget);
    const candidates = await User.find({
      userId: { $nin: excludeIds },
      bounty: { $gte: minBounty, $lte: maxBounty }
    });

    if (candidates.length === 0) {
      const reply = `No suitable bounty targets found. Targets must have bounty between **${formatAmount(minBounty)}** and **${formatAmount(maxBounty)}**.`;
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // Pick a random opponent
    const opponent = candidates[Math.floor(Math.random() * candidates.length)];

    // Fetch the opponent's Discord profile for proper username/avatar display
    const opponentDiscord = await (message ? message.client.users.fetch(opponent.userId) : interaction.client.users.fetch(opponent.userId)).catch(() => null);
    const opponentName = opponentDiscord ? opponentDiscord.username : 'Unknown';
    const opponentAvatar = opponentDiscord ? opponentDiscord.displayAvatarURL() : avatarUrl;

    // Set active bounty and 24-hour expiry
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    requester.activeBountyTarget = opponent.userId;
    requester.lastBountyTarget = opponent.userId;
    requester.bountyCooldownUntil = expiresAt;
    await requester.save();

    // Reward preview (based on relative bounty)
    const targetBounty = opponent.bounty || 100;
    const rewardXP = 0;
    const baseBeli = Math.ceil(targetBounty / 100000) || 1;
    const rewardBeli = baseBeli * 2; // 2x shown in the embed

    // Create bounty embed (matches provided screenshot style)
    const embed = new EmbedBuilder()
      .setColor('#FFFFFF')
      .setTitle('Bounty Challenge')
      .setDescription(`Defeat **${opponentName}** in a duel to claim 2x the reward!`)
      .addFields(
        { name: 'Rewards', value: `• Bounty: <:bounty:1490738541448400976>${formatAmount(targetBounty)}\n• Beli: <:beri:1490738445319016651>${formatAmount(rewardBeli)}`, inline: false }
      )
      .setImage('https://i.pinimg.com/1200x/65/7c/06/657c066ce2b36625b6d56398128150fb.jpg')
      .setFooter({ text: 'Expires' })
      .setTimestamp(expiresAt)
      .setAuthor({ name: username, iconURL: avatarUrl });

    const requesterId = message ? message.author.id : interaction.user.id;
    const infoButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bounty:info:${requesterId}`)
        .setLabel('View Target Info')
        .setStyle(ButtonStyle.Primary)
    );

    let msg;
    if (message) {
      msg = await message.reply({ embeds: [embed], components: [infoButton] });
    } else {
      msg = await interaction.reply({ embeds: [embed], components: [infoButton], fetchReply: true });
    }

    // Disable buttons after expiry (schedules UI update for this process run)
    const msUntilExpiry = Math.max(0, expiresAt - Date.now());
    setTimeout(() => {
      embed.setFooter({ text: 'Expired' });
      msg.edit({ embeds: [embed], components: [] }).catch(() => {});
    }, msUntilExpiry);
  },

  async handleButton(interaction, rawAction) {
    const [action, ownerId] = rawAction.split(':');
    if (ownerId && interaction.user.id !== ownerId) {
      return interaction.reply({ content: 'This bounty info is not for you.', ephemeral: true });
    }
    if (action === 'info') {
      const userId = interaction.user.id;
      const requester = await User.findOne({ userId });
      if (!requester || !requester.activeBountyTarget) {
        return interaction.reply({ content: 'No active bounty found.', ephemeral: true });
      }

      const targetDiscord = await interaction.client.users.fetch(requester.activeBountyTarget).catch(() => null);
      if (!targetDiscord) {
        return interaction.reply({ content: 'Could not fetch target user.', ephemeral: true });
      }

      const { buildUserProfileEmbed } = require('./user');
      const profileEmbed = await buildUserProfileEmbed(requester.activeBountyTarget, targetDiscord);
      if (!profileEmbed) {
        return interaction.reply({ content: 'Target does not have an account.', ephemeral: true });
      }

      await interaction.deferUpdate();
      await interaction.followUp({ embeds: [profileEmbed] });
    }
  }
};
