const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const User = require('../models/User');
const Crew = require('../models/Crew');
const { cards: allCards } = require('../data/cards');

const CREW_CAP = 25;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function genCrewId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function isValidHex(str) {
  return /^#[0-9A-Fa-f]{6}$/.test(str);
}

function isValidUrl(str) {
  return /^https?:\/\/.+/.test(str);
}

function isValidImageUrl(str) {
  if (!isValidUrl(str)) return false;
  try {
    const url = new URL(str);
    const pathname = url.pathname.toLowerCase();
    return /\.(png|jpg|jpeg|gif|webp)(\?|$)/.test(pathname) || isValidUrl(str);
  } catch {
    return false;
  }
}

async function getCrewForUser(userId) {
  return Crew.findOne({ members: userId });
}

async function computeCrewStats(crew) {
  const memberUsers = await User.find(
    { userId: { $in: crew.members } },
    'userId bounty team'
  );
  let totalBounty = 0;
  let totalPower = 0;
  for (const u of memberUsers) {
    totalBounty += (u.bounty ?? 100);
    for (const cid of (u.team || [])) {
      const def = allCards.find(c => c.id === cid);
      if (def && def.power) totalPower += def.power;
    }
  }
  return { totalBounty, totalPower };
}

async function fetchUsernames(userIds, client) {
  const map = {};
  await Promise.all(userIds.map(async id => {
    try {
      const u = await client.users.fetch(id);
      map[id] = u.username;
    } catch {
      map[id] = `Unknown`;
    }
  }));
  return map;
}

async function buildCrewEmbed(crew, client) {
  const { totalBounty, totalPower } = await computeCrewStats(crew);
  const names = await fetchUsernames(crew.members, client);
  const captainName = names[crew.captainId] || crew.captainId;
  const crewMembers = crew.members.filter(id => id !== crew.captainId);

  let desc = `**<:captain:1508200434274406470> Captain**\n┗ ${captainName}`;
  if (crewMembers.length > 0) {
    const memberLines = crewMembers.map(id => `┣ ${names[id] || id}`);
    desc += `\n\n**Members**\n${memberLines.join('\n')}`;
  }

  let captainAvatar = null;
  try {
    const captainUser = await client.users.fetch(crew.captainId);
    captainAvatar = captainUser.displayAvatarURL({ extension: 'png', size: 256 });
  } catch {}

  const embed = new EmbedBuilder()
    .setTitle(`${crew.name}`)
    .setColor(crew.color || '#2b2d31')
    .setDescription(desc)
    .addFields(
      { name: '<:3_:1503002985578365118> Members', value: `${crew.members.length} / ${CREW_CAP}`, inline: true },
      { name: '<:beri:1490738445319016651> Total Bounty', value: totalBounty.toLocaleString(), inline: true },
      { name: '<:sword:1490732251107819530> Total Power', value: totalPower.toLocaleString(), inline: true }
    );

  if (captainAvatar) embed.setThumbnail(captainAvatar);
  if (crew.jollyRoger) embed.setImage(crew.jollyRoger);
  return embed;
}

function buildCreatePrompt() {
  const embed = new EmbedBuilder()
    .setColor('#2b2d31')
    .setTitle('No Crew')
    .setDescription("You're not in a crew yet.\nCreate one to rally your nakama and compete on the crew leaderboard!");
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('crew_create_btn')
      .setLabel('Create Crew')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🏴‍☠️')
  );
  return { embed, row };
}

// ─── Execute ─────────────────────────────────────────────────────────────────

module.exports = {
  name: 'crew',
  description: 'Manage your pirate crew',

  async execute({ message, interaction, args }) {
    const userId = message ? message.author.id : interaction.user.id;
    const client = message ? message.client : interaction.client;

    let sub, targetUser;
    if (interaction) {
      sub = interaction.options.getSubcommand(false) || 'view';
      targetUser = interaction.options.getUser?.('user') || null;
    } else {
      const firstArg = (args?.[0] || '').toLowerCase();
      sub = firstArg || 'view';
      if (sub === 'colour') sub = 'color';
      if (sub === 'add') sub = 'invite';
      if (sub === 'remove') sub = 'kick';
      targetUser = message.mentions.users.first() || null;
    }

    // ── VIEW ─────────────────────────────────────────────────────────────────
    if (sub === 'view') {
      const lookupId = targetUser ? targetUser.id : userId;
      const crew = await getCrewForUser(lookupId);

      if (!crew) {
        if (targetUser) {
          const content = `**${targetUser.username}** is not in a crew.`;
          if (message) return message.reply(content);
          return interaction.reply({ content, ephemeral: true });
        }
        if (interaction) {
          const { embed, row } = buildCreatePrompt();
          return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }
        return message.reply(
          "You're not in a crew yet. Use `/crew view` to create one, or `op crew create <name>` to get started."
        );
      }

      const embed = await buildCrewEmbed(crew, client);
      if (message) return message.reply({ embeds: [embed] });
      return interaction.reply({ embeds: [embed] });
    }

    // ── CREATE (prefix only — slash uses modal) ───────────────────────────────
    if (sub === 'create') {
      if (!message) return;
      const existing = await getCrewForUser(userId);
      if (existing) return message.reply(`You're already in **${existing.name}**. Leave or disband it first.`);

      const name = (args?.slice(1) || []).join(' ').trim().slice(0, 32);
      if (!name) return message.reply('Please provide a crew name: `op crew create <name>`');

      const crew = await Crew.create({
        crewId: genCrewId(),
        name,
        captainId: userId,
        members: [userId],
        color: '#2b2d31',
        jollyRoger: null
      });

      const embed = await buildCrewEmbed(crew, client);
      return message.reply({ content: 'Crew created!', embeds: [embed] });
    }

    // ── COLOR ─────────────────────────────────────────────────────────────────
    if (sub === 'color') {
      const hex = interaction ? interaction.options.getString('hex') : (args?.[1] || '');
      if (!hex || !isValidHex(hex)) {
        const content = 'Please provide a valid hex colour, e.g. `#FF0000`.';
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      const crew = await getCrewForUser(userId);
      if (!crew) {
        const content = "You're not in a crew.";
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      if (crew.captainId !== userId) {
        const content = 'Only the captain can change the crew colour.';
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      crew.color = hex;
      await crew.save();
      const embed = await buildCrewEmbed(crew, client);
      if (message) return message.reply({ content: `Crew colour updated to **\`${hex}\`**.`, embeds: [embed] });
      return interaction.reply({ content: `✅ Crew colour updated to **\`${hex}\`**.`, embeds: [embed] });
    }

    // ── JOLLY ROGER ───────────────────────────────────────────────────────────
    if (sub === 'jolly') {
      const url = interaction ? interaction.options.getString('url') : (args?.[1] || '');
      if (!url || !isValidUrl(url)) {
        const content = 'Please provide a valid image or GIF URL starting with `https://`.';
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      const crew = await getCrewForUser(userId);
      if (!crew) {
        const content = "You're not in a crew.";
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      if (crew.captainId !== userId) {
        const content = 'Only the captain can change the jolly roger.';
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      crew.jollyRoger = url;
      await crew.save();
      const embed = await buildCrewEmbed(crew, client);
      if (message) return message.reply({ content: 'Jolly roger updated.', embeds: [embed] });
      return interaction.reply({ content: 'Jolly roger updated.', embeds: [embed] });
    }

    // ── INVITE ────────────────────────────────────────────────────────────────
    if (sub === 'invite') {
      if (!targetUser) {
        const content = 'Please mention a user to invite.';
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      const crew = await getCrewForUser(userId);
      if (!crew) {
        const content = "You're not in a crew. Create one first.";
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      if (crew.captainId !== userId) {
        const content = 'Only the captain can invite members.';
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      if (crew.members.length >= CREW_CAP) {
        const content = `Your crew is full (${CREW_CAP} members max).`;
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      if (crew.members.includes(targetUser.id)) {
        const content = `**${targetUser.username}** is already in your crew.`;
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      const targetCrew = await getCrewForUser(targetUser.id);
      if (targetCrew) {
        const content = `**${targetUser.username}** is already in another crew.`;
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      const targetAccount = await User.findOne({ userId: targetUser.id });
      if (!targetAccount) {
        const content = `**${targetUser.username}** doesn't have a bot account yet.`;
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      const captainName = message ? message.author.username : interaction.user.username;
      const inviteContent = `<@${targetUser.id}>, **${captainName}** is inviting you to join **${crew.name}**. Do you want to join?`;
      const inviteRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`crew_invite_yes:${crew.crewId}:${targetUser.id}`)
          .setLabel('Yes')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`crew_invite_no:${crew.crewId}:${targetUser.id}`)
          .setLabel('No')
          .setStyle(ButtonStyle.Secondary)
      );
      const channel = message ? message.channel : interaction.channel;
      if (message) {
        await message.delete().catch(() => {});
        return channel.send({ content: inviteContent, components: [inviteRow] });
      }
      return interaction.reply({ content: inviteContent, components: [inviteRow] });
    }

    // ── KICK ──────────────────────────────────────────────────────────────────
    if (sub === 'kick') {
      if (!targetUser) {
        const content = 'Please mention a user to kick.';
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      const crew = await getCrewForUser(userId);
      if (!crew) {
        const content = "You're not in a crew.";
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      if (crew.captainId !== userId) {
        const content = 'Only the captain can kick members.';
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      if (targetUser.id === userId) {
        const content = "You can't kick yourself. Use `disband` to dissolve the crew.";
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      if (!crew.members.includes(targetUser.id)) {
        const content = `**${targetUser.username}** is not in your crew.`;
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      const removedName = targetUser.username;
      const crewName = crew.name;
      crew.members = crew.members.filter(id => id !== targetUser.id);
      await crew.save();

      try {
        await targetUser.send(`You have been removed from **${crewName}**.`);
      } catch {}

      const content = `**${removedName}** has been removed from **${crewName}**.`;
      if (message) return message.reply(content);
      return interaction.reply({ content });
    }

    // ── LEAVE ─────────────────────────────────────────────────────────────────
    if (sub === 'leave') {
      const crew = await getCrewForUser(userId);
      if (!crew) {
        const content = "You're not in a crew.";
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      if (crew.captainId === userId) {
        const content = "You're the captain — use `disband` to dissolve the crew.";
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      crew.members = crew.members.filter(id => id !== userId);
      await crew.save();
      const content = `You've left **${crew.name}**.`;
      if (message) return message.reply(content);
      return interaction.reply({ content, ephemeral: true });
    }

    // ── DISBAND ───────────────────────────────────────────────────────────────
    if (sub === 'disband') {
      const crew = await getCrewForUser(userId);
      if (!crew) {
        const content = "You're not in a crew.";
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      if (crew.captainId !== userId) {
        const content = 'Only the captain can disband the crew.';
        if (message) return message.reply(content);
        return interaction.reply({ content, ephemeral: true });
      }
      if (interaction) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`crew_disband_confirm:${crew.crewId}`)
            .setLabel('Yes, Disband')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('crew_disband_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
        );
        return interaction.reply({
          content: `Are you sure you want to disband **${crew.name}**? This cannot be undone.`,
          components: [row],
          ephemeral: true
        });
      }
      // Prefix: require explicit confirm keyword
      const confirmed = (args?.[1] || '').toLowerCase() === 'confirm';
      if (!confirmed) {
        return message.reply(
          `Are you sure you want to disband **${crew.name}**? This cannot be undone.\nType \`op crew disband confirm\` to proceed.`
        );
      }
      await Crew.deleteOne({ crewId: crew.crewId });
      return message.reply(`**${crew.name}** has been disbanded.`);
    }

  },

  // ─── Button Handler ────────────────────────────────────────────────────────
  async handleButton(interaction, customId) {
    const [action, crewId] = customId.split(':');

    if (action === 'crew_create_btn') {
      const modal = new ModalBuilder()
        .setCustomId('crew_create_modal')
        .setTitle('Create Your Crew');

      const nameInput = new TextInputBuilder()
        .setCustomId('crew_name')
        .setLabel('Crew Name')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(32)
        .setPlaceholder('e.g. Straw Hat Pirates');

      const colorInput = new TextInputBuilder()
        .setCustomId('crew_color')
        .setLabel('Crew Colour (hex, optional)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(7)
        .setPlaceholder('#FF0000');

      const jollyInput = new TextInputBuilder()
        .setCustomId('crew_jolly')
        .setLabel('Jolly Roger URL (optional)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder('https://...');

      modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(colorInput),
        new ActionRowBuilder().addComponents(jollyInput)
      );

      return interaction.showModal(modal);
    }

    if (action === 'crew_disband_confirm') {
      const crew = await Crew.findOne({ crewId });
      if (!crew || crew.captainId !== interaction.user.id) {
        return interaction.update({ content: 'Unable to disband crew.', components: [] });
      }
      const name = crew.name;
      await Crew.deleteOne({ crewId });
      return interaction.update({ content: `**${name}** has been disbanded.`, components: [] });
    }

    if (action === 'crew_disband_cancel') {
      return interaction.update({ content: 'Disband cancelled.', components: [] });
    }

    if (action === 'crew_invite_yes') {
      const [, crewId, invitedUserId] = customId.split(':');
      if (interaction.user.id !== invitedUserId) {
        return interaction.reply({ content: 'This invite is not for you.', ephemeral: true });
      }
      const crew = await Crew.findOne({ crewId });
      if (!crew) {
        return interaction.update({ content: 'This crew no longer exists.', components: [] });
      }
      if (crew.members.includes(invitedUserId)) {
        return interaction.update({ content: "You're already in this crew.", components: [] });
      }
      const alreadyInCrew = await getCrewForUser(invitedUserId);
      if (alreadyInCrew) {
        return interaction.update({ content: "You're already in another crew.", components: [] });
      }
      if (crew.members.length >= CREW_CAP) {
        return interaction.update({ content: `**${crew.name}** is full (${CREW_CAP} members max).`, components: [] });
      }
      crew.members.push(invitedUserId);
      await crew.save();
      return interaction.update({ content: `You've joined **${crew.name}**!`, components: [] });
    }

    if (action === 'crew_invite_no') {
      const [, crewId, invitedUserId] = customId.split(':');
      if (interaction.user.id !== invitedUserId) {
        return interaction.reply({ content: 'This invite is not for you.', ephemeral: true });
      }
      return interaction.update({ content: 'Invite declined.', components: [] });
    }
  },

  // ─── Modal Handler ─────────────────────────────────────────────────────────
  async handleModal(interaction) {
    const userId = interaction.user.id;
    const client = interaction.client;

    const existing = await getCrewForUser(userId);
    if (existing) {
      return interaction.reply({ content: `You're already in **${existing.name}**.`, ephemeral: true });
    }

    const name = interaction.fields.getTextInputValue('crew_name').trim();
    const rawColor = interaction.fields.getTextInputValue('crew_color').trim();
    const rawJolly = interaction.fields.getTextInputValue('crew_jolly').trim();

    if (!name) {
      return interaction.reply({ content: 'Crew name cannot be empty.', ephemeral: true });
    }

    const color = (rawColor && isValidHex(rawColor)) ? rawColor : '#2b2d31';
    const jollyRoger = (rawJolly && isValidUrl(rawJolly)) ? rawJolly : null;

    const crew = await Crew.create({
      crewId: genCrewId(),
      name,
      captainId: userId,
      members: [userId],
      color,
      jollyRoger
    });

    const embed = await buildCrewEmbed(crew, client);
    return interaction.reply({ content: 'Crew created!', embeds: [embed] });
  }
};
