// Centralized status and battle utilities shared by isail and duel
const { getDamageMultiplier } = require('../../utils/attributeSystem');
const statusEffects = require('../../commands/status-effects');
// Build STATUS_EMOJIS from the centralized `commands/status-effects` module
// so the authoritative emoji is defined in one place.
const STATUS_EMOJIS = Object.keys(statusEffects || {}).reduce((acc, key) => {
  const entry = statusEffects[key];
  acc[key] = entry && entry.emoji ? entry.emoji : '';
  return acc;
}, {});

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function addStatus(entity, type, duration, data = {}) {
  if (!entity) return;
  if (!entity.status) entity.status = [];
  // Cap the number of distinct status types shown/managed per entity
  const MAX_STATUS_TYPES = 3;

  // Check if this status type already exists
  const existingStatus = entity.status.find(st => st && st.type === type);

  if (existingStatus) {
    // Stack up to 3 of the same status effect
    if (!existingStatus.stacks) existingStatus.stacks = 1;
    if (existingStatus.stacks < 3) existingStatus.stacks += 1;
    // Update remaining/duration and merge provided data
    existingStatus.remaining = duration;
    Object.assign(existingStatus, { ...data, stacks: existingStatus.stacks });
  } else {
    // If we're at capacity for distinct status types, drop the oldest one
    // so the most recent statuses are kept visible/active.
    if (entity.status.length >= MAX_STATUS_TYPES) {
      entity.status.shift();
    }
    // Add the new status
    entity.status.push({ type, remaining: duration, stacks: 1, ...data });
  }
}

function hasStatusLock(card) {
  if (!card || !card.status || card.status.length === 0) return false;
  return card.status.some(st => st.type === 'stun' || st.type === 'freeze');
}

function hasAttackDisabled(card) {
  if (!card || !card.status || card.status.length === 0) return false;
  return card.status.some(st => st.type === 'dissattack');
}

function getStatusLockReason(card) {
  if (!card || !card.status || card.status.length === 0) return null;
  const lock = card.status.find(st => st.type === 'stun' || st.type === 'freeze');
  if (lock) return lock.type === 'stun' ? 'stunned' : 'frozen';
  return null;
}

function getProneMultiplier(attacker, defender) {
  if (!defender || !defender.status || !attacker) return 1;
  const prone = defender.status.find(st => st.type === 'prone');
  if (!prone) return 1;
  // attacker/defender may be card objects (with .def.attribute) or simple
  // marine objects (with .attribute). Fall back safely to avoid undefined.
  const attackerAttr = attacker?.def?.attribute || attacker?.attribute || 'STR';
  const defenderAttr = defender?.def?.attribute || defender?.attribute || 'STR';
  const attrMultiplier = getDamageMultiplier(attackerAttr, defenderAttr);
  if (attrMultiplier > 1) {
    const extra = (prone.amount ?? 20) / 100;
    return 1 + extra;
  }
  return 1;
}

function getDrunkChance(entity) {
  if (!entity || !entity.status) return 0;
  const drunk = entity.status.find(st => st.type === 'drunk');
  return drunk ? (drunk.chance ?? 20) : 0;
}

function removeStatusTypes(entity, types) {
  if (!entity || !entity.status) return;
  entity.status = entity.status.filter(st => !types.includes(st.type));
}

function decrementStatusDurations(entity) {
  if (!entity || !entity.status) return;
  entity.status = entity.status.filter(st => {
    if (st.remaining > 0) {
      st.remaining--;
      return st.remaining > 0;
    }
    return false;
  });
}

function decrementStatusDurationsForTeam(team) {
  if (Array.isArray(team)) {
    team.forEach(decrementStatusDurations);
  } else {
    decrementStatusDurations(team);
  }
}

function _handleKO(entity) {
  if (!entity) return null;
  if (entity.currentHP <= 0) {
    const undeadActive = entity.status?.some(st => st.type === 'undead' && st.remaining > 0);
    if (undeadActive) {
      entity.currentHP = 1;
      entity.alive = true;
      entity.energy = 0;
      return `${entity.def?.character || entity.rank || 'Entity'} is undead and remains alive at 1 HP!`;
    }
    entity.currentHP = 0;
    entity.alive = false;
    entity.energy = 0;
    return `${entity.def?.character || entity.rank || 'Entity'} is knocked out!`;
  }
  return null;
}

// Apply start-of-turn status effects (cut, bleed, stun expiration, etc.) to the
// provided team array. Bleed damage and duration are handled here per turn.
// Returns an array of log strings describing what happened.
function applyStartOfTurnEffects(teamArray) {
  const logs = [];
  // Safety checks: ensure teamArray is valid
  if (!teamArray || !Array.isArray(teamArray)) return logs;
  
  teamArray.forEach(e => {
    if (!e || !e.status) return;
    e.status = e.status.filter(st => {
      const handler = statusEffects[st.type];
      if (handler && typeof handler.onStartOfTurn === 'function') {
        return handler.onStartOfTurn(e, st, logs, _handleKO);
      }

      if (st.remaining !== Infinity) {
        st.remaining -= 1;
      }
      return st.remaining > 0 || st.remaining === Infinity;
    });
  });
  return logs;
}


// Apply card effect (stun, freeze, cut, bleed, team_stun)
// Mutates target(s) by adding statuses and returns array of log strings.
// Duration 0 = permanent effect; duration > 0 = ticks down each action/turn.
function applyCardEffect(attacker, target, context = {}) {
  const logs = [];
  if (!attacker || !attacker.def || !attacker.def.effect) return logs;
  const def = attacker.def;
  
  // Check if target is Gorosei - if so, they are immune to all status conditions
  const checkGoroseiImmunity = (entity) => {
    if (!entity) return false;
    return entity.rank === 'Gorosei' || (entity.def && entity.def.character && entity.def.character.toLowerCase().includes('gorosei'));
  };
  
  if (Array.isArray(target)) {
    const goroseiTargets = target.filter(checkGoroseiImmunity);
    if (goroseiTargets.length > 0) {
      goroseiTargets.forEach(g => logs.push(`${g.rank || 'Gorosei'} is immune to status conditions!`));
      // Remove Gorosei from target list
      target = target.filter(t => !checkGoroseiImmunity(t));
      if (target.length === 0) return logs;
    }
  } else if (target && checkGoroseiImmunity(target)) {
    logs.push(`${target.rank || 'Gorosei'} is immune to status conditions!`);
    return logs;
  }
  
  // Attempt to resolve a team target when `def.all` is set but a single
  // entity was passed. Callers may provide `context` with helpful team
  // arrays: `playerTeam`, `opponentTeam`, `marines` or `cards`.
  const isAlive = (e) => {
    if (!e) return false;
    if (typeof e.currentHP === 'number') return e.currentHP > 0;
    if (typeof e.alive === 'boolean') return e.alive;
    return true;
  };
  let resolvedTarget = target;
  const defAllish = def.all;
  if (defAllish && !Array.isArray(target)) {
    // Debugging: log resolution attempt for `all:true` effects (include def id/all)
    try {
      const attackerName = (attacker && attacker.def && (attacker.def.character || attacker.def.id)) || 'unknown';
      console.log(`[statusManager] resolving all:true for ${attackerName} defId=${def.id} defAllish=${!!defAllish} (effect=${def.effect}) - targetIsArray=${Array.isArray(target)}`);
    } catch (e) {}
    if (Array.isArray(context.playerTeam) && Array.isArray(context.opponentTeam)) {
      if (context.playerTeam.includes(attacker)) {
        resolvedTarget = context.opponentTeam.filter(isAlive);
      } else if (context.opponentTeam.includes(attacker)) {
        resolvedTarget = context.playerTeam.filter(isAlive);
      } else {
        resolvedTarget = context.opponentTeam.filter(isAlive);
      }
    } else if (Array.isArray(context.marines)) {
      resolvedTarget = context.marines.filter(isAlive);
    } else if (Array.isArray(context.cards)) {
      resolvedTarget = context.cards.filter(isAlive);
    }
    try {
      console.log(`[statusManager] resolvedTarget for defId=${def.id} defAllish=${!!defAllish} length=${Array.isArray(resolvedTarget)?resolvedTarget.length:'N/A'}`);
    } catch (e) {}
  }
  
  // Filter out Gorosei from resolvedTarget if present
  if (Array.isArray(resolvedTarget)) {
    const goroseiTargets = resolvedTarget.filter(checkGoroseiImmunity);
    if (goroseiTargets.length > 0) {
      goroseiTargets.forEach(g => logs.push(`${g.rank || 'Gorosei'} is immune to status conditions!`));
      resolvedTarget = resolvedTarget.filter(t => !checkGoroseiImmunity(t));
    }
  }
  
  // Store original duration for message display
  const origDur = def.effectDuration ?? (def.effect === 'doomed' ? 3 : 1);
  // If duration is 0 or -1, effect is permanent (use Infinity internally)
  let dur = origDur === 0 || origDur === -1 ? Infinity : origDur;
  if (def.effect === 'freeze' || def.effect === 'hungry') {
    dur = Infinity;
  }

  const selfEffects = ['truesight', 'undead'];
  const applyTo = def.effect === 'team_stun'
    ? resolvedTarget
    : (defAllish && Array.isArray(resolvedTarget))
      ? resolvedTarget
      : (def.itself || selfEffects.includes(def.effect))
        ? attacker
        : resolvedTarget;

  // Stun, freeze, team_stun and truesight use the duration as the number of
  // turns they remain active, without additional multipliers.

  const statusMessage = () => {
    if (def.effect === 'freeze' || def.effect === 'hungry') return ` (permanent)`;
    if (origDur === 0 || origDur === -1) return ` (permanent)`;
    return ` for ${origDur} turn${origDur > 1 ? 's' : ''}`;
  };

  const statusTargetName = (entity) => {
    if (Array.isArray(entity)) return 'All targets';
    return entity?.def?.character || entity?.rank || 'Enemy';
  };

  const addEffectToTarget = (effectTarget, type, duration, data = {}) => {
    if (Array.isArray(effectTarget)) {
      effectTarget.forEach(t => addStatus(t, type, duration, data));
    } else {
      addStatus(effectTarget, type, duration, data);
    }
  };

  const effectHandler = statusEffects[def.effect];
  if (effectHandler && typeof effectHandler.applyEffect === 'function' && effectHandler.applyEffect.length === 1) {
    const effectLogs = effectHandler.applyEffect({ target: applyTo, def, dur, origDur, addEffectToTarget, statusTargetName, statusMessage });
    if (Array.isArray(effectLogs)) {
      logs.push(...effectLogs);
    } else if (effectLogs) {
      logs.push(effectLogs);
    }
    return logs;
  }

  switch (def.effect) {
    case 'stun':
      addEffectToTarget(applyTo, 'stun', dur);
      logs.push(`${statusTargetName(applyTo)} is stunned and can't move${statusMessage()}!`);
      break;
    case 'freeze':
      addEffectToTarget(applyTo, 'freeze', dur);
      logs.push(`${statusTargetName(applyTo)} is frozen and can't move${statusMessage()}!`);
      break;
    case 'cut': {
      const amount = def.effectAmount ?? 1;
      addEffectToTarget(applyTo, 'cut', dur, { amount });
      logs.push(`${statusTargetName(applyTo)} is cut${statusMessage()}!`);
      break;
    }
    case 'bleed': {
      const amount = def.effectAmount ?? 2;
      addEffectToTarget(applyTo, 'bleed', dur, { amount });
      // Intentionally do not emit a separate "is bleeding" log here to avoid
      // duplicating the inline effect description shown with the attack.
      break;
    }
    case 'team_stun':
      if (Array.isArray(resolvedTarget)) {
        addEffectToTarget(resolvedTarget, 'stun', dur);
        logs.push(`All opponents are stunned${statusMessage()}!`);
      }
      break;
    case 'regen':
      addEffectToTarget(applyTo, 'regen', dur, { amount: def.effectAmount ?? 10 });
      logs.push(`${statusTargetName(applyTo)} gains regen (${def.effectAmount ?? 10}%)${statusMessage()}!`);
      break;
    case 'confusion': {
      const chance = def.effectChance ?? def.effectAmount ?? 50;
      addEffectToTarget(applyTo, 'confusion', dur, { chance });
      logs.push(`${statusTargetName(applyTo)} is confused (${chance}% miss chance)${statusMessage()}!`);
      break;
    }
    case 'attackup': {
      if (def.effectAmount !== undefined) {
        const amount = def.effectAmount;
        addEffectToTarget(applyTo, 'attackup', dur, { amount });
        logs.push(`${statusTargetName(applyTo)}'s attack is boosted (${amount}%)${statusMessage()}!`);
      }
      break;
    }
    case 'attackdown': {
      if (def.effectAmount !== undefined) {
        const amount = def.effectAmount;
        addEffectToTarget(applyTo, 'attackdown', dur, { amount });
        logs.push(`${statusTargetName(applyTo)}'s attack is reduced (${amount}%)${statusMessage()}!`);
      }
      break;
    }
    case 'defenseup': {
      if (def.effectAmount !== undefined) {
        const amount = def.effectAmount;
        addEffectToTarget(applyTo, 'defenseup', dur, { amount });
        logs.push(`${statusTargetName(applyTo)}'s defense is boosted (${amount}%)${statusMessage()}!`);
      }
      break;
    }
    case 'defensedown': {
      if (def.effectAmount !== undefined) {
        const amount = def.effectAmount;
        addEffectToTarget(applyTo, 'defensedown', dur, { amount });
        logs.push(`${statusTargetName(applyTo)}'s defense is reduced (${amount}%)${statusMessage()}!`);
      }
      break;
    }
    case 'dissattack':
      addEffectToTarget(applyTo, 'dissattack', dur);
      logs.push(`${statusTargetName(applyTo)} cannot attack or special attack${statusMessage()}!`);
      break;
    default:
      break;
  }
  return logs;
}

function getAttackModifier(entity) {
  if (!entity || !entity.status) return 1;
  const up = entity.status
    .filter(st => st.type === 'attackup')
    .reduce((sum, st) => sum + (st.amount ?? 12), 0);
  const down = entity.status
    .filter(st => st.type === 'attackdown')
    .reduce((sum, st) => sum + (st.amount ?? 12), 0);
  return Math.max(0, 1 + (up - down) / 100);
}

function getDefenseMultiplier(attacker, defender) {
  if (!defender || !defender.status) return 1;
  const up = defender.status
    .filter(st => st.type === 'defenseup')
    .reduce((sum, st) => sum + (st.amount || 12), 0);
  const down = defender.status
    .filter(st => st.type === 'defensedown')
    .reduce((sum, st) => sum + (st.amount || 12), 0);
  return 1 + (down - up) / 100; // down boosts attack by %, up reduces by %
}

function getConfusionChance(entity) {
  if (!entity || !entity.status) return 0;
  const confusion = entity.status.find(st => st.type === 'confusion');
  return confusion ? (confusion.chance || 0) : 0;
}

function hasTruesight(entity) {
  if (!entity || !entity.status) return false;
  return entity.status.some(st => st.type === 'truesight' && st.remaining > 0);
}

function consumeTruesight(entity) {
  if (!entity || !entity.status) return false;
  const idx = entity.status.findIndex(st => st.type === 'truesight' && st.remaining > 0);
  if (idx < 0) return false;
  const status = entity.status[idx];
  if (status.remaining !== Infinity) {
    status.remaining = Math.max(0, status.remaining - 1);
    if (status.remaining === 0) {
      entity.status.splice(idx, 1);
    }
  }
  return true;
}

function calculateUserDamage(card, type) {
  if (!card || !card.scaled) return 0;
  const scaled = card.scaled || {};
  
  if (type === 'special') {
    if (card.def.special_attack && scaled.special_attack) {
      const min = scaled.special_attack.min;
      const max = scaled.special_attack.max;
      const low = Math.min(min, max);
      const high = Math.max(min, max);
      return randomInt(low, high);
    }
    return 0;
  }
  
  if (scaled.attack_min != null && scaled.attack_max != null) {
    const low = Math.min(scaled.attack_min, scaled.attack_max);
    const high = Math.max(scaled.attack_min, scaled.attack_max);
    return randomInt(low, high);
  }
  return 0;
}

// Bleed: damage per energy spent. Returns logs and applies KO handling.
function applyBleedOnEnergyUse(entity, energySpent) {
  const logs = [];
  if (!entity || !entity.status || energySpent <= 0) return logs;
  const bleed = entity.status.find(s => s.type === 'bleed');
  if (!bleed) return logs;
  const amount = bleed.amount ?? 2;
  const total = amount * energySpent;
  entity.currentHP = Math.max(0, (entity.currentHP || 0) - total);
  logs.push(`${entity.def?.character || entity.rank || 'Entity'} takes -${total} HP from bleed!`);
  // only decrement if NOT permanent (finite remaining)
  if (bleed.remaining !== Infinity) {
    bleed.remaining = Math.max(0, bleed.remaining - 1);
    if (bleed.remaining <= 0) {
      entity.status = entity.status.filter(s => s.type !== 'bleed');
      logs.push(`${entity.def?.character || entity.rank || 'Entity'} is no longer bleeding!`);
    }
  }
  const ko = _handleKO(entity);
  if (ko) logs.push(ko);
  return logs;
}

module.exports = {
  STATUS_EMOJIS,
  addStatus,
  hasStatusLock,
  hasAttackDisabled,
  getStatusLockReason,
  applyStartOfTurnEffects,
  applyCardEffect,
  calculateUserDamage,
  getAttackModifier,
  getDefenseMultiplier,
  getConfusionChance,
  getProneMultiplier,
  getDrunkChance,
  applyBleedOnEnergyUse,
  removeStatusTypes,
  hasTruesight,
  consumeTruesight,
  decrementStatusDurations,
  decrementStatusDurationsForTeam,
  handleKO: _handleKO
};
