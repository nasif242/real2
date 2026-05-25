const { EmbedBuilder } = require('discord.js');
const User = require('../models/User');
const Crew = require('../models/Crew');
const { cards: cardDefs } = require('../data/cards');

function parseTargetIdFromArgs(message, args) {
  if (!message || !args || args.length === 0) return null;
  const first = args[0];
  const mentionMatch = first.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];
  if (/^\d{17,19}$/.test(first)) return first;
  return null;
}

module.exports = {
  name: 'user',
  description: 'View a user\'s profile',
  options: [{ name: 'target', type: 6, description: 'User to view (optional)', required: false }],
  async execute({ message, interaction, args }) {
    const defaultUserId = message ? message.author.id : interaction.user.id;
    let targetId = defaultUserId;
    let targetUser = message ? message.author : interaction.user;
    if (message) {
      const parsedId = parseTargetIdFromArgs(message, args);
      if (parsedId) {
        targetId = parsedId;
        targetUser = message.mentions.users.first() || await message.client.users.fetch(parsedId).catch(() => message.author) || message.author;
      }
    } else {
      targetId = interaction.options.getUser('target')?.id || defaultUserId;
      targetUser = interaction.options.getUser('target') || interaction.user;
    }
    const username = targetUser.username;
    const avatarUrl = targetUser.displayAvatarURL();

    let user = await User.findOne({ userId: targetId });
    if (!user) {
      const reply = `**${username}** doesn't have an account.`;
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // Calculate unique cards count
    const uniqueCardsCount = user.ownedCards ? user.ownedCards.length : 0;
    const totalCardsCount = cardDefs.filter(c => c.pullable).length;

    // Calculate ranks
    const allUsers = await User.find({});
    
    // Wealth rank (by balance)
    const wealthRank = allUsers
      .sort((a, b) => (b.balance || 0) - (a.balance || 0))
      .findIndex(u => u.userId === targetId) + 1;
    
    // Bounty rank (by bounty)
    const bountyRank = allUsers
      .sort((a, b) => (b.bounty || 100) - (a.bounty || 100))
      .findIndex(u => u.userId === targetId) + 1;
    
    // Dex rank (by unique cards)
    const dexRank = allUsers
      .sort((a, b) => (b.ownedCards?.length || 0) - (a.ownedCards?.length || 0))
      .findIndex(u => u.userId === targetId) + 1;

    const statsValue = `Total Pulls: **${user.totalPulls || 0}**\nUnique Cards: **${uniqueCardsCount}** / ${totalCardsCount}`;

    const crew = await Crew.findOne({ members: targetId });
    let crewValue = 'None';
    if (crew) {
      let roleEmoji = '👤';
      if (crew.captainId === targetId) {
        roleEmoji = '<:captain:1508200434274406470>';
      } else {
        const memberDocs = await User.find(
          { userId: { $in: crew.members.filter(id => id !== crew.captainId) } },
          'userId bounty'
        );
        if (memberDocs.length > 0) {
          const vc = memberDocs.reduce((best, u) => ((u.bounty ?? 100) > (best.bounty ?? 100) ? u : best));
          if (vc.userId === targetId) roleEmoji = '<:vc:1508270658763751434>';
        }
      }
      crewValue = `**${crew.name}** ${roleEmoji}`;
    }

    const title = `${username}'s Profile`;
    const embed = new EmbedBuilder()
      .setColor('#FFFFFF')
      .setTitle(title)
      .setThumbnail(avatarUrl)
      .addFields(
        { name: 'Bounty', value: `<:bounty:1490738541448400976>${user.bounty || 100}`, inline: true },
        { name: 'Crew', value: crewValue, inline: true },
        { name: '**Rankings**', value: `Wealth: #${wealthRank}\nBounty: #${bountyRank}\nDex: #${dexRank}`, inline: false },
        { name: '**Statistics**', value: statsValue, inline: false }
      );

    if (message) return message.channel.send({ embeds: [embed] });
    return interaction.reply({ embeds: [embed] });
  }
};

module.exports.buildUserProfileEmbed = async function (targetId, discordUser) {
  const user = await User.findOne({ userId: targetId });
  if (!user) return null;

  const username = discordUser.username;
  const avatarUrl = discordUser.displayAvatarURL();

  const uniqueCardsCount = user.ownedCards ? user.ownedCards.length : 0;
  const totalCardsCount = cardDefs.filter(c => c.pullable).length;

  const allUsers = await User.find({});
  const wealthRank = allUsers
    .sort((a, b) => (b.balance || 0) - (a.balance || 0))
    .findIndex(u => u.userId === targetId) + 1;
  const bountyRank = allUsers
    .sort((a, b) => (b.bounty || 100) - (a.bounty || 100))
    .findIndex(u => u.userId === targetId) + 1;
  const dexRank = allUsers
    .sort((a, b) => (b.ownedCards?.length || 0) - (a.ownedCards?.length || 0))
    .findIndex(u => u.userId === targetId) + 1;

  const title = `${username}'s Profile`;

  const embed = new EmbedBuilder()
    .setColor('#FFFFFF')
    .setTitle(title)
    .setThumbnail(avatarUrl)
    .addFields(
      { name: 'Bounty', value: `¥${user.bounty || 100}`, inline: true },
      { name: '**Rankings**', value: `Wealth: #${wealthRank}\nBounty: #${bountyRank}\nDex: #${dexRank}`, inline: false },
      { name: '**Statistics**', value: `Total Pulls: **${user.totalPulls || 0}**\nUnique Cards: **${uniqueCardsCount}** / ${totalCardsCount}`, inline: false }
    );

  return embed;
};
