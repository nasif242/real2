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
  
  try {
    await User.updateMany({}, { pullsRemaining: PULL_LIMIT, supportBonusApplied: false });
    console.log('Pulls reset');
    // If a client is set and a reset notification channel is configured, post a message
    try {
      if (globalClient) {
        const { getBotConfig } = require('../models/BotConfig');
        const resetsChannel = await getBotConfig('resetsChannel');
        if (resetsChannel) {
          const ch = await globalClient.channels.fetch(resetsChannel).catch(() => null);
          if (ch) {
            const roleMention = '<@&1389619213492158464>';
            ch.send(`${roleMention} Pulls have been reset! you can start pulling in command channels.`).catch(() => {});
          }
        }
      }
    } catch (err2) {
      console.error('Error sending pull reset notification:', err2);
    }
  } catch (err) {
    console.error('Error resetting user pull counts:', err);
  }
}

function setClient(c) {
  globalClient = c;
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