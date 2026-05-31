// Consolidated status effects module
// Replaces the previous commands/status-effects/* modules with a single file
// Each effect exposes an `applyEffect` function (object-style) and an
// optional `onStartOfTurn(entity, status, logs, handleKO)` handler for
// start-of-turn behavior.

const effects = {};

// CUTt
effects.cut = {
  type: 'cut',
  emoji: '<:1000048305:1497961725788426301>',
  applyEffect({ target, def, dur, origDur, addEffectToTarget, statusTargetName, statusMessage }) {
    const amount = def.effectAmount ?? 1;
    addEffectToTarget(target, 'cut', dur, { amount });
    return [`${statusTargetName(target)} is cut${statusMessage()}!`];
  },
  onStartOfTurn(entity, status, logs, handleKO) {
    const amount = status.amount ?? 1;
    entity.currentHP = Math.max(0, (entity.currentHP || 0) - amount);
    logs.push(`${entity.def?.character || entity.rank || 'Entity'} suffers cut for -${amount} HP!`);
    const ko = handleKO(entity);
    if (ko) logs.push(ko);
    if (status.remaining !== Infinity) status.remaining = Math.max(0, status.remaining - 1);
    return status.remaining > 0 || status.remaining === Infinity;
  }
};

// BLEED: damage when energy is spent (handled by statusManager.applyBleedOnEnergyUse)
effects.bleed = {
  type: 'bleed',
  emoji: '<:1000048306:1497961727336386641>',
  applyEffect({ target, def, dur, origDur, addEffectToTarget }) {
    const amount = def.effectAmount ?? 2;
    addEffectToTarget(target, 'bleed', dur, { amount });
    // Intentionally no start-of-turn damage/log — bleed is applied on energy use
    return [];
  }
};

// ACID: damage each turn, increasing by the base amount each turn
effects.acid = {
  type: 'acid',
  emoji: '<:1000048293:1497961712958177400>',
  applyEffect({ target, def, dur, origDur, addEffectToTarget, statusTargetName, statusMessage }) {
    const base = def.effectAmount ?? 1;
    // store both current amount and base increment so growth is fixed to base
    addEffectToTarget(target, 'acid', dur, { amount: base, baseAmount: base });
    return [`${statusTargetName(target)} is coated in acid${statusMessage()}!`];
  },
  onStartOfTurn(entity, status, logs, handleKO) {
    const amount = status.amount ?? status.baseAmount ?? 1;
    entity.currentHP = Math.max(0, (entity.currentHP || 0) - amount);
    logs.push(`${entity.def?.character || entity.rank || 'Entity'} suffers acid for -${amount} HP!`);
    const ko = handleKO(entity);
    if (ko) logs.push(ko);
    if (status.remaining !== Infinity) status.remaining = Math.max(0, status.remaining - 1);
    // increase damage by the original base amount each turn
    status.amount = amount + (status.baseAmount ?? 1);
    return status.remaining > 0 || status.remaining === Infinity;
  }
};

// REGEN
effects.regen = {
  type: 'regen',
  emoji: '<:1000048286:1497963088992010362>',
  applyEffect({ target, def, dur, origDur, addEffectToTarget, statusTargetName, statusMessage }) {
    const amount = def.effectAmount ?? 10;
    addEffectToTarget(target, 'regen', dur, { amount });
    return [`${statusTargetName(target)} gains regen (${amount}%)${statusMessage()}!`];
  },
  onStartOfTurn(entity, status, logs) {
    const amount = status.amount ?? 0;
    const baseHP = entity.maxHP || entity.def?.health || 0;
    // Only apply regen if the entity is currently alive (do not revive KO'd entities)
    if (baseHP > 0 && (entity.currentHP || 0) > 0) {
      const heal = Math.ceil(baseHP * amount / 100);
      entity.currentHP = Math.min(baseHP, (entity.currentHP || 0) + heal);
      logs.push(`${entity.def?.character || entity.rank || 'Entity'} regenerates ${heal} HP from regen!`);
    }
    if (status.remaining !== Infinity) status.remaining = Math.max(0, status.remaining - 1);
    return status.remaining > 0 || status.remaining === Infinity;
  }
};

// STUN
effects.stun = {
  type: 'stun',
  emoji: '<:1000048308:1497961729219494099>',
  applyEffect({ target, def, dur, addEffectToTarget, statusTargetName, statusMessage }) {
    addEffectToTarget(target, 'stun', dur);
    return [`${statusTargetName(target)} is stunned and can't move${statusMessage()}!`];
  }
};

// TRUESIGHT
effects.truesight = {
  type: 'truesight',
  emoji: '<:1000048290:1497961702464163970>',
  applyEffect({ target, def, dur, addEffectToTarget, statusTargetName, statusMessage }) {
    addEffectToTarget(target, 'truesight', dur);
    return [`${statusTargetName(target)} gains truesight${statusMessage()}!`];
  }
};

// UNDEAD
effects.undead = {
  type: 'undead',
  emoji: '<:1000048291:1497961722533646366>',
  applyEffect({ target, def, dur, addEffectToTarget, statusTargetName, statusMessage }) {
    addEffectToTarget(target, 'undead', dur);
    if (!Array.isArray(target)) {
      target.currentHP = 1;
      target.alive = true;
    } else {
      target.forEach(entity => { entity.currentHP = 1; entity.alive = true; });
    }
    return [`${statusTargetName(target)} becomes undead${statusMessage()}!`];
  },
  onStartOfTurn(entity, status, logs, handleKO) {
    if (status.remaining !== Infinity) {
      status.remaining = Math.max(0, status.remaining - 1);
      if (status.remaining <= 0) {
        if ((entity.currentHP || 0) <= 0) {
          entity.alive = false;
          entity.energy = 0;
          logs.push(`${entity.def?.character || entity.rank || 'Entity'} is no longer undead and collapses!`);
        } else {
          logs.push(`${entity.def?.character || entity.rank || 'Entity'} is no longer undead.`);
        }
        return false;
      }
    }
    return true;
  }
};

// CONFUSION
effects.confusion = {
  type: 'confusion',
  emoji: '<:1000048287:1497961705592848495>',
  applyEffect({ target, def, dur, addEffectToTarget, statusTargetName, statusMessage }) {
    const chance = def.effectChance ?? def.effectAmount ?? 50;
    addEffectToTarget(target, 'confusion', dur, { chance });
    return [`${statusTargetName(target)} is confused (${chance}% chance to hit themselves)${statusMessage()}!`];
  }
};

// ATTACK/DEFENSE UP/DOWN
['attackup','attackdown','defenseup','defensedown'].forEach(name => {
  effects[name] = {
    type: name,
    emoji: name === 'attackup' ? '<:1000048307:1497961719094444217>' : (name === 'attackdown' ? '<:1000048289:1497961703810400347>' : (name === 'defenseup' ? '<:1000048288:1497961711234567890>' : '<:1000048285:1497961701234567890>')),
    applyEffect({ target, def, dur, addEffectToTarget, statusTargetName, statusMessage }) {
      if (def.effectAmount === undefined) {
        return [];
      }
      const amount = def.effectAmount;
      addEffectToTarget(target, name, dur, { amount });
      const verb = name.includes('attack') ? (name === 'attackup' ? "'s attack is boosted" : "'s attack is reduced") : (name === 'defenseup' ? "'s defense is boosted" : "'s defense is reduced");
      return [`${statusTargetName(target)}${verb} (${amount}%)${statusMessage()}!`];
    }
  };
});

// PRONE
effects.prone = {
  type: 'prone',
  emoji: '<:1000048294:1497961715009327225>',
  applyEffect({ target, def, dur, addEffectToTarget, statusTargetName, statusMessage }) {
    const amount = def.effectAmount ?? 20;
    addEffectToTarget(target, 'prone', dur, { amount });
    return [`${statusTargetName(target)} becomes prone (${amount}% extra from effective attributes)${statusMessage()}!`];
  }
};

// BLESSED
effects.blessed = {
  type: 'blessed',
  emoji: '<:1000048295:1497961716733050950>',
  applyEffect({ target, def, dur, addEffectToTarget, statusTargetName, statusMessage }) {
    addEffectToTarget(target, 'blessed', dur);
    return [`${statusTargetName(target)} is blessed and gains energy faster${statusMessage()}!`];
  }
};

// CHARMED
effects.charmed = {
  type: 'charmed',
  emoji: '<:1000048296:1497961707832610938>',
  applyEffect({ target, def, dur, addEffectToTarget, statusTargetName, statusMessage }) {
    addEffectToTarget(target, 'charmed', dur);
    return [`${statusTargetName(target)} is charmed and cannot attack same-attribute targets${statusMessage()}!`];
  }
};

// DOOMED
effects.doomed = {
  type: 'doomed',
  emoji: '<:1000048297:1497961709388824798>',
  applyEffect({ target, def, dur, origDur, addEffectToTarget, statusTargetName, statusMessage }) {
    addEffectToTarget(target, 'doomed', dur);
    return [`${statusTargetName(target)} is doomed and will die in ${origDur} turn${origDur > 1 ? 's' : ''}${statusMessage()}!`];
  },
  onStartOfTurn(entity, status, logs, handleKO) {
    if (status.remaining !== Infinity) {
      status.remaining = Math.max(0, status.remaining - 1);
      if (status.remaining <= 0) {
        entity.currentHP = 0;
        entity.alive = false;
        entity.energy = 0;
        logs.push(`${entity.def?.character || entity.rank || 'Entity'} is doomed and collapses!`);
        return false;
      }
    }
    return true;
  }
};

// DRUNK
effects.drunk = {
  type: 'drunk',
  emoji: '<:1000048298:1497961711054094367>',
  applyEffect({ target, def, dur, addEffectToTarget, statusTargetName, statusMessage }) {
    const chance = def.effectChance ?? def.effectAmount ?? 20;
    addEffectToTarget(target, 'drunk', dur, { chance });
    return [`${statusTargetName(target)} is drunk (${chance}% chance to hit the wrong target)${statusMessage()}!`];
  }
};

// HUNGRY: permanent until explicitly rested (remaining = Infinity)
effects.hungry = {
  type: 'hungry',
  emoji: '<:1000048299:1497961706721116383>',
  applyEffect({ target, def, dur, addEffectToTarget, statusTargetName, statusMessage }) {
    const amount = def.effectAmount ?? 1;
    // make permanent (only removable by rest)
    addEffectToTarget(target, 'hungry', Infinity, { amount });
    return [`${statusTargetName(target)} is hungry and takes damage each turn${statusMessage()}!`];
  },
  onStartOfTurn(entity, status, logs, handleKO) {
    const amount = status.amount ?? 1;
    entity.currentHP = Math.max(0, (entity.currentHP || 0) - amount);
    logs.push(`${entity.def?.character || entity.rank || 'Entity'} suffers hunger for -${amount} HP!`);
    const ko = handleKO(entity);
    if (ko) logs.push(ko);
    // keep permanently until removed by rest
    return true;
  }
};

// REFLECT
effects.reflect = {
  type: 'reflect',
  emoji: '<:1000048292:1497961724018557040>',
  applyEffect({ target, def, dur, addEffectToTarget, statusTargetName, statusMessage }) {
    addEffectToTarget(target, 'reflect', dur);
    return [`${statusTargetName(target)} gains reflect${statusMessage()}!`];
  }
};

module.exports = effects;
