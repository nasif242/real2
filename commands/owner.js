const User = require('../models/User');
const { cards } = require('../data/cards');
const { getCardById, formatCardId } = require('../utils/cards');
const { OWNER_ID } = require('../config');
const duelCmd = require('./duel');

const PAGE_SIZE = 10;

function sortGuilds(guilds, filter) {
  const copy = [...guilds];
  if (!filter || filter === 'default') return copy;
  if (filter === 'members_desc') {
    copy.sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0));
  } else if (filter === 'created_desc') {
    copy.sort((a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0));
  } else if (filter === 'created_asc') {
    copy.sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0));
  }
  return copy;
}

async function buildGuildListEmbedAndMeta(client, page, filter) {
  const { EmbedBuilder } = require('discord.js');
  const guilds = [...client.guilds.cache.values()];
  const sorted = sortGuilds(guilds, filter);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const clampedPage = Math.max(0, Math.min(page || 0, totalPages - 1));
  const start = clampedPage * PAGE_SIZE;
  const slice = sorted.slice(start, start + PAGE_SIZE);
  const lines = [];
  for (const guild of slice) {
    let inviteLink = 'No invite';
    try {
      const channels = guild.channels.cache.filter(c => c.type === 0 && c.permissionsFor(guild.members.me)?.has('CreateInstantInvite'));
      const firstChannel = channels.first();
      if (firstChannel) {
        const invite = await firstChannel.createInvite({ maxAge: 0, maxUses: 0, unique: false }).catch(() => null);
        if (invite) inviteLink = invite.url;
      }
    } catch {} // best-effort
    lines.push(`**${guild.name}** (${guild.memberCount} members)\n${inviteLink}`);
  }

  const embed = new EmbedBuilder()
    .setTitle(`Guild List (${guilds.length} total)`)
    .setColor('#FFFFFF')
    .setDescription(lines.join('\n\n') || 'No guilds.')
    .setFooter({ text: `Page ${clampedPage + 1}/${totalPages}` });

  return { embed, totalPages, page: clampedPage };
}

function parseMention(mention) {
  if (!mention) return null;
  const m = mention.match(/^<@!?(\d+)>$/);
  return m ? m[1] : null;
}

async function list({ message }) {
  if (message.author.id !== OWNER_ID) {
    return message.reply('You are not permitted to run owner commands.');
  }

  const { EmbedBuilder } = require('discord.js');
  const embed = new EmbedBuilder()
    .setTitle('Owner Commands')
    .setColor(0xFF0000)
    .setDescription('Available prefix commands for the bot owner/developer')
    .addFields(
      { name: 'op owner give <type> <amount> <@user>', value: 'Types: beli, gems, bounty, resettoken, card, pack, memerod, item\n- card syntax: op owner give card <cardId> <level> <@user> (level is optional, defaults to 1)\n- pack syntax: op owner give pack <crew name> <amount> <@user>\n- memerod syntax: op owner give memerod <@user>', inline: false },
      { name: 'op owner remove <type> <amount> <@user>', value: 'Types: beli, gems, bounty\n- Removes the specified amount (bounty has minimum of 100)', inline: false },
      { name: 'op owner removecard <cardId> <@user>', value: 'Remove all copies of a card from a user', inline: false },
      { name: 'op owner setresets <#channel>', value: 'Configure a channel to receive pull reset notifications', inline: false },
      { name: 'op owner unsetresets', value: 'Remove the reset notification channel configuration', inline: false },
      { name: 'op owner guildlist', value: 'Paginated list of all servers the bot is in, with invite links', inline: false },
      { name: 'op owner resetdata <@user>', value: 'Deletes the user record so they must /start again', inline: false },
      { name: 'op owner setdrops <#channel> <value>', value: 'Enable card drops in a channel and set messages needed per drop (default 100)', inline: false },
      { name: 'op owner setraids <#channel> <value>', value: 'Enable owner-spawned raids in a channel and set messages needed per spawn (default 200)', inline: false },
      { name: 'op owner unsetraids <#channel>', value: 'Disable owner-spawned raids in the specified channel', inline: false },
      { name: 'op owner activeraids', value: 'List active owner-spawned raids and per-channel progress', inline: false },
      { name: 'op owner unsetdrops <#channel>', value: 'Disable card drops in the specified channel', inline: false },
      { name: 'op owner activedrops', value: 'List active drops and per-channel progress (e.g., 37/100)', inline: false },
      { name: 'op owner dropparty <#channel> <amount>', value: 'Spawn <amount> drops immediately in the specified channel', inline: false },
      { name: 'op owner ship <@user>', value: 'View the user\'s active ship info', inline: false },
      { name: 'op owner setsailstage <sailstagenumber> <@user>', value: 'Set a user\'s story sail progress to the given global stage number (1 = start of Fusha Village). All previous stages are marked complete; stages after are cleared.', inline: false },
      { name: 'op ownerlist', value: 'Show this list', inline: false }
    );
  return message.channel.send({ embeds: [embed] });
}

async function execute({ message, args }) {
  if (message.author.id !== OWNER_ID) {
    return message.reply('You are not permitted to run owner commands.');
  }

  const sub = args[0];
  if (!sub) {
    return message.reply('Usage: op owner <give|resetdata|setdrops> ...');
  }

  if (sub === 'give') {
      const type = args[1];
      if (!type) return message.reply('Usage: op owner give <type> ...');

      let targetId;
      let amt;

      if (type === 'pack') {
        // syntax: give pack <crew> <amount> <@user>
        const crewQuery = args[2];
        amt = parseInt(args[3], 10);
        const mention = args[4];
        targetId = parseMention(mention);
        if (!crewQuery || isNaN(amt) || !targetId) {
          return message.reply('Usage: op owner give pack <crew name> <amount> <@user>');
        }
        // fuzzy match crew name from full list
        const crewList = require('../data/crews').map(c => c.name);
        const match = crewList.find(c => c.toLowerCase().includes(crewQuery.toLowerCase()));
        if (!match) {
          return message.reply(`Crew "${crewQuery}" not recognized.`);
        }
        const crewName = match;
        let target = await User.findOne({ userId: targetId });
        if (!target) return message.reply('Target user does not have an account.');
        target.packInventory = target.packInventory || {};
        target.packInventory[crewName] = (target.packInventory[crewName] || 0) + amt;
        target.markModified('packInventory');
        await target.save();
        return message.reply(`Given ${amt} ${crewName} pack(s) to <@${targetId}>`);
      }

      if (type === 'masscards') {
        // syntax: op owner give masscards <faculty> <@user>
        const facultyQuery = args[2];
        const mention = args[3];
        targetId = parseMention(mention);
        if (!facultyQuery || !targetId) return message.reply('Usage: op owner give masscards <faculty> <@user>');
        const facultyKey = facultyQuery.toLowerCase().replace(/[^a-z0-9]+/g, '');
        const { cards } = require('../data/cards');
        const matches = cards.filter(c => c.faculty && c.faculty.toLowerCase().replace(/[^a-z0-9]+/g, '') === facultyKey);
        if (!matches.length) return message.reply(`No cards found for faculty ${facultyQuery}`);
        let target = await User.findOne({ userId: targetId });
        if (!target) return message.reply('Target user does not have an account.');
        target.ownedCards = target.ownedCards || [];
        for (const def of matches) {
          if (!target.ownedCards.some(e => e.cardId === def.id)) {
            target.ownedCards.push({ cardId: def.id, level: 1, xp: 0 });
          }
          if (!target.history.includes(def.id)) target.history.push(def.id);
        }
        await target.save();
        // run achievement checks for the target
        try {
        } catch (err) {
          console.error('Achievement check after masscards failed', err);
        }
        return message.reply(`Added ${matches.length} cards from faculty ${facultyQuery} to <@${targetId}>`);
      }

      if (type === 'memerod') {
        const mention = args[2];
        targetId = parseMention(mention);
        if (!targetId) {
          return message.reply('Usage: op owner give memerod <@user>');
        }
        const targetUser = await User.findOne({ userId: targetId });
        if (!targetUser) {
          return message.reply('Target user does not have an account.');
        }
        if (!Array.isArray(targetUser.items)) targetUser.items = [];
        if (targetUser.items.some(i => i.itemId === 'meme_rod')) {
          return message.reply('Target user already has the Meme Rod.');
        }
        targetUser.items.push({ itemId: 'meme_rod', quantity: 1, durability: 3 });
        targetUser.currentRod = 'meme_rod';
        await targetUser.save();
        return message.reply(`Given Meme Rod to <@${targetId}>`);
      }

      if (type === 'chest' || type === 'chests') {
        // syntax: op owner give chest <chest name|id> <amount> <@user>
        const chestQuery = args[2];
        const amtParsed = parseInt(args[3], 10);
        const mentionChest = args[4];
        targetId = parseMention(mentionChest);
        if (!chestQuery || isNaN(amtParsed) || !targetId) return message.reply('Usage: op owner give chest <chest> <amount> <@user>');
        const { getChestByQuery, getChestById } = require('../data/chests');
        const chestDef = getChestByQuery(chestQuery) || getChestById(chestQuery);
        if (!chestDef) return message.reply(`Chest type "${chestQuery}" not recognized.`);
        let tgt = await User.findOne({ userId: targetId });
        if (!tgt) return message.reply('Target user does not have an account.');
        tgt.items = tgt.items || [];
        const existing = tgt.items.find(it => it.itemId === chestDef.id);
        if (existing) existing.quantity += amtParsed;
        else tgt.items.push({ itemId: chestDef.id, quantity: amtParsed });
        await tgt.save();
        return message.reply(`Given ${amtParsed} ${chestDef.name}(s) to <@${targetId}>`);
      }

      if (type === 'item') {
        // syntax: op owner give item <itemId> <amount> <@user>
        const itemId = args[2];
        const amtParsed = parseInt(args[3], 10);
        const mention = args[4];
        targetId = parseMention(mention);
        if (!itemId || isNaN(amtParsed) || !targetId) return message.reply('Usage: op owner give item <itemId> <amount> <@user>');
        let tgt = await User.findOne({ userId: targetId });
        if (!tgt) return message.reply('Target user does not have an account.');
        tgt.items = tgt.items || [];
        const existing = tgt.items.find(it => it.itemId === itemId);
        if (existing) existing.quantity += amtParsed;
        else tgt.items.push({ itemId, quantity: amtParsed });
        await tgt.save();
        return message.reply(`Given ${amtParsed} ${itemId}(s) to <@${targetId}>`);
      }

      // card: op owner give card <cardId> <level> <@user>  (level optional)
      if (type === 'card') {
        const cardId = args[2];
        const levelArg = args[3];
        const mention = args[4] || args[3];
        // if levelArg looks like a mention, no level was provided
        const levelProvided = levelArg && !levelArg.startsWith('<@') && !isNaN(parseInt(levelArg, 10));
        const resolvedMention = levelProvided ? args[4] : args[3];
        targetId = parseMention(resolvedMention);
        if (!cardId || !targetId) return message.reply('Usage: op owner give card <cardId> [level] <@user>');
        const cardDef = getCardById(cardId);
        if (!cardDef) return message.reply(`No card with id ${formatCardId(cardId)} exists`);
        let target = await User.findOne({ userId: targetId });
        if (!target) return message.reply('Target user does not have an account.');
        if (target.ownedCards.some(e => e.cardId === cardDef.id)) {
          return message.reply('User already owns that card, gift cancelled.');
        }
        const actualCardId = cardDef.id;
        const { getMaxLevelForRank } = require('../utils/starLevel');
        const maxLevel = getMaxLevelForRank(cardDef.rank);
        let giveLevel = 1;
        if (levelProvided) {
          const parsed = parseInt(levelArg, 10);
          if (!isNaN(parsed) && parsed >= 1) giveLevel = Math.min(parsed, maxLevel);
        }
        target.ownedCards.push({ cardId: actualCardId, level: giveLevel, xp: 0 });
        if (!target.history.includes(actualCardId)) target.history.push(actualCardId);
        await target.save();
        try {
        } catch (err) {
          console.error('Achievement check after owner give card failed', err);
        }
        return message.reply(`Added card ${formatCardId(actualCardId)} (Lv. ${giveLevel}) to <@${targetId}>'s collection`);
      }

      // fallback for simple two-arg give
      const amountArg = args[2];
      const mention = args[3];
      targetId = parseMention(mention);
      if (!amountArg || !targetId) {
        return message.reply('Usage: op owner give <type> <amount> <@user>');
      }

      let target = await User.findOne({ userId: targetId });
      if (!target) {
        return message.reply('Target user does not have an account.');
      }

      // Give bounty amount directly
      if (type === 'bounty') {
        const amtParsed = parseInt(amountArg, 10);
        if (isNaN(amtParsed)) return message.reply('Amount must be a number');
        await User.findOneAndUpdate({ userId: targetId }, { $inc: { bounty: amtParsed } });
        return message.reply(`Given ${amtParsed} bounty to <@${targetId}>`);
      }

      if (type === 'beli' || type === 'gems') {
        const amtParsed = parseInt(amountArg, 10);
        if (isNaN(amtParsed)) return message.reply('Amount must be a number');
        if (type === 'beli') {
          await User.findOneAndUpdate({ userId: targetId }, { $inc: { balance: amtParsed } });
          return message.reply(`Given ¥${amtParsed} to <@${targetId}>`);
        } else {
          await User.findOneAndUpdate({ userId: targetId }, { $inc: { gems: amtParsed } });
          return message.reply(`Given ${amtParsed} gem(s) to <@${targetId}>`);
        }
      }

      if (type === 'resettoken') {
        const amtParsed = parseInt(amountArg, 10);
        if (isNaN(amtParsed)) return message.reply('Amount must be a number');
        await User.findOneAndUpdate({ userId: targetId }, { $inc: { resetTokens: amtParsed } });
        return message.reply(`Given ${amtParsed} reset token(s) to <@${targetId}>`);
      }

      return message.reply('Unknown give type; valid types are beli, gems, resettoken, card, pack');
    }

  if (sub === 'remove') {
      const type = args[1];
      if (!type) return message.reply('Usage: op owner remove <type> <amount> <@user>\nTypes: beli, gems, bounty');

      const amountArg = args[2];
      const mention = args[3];
      const targetId = parseMention(mention);

      if (!amountArg || !targetId) {
        return message.reply('Usage: op owner remove <type> <amount> <@user>');
      }

      let target = await User.findOne({ userId: targetId });
      if (!target) {
        return message.reply('Target user does not have an account.');
      }

      const amtParsed = parseInt(amountArg, 10);
      if (isNaN(amtParsed) || amtParsed < 0) return message.reply('Amount must be a non-negative number');

      // Remove bounty amount
      if (type === 'bounty') {
        const newBounty = Math.max(100, (target.bounty || 100) - amtParsed);
        await User.findOneAndUpdate({ userId: targetId }, { bounty: newBounty });
        return message.reply(`Removed ${amtParsed} bounty from <@${targetId}>. New bounty: ${newBounty}`);
      }

      if (type === 'beli') {
        const newBalance = Math.max(0, (target.balance || 0) - amtParsed);
        await User.findOneAndUpdate({ userId: targetId }, { balance: newBalance });
        return message.reply(`Removed ¥${amtParsed} from <@${targetId}>. New balance: ¥${newBalance}`);
      }

      if (type === 'gems') {
        const newGems = Math.max(0, (target.gems || 0) - amtParsed);
        await User.findOneAndUpdate({ userId: targetId }, { gems: newGems });
        return message.reply(`Removed ${amtParsed} gem(s) from <@${targetId}>. New gems: ${newGems}`);
      }

      // Card level removal: op owner remove <cardID> <levelAmount> @user
      const _removeDef = getCardById(type);
      if (_removeDef) {
        const levelsToRemove = parseInt(amountArg, 10);
        if (isNaN(levelsToRemove) || levelsToRemove < 1) return message.reply('Level amount must be a positive number.');
        const cardEntry = (target.ownedCards || []).find(e => e.cardId === _removeDef.id);
        if (!cardEntry) return message.reply(`<@${targetId}> does not own **${_removeDef.character}**.`);
        const oldLevel = cardEntry.level || 1;
        const newLevel = Math.max(1, oldLevel - levelsToRemove);
        const removed = oldLevel - newLevel;
        cardEntry.level = newLevel;
        cardEntry.xp = 0;
        await target.save();
        return message.reply(`Removed **${removed}** level(s) from **${_removeDef.character}** for <@${targetId}>. Now at Level **${newLevel}**.`);
      }

      return message.reply('Unknown remove type; valid types are beli, gems, bounty');
    }

  if (sub === 'add') {
    const cardId = args[1];
    const levelsArg = args[2];
    const mention = args[3];
    const targetId = parseMention(mention);
    if (!cardId || !levelsArg || !targetId) return message.reply('Usage: op owner add <cardId> <levels> <@user>');
    const cardDef = getCardById(cardId);
    if (!cardDef) return message.reply(`No card with id ${formatCardId(cardId)} exists`);
    const levelsToAdd = parseInt(levelsArg, 10);
    if (isNaN(levelsToAdd) || levelsToAdd < 1) return message.reply('Level amount must be a positive number.');
    const target = await User.findOne({ userId: targetId });
    if (!target) return message.reply('Target user does not have an account.');
    const cardEntry = (target.ownedCards || []).find(e => e.cardId === cardDef.id);
    if (!cardEntry) return message.reply(`<@${targetId}> does not own **${cardDef.character}**.`);
    const { getMaxLevelForRank } = require('../utils/starLevel');
    const maxLevel = getMaxLevelForRank(cardDef.rank);
    const oldLevel = cardEntry.level || 1;
    const newLevel = Math.min(maxLevel, oldLevel + levelsToAdd);
    const added = newLevel - oldLevel;
    cardEntry.level = newLevel;
    await target.save();
    return message.reply(`Added **${added}** level(s) to **${cardDef.character}** for <@${targetId}>. Now at Level **${newLevel}**${newLevel >= maxLevel ? ' (max)' : ''}.`);
  }

  if (sub === 'resetdata') {
    const subArg = args[1];
    if (!subArg) return message.reply('Usage: op owner resetdata <@user> | op owner resetdata all');

    // Handle global reset request with confirmation
    if (subArg === 'all') {
      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      const count = await User.countDocuments();
      const embed = new EmbedBuilder()
        .setTitle('Confirm: Reset All User Data')
        .setColor(0xFF0000)
        .setDescription(`This will DELETE all user data (${count} user records). This action is irreversible. Are you sure you want to proceed?`);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('owner_reset_all:confirm')
          .setLabel('Confirm Reset All')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('owner_reset_all:cancel')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      return message.channel.send({ embeds: [embed], components: [row] });
    }

    const mention = args[1];
    const targetId = parseMention(mention);
    if (!targetId) return message.reply('Usage: op owner resetdata <@user>');

    await User.deleteOne({ userId: targetId });
    // Clear any in-memory duel state for this user (pending/active duels)
    if (duelCmd && typeof duelCmd.clearUserState === 'function') {
      duelCmd.clearUserState(targetId);
    }
    return message.reply(`Deleted data for <@${targetId}>`);
  }

  if (sub === 'setlevel') {
    // syntax: op owner setlevel <cardId> <level> <@user>
    const cardId = args[1];
    const levelArg = args[2];
    const mention = args[3];
    const targetId = parseMention(mention);
    if (!cardId || !levelArg || !targetId) return message.reply('Usage: op owner setlevel <cardId> <level> <@user>');
    const level = parseInt(levelArg, 10);
    if (isNaN(level) || level < 1) return message.reply('Level must be a positive number');
    const target = await User.findOne({ userId: targetId });
    if (!target) return message.reply('Target user does not have an account.');
    target.ownedCards = target.ownedCards || [];
    let entry = target.ownedCards.find(e => e.cardId === cardId);
    if (!entry) {
      target.ownedCards.push({ cardId, level, xp: 0 });
    } else {
      entry.level = level;
      entry.xp = entry.xp || 0;
    }
    await target.save();
    // check achievements (level 100)
    try {
    } catch (err) {
      console.error('Achievement check after setlevel failed', err);
    }
    return message.reply(`Set level of ${cardId} to ${level} for <@${targetId}>`);
  }

  if (sub === 'removecard') {
    // syntax: op owner removecard <cardId> <@user>
    const cardId = args[1];
    const mention = args[2];
    const targetId = parseMention(mention);
    if (!cardId || !targetId) return message.reply('Usage: op owner removecard <cardId> <@user>');
    const cardDef = getCardById(cardId);
    if (!cardDef) return message.reply(`No card with id ${formatCardId(cardId)} exists`);
    const target = await User.findOne({ userId: targetId });
    if (!target) return message.reply('Target user does not have an account.');
    const before = (target.ownedCards || []).length;
    target.ownedCards = (target.ownedCards || []).filter(e => e.cardId !== cardDef.id);
    target.team = (target.team || []).filter(t => t !== cardDef.id);
    target.favoriteCards = (target.favoriteCards || []).filter(c => c !== cardDef.id);
    target.wishlistCards = (target.wishlistCards || []).filter(c => c !== cardDef.id);
    target.history = (target.history || []).filter(h => h !== cardDef.id);
    await target.save();
    const removed = before - (target.ownedCards.length || 0);
    return message.reply(`Removed ${removed} copies of ${formatCardId(cardDef.id)} from <@${targetId}>`);
  }

  if (sub === 'unsetresets' || sub === 'unsetreset') {
    const { getBotConfig: _getBC, deleteBotConfig: _deleteBC } = require('../models/BotConfig');
    const resetsChannel = await _getBC('resetsChannel');
    if (!resetsChannel) {
      return message.reply('No reset notification channel is currently configured.');
    }
    await _deleteBC('resetsChannel');
    return message.reply(`Reset notifications have been disabled (was <#${resetsChannel}>).`);
  }

  if (sub === 'activeresets') {
    const { getBotConfig: _getBC } = require('../models/BotConfig');
    const single = await _getBC('resetsChannel');
    const multi = await _getBC('resetsChannels');
    const channels = [];
    if (Array.isArray(multi) && multi.length) channels.push(...multi);
    if (single) channels.push(single);
    if (!channels.length) return message.reply('No reset notification channels are configured.');
    const lines = channels.map(c => `<#${c}>`);
    return message.reply(`Active reset notification channels:\n${lines.join('\n')}`);
  }

  if (sub === 'guildlist') {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');

    const defaultFilter = 'default';
    const { embed, totalPages } = await buildGuildListEmbedAndMeta(message.client, 0, defaultFilter);

    const select = new StringSelectMenuBuilder()
      .setCustomId('guildlist_filter')
      .setPlaceholder('Sort guilds')
      .addOptions([
        { label: 'Highest to lowest members', value: 'members_desc' },
        { label: 'Latest to oldest', value: 'created_desc' },
        { label: 'Oldest to latest', value: 'created_asc' }
      ]);

    const selectRow = new ActionRowBuilder().addComponents(select);

    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`guildlist_prev:0:${defaultFilter}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`guildlist_goto:0:${defaultFilter}`).setLabel('Specific Page').setStyle(ButtonStyle.Secondary).setDisabled(totalPages <= 1),
      new ButtonBuilder().setCustomId(`guildlist_next:0:${defaultFilter}`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(totalPages <= 1)
    );

    return message.channel.send({ embeds: [embed], components: totalPages > 1 ? [selectRow, navRow] : [selectRow] });
  }

  if (sub === 'setdrops') {
    const channelMention = args[1];
    if (!channelMention) {
      return message.reply('Usage: op owner setdrops <#channel>');
    }

    // Parse channel mention (e.g., <#1234567890>)
    const channelMatch = channelMention.match(/<#(\d+)>/);
    if (!channelMatch) {
      return message.reply('Invalid channel format. Use: op owner setdrops <#channel>');
    }

    const channelId = channelMatch[1];
    const valueArg = args[2];
    let threshold = 100;
    if (valueArg) {
      const parsed = parseInt(valueArg, 10);
      if (isNaN(parsed) || parsed < 1) return message.reply('Invalid drop value. Must be a positive integer.');
      threshold = parsed;
    }
    const dropsModule = require('./drops');
    
    try {
      await dropsModule.startDropTimer(message.client, channelId, threshold);
      return message.reply(`Card drops enabled in <#${channelId}> (threshold: ${threshold})!`);
    } catch (err) {
      console.error('Error setting up drops:', err);
      return message.reply('Failed to set up drops. Make sure the bot can access that channel and that it is a text channel.');
    }
  }

  if (sub === 'setraids') {
    const channelMention = args[1];
    if (!channelMention) {
      return message.reply('Usage: op owner setraids <#channel>');
    }

    const channelMatch = channelMention.match(/<#(\d+)>/);
    if (!channelMatch) {
      return message.reply('Invalid channel format. Use: op owner setraids <#channel>');
    }

    const channelId = channelMatch[1];
    const valueArg = args[2];
    let threshold = 200;
    if (valueArg) {
      const parsed = parseInt(valueArg, 10);
      if (isNaN(parsed) || parsed < 1) return message.reply('Invalid raid value. Must be a positive integer.');
      threshold = parsed;
    }
    const raidsModule = require('./raidspawns');
    try {
      await raidsModule.startRaidTimer(message.client, channelId, threshold);
      return message.reply(`Owner raid spawns enabled in <#${channelId}> (threshold: ${threshold})!`);
    } catch (err) {
      console.error('Error setting up raid spawns:', err);
      return message.reply('Failed to set up owner raid spawns. Make sure the bot can access that channel and that it is a text channel.');
    }
  }

  if (sub === 'setresets' || sub === 'setreset') {
    // syntax: op owner setresets <#channel>
    const channelMention = args[1];
    if (!channelMention) return message.reply('Usage: op owner setresets <#channel>');
    const channelMatch = channelMention.match(/<#(\d+)>/);
    if (!channelMatch) return message.reply('Invalid channel format. Use: op owner setresets <#channel>');
    const channelId = channelMatch[1];
    const { setBotConfig: _setBC } = require('../models/BotConfig');
    await _setBC('resetsChannel', channelId);
    return message.reply(`Reset notifications will be sent to <#${channelId}>`);
  }

  if (sub === 'marketchannel') {
    const channelMention = args[1];
    if (!channelMention) return message.reply('Usage: op owner marketchannel <#channel>');
    const channelMatch = channelMention.match(/<#(\d+)>/);
    if (!channelMatch) return message.reply('Invalid channel format. Use: op owner marketchannel <#channel>');
    const channelId = channelMatch[1];
    const { setBotConfig: _setBC } = require('../models/BotConfig');
    await _setBC('marketChannel', channelId);
    return message.reply(`Market listings will be posted to <#${channelId}>`);
  }

  if (sub === 'unsetmarketchannel') {
    const { getBotConfig: _getBC, deleteBotConfig: _deleteBC } = require('../models/BotConfig');
    const existing = await _getBC('marketChannel');
    if (!existing) return message.reply('No market channel is currently configured.');
    await _deleteBC('marketChannel');
    return message.reply(`Market listing channel has been disabled (was <#${existing}>).`);
  }

  if (sub === 'activemarkets') {
    const { getBotConfig: _getBC } = require('../models/BotConfig');
    const single = await _getBC('marketChannel');
    const multi = await _getBC('marketChannels');
    const channels = [];
    if (Array.isArray(multi) && multi.length) channels.push(...multi);
    if (single) channels.push(single);
    if (!channels.length) return message.reply('No market listing channels are configured.');
    const lines = channels.map(c => `<#${c}>`);
    return message.reply(`Active market listing channels:\n${lines.join('\n')}`);
  }

  if (sub === 'setsail') {
    // syntax: op owner setsail <island> <stage> <@user>
    const islandQuery = args[1];
    const stageArg = args[2];
    const mention = args[3];
    if (!islandQuery || !stageArg || !mention) return message.reply('Usage: op owner setsail <island> <stage> <@user>');
    const targetId = parseMention(mention);
    if (!targetId) return message.reply('Invalid user mention.');
    const sailStages = require('../data/sailStages');
    const islandDef = sailStages.find(s => (s.id && s.id.toLowerCase() === islandQuery.toLowerCase()) || (s.name && s.name.toLowerCase() === islandQuery.toLowerCase()))
      || sailStages.find(s => s.name && s.name.toLowerCase().includes(islandQuery.toLowerCase()));
    if (!islandDef) return message.reply(`Island "${islandQuery}" not recognized.`);
    const stage = parseInt(stageArg, 10);
    if (isNaN(stage) || stage < 1) return message.reply('Stage must be a positive integer.');
    const maxStage = Array.isArray(islandDef.stages) && islandDef.stages.length ? islandDef.stages.length : 3;
    const capped = Math.min(stage, maxStage);
    const target = await User.findOne({ userId: targetId });
    if (!target) return message.reply('Target user does not have an account.');
    target.storyProgress = target.storyProgress || {};
    // mark completed stages up to the specified stage
    target.storyProgress[islandDef.id] = [];
    for (let i = 1; i <= capped; i++) target.storyProgress[islandDef.id].push(i);
    if (typeof target.markModified === 'function') target.markModified('storyProgress');
    await target.save();
    return message.reply(`Set story progress for <@${targetId}>: ${islandDef.id} => stage ${capped}`);
  }

  if (sub === 'setcola') {
    // syntax: op owner setcola <ship> <colaamount> <@user>
    const shipQuery = args[1];
    const colaArg = args[2];
    const mention2 = args[3];
    if (!shipQuery || !colaArg || !mention2) return message.reply('Usage: op owner setcola <ship> <colaamount> <@user>');
    const targetId2 = parseMention(mention2);
    if (!targetId2) return message.reply('Invalid user mention.');
    const { getShipById, getCardById } = require('../utils/cards');
    const shipDef = getShipById(shipQuery) || getCardById(shipQuery);
    if (!shipDef || !shipDef.ship) return message.reply(`Ship "${shipQuery}" not recognized.`);
    const cola = parseInt(colaArg, 10);
    if (isNaN(cola) || cola < 0) return message.reply('Cola amount must be a non-negative integer.');
    const tgt = await User.findOne({ userId: targetId2 });
    if (!tgt) return message.reply('Target user does not have an account.');
    tgt.ships = tgt.ships || {};
    const defaultMax = shipDef.maxCola !== undefined ? shipDef.maxCola : (shipDef.cola !== undefined ? shipDef.cola : cola);
    tgt.ships[shipDef.id] = { cola: cola, maxCola: defaultMax };
    if (typeof tgt.markModified === 'function') tgt.markModified('ships');
    await tgt.save();
    return message.reply(`Set cola for <@${targetId2}> on ship ${shipDef.id} => ${cola}`);
  }

  if (sub === 'dropparty') {
    const channelMention = args[1];
    const amountArg = args[2];
    if (!channelMention || !amountArg) return message.reply('Usage: op owner dropparty <#channel> <amount>');
    const channelMatch2 = channelMention.match(/<#(\d+)>/);
    if (!channelMatch2) return message.reply('Invalid channel format. Use: op owner dropparty <#channel> <amount>');
    const channelId = channelMatch2[1];
    const amount = parseInt(amountArg, 10);
    if (isNaN(amount) || amount < 1 || amount > 100) return message.reply('Amount must be a positive number (max 100)');
    const dropsModule = require('./drops');
    try {
      await dropsModule.spawnDrops(message.client, channelId, amount);
      return message.reply(`Dropped ${amount} cards in <#${channelId}>.`);
    } catch (err) {
      console.error('Error during dropparty:', err);
      return message.reply('Failed to perform dropparty.');
    }
  }

  

  if (sub === 'togglegamble') {
    const { getBotConfig: _getBC, setBotConfig: _setBC } = require('../models/BotConfig');
    const cur = await _getBC('ownerGambleNoCooldown');
    const next = !cur;
    await _setBC('ownerGambleNoCooldown', next);
    return message.reply(`Owner gamble cooldown bypass is now **${next ? 'ENABLED' : 'DISABLED'}**.`);
  }

  if (sub === 'toggleraid') {
    const raidCmd = require('./raid');
    const isNowOn = raidCmd.toggleRaidSoloMode();
    return message.reply(
      `Raid solo mode is now **${isNowOn ? 'ENABLED' : 'DISABLED'}**.\n` +
      (isNowOn
        ? '✅ You can now start a raid alone — no crew required, minimum 1 player.'
        : '❌ Raid solo mode off — normal crew & player requirements apply.')
    );
  }

  if (sub === 'unsetdrops') {
    const channelMention = args[1];
    if (!channelMention) return message.reply('Usage: op owner unsetdrops <#channel>');
    const channelMatch = channelMention.match(/<#(\d+)>/);
    if (!channelMatch) return message.reply('Invalid channel format. Use: op owner unsetdrops <#channel>');
    const channelId = channelMatch[1];
    const dropsModule = require('./drops');
    try {
      dropsModule.stopDropTimer(channelId);
      return message.reply(`Card drops disabled in <#${channelId}>.`);
    } catch (err) {
      console.error('Error disabling drops for channel:', err);
      return message.reply('Failed to disable drops for that channel.');
    }
  }

  if (sub === 'unsetraids') {
    const channelMention = args[1];
    if (!channelMention) return message.reply('Usage: op owner unsetraids <#channel>');
    const channelMatch = channelMention.match(/<#(\d+)>/);
    if (!channelMatch) return message.reply('Invalid channel format. Use: op owner unsetraids <#channel>');
    const channelId = channelMatch[1];
    const raidsModule = require('./raidspawns');
    try {
      raidsModule.stopRaidTimer(channelId);
      return message.reply(`Owner raid spawns disabled in <#${channelId}>.`);
    } catch (err) {
      console.error('Error disabling raid spawns for channel:', err);
      return message.reply('Failed to disable raid spawns for that channel.');
    }
  }

  if (sub === 'activedrops') {
    const dropsModule = require('./drops');
    try {
      const status = dropsModule.getDropStatus();
      const lines = [];
      if (status.configured && status.configured.length) {
        lines.push('Configured drop channels:');
        for (const ch of status.configured) {
          const prog = ch.progress || 0;
          const thresh = ch.threshold || 100;
          lines.push(`<#${ch.channelId}> — ${prog}/${thresh}`);
        }
      } else {
        lines.push('No configured drop channels.');
      }

      if (status.actives && status.actives.length) {
        lines.push('');
        lines.push('Active drops:');
        for (const a of status.actives) {
          const secs = Math.ceil((a.expiresIn || 0) / 1000);
          const mm = Math.floor(secs / 60).toString().padStart(2, '0');
          const ss = (secs % 60).toString().padStart(2, '0');
          let link = '';
          try {
            const chObj = await message.client.channels.fetch(a.channelId);
            const guildId = chObj && (chObj.guildId || (chObj.guild && chObj.guild.id));
            if (guildId) link = ` | message: https://discord.com/channels/${guildId}/${a.channelId}/${a.messageId}`;
          } catch (e) {}
          lines.push(`<#${a.channelId}> — ${a.cardName || 'unknown'} (${a.rank || ''}) — expires in ${mm}:${ss}${link}`);
        }
      }

      return message.channel.send(lines.join('\n'));
    } catch (err) {
      console.error('Error fetching active drops:', err);
      return message.reply('Failed to fetch active drops.');
    }
  }

  if (sub === 'activeraids') {
    const raidsModule = require('./raidspawns');
    try {
      const status = raidsModule.getRaidStatus();
      const lines = [];
      if (status.configured && status.configured.length) {
        lines.push('Configured raid channels:');
        for (const ch of status.configured) {
          const prog = ch.progress || 0;
          const thresh = ch.threshold || 200;
          lines.push(`<#${ch.channelId}> — ${prog}/${thresh}`);
        }
      } else {
        lines.push('No configured raid channels.');
      }

      if (status.actives && status.actives.length) {
        lines.push('');
        lines.push('Active owner raids:');
        for (const a of status.actives) {
          const secs = Math.ceil((a.expiresIn || 0) / 1000);
          const mm = Math.floor(secs / 60).toString().padStart(2, '0');
          const ss = (secs % 60).toString().padStart(2, '0');
          let link = '';
          try {
            const chObj = await message.client.channels.fetch(a.channelId);
            const guildId = chObj && (chObj.guildId || (chObj.guild && chObj.guild.id));
            if (guildId) link = ` | message: https://discord.com/channels/${guildId}/${a.channelId}/${a.messageId}`;
          } catch (e) {}
          lines.push(`<#${a.channelId}> — ${a.cardName || 'unknown'} (${a.rank || ''}) — expires in ${mm}:${ss}${link}`);
        }
      }

      return message.channel.send(lines.join('\n'));
    } catch (err) {
      console.error('Error fetching active raids:', err);
      return message.reply('Failed to fetch active raids.');
    }
  }

  if (sub === 'time') {
    const durationStr = args[1];
    if (!durationStr) {
      return message.reply('Usage: op owner time <duration> (e.g., 8h, 30m, 2d)');
    }

    // Parse duration string (e.g., "8h", "30m", "2d")
    const match = durationStr.match(/^(\d+)([hdm])$/i);
    if (!match) {
      return message.reply('Invalid duration format. Use: <number><h|m|d> (e.g., 8h, 30m, 2d)');
    }

    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    let milliseconds = 0;
    if (unit === 'h') {
      milliseconds = amount * 60 * 60 * 1000;
    } else if (unit === 'm') {
      milliseconds = amount * 60 * 1000;
    } else if (unit === 'd') {
      milliseconds = amount * 24 * 60 * 60 * 1000;
    }

    // Update pull reset time in file to simulate time passing
    const fs = require('fs');
    const path = require('path');
    const PULL_FILE = path.join(__dirname, '..', 'pull.json');

    try {
      const newTime = Date.now() - milliseconds;
      // Preserve any existing pull.json fields (e.g., resetsChannel)
      try {
        let pdata = {};
        if (fs.existsSync(PULL_FILE)) pdata = JSON.parse(fs.readFileSync(PULL_FILE, 'utf8')) || {};
        pdata.lastReset = newTime;
        fs.writeFileSync(PULL_FILE, JSON.stringify(pdata, null, 2));
      } catch (e) {
        fs.writeFileSync(PULL_FILE, JSON.stringify({ lastReset: newTime }, null, 2));
      }
      
      // Reset pulls via direct function call
      const User = require('../models/User');
      const { PULL_LIMIT } = require('../config');
      
      const lastResetDate = new Date(newTime);
      await User.updateMany({ supportServerMember: true }, { $set: { pullsRemaining: PULL_LIMIT + 1, supportBonusApplied: true, lastReset: lastResetDate } });
      await User.updateMany({ supportServerMember: { $ne: true } }, { $set: { pullsRemaining: PULL_LIMIT, supportBonusApplied: false, lastReset: lastResetDate } });
      console.log('Pulls reset');
      
      return message.reply(`⏰ Simulated ${amount}${unit.toUpperCase()} passing. Pulls reset!`);
    } catch (err) {
      console.error('Error simulating time:', err);
      return message.reply('Failed to simulate time passing.');
    }
  }

  if (sub === 'ship') {
    const mention = args[1];
    const targetId = parseMention(mention);
    if (!targetId) return message.reply('Usage: op owner ship <@user>');

    const target = await User.findOne({ userId: targetId });
    if (!target) return message.reply('Target user does not have an account.');

    if (!target.activeShip) {
      return message.reply(`<@${targetId}> does not have an active ship.`);
    }

    const { getShipById, updateShipBalance } = require('../utils/cards');
    const ship = getShipById(target.activeShip);
    if (!ship) {
      return message.reply(`<@${targetId}>'s active ship is invalid.`);
    }

    updateShipBalance(target);
    await target.save();

    const embed = new EmbedBuilder()
      .setTitle(`${ship.character}`)
      .setDescription(`**Owner:** <@${targetId}>\n**Balance:** ${target.shipBalance} <:beri:1490738445319016651>`)
      .setColor('#2b2d31');

    return message.channel.send({ embeds: [embed] });
  }

  if (sub === 'setsailstage') {
    const sailStages = require('../data/sailStages');
    const stageNumArg = args[1];
    const mention = args[2];
    const targetId = parseMention(mention);

    const globalStage = parseInt(stageNumArg, 10);
    if (isNaN(globalStage) || globalStage < 1) {
      return message.reply('Usage: op owner setsailstage <sailstagenumber> @user');
    }
    if (!targetId) {
      return message.reply('Usage: op owner setsailstage <sailstagenumber> @user');
    }

    // Build ordered island list with max stage counts from sailStages data
    const ISLAND_ORDER = ['fusha_village', 'alvidas_hideout', 'shells_town', 'orange_town', 'syrup_village', 'baratie', 'arlong_park', 'loguetown'];
    const islandInfo = ISLAND_ORDER.map(id => {
      const def = (sailStages || []).find(s => s.id === id) || {};
      return { id, maxStage: Array.isArray(def.stages) ? def.stages.length : 0 };
    });

    const totalStages = islandInfo.reduce((sum, x) => sum + x.maxStage, 0);
    if (globalStage > totalStages) {
      return message.reply(`Stage ${globalStage} is out of range. Max global stage is **${totalStages}**.`);
    }

    // Map global stage number to island index + local stage within that island
    let cumulative = 0;
    let targetIslandIdx = -1;
    let localStage = 1;
    for (let i = 0; i < islandInfo.length; i++) {
      const { maxStage } = islandInfo[i];
      if (globalStage <= cumulative + maxStage) {
        targetIslandIdx = i;
        localStage = globalStage - cumulative;
        break;
      }
      cumulative += maxStage;
    }

    if (targetIslandIdx === -1) {
      return message.reply(`Could not resolve stage ${globalStage}.`);
    }

    const target = await User.findOne({ userId: targetId });
    if (!target) return message.reply('Target user does not have an account.');

    target.storyProgress = target.storyProgress || {};

    // Mark every island before the target island as fully completed
    for (let i = 0; i < targetIslandIdx; i++) {
      const { id, maxStage } = islandInfo[i];
      const allStages = [];
      for (let s = 1; s <= maxStage; s++) allStages.push(s);
      target.storyProgress[id] = allStages;
    }

    // Target island: mark stages 1..(localStage-1) as done; localStage itself is next to play
    const targetIsland = islandInfo[targetIslandIdx];
    const completedInTarget = [];
    for (let s = 1; s < localStage; s++) completedInTarget.push(s);
    target.storyProgress[targetIsland.id] = completedInTarget;

    // Clear all islands after the target
    for (let i = targetIslandIdx + 1; i < islandInfo.length; i++) {
      target.storyProgress[islandInfo[i].id] = [];
    }

    target.markModified('storyProgress');
    await target.save();

    const islandDisplayName = targetIsland.id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return message.reply(
      `Set <@${targetId}>'s sail progress to global stage **${globalStage}** — **${islandDisplayName}**, Stage **${localStage}**.\nAll stages before it are marked complete; this stage is queued as next.`
    );
  }

  if (sub === 'setmarinesailstage') {
    const stageNum = parseInt(args[1], 10);
    const mention = args[2];
    const targetId = parseMention(mention);

    if (isNaN(stageNum) || stageNum < 1) {
      return message.reply('Usage: op owner setmarinesailstage <stage> @user');
    }
    if (!targetId) {
      return message.reply('Usage: op owner setmarinesailstage <stage> @user');
    }

    const target = await User.findOne({ userId: targetId });
    if (!target) return message.reply('Target user does not have an account.');

    target.isailProgress = stageNum;
    await target.save();

    return message.reply(`Set <@${targetId}>'s Navy Base (infinite sail) progress to stage **${stageNum}**.`);
  }

  if (sub === 'resetisail') {
    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const count = await User.countDocuments({ isailProgress: { $gt: 1 } });
    const embed = new EmbedBuilder()
      .setTitle('Confirm: Reset Navy Base Progress')
      .setColor(0xFF0000)
      .setDescription(`This will reset the Infinite Sail (Navy Base) progress back to Stage 1 for **${count}** user(s) who are past Stage 1. Are you sure?`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('owner_resetisail:confirm')
        .setLabel('Confirm Reset isail')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('owner_resetisail:cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );
    return message.channel.send({ embeds: [embed], components: [row] });
  }

  return message.reply('Unrecognized owner subcommand.');
}

async function handleButton(interaction, customId) {
  const parts = customId.split(':');
  const key = parts[0];
  const action = parts[1];

  if (key === 'guildlist_prev' || key === 'guildlist_next') {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: 'You are not permitted to use this.', ephemeral: true });
    }
    const filter = parts[2] || 'default';
    const currentPage = parseInt(action, 10) || 0;
    // Defer update quickly to avoid interaction timeout while we build invites
    try { if (global && typeof global.safeDefer === 'function') await global.safeDefer(interaction); } catch (e) {}

    // compute page bounds using a fresh guild list
    const guilds = [...interaction.client.guilds.cache.values()];
    const totalPages = Math.max(1, Math.ceil(guilds.length / PAGE_SIZE));
    const newPage = key === 'guildlist_next'
      ? Math.min(totalPages - 1, currentPage + 1)
      : Math.max(0, currentPage - 1);

    const { embed, page: clampedPage } = await buildGuildListEmbedAndMeta(interaction.client, newPage, filter);

    const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
    const select = new StringSelectMenuBuilder()
      .setCustomId('guildlist_filter')
      .setPlaceholder('Sort guilds')
      .addOptions([
        { label: 'Highest to lowest members', value: 'members_desc', default: filter === 'members_desc' },
        { label: 'Latest to oldest', value: 'created_desc', default: filter === 'created_desc' },
        { label: 'Oldest to latest', value: 'created_asc', default: filter === 'created_asc' }
      ]);

    const selectRow = new ActionRowBuilder().addComponents(select);

    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`guildlist_prev:${clampedPage}:${filter}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(clampedPage === 0),
      new ButtonBuilder().setCustomId(`guildlist_goto:${clampedPage}:${filter}`).setLabel('Specific Page').setStyle(ButtonStyle.Secondary).setDisabled(totalPages <= 1),
      new ButtonBuilder().setCustomId(`guildlist_next:${clampedPage}:${filter}`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(clampedPage >= totalPages - 1)
    );
    // If possible, edit the original message directly after deferring the interaction
    try {
      if (interaction.message && typeof interaction.message.edit === 'function') {
        await interaction.message.edit({ embeds: [embed], components: [selectRow, navRow] }).catch(() => {});
        return null;
      }
    } catch (e) {}

    if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { embeds: [embed], components: [selectRow, navRow] });
    return global.safeUpdate(interaction, { embeds: [embed], components: [selectRow, navRow] });
  }

  if (key === 'guildlist_goto') {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: 'You are not permitted to use this.', ephemeral: true });
    }
    const filter = parts[2] || 'default';
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
    const modal = new ModalBuilder()
      .setCustomId(`guildlist_goto_modal:${filter}`)
      .setTitle('Go to Guild List Page');

    const input = new TextInputBuilder()
      .setCustomId('page_number')
      .setLabel('Page number')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Enter a page number')
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (key === 'owner_resetisail') {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: 'You are not permitted to run owner commands.', ephemeral: true });
    }
    if (action === 'cancel') {
      return global.safeUpdate(interaction, { content: 'Reset cancelled.', embeds: [], components: [] });
    }
    if (action === 'confirm') {
      await interaction.update({ content: 'Resetting Navy Base progress for all users...', embeds: [], components: [] });
      try {
        const result = await User.updateMany({ isailProgress: { $gt: 1 } }, { $set: { isailProgress: 1 } });
        return interaction.followUp({ content: `Done! Reset Navy Base progress to Stage 1 for **${result.modifiedCount}** user(s).` });
      } catch (err) {
        console.error('Error resetting isail progress:', err);
        return interaction.followUp({ content: 'Failed to reset isail progress. Check server logs.', ephemeral: true });
      }
    }
    return;
  }

  if (key !== 'owner_reset_all') return;

  // Permission guard
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: 'You are not permitted to run owner commands.', ephemeral: true });
  }

  if (action === 'confirm') {
    await interaction.update({ content: 'Resetting all user data... This may take a moment.', embeds: [], components: [] });

    // Perform destructive action
    let res;
    try {
      res = await User.deleteMany({});
    } catch (err) {
      console.error('Error deleting all users:', err);
      return interaction.followUp({ content: 'Failed to delete user data. Check server logs.', ephemeral: true });
    }

    // Try clearing in-memory state where possible
    try {
      if (duelCmd && typeof duelCmd.clearAllStates === 'function') duelCmd.clearAllStates();
    } catch (err) {
      console.warn('duelCmd.clearAllStates failed', err);
    }
    if (global.badgeSessions && typeof global.badgeSessions.clear === 'function') global.badgeSessions.clear();
    if (global.packSessions && typeof global.packSessions.clear === 'function') global.packSessions.clear();
    if (global.packInfoSessions && typeof global.packInfoSessions.clear === 'function') global.packInfoSessions.clear();
    if (global.duelStates && typeof global.duelStates.clear === 'function') global.duelStates.clear();
    if (global.pendingDuelRequests && typeof global.pendingDuelRequests.clear === 'function') global.pendingDuelRequests.clear();

    return interaction.followUp({ content: `Deleted ${res.deletedCount || 'all'} user records.` });
  }

  // cancel
  return global.safeUpdate(interaction, { content: 'Reset cancelled.', embeds: [], components: [] });
}

async function handleSelect(interaction) {
  if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'You are not permitted to use this.', ephemeral: true });
  // acknowledge quickly to avoid timeout while we build invites
  try { if (global && typeof global.safeDefer === 'function') await global.safeDefer(interaction); } catch (e) {}
  const selected = (interaction.values && interaction.values[0]) || 'default';
  const { embed, totalPages, page } = await buildGuildListEmbedAndMeta(interaction.client, 0, selected);
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
  const select = new StringSelectMenuBuilder()
    .setCustomId('guildlist_filter')
    .setPlaceholder('Sort guilds')
    .addOptions([
      { label: 'Highest to lowest members', value: 'members_desc', default: selected === 'members_desc' },
      { label: 'Latest to oldest', value: 'created_desc', default: selected === 'created_desc' },
      { label: 'Oldest to latest', value: 'created_asc', default: selected === 'created_asc' }
    ]);

  const selectRow = new ActionRowBuilder().addComponents(select);
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`guildlist_prev:${page}:${selected}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`guildlist_goto:${page}:${selected}`).setLabel('Specific Page').setStyle(ButtonStyle.Secondary).setDisabled(totalPages <= 1),
    new ButtonBuilder().setCustomId(`guildlist_next:${page}:${selected}`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages - 1)
  );
  // Edit the original message directly if possible (we deferred earlier)
  try {
    if (interaction.message && typeof interaction.message.edit === 'function') {
      await interaction.message.edit({ embeds: [embed], components: [selectRow, navRow] }).catch(() => {});
      return null;
    }
  } catch (e) {}

  if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { embeds: [embed], components: [selectRow, navRow] });
  return global.safeUpdate(interaction, { embeds: [embed], components: [selectRow, navRow] });
}

async function handleModal(interaction) {
  const parts = interaction.customId.split(':');
  const filter = parts[1] || 'default';
  const originalMessageId = parts[2] || '';
  if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'You are not permitted to use this.', ephemeral: true });
  const pageStr = interaction.fields.getTextInputValue('page_number') || '';
  const requested = parseInt(pageStr, 10);
  if (isNaN(requested) || requested < 1) {
    return interaction.reply({ content: 'Invalid page number.', ephemeral: true });
  }
  const pageIndex = requested - 1;
  // Defer reply so we have time to fetch and edit the original message
  try { await interaction.deferReply({ ephemeral: true }); } catch (e) {}
  const { embed, totalPages, page: clampedPage } = await buildGuildListEmbedAndMeta(interaction.client, pageIndex, filter);
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
  const select = new StringSelectMenuBuilder()
    .setCustomId('guildlist_filter')
    .setPlaceholder('Sort guilds')
    .addOptions([
      { label: 'Highest to lowest members', value: 'members_desc', default: filter === 'members_desc' },
      { label: 'Latest to oldest', value: 'created_desc', default: filter === 'created_desc' },
      { label: 'Oldest to latest', value: 'created_asc', default: filter === 'created_asc' }
    ]);

  const selectRow = new ActionRowBuilder().addComponents(select);
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`guildlist_prev:${clampedPage}:${filter}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(clampedPage === 0),
    new ButtonBuilder().setCustomId(`guildlist_goto:${clampedPage}:${filter}`).setLabel('Specific Page').setStyle(ButtonStyle.Secondary).setDisabled(totalPages <= 1),
    new ButtonBuilder().setCustomId(`guildlist_next:${clampedPage}:${filter}`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(clampedPage >= totalPages - 1)
  );

  // Try to edit the original message if we have its id (modal can't directly update original message)
  try {
    if (originalMessageId && interaction.channel) {
      const target = await interaction.channel.messages.fetch(originalMessageId).catch(() => null);
      if (target) await target.edit({ embeds: [embed], components: [selectRow, navRow] }).catch(() => {});
    }
  } catch (e) {}

  return interaction.editReply({ content: `Jumped to page ${clampedPage + 1}`, ephemeral: true });
}

module.exports = { list, execute, handleButton, handleSelect, handleModal };
