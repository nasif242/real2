const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { isBaseCard, detectFaceCenter, drawBaseFaceCard } = require('./baseFaceRenderer');

const DEFAULT_COLS = 5;
const DEFAULT_ROWS = 3;
const CELL_W = 156;
const CELL_H = 180;

const RANK_COLORS = {
  D: '#B87333',
  C: '#f9a53f',
  B: '#c6c6c7',
  A: '#bfddff',
  S: '#9966CC',
  SS: '#26619C',
  UR: '#ff00f0'
};

const ATTRIBUTE_COLORS = {
  STR: '#FF4444',
  DEX: '#44AA44',
  QCK: '#4DABF7',
  INT: '#9966CC',
  PSY: '#FFD54F',
  BASE: '#FFFFFF'
};

async function loadImageWithTimeout(url, ms = 6000) {
  return Promise.race([
    loadImage(url),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

// Extract Discord CDN URL from a custom emoji string like <:name:123456>
function getEmojiUrl(emoji) {
  if (!emoji) return null;
  const m = emoji.match(/<a?:[^:]+:(\d+)>/);
  if (!m) return null;
  return `https://cdn.discordapp.com/emojis/${m[1]}.png`;
}

// Image source per card type:
//   ships    → image_url  (full artwork)
//   BASE     → image_url  (face-centered crop rendered separately)
//   artifacts → emoji CDN (fills slot better than the small catbox webp)
//   regular  → emoji CDN
function resolveImageUrl(slot) {
  if (!slot || !slot.cardDef) return null;
  const { cardDef } = slot;
  if (cardDef.ship) return cardDef.image_url || getEmojiUrl(cardDef.emoji) || null;
  if (isBaseCard(cardDef)) return cardDef.image_url || null;
  return getEmojiUrl(cardDef.emoji) || cardDef.image_url || null;
}

async function generateBinderCanvas(slots, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  const CANVAS_W = cols * CELL_W;
  const CANVAS_H = rows * CELL_H;

  const urls = slots.map(resolveImageUrl);
  // Run image loading and BASE-card face detection in parallel
  const [imageResults, faceRegions] = await Promise.all([
    Promise.allSettled(urls.map(url => url ? loadImageWithTimeout(url) : Promise.resolve(null))),
    Promise.all(slots.map((slot, i) => {
      if (!slot || !isBaseCard(slot.cardDef)) return Promise.resolve(null);
      return urls[i] ? detectFaceCenter(urls[i]) : Promise.resolve(null);
    }))
  ]);

  const canvas = createCanvas(CANVAS_W, CANVAS_H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  for (let i = 0; i < ROWS * COLS; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = col * CELL_W;
    const y = row * CELL_H;
    const slot = slots[i];

    ctx.fillStyle = '#161b22';
    ctx.fillRect(x + 1, y + 1, CELL_W - 2, CELL_H - 2);

    if (!slot) {
      ctx.fillStyle = '#1c2128';
      ctx.fillRect(x + 2, y + 2, CELL_W - 4, CELL_H - 4);
      continue;
    }

    const { cardDef, owned } = slot;
    const imgResult = imageResults[i];
    const img = imgResult && imgResult.status === 'fulfilled' ? imgResult.value : null;

    if (isBaseCard(cardDef)) {
      // BASE cards: square face-crop with golden border (same dimensions as regular cards)
      const PAD = 8;
      ctx.globalAlpha = owned ? 1.0 : 0.2;
      await drawBaseFaceCard(ctx, img, faceRegions[i], x + PAD, y + PAD, CELL_W - PAD * 2, CELL_H - PAD * 2, cardDef.character || '?');
      ctx.globalAlpha = 1.0;
      if (!owned) {
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(x + 1, y + 1, CELL_W - 2, CELL_H - 2);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Not Owned', x + CELL_W / 2, y + CELL_H / 2 - 10);
      }
    } else {
      // Padding: ships get a small border; artifacts & regular fill the slot
      const PAD = cardDef.ship ? 4 : cardDef.artifact ? 0 : 8;

      if (img) {
        ctx.globalAlpha = owned ? 1.0 : 0.2;
        ctx.drawImage(img, x + PAD, y + PAD, CELL_W - PAD * 2, CELL_H - PAD * 2);
        ctx.globalAlpha = 1.0;
      } else {
        ctx.fillStyle = RANK_COLORS[cardDef.rank] || '#333333';
        ctx.globalAlpha = owned ? 0.25 : 0.08;
        ctx.fillRect(x + 1, y + 1, CELL_W - 2, CELL_H - 2);
        ctx.globalAlpha = 1.0;
      }

      if (!owned) {
        // Dark overlay
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.fillRect(x + 1, y + 1, CELL_W - 2, CELL_H - 2);

        // "Not Owned" text — shifted up to make room for ID below
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Not Owned', x + CELL_W / 2, y + CELL_H / 2 - 10);
      }
    }

    // Rank badge — only for ships and artifacts (not regular attacking cards)
    if (cardDef.ship || cardDef.artifact) {
      const rank = cardDef.rank || '?';
      ctx.shadowColor = '#000000';
      ctx.shadowBlur = 5;
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(rank, x + CELL_W - 6, y + 6);
      ctx.shadowBlur = 0;
    }

    // Always render card ID at the bottom with a translucent background to ensure visibility
    try {
      const idBgX = x + 6;
      const idBgY = y + CELL_H - 26;
      const idBgW = CELL_W - 12;
      const idBgH = 20;
      // slightly darker background for improved contrast
      ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.fillRect(idBgX, idBgY, idBgW, idBgH);

      const idText = `#${cardDef.id}`;
      const idColor = (cardDef.ship || cardDef.artifact) ? '#FFFFFF' : (ATTRIBUTE_COLORS[cardDef.attribute] || '#aaaaaa');
      const centerX = x + CELL_W / 2;
      const centerY = idBgY + idBgH / 2;

      ctx.save();
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // shadow + stroke for readability against bright borders
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 6;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(idText, centerX, centerY);
      ctx.fillStyle = idColor;
      ctx.fillText(idText, centerX, centerY);
      ctx.restore();
    } catch (e) {
      // fail silently if drawing ID fails
    }
  }

  // Grid separator lines
  ctx.strokeStyle = '#2d333b';
  ctx.lineWidth = 2;
  for (let c = 1; c < cols; c++) {
    ctx.beginPath();
    ctx.moveTo(c * CELL_W, 0);
    ctx.lineTo(c * CELL_W, CANVAS_H);
    ctx.stroke();
  }
  for (let r = 1; r < rows; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * CELL_H);
    ctx.lineTo(CANVAS_W, r * CELL_H);
    ctx.stroke();
  }

  return canvas.toBuffer('image/png');
}

module.exports = {
  generateBinderCanvas,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  PER_PAGE: DEFAULT_COLS * DEFAULT_ROWS
};
