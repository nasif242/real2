let createCanvas, loadImage;
let _imageCache = null;
let loadImageCached = null;
let CANVAS_AVAILABLE = true;
const { isBaseCard, drawBaseFaceCard } = require('./baseFaceRenderer');

// Try preferred fast native binding first, then fall back to node-canvas
try {
  ({ createCanvas, loadImage } = require('@napi-rs/canvas'));
} catch (e1) {
  try {
    // node-canvas exposes createCanvas and loadImage as properties
    const nodeCanvas = require('canvas');
    createCanvas = nodeCanvas.createCanvas;
    loadImage = nodeCanvas.loadImage;
  } catch (e2) {
    CANVAS_AVAILABLE = false;
    console.warn('[teamImage] canvas not available; using lightweight fallback (no images)');
  }
}

if (CANVAS_AVAILABLE) {
  // Module-level cache keyed by URL — stores Promises so concurrent calls
  // for the same URL share one CDN request instead of firing duplicates.
  _imageCache = new Map();
  loadImageCached = async function (url) {
    if (_imageCache.has(url)) return _imageCache.get(url);
    const promise = Promise.race([
      loadImage(url),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Image fetch timeout')), 6000)
      )
    ]).catch(() => {
      _imageCache.delete(url); // remove on failure so next call retries
      return null;
    });
    _imageCache.set(url, promise);
    return promise;
  };
}

function parseDiscordEmojiUrl(emojiString) {
  const match = emojiString.match(/<a?:[^:]+:(\d+)>/);
  if (!match) return null;
  return `https://cdn.discordapp.com/emojis/${match[1]}.png?size=256`;
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fitImageToSquare(ctx, img, x, y, size, radius = 32) {
  ctx.save();
  roundRect(ctx, x, y, size, size, radius);
  ctx.clip();
  ctx.drawImage(img, x, y, size, size);
  ctx.restore();
}

async function loadCardImage(card) {
  if (!CANVAS_AVAILABLE) return null;
  // BASE cards use image_url directly for face-centered rendering
  if (isBaseCard(card)) {
    if (card.image_url) {
      try {
        const img = await loadImageCached(card.image_url);
        if (img) return img;
      } catch (e) {}
    }
    return null;
  }
  if (card.emoji) {
    const emojiUrl = parseDiscordEmojiUrl(card.emoji);
    if (emojiUrl) {
      try {
        const img = await loadImageCached(emojiUrl);
        if (img) return img;
      } catch (e) {}
    }
  }
  if (card.image_url) {
    try {
      const img = await loadImageCached(card.image_url);
      if (img) return img;
    } catch (e) {}
  }
  return null;
}

// 1x1 transparent PNG as a safe fallback when canvas isn't available
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=',
  'base64'
);

async function generateTeamImage({ username, totalPower, cards, backgroundUrl }) {
  if (!CANVAS_AVAILABLE) {
    // Fallback to Jimp-based image generation so we still return a useful
    // team image (with total power and username) when native canvas isn't
    // available in the environment.
    try {
      const Jimp = require('jimp');
      const width = 980;
      const height = 520;
      const image = new Jimp(width, height, 0x0c1221ff);

      // translucent overlay
      const overlay = new Jimp(width, height, 0x06122bbf);
      image.composite(overlay, 0, 0);

      const fontSmall = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
      const fontLarge = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
      const fontMedium = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

      // TOTAL POWER label
      image.print(fontSmall, 0, 32, {
        text: 'TOTAL POWER',
        alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER
      }, width);

      // numeric total
      image.print(fontLarge, 0, 96, {
        text: (totalPower || 0).toLocaleString(),
        alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER
      }, width);

      // draw three card placeholders
      const cardSizes = [190, 240, 190];
      const positions = [220, 490, 760];
      const squareYs = [200, 180, 200];

      for (let i = 0; i < 3; i++) {
        const cardSize = cardSizes[i];
        const x = positions[i] - cardSize / 2;
        const squareY = squareYs[i];

        const box = new Jimp(cardSize + 20, cardSize + 20, 0x1f2f58ff);
        image.composite(box, x - 10, squareY - 10);

        const card = cards[i];
        if (card) {
          // Draw initial letters as fallback
          const initials = (card.character || '').slice(0, 2).toUpperCase();
          image.print(fontMedium, x, squareY + cardSize / 2 - 8, {
            text: initials,
            alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER
          }, cardSize);
        }
      }

      // username's team label
      image.print(fontSmall, 0, height - 56, {
        text: `${username}'s team`,
        alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER
      }, width);

      const buf = await image.getBufferAsync(Jimp.MIME_PNG);
      return buf;
    } catch (e) {
      return PLACEHOLDER_PNG;
    }
  }

  const width = 980;
  const height = 520;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const bgPromise = backgroundUrl
    ? loadImageCached(backgroundUrl).catch(() => null)
    : Promise.resolve(null);

  const cardImagePromises = cards.slice(0, 3).map(c => c ? loadCardImage(c) : Promise.resolve(null));

  const [bg, ...cardImages] = await Promise.all([bgPromise, ...cardImagePromises]);

  if (bg) {
    const scale = Math.max(width / bg.width, height / bg.height);
    const sw = bg.width * scale;
    const sh = bg.height * scale;
    ctx.drawImage(bg, (width - sw) / 2, (height - sh) / 2, sw, sh);
  } else {
    ctx.fillStyle = '#0c1221';
    ctx.fillRect(0, 0, width, height);
  }

  ctx.fillStyle = 'rgba(6, 18, 43, 0.75)';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 26px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('TOTAL POWER', width / 2, 60);

  ctx.font = '800 86px sans-serif';
  ctx.fillStyle = '#ffd85e';
  ctx.fillText(totalPower.toLocaleString(), width / 2, 140);

  const cardSizes = [190, 240, 190];
  const positions = [220, 490, 760];
  const squareYs = [200, 180, 200];

  for (let i = 0; i < 3; i++) {
    const cardSize = cardSizes[i];
    const x = positions[i] - cardSize / 2;
    const squareY = squareYs[i];

    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(ctx, x - 10, squareY - 10, cardSize + 20, cardSize + 20, 34);
    ctx.fill();

    const card = cards[i];
    if (card) {
      const cardImage = cardImages[i];
      if (isBaseCard(card)) {
        // BASE cards: face-centered circular crop with golden border
        const cx = x + cardSize / 2;
        const cy = squareY + cardSize / 2;
        const diameter = cardSize - 10;
        drawBaseFaceCard(ctx, cardImage, cx, cy, diameter, card.character || '?');
      } else if (cardImage) {
        fitImageToSquare(ctx, cardImage, x, squareY, cardSize, 40);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 8;
        roundRect(ctx, x - 6, squareY - 6, cardSize + 12, cardSize + 12, 42);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#1f2f58';
        roundRect(ctx, x, squareY, cardSize, cardSize, 40);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 40px sans-serif';
        ctx.fillText(card.character.slice(0, 2).toUpperCase(), x + cardSize / 2, squareY + cardSize / 2 + 16);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 8;
        roundRect(ctx, x - 6, squareY - 6, cardSize + 12, cardSize + 12, 42);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      roundRect(ctx, x, squareY, cardSize, cardSize, 40);
      ctx.fill();
    }
  }

  ctx.fillStyle = '#c8d2ea';
  ctx.font = '600 24px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${username}'s team`, width / 2, height - 40);

  return canvas.toBuffer('image/png');
}

module.exports = { generateTeamImage };
