const User = require('../models/User');
const MarketListing = require('../models/MarketListing');
const { formatCardId, getCardById } = require('../utils/cards');

const BELI_EMOJI = '<:beri:1490738445319016651>';

function formatPrice(price) {
  return price.toLocaleString('en-US').replace(/,/g, "'");
}

async function execute({ message, interaction, args }) {
  const rawArgs = args || [];
  const msgId = rawArgs[0];
  if (!msgId) return message.reply('Usage: op marketbuy <messageID>');

  const listing = await MarketListing.findOne({ messageId: msgId });
  if (!listing || listing.expiresAt < new Date()) {
    if (listing) await MarketListing.findByIdAndDelete(listing._id).catch(() => {});
    return message.reply('That listing does not exist or has expired.');
  }

  if (listing.sellerId === message.author.id) {
    return message.reply('You cannot buy your own listing.');
  }

  const buyer = await User.findOne({ userId: message.author.id });
  if (!buyer) return message.reply('You need to start first. Use `op start`');

  if ((buyer.balance || 0) < listing.price) {
    return message.reply(`You don't have enough Beli! You need **${formatPrice(listing.price)}** ${BELI_EMOJI} but have **${formatPrice(buyer.balance || 0)}** ${BELI_EMOJI}.`);
  }

  const seller = await User.findOne({ userId: listing.sellerId });
  if (!seller) {
    await MarketListing.findByIdAndDelete(listing._id).catch(() => {});
    return message.reply('The seller no longer exists. Listing removed.');
  }

  // Try to remove card from seller if it still exists in their collection
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
  // Remove the obtained card from buyer's wishlist if it was there
  if (Array.isArray(buyer.wishlistCards) && buyer.wishlistCards.includes(listing.cardId)) {
    buyer.wishlistCards = buyer.wishlistCards.filter(id => id !== listing.cardId);
    if (typeof buyer.markModified === 'function') buyer.markModified('wishlistCards');
  }
  buyer.balance = (buyer.balance || 0) - listing.price;
  seller.balance = (seller.balance || 0) + listing.price;

  await MarketListing.findByIdAndDelete(listing._id).catch(() => {});
  await seller.save();
  await buyer.save();

  try {
    const sellerUser = await message.client.users.fetch(listing.sellerId).catch(() => null);
    const cardDef = getCardById(listing.cardId);
    const cardName = cardDef ? cardDef.character : listing.cardName;
    if (sellerUser) {
      await sellerUser.send(
        `Your market listing for **${cardName}** (\`ID: ${formatCardId(listing.cardId)}\`) was purchased by **${message.author.username}** for **${formatPrice(listing.price)}** ${BELI_EMOJI}!`
      ).catch(() => {});
    }
  } catch (e) {}

  return message.reply(`You purchased **${listing.cardName}** for **${formatPrice(listing.price)}** ${BELI_EMOJI}!`);
}

module.exports = { execute };
