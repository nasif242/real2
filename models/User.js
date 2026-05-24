const mongoose = require('mongoose');
const { Schema } = mongoose;

// schema for an owned card entry (mastery level is implied by the cardId)
const UserCardSchema = new Schema({
  cardId: { type: String, required: true },
  level: { type: Number, default: 1 },
  xp: { type: Number, default: 0 },
  equippedTo: { type: String, default: null },
  starLevel: { type: Number, default: 0 }
}, { _id: false });

const UserSchema = new Schema({
  userId: { type: String, required: true, unique: true },
  pullsRemaining: { type: Number, default: 7 },
  lastReset: { type: Date, default: Date.now },
  supportBonusApplied: { type: Boolean, default: false },
  pityCount: { type: Number, default: 0 },
  ownedCards: { type: [UserCardSchema], default: [] },
  history: { type: [String], default: [] },
  balance: { type: Number, default: 500 },
  gems: { type: Number, default: 0 },
  bounty: { type: Number, default: 100 },
  activeBountyTarget: { type: String, default: null },
  bountyCooldownUntil: { type: Date, default: null },
  robCooldownUntil: { type: Date, default: null },
  lootCooldownUntil: { type: Date, default: null },
  betCooldownUntil: { type: Date, default: null },
  triviaCooldownUntil: { type: Date, default: null },
  isailProgress: { type: Number, default: 1 },
  lastIsailFail: { type: Date, default: null },
  lastIsailEnemies: { type: [String], default: [] },
  totalPulls: { type: Number, default: 0 },
  resetTokens: { type: Number, default: 5 },
  // inventory for future shop/consumables
  items: { type: [{ itemId: String, quantity: Number, durability: Number }], default: [] },
  packs: { type: [{ packType: String, quantity: Number }], default: [] },
  // active team (up to 3 cardIds)
  team: { type: [String], default: [] },
  // custom team background image URL
  teamBackgroundUrl: { type: String, default: null },
  // active ship set for passive income
  activeShip: { type: String, default: null },
  shipBalance: { type: Number, default: 0 },
  shipLastUpdated: { type: Date, default: Date.now },
  // per-user ship state (e.g., current cola levels)
  ships: { type: Object, default: {} },
  // story progression for islands and stages (e.g., { fusha_village: [1,2] })
  storyProgress: { type: Object, default: {} },
  // track how many times an island has been fully completed: { fusha_village: 1 }
  storyCompletions: { type: Object, default: {} },
  // pack inventory for global stock system
  packInventory: { type: Object, default: {} },
  // per-user local stock for stock purchases (initialized from global stock on first purchase/view)
  localStock: { type: Object, default: {} },
  // daily rewards
  lastDaily: { type: Date, default: null },
  dailyStreak: { type: Number, default: 0 },
  // next scheduled DM reminder for daily (set when user claims daily)
  nextDailyReminder: { type: Date, default: null },
  // duel rate limiting: number of duels used today and the reset timestamp
  dailyDuels: { type: Number, default: 0 },
  dailyDuelsReset: { type: Date, default: null },
  // last bounty target userId to avoid assigning the same target twice in a row
  lastBountyTarget: { type: String, default: null },
  // achievements mapping: achievementId -> date awarded
  achievements: { type: Object, default: {} },
  // badges the user owns (achievement ids)
  badgesOwned: { type: [String], default: [] },
  // badges the user has equipped to profile (max 3)
  badgesEquipped: { type: [String], default: [] },
  // favorite cards (array of cardIds) - primary favorites the user has marked
  favoriteCards: { type: [String], default: [] },
  // wishlist cards: cards the user has favorited but does not own (max 3)
  wishlistCards: { type: [String], default: [] },
  // whether the user has completed the in-app tutorial
  tutorialCompleted: { type: Boolean, default: false },
  // fishing
  lastFishFail: { type: Date, default: null },
  // rods for fishing
  currentRod: { type: String, default: 'basic_rod' },
  // top.gg voting
  voteStreak: { type: Number, default: 0 },
  lastVoted: { type: Date, default: null },
  totalVotes: { type: Number, default: 0 },
  // fishing stats
  totalFishCaught: { type: Number, default: 0 },
  // casino gamble cooldown (1 hour after any game)
  gambleCooldownUntil: { type: Date, default: null },
});

module.exports = mongoose.model('User', UserSchema);
