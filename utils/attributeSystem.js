// Attribute system for combat.
/// Each card has an attribute: STR, DEX, QCK, PSY, INT, BASE

const ATTRIBUTE_MATCHUPS = {
  STR: { effective: 'DEX', weak: 'QCK' },
  DEX: { effective: 'QCK', weak: 'STR' },
  QCK: { effective: 'STR', weak: 'DEX' },
  PSY: { effective: 'INT', weak: null },
  INT: { effective: 'PSY', weak: null },
  BASE: { effective: null, weak: null }
};

/**
 * Calculate damage multiplier based on attacker and defender attributes
 * @param {string} attackerAttribute - Attacker's attribute (STR, DEX, QCK, PSY, INT)
 * @param {string} defenderAttribute - Defender's attribute (STR, DEX, QCK, PSY, INT)
 * @returns {number} Damage multiplier (0.5, 1, or 2)
 */
function getDamageMultiplier(attackerAttribute, defenderAttribute) {
  if (!attackerAttribute || !defenderAttribute || !ATTRIBUTE_MATCHUPS[attackerAttribute]) {
    return 1; // Neutral
  }

  const matchup = ATTRIBUTE_MATCHUPS[attackerAttribute];

  if (matchup.effective === defenderAttribute) {
    return 2; // Effective attack
  }

  if (matchup.weak === defenderAttribute) {
    return 0.5; // Weak attack
  }

  return 1; // Neutral
}

/**
 * Get attribute advantage description
 * @param {string} attackerAttribute
 * @param {string} defenderAttribute
 * @returns {string} Description of advantage/disadvantage
 */
function getAttributeDescription(attackerAttribute, defenderAttribute) {
  const multiplier = getDamageMultiplier(attackerAttribute, defenderAttribute);

  if (multiplier === 2) {
    return `${attackerAttribute} is effective against ${defenderAttribute}! (2x damage)`;
  } else if (multiplier === 0.5) {
    return `${attackerAttribute} is weak to ${defenderAttribute}! (0.5x damage)`;
  }

  return `${attackerAttribute} vs ${defenderAttribute} (neutral damage)`;
}

module.exports = {
  ATTRIBUTE_MATCHUPS,
  getDamageMultiplier,
  getAttributeDescription
};
