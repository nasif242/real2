require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Client, GatewayIntentBits } = require('discord.js');
const { PREFIX } = require('./config');

const startCmd = require('./commands/start');
const { normalizeAllUserRods } = require('./utils/inventoryHelper');
const pullCmd = require('./commands/pull');
const resetCmd = require('./commands/reset');
const teamCmd = require('./commands/team');
const teamBackgroundCmd = require('./commands/teambackground');
const inventoryCmd = require('./commands/inventory');
const balanceCmd = require('./commands/balance');
const autoTeamCmd = require('./commands/autoteam');
const duelCmd = require('./commands/duel');
const sellCmd = require('./commands/sell');
const shopCmd = require('./commands/shop');
const buyCmd = require('./commands/buy');
const claimCmd = require('./commands/claim');
const bulksellCmd = require('./commands/bulksell');
const equipCmd = require('./commands/equip');
const unequipCmd = require('./commands/unequip');
const triviaCmd = require('./commands/trivia');
const bountyCmd = require('./commands/bounty');
const userCmd = require('./commands/user');
const leaderboardCmd = require('./commands/leaderboard');
const dailyCmd = require('./commands/daily');
const stockCmd = require('./commands/stock');
const openCmd = require('./commands/open');
const tradeCmd = require('./commands/trade');
const robCmd = require('./commands/rob');
const stopRobCmd = require('./commands/stoprob');
const timersCmd = require('./commands/timers');
const lootCmd = require('./commands/loot');
const setShipCmd = require('./commands/setship');
const depositCmd = require('./commands/deposit');
const betCmd = require('./commands/bet');
const gambleCmd = require('./commands/gamble');
const forfeitCmd = require('./commands/forfeit');
const favoriteCmd = require('./commands/favorite');
const unfavoriteCmd = require('./commands/unfavorite');
const favoritesCmd = require('./commands/favorites');
const voteCmd = require('./commands/vote');
const { startVoteWebhook } = require('./src/voteWebhook');
const marketCmd = require('./commands/market');
const marketListCmd = require('./commands/marketlist');
const marketListingsCmd = require('./commands/marketlistings');
const marketBuyCmd = require('./commands/marketbuy');
const crewCmd = require('./commands/crew');
const User = require('./models/User');
const { setBotConfig } = require('./models/BotConfig');

async function main() {
  if (!process.env.DISCORD_TOKEN && !process.env.TOKEN) return console.error('Please set DISCORD_TOKEN or TOKEN in .env');
  // support either name in runtime
  const token = process.env.DISCORD_TOKEN || process.env.TOKEN;
  if (!process.env.MONGODB_URI) console.warn('MONGODB_URI not set; bot will run without DB');

  // Connect mongoose
  if (process.env.MONGODB_URI) {
    await mongoose.connect(process.env.MONGODB_URI).then(() => console.log('Connected to MongoDB')).catch(err => console.error('MongoDB error', err));
  }

  // Start top.gg vote webhook HTTP server
  startVoteWebhook();

  // Initialize stock system
  const stockModule = require('./src/stock');
  stockModule.initStockSystem();

  // Enforce card level caps based on rank (migration)
  try {
    const { RANK_MAX_LEVEL } = require('./utils/starLevel');
    const { cards: cardDefs } = require('./data/cards');
    const allUsers = await User.find({}, 'ownedCards');
    let cappedUserCount = 0;
    for (const u of allUsers) {
      let modified = false;
      for (const entry of (u.ownedCards || [])) {
        const def = cardDefs.find(c => c.id === entry.cardId);
        if (!def || !def.rank) continue;
        const maxLevel = RANK_MAX_LEVEL[def.rank];
        if (!maxLevel) continue;
        if ((entry.level || 1) > maxLevel) {
          entry.level = maxLevel;
          entry.xp = 0;
          modified = true;
        }
      }
      if (modified) {
        await u.save();
        cappedUserCount++;
      }
    }
    console.log(`Level cap enforcement complete. Updated ${cappedUserCount} user(s).`);
  } catch (err) {
    console.error('Error enforcing level caps:', err);
  }

  // Normalize old rod inventory entries to remove duplicate/outdated rods
  try {
    const normalizedCount = await normalizeAllUserRods();
    console.log(`Rod normalization complete. Updated ${normalizedCount} user${normalizedCount === 1 ? '' : 's'}.`);
  } catch (err) {
    console.error('Error normalizing rod inventory:', err);
  }

  // Initialize drops system
  const dropsModule = require('./commands/drops');
  dropsModule.initializeDrops(null); // Will be set by client once ready

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages], partials: [] });

  // expose safe interaction helpers globally so command modules can call them
  try {
    const safeInteraction = require('./utils/safeInteraction');
    global.safeInteraction = safeInteraction;
    global.safeUpdate = safeInteraction.safeUpdate;
    global.safeReply = safeInteraction.safeReply;
    global.safeDefer = safeInteraction.safeDefer;
  } catch (e) {
    console.warn('Failed to initialize safeInteraction helpers', e);
  }

  // Global process-level handlers to avoid the bot exiting on unexpected errors
  process.on('unhandledRejection', (reason, p) => {
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception thrown:', err);
  });
  process.on('uncaughtExceptionMonitor', (err) => {
    console.error('Uncaught Exception (monitor):', err);
  });

  // Handle Discord client-level errors so they don't crash the process
  client.on('error', (err) => {
    console.error('Discord client error', err);
  });
  client.on('shardError', (err) => {
    console.error('Discord shard error', err);
  });
  client.on('warn', (info) => {
    console.warn('Discord client warning', info);
  });

  client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    // Log some operational counts
    try {
      console.log(`serving ${client.guilds.cache.size} guilds`);
      // Count active players excluding those inactive for more than 14 days
      try {
        const users = await User.find({}, 'lastDaily lastIsailFail lastFishFail');
        const cutoff = Date.now() - (14 * 24 * 60 * 60 * 1000);
        let activeCount = 0;
        for (const u of users) {
          let last = 0;
          if (u.lastDaily) last = Math.max(last, new Date(u.lastDaily).getTime());
          if (u.lastIsailFail) last = Math.max(last, new Date(u.lastIsailFail).getTime());
          if (u.lastFishFail) last = Math.max(last, new Date(u.lastFishFail).getTime());
          if (u._id && typeof u._id.getTimestamp === 'function') last = Math.max(last, u._id.getTimestamp().getTime());
          if (last >= cutoff) activeCount++;
        }
        console.log(`${activeCount} players (excluding inactive >2 weeks)`);
      } catch (errCount) {
        console.error('Error counting active users', errCount);
      }
    } catch (err) {
      console.error('Error during startup logging', err);
    }
    await dropsModule.initializeDrops(client); // Initialize with client reference and restore any saved drop channel
    // let stock module know the client so it can post reset notifications
    try { stockModule.setClient(client); } catch (e) {}
    // pass Discord client to vote webhook so it can DM voters
    try { require('./src/voteWebhook').setClient(client); } catch (e) {}
    // removed pre-warm cache logic (caused issues in some hosting environments)
    // start a periodic checker for daily reminders (runs every minute)
    const { EmbedBuilder } = require('discord.js');
    setInterval(async () => {
      try {
        const now = new Date();
        const dueUsers = await User.find({ nextDailyReminder: { $lte: now } });
        for (const u of dueUsers) {
          try {
            const discordUser = await client.users.fetch(u.userId).catch(() => null);
            if (discordUser) {
              const embed = new EmbedBuilder()
                .setColor('#FFFFFF')
                .setTitle('Daily ready to claim')
                .setDescription(`Hey **${discordUser.username}**, its been 24 hours since you last collected your daily! claim your daily with \`/daily\`.`)
                .setThumbnail(client.user.displayAvatarURL());
              await discordUser.send({ embeds: [embed] }).catch(() => {});
            }
          } catch (err) {
            console.error('Error sending daily reminder DM', err);
          } finally {
            // clear reminder so we only remind once unless they claim again
            u.nextDailyReminder = null;
            await u.save().catch(() => {});
          }
        }
      } catch (err) {
        console.error('Daily reminder check failed', err);
      }
    }, 60 * 1000);
  });

  // simple lock to prevent rapid button spam causing race conditions
  const processingInteractions = new Set();

  client.on('interactionCreate', async (interaction) => {
    try {
      // track guild usage for owner guildlist filtering (best-effort, non-blocking)
      try { if (interaction && interaction.guildId) setBotConfig && setBotConfig(`guildUsed:${interaction.guildId}`, Date.now()); } catch (e) {}
      if (interaction.isButton()) {
        // guard against multiple button presses while we are handling one
        if (processingInteractions.has(interaction.user.id)) {
          return await interaction.reply({ content: 'Please wait for the previous action to finish.', ephemeral: true });
        }
        processingInteractions.add(interaction.user.id);
      }

      if (interaction.isModalSubmit()) {
        const [action] = interaction.customId.split(':');
        if (action === 'market_search_modal') {
          return await marketCmd.handleModal(interaction);
        }
        if (action === 'guildlist_goto_modal') {
          return await require('./commands/owner').handleModal(interaction);
        }
        if (action === 'gamble_roul_lucky') {
          return await gambleCmd.handleRouletteModal(interaction);
        }
        if (action === 'crew_create_modal') {
          return await crewCmd.handleModal(interaction);
        }
      }

      if (interaction.isStringSelectMenu()) {
        const [action] = interaction.customId.split(':');
        if (action === 'collection_sort_select') {
          return await require('./commands/collection').handleButton(interaction, interaction.customId);
        }
        if (action === 'guildlist_filter') {
          return await require('./commands/owner').handleSelect(interaction);
        }
        if (action === 'help_category') {
          return await require('./commands/help').handleCategorySelect(interaction);
        }
        if (action === 'trivia_diff') {
          return await triviaCmd.handleDifficultySelect(interaction);
        }
        if (action === 'gamble_game' || action === 'gamble_bet' || action === 'gamble_roul') {
          return await gambleCmd.handleSelect(interaction);
        }
        if (action === 'sail_select') {
          return await require('./commands/sail').handleSelect(interaction);
        }
        if (action === 'market_rank' || action === 'market_attr' || action === 'market_star' || action === 'market_buy') {
          return await marketCmd.handleSelect(interaction);
        }
        if (action === 'marketcancel') {
          return await marketListingsCmd.handleSelect(interaction);
        }
        if (action === 'inv_category') {
          return await require('./commands/inventory').handleSelect(interaction);
        }
      }

      if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;
        if (commandName === 'start') return await startCmd.execute({ interaction });
        if (commandName === 'pull') return await pullCmd.execute({ interaction });
        if (commandName === 'reset') return await resetCmd.execute({ interaction });
        if (commandName === 'autoteam') return await autoTeamCmd.execute({ interaction });
        if (commandName === 'team') return await teamCmd.execute({ interaction });
        if (commandName === 'teambackground') return await teamBackgroundCmd.execute({ interaction });
        if (commandName === 'inventory') return await inventoryCmd.execute({ interaction });
        if (commandName === 'duel') return await duelCmd.execute({ interaction });
        if (commandName === 'sell') return await sellCmd.execute({ interaction });
        if (commandName === 'shop') return await shopCmd.execute({ interaction });
        if (commandName === 'buy') return await buyCmd.execute({ interaction });
        if (commandName === 'bet') return await betCmd.execute({ interaction });
        if (commandName === 'gamble') return await gambleCmd.execute({ interaction });
        if (commandName === 'trivia') return await triviaCmd.execute({ interaction });
        if (commandName === 'bounty') return await bountyCmd.execute({ interaction });
        if (commandName === 'user') return await userCmd.execute({ interaction });
        if (commandName === 'leaderboard') return await leaderboardCmd.execute({ interaction });
        if (commandName === 'daily') return await dailyCmd.execute({ interaction });
        if (commandName === 'vote') return await voteCmd.execute({ interaction });
        if (commandName === 'stock') return await stockCmd.execute({ interaction });
        if (commandName === 'open') return await openCmd.execute({ interaction });
        if (commandName === 'trade') return await tradeCmd.execute({ interaction });
        if (commandName === 'claim') return await claimCmd.execute({ interaction });
        if (commandName === 'bulksell') return await bulksellCmd.execute({ interaction });
        if (commandName === 'rob') return await robCmd.execute({ interaction });
        if (commandName === 'stoprob') return await stopRobCmd.execute({ interaction });
        if (commandName === 'loot') return await lootCmd.execute({ interaction });
        if (commandName === 'timers') return await timersCmd.execute({ interaction });
        if (commandName === 'info') return await require('./commands/info').execute({ interaction });
        if (commandName === 'tutorial') return await require('./commands/tutorial').execute({ interaction });
        if (commandName === 'setship') return await setShipCmd.execute({ interaction });
        if (commandName === 'deposit') return await depositCmd.execute({ interaction });
        if (commandName === 'card') return await require('./commands/card').execute({ interaction });
        if (commandName === 'upgrade') return await require('./commands/upgrade').execute({ interaction });
        if (commandName === 'forfeit') return await forfeitCmd.execute({ interaction });
        // `/isail` command disabled; use the Sail menu to access Infinite Sail (Navy base)
        if (commandName === 'sail') return require('./commands/sail').execute({ interaction });
        if (commandName === 'fuel') return require('./commands/fuel').execute({ interaction });
        if (commandName === 'fish') return require('./commands/fish').execute({ interaction });
        if (commandName === 'feed') return require('./commands/feed').execute({ interaction });
        if (commandName === 'equip') return equipCmd.execute({ interaction });
        if (commandName === 'unequip') return unequipCmd.execute({ interaction });
        if (commandName === 'help') return require('./commands/help').execute({ interaction });
        if (commandName === 'crew') return crewCmd.execute({ interaction });
      }

      if (interaction.isButton()) {
        const [action, cardId] = interaction.customId.split(':');
        
        // handle help back button
        if (action === 'help_back') {
          return await require('./commands/help').handleBack(interaction);
        }
        // handle tutorial run button (from start prompt) or navigation
        if (action === 'tutorial_run') {
          return await require('./commands/tutorial').execute({ interaction });
        }
        if (action && (action.startsWith('tutorial_nav') || action === 'tutorial_about')) {
          return await require('./commands/tutorial').handleButton(interaction, interaction.customId);
        }
        
        // existing card pager buttons
        if (action === 'mastery_prev' || action === 'mastery_next') {
          const { cards } = require('./data/cards');
          const cardDef = cards.find(c => c.id === cardId);
          if (!cardDef) return;
          const direction = action === 'mastery_prev' ? -1 : 1;
          const newMastery = cardDef.mastery + direction;
          const newDef = cards.find(c => c.character === cardDef.character && c.mastery === newMastery);
          if (!newDef) return;

          // compute user entry if possible
          let userEntry = null;
          let userDoc = null;
          try {
            const user = await User.findOne({ userId: interaction.user.id });
            if (user) {
              userDoc = user;
              userEntry = user.ownedCards.find(e => e.cardId === newDef.id) || null;
            }
          } catch {}
          const { buildCardEmbed } = require('./utils/cards');
          const avatarUrl = interaction.user.displayAvatarURL();
          const embed = buildCardEmbed(newDef, userEntry, avatarUrl, userDoc);
          // rebuild components
          const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
          const prevAvailable = newDef.mastery > 1;
          const nextAvailable = newDef.mastery < newDef.mastery_total;
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`mastery_prev:${newDef.id}`)
              .setLabel('Previous')
              .setStyle(prevAvailable ? ButtonStyle.Primary : ButtonStyle.Secondary)
              .setDisabled(!prevAvailable),
            new ButtonBuilder()
              .setCustomId(`mastery_next:${newDef.id}`)
              .setLabel('Next')
              .setStyle(nextAvailable ? ButtonStyle.Primary : ButtonStyle.Secondary)
              .setDisabled(!nextAvailable)
          );
          // Attach generated artifact image when navigating mastery pages
          let files;
          if (newDef && newDef.artifact && !newDef.image_url) {
            try {
              const { generateArtifactImage } = require('./utils/artifactImage');
              const { AttachmentBuilder } = require('discord.js');
              const buf = await generateArtifactImage(newDef);
              files = [new AttachmentBuilder(buf, { name: `artifact-${newDef.id}.png` })];
            } catch (e) {
              console.error('Failed to generate artifact image for mastery nav', e);
            }
          }
          // use safeUpdate to avoid throwing on expired/unknown interactions
          if (global && typeof global.safeUpdate === 'function') return await global.safeUpdate(interaction, { embeds: [embed], components: [row], files });
          return await global.safeUpdate(interaction, { embeds: [embed], components: [row], files });
        }

        // handle reset token confirmation
        if (action === 'reset_confirm') {
          return await resetCmd.handleButton(interaction, interaction.customId.split(':').slice(1).join(':'));
        }

        // handle infinite sail interactions
        if (action && action.startsWith('isail')) {
          return await require('./commands/isail').handleButton(interaction, action, cardId);
        }
        // handle story sail interactions
        if (action && action.startsWith('sail')) {
          return await require('./commands/sail').handleButton(interaction, action, cardId);
        }

        if (action === 'fish_catch') {
          return await require('./commands/fish').handleCatch(interaction, cardId);
        }

        if (action === 'pull_more_info') {
          return await pullCmd.handleButton(interaction);
        }

        // handle duel interactions
        if (action && action.startsWith('duel')) {
          return await duelCmd.handleButton(interaction, action, cardId);
        }

        // handle pack opening interactions
        if (action && action.startsWith('open_next')) {
          return await openCmd.handleButton(interaction, interaction.customId);
        }

        // handle trade accept/decline buttons
        if (action === 'trade_confirm' || action === 'trade_cancel') {
          return await tradeCmd.handleButton(interaction, interaction.customId);
        }

        // handle stock button purchases
        if (action === 'stock_buy') {
          return await stockCmd.handleButton(interaction, interaction.customId);
        }

        // handle stock page navigation
        if (action === 'stock_page') {
          return await stockCmd.handleButton(interaction, interaction.customId);
        }

        if (action === 'trivia_answer' || action === 'trivia_continue') {
          return await triviaCmd.handleButton(interaction);
        }

        // handle collection navigation and boost
        if (action && (action.startsWith('collection_next') || action.startsWith('collection_prev') || action === 'collection_sort' || action === 'collection_sort_select' || action === 'collection_boost')) {
          return await require('./commands/collection').handleButton(interaction, interaction.customId);
        }

        // handle info card navigation
        if (action && action.startsWith('info_')) {
          return await require('./commands/info').handleButton(interaction, action, cardId);
        }

        // handle inventory pagination
        if (action && (action.startsWith('inv_prev') || action.startsWith('inv_next'))) {
          return await require('./commands/inventory').handleButton(interaction, interaction.customId);
        }

        // handle card drop claims
        if (action && action.startsWith('drop_claim')) {
          const dropId = interaction.customId.split(':')[1];
          return await require('./commands/drops').handleDropClaim(interaction, dropId);
        }

        // handle balance interactions
        if (action === 'balance') {
          return await require('./commands/balance').handleButton(interaction, cardId);
        }

        // handle bounty interactions
        if (action === 'bounty') {
          return await require('./commands/bounty').handleButton(interaction, `${cardId}:${interaction.customId.split(':').slice(2).join(':')}`);
        }

        // handle team autoteam
        if (action === 'team_autoteam') {
          return await require('./commands/team').handleButton(interaction, action, cardId);
        }
        // handle team ids
        if (action === 'team_ids') {
          return await require('./commands/team').handleButton(interaction, action, cardId);
        }

        if (action && action.startsWith('bulksell_confirm')) {
          const [, token, choice] = interaction.customId.split(':');
          return await bulksellCmd.handleButton(interaction, choice, token);
        }

        // handle owner buttons (reset-all confirmation, guildlist pagination)
        if (action && (action.startsWith('owner_reset_all') || action.startsWith('owner_resetisail') || action.startsWith('guildlist_prev') || action.startsWith('guildlist_next') || action.startsWith('guildlist_goto'))) {
          return require('./commands/owner').handleButton(interaction, interaction.customId);
        }

        // handle market navigation and search buttons
        if (action && (action === 'market_prev' || action === 'market_next' || action === 'market_search' || action === 'market_back')) {
          return marketCmd.handleButton(interaction);
        }

        // handle market listing cancel buttons
        if (action === 'marketcancel') {
          return marketListingsCmd.handleButton(interaction);
        }

        // handle star upgrade button interactions
        if (interaction.customId && (interaction.customId.startsWith('upgrade_star_') || interaction.customId === 'upgrade_cancel')) {
          return require('./commands/upgrade').handleUpgradeButton(interaction);
        }

        // handle gamble in-game buttons
        if (action === 'gamble_btn') {
          return gambleCmd.handleButton(interaction);
        }

        // handle nami ability info button (collection + info)
        if (action === 'nami_ability') {
          return gambleCmd.handleNamiAbilityButton(interaction, cardId);
        }

        // handle crew buttons
        if (action && (action === 'crew_create_btn' || action.startsWith('crew_disband') || action.startsWith('crew_invite'))) {
          return crewCmd.handleButton(interaction, interaction.customId);
        }
      }
    } catch (err) {
      console.error(err);
      try {
        if (interaction && (interaction.replied || interaction.deferred)) {
          await interaction.followUp({ content: 'Error running command', ephemeral: true }).catch(() => {});
        } else if (interaction) {
          await interaction.reply({ content: 'Error processing interaction', ephemeral: true }).catch(() => {});
        }
      } catch (replyErr) {
        console.error('Failed to send error response to interaction:', replyErr);
      }
    } finally {
      // release processing lock if we acquired one
      if (interaction.isButton()) processingInteractions.delete(interaction.user.id);
    }
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // Patch message.reply globally so no command ever pings the user
    const _origReply = message.reply.bind(message);
    message.reply = (content) => {
      if (typeof content === 'string') return _origReply({ content, allowedMentions: { repliedUser: false } });
      if (content && typeof content === 'object') return _origReply({ ...content, allowedMentions: { repliedUser: false } });
      return _origReply(content);
    };

    // Support both prefix `op` and bot mention as prefix
    const content = message.content || '';
    const lower = content.toLowerCase();

    // allow: "op pull", "oppull" (not recommended), or mention prefix
    let invoked = null;
    let payload = '';

    if (lower.startsWith(PREFIX)) {
      payload = content.slice(PREFIX.length).trim();
      invoked = 'prefix';
    } else if (message.mentions.users.has(client.user?.id)) {
      // strip mention
      const mentionRegex = new RegExp(`<@!?(?:${client.user.id})>`);
      payload = content.replace(mentionRegex, '').trim();
      invoked = 'mention';
    } else {
      return; // not a command for us
    }

    if (!payload) return; // nothing after prefix
    const args = payload.split(/ +/g);
    let cmd = args.shift().toLowerCase();
    // alias shortcuts
    if (cmd === 'p') cmd = 'pull';
    if (cmd === 'opp') cmd = 'pull';
    if (cmd === 'inv') cmd = 'inventory';
    if (cmd === 'dep') cmd = 'deposit';
    if (cmd === 't') cmd = 'timers';
    if (cmd === 'col') cmd = 'collection';
    try {
      if (cmd === 'start') return await startCmd.execute({ message });
    if (cmd === 'tutorial') return await require('./commands/tutorial').execute({ message });
      if (cmd === 'pull') return await pullCmd.execute({ message });
      if (cmd === 'greset') return await resetCmd.execute({ message, args: ['god'] });
      if (cmd === 'god' && args[0] && args[0].toLowerCase() === 'reset') return await resetCmd.execute({ message, args: ['god'] });
      if (cmd === 'reset') return await resetCmd.execute({ message, args });
      if (cmd === 'team') return await teamCmd.execute({ message, args });
      if (cmd === 'teambg' || cmd === 'teambackground') return await teamBackgroundCmd.execute({ message, args });
      if (cmd === 'autoteam') return await require('./commands/autoteam').execute({ message });
      if (cmd === 'inventory') return await inventoryCmd.execute({ message, args });
      if (cmd === 'balance' || cmd === 'bal') return await balanceCmd.execute({ message, args });
      if (cmd === 'duel') return await duelCmd.execute({ message, args });
      if (cmd === 'sell') return await sellCmd.execute({ message, args });
      if (cmd === 'shop') return await shopCmd.execute({ message });
      if (cmd === 'buy') return await buyCmd.execute({ message, args });
      if (cmd === 'bet') return await betCmd.execute({ message, args });
      if (cmd === 'gamble') return await gambleCmd.execute({ interaction: null, message });
      if (cmd === 'bounty') return await bountyCmd.execute({ message });
      if (cmd === 'user') return await userCmd.execute({ message, args });
      if (cmd === 'leaderboard' || cmd === 'lb') return await leaderboardCmd.execute({ message, args });
      if (cmd === 'daily') return await dailyCmd.execute({ message });
      if (cmd === 'vote') return await voteCmd.execute({ message });
      if (cmd === 'wanted') return await require('./commands/wanted').execute({ message, args });
      if (cmd === 'stock') return await stockCmd.execute({ message });
      if (cmd === 'open') return await openCmd.execute({ message, args });
      if (cmd === 'trade') return await tradeCmd.execute({ message, args });
      if (cmd === 'claim') return await claimCmd.execute({ message, args });
      if (cmd === 'bulksell') return await bulksellCmd.execute({ message, args });
      if (cmd === 'rob') return await robCmd.execute({ message, args });
      if (cmd === 'stoprob') return await stopRobCmd.execute({ message });
      if (cmd === 'forfeit') return await forfeitCmd.execute({ message });
      if (cmd === 'loot') return await lootCmd.execute({ message });
      if (cmd === 'timers') return await timersCmd.execute({ message });
      if (cmd === 'trivia') return await triviaCmd.execute({ message });
      if (cmd === 'collection') return await require('./commands/collection').execute({ message });
      if (cmd === 'info') return await require('./commands/info').execute({ message, args });
      if (cmd === 'upgrade') return await require('./commands/upgrade').execute({ message, args });
      if (cmd === 'set' || cmd === 'setship') return await setShipCmd.execute({ message, args });
      if (cmd === 'deposit') return await depositCmd.execute({ message, args });
      // Prefix `isail` disabled; use `sail` to access Infinite Sail (Navy base)
      if (cmd === 'sail') return await require('./commands/sail').execute({ message, args });
      if (cmd === 'fuel') return await require('./commands/fuel').execute({ message, args });
      if (cmd === 'fish') return await require('./commands/fish').execute({ message });
      if (cmd === 'feed') return await require('./commands/feed').execute({ message, args });
      if (cmd === 'equip') return await equipCmd.execute({ message, args });
      if (cmd === 'unequip') return await unequipCmd.execute({ message, args });
      if (cmd === 'favorite') return await favoriteCmd.execute({ message, args });
      if (cmd === 'unfavorite') return await unfavoriteCmd.execute({ message, args });
      if (cmd === 'favorites') return await favoritesCmd.execute({ message });
      if (cmd === 'help' || cmd === 'h') return await require('./commands/help').execute({ message });
      if (cmd === 'crew') return await crewCmd.execute({ message, args });
      if (cmd === 'ownerlist') return await require('./commands/owner').list({ message });
      if (cmd === 'owner') return await require('./commands/owner').execute({ message, args });
      if (cmd === 'market') return await marketCmd.execute({ message, args });
      if (cmd === 'marketlist') return await marketListCmd.execute({ message, args });
      if (cmd === 'marketbuy') return await marketBuyCmd.execute({ message, args });
      if (cmd === 'marketlistings' || cmd === 'mylistings') return await marketListingsCmd.execute({ message, args });
      return; // unknown command - don't respond
    } catch (err) {
      console.error(err);
      message.reply({ content: 'Error running command.', allowedMentions: { repliedUser: false } });
    }
  });

  client.login(token);
}

main();
