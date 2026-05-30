const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const User = require('../models/User');
const MarketListing = require('../models/MarketListing');
const { searchCards, getCardById, formatCardId } = require('../utils/cards');
const { getMaxStarForRank } = require('../utils/starLevel');

const PAGE_SIZE = 10;
const BELI_EMOJI = '<:beri:1490738445319016651>';

const RANK_EMOJIS = {
  D: '<:Drank:1505618722205732894>',
  C: '<:Crank:1505619117544312993>',
  B: '<:Brank:1505619119201058926>',
  A: '<:Arank:1505618730594472187>',
  S: '<:Srank:1505618732247023676>',
  SS: '<:SSrank:1505618733349994516>',
  UR: '<:URrank:1505618734503559429>',
};

const RANK_EMOJI_IDS = {
  D: '1505618722205732894',
  C: '1505619117544312993',
  B: '1505619119201058926',
  A: '1505618730594472187',
  S: '1505618732247023676',
  SS: '1505618733349994516',
  UR: '1505618734503559429',
};

const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      page: 0,
      filterRank: null,
      filterAttr: null,
      filterStar: null,
      isSearch: false,
      searchQuery: null,
      searchCardIds: null,
      messageId: null,
      channelId: null,
    });
  }
  return sessions.get(userId);
}

async function fetchListings(session) {
  const now = new Date();
  const query = { expiresAt: { $gt: now } };

  if (session.isSearch && session.searchCardIds && session.searchCardIds.length) {
    query.cardId = { $in: session.searchCardIds };
  } else {
    if (session.filterRank) query.cardRank = session.filterRank;
    if (session.filterAttr) query.cardAttribute = session.filterAttr;
    if (session.filterStar !== null && session.filterStar !== undefined) query.starLevel = session.filterStar;
  }

  const total = await MarketListing.countDocuments(query);
  const listings = await MarketListing.find(query)
    .sort({ createdAt: -1 })
    .skip(session.page * PAGE_SIZE)
    .limit(PAGE_SIZE);

  return { listings, total };
}

function formatPrice(price) {
  return price.toLocaleString('en-US').replace(/,/g, "'");
}

function buildMarketEmbed(listings, session, total) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const embed = new EmbedBuilder()
    .setColor('#ffffff')
    .setTitle('Marketplace')
    .setFooter({ text: `Page ${session.page + 1} of ${totalPages} | Total: ${total} listings` });

  const filterParts = [];
  if (session.isSearch && session.searchQuery) filterParts.push(`Search: "${session.searchQuery}"`);
  if (session.filterRank) filterParts.push(`Rank: ${session.filterRank}`);
  if (session.filterAttr) filterParts.push(`Attribute: ${session.filterAttr}`);
  if (session.filterStar !== null && session.filterStar !== undefined) filterParts.push(`Stars: ${session.filterStar === 0 ? 'None' : session.filterStar}`);
  if (filterParts.length) embed.setDescription(`*Filters: ${filterParts.join(' | ')}*`);

  if (!listings.length) {
    embed.setDescription((filterParts.length ? `*Filters: ${filterParts.join(' | ')}*\n\n` : '') + 'No listings found.');
    return embed;
  }

  for (const listing of listings) {
    const cardEmoji = listing.cardEmoji ? listing.cardEmoji + ' ' : '';
    let starStr = '';
    if (typeof listing.starLevel === 'number' && listing.starLevel > 0) {
      const maxStar = getMaxStarForRank(listing.cardRank || 'D');
      if (listing.starLevel >= maxStar) {
        starStr = ' <:MAXstarlevel:1505618736516825180>';
      }
    }
    const priceStr = formatPrice(listing.price);

    embed.addFields({
      name: `${cardEmoji}${listing.cardName}${starStr} (Lvl. ${listing.level})`,
      value: `\`ID: ${formatCardId(listing.cardId)}\` | ${priceStr} ${BELI_EMOJI}`,
      inline: false,
    });
  }

  return embed;
}

function buildMarketComponents(listings, session, total, userId) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const rankRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`market_rank:${userId}`)
      .setPlaceholder('Filter by rank')
      .addOptions([
        { label: 'All ranks', value: 'all', default: !session.filterRank },
        { label: 'D rank', value: 'D', emoji: { id: RANK_EMOJI_IDS.D }, default: session.filterRank === 'D' },
        { label: 'C rank', value: 'C', emoji: { id: RANK_EMOJI_IDS.C }, default: session.filterRank === 'C' },
        { label: 'B rank', value: 'B', emoji: { id: RANK_EMOJI_IDS.B }, default: session.filterRank === 'B' },
        { label: 'A rank', value: 'A', emoji: { id: RANK_EMOJI_IDS.A }, default: session.filterRank === 'A' },
        { label: 'S rank', value: 'S', emoji: { id: RANK_EMOJI_IDS.S }, default: session.filterRank === 'S' },
        { label: 'SS rank', value: 'SS', emoji: { id: RANK_EMOJI_IDS.SS }, default: session.filterRank === 'SS' },
        { label: 'UR rank', value: 'UR', emoji: { id: RANK_EMOJI_IDS.UR }, default: session.filterRank === 'UR' },
      ])
  );

  const attrRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`market_attr:${userId}`)
      .setPlaceholder('Filter by attribute')
      .addOptions([
        { label: 'All attributes', value: 'all', default: !session.filterAttr },
        { label: 'STR', value: 'STR', default: session.filterAttr === 'STR' },
        { label: 'DEX', value: 'DEX', default: session.filterAttr === 'DEX' },
        { label: 'QCK', value: 'QCK', default: session.filterAttr === 'QCK' },
        { label: 'INT', value: 'INT', default: session.filterAttr === 'INT' },
        { label: 'PSY', value: 'PSY', default: session.filterAttr === 'PSY' },
      ])
  );

  const starRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`market_star:${userId}`)
      .setPlaceholder('Filter by star level')
      .addOptions([
        { label: 'All star levels', value: 'all', default: session.filterStar === null || session.filterStar === undefined },
        { label: '1 star', value: '1', default: session.filterStar === 1 },
        { label: '2 stars', value: '2', default: session.filterStar === 2 },
        { label: '3 stars', value: '3', default: session.filterStar === 3 },
        { label: '4 stars', value: '4', default: session.filterStar === 4 },
        { label: '5 stars', value: '5', default: session.filterStar === 5 },
        { label: '6 stars', value: '6', default: session.filterStar === 6 },
        { label: '7 stars', value: '7', default: session.filterStar === 7 },
      ])
  );

  const cardOptions = listings.map(listing => {
    const priceStr = formatPrice(listing.price);
    let starStr = '';
    if (typeof listing.starLevel === 'number' && listing.starLevel > 0) {
      const maxStar = getMaxStarForRank(listing.cardRank || 'D');
      if (listing.starLevel >= maxStar) starStr = ' <:MAXstarlevel:1505618736516825180>';
    }
    const label = `${listing.cardName}${starStr} (Lvl. ${listing.level}) — ${priceStr} beli`.slice(0, 100);
    const desc = `ID: ${formatCardId(listing.cardId)} | Seller: ${listing.sellerName}`.slice(0, 100);
    const opt = { label, description: desc, value: listing._id.toString() };
    if (RANK_EMOJI_IDS[listing.cardRank]) opt.emoji = { id: RANK_EMOJI_IDS[listing.cardRank] };
    return opt;
  });

  const chooseRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`market_buy:${userId}`)
      .setPlaceholder('Choose a card to buy')
      .setDisabled(!cardOptions.length)
      .addOptions(cardOptions.length ? cardOptions : [{ label: 'No listings on this page', value: 'none' }])
  );

  const isSearch = !!session.isSearch;
  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`market_prev:${userId}`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(session.page <= 0),
    new ButtonBuilder()
      .setCustomId(`market_next:${userId}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(session.page >= totalPages - 1),
    isSearch
      ? new ButtonBuilder()
          .setCustomId(`market_back:${userId}`)
          .setLabel('Back')
          .setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder()
          .setCustomId(`market_search:${userId}`)
          .setLabel('Search')
          .setStyle(ButtonStyle.Secondary)
  );

  return [rankRow, attrRow, starRow, chooseRow, btnRow];
}

async function renderMarket(target, userId, session, isUpdate = false) {
  const { listings, total } = await fetchListings(session);
  const embed = buildMarketEmbed(listings, session, total);
  const components = buildMarketComponents(listings, session, total, userId);

  if (isUpdate && target && typeof target.editReply === 'function') {
    if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(target, { embeds: [embed], components });
    try { return target.editReply({ embeds: [embed], components }); } catch (e) {}
  }
  if (target && typeof target.update === 'function') {
    if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(target, { embeds: [embed], components });
    try { return target.update({ embeds: [embed], components }); } catch (e) {}
  }
  if (target && typeof target.reply === 'function') {
    if (global && typeof global.safeReply === 'function') return global.safeReply(target, { embeds: [embed], components });
    try { return target.reply({ embeds: [embed], components }); } catch (e) {}
  }
  if (target && typeof target.edit === 'function') {
    try { return target.edit({ embeds: [embed], components }); } catch (e) {}
  }
  return null;
}

const MARKET_RANKS = new Set(['D', 'C', 'B', 'A', 'S', 'SS', 'UR']);
const MARKET_ATTRS = { str: 'STR', dex: 'DEX', qck: 'QCK', int: 'INT', psy: 'PSY' };

function parseMarketArgs(args) {
  let filterRank = null, filterAttr = null, filterStar = null;
  for (const arg of (args || [])) {
    const upper = arg.toUpperCase();
    if (MARKET_RANKS.has(upper)) { filterRank = upper; continue; }
    if (MARKET_ATTRS[arg.toLowerCase()]) { filterAttr = MARKET_ATTRS[arg.toLowerCase()]; continue; }
    const n = parseInt(arg, 10);
    if (!isNaN(n) && n >= 1 && n <= 7) { filterStar = n; continue; }
  }
  return { filterRank, filterAttr, filterStar };
}

async function execute({ message, interaction, args }) {
  const userId = message ? message.author.id : interaction.user.id;
  const session = getSession(userId);
  session.page = 0;
  session.filterRank = null;
  session.filterAttr = null;
  session.filterStar = null;
  session.isSearch = false;
  session.searchQuery = null;
  session.searchCardIds = null;

  if (message && args && args.length) {
    const parsed = parseMarketArgs(args);
    session.filterRank = parsed.filterRank;
    session.filterAttr = parsed.filterAttr;
    session.filterStar = parsed.filterStar;
  }

  const { listings, total } = await fetchListings(session);
  const embed = buildMarketEmbed(listings, session, total);
  const components = buildMarketComponents(listings, session, total, userId);

  if (message) {
    const sent = await message.reply({ embeds: [embed], components });
    session.messageId = sent.id;
    session.channelId = sent.channelId;
    return sent;
  }
  const sent = await interaction.reply({ embeds: [embed], components });
  session.messageId = sent.id;
  session.channelId = sent.channelId;
  return sent;
}

async function handleButton(interaction) {
  const [action, userId] = interaction.customId.split(':');

  if (interaction.user.id !== userId) {
    return interaction.reply({ content: 'This is not your market view.', ephemeral: true });
  }

  const session = getSession(userId);

  if (action === 'market_prev') {
    session.page = Math.max(0, session.page - 1);
    return renderMarket(interaction, userId, session);
  }

  if (action === 'market_next') {
    const { total } = await fetchListings(session);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    session.page = Math.min(totalPages - 1, session.page + 1);
    return renderMarket(interaction, userId, session);
  }

  if (action === 'market_back') {
    session.isSearch = false;
    session.searchQuery = null;
    session.searchCardIds = null;
    session.page = 0;
    return renderMarket(interaction, userId, session);
  }

  if (action === 'market_search') {
    session.messageId = interaction.message.id;
    session.channelId = interaction.channelId;

    const modal = new ModalBuilder()
      .setCustomId(`market_search_modal:${userId}`)
      .setTitle('Search Marketplace');

    const input = new TextInputBuilder()
      .setCustomId('market_search_input')
      .setLabel('Card name or ID')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. Luffy or 0001')
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }
}

async function handleSelect(interaction) {
  const [action, userId] = interaction.customId.split(':');

  if (interaction.user.id !== userId) {
    return interaction.reply({ content: 'This is not your market view.', ephemeral: true });
  }

  const session = getSession(userId);
  const value = interaction.values[0];

  if (action === 'market_rank') {
    session.filterRank = value === 'all' ? null : value;
    session.page = 0;
    return renderMarket(interaction, userId, session);
  }

  if (action === 'market_attr') {
    session.filterAttr = value === 'all' ? null : value;
    session.page = 0;
    return renderMarket(interaction, userId, session);
  }

  if (action === 'market_star') {
    session.filterStar = value === 'all' ? null : parseInt(value, 10);
    session.page = 0;
    return renderMarket(interaction, userId, session);
  }

  if (action === 'market_buy') {
    if (value === 'none') {
      return interaction.reply({ content: 'No listings available on this page.', ephemeral: true });
    }
    return handleBuy(interaction, userId, session, value);
  }
}

async function handleBuy(interaction, userId, session, listingId) {
  await interaction.deferUpdate();

  const listing = await MarketListing.findById(listingId);
  if (!listing || listing.expiresAt < new Date()) {
    await interaction.followUp({ content: 'This listing has expired or no longer exists.', ephemeral: true });
    return renderMarket(interaction, userId, session, true);
  }

  if (listing.sellerId === userId) {
    return interaction.followUp({ content: 'You cannot buy your own listing!', ephemeral: true });
  }

  const buyer = await User.findOne({ userId });
  if (!buyer) {
    return interaction.followUp({ content: 'You need to start first. Use `op start`', ephemeral: true });
  }

  if ((buyer.balance || 0) < listing.price) {
    return interaction.followUp({
      content: `You don't have enough Beli! You need **${formatPrice(listing.price)}** ${BELI_EMOJI} but have **${formatPrice(buyer.balance || 0)}** ${BELI_EMOJI}.`,
      ephemeral: true,
    });
  }

  const seller = await User.findOne({ userId: listing.sellerId });
  if (!seller) {
    await MarketListing.findByIdAndDelete(listingId);
    await interaction.followUp({ content: 'The seller no longer exists. Listing removed.', ephemeral: true });
    return renderMarket(interaction, userId, session, true);
  }

  // Support escrowed listings: seller may have had the card removed when listing.
  const sellerCardIdx = seller.ownedCards.findIndex(e => e.cardId === listing.cardId);
  let cardEntry = null;
  if (sellerCardIdx !== -1) {
    cardEntry = seller.ownedCards.splice(sellerCardIdx, 1)[0];
  } else {
    cardEntry = {
      cardId: listing.cardId,
      level: listing.level || 1,
      xp: listing.xp || 0,
      equippedTo: listing.equippedTo || null,
      starLevel: listing.starLevel || 0,
    };
  }

  buyer.ownedCards.push(cardEntry);
  buyer.balance = (buyer.balance || 0) - listing.price;
  seller.balance = (seller.balance || 0) + listing.price;

  await MarketListing.findByIdAndDelete(listingId);
  await seller.save();
  await buyer.save();

  try {
    const sellerUser = await interaction.client.users.fetch(listing.sellerId);
    const cardDef = getCardById(listing.cardId);
    const cardName = cardDef ? cardDef.character : listing.cardName;
    await sellerUser.send(
      `Your market listing for **${cardName}** (\`ID: ${formatCardId(listing.cardId)}\`) was purchased by **${interaction.user.username}** for **${formatPrice(listing.price)}** ${BELI_EMOJI}!`
    );
  } catch {}

  await interaction.followUp({
    content: `You purchased **${listing.cardName}** for **${formatPrice(listing.price)}** ${BELI_EMOJI}!`,
    ephemeral: true,
  });

  return renderMarket(interaction, userId, session, true);
}

async function handleModal(interaction) {
  const [, userId] = interaction.customId.split(':');

  if (interaction.user.id !== userId) {
    return interaction.reply({ content: 'This is not your market view.', ephemeral: true });
  }

  const session = getSession(userId);
  const query = interaction.fields.getTextInputValue('market_search_input').trim();

  const results = searchCards(query);
  if (!results || !results.length) {
    return interaction.reply({ content: `No cards found matching **"${query}"**.`, ephemeral: true });
  }

  const matchingIds = results.map(r => r.id).filter(Boolean);

  session.isSearch = true;
  session.searchQuery = query;
  session.searchCardIds = matchingIds;
  session.page = 0;
  // Fetch matching listings so we can report the number of listings found
  const { listings, total } = await fetchListings(session);

  try {
    const channel = interaction.client.channels.cache.get(session.channelId);
    if (channel && session.messageId) {
      const msg = await channel.messages.fetch(session.messageId).catch(() => null);
      if (msg) {
        const embed = buildMarketEmbed(listings, session, total);
        const components = buildMarketComponents(listings, session, total, userId);
        await msg.edit({ embeds: [embed], components });
      }
    }
  } catch {}

  return interaction.reply({ content: `🔍 Showing results for **"${query}"** (${total} listing${total !== 1 ? 's' : ''} found)`, ephemeral: true });
}

module.exports = { execute, handleButton, handleSelect, handleModal };
