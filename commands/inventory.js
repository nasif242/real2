const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const User = require('../models/User');
const { levelers } = require('../data/levelers');
const { rods } = require('../data/rods');
const crews = require('../data/crews');
const { sanitizeUserRods } = require('../utils/inventoryHelper');
const { chests, CHEST_EMOJIS } = require('../data/chests');

const ITEM_DISPLAY_NAMES = {
  c_chest: 'C Chest',
  b_chest: 'B Chest',
  a_chest: 'A Chest'
};
const ITEM_DISPLAY_EMOJIS = {
  c_chest: CHEST_EMOJIS.c_chest,
  b_chest: CHEST_EMOJIS.b_chest,
  a_chest: CHEST_EMOJIS.a_chest
};

ITEM_DISPLAY_NAMES.cola = 'Cola';
ITEM_DISPLAY_EMOJIS.cola = '<:cola:1494106165955792967>';
ITEM_DISPLAY_NAMES.red_shard = 'Red Shard';
ITEM_DISPLAY_EMOJIS.red_shard = '<:RedShard:1494106374492131439>';
ITEM_DISPLAY_NAMES.blue_shard = 'Blue Shard';
ITEM_DISPLAY_EMOJIS.blue_shard = '<:Blueshard:1494106500149411980>';
ITEM_DISPLAY_NAMES.green_shard = 'Green Shard';
ITEM_DISPLAY_EMOJIS.green_shard = '<:GreenShard:1494106686963581039>';
ITEM_DISPLAY_NAMES.yellow_shard = 'Yellow Shard';
ITEM_DISPLAY_EMOJIS.yellow_shard = '<:YellowShard:1494106825627406530>';
ITEM_DISPLAY_NAMES.purple_shard = 'Purple Shard';
ITEM_DISPLAY_EMOJIS.purple_shard = '<:PurpleShard:1494106958582776008>';
ITEM_DISPLAY_NAMES.god_token = 'God Token';
ITEM_DISPLAY_EMOJIS.god_token = '<:godtoken:1499957056650608753>';

const ITEMS_PER_PAGE = 20;

function parseTargetIdFromArgs(args) {
  if (!args || args.length === 0) return null;
  const first = args[0];
  const mentionMatch = first.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];
  if (/^\d{17,19}$/.test(first)) return first;
  return null;
}

function buildItemLines(user) {
  const lines = [];
  const currentRod = rods.find(r => r.id === user.currentRod);
  const rodItem = user.items?.find(it => it.itemId === user.currentRod);
  if (currentRod && rodItem && (rodItem.durability === undefined || rodItem.durability > 0)) {
    let rodDisplay = `${currentRod.emoji} ${currentRod.name}`;
    if (rodItem.durability !== undefined) rodDisplay += ` (${rodItem.durability}/${currentRod.durability})`;
    lines.push(rodDisplay);
  }
  (user.items || [])
    .filter(it => it.itemId !== user.currentRod && (it.durability === undefined || it.durability > 0))
    .forEach(i => {
      if (levelers.some(l => l.id === i.itemId)) return;
      const displayName = ITEM_DISPLAY_NAMES[i.itemId] || i.itemId;
      const emoji = ITEM_DISPLAY_EMOJIS[i.itemId] || '';
      let display = emoji ? `${emoji} ${displayName} x${i.quantity}` : `${displayName} x${i.quantity}`;
      if (i.durability !== undefined) display += ` (${i.durability})`;
      lines.push(display);
    });
  return lines;
}

function buildLevelerLines(user) {
  return (user.items || [])
    .filter(i => levelers.some(l => l.id === i.itemId) && (i.durability === undefined || i.durability > 0))
    .map(i => {
      const leveler = levelers.find(l => l.id === i.itemId);
      let display = `${leveler.emoji} ${leveler.name} x${i.quantity}`;
      if (i.durability !== undefined) display += ` (${i.durability})`;
      return display;
    });
}

function buildPackLines(user) {
  const packObj = user.packInventory || {};
  if (!Object.keys(packObj).length) return [];
  return Object.entries(packObj).map(([name, qty]) => {
    const crew = crews.find(c => c.name === name);
    const emoji = crew && crew.icon ? `${crew.icon} ` : '';
    return `${emoji}${name} x${qty}`;
  });
}

function paginateLines(lines) {
  const pages = [];
  for (let i = 0; i < lines.length; i += ITEMS_PER_PAGE) {
    pages.push(lines.slice(i, i + ITEMS_PER_PAGE));
  }
  if (pages.length === 0) pages.push([]);
  return pages;
}

function buildInventoryEmbed(user, username, avatarUrl, pageIndex = 0, category = 'items') {
  let lines = [];
  let sectionName = '';
  if (category === 'levelers') {
    lines = buildLevelerLines(user);
    sectionName = 'Levelers';
  } else if (category === 'packs') {
    lines = buildPackLines(user);
    sectionName = 'Packs';
  } else {
    lines = buildItemLines(user);
    sectionName = 'Items';
  }

  const pages = paginateLines(lines);
  const totalPages = pages.length;
  const clampedPage = Math.min(pageIndex, totalPages - 1);
  const pageLines = pages[clampedPage] || [];

  const embed = new EmbedBuilder()
    .setColor('#FFFFFF')
    .setTitle(`${username}'s Inventory — ${sectionName}`)
    .setThumbnail(avatarUrl);

  if (pageLines.length === 0) {
    embed.setDescription(`No ${sectionName.toLowerCase()}.`);
  } else {
    embed.setDescription(pageLines.join('\n'));
  }

  embed.setFooter({ text: `Page ${clampedPage + 1}/${totalPages} · ${category}` });

  return { embed, totalPages, currentPage: clampedPage };
}

function buildNavRow(viewerId, targetId, currentPage, totalPages, category) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`inv_prev_${viewerId}_${targetId}_${category}`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId(`inv_next_${viewerId}_${targetId}_${category}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages - 1)
  );
}

function buildCategoryDropdown(viewerId, targetId, category) {
  // Separate the raw numeric IDs for custom emojis so Discord's API can parse them natively
  const cats = [
    { 
      value: 'items', 
      label: 'Items', 
      description: 'View your regular items', 
      emoji: '1494106958582776008' 
    },
    { 
      value: 'levelers', 
      label: 'Levelers', 
      description: 'View your leveler items', 
      emoji: '1490356754691784754' 
    },
    { 
      value: 'packs', 
      label: 'Packs', 
      description: 'View your card packs', 
      emoji: '1480010003896340482' 
    }
  ];

  // Find the currently selected category object for the placeholder text fallback
  const currentCat = cats.find(c => c.value === category);
  const placeholderText = currentCat ? `Viewing: ${currentCat.label}` : 'Viewing: Items';

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`inv_category:${viewerId}:${targetId}`)
      .setPlaceholder(placeholderText)
      .addOptions(
        cats.map(c => ({
          label: c.label,
          description: c.description,
          value: c.value,
          emoji: { id: c.emoji }, // Pass the snowflake ID directly inside the emoji object
          default: c.value === category
        }))
      )
  );
}

module.exports = {
  name: 'inventory',
  description: 'Show your items and packs',
  async execute({ message, interaction, args }) {
    const userId = message ? message.author.id : interaction.user.id;
    const discordUser = message ? message.author : interaction.user;
    const targetId = message ? parseTargetIdFromArgs(args) || userId : interaction.options.getUser('target')?.id || userId;
    let targetUser = discordUser;
    let username = discordUser.username;
    let avatarUrl = discordUser.displayAvatarURL();
    if (message && targetId !== userId) {
      targetUser = await message.client.users.fetch(targetId).catch(() => null) || targetUser;
      username = targetUser.username || username;
      avatarUrl = targetUser.displayAvatarURL ? targetUser.displayAvatarURL() : avatarUrl;
    } else if (!message && targetId !== userId) {
      const targetOption = interaction.options.getUser('target');
      if (targetOption) {
        targetUser = targetOption;
        username = targetUser.username;
        avatarUrl = targetUser.displayAvatarURL();
      }
    }

    let user = await User.findOne({ userId: targetId });
    if (!user) {
      const reply = 'You don\'t have an account. Run `op start` or /start to register.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }
    if (sanitizeUserRods(user)) await user.save();

    const viewerId = message ? message.author.id : interaction.user.id;
    const { embed, totalPages, currentPage } = buildInventoryEmbed(user, username, avatarUrl, 0, 'items');
    const navRow = buildNavRow(viewerId, targetId, currentPage, totalPages, 'items');
    const dropdownRow = buildCategoryDropdown(viewerId, targetId, 'items');

    if (message) return message.channel.send({ embeds: [embed], components: [dropdownRow, navRow] });
    return interaction.reply({ embeds: [embed], components: [dropdownRow, navRow] });
  },

  async handleSelect(interaction) {
    // customId: inv_category:{viewerId}:{targetId}
    const parts = interaction.customId.split(':');
    const viewerId = parts[1];
    const targetId = parts[2] || viewerId;
    const newCategory = interaction.values[0] || 'items';

    if (interaction.user.id !== viewerId) {
      return interaction.reply({ content: 'This is not your inventory.', ephemeral: true });
    }

    const user = await User.findOne({ userId: targetId });
    if (!user) return interaction.reply({ content: 'User not found.', ephemeral: true });

    const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
    const username = targetUser ? targetUser.username : targetId;
    const avatarUrl = targetUser ? targetUser.displayAvatarURL() : interaction.user.displayAvatarURL();

    const { embed, totalPages, currentPage } = buildInventoryEmbed(user, username, avatarUrl, 0, newCategory);
    const navRow = buildNavRow(viewerId, targetId, currentPage, totalPages, newCategory);
    const dropdownRow = buildCategoryDropdown(viewerId, targetId, newCategory);

    return interaction.update({ embeds: [embed], components: [dropdownRow, navRow] });
  },

  async handleButton(interaction, customId) {
    const parts = customId.split('_');
    // customId formats:
    //   inv_prev_{viewerId}_{targetId}_{category}
    //   inv_next_{viewerId}_{targetId}_{category}
    //   inv_cat_{viewerId}_{targetId}_{category}
    const prefix = parts[0];   // 'inv'
    const action = parts[1];   // 'prev' | 'next' | 'cat'
    const viewerId = parts[2];
    const targetId = parts[3] || viewerId;
    const category = parts[4] || 'items';

    if (prefix !== 'inv' || interaction.user.id !== viewerId) {
      return interaction.reply({ content: 'This is not your inventory.', ephemeral: true });
    }

    const user = await User.findOne({ userId: targetId });
    if (!user) return interaction.reply({ content: 'User not found.', ephemeral: true });

    const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
    const username = targetUser ? targetUser.username : targetId;
    const avatarUrl = targetUser ? targetUser.displayAvatarURL() : interaction.user.displayAvatarURL();

    let newCategory = category;
    let newPage = 0;

    if (action === 'cat') {
      // Switch category, reset to page 0
      newCategory = category;
      newPage = 0;
    } else {
      // Navigate within current category
      const currentEmbed = interaction.message.embeds[0];
      const footerText = currentEmbed?.footer?.text || 'Page 1/1 · items';
      const match = footerText.match(/Page (\d+)\/(\d+)/);
      const currentPage = match ? parseInt(match[1]) - 1 : 0;
      const totalFromFooter = match ? parseInt(match[2]) : 1;

      if (action === 'prev') newPage = Math.max(0, currentPage - 1);
      else if (action === 'next') newPage = Math.min(totalFromFooter - 1, currentPage + 1);
      else newPage = currentPage;
    }

    const { embed, totalPages, currentPage: actualPage } = buildInventoryEmbed(user, username, avatarUrl, newPage, newCategory);
    const navRow = buildNavRow(viewerId, targetId, actualPage, totalPages, newCategory);
    const dropdownRow = buildCategoryDropdown(viewerId, targetId, newCategory);

    return interaction.update({ embeds: [embed], components: [dropdownRow, navRow] });
  }
};
