const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { getCurrentStock, getStockCountdownString, getPricing, ensureStockUpToDate, getNextStockResetDate } = require('../src/stock');
const User = require('../models/User');
const { tryAcquire } = require('../utils/heavyCommandCooldown');

const RANK_COLORS = {
  D: '#F7FBFF',
  C: '#EBF3FF',
  B: '#D6E5FF',
  A: '#B8D0FF',
  S: '#8AA6FF',
  SS: '#5E7CFF',
  UR: '#2B4EBF'
};

function formatStockDescription(stock) {
  const lines = stock.map((pack, index) => {
    const price = getPricing()[pack.rank] || 0;
    return `**${index + 1}.** ${pack.quantity}x **${pack.icon} ${pack.name}** · \`${price} gems\``;
  });

  return `Click a button below to buy one pack!\n\n${lines.join('\n')}`;
}

function buildStockEmbed(stock, countdown, resetTimestamp, hasImage = true) {
  const color = stock.length ? RANK_COLORS[stock[0].rank] || '#1E40AF' : '#1E40AF';
  const description = formatStockDescription(stock);
  const embed = new EmbedBuilder()
    .setColor(color)
    .setDescription(description)
    .setFooter({ text: `Resets in ${countdown}` });

  if (hasImage) {
    embed.setImage('attachment://stock.png');
  }

  if (resetTimestamp) {
    embed.setTimestamp(resetTimestamp);
  }

  return embed;
}

function buildStockRow(stock, userId) {
  const row = new ActionRowBuilder();
  stock.forEach((pack, index) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`stock_buy:${userId}:${index}`)
        .setLabel(`${index + 1}`)
        .setStyle(pack.quantity > 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(pack.quantity <= 0)
    );
  });
  return row;
}

async function createStockImage(stock) {
  // Dimensions for the full landscape canvas
  const imageWidth = 200; // width of each pack image in pixels
  const imageHeight = 300; // height of each pack image in pixels
  const padding = 0; // padding around the edges and between pack images in pixels
  const packCount = Math.min(stock.length, 3); // number of packs to render

  // Canvas width = left padding + pack widths + spaces between packs + right padding
  const width = padding + packCount * imageWidth + (packCount - 1) * padding + padding;
  // Canvas height = top padding + pack height + bottom padding
  const height = padding + imageHeight + padding;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background rectangle covers the full canvas from (0, 0) to (width, height)
  ctx.fillStyle = '#2f3136';
  ctx.fillRect(0, 0, width, height);

  // Load images in parallel
  const imagePromises = stock.slice(0, packCount).map(async (pack) => {
    if (pack.packImage && pack.packImage.trim()) {
      try {
        const controller = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? null
          : new AbortController();
        const response = await fetch(pack.packImage, {
          method: 'GET',
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: controller ? controller.signal : AbortSignal.timeout(10000)
        });
        if (controller) {
          setTimeout(() => controller.abort(), 10000);
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        return await loadImage(buffer);
      } catch (err) {
        console.warn(`Stock pack image unavailable for ${pack.name}: ${err?.message || err}`);
        return null;
      }
    }
    return null;
  });

  const images = await Promise.all(imagePromises);

  // Draw each pack image side by side
  for (let index = 0; index < packCount; index++) {
    const pack = stock[index];
    const image = images[index];

    // X, Y position for the current pack image
    const x = padding + index * (imageWidth + padding); // pack X position
    const y = padding; // pack Y position (same for all packs)

    if (image) {
      // Draw the booster pack image at the specified position and size
      ctx.drawImage(image, x, y, imageWidth, imageHeight);
    } else {
      // Fallback placeholder if image fails to load
      ctx.fillStyle = '#4b4f57';
      ctx.fillRect(x, y, imageWidth, imageHeight);
      ctx.fillStyle = '#ffffff';
      ctx.font = '14px sans-serif';
      ctx.fillText(pack.name, x + 10, y + 20);
    }
  }

  return canvas.toBuffer('image/png');
}

function getStockResetTimestamp() {
  return getNextStockResetDate();
}

module.exports = {
  name: 'stock',
  description: 'View current pack stock',
  async execute({ message, interaction }) {
    // Enforce 10s per-user cooldown across heavy commands
    const userId = message ? message.author.id : interaction.user.id;
    if (!tryAcquire(userId)) {
      const errMsg = 'Please wait a moment before running this command again.';
      if (message) {
        try {
          const m = await message.reply(errMsg);
          setTimeout(() => m.delete().catch(() => {}), 5000);
        } catch (e) {}
        return;
      }
      return interaction.reply({ content: errMsg, ephemeral: true });
    }

    ensureStockUpToDate();
    const globalStock = getCurrentStock().slice(0, 3);
    let stock = globalStock;
    // show per-user local stock when possible (do not decrement global stock on buy)
    let user = null;
    try {
      user = await User.findOne({ userId: message ? message.author.id : interaction.user.id });
    } catch (err) {
      user = null;
    }
    if (user && user.localStock) {
      stock = globalStock.map(p => {
        const qty = typeof user.localStock[p.name] !== 'undefined' ? user.localStock[p.name] : p.quantity;
        return { ...p, quantity: qty };
      });
    }

    if (!stock.length) {
      const reply = 'No stock is available right now.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const countdown = getStockCountdownString();
    const resetTimestamp = getStockResetTimestamp();
    const content = 'here is the current pack stock!';

    if (message) {
      // Message-based invocation: send synchronously
      const imageBuffer = await createStockImage(stock);
      const attachment = new AttachmentBuilder(imageBuffer, { name: 'stock.png' });
      const embed = buildStockEmbed(stock, countdown, resetTimestamp, true);
      const row = buildStockRow(stock, userId);
      return message.channel.send({ content, embeds: [embed], components: [row], files: [attachment] });
    }

    // Interaction-based invocation: defer reply to avoid timeouts and show a fast acknowledgement
    await interaction.deferReply();
    let imageBuffer = null;
    let attachment = null;
    try {
      imageBuffer = await createStockImage(stock);
      attachment = new AttachmentBuilder(imageBuffer, { name: 'stock.png' });
    } catch (err) {
      console.error('[stock] createStockImage failed:', err && err.message ? err.message : err);
    }
    const embed = buildStockEmbed(stock, countdown, resetTimestamp, !!attachment);
    const row = buildStockRow(stock, userId);

    // Edit the deferred reply with the stock embed (with or without attachment)
    if (attachment) {
      return interaction.editReply({ content, embeds: [embed], components: [row], files: [attachment] });
    }
    return interaction.editReply({ content, embeds: [embed], components: [row] });
  },

  async handleButton(interaction, fullCustomId) {
    ensureStockUpToDate();
    const globalStock = getCurrentStock().slice(0, 3);
    const parts = fullCustomId.split(':');
    const ownerId = parts[1];
    const index = Number(parts[2]);
    if (ownerId && interaction.user.id !== ownerId) {
      return interaction.reply({ content: 'This stock menu is not for you. Run `op stock` to open your own.', ephemeral: true });
    }
    if (Number.isNaN(index) || index < 0 || index >= globalStock.length) {
      return interaction.reply({ content: 'Invalid pack selection.', ephemeral: true });
    }

    const pack = globalStock[index];
    if (pack.quantity <= 0) {
      return interaction.reply({ content: 'That pack is sold out.', ephemeral: true });
    }

    const userId = interaction.user.id;
    let user = await User.findOne({ userId });
    if (!user) {
      return interaction.reply({ content: 'You need an account first – run `op start` or /start.', ephemeral: true });
    }

    const price = getPricing()[pack.rank] || 0;
    if ((user.gems || 0) < price) {
      return interaction.reply({ content: `You need **${price}** Gems to buy ${pack.icon} **${pack.name}**.`, ephemeral: true });
    }

    // Ensure per-user localStock key exists (set it if missing)
    user.localStock = user.localStock || {};
    if (typeof user.localStock[pack.name] === 'undefined') {
      const match = globalStock.find(s => s.name === pack.name);
      const defaultQty = match ? (match.quantity || 0) : (pack.quantity || 0);
      await User.updateOne({ userId, [`localStock.${pack.name}`]: { $exists: false } }, { $set: { [`localStock.${pack.name}`]: defaultQty } }).catch(() => {});
    }

    // Perform atomic purchase: ensure gems and localStock available then decrement and increment packInventory
    const upd = await User.updateOne(
      { userId, gems: { $gte: price }, [`localStock.${pack.name}`]: { $gte: 1 } },
      { $inc: { gems: -price, [`packInventory.${pack.name}`]: 1, [`localStock.${pack.name}`]: -1 } }
    );

    if (!upd || upd.modifiedCount === 0) {
      // Reload user to give a better error message
      const fresh = await User.findOne({ userId });
      if (!fresh || (fresh.gems || 0) < price) {
        return interaction.reply({ content: `You need **${price}** Gems to buy ${pack.icon} **${pack.name}**.`, ephemeral: true });
      }
      if (!fresh.localStock || (fresh.localStock[pack.name] || 0) < 1) {
        return interaction.reply({ content: `Not enough stock remaining for ${pack.name} packs.`, ephemeral: true });
      }
      return interaction.reply({ content: 'Purchase failed due to a concurrent update. Please try again.', ephemeral: true });
    }

    const updatedGlobal = getCurrentStock().slice(0, 3);
    const freshUser = await User.findOne({ userId });
    const updatedStock = (freshUser && freshUser.localStock) ? updatedGlobal.map(p => {
      const qty = typeof freshUser.localStock[p.name] !== 'undefined' ? freshUser.localStock[p.name] : p.quantity;
      return { ...p, quantity: qty };
    }) : updatedGlobal;

    const countdown = getStockCountdownString();
    const resetTimestamp = getStockResetTimestamp();
    const stockOwnerId = ownerId || userId;
    // Acknowledge the button interaction quickly to avoid "Unknown interaction" errors
    try {
      await interaction.deferUpdate();
    } catch (err) {
      console.warn('[stock] interaction.deferUpdate failed (continuing):', err && err.message ? err.message : err);
    }

    let imageBuffer = null;
    let attachment = null;
    try {
      imageBuffer = await createStockImage(updatedStock);
      attachment = new AttachmentBuilder(imageBuffer, { name: 'stock.png' });
    } catch (err) {
      console.error('[stock] createStockImage failed after buy:', err && err.message ? err.message : err);
    }

    const embed = buildStockEmbed(updatedStock, countdown, resetTimestamp, !!attachment);
    const row = buildStockRow(updatedStock, stockOwnerId);

    // Try to edit the original message using the bot token (safer than
    // relying on the interaction token which can expire when uploading files).
    try {
      let edited = false;

      // Prefer fetching the message via the channel and editing that instance
      // (this uses the bot token and is resilient to interaction token expiry).
      if (interaction.channel && interaction.message && interaction.message.id) {
        const msg = await interaction.channel.messages.fetch(interaction.message.id).catch(() => null);
        if (msg && typeof msg.edit === 'function') {
          if (attachment) await msg.edit({ content: 'here is the current pack stock!', embeds: [embed], components: [row], files: [attachment] });
          else await msg.edit({ content: 'here is the current pack stock!', embeds: [embed], components: [row] });
          edited = true;
        }
      }

      // Fallback to the cached interaction.message.edit (may use webhook token).
      if (!edited && interaction.message && typeof interaction.message.edit === 'function') {
        if (attachment) await interaction.message.edit({ content: 'here is the current pack stock!', embeds: [embed], components: [row], files: [attachment] });
        else await interaction.message.edit({ content: 'here is the current pack stock!', embeds: [embed], components: [row] });
        edited = true;
      }

      // Final fallback: send a fresh channel message
      if (!edited) {
        if (attachment) await interaction.channel.send({ content: 'here is the current pack stock!', embeds: [embed], components: [row], files: [attachment] });
        else await interaction.channel.send({ content: 'here is the current pack stock!', embeds: [embed], components: [row] });
      }
    } catch (err) {
      console.error('[stock] Failed to update stock message after purchase:', err && err.message ? err.message : err);
      try { await interaction.followUp({ content: `You bought 1x ${pack.icon} **${pack.name}** for **${price} gems**!`, ephemeral: true }); } catch(e){ console.warn('[stock] followUp after failed edit also failed:', e && e.message ? e.message : e); }
      return;
    }

    try {
      await interaction.followUp({ content: `You bought 1x ${pack.icon} **${pack.name}** for **${price} gems**!`, ephemeral: true });
    } catch (err) {
      console.warn('[stock] followUp failed:', err && err.message ? err.message : err);
    }
    return;
  }
};