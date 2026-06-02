const User = require('../models/User');
const { cards } = require('../data/cards');
const { PULL_LIMIT, PULL_RESET_HOURS, PULL_RATES, PITY_TARGET, PITY_DISTRIBUTION } = require('../config');
const { buildPullEmbed, getAllCardVersions, getCardById, pickFromPoolWithWishlist, applyXpToEquippedArtifact } = require('../utils/cards');
const stockUtils = require('../src/stock');
const getPreviousPullResetDate = stockUtils.getPreviousPullResetDate;
const getTimeUntilNextPullReset = stockUtils.getTimeUntilNextPullReset;
const { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { generateArtifactImage } = require('../utils/artifactImage');
const SUPPORT_GUILD_ID = '1322627413234155520';
const { getMaxStarForRank } = require('../utils/starLevel');
const SPECIAL_PULL_CARD_IDS = ['4162', '4037', '3786'];

async function isInSupportServer(userId, client) {
  try {
    const guild = client.guilds.cache.get(SUPPORT_GUILD_ID);
    if (!guild) {
      console.log(`[pull] isInSupportServer: bot is NOT in guild ${SUPPORT_GUILD_ID} (not in cache). Cannot check membership.`);
      return false;
    }
    // fetch single member — does not require privileged GUILD_MEMBERS intent
    const member = await guild.members.fetch(userId);
    console.log(`[pull] isInSupportServer: user ${userId} IS in support server.`);
    return !!member;
  } catch (e) {
    if (e.code === 10007) {
      console.log(`[pull] isInSupportServer: user ${userId} is NOT in support server (Unknown Member).`);
    } else {
      console.error(`[pull] isInSupportServer: unexpected error for user ${userId}:`, e.code, e.message);
    }
    return false;
  }
}

module.exports = {
  name: 'pull',
  description: 'Pull a random card',
  async execute({ message, interaction }) {
    const userId = message ? message.author.id : interaction.user.id;
    const username = message ? message.author.username : interaction.user.username;
    let user = await User.findOne({ userId });
    if (!user) {
      const reply = 'You don\'t have an account. Run `op start` or /start to register.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // Reset logic using global pull timer
    const now = new Date();

    // Ensure lastReset is a Date
    if (!user.lastReset || !(user.lastReset instanceof Date)) {
      user.lastReset = now;
    }

    const lastResetBoundary = getPreviousPullResetDate();
    let effectivePullLimit = PULL_LIMIT;
    let inSupportServer = false;

    // Only check support-server membership on the first pull after a global reset.
    if (user.lastReset < lastResetBoundary) {
      const client = message ? message.client : interaction.client;
      inSupportServer = await isInSupportServer(userId, client);

      // Count special max-star cards owned by the user
      let extrasFromCards = 0;
      const owned = user.ownedCards || [];
      for (const cid of SPECIAL_PULL_CARD_IDS) {
        const entry = owned.find(e => e.cardId === cid);
        if (entry) {
          const def = cards.find(c => c.id === cid);
          const maxStar = def ? getMaxStarForRank(def.rank) : 7;
          if ((entry.starLevel || 0) >= maxStar) extrasFromCards += 1;
        }
      }

      effectivePullLimit = PULL_LIMIT + (inSupportServer ? 1 : 0) + extrasFromCards;

      user.pullsRemaining = effectivePullLimit;
      user.lastReset = lastResetBoundary;
      user.supportBonusApplied = inSupportServer;
      await user.save();
    } else {
      // Not a reset boundary — derive effective limit from persisted flag (no membership check)
      let extrasFromCards = 0;
      const owned = user.ownedCards || [];
      for (const cid of SPECIAL_PULL_CARD_IDS) {
        const entry = owned.find(e => e.cardId === cid);
        if (entry) {
          const def = cards.find(c => c.id === cid);
          const maxStar = def ? getMaxStarForRank(def.rank) : 7;
          if ((entry.starLevel || 0) >= maxStar) extrasFromCards += 1;
        }
      }

      effectivePullLimit = PULL_LIMIT + (user.supportServerMember ? 1 : 0) + extrasFromCards;

      // Normalize pullsRemaining to a finite integer within [0, effectivePullLimit]
      if (typeof user.pullsRemaining !== 'number' || !isFinite(user.pullsRemaining)) {
        user.pullsRemaining = effectivePullLimit;
      } else {
        user.pullsRemaining = Math.floor(user.pullsRemaining);
        if (user.pullsRemaining > effectivePullLimit) user.pullsRemaining = effectivePullLimit;
        if (user.pullsRemaining < 0) user.pullsRemaining = 0;
      }
    }

    if (user.pullsRemaining <= 0) {
      const diffMs = getTimeUntilNextPullReset();
      const hrs = Math.floor(diffMs / (1000 * 60 * 60));
      const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      const secs = Math.floor((diffMs % (1000 * 60)) / 1000);
      const timeStr = `${hrs}h ${mins}m ${secs}s`;
      const nextEmoji = '<:next:1489374606916714706>';
      const resetTokenEmoji = '<:resettoken:1490738386540171445>';

      // Determine which 'more pulls' options to show
      const VOTE_COOLDOWN_MS = 12 * 60 * 60 * 1000;
      const lastVoted = user.lastVoted ? new Date(user.lastVoted).getTime() : 0;
      const canVoteNow = !user.lastVoted || (Date.now() - lastVoted) >= VOTE_COOLDOWN_MS;
      const showVote = canVoteNow;
      const showSupport = !user.supportServerMember;

      // Cards to present for extra pulls
      const specialCards = SPECIAL_PULL_CARD_IDS.map(id => cards.find(c => c.id === id)).filter(Boolean);
      const cardLines = [];
      for (const c of specialCards) {
        const ownedEntry = (user.ownedCards || []).find(e => e.cardId === c.id);
        const maxStar = getMaxStarForRank(c.rank);
        const isMax = ownedEntry && (ownedEntry.starLevel || 0) >= maxStar;
        if (!isMax) {
          const emoji = c.emoji ? c.emoji + ' ' : '';
          cardLines.push(`${nextEmoji} ${emoji}${c.character} \`${c.id}\``);
        }
      }

      // Build reply
      const reply = `you've used all ${effectivePullLimit} pulls. Next reset in **${timeStr}**`;

      const morePullsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('pull_more_info')
          .setLabel('Get More Pulls')
          .setStyle(ButtonStyle.Secondary)
      );

      if (message) return message.channel.send({ content: reply, components: [morePullsRow] });
      return interaction.reply({ content: reply, ephemeral: true, components: [morePullsRow] });
    }

    // determine category first (Cards / Artifacts / Ships) then roll rank per-category
    // Category weights (treated as relative weights and normalized)
    // Use percentages: cards 97%, artifacts 2%, ships 1%
    const CATEGORY_WEIGHTS = { cards: 97, artifacts: 2, ships: 1 };
    const CARD_RATES = { D: 30, C: 30, B: 29.80, A: 7.6, S: 2.2, SS: 0.35, UR: 0.05 };
    const ARTIFACT_SHIP_RATES = { D: 30, C: 30, B: 20, A: 12, S: 8 };

    let rank;
    let pityTriggered = false;
    let category = 'cards';
    // Atomically claim pity for prefix pulls to avoid two quick pulls both consuming pity
    let pityClaimed = false;
    if (message && PITY_TARGET && (user.pityCount || 0) >= PITY_TARGET) {
      try {
        const claimed = await User.findOneAndUpdate(
          { userId, pityCount: { $gte: PITY_TARGET } },
          { $set: { pityCount: 0 } },
          { new: true }
        );
        if (claimed) {
          pityClaimed = true;
          user.pityCount = 0;
        }
      } catch (e) {
        console.error('Error claiming pity for user', userId, e);
      }
    }

    // If pity was successfully claimed, force an SS card from the card pool
    if (message && pityClaimed) {
      rank = 'SS';
      category = 'cards';
      pityTriggered = true;
    } else {
      // choose category by weights (normalize in case they don't sum to 100)
      const catTotal = Object.values(CATEGORY_WEIGHTS).reduce((s, v) => s + v, 0) || 1;
      let rc = Math.random() * catTotal;
      for (const [k, w] of Object.entries(CATEGORY_WEIGHTS)) {
        rc -= w;
        if (rc <= 0) { category = k; break; }
      }

      // pick rank according to selected category's distribution
      const pickFromDist = (dist) => {
        const total = Object.values(dist).reduce((s, v) => s + v, 0) || 1;
        let r = Math.random() * total;
        for (const [rk, pct] of Object.entries(dist)) {
          r -= pct;
          if (r <= 0) return rk;
        }
        return Object.keys(dist)[Object.keys(dist).length - 1];
      };

      if (category === 'cards') rank = pickFromDist(CARD_RATES);
      else rank = pickFromDist(ARTIFACT_SHIP_RATES);

      // increment pity for prefix pulls only when we did not atomically claim pity
      if (message) user.pityCount = (user.pityCount || 0) + 1;
    }

    const pityProgress = message ? `Pity: ${user.pityCount}/${PITY_TARGET}` : '';

    // select card from pool matching category and rank with category-safe fallbacks
    // Cards with these keywords in their name are never pullable from the pool
    const UNPULLABLE_NAME_KEYWORDS = ['slasher', 'striker', 'group'];
    const pullable = cards.filter(c => {
      if (!c.pullable) return false;
      const name = (c.character || '').toLowerCase();
      return !UNPULLABLE_NAME_KEYWORDS.some(kw => name.includes(kw));
    });
    let pool = [];
    if (category === 'cards') {
      // prefer non-ship, non-artifact cards of the given rank
      pool = pullable.filter(c => c.rank === rank && !c.ship && !c.artifact);
      // fallback: any non-ship/non-artifact regardless of rank
      if (!pool || pool.length === 0) pool = pullable.filter(c => !c.ship && !c.artifact);
    } else if (category === 'artifacts') {
      // prefer artifacts of the given rank
      pool = pullable.filter(c => c.rank === rank && c.artifact);
      // fallback: any artifact regardless of rank
      if (!pool || pool.length === 0) pool = pullable.filter(c => c.artifact);
    } else if (category === 'ships') {
      // prefer ships of the given rank
      pool = pullable.filter(c => c.rank === rank && c.ship);
      // fallback: any ship regardless of rank
      if (!pool || pool.length === 0) pool = pullable.filter(c => c.ship);
    }

    // final fallback: anything pullable (should be very rare)
    if (!pool || pool.length === 0) pool = pullable;

    const card = pickFromPoolWithWishlist(pool, user.wishlistCards);

    // Get all versions in this card group
    const allVersionIds = getAllCardVersions(card);
    
    // Find if user owns any version in this card group
    let bestOwnedEntry = null;
    let bestOwnedId = null;
    for (const versionId of allVersionIds) {
      const entry = user.ownedCards.find(e => e.cardId === versionId);
      if (entry) {
        bestOwnedEntry = entry;
        bestOwnedId = versionId;
      }
    }

    let duplicateText = '';
    
    if (bestOwnedEntry && bestOwnedId) {
      // User owns some version of this character
      const bestOwnedCard = getCardById(bestOwnedId);
      const pulledCard = getCardById(card.id);
      
      if (pulledCard.mastery < bestOwnedCard.mastery) {
        bestOwnedEntry.xp = (bestOwnedEntry.xp || 0) + 100;
        applyXpToEquippedArtifact(user, bestOwnedEntry, 100);
        const gained = Math.floor(bestOwnedEntry.xp / 100);
        if (gained > 0) {
          bestOwnedEntry.level = (bestOwnedEntry.level || 1) + gained;
          bestOwnedEntry.xp = bestOwnedEntry.xp % 100;
        }
        duplicateText = `+100 XP`;
      } else if (pulledCard.mastery === bestOwnedCard.mastery) {
        bestOwnedEntry.xp = (bestOwnedEntry.xp || 0) + 100;
        applyXpToEquippedArtifact(user, bestOwnedEntry, 100);
        const gained = Math.floor(bestOwnedEntry.xp / 100);
        if (gained > 0) {
          bestOwnedEntry.level = (bestOwnedEntry.level || 1) + gained;
          bestOwnedEntry.xp = bestOwnedEntry.xp % 100;
        }
        duplicateText = `+100 XP`;
      } else {
        // Pulled a higher version than what they own
        const bestOwnedIdVal = bestOwnedId; // id of version they currently have
        // check if the card on team prevents upgrade
        if (user.team && user.team.includes(bestOwnedIdVal)) {
          bestOwnedEntry.xp = (bestOwnedEntry.xp || 0) + 100;
          applyXpToEquippedArtifact(user, bestOwnedEntry, 100);
          const gained = Math.floor(bestOwnedEntry.xp / 100);
          if (gained > 0) {
            bestOwnedEntry.level = (bestOwnedEntry.level || 1) + gained;
            bestOwnedEntry.xp = bestOwnedEntry.xp % 100;
          }
          duplicateText = `+100 XP`;
        } else {
          // normal upgrade: add new version and remove lower ones
          user.ownedCards = user.ownedCards || [];
          if (!user.ownedCards.some(e => e.cardId === card.id)) {
            user.ownedCards.push({ cardId: card.id, level: 1, xp: 0 });
          }
          // Remove all lower versions of this character
          user.ownedCards = user.ownedCards.filter(e => {
            const eCard = getCardById(e.cardId);
            if (!eCard || eCard.character !== card.character) return true;
            return eCard.mastery >= card.mastery;
          });
          if (!user.history.includes(card.id)) user.history.push(card.id);
          duplicateText = `Upgraded! Higher version acquired. Lower versions removed.`;
        }
      }
    } else {
      // Don't own any version - add this one (avoid accidental duplicates)
      user.ownedCards = user.ownedCards || [];
      if (!user.ownedCards.some(e => e.cardId === card.id)) {
        user.ownedCards.push({ cardId: card.id, level: 1, xp: 0 });
      }
      if (!user.history.includes(card.id)) user.history.push(card.id);
    }

    // Build embed now (before we remove wishlist entries) so the pulled
    // card still shows as wishlisted/favorited in the embed if it was.
    const avatarUrl = message ? message.author.displayAvatarURL() : interaction.user.displayAvatarURL();
    const embed = buildPullEmbed(card, username, avatarUrl, pityProgress, duplicateText, user);

    // If this card was on the user's wishlist, remove it now that they've
    // obtained it so the favorites/wishlist UI reflects ownership.
    if (Array.isArray(user.wishlistCards) && user.wishlistCards.includes(card.id)) {
      user.wishlistCards = user.wishlistCards.filter(id => id !== card.id);
      if (typeof user.markModified === 'function') user.markModified('wishlistCards');
    }

    user.pullsRemaining -= 1;
    user.totalPulls = (user.totalPulls || 0) + 1;
    await user.save();

    // Check achievements after changes
    try {
    } catch (err) {
      console.error('Error checking achievements after pull', err);
    }

    // Attach generated artifact image when the pulled card is an artifact
    let files;
    if (card && card.artifact) {
      try {
        const buf = await generateArtifactImage(card);
        const att = new AttachmentBuilder(buf, { name: `artifact-${card.id}.png` });
        files = [att];
      } catch (e) {
        console.error('Failed to generate artifact image for pull', e);
      }
    }

    if (message) return message.channel.send({ embeds: [embed], files });
    return interaction.reply({ embeds: [embed], files });
  },

  async handleButton(interaction) {
    const userId = interaction.user.id;
    const user = await User.findOne({ userId });
    if (!user) return interaction.reply({ content: "You don't have an account yet.", ephemeral: true });

    const { PULL_LIMIT, PULL_RESET_HOURS } = require('../config');
    const { getMaxStarForRank } = require('../utils/starLevel');
    const { cards } = require('../data/cards');

    let extrasFromCards = 0;
    const owned = user.ownedCards || [];
    for (const cid of SPECIAL_PULL_CARD_IDS) {
      const entry = owned.find(e => e.cardId === cid);
      if (entry) {
        const def = cards.find(c => c.id === cid);
        const maxStar = def ? getMaxStarForRank(def.rank) : 7;
        if ((entry.starLevel || 0) >= maxStar) extrasFromCards += 1;
      }
    }
    const effectivePullLimit = PULL_LIMIT + (user.supportBonusApplied ? 1 : 0) + extrasFromCards;

    const nextEmoji = '<:next:1489374606916714706>';
    const resetTokenEmoji = '<:resettoken:1490738386540171445>';

    const VOTE_COOLDOWN_MS = 12 * 60 * 60 * 1000;
    const lastVoted = user.lastVoted ? new Date(user.lastVoted).getTime() : 0;
    const canVoteNow = !user.lastVoted || (Date.now() - lastVoted) >= VOTE_COOLDOWN_MS;
    const showVote = canVoteNow;
    const showSupport = !user.supportBonusApplied;

    const specialCards = SPECIAL_PULL_CARD_IDS.map(id => cards.find(c => c.id === id)).filter(Boolean);
    const cardLines = [];
    for (const c of specialCards) {
      const ownedEntry = (user.ownedCards || []).find(e => e.cardId === c.id);
      const maxStar = getMaxStarForRank(c.rank);
      const isMax = ownedEntry && (ownedEntry.starLevel || 0) >= maxStar;
      if (!isMax) {
        const emoji = c.emoji ? c.emoji + ' ' : '';
        cardLines.push(`${nextEmoji} ${emoji}${c.character} \`${c.id}\``);
      }
    }

    const wantLines = [];
    if (showVote) wantLines.push(`${nextEmoji} [Vote](<https://top.gg/bot/1461800991677481173/vote>) for the bot for ${resetTokenEmoji}Reset token`);
    if (showSupport) wantLines.push(`${nextEmoji} Join the [Support server](https://discord.gg/z8bDjhYZE5) for 1 Extra pull per reset`);
    if (cardLines.length > 0) {
      wantLines.push('__Obtain these cards and upgrade them to Max star level for 1 extra pull each.__');
      wantLines.push(...cardLines);
    }

    const content = wantLines.length > 0
      ? `**Want more pulls?**\n${wantLines.join('\n')}`
      : 'You currently have no extra ways to gain more pulls available.';

    return interaction.reply({ content, ephemeral: true });
  }
};
