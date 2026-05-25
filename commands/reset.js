const User = require('../models/User');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { PULL_LIMIT } = require('../config');
const stockModule = require('../src/stock');
const { cards } = require('../data/cards');
const { getMaxStarForRank } = require('../utils/starLevel');

const SPECIAL_PULL_CARD_IDS = ['4162', '4037', '3786'];

function getCardExtras(user) {
  let extras = 0;
  const owned = user.ownedCards || [];
  for (const cid of SPECIAL_PULL_CARD_IDS) {
    const entry = owned.find(e => e.cardId === cid);
    if (entry) {
      const def = cards.find(c => c.id === cid);
      const maxStar = def ? getMaxStarForRank(def.rank) : 7;
      if ((entry.starLevel || 0) >= maxStar) extras += 1;
    }
  }
  return extras;
}

function findItemCount(items, itemId) {
  if (!Array.isArray(items)) return 0;
  const it = items.find(i => i.itemId === itemId);
  return it ? (it.quantity || 0) : 0;
}

function removeItem(items, itemId, count) {
  if (!Array.isArray(items) || count <= 0) return items;
  const idx = items.findIndex(i => i.itemId === itemId);
  if (idx === -1) return items;
  items[idx].quantity = (items[idx].quantity || 0) - count;
  if (items[idx].quantity <= 0) items.splice(idx, 1);
  return items;
}

module.exports = {
  name: 'reset',
  description: 'Reset various timers using tokens (type: pull, stock, bounty, trivia, loot, coin, god)',
  options: [
    { name: 'type', type: 3, description: 'Which timer to reset (pull, stock, bounty, trivia, loot, coin, god)', required: false }
  ],

  async execute({ message, interaction, args }) {
    const userId = message ? message.author.id : interaction.user.id;
    const username = message ? message.author.username : interaction.user.username;
    let user = await User.findOne({ userId });
    if (!user) {
      const reply = 'You don\'t have an account. Run `op start` or /start to register.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // determine requested type
    let typeRaw = null;
    if (interaction) typeRaw = interaction.options.getString('type');
    if (!typeRaw && message && Array.isArray(args) && args.length > 0) typeRaw = args[0];
    const type = typeRaw ? String(typeRaw).toLowerCase() : 'pull';

    if (type === 'daily') {
      const reply = 'op reset daily is not a valid command.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // GOD reset (consumes god_token item)
    if (type === 'god' || type === 'greset' || type === 'godreset') {
      const have = findItemCount(user.items || [], 'god_token');
      if (have <= 0) {
        const reply = 'You do not have any God Tokens.';
        if (message) return message.reply(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }

      // consume one god token
      user.items = removeItem(user.items || [], 'god_token', 1);

      // reset user timers (except daily)
      user.bountyCooldownUntil = null;
      user.triviaCooldownUntil = null;
      user.lootCooldownUntil = null;
      user.betCooldownUntil = null;
      user.gambleCooldownUntil = null;
      user.activeBountyTarget = null;
      // reset pulls for this user (honor support server membership + special card bonuses)
      user.pullsRemaining = PULL_LIMIT + (user.supportServerMember ? 1 : 0) + getCardExtras(user);
      user.lastReset = new Date();
      await user.save();

      const reply = 'Successfully used a **God Token**! All cooldowns and pulls have been reset.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply });
    }

    // For non-god resets, require a normal reset token (resetTokens)
    if (!user.resetTokens || user.resetTokens <= 0) {
      const reply = 'You don\'t have any **reset tokens**.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // Handle pull reset (default)
    if (type === 'pull' || !type) {
      // If pulls remaining, show confirmation with buttons
      if (user.pullsRemaining > 0 && message) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`reset_confirm:${userId}:yes`)
            .setLabel('Yes, Use Token')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`reset_confirm:${userId}:no`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
        );

        const confirmMsg = `You have ${user.pullsRemaining} Pulls left. Are you sure you want to use a **Reset Token**?`;
        return message.reply({ content: confirmMsg, components: [row] });
      }

      // Use token directly
      user.resetTokens -= 1;
      user.pullsRemaining = PULL_LIMIT + (user.supportServerMember ? 1 : 0) + getCardExtras(user);
      user.gems = (user.gems || 0) + 1;
      user.lastReset = new Date();
      await user.save();

      const reply = `Successfully used a **Reset Token**! Pull count has been reset.`;
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply });
    }

    // Stock reset: only affects this user's per-pack purchase counts (not global stock)
    if (type === 'stock') {
      user.resetTokens -= 1;
      user.packInventory = {};
      user.markModified('packInventory');
      await user.save();
      const reply = 'Your pack purchase counts have been reset for your account.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply });
    }

    // Bounty / Trivia / Loot / Coin resets
    if (type === 'bounty') {
      user.resetTokens -= 1;
      user.bountyCooldownUntil = null;
      user.activeBountyTarget = null;
      await user.save();
      const reply = 'Bounty cooldown reset.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply });
    }

    if (type === 'trivia') {
      const reply = 'Reset tokens cannot reset the trivia cooldown.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    if (type === 'gamble' || type === 'gambling' || type === 'casino') {
      user.resetTokens -= 1;
      user.gambleCooldownUntil = null;
      await user.save();
      const reply = 'Gambling cooldown reset.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply });
    }

    if (type === 'loot') {
      user.resetTokens -= 1;
      user.lootCooldownUntil = null;
      await user.save();
      const reply = 'Loot cooldown reset.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply });
    }

    if (type === 'coin' || type === 'bet') {
      user.resetTokens -= 1;
      user.betCooldownUntil = null;
      await user.save();
      const reply = 'Coin/bet cooldown reset.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply });
    }

    // Unknown type
    const reply = 'Unknown reset type. Valid: pull, stock, bounty, loot, coin, gamble, god';
    if (message) return message.reply(reply);
    return interaction.reply({ content: reply, ephemeral: true });
  },

  async handleButton(interaction, rawArg) {
    const parts = rawArg.split(':');
    const ownerId = parts.length >= 2 ? parts[0] : null;
    const action = parts.length >= 2 ? parts[1] : parts[0];
    if (ownerId && interaction.user.id !== ownerId) {
      return interaction.reply({ content: 'This confirmation is not for you.', ephemeral: true });
    }
    const userId = interaction.user.id;
    const confirmed = action === 'yes';

    if (confirmed) {
      let user = await User.findOne({ userId });
      if (!user || user.resetTokens <= 0) {
        return interaction.reply({ content: 'Could not use reset token.', ephemeral: true });
      }

      user.resetTokens -= 1;
      user.pullsRemaining = PULL_LIMIT + (user.supportServerMember ? 1 : 0) + getCardExtras(user);
      user.gems = (user.gems || 0) + 1;
      user.lastReset = new Date();
      await user.save();

      if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { content: `Successfully used a **Reset Token**! Pull count has been reset. You gained **1 Gem**.`, components: [] });
      return global.safeUpdate(interaction, { content: `Successfully used a **Reset Token**! Pull count has been reset. You gained **1 Gem**.`, components: [] });
    }

    if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { content: 'Reset token use cancelled.', components: [] });
    return global.safeUpdate(interaction, { content: 'Reset token use cancelled.', components: [] });
  }
};
