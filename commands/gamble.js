const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, StringSelectMenuBuilder, AttachmentBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const User = require('../models/User');
const { cards } = require('../data/cards');

const { OWNER_ID } = require('../config');
const { getBotConfig } = require('../models/BotConfig');

const GAMBLE_COOLDOWN_MS = 60 * 60 * 1000;

// In-memory sessions: userId → session
const gambleSessions = new Map();
// crash update intervals (userId -> intervalId)
const crashIntervals = new Map();

const ATTRIBUTE_COLORS = {
  INT: '#9966CC',
  PSY: '#FFD54F',
  DEX: '#44AA44',
  STR: '#FF4444',
  QCK: '#4DABF7'
};

const GAME_EMOJIS = {
  coin: '<:Untitleddesign:1507893497103913040>',
  blackjack: '<:blackjack:1507893867851157597>',
  roulette: '<:roulette:1507894367149621339>',
  slots: '<:slots:1507894799770976346>',
  crash: '<:crash:1507895089568026805>',
  towers: '<:tower:1507895575708831784>',
  scratch: '<:scratch:1507895905708281988>'
};

const HEADS_EMOJI_URL = 'https://cdn.discordapp.com/emojis/1507889461441069157.png';
const TAILS_EMOJI_URL = 'https://cdn.discordapp.com/emojis/1507889462645100554.png';

// ────────────────────────────────────────────
// UTILITY
// ────────────────────────────────────────────

function formatBeli(n) {
  return `¥${Math.floor(n).toLocaleString()}`;
}

function formatTimeLeft(ms) {
  if (ms <= 0) return 'Available!';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function extractEmojiId(emoji) {
  if (!emoji || typeof emoji !== 'string') return null;
  const m = emoji.match(/<a?:[^:]+:(\d+)>/);
  return m ? m[1] : null;
}

function getNamiMultiplier(user) {
  if (!user || !Array.isArray(user.ownedCards)) return 1.0;
  const namiIds = new Set(cards.filter(c => c.character === 'Nami').map(c => c.id));
  let boost = 0;
  for (const entry of user.ownedCards) {
    if (namiIds.has(entry.cardId) && (entry.starLevel || 0) >= 1) {
      boost += (entry.starLevel || 0) * 0.01;
    }
  }
  return parseFloat((1 + boost).toFixed(4));
}

function rollRank() {
  const r = Math.random() * 100;
  if (r < 20) return 'D';
  if (r < 40) return 'C';
  if (r < 60) return 'B';
  if (r < 80) return 'A';
  if (r < 98) return 'S';
  if (r < 99.9) return 'SS';
  return 'UR';
}

function getSlotPool() {
  return cards.filter(c => !c.ship && !c.artifact && c.emoji && c.character && c.rank && ['S','SS','UR'].includes(c.rank));
}

function rollSlotRank() {
  const r = Math.random() * 100;
  if (r < 80) return 'S';
  if (r < 98) return 'SS';
  return 'UR';
}

function rollSlotCard() {
  const rank = rollSlotRank();
  const pool = getSlotPool().filter(c => c.rank === rank);
  if (!pool.length) return getSlotPool()[Math.floor(Math.random() * getSlotPool().length)];
  return pool[Math.floor(Math.random() * pool.length)];
}

// ────────────────────────────────────────────
// BLACKJACK DECK
// ────────────────────────────────────────────

const BLACKJACK_DECK_ASSETS = {
  // Hearts
  'H_A': '', 'H_2': '', 'H_3': '', 'H_4': '', 'H_5': '', 'H_6': '', 'H_7': '',
  'H_8': '', 'H_9': '', 'H_10': '', 'H_J': '', 'H_Q': '', 'H_K': '',
  // Diamonds
  'D_A': '', 'D_2': '', 'D_3': '', 'D_4': '', 'D_5': '', 'D_6': '', 'D_7': '',
  'D_8': '', 'D_9': '', 'D_10': '', 'D_J': '', 'D_Q': '', 'D_K': '',
  // Clubs
  'C_A': '', 'C_2': '', 'C_3': '', 'C_4': '', 'C_5': '', 'C_6': '', 'C_7': '',
  'C_8': '', 'C_9': '', 'C_10': '', 'C_J': '', 'C_Q': '', 'C_K': '',
  // Spades
  'S_A': '', 'S_2': '', 'S_3': '', 'S_4': '', 'S_5': '', 'S_6': '', 'S_7': '',
  'S_8': '', 'S_9': '', 'S_10': '', 'S_J': '', 'S_Q': '', 'S_K': '',
  // Theme backing asset
  'CARD_BACK': ''
};

const BJ_VALUES = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const BJ_SUITS = ['H','D','C','S'];

function makeDeck() {
  const deck = [];
  for (const suit of BJ_SUITS) {
    for (const val of BJ_VALUES) {
      deck.push({ suit, val, key: `${suit}_${val}` });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function handTotal(hand) {
  let total = 0, aces = 0;
  for (const c of hand) {
    if (c.val === 'A') { aces++; total += 11; }
    else if (['J','Q','K'].includes(c.val)) total += 10;
    else total += parseInt(c.val, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function isBlackjack(hand) {
  return hand.length === 2 && handTotal(hand) === 21;
}

const SUIT_EMOJI = { H: '♥', D: '♦', C: '♣', S: '♠' };

function cardLabel(c) {
  return `${c.val}${SUIT_EMOJI[c.suit] || ''}`;
}

// Crash
function rollCrashAt() {
  return Math.min(100, Math.max(1.01, 0.99 / (Math.random() * 0.99)));
}

function crashCurrentMult(startTime) {
  const t = (Date.now() - startTime) / 1000;
  return parseFloat(Math.max(1.00, 1 + t * 0.18 + t * t * 0.004).toFixed(2));
}

// Towers
const TOWER_PAYOUTS = [1.3, 1.7, 2.3, 3.2, 5.0];

// Scratch prizes (will be scaled by bet/100)
// Scratch multipliers (applied to bet): 0.25x min, 2.5x max, ~60% win chance
const SCRATCH_MULTIPLIERS = [0.25, 0.5, 1.0, 1.5, 2.5];

function buildScratchGrid(bet) {
  const mults = SCRATCH_MULTIPLIERS;
  let tiles;
  if (Math.random() < 0.60) {
    // Win round: guarantee at least a pair of one multiplier
    const winIdx = Math.floor(Math.random() * mults.length);
    const winVal = Math.round(mults[winIdx] * bet);
    const isTriple = Math.random() < 0.25;
    const copies = isTriple ? 3 : 2;
    tiles = Array(copies).fill(winVal);
    // Fill remaining slots with the other multipliers (one each), then zeros
    mults.filter((_, i) => i !== winIdx).forEach(m => tiles.push(Math.round(m * bet)));
    while (tiles.length < 9) tiles.push(0);
  } else {
    // Loss round: all 5 multipliers unique (no pair possible), rest zeros
    tiles = mults.map(m => Math.round(m * bet));
    while (tiles.length < 9) tiles.push(0);
  }
  return tiles.sort(() => Math.random() - 0.5);
}

const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

// ────────────────────────────────────────────
// CANVAS: COIN FLIP
// ────────────────────────────────────────────

async function renderCoinCanvas(pick, result, done) {
  const w = 600, h = 320;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#2b2d31';
  ctx.fillRect(0, 0, w, h);

  const won = done && pick === result;

  let headsImg = null, tailsImg = null;
  try { headsImg = await loadImage(HEADS_EMOJI_URL); } catch (e) {}
  try { tailsImg = await loadImage(TAILS_EMOJI_URL); } catch (e) {}

  const drawSide = (cx, headerText, labelText, isResult) => {
    ctx.fillStyle = '#aaaaaa';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(headerText, cx, 34);

    const r = 110;
    const cy = h / 2 + 20;

    let fill;
    if (!isResult) fill = '#444444';
    else if (done) fill = won ? '#2a2000' : '#222222';
    else fill = '#444444';

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, r - 6, 0, Math.PI * 2);
    ctx.strokeStyle = isResult && done ? (won ? '#ffd700' : '#555555') : '#555555';
    ctx.lineWidth = 4;
    ctx.stroke();

    const label = String(labelText || '').toLowerCase();
    if ((label === 'heads' || label === 'tails') && (headsImg || tailsImg)) {
      const img = label === 'heads' ? headsImg : tailsImg;
      if (img) {
        const iw = 140, ih = 140;
        ctx.drawImage(img, cx - iw / 2, cy - ih / 2, iw, ih);
        return;
      }
    }

    ctx.fillStyle = isResult && done && !won ? '#666666' : '#ffffff';
    ctx.font = `bold 18px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, cx, cy);
    ctx.textBaseline = 'alphabetic';
  };

  drawSide(w / 4, 'YOUR PICK', pick === '?' ? '?' : pick.toLowerCase(), false);
  drawSide((w * 3) / 4, 'RESULT', done ? result.toLowerCase() : '?', true);

  return canvas.toBuffer('image/png');
}

// ────────────────────────────────────────────
// CANVAS: ROULETTE
// ────────────────────────────────────────────

function renderRouletteCanvas(number, won) {
  const w = 740, h = 180;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#111111';
  ctx.fillRect(0, 0, w, h);

  const tileW = Math.floor((w - 20) / 37);
  const tileH = 96;
  const startY = (h - tileH) / 2;
  const startX = 10;

  for (let n = 0; n <= 36; n++) {
    const x = startX + n * tileW;
    let bg = n === 0 ? '#1a7a1a' : RED_NUMBERS.has(n) ? '#8b0000' : '#1a1a1a';

    if (n === number) {
      const glow = won ? '#ffd700' : '#ff4444';
      ctx.fillStyle = glow;
      ctx.fillRect(x - 3, startY - 8, tileW + 6, tileH + 16);
    }

    ctx.fillStyle = bg;
    ctx.fillRect(x + 1, startY, tileW - 2, tileH);

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${n >= 10 ? '10' : '12'}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), x + tileW / 2, startY + tileH / 2);
    ctx.textBaseline = 'alphabetic';
  }

  ctx.fillStyle = '#aaaaaa';
  ctx.font = '13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    number === 0 ? `▲ 0 — Green` : `▲ ${number} — ${RED_NUMBERS.has(number) ? 'Red' : 'Black'}`,
    startX + number * tileW + tileW / 2,
    h - 12
  );

  return canvas.toBuffer('image/png');
}

// ────────────────────────────────────────────
// CANVAS: CRASH
// ────────────────────────────────────────────

function renderCrashCanvas(displayMult, crashed, cashedAt) {
  const w = 700, h = 360;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#252550';
  ctx.lineWidth = 1;
  for (let x = 0; x <= w; x += 70) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y <= h; y += 60) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const maxMult = Math.max(displayMult * 1.4, 3);
  const steps = 60;
  const padX = 50, padY = 40;
  const graphW = w - padX * 2, graphH = h - padY * 2;

  const toCanvas = (mult) => ({
    x: padX + ((mult - 1) / (displayMult - 1 || 1)) * graphW * 0.85,
    y: h - padY - ((mult - 1) / (maxMult - 1)) * graphH
  });

  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    const m = 1 + frac * (displayMult - 1);
    pts.push(toCanvas(m));
  }

  const grad = ctx.createLinearGradient(padX, 0, w - padX, 0);
  if (crashed) {
    grad.addColorStop(0, '#ff6b6b');
    grad.addColorStop(1, '#ff0000');
  } else if (cashedAt) {
    grad.addColorStop(0, '#69db7c');
    grad.addColorStop(1, '#40c057');
  } else {
    grad.addColorStop(0, '#74c0fc');
    grad.addColorStop(1, '#4dabf7');
  }

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts) ctx.lineTo(p.x, p.y);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 3;
  ctx.stroke();

  const ep = pts[pts.length - 1];
  ctx.beginPath();
  ctx.arc(ep.x, ep.y, 8, 0, Math.PI * 2);
  ctx.fillStyle = crashed ? '#ff0000' : cashedAt ? '#40c057' : '#ffffff';
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let label, labelColor;
  if (crashed) {
    label = `CRASHED @ ${displayMult.toFixed(2)}×`;
    labelColor = '#ff6b6b';
  } else if (cashedAt) {
    label = `CASHED OUT @ ${cashedAt.toFixed(2)}×`;
    labelColor = '#69db7c';
  } else {
    label = `${displayMult.toFixed(2)}×`;
    labelColor = '#ffffff';
  }
  ctx.fillStyle = labelColor;
  ctx.font = 'bold 38px sans-serif';
  ctx.fillText(label, w / 2, 65);
  ctx.textBaseline = 'alphabetic';

  return canvas.toBuffer('image/png');
}

// ────────────────────────────────────────────
// CANVAS: TOWERS
// ────────────────────────────────────────────

function renderTowersCanvas(state) {
  const { floors, currentFloor, picks, phase } = state;
  const w = 440, h = 500;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, w, h);

  const n = floors.length;
  const tileW = 72, tileH = 46, gapX = 8, gapY = 10;
  const gridW = 4 * tileW + 3 * gapX;
  const gridH = n * (tileH + gapY) - gapY;
  const ox = (w - gridW - 52) / 2;
  const oy = (h - gridH) / 2;

  for (let fi = n - 1; fi >= 0; fi--) {
    const row = n - 1 - fi;
    const y = oy + row * (tileH + gapY);
    const floor = floors[fi];
    const isCurrent = fi === currentFloor && phase === 'playing';
    const isPast = fi < currentFloor || (fi === currentFloor && phase !== 'playing');
    const pick = picks[fi];

    for (let t = 0; t < 4; t++) {
      const x = ox + t * (tileW + gapX);

      let bg = '#252550';
      let border = isCurrent ? '#4dabf7' : '#333366';

      const isSafePick = pick !== undefined && t === pick && t !== floor.bomb;
      const isBomb = pick !== undefined && t === floor.bomb;
      const isRevealedBomb = isPast && isBomb && phase === 'lost';
      const isRevealedSafe = isPast && isSafePick;

      if (isCurrent && isBomb && phase === 'lost') {
        bg = '#5c1a1a'; border = '#ff6b6b';
      } else if (isCurrent && isSafePick) {
        bg = '#1a4a2e'; border = '#51cf66';
      } else if (isRevealedBomb) {
        bg = '#5c1a1a'; border = '#ff6b6b';
      } else if (isRevealedSafe) {
        bg = '#1a4a2e'; border = '#51cf66';
      }

      ctx.fillStyle = bg;
      ctx.strokeStyle = border;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.rect(x, y, tileW, tileH);
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      if (isRevealedBomb || (isCurrent && isBomb && phase === 'lost')) {
        ctx.font = '22px sans-serif';
        ctx.fillText('💣', x + tileW / 2, y + tileH / 2);
      } else if (isRevealedSafe || (isCurrent && isSafePick)) {
        ctx.fillStyle = '#51cf66';
        ctx.font = 'bold 18px sans-serif';
        ctx.fillText('✓', x + tileW / 2, y + tileH / 2);
      } else if (isCurrent && pick === undefined) {
        ctx.fillStyle = '#aaccff';
        ctx.font = 'bold 15px sans-serif';
        ctx.fillText(`${t + 1}`, x + tileW / 2, y + tileH / 2);
      }

      ctx.textBaseline = 'alphabetic';
    }

    const labelX = ox + gridW + 10;
    const isCompletedFloor = fi < currentFloor;
    ctx.fillStyle = isCurrent ? '#4dabf7' : isCompletedFloor ? '#51cf66' : '#444466';
    ctx.font = `bold 13px sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(`${TOWER_PAYOUTS[fi]}×`, labelX, y + tileH / 2 + 5);
  }

  return canvas.toBuffer('image/png');
}

// ────────────────────────────────────────────
// CANVAS: BLACKJACK
// ────────────────────────────────────────────

function renderBlackjackCanvas(playerHand, dealerHand, revealDealer) {
  const w = 800, h = 480;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#2b2d31';
  ctx.fillRect(0, 0, w, h);

  const cw = 95, ch = 138, cr = 10;

  function drawCard(card, x, y, faceDown) {
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = faceDown ? '#1e2a4a' : '#f8f8f8';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, cw, ch, cr) : ctx.rect(x, y, cw, ch);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = faceDown ? '#2a3d6a' : '#cccccc';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (!faceDown) {
      const isRed = card.suit === 'H' || card.suit === 'D';
      ctx.fillStyle = isRed ? '#cc2222' : '#111111';
      ctx.font = 'bold 20px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(cardLabel(card), x + cw / 2, y + ch / 2);
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(cardLabel(card), x + 7, y + 7);
      ctx.textBaseline = 'alphabetic';
    } else {
      ctx.fillStyle = '#4a6aaa';
      ctx.font = 'bold 26px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', x + cw / 2, y + ch / 2);
      ctx.textBaseline = 'alphabetic';
    }
  }

  const dTotal = revealDealer ? handTotal(dealerHand) : handTotal([dealerHand[0]]);
  const dLabel = revealDealer ? `Dealer: ${dTotal}` : `Dealer: ${handTotal([dealerHand[0]])} + ?`;

  ctx.fillStyle = '#aaaaaa';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(dLabel, 30, 38);
  dealerHand.forEach((card, i) => drawCard(card, 30 + i * (cw + 12), 50, !revealDealer && i > 0));

  const pTotal = handTotal(playerHand);
  ctx.fillStyle = '#aaaaaa';
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText(`You: ${pTotal}`, 30, 248);
  playerHand.forEach((card, i) => drawCard(card, 30 + i * (cw + 12), 258));

  if (revealDealer) {
    const pt = handTotal(playerHand);
    const dt = handTotal(dealerHand);
    let msg = pt > 21 ? 'BUST!' : dt > 21 || pt > dt ? 'YOU WIN!' : pt === dt ? 'PUSH' : 'DEALER WINS';
    const msgColor = (pt > 21 || (pt < dt && dt <= 21)) ? '#ff6b6b' : pt === dt ? '#aaaaaa' : '#69db7c';
    ctx.fillStyle = msgColor;
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg, w / 2, h - 38);
    ctx.textBaseline = 'alphabetic';
  }

  return canvas.toBuffer('image/png');
}

// ────────────────────────────────────────────
// CANVAS: SLOTS
// ────────────────────────────────────────────

async function renderSlotsCanvas(reels, matchType) {
  const w = 600, h = 210;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#111111';
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('— S L O T S —', w / 2, 22);

  const slotW = 162, slotH = 138, gap = 12;
  const startX = (w - 3 * slotW - 2 * gap) / 2;
  const startY = 32;

  const rankColors = { D: '#888888', C: '#44aa44', B: '#4488ff', A: '#aa44aa', S: '#ffd700', SS: '#ff8800', UR: '#ff2222' };

  for (let i = 0; i < 3; i++) {
    const x = startX + i * (slotW + gap);
    const card = reels[i];
    const highlight = matchType === 'jackpot' || matchType === 'attr3' || (matchType === 'attr2' && i < 2);
    const attrColor = ATTRIBUTE_COLORS[card.attribute] || '#333333';
    const borderColor = highlight ? '#ffd700' : attrColor;

    ctx.strokeStyle = borderColor;
    ctx.lineWidth = highlight ? 3 : 2;
    // subtle background tint based on attribute
    ctx.fillStyle = highlight ? '#151515' : (card.attribute ? '#0f0f0f' : '#1a1a1a');
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, startY, slotW, slotH, 8) : ctx.rect(x, startY, slotW, slotH);
    ctx.fill();
    ctx.stroke();

    const emojiId = extractEmojiId(card.emoji);
    let imgLoaded = false;
    if (emojiId) {
      try {
        const img = await loadImage(`https://cdn.discordapp.com/emojis/${emojiId}.png`);
        const iw = 88, ih = 88;
        ctx.drawImage(img, x + (slotW - iw) / 2, startY + 8, iw, ih);
        imgLoaded = true;
      } catch (e) { /* fall through to text */ }
    }

    if (!imgLoaded) {
      ctx.fillStyle = '#cccccc';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(card.character.split(' ').pop(), x + slotW / 2, startY + slotH / 2 - 12);
      ctx.textBaseline = 'alphabetic';
    }

    const rankH = 24;
    // Use attribute color for the bottom bar so DEX cards show DEX color
    ctx.fillStyle = ATTRIBUTE_COLORS[card.attribute] || '#555555';
    ctx.fillRect(x, startY + slotH - rankH, slotW, rankH);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const name = card.character.length > 12 ? card.character.split(' ').pop() : card.character;
    ctx.fillText(`${card.rank}  ${name}`, x + slotW / 2, startY + slotH - rankH / 2);
    ctx.textBaseline = 'alphabetic';
  }

  return canvas.toBuffer('image/png');
}

// ────────────────────────────────────────────
// CANVAS: SCRATCH
// ────────────────────────────────────────────

function renderScratchCanvas(grid, revealed) {
  const w = 370, h = 370;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#2b2d31';
  ctx.fillRect(0, 0, w, h);

  const tileW = 100, tileH = 90, gap = 15;
  const startX = (w - 3 * tileW - 2 * gap) / 2;
  const startY = (h - 3 * tileH - 2 * gap) / 2;

  for (let i = 0; i < 9; i++) {
    const col = i % 3, row = Math.floor(i / 3);
    const x = startX + col * (tileW + gap);
    const y = startY + row * (tileH + gap);
    const isRevealed = revealed.includes(i);
    const value = grid[i];

    ctx.fillStyle = isRevealed ? (value > 0 ? '#1a3a1a' : '#222222') : '#3a3d42';
    ctx.strokeStyle = isRevealed ? (value > 0 ? '#51cf66' : '#444444') : '#555555';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, tileW, tileH, 8) : ctx.rect(x, y, tileW, tileH);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (isRevealed) {
      if (value > 0) {
        ctx.fillStyle = '#69db7c';
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText(`¥${value.toLocaleString()}`, x + tileW / 2, y + tileH / 2);
      } else {
        ctx.fillStyle = '#555555';
        ctx.font = 'bold 22px sans-serif';
        ctx.fillText('✗', x + tileW / 2, y + tileH / 2);
      }
    } else {
      ctx.fillStyle = '#888888';
      ctx.font = 'bold 26px sans-serif';
      ctx.fillText('?', x + tileW / 2, y + tileH / 2);
    }
    ctx.textBaseline = 'alphabetic';
  }

  return canvas.toBuffer('image/png');
}

// ────────────────────────────────────────────
// COOLDOWN HELPER
// ────────────────────────────────────────────

async function setCooldown(userId) {
  try {
    if (String(userId) === String(OWNER_ID)) {
      const val = await getBotConfig('ownerGambleNoCooldown');
      if (val) return; // owner bypass enabled, don't set cooldown
    }
  } catch (e) { /* ignore BotConfig errors and continue to set cooldown */ }

  await User.updateOne({ userId }, { $set: { gambleCooldownUntil: new Date(Date.now() + GAMBLE_COOLDOWN_MS) } });
}

// ────────────────────────────────────────────
// MAIN DASHBOARD
// ────────────────────────────────────────────

async function execute({ interaction, message }) {
  const embed = new EmbedBuilder()
    .setColor('#ffd500')
    .setTitle('Casino Rain Dinners: Crocodiles Casino')
    .setImage('https://imgs.search.brave.com/zeuK_85T9vBIdoW7ZOvYCIuSDuHWDDzD__2DecdLawc/rs:fit:860:0:0:0/g:ce/aHR0cHM6Ly9zdGF0/aWMud2lraWEubm9j/b29raWUubmV0L29u/ZXBpZWNlL2ltYWdl/cy8wLzBjL1JhaW5f/RGlubmVycy5wbmcv/cmV2aXNpb24vbGF0/ZXN0L3NjYWxlLXRv/LXdpZHRoLWRvd24v/MjY4P2NiPTIwMTMw/MzE0MjAyMTIyJnBh/dGgtcHJlZml4PWVz')
    .setDescription('Welcome to Sir Crocodiles Casino! Here you can gamble every hour for a chance of winning beli.\n\n<:namigamble:1507864864012501022> Owning **Nami** gives you a beli boost!')
    .setThumbnail((interaction && interaction.client) ? interaction.client.user.displayAvatarURL() : (message && message.client ? message.client.user.displayAvatarURL() : ''));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`gamble_game:${(interaction && interaction.user) ? interaction.user.id : (message && message.author ? message.author.id : 'unknown')}`)
    .setPlaceholder('Choose a game...')
    .addOptions([
      { label: 'Coin Flip', value: 'coin', emoji: GAME_EMOJIS.coin },
      { label: 'Blackjack', value: 'blackjack', emoji: GAME_EMOJIS.blackjack },
      { label: 'Roulette', value: 'roulette', emoji: GAME_EMOJIS.roulette },
      { label: 'Slots', value: 'slots', emoji: GAME_EMOJIS.slots },
      { label: 'Crash', value: 'crash', emoji: GAME_EMOJIS.crash },
      { label: 'Towers', value: 'towers', emoji: GAME_EMOJIS.towers },
      { label: 'Scratch', value: 'scratch', emoji: GAME_EMOJIS.scratch }
    ]);

  const row = new ActionRowBuilder().addComponents(menu);

    return message ? message.channel.send({ embeds: [embed], components: [row] }) : (await interaction.deferReply(), await interaction.editReply({ embeds: [embed], components: [row] }));
}

// ────────────────────────────────────────────
// SELECT MENU HANDLER
// ────────────────────────────────────────────

async function handleSelect(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[0];
  const userId = interaction.user.id;

  // Roulette spin type (handled separately below)
  if (action === 'gamble_roul') {
    const choice = interaction.values[0];
    if (choice === 'lucky') {
      // Must show modal BEFORE any deferUpdate — cannot defer then showModal
      const session = gambleSessions.get(userId);
      if (!session) return interaction.reply({ content: 'No active session.', ephemeral: true });
      const modal = new ModalBuilder()
        .setCustomId(`gamble_roul_lucky:${userId}`)
        .setTitle('Pick a lucky number');
      const input = new TextInputBuilder()
        .setCustomId('luckyNumber')
        .setLabel('Enter a number (0-36)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 7')
        .setRequired(true);
      const row = new ActionRowBuilder().addComponents(input);
      modal.addComponents(row);
      return interaction.showModal(modal);
    }
    await interaction.deferUpdate();
    const session = gambleSessions.get(userId);
    if (!session) return;
    return handleRouletteSpin(interaction, session, choice);
  }

  await interaction.deferUpdate();

  const user = await User.findOne({ userId });
  if (!user) return;

  if (action === 'gamble_game') {
    const now = new Date();
    let skipCooldown = false;
    try {
      if (interaction.user && String(interaction.user.id) === String(OWNER_ID)) {
        const val = await getBotConfig('ownerGambleNoCooldown');
        if (val) skipCooldown = true;
      }
    } catch (e) {}

    if (!skipCooldown && user.gambleCooldownUntil && user.gambleCooldownUntil > now) {
      const remaining = formatTimeLeft(user.gambleCooldownUntil - now);
      return interaction.followUp({
        content: `You must wait **${remaining}** before gambling again.`,
        ephemeral: true
      });
    }

    const game = interaction.values[0];
    const betMenu = new StringSelectMenuBuilder()
      .setCustomId(`gamble_bet:${userId}:${game}`)
      .setPlaceholder('How much do you want to bet?')
      .addOptions([
        { label: '100 Beli', value: '100' },
        { label: '500 Beli', value: '500' },
        { label: '1,000 Beli', value: '1000' },
        { label: '5,000 Beli', value: '5000' },
        { label: '10,000 Beli', value: '10000' },
        { label: '50,000 Beli', value: '50000' },
        { label: 'All-In', value: 'allin' }
      ]);

    const gameNames = { coin: 'Coin Flip', blackjack: 'Blackjack', roulette: 'Roulette', slots: 'Slots', crash: 'Crash', towers: 'Towers', scratch: 'Scratch' };
    const embed = new EmbedBuilder()
      .setColor('#23272a')
      .setTitle('Casino Rain Dinners: Crocodiles Casino')
      .setDescription(`You selected **${gameNames[game] || game}**.\n\nHow much Beli do you want to bet?`)
      .setThumbnail(interaction.client.user.displayAvatarURL());

    return interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(betMenu)] });
      }

      if (action === 'gamble_bet') {
    const game = parts[2];
    let bet = interaction.values[0] === 'allin'
      ? Math.max(100, user.balance || 0)
      : parseInt(interaction.values[0], 10);

    if (!bet || bet < 100) bet = 100;

    if ((user.balance || 0) < bet) {
      return interaction.followUp({
        content: `You don't have enough Beli. Your balance: **${formatBeli(user.balance || 0)}**`,
        ephemeral: true
      });
    }

    const session = { userId, game, bet, namiMultiplier: getNamiMultiplier(user), paidSoFar: 0, state: {} };
    gambleSessions.set(userId, session);

    switch (game) {
      case 'coin': return startCoinFlip(interaction, session);
      case 'blackjack': return startBlackjack(interaction, session);
      case 'roulette': return startRoulette(interaction, session);
      case 'slots': return startSlots(interaction, session);
      case 'crash': return startCrash(interaction, session);
      case 'towers': return startTowers(interaction, session);
      case 'scratch': return startScratch(interaction, session);
    }
  }
}

// ────────────────────────────────────────────
// GAME STARTERS
// ────────────────────────────────────────────

async function startCoinFlip(interaction, session) {
  session.state = { phase: 'picking' };
  const buf = await renderCoinCanvas('?', '?', false);
  const att = new AttachmentBuilder(buf, { name: 'coin.png' });
  const embed = new EmbedBuilder()
    .setColor('#23272a')
    .setTitle(`${GAME_EMOJIS.coin} Coin Flip — Crocodiles Casino`)
    .setDescription(`**Bet:** ${formatBeli(session.bet)}\nPick **Heads** or **Tails**.`)
    .setThumbnail((interaction && interaction.client) ? interaction.client.user.displayAvatarURL() : '')
    .setImage('attachment://coin.png')
    .setFooter({ text: 'Choose quickly — may the odds be in your favor!' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gamble_btn:${session.userId}:coin:heads`).setLabel('Heads').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gamble_btn:${session.userId}:coin:tails`).setLabel('Tails').setStyle(ButtonStyle.Primary)
  );
  return interaction.editReply({ embeds: [embed], components: [row], files: [att] });
}

async function startBlackjack(interaction, session) {
  const deck = makeDeck();
  const playerHand = [deck.pop(), deck.pop()];
  const dealerHand = [deck.pop(), deck.pop()];
  session.state = { deck, playerHand, dealerHand, phase: 'playing' };

  if (isBlackjack(playerHand)) {
    return finishBlackjack(interaction, session, 'blackjack');
  }

  const buf = renderBlackjackCanvas(playerHand, dealerHand, false);
  const att = new AttachmentBuilder(buf, { name: 'blackjack.png' });
  const embed = new EmbedBuilder()
    .setColor('#23272a')
    .setTitle(`${GAME_EMOJIS.blackjack} Blackjack — Crocodiles Casino`)
    .setThumbnail((interaction && interaction.client) ? interaction.client.user.displayAvatarURL() : '')
    .setDescription(`**Bet:** ${formatBeli(session.bet)} | **Your hand:** ${handTotal(playerHand)}`)
    .setImage('attachment://blackjack.png')
    .setFooter({ text: 'Hit / Stand / Double Down' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gamble_btn:${session.userId}:bj:hit`).setLabel('Hit').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gamble_btn:${session.userId}:bj:stand`).setLabel('Stand').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`gamble_btn:${session.userId}:bj:double`).setLabel('Double Down').setStyle(ButtonStyle.Secondary)
  );
  return interaction.editReply({ embeds: [embed], components: [row], files: [att] });
}

async function startRoulette(interaction, session) {
  session.state = { phase: 'picking' };
  const embed = new EmbedBuilder()
    .setColor('#23272a')
    .setTitle(`${GAME_EMOJIS.roulette} Roulette`)
    .setDescription(`**Bet:** ${formatBeli(session.bet)}\nChoose where to place your bet.`);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`gamble_roul:${session.userId}`)
    .setPlaceholder('Pick a bet type...')
    .addOptions([
      { label: 'Red (×2)', value: 'red' },
      { label: 'Black (×2)', value: 'black' },
      { label: 'Green 0 (×18)', value: 'green' },
      { label: 'Lucky Number — choose (×36)', value: 'lucky' }
    ]);
  return interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)], files: [] });
}

async function startSlots(interaction, session) {
  // Show spinning message for climax
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor('#23272a')
      .setTitle('🎰 Slots')
      .setDescription('**Spinning ...**\n\n🎰  🎰  🎰')],
    components: [],
    files: []
  });
  await new Promise(r => setTimeout(r, 2000));

  const pool = getSlotPool();
  if (!pool.length) {
    const reels = [rollSlotCard(), rollSlotCard(), rollSlotCard()];
    const buf = await renderSlotsCanvas(reels, 'none');
    const att = new AttachmentBuilder(buf, { name: 'slots.png' });
    await User.updateOne({ userId: session.userId }, { $inc: { balance: -session.bet } });
    const embed = new EmbedBuilder()
      .setColor('#23272a')
      .setTitle('Slots')
      .setDescription(`**Bet:** ${formatBeli(session.bet)}\n\n**No match. Better luck next time!**`)
      .setImage('attachment://slots.png');
    await setCooldown(session.userId);
    gambleSessions.delete(session.userId);
    return interaction.editReply({ embeds: [embed], components: [], files: [att] });
  }

  // Choose first reel uniformly from pool
  const reels = [];
  reels[0] = pool[Math.floor(Math.random() * pool.length)];

  // Make exact same-card matches more probable than pure RNG
  for (let i = 1; i < 3; i++) {
    const pSame = 0.18;
    const pAttr = 0.12;
    if (Math.random() < pSame) {
      reels[i] = reels[0];
    } else if (Math.random() < pAttr) {
      const sameAttr = pool.filter(c => c.attribute === reels[0].attribute && c.id !== reels[0].id);
      if (sameAttr.length) reels[i] = sameAttr[Math.floor(Math.random() * sameAttr.length)];
      else reels[i] = pool[Math.floor(Math.random() * pool.length)];
    } else {
      reels[i] = pool[Math.floor(Math.random() * pool.length)];
    }
  }

  const ids = reels.map(c => c.id);
  const attrs = reels.map(c => c.attribute);
  const allSame = ids[0] === ids[1] && ids[1] === ids[2];
  const allAttr = attrs[0] === attrs[1] && attrs[1] === attrs[2];
  const twoAttr = !allAttr && (attrs[0] === attrs[1] || attrs[1] === attrs[2] || attrs[0] === attrs[2]);

  let payoutMult = 0;
  let matchType = 'none';
  let resultLine = '';

  if (allSame) {
    payoutMult = 20; matchType = 'jackpot';
    resultLine = '**JACKPOT! 3-of-a-kind!**';
  } else if (allAttr) {
    payoutMult = 5; matchType = 'attr3';
    resultLine = `**3 ${attrs[0]} Attribute Match!** ×${payoutMult}`;
  } else if (twoAttr) {
    payoutMult = 1.5; matchType = 'attr2';
    resultLine = `**2 Attribute Match!** ×${payoutMult}`;
  } else {
    resultLine = '**No match. Better luck next time!**';
  }

  let winnings = 0;
  if (payoutMult > 0) {
    winnings = Math.floor(session.bet * (payoutMult - 1) * session.namiMultiplier);
    await User.updateOne({ userId: session.userId }, { $inc: { balance: winnings } });
  } else {
    await User.updateOne({ userId: session.userId }, { $inc: { balance: -session.bet } });
  }

  let bonusLine = '';
  if (allSame) {
    try {
      const freshUser = await User.findOne({ userId: session.userId });
      const alreadyOwns = freshUser && freshUser.ownedCards && freshUser.ownedCards.some(e => e.cardId === reels[0].id);
      if (alreadyOwns) {
        const xpGain = 50;
        await User.updateOne(
          { userId: session.userId, 'ownedCards.cardId': reels[0].id },
          { $inc: { 'ownedCards.$.xp': xpGain } }
        );
        bonusLine = `\n**Already owned!** ${reels[0].emoji} ${reels[0].character} → converted to **+${xpGain} XP**`;
      } else {
        await User.updateOne({ userId: session.userId }, {
          $push: { ownedCards: { cardId: reels[0].id, level: 1, xp: 0, starLevel: 0 } }
        });
        bonusLine = `\n**Card won:** ${reels[0].emoji} ${reels[0].character} added to your collection!`;
      }
    } catch (e) {}
  }

  await setCooldown(session.userId);
  gambleSessions.delete(session.userId);

  const buf = await renderSlotsCanvas(reels, matchType);
  const att = new AttachmentBuilder(buf, { name: 'slots.png' });
  let namiBoostLine = '';
  if (winnings > 0 && session.namiMultiplier && session.namiMultiplier > 1) {
    const pct = ((session.namiMultiplier - 1) * 100).toFixed(2);
    namiBoostLine = `\n**Nami boost:** +${pct}% (×${session.namiMultiplier.toFixed(2)})`;
  }
  const desc = `**Bet:** ${formatBeli(session.bet)}\n\n${resultLine}${winnings > 0 ? `\n**Won:** ${formatBeli(winnings)}` : ''}${namiBoostLine}${bonusLine}`;
  const embed = new EmbedBuilder()
    .setColor('#23272a')
    .setTitle('Slots')
    .setDescription(desc)
    .setImage('attachment://slots.png');
  return interaction.editReply({ embeds: [embed], components: [], files: [att] });
}

async function startCrash(interaction, session) {
  const crashAt = rollCrashAt();
  const startTime = Date.now();
  session.state = { crashAt, startTime, phase: 'playing' };
  const buf = renderCrashCanvas(1.00, false, null);
  const att = new AttachmentBuilder(buf, { name: 'crash.png' });
  const embed = new EmbedBuilder()
    .setColor('#23272a')
    .setTitle(`${GAME_EMOJIS.crash} Crash`)
    .setDescription(`**Bet:** ${formatBeli(session.bet)}\nThe multiplier is climbing — cash out before it crashes!`)
    .setImage('attachment://crash.png');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gamble_btn:${session.userId}:crash:cashout`)
      .setLabel('Cash Out')
      .setStyle(ButtonStyle.Success)
  );
  await interaction.editReply({ embeds: [embed], components: [row], files: [att] });

  // Periodically update the crash embed to show the climbing multiplier
  try {
    if (crashIntervals.has(session.userId)) {
      clearInterval(crashIntervals.get(session.userId));
      crashIntervals.delete(session.userId);
    }
    const iv = setInterval(async () => {
      try {
        // stop if session no longer active
        const active = gambleSessions.get(session.userId);
        if (!active || active.state.phase !== 'playing') {
          clearInterval(iv);
          crashIntervals.delete(session.userId);
          return;
        }
        const nowMult = crashCurrentMult(session.state.startTime);
        const buf2 = renderCrashCanvas(nowMult, false, null);
        const att2 = new AttachmentBuilder(buf2, { name: 'crash.png' });
        const upd = new EmbedBuilder()
          .setColor('#23272a')
          .setTitle('Crash')
          .setDescription(`**Bet:** ${formatBeli(session.bet)}\n\nThe multiplier is climbing — current: ${nowMult.toFixed(2)}×\nCash out before it crashes!`)
          .setImage('attachment://crash.png');
        await interaction.editReply({ embeds: [upd], components: [row], files: [att2] }).catch(() => {});
      } catch (e) {}
    }, 1000);
    crashIntervals.set(session.userId, iv);
  } catch (e) {}
}


async function startTowers(interaction, session) {
  const floors = Array.from({ length: 5 }, () => ({ bomb: Math.floor(Math.random() * 4) }));
  session.state = { floors, currentFloor: 0, picks: {}, phase: 'playing' };
  const buf = renderTowersCanvas(session.state);
  const att = new AttachmentBuilder(buf, { name: 'towers.png' });
  const embed = new EmbedBuilder()
    .setColor('#23272a')
    .setTitle(`${GAME_EMOJIS.towers} Towers`)
    .setDescription(`**Bet:** ${formatBeli(session.bet)}\nPick a safe tile each floor. Reach the top for **${TOWER_PAYOUTS[TOWER_PAYOUTS.length - 1]}×**!\n**Floor 1 — Potential: ${TOWER_PAYOUTS[0]}×**`)
    .setImage('attachment://towers.png');
  const tileRow = new ActionRowBuilder().addComponents(
    ...[0,1,2,3].map(i => new ButtonBuilder()
      .setCustomId(`gamble_btn:${session.userId}:tower:${i}`)
      .setLabel(`Tile ${i+1}`)
      .setStyle(ButtonStyle.Primary))
  );
  return interaction.editReply({ embeds: [embed], components: [tileRow], files: [att] });
}

async function startScratch(interaction, session) {
  const grid = buildScratchGrid(session.bet);
  session.state = { grid, revealed: [], phase: 'playing' };
  const buf = renderScratchCanvas(grid, []);
  const att = new AttachmentBuilder(buf, { name: 'scratch.png' });
  const embed = new EmbedBuilder()
    .setColor('#23272a')
    .setTitle('Scratch Card')
    .setDescription(`**Bet:** ${formatBeli(session.bet)}\nReveal all 9 tiles — match 3 to win!`)
    .setImage('attachment://scratch.png');
  return interaction.editReply({ embeds: [embed], components: makeScratchRows(session, []), files: [att] });
}

// ────────────────────────────────────────────
// BUTTON HANDLER
// ────────────────────────────────────────────

async function handleButton(interaction) {
  const parts = interaction.customId.split(':');
  const userId = parts[1];
  const gameType = parts[2];
  const actionData = parts[3];

  if (interaction.user.id !== userId) {
    return interaction.reply({ content: 'This is not your game.', ephemeral: true });
  }

  const session = gambleSessions.get(userId);
  if (!session) {
    return interaction.reply({ content: 'No active game session. Run `/gamble` to start a new one.', ephemeral: true });
  }

  await interaction.deferUpdate();

  switch (gameType) {
    case 'coin': return handleCoinButton(interaction, session, actionData);
    case 'bj': return handleBlackjackButton(interaction, session, actionData);
    case 'crash': return handleCrashButton(interaction, session, actionData);
    case 'tower': return handleTowerButton(interaction, session, actionData);
    case 'scratch': return handleScratchButton(interaction, session, parseInt(actionData, 10));
  }
}

// ────────────────────────────────────────────
// GAME BUTTON HANDLERS
// ────────────────────────────────────────────

async function handleCoinButton(interaction, session, pick) {
  const result = Math.random() < 0.5 ? 'heads' : 'tails';
  const won = pick === result;
  const profit = won ? Math.floor(session.bet * session.namiMultiplier) : 0;
  if (won) await User.updateOne({ userId: session.userId }, { $inc: { balance: profit } });
  else await User.updateOne({ userId: session.userId }, { $inc: { balance: -session.bet } });
  await setCooldown(session.userId);
  gambleSessions.delete(session.userId);

  const buf = await renderCoinCanvas(pick, result, true);
  const att = new AttachmentBuilder(buf, { name: 'coin.png' });
  let namiBoostLine = '';
  if (won && session.namiMultiplier && session.namiMultiplier > 1) {
    const pct = ((session.namiMultiplier - 1) * 100).toFixed(2);
    namiBoostLine = `\n**Nami boost:** +${pct}% (×${session.namiMultiplier.toFixed(2)})`;
  }
  const desc = `**Bet:** ${formatBeli(session.bet)}\n\nYou picked **${pick}** — Result: **${result}**\n`
    + (won ? `**You won ${formatBeli(profit)}!**${namiBoostLine}` : `**You lost ${formatBeli(session.bet)}.**`);
  const embed = new EmbedBuilder()
    .setColor('#23272a')
    .setTitle(`${GAME_EMOJIS.coin} Coin Flip`)
    .setDescription(desc)
    .setThumbnail((interaction && interaction.client) ? interaction.client.user.displayAvatarURL() : '')
    .setImage('attachment://coin.png');
  return interaction.editReply({ embeds: [embed], components: [], files: [att] });
}

async function handleBlackjackButton(interaction, session, action) {
  const { deck, playerHand, dealerHand } = session.state;

  if (action === 'double') {
    if (playerHand.length !== 2) return;
    const fresh = await User.findOne({ userId: session.userId });
    if (!fresh || (fresh.balance || 0) < session.bet) {
      return interaction.followUp({
        content: `You need **${formatBeli(session.bet)}** more Beli to double down.`,
        ephemeral: true
      });
    }
    await User.updateOne({ userId: session.userId }, { $inc: { balance: -session.bet } });
    session.paidSoFar = (session.paidSoFar || 0) + session.bet;
    session.bet *= 2;
    playerHand.push(deck.pop());
    return finishBlackjack(interaction, session, handTotal(playerHand) > 21 ? 'bust' : 'stand');
  }

  if (action === 'hit') {
    playerHand.push(deck.pop());
    if (handTotal(playerHand) > 21) return finishBlackjack(interaction, session, 'bust');
    const buf = renderBlackjackCanvas(playerHand, dealerHand, false);
    const att = new AttachmentBuilder(buf, { name: 'blackjack.png' });
    const embed = new EmbedBuilder()
      .setColor('#23272a')
      .setTitle('Blackjack')
      .setDescription(`**Bet:** ${formatBeli(session.bet)} | **Your hand:** ${handTotal(playerHand)}`)
      .setImage('attachment://blackjack.png');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gamble_btn:${session.userId}:bj:hit`).setLabel('Hit').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gamble_btn:${session.userId}:bj:stand`).setLabel('Stand').setStyle(ButtonStyle.Danger)
    );
    return interaction.editReply({ embeds: [embed], components: [row], files: [att] });
  }

  if (action === 'stand') return finishBlackjack(interaction, session, 'stand');
}

async function finishBlackjack(interaction, session, reason) {
  const { playerHand, dealerHand, deck } = session.state;
  if (reason === 'stand' || reason === 'blackjack') {
    while (handTotal(dealerHand) < 17) dealerHand.push(deck.pop());
  }

  const pt = handTotal(playerHand);
  const dt = handTotal(dealerHand);

  let payoutMult = 0;
  let outcome;

  if (reason === 'bust') {
    outcome = '**Bust!**';
  } else if (reason === 'blackjack') {
    payoutMult = 2.5;
    outcome = '**Blackjack! Natural 21!**';
  } else if (dt > 21 || pt > dt) {
    payoutMult = 2;
    outcome = '**You win!**';
  } else if (pt === dt) {
    payoutMult = 1;
    outcome = '**Push — bet returned.**';
  } else {
    outcome = '**Dealer wins.**';
  }

  let profit = 0;
  if (payoutMult > 1) {
    profit = Math.floor(session.bet * (payoutMult - 1) * session.namiMultiplier);
    await User.updateOne({ userId: session.userId }, { $inc: { balance: profit } });
  } else if (payoutMult === 0) {
    const remaining = (session.bet || 0) - (session.paidSoFar || 0);
    if (remaining > 0) await User.updateOne({ userId: session.userId }, { $inc: { balance: -remaining } });
  }
  await setCooldown(session.userId);
  gambleSessions.delete(session.userId);

  const buf = renderBlackjackCanvas(playerHand, dealerHand, true);
  const att = new AttachmentBuilder(buf, { name: 'blackjack.png' });
  let namiBoostLine = '';
  if (profit > 0 && session.namiMultiplier && session.namiMultiplier > 1) {
    const pct = ((session.namiMultiplier - 1) * 100).toFixed(2);
    namiBoostLine = `\n**Nami boost:** +${pct}% (×${session.namiMultiplier.toFixed(2)})`;
  }
  const desc = payoutMult > 1
    ? `**Bet:** ${formatBeli(session.bet)}\n\n${outcome}\n**Won:** ${formatBeli(profit)}${namiBoostLine}`
    : payoutMult === 1
      ? `**Bet:** ${formatBeli(session.bet)}\n\n${outcome}`
      : `**Bet:** ${formatBeli(session.bet)}\n\n${outcome}\n**Lost:** ${formatBeli(session.bet)}`;
  const embed = new EmbedBuilder()
    .setColor('#23272a')
    .setTitle(`${GAME_EMOJIS.blackjack} Blackjack`)
    .setDescription(desc)
    .setImage('attachment://blackjack.png');
  return interaction.editReply({ embeds: [embed], components: [], files: [att] });
}

async function handleRouletteSpin(interaction, session, betType) {
  const number = Math.floor(Math.random() * 37);
  const isRed = RED_NUMBERS.has(number);
  const isGreen = number === 0;
  const isBlack = !isRed && !isGreen;

  let won = false, payoutMult = 0, luckyNum = null;

  if (betType === 'red' && isRed) { won = true; payoutMult = 2; }
  else if (betType === 'black' && isBlack) { won = true; payoutMult = 2; }
  else if (betType === 'green' && isGreen) { won = true; payoutMult = 18; }
  else if (typeof betType === 'string' && betType.startsWith('lucky')) {
    const parts = betType.split(':');
    if (parts.length > 1) {
      const parsed = parseInt(parts[1], 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 36) luckyNum = parsed;
    }
    if (luckyNum === null) luckyNum = Math.floor(Math.random() * 37);
    if (luckyNum === number) { won = true; payoutMult = 36; }
  }

  let rouProfit = 0;
  if (won) {
    rouProfit = Math.floor(session.bet * (payoutMult - 1) * session.namiMultiplier);
    await User.updateOne({ userId: session.userId }, { $inc: { balance: rouProfit } });
  } else {
    await User.updateOne({ userId: session.userId }, { $inc: { balance: -session.bet } });
  }
  await setCooldown(session.userId);
  gambleSessions.delete(session.userId);

  const buf = renderRouletteCanvas(number, won);
  const att = new AttachmentBuilder(buf, { name: 'roulette.png' });

  let betLine = (typeof betType === 'string' && betType.startsWith('lucky'))
    ? `**Your lucky number:** ${luckyNum} — **Ball landed on:** ${number}`
    : `**Bet type:** ${betType.charAt(0).toUpperCase() + betType.slice(1)} — **Ball landed on:** ${number}`;
  let namiBoostLine = '';
  if (won && session.namiMultiplier && session.namiMultiplier > 1) {
    const pct = ((session.namiMultiplier - 1) * 100).toFixed(2);
    namiBoostLine = `\n**Nami boost:** +${pct}% (×${session.namiMultiplier.toFixed(2)})`;
  }

  const desc = `**Bet:** ${formatBeli(session.bet)}\n${betLine}\n\n` +
    (won ? `**Won ${formatBeli(rouProfit)}!** (×${payoutMult})${namiBoostLine}` : `**You lost ${formatBeli(session.bet)}.**`);
  const embed = new EmbedBuilder()
    .setColor('#23272a')
    .setTitle(`${GAME_EMOJIS.roulette} Roulette`)
    .setDescription(desc)
    .setImage('attachment://roulette.png');
  return interaction.editReply({ embeds: [embed], components: [], files: [att] });
}

async function handleCrashButton(interaction, session) {
  const { crashAt, startTime } = session.state;
  const currentMult = crashCurrentMult(startTime);
  const crashed = currentMult >= crashAt;

  if (crashed) {
    await User.updateOne({ userId: session.userId }, { $inc: { balance: -session.bet } });
    await setCooldown(session.userId);
    gambleSessions.delete(session.userId);
    try {
      if (crashIntervals.has(session.userId)) {
        clearInterval(crashIntervals.get(session.userId));
        crashIntervals.delete(session.userId);
      }
    } catch (e) {}
    const buf = renderCrashCanvas(parseFloat(crashAt.toFixed(2)), true, null);
    const att = new AttachmentBuilder(buf, { name: 'crash.png' });
    const embed = new EmbedBuilder()
      .setColor('#23272a')
      .setTitle(`${GAME_EMOJIS.crash} Crash`)
      .setDescription(`**Bet:** ${formatBeli(session.bet)}\n\n**Crashed at ${crashAt.toFixed(2)}× before you cashed out!**\n**Lost ${formatBeli(session.bet)}.**`)
      .setImage('attachment://crash.png');
    return interaction.editReply({ embeds: [embed], components: [], files: [att] });
  }

  const crashProfit = Math.floor(session.bet * (currentMult - 1) * session.namiMultiplier);
  await User.updateOne({ userId: session.userId }, { $inc: { balance: crashProfit } });
  await setCooldown(session.userId);
  gambleSessions.delete(session.userId);
  try {
    if (crashIntervals.has(session.userId)) {
      clearInterval(crashIntervals.get(session.userId));
      crashIntervals.delete(session.userId);
    }
  } catch (e) {}

  const buf = renderCrashCanvas(currentMult, false, currentMult);
  const att = new AttachmentBuilder(buf, { name: 'crash.png' });
  let namiBoostLine = '';
  if (crashProfit > 0 && session.namiMultiplier && session.namiMultiplier > 1) {
    const pct = ((session.namiMultiplier - 1) * 100).toFixed(2);
    namiBoostLine = `\n**Nami boost:** +${pct}% (×${session.namiMultiplier.toFixed(2)})`;
  }
  const embed = new EmbedBuilder()
    .setColor('#23272a')
    .setTitle(`${GAME_EMOJIS.crash} Crash`)
    .setDescription(`**Bet:** ${formatBeli(session.bet)}\n\n**Cashed out at ${currentMult.toFixed(2)}×!**\n**Won ${formatBeli(crashProfit)}!**${namiBoostLine}`)
    .setImage('attachment://crash.png');
  return interaction.editReply({ embeds: [embed], components: [], files: [att] });
}

async function handleTowerButton(interaction, session, tile) {
  const { floors, currentFloor, picks } = session.state;

  // "Take winnings" at last completed floor
  if (tile === 'take') {
    const completedFloor = currentFloor - 1;
    const payoutMult = TOWER_PAYOUTS[Math.max(0, completedFloor)];
    const winnings = Math.floor(session.bet * (payoutMult - 1) * session.namiMultiplier);
    await User.updateOne({ userId: session.userId }, { $inc: { balance: winnings } });
    await setCooldown(session.userId);
    gambleSessions.delete(session.userId);
    const buf = renderTowersCanvas(session.state);
    const att = new AttachmentBuilder(buf, { name: 'towers.png' });
    let namiBoostLine = '';
    if (winnings > 0 && session.namiMultiplier && session.namiMultiplier > 1) {
      const pct = ((session.namiMultiplier - 1) * 100).toFixed(2);
      namiBoostLine = `\n**Nami boost:** +${pct}% (×${session.namiMultiplier.toFixed(2)})`;
    }
    const embed = new EmbedBuilder()
      .setColor('#23272a')
      .setTitle(`${GAME_EMOJIS.towers} Towers`)
      .setDescription(`**Bet:** ${formatBeli(session.bet)}\n\n**Cashed out at ${payoutMult}×!**\n**Won ${formatBeli(winnings)}!**${namiBoostLine}`)
      .setImage('attachment://towers.png');
    return interaction.editReply({ embeds: [embed], components: [], files: [att] });
  }

  const tileIndex = parseInt(tile, 10);
  if (isNaN(tileIndex)) return;

  const floor = floors[currentFloor];
  const hitBomb = tileIndex === floor.bomb;
  picks[currentFloor] = tileIndex;

  if (hitBomb) {
    session.state.phase = 'lost';
    await User.updateOne({ userId: session.userId }, { $inc: { balance: -session.bet } });
    await setCooldown(session.userId);
    gambleSessions.delete(session.userId);
    const buf = renderTowersCanvas(session.state);
    const att = new AttachmentBuilder(buf, { name: 'towers.png' });
    const embed = new EmbedBuilder()
      .setColor('#23272a')
      .setTitle(`${GAME_EMOJIS.towers} Towers`)
      .setDescription(`**Bet:** ${formatBeli(session.bet)}\n\n**Boom! You hit a bomb on floor ${currentFloor + 1}!**\n**Lost ${formatBeli(session.bet)}.**`)
      .setImage('attachment://towers.png');
    return interaction.editReply({ embeds: [embed], components: [], files: [att] });
  }

  const currentPayout = TOWER_PAYOUTS[currentFloor];
  const nextFloor = currentFloor + 1;

  if (nextFloor >= floors.length) {
    session.state.phase = 'won';
    const winnings = Math.floor(session.bet * (currentPayout - 1) * session.namiMultiplier);
    await User.updateOne({ userId: session.userId }, { $inc: { balance: winnings } });
    await setCooldown(session.userId);
    gambleSessions.delete(session.userId);
    const buf = renderTowersCanvas(session.state);
    const att = new AttachmentBuilder(buf, { name: 'towers.png' });
    let namiBoostLine2 = '';
    if (winnings > 0 && session.namiMultiplier && session.namiMultiplier > 1) {
      const pct2 = ((session.namiMultiplier - 1) * 100).toFixed(2);
      namiBoostLine2 = `\n**Nami boost:** +${pct2}% (×${session.namiMultiplier.toFixed(2)})`;
    }
    const embed = new EmbedBuilder()
      .setColor('#23272a')
      .setTitle(`${GAME_EMOJIS.towers} Towers`)
      .setDescription(`**Bet:** ${formatBeli(session.bet)}\n\n**All floors cleared! ${currentPayout}×!**\n**Won ${formatBeli(winnings)}!**${namiBoostLine2}`)
      .setImage('attachment://towers.png');
    return interaction.editReply({ embeds: [embed], components: [], files: [att] });
  }

  session.state.currentFloor = nextFloor;
  const nextPayout = TOWER_PAYOUTS[nextFloor];
  const currentWinnings = Math.floor(session.bet * (currentPayout - 1) * session.namiMultiplier);

  const buf = renderTowersCanvas(session.state);
  const att = new AttachmentBuilder(buf, { name: 'towers.png' });
  const embed = new EmbedBuilder()
    .setColor('#23272a')
    .setTitle(`${GAME_EMOJIS.towers} Towers`)
    .setDescription(
      `**Bet:** ${formatBeli(session.bet)}\n**Floor ${currentFloor + 1} cleared!**\n`
      + `**Next floor potential:** ${nextPayout}× | **Take now:** ${currentPayout}× = ${formatBeli(currentWinnings)}`
    )
    .setImage('attachment://towers.png');
  const tileRow = new ActionRowBuilder().addComponents(
    ...[0,1,2,3].map(i => new ButtonBuilder()
      .setCustomId(`gamble_btn:${session.userId}:tower:${i}`)
      .setLabel(`Tile ${i+1}`)
      .setStyle(ButtonStyle.Primary))
  );
  const takeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gamble_btn:${session.userId}:tower:take`)
      .setLabel(`Take ${currentPayout}× (${formatBeli(currentWinnings)})`)
      .setStyle(ButtonStyle.Success)
  );
  return interaction.editReply({ embeds: [embed], components: [tileRow, takeRow], files: [att] });
}

function makeScratchRows(session, revealed) {
  return [
    new ActionRowBuilder().addComponents(
      ...[0,1,2].map(i => new ButtonBuilder()
        .setCustomId(`gamble_btn:${session.userId}:scratch:${i}`)
        .setLabel(`${i+1}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(revealed.includes(i)))
    ),
    new ActionRowBuilder().addComponents(
      ...[3,4,5].map(i => new ButtonBuilder()
        .setCustomId(`gamble_btn:${session.userId}:scratch:${i}`)
        .setLabel(`${i+1}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(revealed.includes(i)))
    ),
    new ActionRowBuilder().addComponents(
      ...[6,7,8].map(i => new ButtonBuilder()
        .setCustomId(`gamble_btn:${session.userId}:scratch:${i}`)
        .setLabel(`${i+1}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(revealed.includes(i)))
    )
  ];
}

async function handleScratchButton(interaction, session, tileIndex) {
  const { grid, revealed } = session.state;
  if (revealed.includes(tileIndex)) return;
  revealed.push(tileIndex);

  const allRevealed = revealed.length >= 9;

  const buf = renderScratchCanvas(grid, revealed);
  const att = new AttachmentBuilder(buf, { name: 'scratch.png' });

  if (allRevealed) {
    // Tally winnings — pair pays tile value, triple pays tile value × 2
    const counts = {};
    for (const v of grid.filter(v => v > 0)) counts[v] = (counts[v] || 0) + 1;
    let bestPrize = 0;
    for (const [val, cnt] of Object.entries(counts)) {
      if (cnt >= 3) bestPrize = Math.max(bestPrize, parseInt(val, 10) * 2);
      else if (cnt >= 2) bestPrize = Math.max(bestPrize, parseInt(val, 10));
    }

    const rawPrize = Math.floor(bestPrize * session.namiMultiplier);
    const scratchNet = rawPrize - session.bet;
    await User.updateOne({ userId: session.userId }, { $inc: { balance: scratchNet } });
    await setCooldown(session.userId);
    gambleSessions.delete(session.userId);

    let namiBoostLine = '';
    if (rawPrize > 0 && session.namiMultiplier && session.namiMultiplier > 1) {
      const pct = ((session.namiMultiplier - 1) * 100).toFixed(2);
      namiBoostLine = `\n**Nami boost:** +${pct}% (×${session.namiMultiplier.toFixed(2)})`;
    }
    const embed = new EmbedBuilder()
      .setColor('#23272a')
      .setTitle(`${GAME_EMOJIS.scratch} Scratch Card`)
      .setDescription(rawPrize > 0
        ? `**Bet:** ${formatBeli(session.bet)}\n\n**Matched! Prize: ${formatBeli(rawPrize)}**${namiBoostLine}\n**Net:** ${scratchNet >= 0 ? '+' : ''}${formatBeli(scratchNet)}`
        : `**Bet:** ${formatBeli(session.bet)}\n\n**No match. Lost ${formatBeli(session.bet)}.**`)
      .setImage('attachment://scratch.png');
    return interaction.editReply({ embeds: [embed], components: [], files: [att] });
  }

  const embed = new EmbedBuilder()
    .setColor('#23272a')
    .setTitle('Scratch Card')
    .setDescription(`**Bet:** ${formatBeli(session.bet)}\nReveal all tiles — match 3 to win! *(${9 - revealed.length} left)*`)
    .setImage('attachment://scratch.png');
  return interaction.editReply({ embeds: [embed], components: makeScratchRows(session, revealed), files: [att] });
}

// ────────────────────────────────────────────
// NAMI ABILITY BUTTON
// ────────────────────────────────────────────

async function handleNamiAbilityButton(interaction, cardId) {
  const cardDef = cards.find(c => c.id === cardId);
  if (!cardDef || cardDef.character !== 'Nami') {
    return interaction.reply({ content: 'Unknown card.', ephemeral: true });
  }
  const user = await User.findOne({ userId: interaction.user.id });
  if (!user) return interaction.reply({ content: 'You don\'t have an account.', ephemeral: true });

  const owned = user.ownedCards.find(e => e.cardId === cardId);
  if (!owned) {
    return interaction.reply({
      content: 'Nami boosts the Beli you receive from gambling depending on her star level.\n\nExample:\n1 ✮ = 1% beli boost',
      ephemeral: true
    });
  }

  const starLevel = owned.starLevel || 0;
  const mult = (1 + starLevel * 0.01).toFixed(2);
  const pct = (starLevel * 1);
  const activation = starLevel === 0 ? ' — reach ★1 to activate!' : '.';
  return interaction.reply({
    content: `Nami boosts the Beli you receive from gambling depending on her star level.\n\nExample:\n1 ✮ = 1% beli boost\n\nCurrent: ${starLevel} ✮ = ${pct}% boost (×${mult})${activation}`,
    ephemeral: true
  });
}

// Handle modal submit for roulette lucky number
async function handleRouletteModal(interaction) {
  const parts = interaction.customId.split(':');
  const userId = parts[1];
  if (interaction.user.id !== userId) return interaction.reply({ content: 'This modal is not for you.', ephemeral: true });
  const val = interaction.fields.getTextInputValue('luckyNumber');
  const num = parseInt(val, 10);
  if (isNaN(num) || num < 0 || num > 36) return interaction.reply({ content: 'Please enter a number between 0 and 36.', ephemeral: true });
  const session = gambleSessions.get(userId);
  if (!session) return interaction.reply({ content: 'No active gamble session.', ephemeral: true });
  await interaction.deferReply();
  return handleRouletteSpin(interaction, session, `lucky:${num}`);
}



module.exports = {
  name: 'gamble',
  description: "Visit Sir Crocodile's Casino for a chance to win Beli",
  execute,
  handleSelect,
  handleButton,
  handleNamiAbilityButton,
  handleRouletteModal,
  getNamiMultiplier,
  BLACKJACK_DECK_ASSETS
};
