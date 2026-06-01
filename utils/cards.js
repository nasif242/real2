const { EmbedBuilder } = require('discord.js');
const { cards, rankData, artifactThumbnails } = require('../data/cards');
const crews = require('../data/crews');
const { PULL_RATES, PITY_TARGET, PITY_DISTRIBUTION } = require('../config');

// Create icon map (normalize gif URLs so Tenor short links become media.tenor URLs)
const crewIcons = {};
crews.forEach(crew => {
  let iconVal = crew.icon;
  try {
    if (iconVal && typeof iconVal === 'string' && iconVal.startsWith && iconVal.startsWith('http')) {
      iconVal = normalizeGifUrl(iconVal);
    }
  } catch (e) {
    // ignore and fall back to raw icon
  }
  crewIcons[crew.name] = iconVal;
});

// Emoji used to mark favorited cards in embeds/lists
const STAR_EMOJI = '<:star:1501996419693936843>';
// Emoji used to mark wishlist (non-owned) cards
const WISH_EMOJI = '📝';

const RANDOM_ENEMY_EMOJI_REMAP = {
  '<:randomenemy:1491916913960423645>': '<:fgcrb:1492280855832432680>',
  '<:randomenemygreen:1491937401860259982>': '<:fgcgb:1492280858806059068>',
  '<:randomenemyqck:1491937598690820267>': '<:fgcbb:1492280860064350368>',
  '<:randomenemyint:1491938030611861574>': '<:fgcpb:1492280857187192983>',
  '<:randomenemypsy:1491937909060931847>': '<:fgcyb:1492280854767079494>'
};

// Safely apply an author object to an EmbedBuilder.
// Discord's builders require `name` to be a non-empty string. Many cards
// may not have a faculty or an icon; avoid calling `setAuthor` with
// undefined fields which triggers shapeshift validation errors.
function safeApplyAuthor(embed, author) {
  if (!embed || !author || typeof author !== 'object') return;
  const out = {};
  if (typeof author.name === 'string' && author.name.trim()) out.name = author.name;
  if (typeof author.iconURL === 'string' && author.iconURL.trim()) out.iconURL = author.iconURL;
  if (typeof author.url === 'string' && author.url.trim()) out.url = author.url;
  if (out.name) embed.setAuthor(out);
}

function getModifiedRates(baseRates, rodMultiplier = 1) {
  if (rodMultiplier === 1) return baseRates;
  const boostedRanks = new Set(['A', 'S', 'SS', 'UR']);
  const modified = {};
  let total = 0;
  for (const [rank, pct] of Object.entries(baseRates)) {
    const weight = boostedRanks.has(rank) ? pct * rodMultiplier : pct;
    modified[rank] = weight;
    total += weight;
  }
  if (total === 0) return baseRates;
  const factor = 100 / total;
  for (const rank of Object.keys(modified)) {
    modified[rank] = modified[rank] * factor;
  }
  return modified;
}

function getRankFromDistribution(rates) {
  const r = Math.random() * 100;
  let running = 0;
  for (const [rk, pct] of Object.entries(rates)) {
    running += pct;
    if (r <= running) return rk;
  }
  return Object.keys(rates)[Object.keys(rates).length - 1];
}

function getRankFromDistributionWithFilter(rates, allowedRanks) {
  const filteredRates = {};
  let total = 0;
  for (const [rk, pct] of Object.entries(rates)) {
    if (allowedRanks.has(rk)) {
      filteredRates[rk] = pct;
      total += pct;
    }
  }
  if (total === 0) return null;
  const factor = 100 / total;
  for (const rk of Object.keys(filteredRates)) {
    filteredRates[rk] = filteredRates[rk] * factor;
  }
  return getRankFromDistribution(filteredRates);
}

// Pick an item from a pool, giving a small relative bonus to wishlisted items.
// `wishlist` is an array of cardIds that should receive a weight multiplier.
function pickFromPoolWithWishlist(pool, wishlist) {
  if (!pool || !pool.length) return null;
  const wishSet = Array.isArray(wishlist) ? new Set(wishlist) : null;
  // base weight 1; wishlisted items have a 1.10 multiplier (i.e., +10% relative chance)
  const weights = pool.map(c => (wishSet && wishSet.has(c.id) ? 1.1 : 1));
  const total = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

function normalizeName(name) {
  return name ? name.toLowerCase().replace(/[^a-z0-9]+/g, '') : '';
}

function getFacultyCharacters(faculty) {
  const normalizedFaculty = normalizeName(faculty);
  const characters = new Set();
  if (!normalizedFaculty) return characters;
  cards.forEach(c => {
    const cardFaculty = normalizeName(c.faculty);
    if (!cardFaculty) return;
    if (cardFaculty === normalizedFaculty || cardFaculty.includes(normalizedFaculty) || normalizedFaculty.includes(cardFaculty)) {
      characters.add(c.character);
    }
  });
  return characters;
}

function normalizeCardId(cardId) {
  if (cardId == null) return '';
  const raw = String(cardId).trim().toLowerCase();
  const lettersDigits = raw.match(/^([a-z]+)(\d+)$/i);
  if (lettersDigits) {
    return `${lettersDigits[1].toLowerCase()}${lettersDigits[2].padStart(3, '0')}`;
  }
  if (/^\d+$/.test(raw)) {
    return raw.padStart(4, '0');
  }
  return raw;
}

function formatCardId(cardId) {
  return normalizeCardId(cardId);
}

// Get a card definition by its ID
function getCardById(cardId) {
  const card = cards.find(c => c.id === cardId);
  if (card) return card;
  const normalizedId = normalizeCardId(cardId);
  return cards.find(c => normalizeCardId(c.id) === normalizedId) || null;
}

function getCardGroup(cardDef) {
  if (!cardDef || typeof cardDef !== 'object') return null;
  return cardDef.group || null;
}

function isArtifactCard(cardDef) {
  return cardDef && cardDef.artifact === true;
}

function isShipCard(cardDef) {
  return cardDef && cardDef.ship === true;
}

function getShipById(cardId) {
  const card = cards.find(c => c.id === cardId && c.ship === true);
  if (card) return card;
  const normalizedId = normalizeCardId(cardId);
  return cards.find(c => normalizeCardId(c.id) === normalizedId && c.ship === true) || null;
}

function updateShipBalance(user) {
  if (!user || !user.activeShip) return;
  const ship = getShipById(user.activeShip);
  if (!ship) return;
  const startingBalance = (ship.startingBalance !== undefined) ? ship.startingBalance : 0;
  if (typeof user.shipBalance !== 'number' || user.shipBalance <= 0) {
    user.shipBalance = startingBalance;
  }
  const lastUpdated = user.shipLastUpdated ? new Date(user.shipLastUpdated) : new Date();
  const now = new Date();
  const minutesPassed = Math.floor((now - lastUpdated) / 60000);
  if (minutesPassed <= 0) {
    user.shipLastUpdated = user.shipLastUpdated || now;
    return;
  }
  let nextBalance = (user.shipBalance || startingBalance) * Math.pow(ship.incomeMultiplier, minutesPassed);
  nextBalance = Math.min(ship.capacity, Math.ceil(nextBalance));
  user.shipBalance = nextBalance;
  user.shipLastUpdated = now;
}

function parseBoostTargets(boostText) {
  if (!boostText || typeof boostText !== 'string') return [];
  const regex = /([\w .'-]+?)(?:,\s*([\w ]+))?\s*\((\d+)%\)/gi;
  const results = [];
  let match;
  while ((match = regex.exec(boostText)) !== null) {
    results.push({ target: match[1].trim(), stat: match[2] ? match[2].trim() : null, pct: parseInt(match[3], 10) });
  }
  return results;
}

function getArtifactBoostSummary(cardDef, level = 1) {
  const targets = parseBoostTargets(cardDef.boost);
  if (!targets.length) return null;
  const allStats = targets.every(t => !t.stat);
  const uniquePct = Array.from(new Set(targets.map(t => t.pct)));
  if (allStats && uniquePct.length === 1) {
    const basePct = uniquePct[0];
    const levelBonus = Math.ceil((level || 1) / 10);
    const totalPct = basePct + (levelBonus > 0 ? levelBonus : 0);
    return `${totalPct}%`;
  }
  return null;
}

function getArtifactSignatureLines(cardDef) {
  const targets = parseBoostTargets(cardDef.boost);
  if (!targets.length) return [];
  return targets.map((target) => {
    let emoji = '';
    const crew = crews.find(cr => cr.name.toLowerCase().replace(/[- ]/g, '') === target.target.toLowerCase().replace(/[- ]/g, ''));
    if (crew && crew.icon) emoji = `${crew.icon} `;
    else {
      const targetCard = cards.find(c => c.character.toLowerCase() === target.target.toLowerCase());
      if (targetCard && targetCard.emoji) emoji = `${targetCard.emoji} `;
    }
    return `${emoji}${target.target}`.trim();
  });
}

function getAttributeEmoji(attribute) {
  const map = {
    STR: '<:STR:1490476222755639476>',
    DEX: '<:DEX:1490476443946188952>',
    QCK: '<:QCK:1490476238593331291>',
    PSY: '<:PSY:1490476369472127166>',
    INT: '<:INT:1490476207601483816>',
    ALL: '🔷',
    BASE: '<:BASE:1510322504194064404>'
  };
  return map[attribute] || attribute || '❔';
}

// Parse a card attribute string into an array of attribute codes.
// Supports formats like 'STR', 'STR/INT', '<:STR:1234>/<:INT:5678>', or emoji-like tokens.
function parseCardAttributes(attribute) {
  if (!attribute || typeof attribute !== 'string') return [];
  const parts = attribute.split('/').map(p => p.trim()).filter(Boolean);
  const codes = [];
  const KNOWN = ['STR', 'DEX', 'QCK', 'INT', 'PSY', 'ALL', 'BASE'];
  for (const part of parts) {
    if (!part) continue;
    const up = part.toUpperCase();
    // direct code
    if (KNOWN.includes(up)) {
      codes.push(up);
      continue;
    }
    // emoji token like <:STR:12345> or name containing STR/INT
    const m = part.match(/<a?:([^:>]+):\d+>/);
    const name = m ? m[1] : part;
    const found = (name.match(/STR|DEX|QCK|INT|PSY|BASE/i) || [])[0];
    if (found) codes.push(found.toUpperCase());
    else {
      // fallback: if the part itself contains a known code substring
      const alt = (part.match(/STR|DEX|QCK|INT|PSY|BASE/i) || [])[0];
      if (alt) codes.push(alt.toUpperCase());
    }
  }
  // unique
  return Array.from(new Set(codes));
}

function buildDurabilityBar(current, max, type = 'default') {
  if (max <= 0) return '';
  // empty bar (no durability)
  if (current <= 0) {
    return '<:Healthemptyleft:1481750325151928391>'
      + '<:Healthemptymiddle:1481750341489004596>'.repeat(6)
      + '<:healthemptyright:1481750363286667334>';
  }

  const healthPercent = Math.max(0, Math.min(1, current / max));
  const totalSections = 8;
  const filledSections = Math.floor(healthPercent * totalSections);
  const emptySections = totalSections - filledSections;

  // default (ship/cola) filled icons
  const defaultFilled = {
    left: '<:1000048130:1497622896330408099>',
    middle: '<:1000048131:1497622898603458570>',
    right: '<:1000048132:1497622899790713052>'
  };

  // rod-specific filled icons (requested)
  const rodFilled = {
    left: '<:durabilltyleftfull:1491513785570033734>',
    middle: '<:durabilitymiddlefulll:1491513816654155838>',
    right: '<:durabilityrightfull:1491513801089093923>'
  };

  const filled = (type === 'rod') ? rodFilled : defaultFilled;

  const empty = {
    left: '<:Healthemptyleft:1481750325151928391>',
    middle: '<:Healthemptymiddle:1481750341489004596>',
    right: '<:healthemptyright:1481750363286667334>'
  };

  const icons = [
    emptySections > 0 ? empty.left : filled.left,
    emptySections > 1 ? empty.middle : filled.middle,
    emptySections > 2 ? empty.middle : filled.middle,
    emptySections > 3 ? empty.middle : filled.middle,
    emptySections > 4 ? empty.middle : filled.middle,
    emptySections > 5 ? empty.middle : filled.middle,
    emptySections > 6 ? empty.middle : filled.middle,
    emptySections > 7 ? empty.right : filled.right
  ];

  return icons.join('');
}

function stripBoostAmounts(boostText) {
  if (!boostText || typeof boostText !== 'string') return boostText;
  return boostText.replace(/\s*\(\d+%\)/g, '').trim();
}

function getAllCardVersions(cardOrCharacter) {
  if (!cardOrCharacter) return [];
  if (typeof cardOrCharacter === 'object') {
    const group = getCardGroup(cardOrCharacter);
    if (group) {
      return cards.filter(c => getCardGroup(c) === group).map(c => c.id);
    }
    return cardOrCharacter.id ? [cardOrCharacter.id] : [];
  }

  const byId = cards.find(c => c.id === cardOrCharacter);
  if (byId) return [byId.id];

  const normalizedGroup = normalizeName(cardOrCharacter);
  const groupCards = cards.filter(c => c.group && normalizeName(c.group) === normalizedGroup);
  if (groupCards.length) return groupCards.map(c => c.id);

  return cards.filter(c => c.character === cardOrCharacter).map(c => c.id);
}

function getOwnedEntry(user, cardDef) {
  return user && Array.isArray(user.ownedCards) ? user.ownedCards.find(e => e.cardId === cardDef.id) : null;
}

function hasHigherVersionOwned(user, cardDef) {
  if (!user || !Array.isArray(user.ownedCards) || !cardDef) return false;
  const allVersionIds = getAllCardVersions(cardDef);
  if (allVersionIds.length <= 1) return false;
  const currentIndex = allVersionIds.indexOf(cardDef.id);
  if (currentIndex < 0) return false;
  const higherVersionIds = allVersionIds.slice(currentIndex + 1);
  const ownedIds = user.ownedCards.map(e => e.cardId);
  return higherVersionIds.some(id => ownedIds.includes(id));
}

function resolveBoostsForCard(cardDef, user) {
  const boostEntries = [];
  let totalBoostPct = 0;
  const statBoosts = {};
  if (!user || !Array.isArray(user.ownedCards)) return { boostEntries, totalBoostPct, statBoosts };

  const getEffectiveBoost = (boostCardId, baseBoostPct) => {
    let effectiveBoost = baseBoostPct;
    user.ownedCards.forEach(entry => {
      const def = cards.find(c => c.id === entry.cardId);
      if (def && def.boost && entry.cardId !== boostCardId) {
        const boostCard = cards.find(c => c.id === boostCardId);
        if (boostCard) {
          const charRegex = new RegExp(`${boostCard.character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\((\\d+)%\\)`, 'i');
          const charMatch = def.boost.match(charRegex);
          if (charMatch) {
            const applyBoost = parseInt(charMatch[1], 10);
            effectiveBoost = Math.ceil(effectiveBoost * (1 + applyBoost / 100));
          }
        }
      }
    });
    return effectiveBoost;
  };

  user.ownedCards.forEach(entry => {
    const def = cards.find(c => c.id === entry.cardId);
    if (def && def.boost) {
      // Artifact boosts only apply when equipped to this card
      if (isArtifactCard(def) && entry.equippedTo !== cardDef.id) return;
      // Regex: target, optional stat, percent
      const regex = /([\w .'-]+?)(?:,\s*([\w ]+))?\s*\((\d+)%\)/gi;
      let match;
      while ((match = regex.exec(def.boost)) !== null) {
        const targetName = match[1].trim();
        const stat = match[2] ? match[2].trim() : null;
        const pct = parseInt(match[3], 10);
        // If this boost applies to this card or its faculty (faculty boost applies to all cards in that faculty)
        if (
          targetName.toLowerCase() === cardDef.character.toLowerCase() ||
          (cardDef.faculty && targetName.toLowerCase().replace(/-/g, '').replace(/ /g, '') === cardDef.faculty.toLowerCase().replace(/-/g, '').replace(/ /g, ''))
        ) {
          const boostAmount = getEffectiveBoost(def.id, pct);
          if (stat) {
            // Normalize stat names to canonical keys so boosts reliably
            // apply regardless of capitalization or synonyms (e.g. "Health", "HP", "Attack", "Atk").
            let statKey = stat.toLowerCase().trim();
            if (statKey === 'hp') statKey = 'health';
            if (statKey === 'atk') statKey = 'attack';
            if (statKey === 'att') statKey = 'attack';
            // record using canonical key
            statBoosts[statKey] = (statBoosts[statKey] || 0) + boostAmount;
            boostEntries.push({ source: def.character, pct: boostAmount, stat: statKey });
          } else {
            totalBoostPct += boostAmount;
            boostEntries.push({ source: def.character, pct: boostAmount });
          }
        }
      }
    }
  });

  return { boostEntries, totalBoostPct, statBoosts };
}

function getCardFinalStats(cardDef, level, user) {
  const userEntry = getOwnedEntry(user, cardDef);
  const isOwned = !!userEntry;
  const higherVersionOwned = !isOwned && hasHigherVersionOwned(user, cardDef);
  const boostInfo = (isOwned || !higherVersionOwned) ? resolveBoostsForCard(cardDef, user) : { boostEntries: [], totalBoostPct: 0, statBoosts: {} };
  const scaled = computeScaledStats(cardDef, level || 1, boostInfo.totalBoostPct, boostInfo.statBoosts, userEntry?.starLevel || 0);
  return {
    scaled,
    boostEntries: boostInfo.boostEntries,
    totalBoostPct: boostInfo.totalBoostPct,
    statBoosts: boostInfo.statBoosts || {},
    isOwned,
    higherVersionOwned
  };
}


// Find the highest mastery owned version of a character
async function findBestOwnedVersion(userId, character) {
  const User = require('../models/User');
  const allVersions = getAllCardVersions(character);
  if (!allVersions.length) return null;
  
  const user = await User.findOne({ userId });
  if (!user || !user.ownedCards) return null;
  
  const ownedIds = user.ownedCards.map(e => e.cardId);
  const ownedVersions = allVersions.filter(id => ownedIds.includes(id));
  
  if (!ownedVersions.length) return null;
  
  // return highest mastery owned version (they're in order, so last is highest)
  const lastId = ownedVersions[ownedVersions.length - 1];
  return getCardById(lastId);
}

async function findBestOwnedShip(userId, query) {
  const User = require('../models/User');
  const matches = searchCards(query).filter(c => c.ship);
  if (!matches.length) return null;

  const user = await User.findOne({ userId });
  // Require ownership for ship selection: if the user isn't found or has no owned ships,
  // do not return an unowned match. This prevents fueling/setting ships the user does not own.
  if (!user || !Array.isArray(user.ownedCards)) return null;

  const ownedIds = user.ownedCards.map(e => e.cardId);
  const ownedMatches = matches.filter(m => ownedIds.includes(m.id));
  if (!ownedMatches.length) return null;

  // Prefer by team or favorites
  const preferred = preferMatchForUser(user, ownedMatches);
  if (preferred) return preferred;
  // fallback to highest mastery owned (last one)
  return ownedMatches[ownedMatches.length - 1];
}

// fuzzy search: return matched card definitions sorted by mastery asc
function searchCards(query) {
  if (!query) return [];
  const q = query.toLowerCase();
  const normalizedQuery = normalizeCardId(q);
  const matches = cards.filter(c => {
    const normalizedId = normalizeCardId(c.id);
    if (normalizedId === normalizedQuery) return true;
    if (normalizedId.includes(normalizedQuery) && /^[a-z]*\d+$/.test(q)) return true;
    if (c.character.toLowerCase().includes(q)) return true;
    if (c.title && c.title.toLowerCase().includes(q)) return true;
    if (Array.isArray(c.alias) && c.alias.some(a => a.toLowerCase().includes(q))) return true;
    return false;
  });
  return matches.sort((a,b)=> a.mastery - b.mastery);
}

function findFirstCard(query) {
  const results = searchCards(query);
  return results.length ? results[0] : null;
}

// Prefer a match from a user's context: team first, then exact favorite ids, then fallback
function preferMatchForUser(user, matches) {
  if (!user || !Array.isArray(matches) || matches.length === 0) return matches[0] || null;

  // Prefer exact favorite card id matches (preserve favorite order)
  if (Array.isArray(user.favoriteCards) && user.favoriteCards.length) {
    for (const favId of user.favoriteCards) {
      const found = matches.find(m => m.id === favId);
      if (found) return found;
    }
  }

  // Next prefer wishlist entries (preserve wishlist order)
  if (Array.isArray(user.wishlistCards) && user.wishlistCards.length) {
    for (const wishId of user.wishlistCards) {
      const found = matches.find(m => m.id === wishId);
      if (found) return found;
    }
  }

  // Then prefer team entries (preserve team order)
  if (Array.isArray(user.team) && user.team.length) {
    for (const teamId of user.team) {
      const found = matches.find(m => m.id === teamId);
      if (found) return found;
    }
  }

  // fallback to first match
  return matches[0] || null;
}

// Find the best (highest mastery) owned version of a card
async function findBestOwnedCard(userId, query) {
  const User = require('../models/User');
  const matches = searchCards(query);
  if (!matches.length) return null;
  
  const user = await User.findOne({ userId });
  if (!user || !user.ownedCards) return matches[0]; // fallback to base if no user

  // find all owned versions of this character
  const ownedIds = user.ownedCards.map(e => e.cardId);
  const ownedMatches = matches.filter(m => ownedIds.includes(m.id));

  if (ownedMatches.length) {
    // Prefer team / favorites
    const preferred = preferMatchForUser(user, ownedMatches);
    if (preferred) return preferred;
    // return highest mastery owned, or fallback to base if none owned
    return ownedMatches[ownedMatches.length - 1];
  }

  return matches[0];
}

// Simulate a pull with optional faculty filter and optional rod/mastery modifiers
function simulatePull(pityCount, faculty = null, options = {}) {
  const { rodMultiplier = 1, mastery = 1 } = options;
  const rateSource = pityCount >= PITY_TARGET ? PITY_DISTRIBUTION : PULL_RATES;
  const effectiveRates = getModifiedRates(rateSource, rodMultiplier);
  const rank = getRankFromDistribution(effectiveRates);

  let candidateCards = cards.filter(c => c.mastery === mastery && c.rank === rank && !isShipCard(c));
  if (mastery === 1) candidateCards = candidateCards.filter(c => c.pullable && !isShipCard(c));

  if (faculty) {
    const facultyCharacters = getFacultyCharacters(faculty);
    if (facultyCharacters.size === 0) {
      return null;
    }

    let eligibleCards = cards.filter(c => c.mastery === mastery && facultyCharacters.has(c.character) && !isShipCard(c));
    if (mastery === 1) {
      eligibleCards = eligibleCards.filter(c => c.pullable && !isShipCard(c));
    }

    if (eligibleCards.length === 0) {
      return null;
    }

    const allowedRanks = new Set(eligibleCards.map(c => c.rank));
    let selectedRank = getRankFromDistributionWithFilter(effectiveRates, allowedRanks);
    if (!selectedRank && rateSource === PITY_DISTRIBUTION) {
      selectedRank = getRankFromDistributionWithFilter(PULL_RATES, allowedRanks);
    }
    if (!selectedRank) return null;
    const pool = eligibleCards.filter(c => c.rank === selectedRank);
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  let pool = candidateCards;
  if (pool.length === 0) {
    pool = cards.filter(c => c.mastery === mastery);
    if (mastery === 1) pool = pool.filter(c => c.pullable);
  }

  if (pool.length === 0) {
    pool = cards.filter(c => c.pullable && c.mastery === 1);
  }

  if (pool.length === 0) {
    pool = cards.filter(c => c.pullable);
  }

  if (pool.length === 0) {
    return null;
  }

  // If a wishlist was provided in options, favor wishlisted cards when choosing.
  if (options && Array.isArray(options.wishlist) && options.wishlist.length) {
    return pickFromPoolWithWishlist(pool, options.wishlist);
  }

  return pool[Math.floor(Math.random() * pool.length)];
}


// Build a pull embed according to spec
function buildPullEmbed(card, username, avatarUrl, pityText, duplicateInfo, user, options = {}) {
  const attributeColors = {
    STR: '#ff4b4b',
    DEX: '#33cc33',
    QCK: '#3498ff',
    PSY: '#f5df4d',
    INT: '#9b59b6',
    BASE: '#FFFFFF'
  };
  const rankColor = rankData[card.rank] && rankData[card.rank].color;
  const cardAttrs = parseCardAttributes(card.attribute);
  let color;
  if (card && card.scount && Array.isArray(cardAttrs) && cardAttrs.length > 1) {
    color = '#000000';
  } else {
    color = attributeColors[cardAttrs[0]] || rankColor || '#2b2d31';
  }
  // Artifact and BASE pull embeds should always be white
  if (card && card.artifact) color = '#FFFFFF';
  if (cardAttrs[0] === 'BASE') color = '#FFFFFF';
  // same emoji handling as buildCardEmbed: transform `<:name:id>` into a CDN URL
  let iconVal = crewIcons[card.faculty];
  if (iconVal && iconVal.startsWith && iconVal.startsWith('<:')) {
    const m = iconVal.match(/<:[^:]+:(\d+)>/);
    if (m) iconVal = `https://cdn.discordapp.com/emojis/${m[1]}.png`;
  }
  const author = {};
  if (iconVal && pityText) {
    if (iconVal.startsWith && iconVal.startsWith('http')) {
      try { author.iconURL = normalizeGifUrl(iconVal); } catch (e) { author.iconURL = iconVal; }
    } else author.name = iconVal;
  }
  // always include a name field; use faculty if nothing else
  if (!author.name && pityText) author.name = card.faculty;

  // Determine whether to show the star icon for this pull. We show a star
  // if the card was favorited or wishlisted for the provided user, or if the
  // caller explicitly forces it via options.forceStar.
  const forcedStar = options && !!options.forceStar;
  const isFavPull = user && Array.isArray(user.favoriteCards) && user.favoriteCards.includes(card.id);
  const isWishPull = user && Array.isArray(user.wishlistCards) && user.wishlistCards.includes(card.id);
  const showStar = forcedStar || isFavPull || isWishPull;
  
  // Artifact cards use a simplified pull embed with boost/signature info
  // Artifacts always use the generated attachment image for consistency
  let embed = new EmbedBuilder().setColor(color).setTitle(`${showStar ? STAR_EMOJI + ' ' : ''}${card.character}`).setImage(card.artifact ? `attachment://artifact-${card.id}.png` : (card.image_url || null))
    .setFooter({ text: `ID ${formatCardId(card.id)}${pityText ? ` | ${pityText}` : ''}${duplicateInfo ? ` | ${duplicateInfo}` : ''}`, iconURL: avatarUrl || null });

  if (isShipCard(card)) {
    const descLines = [
      card.title || '',
      `**Rank:** ${card.rank}`,
      '',
      `**Income:** \`${card.incomeMultiplier}x\``,
      `**Capacity:** <:beri:1490738445319016651>${card.capacity}`
    ];
    const shipEmbed = new EmbedBuilder()
      .setColor(card.color || color)
      .setTitle(`${showStar ? STAR_EMOJI + ' ' : ''}${card.character}`)
      .setDescription(descLines.join('\n'))
      .setImage(card.image_url || null)
      .setFooter({ text: `ID ${formatCardId(card.id)}${duplicateInfo ? ` | ${duplicateInfo}` : ''}`, iconURL: avatarUrl || null });

    safeApplyAuthor(shipEmbed, author);
    return shipEmbed;
  }

  if (isArtifactCard(card)) {
    const boostSummary = getArtifactBoostSummary(card);
    const signatureLines = getArtifactSignatureLines(card);
    const descLines = [
      card.title || '',
      `**Rank:** ${card.rank}`
    ];
    if (boostSummary) {
      descLines.push('', `**Boost:** \`${boostSummary}\` Of all stats`);
    }
    if (signatureLines.length) {
      descLines.push('**Signature(s)**', ...signatureLines);
    }
    embed.setDescription(descLines.join('\n'));
  } else {
    // Calculate attack value for display (show per-target split when `count` is used)
    let attackVal;
    // Determine count/scount icons if present
    const pullCountIcon = card.countIcon || (card.count === 2 ? '<:2_:1503002986560094228>' : (card.count ? '<:3_:1503002985578365118>' : null));
    if (card.count && Number.isFinite(card.count) && card.count > 1) {
      const divisor = card.count;
      const minPer = Math.floor(card.attack_min / divisor);
      const maxPer = Math.floor(card.attack_max / divisor);
      attackVal = `${minPer} - ${maxPer}`;
    } else {
      attackVal = `${card.attack_min} - ${card.attack_max}`;
    }
    // Build stats field - exclude attack for cards that are pure boosts
    let statsText = `**Health:** ${card.health}\n**Power:** ${card.power}\n**Speed:** ${card.speed}`;
    if (!card.boost) {
      statsText += `\n**Attack:** ${attackVal}` + (pullCountIcon ? ` (${pullCountIcon})` : '');
    }
    const descLines = [
      card.title || '',
      `**Rank:** ${card.rank}`
    ];
    embed.setDescription(descLines.join('\n'));
    embed.addFields({ name: 'Stats', value: statsText, inline: false });
  }

  safeApplyAuthor(embed, author);

  if (card.title !== 'Random enemy') {
    // Prefer an explicit artifact thumbnail when the card is an artifact.
    if (card.artifact && artifactThumbnails && artifactThumbnails[card.rank]) {
      embed.setThumbnail(artifactThumbnails[card.rank]);
    } else {
      const emojiThumbnail = getEmojiImageUrl(card.emoji);
      if (emojiThumbnail) {
        embed.setThumbnail(emojiThumbnail);
      } else {
        const rankBadge = rankData[card.rank] && rankData[card.rank].badge;
        if (rankBadge) embed.setThumbnail(rankBadge);
        else if (iconVal && iconVal.startsWith && iconVal.startsWith('http')) {
          try { embed.setThumbnail(normalizeGifUrl(iconVal)); } catch (e) { embed.setThumbnail(iconVal); }
        }
      }
    }
  }

  return embed;
}

// Build a card embed according to spec
function normalizeEmoji(emoji) {
  return RANDOM_ENEMY_EMOJI_REMAP[emoji] || emoji;
}

function getEmojiImageUrl(emoji) {
  if (!emoji || typeof emoji !== 'string') return null;
  const normalized = normalizeEmoji(emoji);
  const match = normalized.match(/<a?:[^:]+:(\d+)>/);
  return match ? `https://cdn.discordapp.com/emojis/${match[1]}.png` : null;
}

// Consume 1 cola from user's active ship.
// Returns true if cola was consumed, false if no cola available or no active ship.
function consumeShipCola(user) {
  if (!user) return false;
  user.ships = user.ships || {};
  const shipId = user.activeShip;
  if (!shipId) return false;
  const shipDef = getShipById(shipId) || getCardById(shipId) || null;
  const defaultCola = shipDef ? (shipDef.cola !== undefined ? shipDef.cola : (shipDef.maxCola !== undefined ? shipDef.maxCola : 0)) : 0;
  if (!user.ships[shipId]) {
    user.ships[shipId] = { cola: defaultCola, maxCola: (shipDef && shipDef.maxCola !== undefined) ? shipDef.maxCola : defaultCola };
  }
  const shipState = user.ships[shipId];
  if (!shipState || (shipState.cola || 0) <= 0) return false;
  user.ships[shipId].cola = Math.max(0, (user.ships[shipId].cola || 0) - 1);
  // mark modified so mongoose will persist nested changes
  if (typeof user.markModified === 'function') user.markModified('ships');
  return true;
}

function buildCardEmbed(cardDef, userEntry, avatarUrl, user) {
  const attributeColors = {
    STR: '#ff4b4b',
    DEX: '#33cc33',
    QCK: '#3498ff',
    PSY: '#f5df4d',
    INT: '#9b59b6',
    BASE: '#FFFFFF'
  };
  let color;
  const rankColor = rankData[cardDef.rank] && rankData[cardDef.rank].color;
  if (cardDef.ship) {
    color = cardDef.color || rankColor || '#2b2d31';
  } else if (cardDef.artifact) {
    // Info embeds for artifacts should be white
    color = '#ffffff';
  } else {
    // Use attribute color first, then rank color, then a default.
    const defAttrs = parseCardAttributes(cardDef.attribute);
    if (cardDef && cardDef.scount && Array.isArray(defAttrs) && defAttrs.length > 1) {
      color = '#000000';
    } else {
      color = attributeColors[defAttrs[0]] || rankColor || '#2b2d31';
    }
  }
  let iconText = crewIcons[cardDef.faculty];
  let iconUrl = iconText;
  if (iconText && iconText.startsWith && iconText.startsWith('<:')) {
    const match = iconText.match(/<:[^:]+:(\d+)>/);
    if (match) {
      iconUrl = `https://cdn.discordapp.com/emojis/${match[1]}.png`;
    }
  }

  const author = {};
  if (iconUrl) {
    if (iconUrl.startsWith && iconUrl.startsWith('http')) {
      try { author.iconURL = normalizeGifUrl(iconUrl); } catch (e) { author.iconURL = iconUrl; }
    } else author.name = iconUrl;
  }
  if (!author.name) author.name = cardDef.faculty;

  const exactEntry = userEntry;
  const isOwned = !!userEntry;
  const lvl = exactEntry ? exactEntry.level : 1;
  const cardStats = getCardFinalStats(cardDef, lvl, user);
  const scaled = cardStats.scaled;
  const boostEntries = cardStats.boostEntries || [];
  // Whether to show the star icon for this card when rendering embeds.
  // Show for favorited or wishlisted cards (keeps behavior consistent
  // with `buildPullEmbed`).
  const showStar = user && (Array.isArray(user.favoriteCards) && user.favoriteCards.includes(cardDef.id) || Array.isArray(user.wishlistCards) && user.wishlistCards.includes(cardDef.id));

  if (cardDef.ship) {
    const isActiveShip = user && user.activeShip === cardDef.id;
    const shipBalance = isActiveShip
      ? Math.floor((typeof user?.shipBalance === 'number') ? user.shipBalance : (cardDef.startingBalance !== undefined ? cardDef.startingBalance : 0))
      : null;
    const isMaxed = shipBalance !== null && shipBalance >= cardDef.capacity;
    const descLines = [
      cardDef.title || '',
      '',
      `**Rank:** ${cardDef.rank}`,
      `**Capacity:** <:beri:1490738445319016651>${cardDef.capacity}`,
      `**Income:** \`${cardDef.incomeMultiplier}x\``,
      `**Owned:** ${isOwned ? 'Yes' : 'No'}`,
    ];
    if (shipBalance !== null) {
      descLines.push('', `**Earnings:** <:beri:1490738445319016651>${shipBalance}${isMaxed ? ' *max*' : ''}`);
    }

    const isFav = user && Array.isArray(user.favoriteCards) && user.favoriteCards.includes(cardDef.id);
    const isWish = user && Array.isArray(user.wishlistCards) && user.wishlistCards.includes(cardDef.id);
    const titleText = isFav ? `${STAR_EMOJI} ${cardDef.character}` : (isWish ? `${WISH_EMOJI} ${cardDef.character}` : `${cardDef.character}`);
    const shipEmbed = new EmbedBuilder()
      .setColor(color)
      .setTitle(titleText)
      .setDescription(descLines.join('\n'))
      .setImage(cardDef.image_url || null)
      .setFooter({ text: `ID ${formatCardId(cardDef.id) || 'unknown'}`, iconURL: avatarUrl || null });

    if (iconUrl) {
      shipEmbed.setThumbnail(iconUrl);
    }

    safeApplyAuthor(shipEmbed, author);

    // Show Cola status for ships (per-user state if available, otherwise show card defaults)
    const shipState = user && user.ships ? (user.ships[cardDef.id] || null) : null;
    const currCola = shipState && typeof shipState.cola === 'number' ? shipState.cola : (cardDef.cola !== undefined ? cardDef.cola : null);
    const maxCola = (cardDef.maxCola !== undefined) ? cardDef.maxCola : (shipState && typeof shipState.maxCola === 'number' ? shipState.maxCola : null);
    if (currCola !== null && maxCola !== null) {
      const colaBar = buildDurabilityBar(currCola, maxCola, 'ship');
      shipEmbed.addFields({ name: 'Cola', value: `${colaBar} (${currCola}/${maxCola})`, inline: false });
    }

    return shipEmbed;
  }

  if (isArtifactCard(cardDef)) {
    const artifactAttrs = parseCardAttributes(cardDef.attribute);
    const attributeIcon = artifactAttrs.length > 1 ? artifactAttrs.map(getAttributeEmoji).join('/') : (artifactAttrs[0] ? getAttributeEmoji(artifactAttrs[0]) : null);
    const boostSummary = getArtifactBoostSummary(cardDef, lvl);
    const signatureLines = getArtifactSignatureLines(cardDef);
    const wielderLine = exactEntry && exactEntry.equippedTo
      ? (() => {
        const targetCard = cards.find(c => c.id === exactEntry.equippedTo);
        if (targetCard) return `**Wielder:** ${targetCard.emoji ? `${targetCard.emoji} ` : ''}${targetCard.character}`;
        return '**Wielder:** Unknown';
      })()
      : null;

    const descLines = [cardDef.title || ''];
    if (attributeIcon) descLines.push('', `**Attribute:** ${attributeIcon}`);
    if (wielderLine) descLines.push(wielderLine);
    if (exactEntry) {
      descLines.push(`**Level:** ${lvl}${typeof exactEntry.xp === 'number' ? ` (XP: ${exactEntry.xp})` : ''}`);
    }
    descLines.push(`**Owned:** ${isOwned ? 'Yes' : 'No'}`);
    descLines.push(`**Rank:** ${cardDef.rank}`);
    if (signatureLines.length) {
      descLines.push('', '**Signature(s)**', ...signatureLines);
    }
    // Also show explicit per-target/stat boost lines for artifacts so users
    // can see something like: "Boosts Usopp — Health by `5%`" on the info
    // embed. Use the same parser as other boost helpers to remain consistent
    // with how boosts are authored in `data/cards.js`.
    const parsedBoosts = parseBoostTargets(cardDef.boost);
    if (parsedBoosts.length) {
      const capitalize = (s) => String(s || '').trim().replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
      // If there's only one signature, omit repeating the target name and
      // show only the stat/amount (e.g. "All stats by `20%`" or "Attack by `10%`").
      if (parsedBoosts.length === 1) {
        const b = parsedBoosts[0];
        if (!b.stat) {
          descLines.push('', '**Boost(s)**', `All stats by \`${b.pct}%\``);
        } else {
          descLines.push('', '**Boost(s)**', `${capitalize(b.stat)} by \`${b.pct}%\``);
        }
      } else {
        // If all parsed boosts share the same stat (or all-stats) AND the same
        // percentage, collapse into a single line like "Attack by `20%`".
        const normalizeStatKey = (s) => {
          if (!s) return 'all';
          const k = String(s).toLowerCase().trim();
          if (k === 'hp') return 'health';
          if (k === 'atk' || k === 'att') return 'attack';
          return k;
        };
        const firstKey = normalizeStatKey(parsedBoosts[0].stat);
        const firstPct = parsedBoosts[0].pct;
        const allSame = parsedBoosts.every(b => normalizeStatKey(b.stat) === firstKey && b.pct === firstPct);
        if (allSame) {
          if (firstKey === 'all') {
            descLines.push('', '**Boost(s)**', `All stats by \`${firstPct}%\``);
          } else {
            const label = capitalize(firstKey);
            descLines.push('', '**Boost(s)**', `${label} by \`${firstPct}%\``);
          }
        } else {
          const boostLines = parsedBoosts.map(b => {
            const statLabel = b.stat ? capitalize(b.stat) : 'All';
            // target emoji if available
            let emoji = '';
            const crew = crews.find(cr => cr.name.toLowerCase().replace(/[- ]/g, '') === b.target.toLowerCase().replace(/[- ]/g, ''));
            if (crew && crew.icon) emoji = `${crew.icon} `;
            else {
              const targetCard = cards.find(c => c.character.toLowerCase() === b.target.toLowerCase());
              if (targetCard && targetCard.emoji) emoji = `${targetCard.emoji} `;
            }
            if (!b.stat) {
              return `${emoji}All ${b.target}'s stats by \`${b.pct}%\``;
            }
            return `${emoji}${b.target}'s ${statLabel} by \`${b.pct}%\``;
          });
          descLines.push('', '**Boost(s)**', ...boostLines);
        }
      }
    }

    const isFavA = user && Array.isArray(user.favoriteCards) && user.favoriteCards.includes(cardDef.id);
    const isWishA = user && Array.isArray(user.wishlistCards) && user.wishlistCards.includes(cardDef.id);
    // For artifacts pulled in a pull/pack, show a star if the card was favorited
    // or wishlisted at the time of the pull (or forced via options).
    const artifactTitle = showStar ? `${STAR_EMOJI} ${cardDef.character}` : `${cardDef.character}`;
    const artifactEmbed = new EmbedBuilder()
      .setColor(color)
      .setTitle(artifactTitle)
      .setDescription(descLines.join('\n'))
      // Artifacts use a generated attachment image for consistent visuals.
      .setImage(`attachment://artifact-${cardDef.id}.png`)
      .setFooter({ text: `ID ${formatCardId(cardDef.id) || 'unknown'}`, iconURL: avatarUrl || null });

    if (cardDef.title !== 'Random enemy') {
      // Prefer configured artifact thumbnail first, then emoji, then rank badge.
      if (artifactThumbnails && artifactThumbnails[cardDef.rank]) {
        artifactEmbed.setThumbnail(artifactThumbnails[cardDef.rank]);
      } else {
        const emojiThumbnail = getEmojiImageUrl(cardDef.emoji);
        if (emojiThumbnail) {
          artifactEmbed.setThumbnail(emojiThumbnail);
        } else {
          const rankBadge = rankData[cardDef.rank] && rankData[cardDef.rank].badge;
          if (rankBadge) artifactEmbed.setThumbnail(rankBadge);
          else if (iconUrl && iconUrl.startsWith && iconUrl.startsWith('http')) {
            try { artifactEmbed.setThumbnail(normalizeGifUrl(iconUrl)); } catch (e) { artifactEmbed.setThumbnail(iconUrl); }
          }
        }
      }
    }

    safeApplyAuthor(artifactEmbed, author);
    return artifactEmbed;
  }

  // Title line: Card name (biggest), title next to it
  let titleLine = cardDef.character;
  if (cardDef.title) titleLine += ` — ${cardDef.title}`;
  // Blank line after title
  // Dex/attribute emoji below title, above level
  const cardAttrIcons = parseCardAttributes(cardDef.attribute);
  const attributeIcon = cardAttrIcons.length > 1 ? cardAttrIcons.map(getAttributeEmoji).join('/') : (cardAttrIcons[0] ? getAttributeEmoji(cardAttrIcons[0]) : null);
  const descLines = [
          `${titleLine}`,
          '',
          `**Attribute:** ${attributeIcon}`
  ];
  if (exactEntry) {
    const { getMaxLevelForRank: _getMaxLvl } = require('../utils/starLevel');
    const _maxLevel = _getMaxLvl(cardDef.rank);
    const _isAtMax = lvl >= _maxLevel;
    descLines.push(`**Level:** ${lvl}${_isAtMax ? ' (max)' : (typeof exactEntry.xp === 'number' ? ` (xp: ${exactEntry.xp})` : '')}`);
  }
  descLines.push(`**Owned:** ${isOwned ? 'Yes' : 'No'}`);
  descLines.push(`**Rank:** ${cardDef.rank}`);

  const isFavN = user && Array.isArray(user.favoriteCards) && user.favoriteCards.includes(cardDef.id);
  const isWishN = user && Array.isArray(user.wishlistCards) && user.wishlistCards.includes(cardDef.id);
  const normalTitle = showStar ? `${STAR_EMOJI} ${cardDef.character}` : `${cardDef.character}`;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(normalTitle)
    .setDescription(descLines.join('\n'))
    .setImage(cardDef.image_url || null)
    .setFooter({ text: `ID ${formatCardId(cardDef.id) || 'unknown'}`, iconURL: avatarUrl || null });

  safeApplyAuthor(embed, author);

  if (cardDef.title !== 'Random enemy') {
    const emojiThumbnail = getEmojiImageUrl(cardDef.emoji);
    if (emojiThumbnail) {
      embed.setThumbnail(emojiThumbnail);
    } else {
      const rankBadge = rankData[cardDef.rank] && rankData[cardDef.rank].badge;
      if (rankBadge) embed.setThumbnail(rankBadge);
      else if (iconUrl && iconUrl.startsWith && iconUrl.startsWith('http')) {
        try { embed.setThumbnail(normalizeGifUrl(iconUrl)); } catch (e) { embed.setThumbnail(iconUrl); }
      }
    }
  }

  const statsLines = [
      `**Health:** ${scaled.health}`,
  ];
  // Only show power if not a boost card, or if power > 1
  if (!cardDef.boost || scaled.power > 1) {
    statsLines.push(`**Power:** ${scaled.power}`);
  }
  statsLines.push(`**Speed:** ${scaled.speed}`);
  if (!cardDef.boost) {
    const infoCountIcon = cardDef.countIcon || (cardDef.count === 2 ? '<:2_:1503002986560094228>' : (cardDef.count ? '<:3_:1503002985578365118>' : null));
    if (cardDef.count && Number.isFinite(cardDef.count) && cardDef.count > 1) {
      const divisor = cardDef.count;
      const perMin = Math.floor(scaled.attack_min / divisor);
      const perMax = Math.floor(scaled.attack_max / divisor);
      statsLines.push(`**Attack:** ${perMin} - ${perMax}` + (infoCountIcon ? ` (${infoCountIcon})` : ''));
    } else {
      statsLines.push(`**Attack:** ${scaled.attack_min} - ${scaled.attack_max}` + (infoCountIcon ? ` (${infoCountIcon})` : ''));
    }
  } else {
    // Show boost line with correct emoji(s), stat, and percent
    const targets = [];
    if (cardDef.boost) {
      // Regex: target, optional stat, percent
      const regex = /([\w .'-]+?)(?:,\s*([\w ]+))?\s*\((\d+)%\)/gi;
      let match;
      const boostsByPct = {};
      while ((match = regex.exec(cardDef.boost)) !== null) {
        const targetName = match[1].trim();
        const stat = match[2] ? match[2].trim() : null;
        const pct = match[3];
        // Find emoji for target (crew or card)
        let emoji = '';
        const crew = crews.find(cr => cr.name.toLowerCase().replace(/-/g, '').replace(/ /g, '') === targetName.toLowerCase().replace(/-/g, '').replace(/ /g, ''));
        if (crew && crew.icon) emoji = crew.icon;
        else {
          const targetCard = cards.find(c => c.character === targetName);
          if (targetCard && targetCard.emoji) emoji = targetCard.emoji;
        }
        // Group by percentage and stat to combine emojis
        const key = `${pct}|${stat || 'all'}`;
        if (!boostsByPct[key]) {
          boostsByPct[key] = { emojis: [], pct, stat };
        }
        if (emoji) boostsByPct[key].emojis.push(emoji);
      }
      // Create boost lines with combined emojis
      Object.values(boostsByPct).forEach(boost => {
        const emojiStr = boost.emojis.join(' ');
        if (boost.stat) {
          targets.push(`${emojiStr} Boosted by \`${boost.pct}%\` of ${boost.stat}`.trim());
        } else {
          targets.push(`${emojiStr} Boosted by \`${boost.pct}%\` of all stats`.trim());
        }
      });
    }
    if (targets.length) {
      statsLines.push(`**Boost:** ${targets.join('\n')}`);
    } else {
      statsLines.push(`**Boost:** Boost card`);
    }
  }
  embed.addFields({ name: 'Stats', value: statsLines.join('\n'), inline: false });

  if (cardDef.special_attack && scaled.special_attack) {
    const { isSpecialAttackUnlocked: _isSpecUnlocked, isStatusEffectUnlocked: _isEffUnlocked } = require('../utils/starLevel');
    const _cardStarForSpec = exactEntry ? (exactEntry.starLevel || 0) : 0;
    if (exactEntry && !_isSpecUnlocked(_cardStarForSpec)) {
      embed.addFields({ name: 'Special Attack', value: '<:lock:1504265310893637724> Locked — Reach **Star Level 4** to unlock', inline: false });
    } else {
      const sa = cardDef.special_attack;
      const normalizedEffectAmount = cardDef.effectAmount !== undefined
        ? normalizeEffectValue(cardDef.effectAmount, cardDef.effect === 'regen' ? 10 : 12)
        : null;
      const normalizedEffectChance = cardDef.effectChance !== undefined
        ? normalizeEffectValue(cardDef.effectChance, 50)
        : null;
      const infoScountIcon = cardDef.scountIcon || (cardDef.scount === 2 ? '<:2_:1503002986560094228>' : (cardDef.scount ? '<:3_:1503002985578365118>' : null));
      let specialAttackValue;
      if (cardDef.scount && Number.isFinite(cardDef.scount) && cardDef.scount > 1) {
        const divisor = cardDef.scount;
        const perMin = Math.floor(scaled.special_attack.min / divisor);
        const perMax = Math.floor(scaled.special_attack.max / divisor);
        specialAttackValue = `${sa.name} (${perMin}-${perMax} Atk)` + (infoScountIcon ? ` ${infoScountIcon}` : '');
      } else {
        specialAttackValue = `${sa.name} (${scaled.special_attack.min}-${scaled.special_attack.max} Atk)` + (infoScountIcon ? ` ${infoScountIcon}` : '');
      }
      if (cardDef.effect) {
        if (!exactEntry || _isEffUnlocked(_cardStarForSpec)) {
          const effDur = (cardDef.effectDuration !== undefined && cardDef.effectDuration !== null)
            ? cardDef.effectDuration
            : (cardDef.effect === 'doomed' ? 3 : 1);
          const effectDesc = cardDef.effect === 'undead' && cardDef.itself
            ? 'Keeps itself alive at 1 HP until the effect ends'
            : getEffectDescription(cardDef.effect, effDur, !!cardDef.itself, normalizedEffectAmount, normalizedEffectChance, !!cardDef.scount);
          if (effectDesc) {
            let amountLabel = '';
            if (['cut', 'bleed'].includes(cardDef.effect)) {
              const amount = normalizeEffectValue(cardDef.effectAmount, cardDef.effect === 'cut' ? 1 : 2);
              amountLabel = ` (${amount} damage)`;
            } else if (cardDef.effect === 'acid') {
              const amount = normalizeEffectValue(cardDef.effectAmount, 1);
              amountLabel = ` (${amount} initial)`;
            } else if (cardDef.effect === 'prone' && cardDef.effectAmount !== undefined) {
              const amount = normalizeEffectValue(cardDef.effectAmount, 20);
              amountLabel = ` (${amount}% extra)`;
            } else if (cardDef.effect === 'hungry') {
              const amount = normalizeEffectValue(cardDef.effectAmount, 1);
              amountLabel = ` (${amount} damage/turn)`;
            }
            specialAttackValue += ` - *${effectDesc}${amountLabel}*`;
          }
        } else {
          specialAttackValue += ` - <:lock:1504265310893637724> *Status Effect locked (Star 5 required)*`;
        }
      }
      embed.addFields({ name: 'Special Attack', value: specialAttackValue, inline: false });
    }
  }

    if (cardDef.effect && (!cardDef.special_attack || !scaled.special_attack)) {
      const normalizedEffectAmount = cardDef.effectAmount !== undefined
        ? normalizeEffectValue(cardDef.effectAmount, cardDef.effect === 'regen' ? 10 : 12)
        : null;
      const normalizedEffectChance = cardDef.effectChance !== undefined
        ? normalizeEffectValue(cardDef.effectChance, 50)
        : null;
      const effDur = (cardDef.effectDuration !== undefined && cardDef.effectDuration !== null)
        ? cardDef.effectDuration
        : (cardDef.effect === 'doomed' ? 3 : 1);
      const effectDescription = getEffectDescription(cardDef.effect, effDur, !!cardDef.itself, normalizedEffectAmount, normalizedEffectChance, !!cardDef.count);
      if (effectDescription) {
        embed.addFields({ name: 'Effect', value: effectDescription, inline: false });
      }
    }
  // Star Level field — only shown if the user owns the card
  if (exactEntry) {
    const { buildStarDisplay: _bsdField } = require('../utils/starLevel');
    const _cardStarField = exactEntry.starLevel || 0;
    embed.addFields({ name: 'Star Level', value: _bsdField(cardDef.attribute, _cardStarField, cardDef.rank), inline: false });
  }

  return embed;
}

function computeScaledStats(cardDef, level, boostPct = 0, statBoosts = {}, starLevel = 0) {
  // 0.1% per level + 1% per star level (e.g. lvl 20 = 2%, star 6 = 6%, total 8%)
  const levelMultiplier = 1 + (level || 0) * 0.001 + (starLevel || 0) * 0.01;
  const base = {
    power: Math.ceil(cardDef.power * levelMultiplier),
    health: Math.ceil(cardDef.health * levelMultiplier),
    speed: Math.ceil(cardDef.speed * levelMultiplier),
    attack_min: Math.ceil(cardDef.attack_min * levelMultiplier),
    attack_max: Math.ceil(cardDef.attack_max * levelMultiplier)
  };
  // Apply all-stats boost
  if (boostPct > 0) {
    const boostMultiplier = 1 + boostPct / 100;
    base.power = Math.ceil(base.power * boostMultiplier);
    base.health = Math.ceil(base.health * boostMultiplier);
    base.speed = Math.ceil(base.speed * boostMultiplier);
    base.attack_min = Math.ceil(base.attack_min * boostMultiplier);
    base.attack_max = Math.ceil(base.attack_max * boostMultiplier);
  }
  // Apply stat-specific boosts
  if (statBoosts && typeof statBoosts === 'object') {
    for (const [stat, pct] of Object.entries(statBoosts)) {
      const statKey = stat.toLowerCase();
      if (base.hasOwnProperty(statKey)) {
        const multiplier = 1 + pct / 100;
        base[statKey] = Math.ceil(base[statKey] * multiplier);
      } else if (statKey === 'health') {
        base.health = Math.ceil(base.health * (1 + pct / 100));
      } else if (statKey === 'power') {
        base.power = Math.ceil(base.power * (1 + pct / 100));
      } else if (statKey === 'speed') {
        base.speed = Math.ceil(base.speed * (1 + pct / 100));
      } else if (statKey === 'attack') {
        base.attack_min = Math.ceil(base.attack_min * (1 + pct / 100));
        base.attack_max = Math.ceil(base.attack_max * (1 + pct / 100));
      }
    }
  }
  // also scale special attack if present
  if (cardDef.special_attack) {
    const sa = cardDef.special_attack;
    let min = Math.ceil(sa.min_atk * levelMultiplier);
    let max = Math.ceil(sa.max_atk * levelMultiplier);
    if (boostPct > 0) {
      const boostMultiplier = 1 + boostPct / 100;
      min = Math.ceil(min * boostMultiplier);
      max = Math.ceil(max * boostMultiplier);
    }
    // Apply stat-specific boost to special attack if relevant
    if (statBoosts && typeof statBoosts === 'object' && statBoosts['attack']) {
      const atkMultiplier = 1 + statBoosts['attack'] / 100;
      min = Math.ceil(min * atkMultiplier);
      max = Math.ceil(max * atkMultiplier);
    }
    base.special_attack = { min, max };
  }
  return base;
}

// alias for clarity.  the `isail` command and other places talk about final
// stats which are just the base values scaled by level and boosts.  the
// original name `computeScaledStats` has been around for a while and is still
// exported for backward compatibility, but this helper makes the intent a bit
// clearer when reading code elsewhere (e.g. `calculateFinalStats(...)`).
function calculateFinalStats(cardDef, level, boostPct = 0) {
  return computeScaledStats(cardDef, level, boostPct);
}

// expose helper for other modules to describe status effects on attacks
function normalizeGifUrl(url) {
  if (!url || typeof url !== 'string') return url;  // Handle direct media.tenor.com URLs (e.g., https://media1.tenor.com/m/{id}/{name}.gif)
  const directMediaMatch = url.match(/^https?:\/\/media\d*\.tenor\.com\/(.+)$/i);
  if (directMediaMatch) {
    // Normalize to media.tenor.com (Discord sometimes has issues with media1, media2, etc.)
    return `https://media.tenor.com/${directMediaMatch[1]}`;
  }  const tenorShortMatch = url.match(/^https?:\/\/(?:www\.)?tenor\.com\/([A-Za-z0-9_-]+)(?:\.gif)?(?:\?.*)?$/i);
  if (tenorShortMatch) {
    return `https://media.tenor.com/${tenorShortMatch[1]}.gif`;
  }
  const tenorViewMatch = url.match(/^https?:\/\/(?:www\.)?tenor\.com\/view\/[^/]+-(\d+)(?:\?.*)?$/i);
  if (tenorViewMatch) {
    return `https://media.tenor.com/${tenorViewMatch[1]}.gif`;
  }
  return url;
}

function normalizeEffectValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getEffectDescription(effectType, duration, isSelf = false, effectAmount = null, effectChance = null, isMultiTarget = false) {
  const isPermanent = duration === -1;
  const durationText = isPermanent ? '' : `${duration} turn${duration > 1 ? 's' : ''}`;
  const targetLabel = isSelf ? 'own' : `opponent${isMultiTarget ? 's' : ''}'s`;
  const targetWord = isSelf ? 'target' : `opponent${isMultiTarget ? 's' : ''}`;
  const amount = (effectAmount !== null && effectAmount !== undefined)
    ? normalizeEffectValue(effectAmount, effectType === 'regen' ? 10 : 12)
    : (['attackup', 'attackdown', 'defenseup', 'defensedown'].includes(effectType) ? 12 : (effectType === 'regen' ? 10 : null));
  const chance = (effectChance !== null && effectChance !== undefined)
    ? normalizeEffectValue(effectChance ?? effectAmount, 50)
    : null;
  const amountText = ['attackup', 'attackdown', 'defenseup', 'defensedown'].includes(effectType)
    ? (amount !== null ? ` ${amount}%` : '')
    : effectType === 'regen'
      ? (amount !== null ? ` (${amount}%)` : '')
      : effectType === 'confusion'
        ? (chance !== null ? ` (${chance}% chance)` : '')
        : effectType === 'drunk'
          ? (chance !== null ? ` (${chance}% wrong target chance)` : '')
          : effectType === 'bleed' || effectType === 'cut'
            ? (amount !== null ? ` (${amount} damage)` : '')
            : '';

  const effectDescriptions = {
    regen: isPermanent
      ? `Permanently regenerates HP each turn${amountText}`
      : `Regenerates HP each turn${durationText ? ` for ${durationText}` : ''}${amountText}`,
    confusion: `Confuses the ${targetWord}${durationText ? ` for ${durationText}` : ''}${amountText}`,
    drunk: `Makes the ${targetWord} drunk${durationText ? ` for ${durationText}` : ''}${amountText}`,
    doomed: isPermanent
      ? `Dooms the ${targetWord} (dies instantly)`
      : `Dooms the ${targetWord} — dies in ${durationText || '1 turn'}`,
    attackup: isPermanent
      ? `Permanently boosts ${targetLabel} attack${amountText ? ` by${amountText}` : ''}`
      : `Boosts ${targetLabel} attack${durationText ? ` for ${durationText}` : ''}${amountText ? ` by${amountText}` : ''}`,
    attackdown: isPermanent
      ? `Permanently reduces ${targetLabel} attack${amountText ? ` by${amountText}` : ''}`
      : `Reduces ${targetLabel} attack${durationText ? ` for ${durationText}` : ''}${amountText ? ` by${amountText}` : ''}`,
    defenseup: isPermanent
      ? `Permanently boosts ${targetLabel} defense${amountText ? ` by${amountText}` : ''}`
      : `Boosts ${targetLabel} defense${durationText ? ` for ${durationText}` : ''}${amountText ? ` by${amountText}` : ''}`,
    defensedown: isPermanent
      ? `Permanently reduces ${targetLabel} defense${amountText ? ` by${amountText}` : ''}`
      : `Reduces ${targetLabel} defense${durationText ? ` for ${durationText}` : ''}${amountText ? ` by${amountText}` : ''}`,
    truesight: `Can't be attacked${durationText ? ` for ${durationText}` : ''}`,
    undead: `Keeps the target alive at 0 HP until the effect ends`,
    stun: `Stuns the ${targetWord}${durationText ? ` for ${durationText}` : ''}`,
    freeze: `Freezes the ${targetWord}${durationText ? ` for ${durationText}` : ''}`,
    cut: `Cuts the ${targetWord}${durationText ? ` for ${durationText}` : ''}`,
    bleed: `Bleeds the ${targetWord}${durationText ? ` for ${durationText}` : ''}`,
    prone: `Makes the ${targetWord} prone${durationText ? ` for ${durationText}` : ''}${amount !== null ? ` (${amount}% extra)` : ''}`,
    reflect: `Reflects attacks${durationText ? ` for ${durationText}` : ''}`,
  };
  return effectDescriptions[effectType] || null;
}

// Apply XP to an equipped artifact when its host card gains XP
function applyXpToEquippedArtifact(user, cardEntry, xpGain) {
  if (!user || !Array.isArray(user.ownedCards) || !cardEntry) return;

  // Find all artifacts equipped to this card and apply XP to each (supports
  // multiple artifacts equipped to the same host, e.g., Zoro's special slot).
  const artifacts = user.ownedCards.filter(a => a.equippedTo === cardEntry.cardId && isArtifactCard(getCardById(a.cardId)));
  if (!artifacts.length) return;

  for (const artifact of artifacts) {
    artifact.xp = (artifact.xp || 0) + xpGain;
    const artifactLevelsGained = Math.floor(artifact.xp / 100);
    if (artifactLevelsGained > 0) {
      artifact.level = (artifact.level || 1) + artifactLevelsGained;
      artifact.xp = artifact.xp % 100;
    }
  }

  if (typeof user.markModified === 'function') user.markModified('ownedCards');
}

module.exports = {
  searchCards,
  findFirstCard,
  findBestOwnedCard,
  buildPullEmbed,
  buildCardEmbed,
  computeScaledStats,
  calculateFinalStats,
  getCardById,
  getAllCardVersions,
  findBestOwnedVersion,
  findBestOwnedShip,
  getEffectDescription,
  normalizeGifUrl,
  getCardFinalStats,
  getAttributeEmoji,
  parseCardAttributes,
  buildDurabilityBar,
  simulatePull,
  pickFromPoolWithWishlist,
  isArtifactCard,
  isShipCard,
  getShipById,
  updateShipBalance,
  formatCardId,
  consumeShipCola,
  applyXpToEquippedArtifact,
};
