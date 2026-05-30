/**
 * BASE card utilities: detection + face-centered circular rendering for canvas displays.
 * BASE cards (attribute === 'BASE' or id >= 6000) use image_url and show the character's
 * face cropped from the upper-center of the image, framed with a golden circular border.
 */

/**
 * Returns true if a card is a BASE-type card.
 * BASE cards have attribute 'BASE' or an id >= 6000.
 */
function isBaseCard(card) {
  if (!card) return false;
  if (card.attribute === 'BASE') return true;
  const numId = parseInt(card.id, 10);
  return !isNaN(numId) && numId >= 6000;
}

/**
 * Draw a BASE card as a face-centered circular crop with a golden border.
 *
 * @param {CanvasRenderingContext2D} ctx  - canvas 2d context
 * @param {Image|null} img               - pre-loaded image (or null for fallback)
 * @param {number} cx                    - center X of the circle
 * @param {number} cy                    - center Y of the circle
 * @param {number} diameter              - diameter of the circular crop
 * @param {string} [fallbackText]        - short text shown when image unavailable
 */
function drawBaseFaceCard(ctx, img, cx, cy, diameter, fallbackText = '?') {
  const r = diameter / 2;

  ctx.save();

  if (img) {
    // Heuristic face region: upper-center square of the source image.
    // Most anime character art has the face in the top ~55% of height, centered.
    const srcH = img.height * 0.55;
    const srcW = Math.min(img.width * 0.80, srcH);
    const srcX = (img.width - srcW) / 2;
    const srcY = img.height * 0.02;

    // Clip to circle
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, srcX, srcY, srcW, srcH, cx - r, cy - r, diameter, diameter);
    ctx.restore();
    ctx.save();
  } else {
    // Fallback: dark fill + character initials
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(cx - r, cy - r, diameter, diameter);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold ${Math.floor(diameter * 0.28)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fallbackText.slice(0, 2).toUpperCase(), cx, cy);
    ctx.restore();
    ctx.save();
  }

  // Golden border ring (drawn on top, outside clip so it's always visible)
  ctx.beginPath();
  ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.restore();
}

module.exports = { isBaseCard, drawBaseFaceCard };
