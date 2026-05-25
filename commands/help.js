const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { applyDefaultEmbedStyle } = require('../utils/embedStyle');

const COMMAND_CATEGORIES = {
  account: {
    name: 'Account',
    emoji: '<:user:1490731587564736643>',
    commands: [
      { name: 'start', desc: 'Create your account' },
      { name: 'user', desc: 'View your profile' },
      { name: 'balance', desc: 'Check your balance' }
    ]
  },
  cards: {
    name: 'Cards',
    emoji: '<:bag:1490732030458331348>',
    commands: [
      { name: 'pull', desc: 'Pull a card' },
      { name: 'info <card>', desc: 'View a card\'s stats/information' },
      { name: 'collection', desc: 'Browse your card collection with filters' },
      { name: 'stock', desc: 'See the current pack stock' },
      { name: 'open <pack>', desc: 'Open a chest or a pack' },
      { name: 'equip <artifact> <card>', desc: 'Equip an artifact to a card' },
      { name: 'unequip <artifact>', desc: 'Unequip an artifact from its card' },
      { name: 'reset', desc: 'Reset your pulls' },
      { name: 'market', desc: 'View the card market' },
      { name: 'marketlistings', desc: 'View your market listings' }
    ]
  },
  team: {
    name: 'Team',
    emoji: '<:sword:1490732251107819530>',
    commands: [
      { name: 'team', desc: 'View your team.' },
      { name: 'team add/remove <card>', desc: 'Remove or add a card from your team' },
      { name: 'autoteam', desc: 'Automatically set your team to your 3 strongest cards' },
      { name: 'teambackground <image_url>', desc: 'Set your team background' }
    ]
  },
  battle: {
    name: 'Battle',
    emoji: '<:energy:1478051414558118052>',
    commands: [
      { name: 'duel @user', desc: 'Challenge another player to a 1v1 battle' },
      { name: 'sail', desc: 'Sail through story stages or battle NPC marines' },
      { name: 'forfeit', desc: 'Forfeit your current battle' },
      { name: 'bounty', desc: 'Place a bounty on a random user' },
      { name: 'fuel <amount>', desc: 'Use Cola to refill your ship' },
      { name: 'wanted', desc: 'See your wanted poster' }
    ]
  },
  economy: {
    name: 'Economy',
    emoji: '<:dollar:1490732561792500062>',
    commands: [
      { name: 'daily', desc: 'Claim your daily rewards (streak & packs)' },
      { name: 'shop', desc: 'View the shop' },
      { name: 'buy <item> <quantity>', desc: 'Purchase items from the shop' },
      { name: 'sell <card/leveler>', desc: 'Sell cards from your collection' },
      { name: 'bulksell <card/leveler>, etc.. ', desc: 'Bulk sell multiple cards' },
      { name: 'inventory', desc: 'View your inventory' },
      { name: 'setship <ship>', desc: 'Set your ship' },
      { name: 'deposit <amount>', desc: 'Deposit Beli into your active ship' },
      { name: 'claim [amount]', desc: 'Claim earnings from your active ship' },
      { name: 'rob [@user]', desc: 'Attempt to rob another player' },
      { name: 'loot', desc: 'Attempt to loot a random pirate ship' },
      { name: 'gamble', desc: 'Lots fun little gambling minigames' }
    ]
  },
  activities: {
    name: 'Fun',
    emoji: '<:paintbrush:1490733392860287088>',
    commands: [
      { name: 'fish', desc: 'Go fishing for levelers' },
      { name: 'feed <query> <item>', desc: 'Feed levelers to a card to level it up' },
      { name: 'trivia [difficulty]', desc: 'Play a trivia quiz to earn rewards' },
      { name: 'trade <cardID>/*beli <cardID>', desc: 'Trade with another user' },
    ]
  },
  info: {
    name: 'Info',
    emoji: '<:help:1490733477057007716>',
    commands: [
      { name: 'leaderboard', desc: 'View the global leaderboard' },
      { name: 'timers', desc: 'Check all your timers' },
      { name: 'help', desc: 'Show this help menu' }
    ]
  },
  crew: {
    name: 'Crew',
    emoji: '🏴‍☠️',
    commands: [
      { name: 'crew view [@user]', desc: 'View your crew or another player\'s crew' },
      { name: 'crew create <name>', desc: 'Create a new crew (prefix) or use /crew view for the form' },
      { name: 'crew invite @user', desc: 'Invite a member to your crew (captain only)' },
      { name: 'crew kick @user', desc: 'Kick a member from your crew (captain only)' },
      { name: 'crew color <#hex>', desc: 'Set the crew embed colour (captain only)' },
      { name: 'crew jolly <url>', desc: 'Set the crew jolly roger image (captain only)' },
      { name: 'crew leave', desc: 'Leave your current crew' },
      { name: 'crew disband', desc: 'Disband your crew (captain only)' }
    ]
  }
};

function createCategoryEmbed(categoryKey, discordUser) {
  const category = COMMAND_CATEGORIES[categoryKey];
  if (!category) return null;

  const embed = new EmbedBuilder()
    .setColor('#FFFFFF')
    .setTitle(`${category.emoji} ${category.name}`)
    .setDescription(category.commands.map(cmd => `\`${cmd.name}\` - ${cmd.desc}`).join('\n'))
    .setFooter({ text: 'Use `/` for slash commands or `op` prefix for text commands' });

  applyDefaultEmbedStyle(embed, discordUser);
  return embed;
}

function createMainHelpEmbed(discordUser) {
  const categoryList = Object.entries(COMMAND_CATEGORIES)
    .map(([key, cat]) => `${cat.emoji} **${cat.name}** - ${cat.commands.length} commands`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor('#FFFFFF')
    .setDescription('**Select a category below to view commands.**')
    .addFields({ name: 'Categories', value: categoryList })
    .setFooter({ text: 'Select a category from the dropdown menu below' });

  applyDefaultEmbedStyle(embed, discordUser);
  return embed;
}

function createSelectMenu() {
  const options = Object.entries(COMMAND_CATEGORIES).map(([key, cat]) => ({
    label: cat.name,
    value: key,
    emoji: cat.emoji,
    description: `${cat.commands.length} commands`
  }));

  return new StringSelectMenuBuilder()
    .setCustomId('help_category')
    .setPlaceholder('Choose a category...')
    .addOptions(options);
}

module.exports = {
  name: 'help',
  description: 'View all available commands',
  async execute({ message, interaction }) {
    const discordUser = message ? message.author : interaction.user;
    const mainEmbed = createMainHelpEmbed(discordUser);
    const row = new ActionRowBuilder().addComponents(createSelectMenu());

    if (message) {
      return message.channel.send({ embeds: [mainEmbed], components: [row] });
    }
    return interaction.reply({ embeds: [mainEmbed], components: [row] });
  },

  // Handle category selection
  async handleCategorySelect(interaction) {
    const categoryKey = interaction.values[0];
    const embed = createCategoryEmbed(categoryKey, interaction.user);
    
    if (!embed) {
      if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { content: 'Category not found.', components: [] });
      return global.safeUpdate(interaction, { content: 'Category not found.', components: [] });
    }

    const backButton = new ActionRowBuilder().addComponents(
      new (require('discord.js')).ButtonBuilder()
        .setCustomId('help_back')
        .setLabel('Back')
        .setStyle(require('discord.js').ButtonStyle.Secondary)
    );

    if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { embeds: [embed], components: [backButton] });
    return global.safeUpdate(interaction, { embeds: [embed], components: [backButton] });
  },

  // Handle back button
  async handleBack(interaction) {
    const discordUser = interaction.user;
    const mainEmbed = createMainHelpEmbed(discordUser);
    const row = new ActionRowBuilder().addComponents(createSelectMenu());
    
    if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { embeds: [mainEmbed], components: [row] });
    return global.safeUpdate(interaction, { embeds: [mainEmbed], components: [row] });
  }
};
