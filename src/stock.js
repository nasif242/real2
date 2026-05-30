const fs = require('fs');
const path = require('path');
const crews = require('../data/crews');

const STOCK_FILE = path.join(__dirname, '..', 'stock.json');
const PULL_FILE = path.join(__dirname, '..', 'pull.json');


// Pricing based on rank
const PRICING = {
  'D': 1,
  'C': 2,
  'B': 3,
  'A': 5,
  'S': 7,
  'SS': 10,
  'UR': 25
};

let currentStock = [];
let lastStockReset = Date.now();
let lastPullReset = Date.now();
let globalClient = null;
let pendingResetNotification = false;
const SUPPORT_GUILD_ID = '1322627413234155520';

async function attemptResetNotify() {
  try {
    if (!globalClient) {
      console.warn('[reset-notify] attemptResetNotify called but Discord client not attached');
      pendingResetNotification = true;
      return;
    }
    const { getBotConfig } = require('../models/BotConfig');
    const resetsChannel = await getBotConfig('resetsChannel');
    console.log(`[reset-notify] attempt: resetsChannel from DB: ${resetsChannel || 'not configured'}`);
    if (!resetsChannel) {
      console.log('[reset-notify] No resetsChannel configured — skipping notification');
      pendingResetNotification = false;
      return;
    }
    const ch = await globalClient.channels.fetch(resetsChannel).catch((e) => {
      console.error(`[reset-notify] Failed to fetch channel ${resetsChannel}:`, e && e.message ? e.message : e);
      return null;
    });
    if (ch) {
      const roleMention = '<@&1389619213492158464>'; // kept for backwards compatibility
      await ch.send(`${roleMention} Pulls have been reset! you can start pulling in command channels.`)
        .then(() => console.log(`[reset-notify] Reset message sent successfully to #${ch.name} (${resetsChannel})`))
        .catch((e) => console.error(`[reset-notify] Failed to send reset message to ${resetsChannel}:`, e && e.message ? e.message : e));
    } else {
      console.warn(`[reset-notify] Channel ${resetsChannel} could not be fetched — message not sent`);
    }
    pendingResetNotification = false;
  } catch (err) {
    console.error('[reset-notify] attemptResetNotify error:', err);
  }
}

async function syncSupportServerMembers() {
  const User = require('../models/User');
  if (!globalClient) {
    console.log('[stock] syncSupportServerMembers: client not set, skipping support-server sync');
    return;
  }

  try {
    const guild = await globalClient.guilds.fetch(SUPPORT_GUILD_ID).catch(() => null);
    if (!guild) {
      console.log(`[stock] syncSupportServerMembers: support guild ${SUPPORT_GUILD_ID} not found. Clearing support flags.`);
      await User.updateMany({}, { supportServerMember: false }).catch(() => {});
      return;
    }

    const users = await User.find({}, 'userId supportServerMember').lean();
    if (!users || users.length === 0) return;

    const updates = [];
    const batchSize = 10;
    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      const promises = batch.map(async (u) => {
        try {
          const member = await guild.members.fetch(u.userId).catch(() => null);
          const isMember = !!member;
          if (u.supportServerMember !== isMember) return { userId: u.userId, isMember };
          return null;
        } catch (err) {
          return null;
        }
      });
      const results = await Promise.all(promises);
      for (const r of results) if (r) updates.push(r);
      if (i + batchSize < users.length) await new Promise(r => setTimeout(r, 800));
    }

    if (updates.length > 0) {
      const bulkOps = updates.map(u => ({ updateOne: { filter: { userId: u.userId }, update: { $set: { supportServerMember: u.isMember } } } }));
      await User.bulkWrite(bulkOps, { ordered: false }).catch(() => {});
      console.log(`[stock] Synced support server membership for ${updates.length} users`);
    } else {
      console.log('[stock] Support server membership already up-to-date');
    }
    // If we just discovered users who are support members but haven't had their bonus applied this cycle,
    // apply the bonus now (increment pullsRemaining by 1 up to PULL_LIMIT+1 and mark supportBonusApplied true).
    try {
      const { PULL_LIMIT } = require('../config');
      const lastResetBoundary = getPreviousPullResetDate();
      const pending = await User.find({ supportServerMember: true, supportBonusApplied: { $ne: true }, lastReset: { $gte: lastResetBoundary } });
      if (pending && pending.length > 0) {
        const grantOps = pending.map(u => {
          const eff = PULL_LIMIT + 1;
          const current = typeof u.pullsRemaining === 'number' && isFinite(u.pullsRemaining) ? Math.floor(u.pullsRemaining) : 0;
          const newVal = Math.min(current + 1, eff);
          return { updateOne: { filter: { userId: u.userId }, update: { $set: { pullsRemaining: newVal, supportBonusApplied: true } } } };
        });
        if (grantOps.length > 0) await User.bulkWrite(grantOps, { ordered: false }).catch(() => {});
        console.log(`[stock] Applied support bonus to ${grantOps.length} users discovered during sync.`);
      }
    } catch (errApply) {
      console.error('Error applying support bonuses during sync:', errApply);
    }
  } catch (err) {
    console.error('Error syncing support server members:', err);
  }
}


// decrement stock count for crew name, return false if insufficient
function decrementStock(crewName, amt) {
  const entry = currentStock.find(e => e.name === crewName);
  if (!entry) return false;
  if (entry.quantity < amt) return false;
  entry.quantity -= amt;
  saveStock();
  return true;
}

function loadStock() {
  try {
    if (fs.existsSync(STOCK_FILE)) {
      const data = JSON.parse(fs.readFileSync(STOCK_FILE, 'utf8'));
      // Only keep crews that still exist in crews.js
      currentStock = (data.stock || []).filter(c => crews.some(crew => crew.name === c.name)).map(c => {
        const crewDef = crews.find(crew => crew.name === c.name);
        return { ...crewDef, quantity: Math.min(c.quantity || (Math.floor(Math.random() * 3) + 1), 3) };
      });
      lastStockReset = data.lastReset || Date.now();
    }
  } catch (err) {
    console.error('Error loading stock:', err);
  }
}

function saveStock() {
  try {
    fs.writeFileSync(STOCK_FILE, JSON.stringify({ stock: currentStock, lastReset: lastStockReset }, null, 2));
  } catch (err) {
    console.error('Error saving stock:', err);
  }
}

function resetStock() {
  // Select 3 random crews from all available crews with equal probability
  const shuffled = [...crews].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 3);
  currentStock = selected.map(c => ({ ...c, quantity: Math.floor(Math.random() * 3) + 1 }));
  lastStockReset = Date.now();
  saveStock();
  console.log('Stock reset:', currentStock.map(c => `${c.name} (${c.quantity})`));
}

function getCurrentStockNames() {
  return currentStock.map(c => c.name);
}

function loadPullReset() {
  try {
    if (fs.existsSync(PULL_FILE)) {
      const data = JSON.parse(fs.readFileSync(PULL_FILE, 'utf8'));
      lastPullReset = data.lastReset || Date.now();
    }
  } catch (err) {
    console.error('Error loading pull reset:', err);
  }
}

function savePullReset() {
  try {
    // Preserve any existing fields (e.g., configured resetsChannel)
    let data = {};
    try {
      if (fs.existsSync(PULL_FILE)) data = JSON.parse(fs.readFileSync(PULL_FILE, 'utf8')) || {};
    } catch (e) {
      data = {};
    }
    data.lastReset = lastPullReset;
    fs.writeFileSync(PULL_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving pull reset:', err);
  }
}

async function resetPullCounter() {
  lastPullReset = Date.now();
  savePullReset();
  
  // Also reset all users' pull counts in the database
  const User = require('../models/User');
  const { PULL_LIMIT } = require('../config');
  const { cards } = require('../data/cards');
  const { getMaxStarForRank } = require('../utils/starLevel');
  const SPECIAL_PULL_CARD_IDS = ['4162', '4037', '3786'];
  
  try {
    // Compute pulls per-user honoring support membership and special max-star card bonuses
    const lastResetBoundary = getPreviousPullResetDate();

    // Precompute max star needed for special cards
    const specialMaxStars = {};
    for (const cid of SPECIAL_PULL_CARD_IDS) {
      const def = cards.find(c => c.id === cid);
      specialMaxStars[cid] = def ? getMaxStarForRank(def.rank) : 7;
    }

    // Iterate users in batches and apply calculated pullsRemaining
    const batchSize = 200;
    let bulkOps = [];
    const cursor = User.find({}, 'userId supportServerMember ownedCards').cursor();
    for (let user = await cursor.next(); user != null; user = await cursor.next()) {
      let extras = user.supportServerMember ? 1 : 0;
      const owned = user.ownedCards || [];
      for (const cid of SPECIAL_PULL_CARD_IDS) {
        const entry = owned.find(e => e.cardId === cid);
        if (entry && (entry.starLevel || 0) >= (specialMaxStars[cid] || 0)) extras += 1;
      }
      const newPulls = PULL_LIMIT + extras;
      bulkOps.push({ updateOne: { filter: { userId: user.userId }, update: { $set: { pullsRemaining: newPulls, supportBonusApplied: !!user.supportServerMember, lastReset: lastResetBoundary } } } });
      if (bulkOps.length >= batchSize) {
        await User.bulkWrite(bulkOps, { ordered: false }).catch(() => {});
        bulkOps = [];
      }
    }
    if (bulkOps.length > 0) {
      await User.bulkWrite(bulkOps, { ordered: false }).catch(() => {});
    }
    console.log('Pulls reset');
    // Try to notify configured channel; if client not available, defer notification
    try {
      if (globalClient) {
        await attemptResetNotify();
      } else {
        pendingResetNotification = true;
        console.warn('[reset-notify] Discord client not attached — will notify when available');
      }
    } catch (err2) {
      console.error('Error sending pull reset notification:', err2);
    }

    // Ensure drop timers/configs are reloaded after global resets so configured
    // drop channels are preserved and timers restarted if necessary.
    try {
      const dropsModule = require('../commands/drops');
      if (typeof dropsModule.initializeDrops === 'function') {
        // reinitialize with current client (no-op if client missing)
        dropsModule.initializeDrops(globalClient).catch(() => {});
      }
    } catch (e) {
      // best-effort; ignore
    }
  } catch (err) {
    console.error('Error resetting user pull counts:', err);
  }
}

function setClient(c) {
  globalClient = c;
  if (pendingResetNotification) {
    // Try to send any pending reset notification now that client is available
    attemptResetNotify().catch((e) => console.error('[reset-notify] deferred notify failed:', e));
  }
  // Kick off a background sync of support-server membership for all users
  (async () => {
    try {
      await syncSupportServerMembers();
    } catch (e) {
      console.error('Error during support-server membership sync:', e);
    }
  })();
}

function getNextStockResetDate() {
  // Always reset every 20 minutes from the last reset
  const last = lastStockReset || Date.now();
  return new Date(last + 20 * 60 * 1000);
}

function getTimeUntilNextStockReset() {
  const now = new Date();
  const nextReset = getNextStockResetDate();
  return Math.max(0, nextReset - now);
}

function getNextPullResetDate() {
  const now = new Date();
  const anchor = new Date(now);
  anchor.setHours(6, 0, 0, 0);

  if (now < anchor) {
    anchor.setDate(anchor.getDate() - 1);
  }

  const elapsed = now - anchor;
  const eightHours = 8 * 60 * 60 * 1000;
  const step = Math.floor(elapsed / eightHours) + 1;
  const nextReset = new Date(anchor.getTime() + step * eightHours);
  return nextReset;
}

function getPreviousPullResetDate() {
  const now = new Date();
  const anchor = new Date(now);
  anchor.setHours(6, 0, 0, 0);

  if (now < anchor) {
    anchor.setDate(anchor.getDate() - 1);
  }

  const elapsed = now - anchor;
  const eightHours = 8 * 60 * 60 * 1000;
  const step = Math.floor(elapsed / eightHours);
  return new Date(anchor.getTime() + step * eightHours);
}

function getTimeUntilNextPullReset() {
  const now = Date.now();
  const nextReset = getNextPullResetDate();
  return Math.max(0, nextReset - now);
}

function getCountdownString() {
  const ms = getTimeUntilNextStockReset();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m`;
}

function getStockCountdownString() {
  const ms = getTimeUntilNextStockReset();
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function ensureStockUpToDate() {
  const timeToStock = getTimeUntilNextStockReset();
  if (timeToStock <= 0) {
    resetStock();
    return true;
  }
  return false;
}

function getPullCountdownString() {
  const ms = getTimeUntilNextPullReset();
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function initStockSystem() {
  const hasStockFile = fs.existsSync(STOCK_FILE);
  loadStock();
  loadPullReset();

  const eightHours = 8 * 60 * 60 * 1000;

  // If stock file is missing, initialize for the first time.
  if (!hasStockFile) {
    resetStock();
  } else {
    // Check if stock needs reset based on time
    const timeToStock = getTimeUntilNextStockReset();
    if (timeToStock <= 0) {
      resetStock();
    }
  }

  // Check if we need to reset pull counter based on time
  const timeToPull = getTimeUntilNextPullReset();
  if (timeToPull <= 0) {
    console.log('Global pull reset was due while offline; resetting now.');
    resetPullCounter();
  }

  // Set interval to check every 5 seconds for resets
  setInterval(async () => {
    const timeToStock = getTimeUntilNextStockReset();
    if (timeToStock <= 0) {
      resetStock();
    }

    const timeToPull = getTimeUntilNextPullReset();
    if (timeToPull <= 0) {
      await resetPullCounter();
      resetStock(); // Also reset stock when pulls reset
    }
  }, 5000); // check every 5 seconds
}

module.exports = {
  initStockSystem,
  getCurrentStock: () => currentStock,
  getLastStockReset: () => lastStockReset,
  getPricing: () => PRICING,
  getCountdownString,
  getStockCountdownString,
  getPullCountdownString,
  getNextStockResetDate,
  getNextPullResetDate,
  getPreviousPullResetDate,
  getTimeUntilNextPullReset,
  ensureStockUpToDate,
  resetStock,
  resetPullCounter,
  setClient,
  decrementStock
};