// I changed the title, keep it that way. the enrgy icon is: <:energy:1478051414558118052>

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');

// helper to safely defer interaction updates without crashing on expired ones
async function safeDefer(interaction) {
  if (!interaction) return;
  // If already acknowledged, nothing to do
  if (interaction.deferred || interaction.replied) return;

  // Prefer `deferUpdate` (silent ack for component interactions). If that
  // fails (some interaction types can't be update-deferred), fall back to
  // `deferReply({ ephemeral: true })`. As a last resort try a plain reply.
  try {
    await interaction.deferUpdate();
    return;
  } catch (e) {
    // Try deferReply fallback
    try {
      await interaction.deferReply({ ephemeral: true });
      return;
    } catch (e2) {
      try {
        if (!interaction.replied) await interaction.reply({ content: 'Acknowledged.', ephemeral: true });
        return;
      } catch (e3) {
        // Log original error(s) for investigation but don't blow up
        if (e && e.code !== 10062) console.error('Failed to defer interaction (deferUpdate):', e);
        if (e2 && e2.code !== 10062) console.error('Failed to defer interaction (deferReply):', e2);
        if (e3 && e3.code !== 10062) console.error('Failed to reply as fallback:', e3);
      }
    }
  }
}

// helper to safely update battle messages without crashing when message is deleted
async function safeUpdateBattleMessage(msg, state, user, discordUser) {
  try {
    await updateBattleMessage(msg, state, user, discordUser);
  } catch (e) {
    if (e.code !== 10008) {
      console.error('Error updating battle message:', e);
    }
  }
}
const User = require('../models/User');
const { cards: cardDefs } = require('../data/cards');
const marines = require('../data/marines');
// stats computations (level & boosts) are resolved via a shared helper
// so that `info` and `isail` always produce identical values.
const { resolveStats } = require('../utils/statResolver');
const { getEffectDescription, normalizeGifUrl } = require('../utils/cards');
const { getDamageMultiplier, getAttributeDescription } = require('../utils/attributeSystem');
const { applyDefaultEmbedStyle } = require('../utils/embedStyle');
const { fetchBuffer, getMapImageBuffer } = require('../utils/mapImage');
const { getShipById, getCardById, consumeShipCola } = require('../utils/cards');
const sailStages = require('../data/sailStages');
const { moreCards } = require('../data/morecards');
const { cards: baseCards } = require('../data/cards');

function findEnemyDef(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  let def = (moreCards || []).find(c => (c.character && c.character.toLowerCase() === n) || (Array.isArray(c.alias) && c.alias.some(a => a.toLowerCase() === n)));
  if (def) return def;
  def = (baseCards || []).find(c => (c.character && c.character.toLowerCase() === n) || (Array.isArray(c.alias) && c.alias.some(a => a.toLowerCase() === n)));
  return def || null;
}

function makeMarineFromDef(def, hpMultiplier = 3, atkMultiplier = 1) {
  if (!def) return null;
  const baseMin = (typeof def.attack_min === 'number') ? def.attack_min : (def.power || 1);
  const baseMax = (typeof def.attack_max === 'number') ? def.attack_max : baseMin;
  const mul = (typeof atkMultiplier === 'number') ? atkMultiplier : 1;
  const newMin = Math.max(0, Math.floor(baseMin * mul));
  const newMax = Math.max(newMin, Math.floor(baseMax * mul));
  const avgAtk = Math.floor((newMin + newMax) / 2);
  return {
    rank: def.character || def.title || 'Enemy',
    speed: def.speed || 1,
    atk: avgAtk,
    attack_min: newMin,
    attack_max: newMax,
    maxHP: (def.health || def.hp || 1) * hpMultiplier,
    attribute: def.attribute || 'STR',
    emoji: def.emoji || '',
    image: def.image_url || def.image || null
  };
}

// Build wave slices for a given story stage using data/sailStages.js
function buildStageWaveSlices(storyKey, stageNum) {
  const island = (sailStages || []).find(s => s.id === storyKey);
  if (!island) return [];
  const stageObj = (island.stages || []).find(s => Number(s.stage) === Number(stageNum));
  if (!stageObj || !Array.isArray(stageObj.waves)) return [];
  const slices = [];
  for (const wave of stageObj.waves) {
    const ids = Array.isArray(wave) ? wave.flat() : [wave];
    for (let i = 0; i < ids.length; i += 3) {
      const chunk = ids.slice(i, i + 3);
      const marineObjs = [];
        for (const id of chunk) {
          const def = getCardById(id) || null;
          if (!def) continue;
          const hpMultiplier = chunk.length === 1 ? 3 : chunk.length === 2 ? 2 : 1;
          const atkMultiplier = chunk.length === 1 ? 2 : chunk.length === 2 ? 1.5 : 1;
          const m = makeMarineFromDef(def, hpMultiplier, atkMultiplier);
          if (m) marineObjs.push(m);
        }
      if (marineObjs.length) slices.push(marineObjs);
    }
  }
  try {
    console.log(`[isail] buildStageWaveSlices: ${storyKey} stage ${stageNum} -> ${slices.length} slice(s)`);
    slices.forEach((s, i) => console.log(`[isail]  slice ${i}: ${s.map(m=>m.rank).join(', ')}`));
  } catch (e) {}
  return slices;
}



function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const statusManager = require('../src/battle/statusManager');
const STATUS_EMOJIS = statusManager.STATUS_EMOJIS;
const {
  addStatus,
  hasStatusLock,
  getStatusLockReason,
  applyStartOfTurnEffects: applyStatusesForTurn,
  applyCardEffect: applyCardEffectShared,
  calculateUserDamage: calculateUserDamageShared,
  getAttackModifier,
  getDefenseMultiplier,
  getProneMultiplier,
  getDrunkChance,
  applyBleedOnEnergyUse,
  getConfusionChance,
  hasAttackDisabled,
  removeStatusTypes,
  hasTruesight,
  consumeTruesight,
  decrementStatusDurationsForTeam,
  handleKO
} = statusManager;
const { tryAcquire } = require('../utils/heavyCommandCooldown');


const calculateUserDamage = calculateUserDamageShared;

function resolveEffectTarget(card, state, damageTarget) {
  if (!card) return damageTarget;
  if (card.def.effect === 'team_stun') {
    return state.marines.filter(m => m.currentHP > 0);
  }
  if (card.def.all) {
    if (card.def.itself) {
      return state.cards.filter(c => c.alive);
    }
    return state.marines.filter(m => m.currentHP > 0);
  }
  return damageTarget;
}

async function handleConfusionAction(state, interaction, card, action) {
  const confusionChance = getConfusionChance(card);
  if (confusionChance > 0 && randomInt(1, 100) <= confusionChance) {
    const cost = action === 'special' ? 3 : 1;
    if (card.energy >= cost) {
      card.energy -= cost;
      card.turnsUntilRecharge = 2;
    }
    const baseDmg = calculateUserDamage(card, action);
    const attackMod = getAttackModifier(card);
    const selfDmg = Math.max(0, Math.floor(baseDmg * attackMod));
    card.currentHP = Math.max(0, (card.currentHP || 0) - selfDmg);
    const selfKo = handleKO(card);
    if (selfKo) appendLog(state, selfKo);
    state.lastUserAction = `${card.def.character} is confused and hits themselves for **${selfDmg} DMG**! <:energy:1478051414558118052> -${cost}`;
    state.selected = null;
    await finalizeUserAction(state, interaction.message, interaction);
    return true;
  }
  return false;
}

function getReflectStatus(entity) {
  return entity?.status?.find(st => st.type === 'reflect');
}

function isCharmedAgainstTarget(attacker, target) {
  if (!attacker || !target || !attacker.status) return false;
  return attacker.status.some(st => st.type === 'charmed') && attacker.def.attribute === target.attribute;
}

// Function to get attribute from emoji name
function getAttributeFromEmoji(emoji) {
  const match = emoji.match(/:([A-Z]{3})[^:]*:/);
  return match ? match[1] : 'STR'; // default to STR if not found
}

// Calculate damage with attribute multiplier
function calculateDamageWithAttribute(card, type, defenderAttribute) {
  const baseDamage = calculateUserDamage(card, type);
  const multiplier = getDamageMultiplier(card.def.attribute, defenderAttribute);
  return Math.floor(baseDamage * multiplier);
}


// key: message.id -> state object
const battleStates = new Map();

const OWNER_ID = process.env.OWNER_ID;

function hpBar(current, max) {
  if (max <= 0 || current <= 0) {
    return '<:Healthemptyleft:1481750325151928391>'
      + '<:Healthemptymiddle:1481750341489004596>'.repeat(6)
      + '<:healthemptyright:1481750363286667334>';
  }
  
  // Calculate percentage of health remaining
  const healthPercent = Math.max(0, Math.min(1, current / max));
  // 6 middle sections, so we have 0-6 filled sections
  const filledSections = Math.floor(healthPercent * 6);
  
  // Build the bar: right-to-left filling
  const leftIcon = '<:Healthfullleft:1481750264074469437>';
  const rightIcon = filledSections === 6 ? '<:healthfullright:1481750302679105710>' : '<:healthemptyright:1481750363286667334>';
  
  let bar = leftIcon;
  
  // Add filled middle sections first (on left side for left-to-right filling)
  for (let i = 0; i < filledSections; i++) {
    bar += '<:healthfullmiddle:1481750286795149435>';
  }
  
  // Add empty middle sections after (on right side)
  for (let i = filledSections; i < 6; i++) {
    bar += '<:Healthemptymiddle:1481750341489004596>';
  }
  
  bar += rightIcon;
  return bar;
}

// Returns a copy of a card's definition with all status-effect fields stripped
// out when the user's star level has not yet unlocked status effects (< 5).
// This is the single source of truth — downstream code (getEffectString,
// applyCardEffectShared, battle log messages) automatically sees no effect.
function buildBattleDef(def, entry) {
  const { isStatusEffectUnlocked } = require('../utils/starLevel');
  if (isStatusEffectUnlocked((entry && entry.starLevel) || 0)) return def;
  return Object.assign({}, def, {
    effect: undefined,
    effectDuration: undefined,
    effectAmount: undefined,
    effectChance: undefined,
    effectTarget: undefined
  });
}

function getEffectString(card, target) {
  if (!card.def.effect) return '';
  if (card.def.effect === 'team_stun') {
    return ` (${STATUS_EMOJIS.stun} stuns the whole crew for **${card.def.effectDuration || 1}** turn(s))`;
  } else {
    const effectVerbs = {
      'stun': 'stuns',
      'freeze': 'freezes',
      'cut': 'cuts',
      'bleed': 'bleeds',
      'regen': 'regenerates',
      'confusion': 'confuses',
      'attackup': 'boosts attack on',
      'attackdown': 'reduces attack on',
      'defenseup': 'boosts defense on',
      'defensedown': 'reduces defense on',
      'truesight': 'grants truesight to',
      'undead': 'grants undead to'
    };
    const verb = effectVerbs[card.def.effect] || 'affects';
    const duration = card.def.effectDuration || 1;
    const targetName = card.def.itself ? card.def.character : (target ? (target.rank || target.def?.character) : 'target');
    const icon = STATUS_EMOJIS[card.def.effect] || '';
    const defaultAmount = 12;
    const rawAmount = card.def.effectAmount ?? (card.def.effect === 'regen' ? 10 : defaultAmount);
    const effectAmount = Number.isNaN(Number(rawAmount)) ? (card.def.effect === 'regen' ? 10 : defaultAmount) : Number(rawAmount);
    const rawChance = card.def.effectChance ?? card.def.effectAmount;
    const parsedChance = Number.parseInt(String(rawChance ?? '').replace(/[^0-9]/g, ''), 10);
    const effectChance = Number.isNaN(parsedChance) ? 50 : parsedChance;
    let details = '';
    if (card.def.effect === 'regen') details = ` (${effectAmount}%)`;
    if (card.def.effect === 'confusion') details = ` (${effectChance}%)`;
    if (['attackup', 'attackdown', 'defenseup', 'defensedown'].includes(card.def.effect)) details = ` (${effectAmount}%)`;
    return ` (${icon} ${verb} ${targetName}${details} for **${duration}** turn(s))`;
  }
}

function addEmbedFieldLines(embed, baseName, lines, inline = false) {
  const maxLen = 1024;
  let content = lines.join('\n');
  if (content.length > maxLen) {
    content = content.slice(0, maxLen - 1) + '…';
  }
  embed.addFields({ name: baseName, value: content, inline });
}

// apply cut status to both teams (global turn transition)
function applyGlobalCut(state) {
  const logs = [];
  logs.push(...applyStatusesForTurn(state.cards));
  logs.push(...applyStatusesForTurn(state.marines));
  logs.forEach(l => appendLog(state, l));
}

// send a fresh message and remove the old one to reset Discord interaction timer
async function refreshBattleMessage(oldMsg, state, user, discordUser) {
  try {
    await updateBattleMessage(oldMsg, state, user, discordUser);
  } catch (e) {
    console.error('refreshBattleMessage failed to delegate to updateBattleMessage', e);
  }
  return oldMsg;
}

function energyDisplay(energy) {
  if (energy <= 0) return '0';
  return '<:energy:1478051414558118052>'.repeat(energy);
}

// return an array of marine objects for the given progress level
// Simple seeded PRNG (LCG) for reproducible stage generation
function makeSeed(userId, stage) {
  let h = 0;
  const str = `${userId}:${stage}`;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return (h >>> 0);
}

function seededRng(seed) {
  let s = seed >>> 0;
  return function() {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function getMarinesForLevel(stage, prevRanks = [], userId = null) {
  // Filter eligible ranks based on stagerange
  const eligible = marines.filter(m => stage >= m.stagerange[0] && stage <= m.stagerange[1]);
  if (eligible.length === 0) return [];

  // Use seeded RNG when userId provided so the same stage always gives the same marines
  const rand = userId ? seededRng(makeSeed(userId, stage)) : Math.random.bind(Math);

  // Randomly determine count: 1, 2, or 3
  const countRoll = rand();
  // Bias multi-enemy groups towards higher stages.
  // Interpolate probabilities from stage=1 => [1:0.55,2:0.35,3:0.10]
  // to stage=100 => [1:0.10,2:0.50,3:0.40].
  const stageNorm = Math.min(Math.max(stage || 1, 1), 100) / 100;
  const p1 = 0.55 - 0.45 * stageNorm;
  const p2 = 0.35 + 0.15 * stageNorm;
  const p3 = 0.10 + 0.30 * stageNorm;
  let count;
  if (countRoll < p1) count = 1;
  else if (countRoll < p1 + p2) count = 2;
  else count = 3;

  const group = [];
  for (let i = 0; i < count; i++) {
    // Randomly select from eligible ranks
    const c = eligible[Math.floor(rand() * eligible.length)];
    const rank = c.rank;
    const pool = c.pool || [];
    const poolEntry = pool.length > 0 ? pool[Math.floor(rand() * pool.length)] : { emoji: '', attribute: 'STR' };
    const emoji = poolEntry.emoji;
    const attribute = poolEntry.attribute;
    const maxHP = marines.getRandomMarineHP(c.rank, stage);
    group.push({ rank, speed: c.speed, atk: c.atk, maxHP, currentHP: maxHP, status: [], emoji, attribute });
  }

  // Apply atk multiplier based on group length
  const groupLen = group.length;
  const atkMultiplier = groupLen === 1 ? 2 : groupLen === 2 ? 1.5 : 1;
  group.forEach(m => {
    const newAtk = Math.max(0, Math.floor((m.atk || 0) * atkMultiplier));
    m.atk = newAtk;
    m.attack_min = newAtk;
    m.attack_max = newAtk;
  });

  // Apply HP scaling based on number of marines (Navy scaling):
  // 1 enemy => 3x HP, 2 enemies => 2x HP, 3 enemies => 1x HP
  const hpMultiplier = groupLen === 1 ? 3 : groupLen === 2 ? 2 : 1;
  group.forEach(m => {
    m.maxHP = Math.max(1, Math.floor((m.maxHP || 1) * hpMultiplier));
    // Freshly generated marines should start at full HP (currentHP = maxHP)
    m.currentHP = m.maxHP;
  });

  return group;
}

function buildEmbed(state, user, discordUser) {
  // Ensure the battle uses the pre-resolved stats prepared at start.
  // `state.cards` already contains a `scaled` object created from the DB
  // instance via `resolveStats`. Just clamp currentHP to the resolved max.
  state.cards.forEach(c => {
    if (!c.scaled) return;
    const oldMax = c.maxHP;
    c.maxHP = c.scaled.health;
    if (c.currentHP > c.maxHP) c.currentHP = c.maxHP;
  });

  // color remains fixed based on who started (user = white, marine = black)
  const embedColor = state.startingPlayer === 'user' ? '#FFFFFF' : '#000000';
  const embed = new EmbedBuilder().setColor('#b0d4ff');
  if (state.storyMode) {
    const key = state.storyKey || 'Story';
    const stageNum = state.storyStage || 1;
    embed.setDescription(`**${key.replace(/_/g, ' ')} — Stage ${stageNum}**`);
    // prefer the user's ship as the battle thumbnail for story battles
    try {
      if (user && user.activeShip) {
        const shipDef = getShipById(user.activeShip) || getCardById(user.activeShip) || null;
        const thumb = shipDef && (shipDef.image_url || shipDef.image || shipDef.art) ? (shipDef.image_url || shipDef.image || shipDef.art) : null;
        if (thumb) embed.setThumbnail(thumb);
        else if (discordUser) embed.setThumbnail(discordUser.displayAvatarURL());
      } else if (discordUser) {
        embed.setThumbnail(discordUser.displayAvatarURL());
      }
    } catch (e) {
      // swallow thumbnail errors
    }
  } else {
    embed.setDescription(`**sailing stage \`${user.isailProgress}\`**`);
    // show the marine thumbnail only for infinite sail (not story mode)
    embed.setThumbnail('https://static.wikia.nocookie.net/onepiece/images/d/dc/Marines_Infobox.png/revision/latest/scale-to-width-down/1000?cb=20210110121711');
  }
  // set any image override (special attack gif) or default art
  if (state.embedImage) {
    embed.setImage(state.embedImage);
  } else {
    // If no explicit embedImage is set, choose the strongest alive marine's image.
    const aliveMarinesForImage = state.marines.filter(m => m.currentHP > 0 && (m.image || m.image_url));
    if (aliveMarinesForImage.length > 0) {
      const getAtkAvg = (x) => {
        if (typeof x.attack_min === 'number' && typeof x.attack_max === 'number') return (x.attack_min + x.attack_max) / 2;
        return (x.atk || 0);
      };
      let strongest = aliveMarinesForImage[0];
      for (const m of aliveMarinesForImage) {
        const mHP = m.maxHP || m.hp || 0;
        const sHP = strongest.maxHP || strongest.hp || 0;
        if (mHP > sHP || (mHP === sHP && getAtkAvg(m) > getAtkAvg(strongest))) {
          strongest = m;
        }
      }
      embed.setImage(strongest.image || strongest.image_url);
    }
  }
  if (discordUser) {
    embed.setAuthor({ name: discordUser.username, iconURL: discordUser.displayAvatarURL() });
  }

  // enemy marines (show status emojis and HP numbers) - filter out KO
  const aliveMarines = state.marines.filter(m => m.currentHP > 0);
  if (aliveMarines.length > 0) {
    for (const m of aliveMarines) {
      const statusList = Array.isArray(m.status) ? m.status : [];
      const uniqueStatuses = [];
      for (const st of statusList) {
        if (!uniqueStatuses.find(u => u.type === st.type)) uniqueStatuses.push(st);
        if (uniqueStatuses.length >= 3) break;
      }
      const statusEmojis = uniqueStatuses.map(st => {
        const emoji = STATUS_EMOJIS[st.type] || '';
        return st.stacks && st.stacks > 1 ? `${emoji}x${st.stacks}` : emoji;
      }).join(' ');
      const fieldName = `${m.emoji || ''} ${statusEmojis} ${m.rank}`.trim();
      const value = `${hpBar(m.currentHP, m.maxHP)}\n${m.currentHP}/${m.maxHP}`;
      embed.addFields({ name: fieldName, value, inline: true });
    }
  } else {
    embed.addFields({ name: 'Enemy Marines', value: 'All marines defeated!', inline: false });
  }

  // Separator between teams
  embed.addFields({ name: '\u200B', value: '\u200B' });

  // cards field - filter out KO, new multi-line format with level/upgrade
  const aliveCards = state.cards.filter(c => c.currentHP > 0);
  if (aliveCards.length > 0) {
    for (const c of aliveCards) {
      const statusList = Array.isArray(c.status) ? c.status : [];
      const uniqueStatuses = [];
      for (const st of statusList) {
        if (!uniqueStatuses.find(u => u.type === st.type)) uniqueStatuses.push(st);
        if (uniqueStatuses.length >= 3) break;
      }
      const statusEmojis = uniqueStatuses.map(st => {
        const emoji = STATUS_EMOJIS[st.type] || '';
        return st.stacks && st.stacks > 1 ? `${emoji}x${st.stacks}` : emoji;
      }).join(' ');
      const fieldName = `${c.def.emoji || ''} ${statusEmojis} ${c.def.character}`.trim();
      const idx = state.cards.indexOf(c);
      const isSelected = state.selected !== null && idx === state.selected;
      const level = c.userEntry ? c.userEntry.level : 1;
      const _starLvlI = c.userEntry ? (c.userEntry.starLevel || 0) : 0;
      let value = `${hpBar(c.currentHP, c.maxHP)}`;
      value += `\nLv. ${level} S${_starLvlI}`;
      value += `\n${c.currentHP}/${c.maxHP} ${energyDisplay(c.energy)}`;
      if (isSelected) value = `**> ${value}**`;
      embed.addFields({ name: fieldName, value, inline: true });
    }
  } else {
    embed.addFields({ name: 'Your Crew', value: 'Entire crew defeated!', inline: false });
  }

  // action columns
  if (state.lastUserAction || state.lastMarineAction) {
    embed.addFields(
      { name: 'Your Action', value: state.lastUserAction || '—', inline: true },
      { name: 'Marine Action', value: state.lastMarineAction || '—', inline: true }
    );
  }

  // If we're awaiting multiple target selections, show a short hint
  if (state.awaitingTarget && typeof state.awaitingTarget === 'object') {
    const sel = state.awaitingTarget.selections || [];
    const names = sel.map(i => (state.marines[i] ? `${state.marines[i].emoji || ''} ${state.marines[i].rank}` : null)).filter(Boolean).join(', ') || 'None';
    embed.addFields({ name: 'Select Targets', value: `Pick ${state.awaitingTarget.required} target(s): ${names} (${sel.length}/${state.awaitingTarget.required})`, inline: false });
  }

  // footer: forfeit hint
  embed.setFooter({ text: 'Use /forfeit to forfeit the battle' });

  return embed;
}

function makeSelectionRow(state) {
  const row = new ActionRowBuilder();
  state.cards.forEach((c, i) => {
    const locked = c.status && c.status.some(st => st.type === 'stun' || st.type === 'freeze');
    const disabled = !c.alive || state.turn !== 'user' || c.energy === 0 || !!state.awaitingTarget || locked;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`isail_select:${i}`)
        .setLabel(c.def.character)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    );
  });
  return row;
}

function makeActionRow(state) {
  if (state.awaitingTarget) return null;
  const row = new ActionRowBuilder();
  if (state.selected !== null) {
    const card = state.cards[state.selected];
    const isUndead = card.status && card.status.some(st => st.type === 'undead');
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('isail_action:attack')
        .setLabel('Attack')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(isUndead || card.energy < 1)
    );
    const { isSpecialAttackUnlocked: _isailSpecUnlocked } = require('../utils/starLevel');
    if (card.def.special_attack && _isailSpecUnlocked(card.userEntry?.starLevel)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('isail_action:special')
          .setLabel('Special Attack')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(isUndead || card.energy < 3)
      );
    }
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('isail_action:rest')
      .setLabel('Rest')
      .setStyle(ButtonStyle.Success)
      .setDisabled(state.turn !== 'user')
  );
  return row;
}

async function updateBattleMessage(msg, state, user, discordUser) {
  const embed = buildEmbed(state, user, discordUser);
  const components = [makeSelectionRow(state)];
  if (state.awaitingTarget) {
    const targetRow = makeTargetRow(state);
    if (targetRow) components.push(targetRow);
  } else {
    const actionRow = makeActionRow(state);
    if (actionRow) components.push(actionRow);
  }
  // disable everything if finished
  if (state.finished) {
    components.forEach(r => r.components.forEach(b => b.setDisabled(true)));
    // add next isail button if victory
    if (state.victory) {
      const nextIsailRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('isail_next')
        .setLabel('Next Stage')
        .setEmoji('<:nextsail:1490397191125209119>')
        .setStyle(ButtonStyle.Secondary)
    );
      components.push(nextIsailRow);
    }
  }
  try {
    await msg.edit({ embeds: [embed], components });
  } catch (e) {
    // Ignore 10008 (Unknown Message) - message was deleted
    if (e.code !== 10008) {
      console.error('Error handling isail button:', e);
    }
    return;
  }
  // manage inactivity timer
  if (state.finished) {
    clearBattleTimeout(state);
  } else {
    setupTimeout(state, msg, user, discordUser);
  }
}

function checkForDefeat(state) {
  return state.cards.every(c => !c.alive);
}

// Attempt to advance to the next wave slice if available. Returns true
// if a new wave was spawned, false otherwise.
async function advanceToNextWave(state, msg, user, discordUser) {
  if (!state || !Array.isArray(state.waveSlices) || typeof state.currentWaveIndex !== 'number') return false;
  if (state.currentWaveIndex >= state.waveSlices.length - 1) return false;

  const prevIdx = state.currentWaveIndex;
  state.currentWaveIndex += 1;
  const nextSlice = state.waveSlices[state.currentWaveIndex] || [];
  state.marines = (nextSlice || []).map(m => {
    const maxHP = m.maxHP || m.hp || 30;
    return Object.assign({}, m, { currentHP: typeof m.currentHP === 'number' ? m.currentHP : maxHP, maxHP });
  });
  state.selected = null;
  state.embedImage = null;
  try {
    console.log(`[isail] advanceToNextWave: user=${state.userId} fromIdx=${prevIdx} toIdx=${state.currentWaveIndex} spawned ${state.marines.length} marine(s)`);
    state.marines.forEach((m, i) => {
      const atkDesc = (typeof m.attack_min === 'number' && typeof m.attack_max === 'number') ? `${m.attack_min}-${m.attack_max}` : String(m.atk || 0);
      console.log(`[isail]  marine ${i}: ${m.rank} HP=${m.maxHP} ATK=${atkDesc}`);
    });
  } catch (e) {}

  // Determine who acts first this wave based on speed
  try {
    const userSpeed = Math.max(...state.cards.map(c => c.def.speed || 0));
    const marineSpeed = Math.max(...state.marines.map(m => m.speed || 0));
    state.turn = userSpeed >= marineSpeed ? 'user' : 'marine';
  } catch (e) {
    state.turn = 'user';
  }

  // Refresh battle message to show the new wave
  try {
    await refreshBattleMessage(msg, state, user, discordUser);
  } catch (e) {
    console.error('Failed to refresh battle message after advancing wave:', e);
  }
  return true;
}

function makeTargetRow(state) {
  if (!state.awaitingTarget) return null;
  const row = new ActionRowBuilder();
  const attacker = state.cards[state.selected];
  // All live marines can be targeted (no tank restriction)
  // If awaitingTarget is an object it contains multi-select state
  const awaiting = state.awaitingTarget && typeof state.awaitingTarget === 'object' ? state.awaitingTarget : null;
  const preselected = awaiting && Array.isArray(awaiting.selections) ? awaiting.selections : [];
  state.marines.forEach((m, i) => {
    const disabled = m.currentHP <= 0 || preselected.includes(i);
    const multiplier = getDamageMultiplier(attacker.def.attribute, m.attribute);
    let style = ButtonStyle.Secondary; // Grey for neutral
    if (multiplier > 1) style = ButtonStyle.Success; // Green for effective
    else if (multiplier < 1) style = ButtonStyle.Danger; // Red for resisted
    const label = preselected.includes(i) ? `Enemy ${i + 1} ✓` : `Enemy ${i + 1}`;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`isail_target:${i}`)
        .setLabel(label)
        .setStyle(style)
        .setDisabled(disabled)
    );
  });
  return row;
}

function rechargeEnergy(state) {
  state.cards.forEach(c => {
    const locked = c.status && c.status.some(st => st.type === 'stun' || st.type === 'freeze');
    const gain = c.status && c.status.some(st => st.type === 'blessed') ? 2 : 1;
    if (c.turnsUntilRecharge > 0) {
      c.turnsUntilRecharge--;
    } else if (c.alive && c.energy < 3 && !locked) {
      c.energy = Math.min(3, c.energy + gain);
    }
  });
}

function marineAttack(state) {
  // each marine takes its turn
  const logs = [];
  state.marines.forEach(marine => {
    if (marine.currentHP <= 0) return;
    // Check if marine is stunned or frozen - skip turn if so
    if (hasStatusLock(marine)) {
      const reason = getStatusLockReason(marine);
      logs.push(`${marine.rank} is ${reason} and cannot attack!`);
      return;
    }
    // Confusion: marine may hit itself instead of attacking
    try {
      const confusionChance = getConfusionChance(marine);
      if (confusionChance > 0 && randomInt(1, 100) <= confusionChance) {
        // Marine hits itself
        let baseAtkForMarine = 0;
        if (typeof marine.attack_min === 'number' && typeof marine.attack_max === 'number') {
          baseAtkForMarine = randomInt(marine.attack_min, marine.attack_max);
        } else {
          baseAtkForMarine = marine.atk || 0;
        }
        const selfDmg = Math.max(0, Math.floor(baseAtkForMarine));
        marine.currentHP = Math.max(0, (marine.currentHP || 0) - selfDmg);
        if (marine.currentHP <= 0) {
          const ko = handleKO(marine);
          if (ko) logs.push(ko);
        }
        logs.push(`${marine.emoji || ''} **${marine.rank}** is confused and hits themselves for **${selfDmg} DMG**!`);
        return;
      }
    } catch (e) {
      // ignore confusion errors and continue with normal attack
      console.error('Error resolving marine confusion:', e);
    }
    // choose the same target the user just hit, if still alive; otherwise random alive target
    let target = state.lastMarineTarget && state.lastMarineTarget.alive ? state.lastMarineTarget : null;
    const alive = state.cards.filter(c => c.alive);
    if (!target && alive.length) {
      target = alive[Math.floor(Math.random() * alive.length)];
    }
    if (!target) return;
    let baseAtkForMarine = 0;
    if (typeof marine.attack_min === 'number' && typeof marine.attack_max === 'number') {
      baseAtkForMarine = randomInt(marine.attack_min, marine.attack_max);
    } else {
      baseAtkForMarine = marine.atk || 0;
    }

    // Apply attribute multiplier
    if (hasTruesight(target)) {
      logs.push(`${target.def.character} dodges with truesight!`);
      return;
    }

    const marineAttrMultiplier = getDamageMultiplier(marine.attribute, target.def.attribute);
    const finalMarineDmg = Math.floor(baseAtkForMarine * marineAttrMultiplier);
    
    target.currentHP -= finalMarineDmg;
    if (target.currentHP <= 0) {
      const ko = handleKO(target);
      if (ko) logs.push(ko);
    }
    // unfreeze the target if frozen
    if (target.status) {
      const freezeIdx = target.status.findIndex(st => st.type === 'freeze');
      if (freezeIdx >= 0) {
        target.status.splice(freezeIdx, 1);
        logs.push(`${target.def.character} was unfrozen by the attack!`);
      }
    }
    
    // Log attribute advantage/disadvantage in the attack message
    const marineEffectivenessStr = marineAttrMultiplier > 1 ? ` (Effective!)` : marineAttrMultiplier < 1 ? ` (Weak)` : '';
    logs.push(`${marine.emoji} **${marine.rank}** attacked ${target.def?.emoji || '⚔️'} **${target.def.character}** for **${finalMarineDmg} DMG**${marineEffectivenessStr}!`);
  });
  state.lastMarineAction = logs.join('\n');
  state.turn = 'user';
}

function maybeSkipUserTurn(state) {
  if (state.turn !== 'user') return false;
  // check if any card is alive, unlocked (not stunned/frozen), and has energy
  const available = state.cards.some(c => c.alive && !hasStatusLock(c) && c.energy > 0);
  if (!available) {
    // recharge and let marine attack
    rechargeEnergy(state);
    appendLog(state, 'No valid moves available; crew is recharging.');
    state.turn = 'marine';
    applyGlobalCut(state); // apply cut before marine acts
    return true;
  }
  return false;
}

async function finalizeUserAction(state, msg, interaction) {
  // after resolving user action we continue on to marine turn; embedImage
  // should stay set until after the marine action update so it appears on the
  // same embed with both log lines.

  // victory if all marines are dead
  if (state.marines.every(m => m.currentHP <= 0)) {
    // If we have precomputed wave slices, advance to the next one instead of
    // ending the battle. Otherwise, treat as a victory.
    if (Array.isArray(state.waveSlices) && typeof state.currentWaveIndex === 'number' && state.currentWaveIndex < state.waveSlices.length - 1) {
      const userDoc = await User.findOne({ userId: state.userId });
      console.log(`[isail] finalizeUserAction: all marines KO'd, attempting advance for user=${state.userId}`);
      const advanced = await advanceToNextWave(state, msg, userDoc, interaction ? interaction.user : null);
      if (advanced) {
        try { console.log('[isail] finalizeUserAction: advanced to next slice'); } catch (e) {}
        // After spawning next slice, return control to the player without forcing a marine turn
        return false;
      }
      // advanceToNextWave returned false unexpectedly (e.g. race condition already advanced index)
      // Fall back to victory so progress is always recorded and the battle ends cleanly
      console.log(`[isail] finalizeUserAction: advanceToNextWave returned false — treating as victory for user=${state.userId}`);
      const userDoc2 = await User.findOne({ userId: state.userId });
      await handleVictory(state, msg, userDoc2, interaction ? interaction.user : null);
      battleStates.delete(msg.id);
      return true;
    } else {
      const userDoc = await User.findOne({ userId: state.userId });
      await handleVictory(state, msg, userDoc, interaction ? interaction.user : null);
      battleStates.delete(msg.id);
      return true; // finished
    }
  }

  // switch to marine turn (NO recharge here - cards won't recharge twice)
  state.turn = 'marine';
  state.selected = null;

  // marine takes a swing
  marineAttack(state);
  // check if all cards died
  if (checkForDefeat(state)) {
    const user = await User.findOne({ userId: state.userId });
    await handleDefeat(state, msg, user);
    battleStates.delete(msg.id);
    return true;
  }

  // back to the user – update now will show both user action and marine action
  const user = await User.findOne({ userId: state.userId });
  // apply cut/bleed effects for both sides after marine action
  applyGlobalCut(state);
  // If status effects killed the user's own cards, trigger defeat now
  if (state.cards && state.cards.every(c => (c.currentHP || 0) <= 0)) {
    if (state.log) { try { await refreshBattleMessage(msg, state, user); } catch (e) {} }
    await handleDefeat(state, msg, user);
    battleStates.delete(msg.id);
    return true;
  }
  // If status effects (cut/bleed) killed all remaining marines, trigger victory now
  if (state.marines.every(m => m.currentHP <= 0)) {
    const userDocCut = await User.findOne({ userId: state.userId });
    if (state.log) { try { await refreshBattleMessage(msg, state, userDocCut); } catch (e) {} }
    await handleVictory(state, msg, userDocCut, interaction ? interaction.user : null);
    battleStates.delete(msg.id);
    return true;
  }
  // Recharge energy at the start of user turn for any cards that didn't act last turn
  rechargeEnergy(state);
  // refresh message now so any accumulated logs (effects, skips) are visible
  msg = await refreshBattleMessage(msg, state, user);
  // clear log after the embed has been sent
  state.log = '';
  state.embedImage = null;

  // if energy still zero this will auto-skip again
  await runSkipCycle(state, msg, user);
  return false;
}

async function runSkipCycle(state, msg, user, discordUser) {
  // loop until either it's the user's turn with available energy or battle finishes
  while (!state.finished && state.turn === 'user') {
    if (maybeSkipUserTurn(state)) {
      // perform marine attack now that we've switched to marine
      marineAttack(state);
      if (checkForDefeat(state)) {
        await handleDefeat(state, msg, user, discordUser);
        battleStates.delete(msg.id);
        return false; // battle ended
      }
      // If cut/bleed from maybeSkipUserTurn killed all marines, trigger victory
      if (state.marines.every(m => m.currentHP <= 0)) {
        const userDocCut = await User.findOne({ userId: state.userId });
        if (state.log) { try { await refreshBattleMessage(msg, state, userDocCut); } catch (e) {} }
        await handleVictory(state, msg, userDocCut, discordUser);
        battleStates.delete(msg.id);
        return false;
      }
      state.turn = 'user';
      // refresh message after marine action
      msg = await refreshBattleMessage(msg, state, user, discordUser);
      state.log = '';
      // continue to check again
      continue;
    }
    break;
  }
  return !state.finished;
}

async function handleVictory(state, msg, user, discordUser) {
  // mark finished and clear timeouts
  try { state.finished = true; } catch (e) {}
  try { state.victory = true; } catch (e) {}
  clearBattleTimeout(state);
  // remove any lingering battle state entries for this user (message ids may differ)
  try {
    for (const [mid, s] of battleStates) {
      if (s && (s.userId === (user && user.userId ? user.userId : state.userId))) {
        battleStates.delete(mid);
      }
    }
  } catch (e) {
    console.error('Failed to clean up lingering battle states for victory:', e);
  }
  console.log(`[isail] handleVictory: user=${user.userId} startProgress=${user.isailProgress}`);
  
  // Bounty mapping for marine ranks
  const bountyMap = {
    'Choreboy': 10,
    'Seaman Recruit': 50,
    'Seaman Apprentice': 250,
    'Seaman First Class': 700,
    'Petty Officer': 2500,
    'Chief Petty Officer': 10000,
    'Master Chief Petty Officer': 30000,
    'Warrant Officer': 100000,
    'Ensign': 100000,
    'Lieutenant Junior Grade': 100000,
    'Lieutenant': 250000,
    'Lieutenant Commander': 300000,
    'Captain': 400000,
    'Commodore': 500000,
    'Rear admiral': 600000,
    'Vice admiral': 700000,
    'Admiral': 800000,
    'Fleet Admiral': 1000000
  };
  
  // calculate rewards
  let belis = 0;
  let bountyGain = 0;
  let stageRuns = 0;
  if (state.storyMode) {
    // Story-mode: only give island completion rewards when the boss (stage 3) is cleared.
    const key = state.storyKey || 'story';
    const stage = state.storyStage || 1;

    // Determine island's max stage from data/sailStages
    const islandDef = (sailStages || []).find(s => s.id === key) || {};
    const maxStage = Array.isArray(islandDef.stages) && islandDef.stages.length > 0 ? islandDef.stages.length : 3;

    // ensure containers exist
    user.storyProgress = user.storyProgress || {};
    user.storyCompletions = user.storyCompletions || {};
    user.storyStageRuns = user.storyStageRuns || {};
    user.storyProgress[key] = user.storyProgress[key] || [];
    user.storyStageRuns[key] = user.storyStageRuns[key] || {};
    stageRuns = Number(user.storyStageRuns[key][stage] || 0);
    const isRepeatStage = stageRuns > 0;
    user.storyStageRuns[key][stage] = stageRuns + 1;
    if (typeof user.markModified === 'function') user.markModified('storyStageRuns');

    // compute marine bounty contribution
    let marineBounty = 0;
    if (state.marines && state.marines.length > 0) {
      state.marines.forEach(m => { marineBounty += bountyMap[m.rank] || 0; });
    }

    if (stage < maxStage) {
      if (stageRuns === 0) {
        // First clear of a non-boss stage: record progress only
        if (!user.storyProgress[key].some(x => Number(x) === stage)) {
          user.storyProgress[key].push(stage);
          if (typeof user.markModified === 'function') user.markModified('storyProgress');
        }
        belis = 0;
        bountyGain = 0;
      } else if (stageRuns === 1) {
        // Second completion of the same stage: 1 gem repeat reward
        user.gems = (user.gems || 0) + 1;
        belis = 0;
        bountyGain = 0;
      } else {
        // Third+ completion of the same stage: 50 beli
        belis = 50;
        bountyGain = 0;
      }
    } else {
      // Boss (final) stage cleared -> island completion logic
      const prevCount = Number(user.storyCompletions[key] || 0);
      const islandRewards = islandDef.rewards || {};
      
      if (prevCount === 0) {
        // First time completing this island: use rewards from sailStages, default to 5 gems + bounty
        const firstTimeRewards = islandRewards.firstTime || {};
        const rewardGems = firstTimeRewards.gems || 5;
        const rewardBounty = firstTimeRewards.bounty || 100000;
        const rewardShip = firstTimeRewards.ship_card;
        // collect any id_card fields (id_card, id_card_1, id_card_2, or id_cards array)
        const rewardIdCards = [];
        if (firstTimeRewards.id_card) rewardIdCards.push(firstTimeRewards.id_card);
        if (firstTimeRewards.id_card_1) rewardIdCards.push(firstTimeRewards.id_card_1);
        if (firstTimeRewards.id_card_2) rewardIdCards.push(firstTimeRewards.id_card_2);
        if (Array.isArray(firstTimeRewards.id_cards)) rewardIdCards.push(...firstTimeRewards.id_cards);

        user.gems = (user.gems || 0) + rewardGems;
        bountyGain = marineBounty + rewardBounty;
        belis = 0;
        
        // Handle id_card and ship_card rewards if present
        if (rewardIdCards.length) {
          user.ownedCards = user.ownedCards || [];
          const uniqueIds = Array.from(new Set(rewardIdCards.map(String)));
          uniqueIds.forEach(id => {
            if (!user.ownedCards.some(c => c.cardId === id)) {
              user.ownedCards.push({ cardId: id, level: 1, xp: 0 });
            }
          });
        }
        if (rewardShip) {
          // Ensure ships is an object keyed by ship id (per other codepaths)
          user.ships = user.ships || {};
          const shipDefObj = getShipById(rewardShip) || getCardById(rewardShip) || null;
          const shipKey = (shipDefObj && shipDefObj.id) ? shipDefObj.id : String(rewardShip).toLowerCase().replace(/[^a-z0-9]+/g, '_');
          const defaultCola = shipDefObj ? (shipDefObj.cola !== undefined ? shipDefObj.cola : (shipDefObj.maxCola !== undefined ? shipDefObj.maxCola : 0)) : 0;
          // Always grant the ship on first island completion (prevCount === 0 guarantees this is first time)
          if (!user.ships[shipKey]) {
            user.ships[shipKey] = { cola: defaultCola, maxCola: (shipDefObj && shipDefObj.maxCola !== undefined) ? shipDefObj.maxCola : defaultCola };
          } else {
            // Ship entry already exists — update maxCola if it's missing
            if (user.ships[shipKey].maxCola === undefined) {
              user.ships[shipKey].maxCola = (shipDefObj && shipDefObj.maxCola !== undefined) ? shipDefObj.maxCola : defaultCola;
            }
          }
          if (typeof user.markModified === 'function') user.markModified('ships');
        }
      } else if (prevCount === 1) {
        // Second completion: 1 gem
        user.gems = (user.gems || 0) + 1;
        bountyGain = marineBounty;
        belis = 0;
      } else {
        // Subsequent completions: small beli reward (50 beli, no bounty)
        belis = 50;
        bountyGain = 0;
      }
      // increment completion counter and persist stage if not recorded
      user.storyCompletions[key] = prevCount + 1;
      if (!user.storyProgress[key].some(x => Number(x) === maxStage)) {
        user.storyProgress[key].push(maxStage);
        if (typeof user.markModified === 'function') user.markModified('storyProgress');
      }
      if (typeof user.markModified === 'function') user.markModified('storyCompletions');
    }
  } else {
    // Infinite sail rewards (legacy behavior)
    const lvl = user.isailProgress || 1;
    if (lvl <= 10) belis = randomInt(10, 100);
    else if (lvl <= 20) belis = randomInt(30, 150);
    else if (lvl <= 30) {
      belis = randomInt(50, 300);
      if (Math.random() < 0.10) {
        user.resetTokens = (user.resetTokens || 0) + 1;
        appendLog(state, 'You also found a **Reset Token**!');
      }
    } else if (lvl <= 40) {
      belis = randomInt(80, 400) + Math.floor((lvl - 30) * 10);
    } else {
      belis = randomInt(120, 500) + Math.floor((lvl - 40) * 15);
    }
    if (state.marines && state.marines.length > 0) {
      state.marines.forEach(marine => {
        bountyGain += bountyMap[marine.rank] || 0;
      });
    }
    user.isailProgress = (user.isailProgress || 1) + 1;
  }

  // apply rewards
  user.balance = (user.balance || 0) + belis;
  user.bounty = (user.bounty || 100) + bountyGain;
  // store last enemy ranks to avoid repeat on next run
  state.marines && (user.lastIsailEnemies = state.marines.map(m => m.rank));

  // ===== XP & level-up handling =====
  // give each active team member XP and handle level ups.
  const key = state.storyKey || 'story';
  let xpGain = 30;
  if (state.storyMode) {
    const completions = Number((user.storyCompletions && user.storyCompletions[key]) ? user.storyCompletions[key] : 0);
    if (stageRuns > 0 || completions > 0) xpGain = 0;
  }
  const levelUpLines = [];
  if (Array.isArray(user.team)) {
    // Only give XP to cards that were actually used in this battle
    const activeCardIds = state.cards.map(c => c.def.id);
    activeCardIds.forEach(cardId => {
      // find the matching owned card entry; if missing create a placeholder.
      let entry = (user.ownedCards || []).find(e => e.cardId === cardId);
      if (!entry) {
        entry = { cardId, level: 1, xp: 0 };
        user.ownedCards = user.ownedCards || [];
        user.ownedCards.push(entry);
      }
      const prevLevel = entry.level || 1;
      entry.xp = (entry.xp || 0) + xpGain;
      // roll over multiple levels if XP exceeds threshold
      while (entry.xp >= 100) {
        entry.xp -= 100;
        entry.level = (entry.level || 1) + 1;
      }
      // Also give XP to any artifacts equipped to this card (supports multiple)
      const _equippedArtifacts = (user.ownedCards || []).filter(a => a.equippedTo === cardId);
      if (_equippedArtifacts.length) {
        for (const _equippedArtifact of _equippedArtifacts) {
          _equippedArtifact.xp = (_equippedArtifact.xp || 0) + xpGain;
          while (_equippedArtifact.xp >= 100) {
            _equippedArtifact.xp -= 100;
            _equippedArtifact.level = (_equippedArtifact.level || 1) + 1;
          }
        }
      }
      if (entry.level > prevLevel) {
        const def = cardDefs.find(c => c.id === cardId);
        const name = def ? def.character : cardId;
        levelUpLines.push(`**${name}** leveled up to **Level ${entry.level}**!`);
      }
    });
  }

  await user.save();
  try {
  } catch (err) {
    console.error('Achievement check after isail victory failed', err);
  }
  // Create a simple victory embed with contextual story rewards
  const victoryEmbed = new EmbedBuilder().setColor('#f8fec6').setTitle('Victory!');
  const descLines = [];
  if (state.storyMode) {
    const key = state.storyKey || 'story';
    const islandDef2 = (sailStages || []).find(s => s.id === key) || {};
    const maxStage2 = Array.isArray(islandDef2.stages) && islandDef2.stages.length > 0 ? islandDef2.stages.length : 3;

    // If this was the island's final stage, show island-completion rewards
    if (state.storyStage === maxStage2) {
      const completions = Number((user.storyCompletions && user.storyCompletions[key]) ? user.storyCompletions[key] : 0);
      const gemIcon = '<:gem:1490741488081043577>';
      const islandRewards = islandDef2.rewards || {};
      
      if (completions === 1) {
        // first time island clear - use rewards from sailStages
        const firstTimeRewards = islandRewards.firstTime || {};
        const rewardGems = firstTimeRewards.gems || 5;
        descLines.push(`• Earned ${gemIcon} ${rewardGems} Gems`);
        if (bountyGain > 0) descLines.push(`• Earned ${bountyGain} <:bounty:1490738541448400976>`);
        // show any awarded id cards
        const displayIdCards = [];
        if (firstTimeRewards.id_card) displayIdCards.push(firstTimeRewards.id_card);
        if (firstTimeRewards.id_card_1) displayIdCards.push(firstTimeRewards.id_card_1);
        if (firstTimeRewards.id_card_2) displayIdCards.push(firstTimeRewards.id_card_2);
        if (Array.isArray(firstTimeRewards.id_cards)) displayIdCards.push(...firstTimeRewards.id_cards);
        const ATTR_EMOJIS = {
          STR: '<:STRrandom:1492293852873232455>',
          DEX: '<:Dexrandom:1492293859785441400>',
          QCK: '<:Qckrandom:1492293854265868300>',
          INT: '<:INTrandom:1492293858170765466>',
          PSY: '<:psyrandom:1492293855700062258>'
        };
        Array.from(new Set(displayIdCards.map(String))).forEach(id => {
          try {
            const cardDef = getCardById(id);
            if (cardDef) {
              if (cardDef.artifact && cardDef.attribute) {
                const attrEmoji = ATTR_EMOJIS[cardDef.attribute] || '';
                descLines.push(`• Obtained ${attrEmoji ? attrEmoji + ' ' : ''}${cardDef.attribute} \`${cardDef.id}\``);
              } else {
                const emoji = cardDef.emoji ? `${cardDef.emoji} ` : '';
                const name = cardDef.character || cardDef.title || id;
                descLines.push(`• Obtained ${emoji}${name} \`${cardDef.id}\``);
              }
            } else {
              descLines.push(`• Obtained \`${id}\``);
            }
          } catch (e) {
            descLines.push(`• Obtained \`${id}\``);
          }
        });
        if (firstTimeRewards.ship_card) {
          descLines.push(`• Obtained ship **${firstTimeRewards.ship_card}**`);
        }
        // compute next island name for unlock message
        const ISLAND_ORDER = ['fusha_village','alvidas_hideout','shells_town','orange_town','syrup_village','baratie','arlong_park','loguetown'];
        const idx = ISLAND_ORDER.indexOf(key);
        if (idx >= 0 && idx < ISLAND_ORDER.length - 1) {
          const nextName = ISLAND_ORDER[idx + 1].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          descLines.push(`Unlocked **${nextName}**!`);
        } else {
          descLines.push('Island cleared!');
        }
      } else if (completions === 2) {
        descLines.push(`• Earned ${gemIcon} 1 Gem`);
        if (bountyGain > 0) descLines.push(`• Earned ${bountyGain} <:bounty:1490738541448400976>`);
      } else {
        if (belis > 0) descLines.push(`• Earned ${belis} <:beri:1490738445319016651>`);
        if (bountyGain > 0) descLines.push(`• Earned ${bountyGain} <:bounty:1490738541448400976>`);
      }
    } else if (state.storyStage < maxStage2) {
      const gemIcon = '<:gem:1490741488081043577>';
      if (stageRuns === 0) {
        // first clear of a non-boss stage has no reward beyond XP
        descLines.push('Stage cleared!');
      } else if (stageRuns === 1) {
        descLines.push(`• Earned ${gemIcon} 1 Gem`);
      } else {
        descLines.push(`• Earned ${belis} <:beri:1490738445319016651>`);
      }
    } else {
      if (belis > 0) descLines.push(`• Earned ${belis} <:beri:1490738445319016651>`);
      if (bountyGain > 0) descLines.push(`• Earned ${bountyGain} <:bounty:1490738541448400976>`);
    }
  } else {
    if (belis > 0) descLines.push(`• Earned ${belis} <:beri:1490738445319016651>`);
    if (bountyGain > 0) descLines.push(`• Earned ${bountyGain} <:bounty:1490738541448400976>`);
  }
  if (xpGain > 0) {
    descLines.push(`• team members gained **${xpGain} XP**`);
  }
  // Ensure description is not empty - provide a default if no rewards
  const descriptionText = descLines.length > 0 ? descLines.join('\n') : 'Victory!';
  victoryEmbed.setDescription(descriptionText);
  if (discordUser) victoryEmbed.setAuthor({ name: discordUser.username, iconURL: discordUser.displayAvatarURL() });
  
  // build next button; if this was a story battle, attach story metadata so the handler resumes the correct stage
  let nextCustomId = 'isail_next';
  if (state.storyMode) {
    const nextStage = (state.storyStage || 1) + 1;
    const islandDef2 = (sailStages || []).find(s => s.id === state.storyKey) || {};
    const maxStage2 = Array.isArray(islandDef2.stages) && islandDef2.stages.length > 0 ? islandDef2.stages.length : 3;
    if (nextStage <= maxStage2) nextCustomId = `isail_next:story|${state.storyKey}|${nextStage}`;
    else nextCustomId = `isail_next:finish|${state.storyKey}`;
  }
  const nextLabel = nextCustomId.includes('finish|') ? 'Open Map' : 'Next Stage';
  const nextSailRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(nextCustomId)
      .setLabel(nextLabel)
      .setEmoji('<:nextsail:1490397191125209119>')
      .setStyle(ButtonStyle.Secondary)
  );
  
  try { await msg.delete(); } catch {}
  await msg.channel.send({ embeds: [victoryEmbed], components: [nextSailRow] });
}

async function handleDefeat(state, msg, user, discordUser) {
  clearBattleTimeout(state);
  user.lastIsailFail = new Date();
  await user.save();
  
  const defeatEmbed = new EmbedBuilder()
    .setColor('#ffbaba')
    .setTitle('Defeat')
    .setDescription('Better luck next time.');
  if (discordUser) {
    defeatEmbed.setAuthor({ name: discordUser.username, iconURL: discordUser.displayAvatarURL() });
  }
  
  try { await msg.delete(); } catch {}
  await msg.channel.send({ embeds: [defeatEmbed] });
}

function clearBattleTimeout(state) {
  if (state.timeout) {
    clearTimeout(state.timeout);
    state.timeout = null;
  }
}

function setupTimeout(state, msg, user, discordUser) {
  clearBattleTimeout(state);
  if (!state.finished) {
    state.timeout = setTimeout(async () => {
      try {
        // Check if battle state still exists with this message ID
        if (!battleStates.has(msg.id)) return;
        if (state.finished) return;
        // Mark inactivity and pass the turn to the marines
        appendLog(state, 'Player took too long. Turn passed to the marines.');
        // clear any pending selection
        state.selected = null;
        state.turn = 'marine';
        // apply start-of-turn effects
        applyGlobalCut(state);
        // perform marine action
        marineAttack(state);
        // check for defeat
        if (checkForDefeat(state)) {
          const userDoc = await User.findOne({ userId: state.userId });
          await handleDefeat(state, msg, userDoc, discordUser);
          battleStates.delete(msg.id);
          return;
        }
        // If cut/bleed effects killed all marines during the timeout turn, trigger victory
        if (state.marines.every(m => m.currentHP <= 0)) {
          const userDocCut = await User.findOne({ userId: state.userId });
          await handleVictory(state, msg, userDocCut, discordUser);
          battleStates.delete(msg.id);
          return;
        }
        // recharge energy for next user turn
        rechargeEnergy(state);
        // refresh the battle message
        try {
          await refreshBattleMessage(msg, state, await User.findOne({ userId: state.userId }), discordUser);
        } catch (e) {
          if (e.code !== 10008) console.error('Timeout refresh error:', e);
        }
        // reset log after showing
        state.log = '';
        // restart inactivity timer for next turn
        setupTimeout(state, msg, await User.findOne({ userId: state.userId }), discordUser);
      } catch (e) {
        console.error('Timeout handler error:', e);
      }
    }, 30000);
  }
}

function appendLog(state, txt) {
  if (state.log) state.log += '\n' + txt;
  else state.log = txt;
}

// exportable helper to start a battle using a provided marines array
async function startBattleWithMarines({ message, interaction, user, discordUser, marines, waveSlices = null, storyMode = false, storyKey = null, storyStage = null }) {
  if (!user) return;
  const userId = user.userId || user.userId;

  // Heavy-command cooldown check (silent — no user-facing message)
  try { tryAcquire(userId); } catch (e) {}

  const safeInteractionReply = async (payload) => {
    if (message) return message.reply(payload);
    if (!interaction) return;
    try {
      if (!interaction.deferred && !interaction.replied) return await interaction.reply(payload);
      return await interaction.followUp(payload);
    } catch (err) {
      try {
        return await interaction.channel.send(payload);
      } catch (sendErr) {
        console.error('Failed safe interaction reply:', sendErr);
      }
    }
  };

  // Check for active battle for this user
  let activeIsail = null;
  for (const [msgId, state] of battleStates) {
    if (state.userId === userId && !state.finished) {
      activeIsail = msgId;
      break;
    }
  }
  if (activeIsail) {
    try { console.log(`[isail] startBattleWithMarines blocked: user ${userId} already has active sail msg=${activeIsail}`); } catch (e) {}
    const reply = 'You already have an active sail in progress!';
    if (message) return message.reply(reply);
    return safeInteractionReply({ content: reply, ephemeral: true });
  }

  if (!Array.isArray(user.team) || user.team.length === 0) {
    const reply = 'Your team must have at least 1 card.';
    if (message) return message.reply(reply);
    return safeInteractionReply({ content: reply, ephemeral: true });
  }

  const teamDefs = user.team.slice(0, 3).map(id => cardDefs.find(c => c.id === id)).filter(Boolean);
  if (teamDefs.length === 0) {
    const reply = 'Your team must have at least 1 valid card.';
    if (message) return message.reply(reply);
    return safeInteractionReply({ content: reply, ephemeral: true });
  }

  const resolvedTeam = teamDefs.map(def => {
    const entry = (user.ownedCards || []).find(e => e.cardId === def.id) || { cardId: def.id, level: 1, xp: 0 };
    const battleDef = buildBattleDef(def, entry);
    const scaled = resolveStats(entry, user.ownedCards || []);
    return {
      def: battleDef,
      userEntry: entry,
      scaled: scaled || {
        health: battleDef.health,
        power: battleDef.power,
        speed: battleDef.speed,
        attack_min: battleDef.attack_min,
        attack_max: battleDef.attack_max,
        special_attack: battleDef.special_attack ? { min: battleDef.special_attack.min_atk || battleDef.special_attack.min, max: battleDef.special_attack.max_atk || battleDef.special_attack.max } : undefined
      },
      currentHP: (scaled && scaled.health) || battleDef.health,
      maxHP: (scaled && scaled.health) || battleDef.health,
      energy: 3,
      alive: true,
      turnsUntilRecharge: 0,
      status: []
    };
  });

  // Ensure marines array has currentHP fields
  const safeMarines = (marines || []).map(m => {
    const maxHP = m.maxHP || m.hp || 30;
    return Object.assign({}, m, { currentHP: typeof m.currentHP === 'number' ? m.currentHP : maxHP, maxHP });
  });

  const state = {
    userId,
    marines: safeMarines,
    cards: resolvedTeam,
    turn: null,
    startingPlayer: null,
    log: '',
    selected: null,
    awaitingTarget: null,
    finished: false,
    lastUserAction: '',
    lastMarineAction: '',
    timeout: null,
    embedImage: null,
    storyMode: !!storyMode,
    storyKey: storyKey || null,
    storyStage: storyStage || null
  };

  // If the caller provided waveSlices (arrays of marine objects), normalize and attach them to state
  if (Array.isArray(waveSlices) && waveSlices.length > 0) {
    state.waveSlices = waveSlices.map(slice => (slice || []).map(m => {
      const maxHP = m.maxHP || m.hp || 30;
      return Object.assign({}, m, { currentHP: typeof m.currentHP === 'number' ? m.currentHP : maxHP, maxHP });
    }));
    state.currentWaveIndex = 0;
  } else {
    state.waveSlices = null;
    state.currentWaveIndex = null;
  }

  // embedImage will be selected dynamically in buildEmbed (strongest opponent image).
  state.embedImage = null;

  const userSpeed = Math.max(...state.cards.map(c => c.def.speed || 0));
  const marineSpeed = Math.max(...state.marines.map(m => m.speed || 0));
  state.turn = userSpeed >= marineSpeed ? 'user' : 'marine';
  state.startingPlayer = state.turn;
  applyGlobalCut(state);

  const embed = buildEmbed(state, user, discordUser);
  const row = makeSelectionRow(state);
  const components = [row];
  let msg;
  if (message) {
    msg = await message.channel.send({ embeds: [embed], components });
  } else {
    try {
      if (!interaction.deferred && !interaction.replied) {
        msg = await interaction.reply({ embeds: [embed], components, fetchReply: true });
      } else {
        msg = await interaction.channel.send({ embeds: [embed], components });
      }
    } catch (e) {
      msg = await interaction.channel.send({ embeds: [embed], components });
    }
  }
  battleStates.set(msg.id, state);
  await setupTimeout(state, msg, user, discordUser);

  setTimeout(() => {
    const expiredEmbed = buildEmbed(state, user, discordUser);
    expiredEmbed.setFooter({ text: 'Expired' });
    msg.edit({ embeds: [expiredEmbed], components: [] }).catch(() => {});
  }, 180000);

  if (state.turn === 'marine') {
    marineAttack(state);
    if (checkForDefeat(state)) {
      await handleDefeat(state, msg, user, discordUser);
      battleStates.delete(msg.id);
      return;
    }
    state.turn = 'user';
    applyGlobalCut(state);
    msg = await refreshBattleMessage(msg, state, user, discordUser);
    state.log = '';
    await runSkipCycle(state, msg, user, discordUser);
  }
}

module.exports = {
  name: 'isail',
  description: 'Begin the Infinite Sail interactive battle',
  options: [],
  async execute({ message, interaction, skipMapFirst = false }) {
    const userId = message ? message.author.id : interaction.user.id;
    const discordUser = message ? message.author : interaction.user;
    // Heavy-command cooldown check (silent — no user-facing message)
    try { tryAcquire(userId); } catch (e) {}
    let user = await User.findOne({ userId });
    if (!user) {
      const reply = 'You need an account first – run `op start` or /start.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }
    user.isailProgress = user.isailProgress || 1;
  console.log(`[isail] execute: user=${userId} progress=${user.isailProgress}`);

    // Check if user already has an active isail battle
    let activeIsail = null;
    for (const [msgId, state] of battleStates) {
      if (state.userId === userId && !state.finished) {
        activeIsail = msgId;
        break;
      }
    }
    
    if (activeIsail) {
      const reply = 'You already have an active sail in progress!';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // cooldown check (1 minute on loss; owner bypass)
    const now = new Date();
    if (user.lastIsailFail) {
      const diff = now - user.lastIsailFail;
      const COOLDOWN_MS = 60_000;
      if (diff < COOLDOWN_MS) {
        const wait = Math.ceil((COOLDOWN_MS - diff) / 1000);
        const reply = `You must wait ${wait}s before attempting Sailing again.`;
        if (message) return message.reply(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }
    }

    if (!Array.isArray(user.team) || user.team.length === 0) {
      const reply = 'Your team must have at least 1 card.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const teamDefs = user.team.slice(0, 3).map(id => cardDefs.find(c => c.id === id)).filter(Boolean);
    if (teamDefs.length === 0) {
      const reply = 'Your team must have at least 1 valid card.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // prepare resolvedTeam: each element represents the DB-owned instance
    // with final stats (level + boosts applied). `resolveStats` reads the
    // user's ownedCards to count Boost cards and returns the final stats.
    const resolvedTeam = teamDefs.map(def => {
      const entry = (user.ownedCards || []).find(e => e.cardId === def.id) || { cardId: def.id, level: 1, xp: 0 };
      const battleDef = buildBattleDef(def, entry);
      const scaled = resolveStats(entry, user.ownedCards || []);
      return {
        def: battleDef,
        userEntry: entry,
        scaled: scaled || {
          health: battleDef.health,
          power: battleDef.power,
          speed: battleDef.speed,
          attack_min: battleDef.attack_min,
          attack_max: battleDef.attack_max,
          special_attack: battleDef.special_attack ? { min: battleDef.special_attack.min_atk || battleDef.special_attack.min, max: battleDef.special_attack.max_atk || battleDef.special_attack.max } : undefined
        },
        currentHP: (scaled && scaled.health) || battleDef.health,
        maxHP: (scaled && scaled.health) || battleDef.health,
        energy: 3,
        alive: true,
        turnsUntilRecharge: 0,
        status: [] // status effects container
      };
    });

    const state = {
      userId,
      marines: getMarinesForLevel(user.isailProgress, [], userId),
      cards: resolvedTeam,
      turn: null,
      startingPlayer: null, // will set below
      log: '',
      selected: null,
      awaitingTarget: null, // when set, an action is pending
      finished: false,
      lastUserAction: '',
      lastMarineAction: '',
      timeout: null,
      embedImage: null
    };

    const userSpeed = Math.max(...state.cards.map(c => c.def.speed || 0));
    const marineSpeed = Math.max(...state.marines.map(m => m.speed || 0));
    state.turn = userSpeed >= marineSpeed ? 'user' : 'marine';
    state.startingPlayer = state.turn; // remember who started for color logic
    // apply cut effects before first action
    applyGlobalCut(state);

    // send initial message
      const embed = buildEmbed(state, user, discordUser);
      const row = makeSelectionRow(state);
      const components = [row];
      let msg;

      // If this is not the user's first Infinite Sail run, send the map image first
      const sendMapFirst = !skipMapFirst && !!(user && user.isailProgress && user.isailProgress > 1);
      if (sendMapFirst) {
        try {
          const buf = await getMapImageBuffer(user);
          const att = new AttachmentBuilder(buf, { name: 'eastblue.png' });
          if (message) {
            await message.channel.send({ files: [att] });
          } else {
            await interaction.reply({ files: [att] });
          }
        } catch (e) {
          console.error('Failed to send map image in isail:', e);
        }
      }

      if (message) {
        msg = await message.channel.send({ embeds: [embed], components });
      } else {
        if (sendMapFirst) {
          msg = await interaction.followUp({ embeds: [embed], components, fetchReply: true });
        } else {
          msg = await interaction.reply({ embeds: [embed], components, fetchReply: true });
        }
      }
    battleStates.set(msg.id, state);
    // start inactivity timeout for first turn
    await setupTimeout(state, msg, user, discordUser);

    // 3-minute expiration timeout
    setTimeout(() => {
      const expiredEmbed = buildEmbed(state, user, discordUser);
      expiredEmbed.setFooter({ text: 'Expired' });
      msg.edit({ embeds: [expiredEmbed], components: [] }).catch(() => {});
    }, 180000);

    // if marine goes first, perform an immediate attack
    if (state.turn === 'marine') {
      marineAttack(state);
      // after marine attack, check defeat
      if (checkForDefeat(state)) {
        await handleDefeat(state, msg, user, discordUser);
        battleStates.delete(msg.id);
        return;
      }
      state.turn = 'user';
      // apply cut effects at turn transition
      applyGlobalCut(state);
      // refresh message after marine action
      msg = await refreshBattleMessage(msg, state, user, discordUser);
      state.log = '';
      // in case all cards have no energy, let skip cycle run automatically
      await runSkipCycle(state, msg, user, discordUser);
    }
  },

  async handleButton(interaction, rawAction, cardId) {
    const msgId = interaction.message.id;
    const state = battleStates.get(msgId);
    const discordUser = interaction.user;

    // Handle next isail button
    if (rawAction === 'isail_next') {
      // Remove old state in case old message is reused
      battleStates.delete(msgId);

      try {
        await interaction.deferUpdate();
      } catch (e) {
        if (e.code !== 10062) console.error('Failed to defer:', e);
      }

      const userId = interaction.user.id;
      const user = await User.findOne({ userId });
      if (!user) {
        return interaction.followUp({ content: 'Unable to find your profile. Please start with `/isail` again.', ephemeral: true });
      }

      // Guarantee existing progress is respected. If missing, set to 1.
      user.isailProgress = user.isailProgress || 1;
      await user.save();
      console.log(`[isail_next] user ${userId} resumes at progress ${user.isailProgress}`);

      // If the Next button includes story metadata (story|island|stage), resume the story stage
      if (cardId && cardId.startsWith('story|')) {
        const parts = cardId.split('|');
        const storyKey = parts[1];
        const nextStage = parseInt(parts[2], 10) || 1;

        // cooldown check (1 minute on loss)
        const now = new Date();
        if (user.lastIsailFail) {
          const diff = now - user.lastIsailFail;
          const COOLDOWN_MS = 60_000;
          if (diff < COOLDOWN_MS) {
            const wait = Math.ceil((COOLDOWN_MS - diff) / 1000);
            return interaction.followUp({ content: `You must wait ${wait}s before attempting Infinite Sail again.`, ephemeral: true });
          }
        }

        // consume 1 cola from active ship (centralized)
        if (!consumeShipCola(user)) return interaction.followUp({ content: 'Your ship is out of cola! Fuel it up using /fuel ship.', ephemeral: true });
        await user.save();

        // Attempt to build structured wave slices for this story stage first
        try {
          const waveSlices = buildStageWaveSlices(storyKey, nextStage);
          if (Array.isArray(waveSlices) && waveSlices.length > 0) {
            await startBattleWithMarines({ interaction, user, discordUser: interaction.user, marines: waveSlices[0], waveSlices, storyMode: true, storyKey, storyStage: nextStage });
            return;
          }
        } catch (e) {
          console.error('Failed to build stage wave slices:', e);
        }

        // Fallback to legacy single-enemy stage definitions
        let marinesArr = [];
        if (storyKey === 'fusha_village') {
          const name = nextStage === 1 ? 'Pistol Bandit' : nextStage === 2 ? 'Higuma' : 'Master of the Near Sea';
          const def = findEnemyDef(name);
          const m = makeMarineFromDef(def, 3, 2);
          if (m) marinesArr.push(m);
        } else if (storyKey === 'alvidas_hideout') {
          const name = nextStage === 1 ? 'Mohji & Richie' : nextStage === 2 ? 'Cabaji' : 'Alvida';
          const def = findEnemyDef(name);
          const m = makeMarineFromDef(def, 3, 2);
          if (m) marinesArr.push(m);
        }

        if (!marinesArr.length) return interaction.followUp({ content: 'This story stage is not implemented yet.', ephemeral: true });

        try {
          await startBattleWithMarines({ interaction, user, discordUser: interaction.user, marines: marinesArr, storyMode: true, storyKey, storyStage: nextStage });
        } catch (e) {
          console.error('Failed to start story next stage', e);
          return interaction.followUp({ content: 'Failed to start next stage.', ephemeral: true });
        }
        return;
      }

      // If Next was a finish marker (island cleared), open sail map
      if (cardId && cardId.startsWith('finish|')) {
        try {
          const sailCmd = require('./sail');
          return await sailCmd.execute({ interaction });
        } catch (e) {
          console.error('Failed to open sail after island finish', e);
          return interaction.followUp({ content: 'Failed to continue to sail.', ephemeral: true });
        }
      }

      // Consume 1 cola from active ship before starting next infinite sail run
      if (!consumeShipCola(user)) return interaction.followUp({ content: 'Your ship is out of cola! Fuel it up using /fuel ship.', ephemeral: true });
      await user.save();

      // Start the next sail run by invoking execute with a message-style context (no duplicate interaction reply)
      const fakeMessage = {
        channel: interaction.channel,
        author: interaction.user,
        reply: async (content) => {
          if (typeof content === 'string') {
            return interaction.followUp({ content, ephemeral: true });
          }
          return interaction.followUp(content);
        }
        ,
        // Start a battle using a pre-defined marines array (used for story mode / sail stages)
        async startBattleWithMarines({ message, interaction, user, discordUser, marines, storyMode = false, storyKey = null, storyStage = null }) {
          if (!user) return;
          const userId = user.userId || user.userId;

          // Check for active battle for this user
          let activeIsail = null;
          for (const [msgId, state] of battleStates) {
            if (state.userId === userId && !state.finished) {
              activeIsail = msgId;
              break;
            }
          }
          if (activeIsail) {
            const reply = 'You already have an active sail in progress!';
            if (message) return message.reply(reply);
            return interaction.reply({ content: reply, ephemeral: true });
          }

          if (!Array.isArray(user.team) || user.team.length === 0) {
            const reply = 'Your team must have at least 1 card.';
            if (message) return message.reply(reply);
            return interaction.reply({ content: reply, ephemeral: true });
          }

          const teamDefs = user.team.slice(0, 3).map(id => cardDefs.find(c => c.id === id)).filter(Boolean);
          if (teamDefs.length === 0) {
            const reply = 'Your team must have at least 1 valid card.';
            if (message) return message.reply(reply);
            return interaction.reply({ content: reply, ephemeral: true });
          }

          const resolvedTeam = teamDefs.map(def => {
            const entry = (user.ownedCards || []).find(e => e.cardId === def.id) || { cardId: def.id, level: 1, xp: 0 };
            const battleDef = buildBattleDef(def, entry);
            const scaled = resolveStats(entry, user.ownedCards || []);
            return {
              def: battleDef,
              userEntry: entry,
              scaled: scaled || {
                health: battleDef.health,
                power: battleDef.power,
                speed: battleDef.speed,
                attack_min: battleDef.attack_min,
                attack_max: battleDef.attack_max,
                special_attack: battleDef.special_attack ? { min: battleDef.special_attack.min_atk || battleDef.special_attack.min, max: battleDef.special_attack.max_atk || battleDef.special_attack.max } : undefined
              },
              currentHP: (scaled && scaled.health) || battleDef.health,
              maxHP: (scaled && scaled.health) || battleDef.health,
              energy: 3,
              alive: true,
              turnsUntilRecharge: 0,
              status: []
            };
          });

          // Ensure marines array has currentHP fields
          const safeMarines = (marines || []).map(m => {
            const maxHP = m.maxHP || m.hp || 30;
            return Object.assign({}, m, { currentHP: typeof m.currentHP === 'number' ? m.currentHP : maxHP, maxHP });
          });

          const state = {
            userId,
            marines: safeMarines,
            cards: resolvedTeam,
            turn: null,
            startingPlayer: null,
            log: '',
            selected: null,
            awaitingTarget: null,
            finished: false,
            lastUserAction: '',
            lastMarineAction: '',
            timeout: null,
            embedImage: null,
            storyMode: !!storyMode,
            storyKey: storyKey || null,
            storyStage: storyStage || null
          };

          // embedImage will be selected dynamically in buildEmbed (strongest opponent image)
          state.embedImage = null;

          const userSpeed = Math.max(...state.cards.map(c => c.def.speed || 0));
          const marineSpeed = Math.max(...state.marines.map(m => m.speed || 0));
          state.turn = userSpeed >= marineSpeed ? 'user' : 'marine';
          state.startingPlayer = state.turn;
          applyGlobalCut(state);

          const embed = buildEmbed(state, user, discordUser);
          const row = makeSelectionRow(state);
          const components = [row];
          let msg;
          if (message) {
            msg = await message.channel.send({ embeds: [embed], components });
          } else {
            try {
              if (!interaction.deferred && !interaction.replied) {
                msg = await interaction.reply({ embeds: [embed], components, fetchReply: true });
              } else {
                msg = await interaction.channel.send({ embeds: [embed], components });
              }
            } catch (e) {
              msg = await interaction.channel.send({ embeds: [embed], components });
            }
          }
          battleStates.set(msg.id, state);
          await setupTimeout(state, msg, user, discordUser);

          setTimeout(() => {
            const expiredEmbed = buildEmbed(state, user, discordUser);
            expiredEmbed.setFooter({ text: 'Expired' });
            msg.edit({ embeds: [expiredEmbed], components: [] }).catch(() => {});
          }, 180000);

          if (state.turn === 'marine') {
            marineAttack(state);
            if (checkForDefeat(state)) {
              await handleDefeat(state, msg, user, discordUser);
              battleStates.delete(msg.id);
              return;
            }
            state.turn = 'user';
            applyGlobalCut(state);
            msg = await refreshBattleMessage(msg, state, user, discordUser);
            state.log = '';
            await runSkipCycle(state, msg, user, discordUser);
          }
        }
      };

      await module.exports.execute({ message: fakeMessage, skipMapFirst: true });
      return;
    }

    try {
      // Defer the interaction to acknowledge it
      await safeDefer(interaction);

      if (!state) {
        return interaction.followUp({ content: 'This battle session has expired.', ephemeral: true });
      }
      if (interaction.user.id !== state.userId) {
        return interaction.followUp({ content: 'You are not part of this battle.', ephemeral: true });
      }

      // parse action
      const parts = rawAction.split('_');
      const type = parts[1]; // 'select' or 'action'

      if (type === 'select') {
      const idx = parseInt(cardId, 10);
      if (isNaN(idx) || idx < 0 || idx >= state.cards.length) {
        return interaction.followUp({ content: 'Invalid selection.', ephemeral: true });
      }
      // selection only allowed if it's user's turn and not finished
      if (state.finished || state.turn !== 'user') {
        return interaction.followUp({ content: 'You cannot select now.', ephemeral: true });
      }
      const card = state.cards[idx];
      if (!card.alive) {
        return interaction.followUp({ content: 'That card is knocked out.', ephemeral: true });
      }
      // Hard stun/freeze block - prevent selection of stunned/frozen cards
      if (hasStatusLock(card)) {
        const reason = getStatusLockReason(card);
        return interaction.followUp({ content: `${card.def.character} is ${reason}!`, ephemeral: true });
      }
      state.selected = idx;
      // no desktop art; gif-only display handled separately
      await safeUpdateBattleMessage(interaction.message, state, await User.findOne({ userId: state.userId }), discordUser);
      return safeDefer(interaction);
    }

    if (type === 'action') {
      const act = cardId;
      // do not respond if battle finished
      if (state.finished) {
        return interaction.followUp({ content: 'The battle has already ended.', ephemeral: true });
      }
      
      if (state.turn !== 'user') {
        return interaction.followUp({ content: 'It is not your turn.', ephemeral: true });
      }

      // process user action (with optional target selection)
      if (act === 'attack' || act === 'special') {
        const card = state.cards[state.selected];
        if (!card || !card.alive) {
          state.selected = null;
          await safeUpdateBattleMessage(interaction.message, state, await User.findOne({ userId: state.userId }), discordUser);
          return interaction.followUp({ content: 'Selected card is unavailable.', ephemeral: true });
        }
        // block if the selected card is stunned/frozen
        if (hasStatusLock(card)) {
          return interaction.followUp({ content: `${card.def.character} is ${getStatusLockReason(card)} and cannot act!`, ephemeral: true });
        }
        let aliveEnemies = state.marines.filter(m => m.currentHP > 0);
        if (aliveEnemies.length === 0) {
          const userDoc = await User.findOne({ userId: state.userId });
          const advanced = await advanceToNextWave(state, interaction.message, userDoc, discordUser);
          if (advanced) {
            aliveEnemies = state.marines.filter(m => m.currentHP > 0);
            if (aliveEnemies.length === 0) return interaction.followUp({ content: 'No valid targets remaining.', ephemeral: true });
          } else {
            return interaction.followUp({ content: 'No valid targets remaining.', ephemeral: true });
          }
        }
        let targetIdx = state.marines.findIndex(m => m.currentHP > 0);
        // Determine if this card should trigger multi-target selection
        let required = 1;
        if (act === 'attack' && card.def.count) {
          if (typeof card.def.count === 'number') required = Math.min(card.def.count, aliveEnemies.length);
          else required = aliveEnemies.length;
        } else if (act === 'special' && card.def.scount) {
          if (typeof card.def.scount === 'number') required = Math.min(card.def.scount, aliveEnemies.length);
          else required = aliveEnemies.length;
        }

        // Prompt for multi-select or auto-target if applicable
        let autoTargets = null;
        if (aliveEnemies.length > 1 && !state.awaitingTarget) {
          if (required > 1) {
            if (required >= aliveEnemies.length) {
              // auto-target all alive enemies
              autoTargets = state.marines.filter(m => m.currentHP > 0);
            } else {
              // require player to pick `required` targets
              state.awaitingTarget = { action: act, required, selections: [] };
              await safeUpdateBattleMessage(interaction.message, state, await User.findOne({ userId: state.userId }), discordUser);
              return safeDefer(interaction);
            }
          } else {
            // single target: prompt user to pick one
            state.awaitingTarget = act;
            await safeUpdateBattleMessage(interaction.message, state, await User.findOne({ userId: state.userId }), discordUser);
            return safeDefer(interaction);
          }
        }
        // cost checks and energy deduction
        if (act === 'attack') {
          if (card.energy < 1) return interaction.followUp({ content: 'Not enough energy for attack.', ephemeral: true });
          card.energy -= 1;
        } else if (act === 'special') {
          const { isSpecialAttackUnlocked: _isailSpecCheck } = require('../utils/starLevel');
          if (!_isailSpecCheck(card.userEntry?.starLevel)) {
            return interaction.followUp({ content: `**${card.def.character}** has not unlocked Special Attack yet. Reach **Star Level 4** to unlock it.`, ephemeral: true });
          }
          if (card.energy < 3) return interaction.followUp({ content: 'Special attack requires 3 <:energy:1478051414558118052>.', ephemeral: true });
          card.energy -= 3;
          // set gif display
          if (card.def.special_attack && card.def.special_attack.gif) {
            state.embedImage = normalizeGifUrl(card.def.special_attack.gif);
          }
        }
        // Apply bleed if present when energy is spent
        try {
          const energySpent = act === 'special' ? 3 : (act === 'attack' ? 1 : 0);
          const bleedLogs = applyBleedOnEnergyUse(card, energySpent);
          bleedLogs.forEach(l => appendLog(state, l));
        } catch (e) {}
        card.turnsUntilRecharge = 2;
        const confusionResolved = await handleConfusionAction(state, interaction, card, act);
        if (confusionResolved) return safeDefer(interaction);
        // recalc damage with user context so boosts are always included
        const user = await User.findOne({ userId: state.userId });
        const baseDmg = calculateUserDamage(card, act, user);
        // If we auto-selected multiple targets (e.g., count/scount hitting all enemies),
        // apply per-target damage distribution and then apply effects appropriately.
        if (autoTargets && autoTargets.length) {
          const targets = autoTargets;
          const basePerTarget = Math.max(0, Math.floor(baseDmg / Math.max(1, targets.length)));
          const perTargetDmg = [];
          for (const tgt of targets) {
            if (!tgt) continue;
            const attrMultiplier = getDamageMultiplier(card.def.attribute, tgt.attribute || tgt.def?.attribute);
            const proneMultiplier = getProneMultiplier(card, tgt);
            const attackModLocal = getAttackModifier(card);
            const defenseMultiplierLocal = getDefenseMultiplier(card, tgt);
            let dmg = Math.max(0, Math.floor(basePerTarget * attrMultiplier * proneMultiplier * attackModLocal * defenseMultiplierLocal));

            const reflect = getReflectStatus(tgt);
            if (reflect) {
              card.currentHP = Math.max(0, (card.currentHP || 0) - dmg);
              const reflectKO = handleKO(card);
              if (reflectKO) appendLog(state, reflectKO);
              appendLog(state, `${tgt.rank || tgt.def?.character}'s reflect sends the attack back to ${card.def.character} for **${dmg} DMG**!`);
            } else {
              tgt.currentHP -= dmg;
              if (tgt.currentHP <= 0) {
                tgt.currentHP = 0;
                const ko = handleKO(tgt);
                if (ko) appendLog(state, ko);
              }
            }
            // unfreeze
            if (tgt.status) {
              const freezeIdx = tgt.status.findIndex(st => st.type === 'freeze');
              if (freezeIdx >= 0) tgt.status.splice(freezeIdx, 1);
            }
            perTargetDmg.push(dmg);
          }

          // Apply effects for specials according to multi-target rules
          let effectLogs = [];
          if (act === 'special') {
            let multiEffectTarget = null;
            if (card.def.effect === 'team_stun') {
              multiEffectTarget = state.marines.filter(m => m.currentHP > 0);
            } else if (card.def.all) {
              if (card.def.effect) multiEffectTarget = targets;
            } else {
              // scount: apply effect to all selected targets (not just the first)
              multiEffectTarget = card.def.scount ? targets : (targets[0] || null);
            }
            const { isStatusEffectUnlocked: _isailAutoEffUnlocked } = require('../utils/starLevel');
            if (multiEffectTarget && _isailAutoEffUnlocked(card.userEntry?.starLevel)) {
              try {
                effectLogs = applyCardEffectShared(card, multiEffectTarget, { playerTeam: state.cards, opponentTeam: state.marines, marines: state.marines, cards: state.cards });
              } catch (e) {
                console.error('Error applying effect:', e);
              }
            }
          }

          // Build action summary
          const names = targets.map(t => `${t.emoji || ''} ${t.rank || t.def?.character}`).join(', ');
          const dmgSummary = perTargetDmg.length ? (perTargetDmg.every(d => d === perTargetDmg[0]) ? `**${perTargetDmg[0]} DMG** each` : perTargetDmg.map(d => `**${d}**`).join('/')) : '**0 DMG**';
          const cost = act === 'attack' ? 1 : act === 'special' ? 3 : 0;
          const actionVerb = act === 'special' ? (card.def.special_attack?.name || 'Special Attack') : 'attacked';
          state.lastUserAction = `${card.def.emoji} **${card.def.character}** ${act === 'special' ? 'used' : 'attacked'} ${act === 'special' ? actionVerb : names} for ${dmgSummary}! **<:energy:1478051414558118052> -${cost}**`;

          if (effectLogs && effectLogs.length) effectLogs.forEach(l => appendLog(state, l));
          state.selected = null;
          try {
            const finished = await finalizeUserAction(state, interaction.message, interaction);
            if (finished) battleStates.delete(interaction.message.id);
          } catch (e) {
            if (e.code === 10008 || e.code === 10062) {
              battleStates.delete(interaction.message.id);
            } else {
              throw e;
            }
          }
          return safeDefer(interaction);
        }
        let damageTarget;
        let effectTarget;
        if (act === 'special' && card.def.effect === 'team_stun') {
          // team_stun: damage single target, stun all alive enemies
          damageTarget = state.marines[targetIdx];
          effectTarget = state.marines.filter(m => m.currentHP > 0);
        } else {
          const m = state.marines[targetIdx];
          damageTarget = m;
          effectTarget = resolveEffectTarget(card, state, m);
        }
        // Drunk: redirect attack to a random different alive marine
        {
          const drunkChance = getDrunkChance(card);
          if (drunkChance > 0 && damageTarget && Math.random() * 100 < drunkChance) {
            const otherMarines = state.marines.filter(m => m.currentHP > 0 && m !== damageTarget);
            if (otherMarines.length > 0) {
              const newTarget = otherMarines[Math.floor(Math.random() * otherMarines.length)];
              appendLog(state, `${card.def.character} is drunk and staggers — attacks ${newTarget.rank || newTarget.def?.character} instead!`);
              damageTarget = newTarget;
            }
          }
        }
        // calculate final damage with attribute multiplier and modifiers
        let attrMultiplier = 1;
        let isDodgedByTruesight = false;
        let attackMod = getAttackModifier(card);
        let proneMultiplier = 1;
        let defenseMultiplier = 1;
        if (damageTarget) {
          attrMultiplier = getDamageMultiplier(card.def.attribute, damageTarget.attribute || damageTarget.def?.attribute);
          proneMultiplier = getProneMultiplier(card, damageTarget);
          defenseMultiplier = getDefenseMultiplier(card, damageTarget);
          if (hasTruesight(damageTarget)) {
            isDodgedByTruesight = true;
            consumeTruesight(damageTarget);
            const dodgeMsg = `${damageTarget.def.character} dodges with truesight!`;
            appendLog(state, dodgeMsg);
            state.lastUserAction = `${card.def.character} tries to attack but ${damageTarget.def.character} evades with truesight!`;
          }
        }

        const dmg = isDodgedByTruesight ? 0 : Math.max(0, Math.floor(baseDmg * attrMultiplier * proneMultiplier * attackMod * defenseMultiplier));
        const _reflectSt1 = !isDodgedByTruesight && damageTarget ? getReflectStatus(damageTarget) : null;
        if (_reflectSt1) {
          card.currentHP = Math.max(0, (card.currentHP || 0) - dmg);
          const reflectKO = handleKO(card);
          if (reflectKO) appendLog(state, reflectKO);
          appendLog(state, `${damageTarget.rank || damageTarget.def?.character}'s reflect sends the attack back to ${card.def.character} for **${dmg} DMG**!`);
        } else if (damageTarget && !isDodgedByTruesight) {
          damageTarget.currentHP -= dmg;
          if (damageTarget.currentHP <= 0) damageTarget.currentHP = 0;
          const ko = handleKO(damageTarget);
          if (ko) appendLog(state, ko);
        }
        // unfreeze the damage target if it was frozen
        if (damageTarget.status) {
          const freezeIdx = damageTarget.status.findIndex(st => st.type === 'freeze');
          if (freezeIdx >= 0) {
            damageTarget.status.splice(freezeIdx, 1);
          }
        }
        if (!isDodgedByTruesight && act === 'special') {
          try {
            console.log(`[isail] applying effect=${card.def.effect} id=${card.def.id} all=${!!card.def.all} targetIsArray=${Array.isArray(effectTarget)} targetCount=${Array.isArray(effectTarget) ? effectTarget.length : (effectTarget ? 1 : 0)}`);
          } catch (e) {}
        }
        const { isStatusEffectUnlocked: _isailEffUnlocked } = require('../utils/starLevel');
        const effectLogs = (!isDodgedByTruesight && act === 'special' && _isailEffUnlocked(card.userEntry?.starLevel)) ? applyCardEffectShared(card, effectTarget, { playerTeam: state.cards, opponentTeam: state.marines, marines: state.marines, cards: state.cards }) : [];
        effectLogs.forEach(l => appendLog(state, l));
        if (!isDodgedByTruesight && act === 'special' && card.def.special_attack?.gif) {
          try {
            let desc = `${card.def.character} uses ${card.def.special_attack.name || 'Special Attack'}!`;
            if (card.def.effect && card.def.effectDuration) {
              const effectDesc = getEffectDescription(card.def.effect, card.def.effectDuration, !!card.def.itself, card.def.effectAmount, card.def.effectChance);
              if (effectDesc) desc += `\n*${effectDesc}*`;
            }
            const normalizedGifUrl = normalizeGifUrl(card.def.special_attack.gif);
            // fetch and send as attachment to avoid remote-host embed issues
            try {
              const gifBuf = await fetchBuffer(normalizedGifUrl);
              const att = new AttachmentBuilder(gifBuf, { name: 'special.gif' });
              const gifEmbed = new EmbedBuilder()
                .setColor(state.startingPlayer === 'user' ? '#FFFFFF' : '#000000')
                .setImage('attachment://special.gif')
                .setDescription(desc);
              const gifMsg = await interaction.channel.send({ embeds: [gifEmbed], files: [att] });
              state.gifMessageId = gifMsg.id;
            } catch (innerErr) {
              state.embedImage = null;
              state.embedImage = null;
              // fallback to URL embed if fetching fails
              const gifEmbed = new EmbedBuilder()
                .setColor(state.startingPlayer === 'user' ? '#FFFFFF' : '#000000')
                .setImage(normalizedGifUrl)
                .setDescription(desc);
              const gifMsg = await interaction.channel.send({ embeds: [gifEmbed] }).catch(() => null);
              if (gifMsg) state.gifMessageId = gifMsg.id;
            }
          } catch (e) {
            console.error('Failed to send special attack GIF:', e);
            // Continue with battle even if GIF fails
          }
        }
        const cost = act === 'attack' ? 1 : act === 'special' ? 3 : 1;
        const effectivenessStr = attrMultiplier > 1 ? ' (Effective!)' : attrMultiplier < 1 ? ' (Weak)' : '';
        const effectMessages = effectLogs.length > 0 ? ` *${effectLogs.join(', ')}*` : '';
        if (act === 'special') {
          if (card.def.effect === 'team_stun') {
            // Only show stun text if the status effect is unlocked (star level 5+)
            const stunMsg = _isailEffUnlocked(card.userEntry?.starLevel) ? ` *stunned the whole crew*` : '';
            state.lastUserAction = `${card.def.emoji} **${card.def.character}** used ${card.def.special_attack ? card.def.special_attack.name : 'Special Attack'} on ${damageTarget.emoji} **${damageTarget.rank}** for **${dmg} DMG**!${effectivenessStr}${stunMsg}${effectMessages} **<:energy:1478051414558118052> -${cost}**`;
          } else {
            // Only describe the status effect if it is actually unlocked (star level 5+)
            const effectStr = _isailEffUnlocked(card.userEntry?.starLevel) ? getEffectString(card, damageTarget) : '';
            state.lastUserAction = `${card.def.emoji} **${card.def.character}** used ${card.def.special_attack ? card.def.special_attack.name : 'Special Attack'} for **${dmg} DMG**!${effectivenessStr}${effectStr}${effectMessages} **<:energy:1478051414558118052> -${cost}**`;
          }
        } else {
          state.lastUserAction = `${card.def.emoji} **${card.def.character}** attacked ${damageTarget.emoji} **${damageTarget.rank}** for **${dmg} DMG**!${effectivenessStr}${effectMessages} **<:energy:1478051414558118052> -${cost}**`;
        }
      }
      else if (act === 'rest') {
        // If a specific card is selected, rest only that card (3 energy, 10% HP)
        if (state.selected !== null) {
          const card = state.cards[state.selected];
          if (card && card.alive) {
            card.energy = 3;
            card.turnsUntilRecharge = 2;
            const healAmount = Math.ceil((card.maxHP || card.def.health) * 0.10);
            card.currentHP = Math.min(card.maxHP || card.def.health, (card.currentHP || 0) + healAmount);
            const removed = card.status?.some(st => st.type === 'freeze' || st.type === 'hungry');
            if (removed) {
              removeStatusTypes(card, ['freeze', 'hungry']);
            }
            state.lastUserAction = `${card.def.character} took a rest, restored energy and healed for ${healAmount} HP${removed ? ', and recovered from freeze/hunger' : ''}!`;
          } else {
            state.lastUserAction = `Invalid selection for rest.`;
          }
        } else {
          // Team rest: heal all alive cards by 5% max HP, restore +2 energy to each
          state.cards.forEach(c => {
            if (c.alive) {
              c.currentHP = Math.min(c.maxHP || c.def.health, (c.currentHP || 0) + Math.floor((c.maxHP || c.def.health) * 0.05));
              c.energy = Math.min(3, c.energy + 2);
            }
          });
          state.lastUserAction = `The team took a rest, healed 5% HP and restored +2 energy each!`;
        }
      } else {
        return interaction.followUp({ content: 'Unknown action.', ephemeral: true });
      }

      // Clear log after action to prevent accumulation
      state.log = '';

      try {
        const finished = await finalizeUserAction(state, interaction.message, interaction);
        if (finished) battleStates.delete(msgId);
      } catch (e) {
        // If message was deleted or interaction expired, clean up gracefully
        if (e.code === 10008 || e.code === 10062) {
          battleStates.delete(msgId);
          if (!interaction.deferred && !interaction.replied) {
            try {
              await interaction.reply({ content: 'Battle session ended (message deleted or expired).', ephemeral: true });
            } catch {}
          }
        } else {
          throw e;
        }
      }
      return safeDefer(interaction);
    }

    if (type === 'target') {
      const targetIdx = parseInt(cardId, 10);
      if (isNaN(targetIdx) || targetIdx < 0 || targetIdx >= state.marines.length) {
        return interaction.followUp({ content: 'Invalid target.', ephemeral: true });
      }
      const awaiting = state.awaitingTarget;
      if (!awaiting) {
        return interaction.followUp({ content: 'Invalid target action.', ephemeral: true });
      }

      // Multi-select flow
      if (typeof awaiting === 'object') {
        const act = awaiting.action;
        const required = awaiting.required || 1;
        const selections = Array.isArray(awaiting.selections) ? awaiting.selections.slice() : [];
        // Validate target
        const selMarine = state.marines[targetIdx];
        if (!selMarine || selMarine.currentHP <= 0) {
          return interaction.followUp({ content: 'Target is already defeated.', ephemeral: true });
        }
        if (!selections.includes(targetIdx)) selections.push(targetIdx);
        // If we haven't collected enough selections yet, update state and prompt further
        if (selections.length < required) {
          state.awaitingTarget = { action: act, required, selections };
          await safeUpdateBattleMessage(interaction.message, state, await User.findOne({ userId: state.userId }), discordUser);
          return safeDefer(interaction);
        }
        // Selections complete – clear awaiting and perform multi-target attack
        state.awaitingTarget = null;
        const card = state.cards[state.selected];
        if (!card || !card.alive) {
          return interaction.followUp({ content: 'Selected card is unavailable.', ephemeral: true });
        }
        if (hasStatusLock(card)) {
          return interaction.followUp({ content: `${card.def.character} is ${getStatusLockReason(card)} and cannot act!`, ephemeral: true });
        }
        let aliveEnemies = state.marines.filter(m => m.currentHP > 0);
        if (aliveEnemies.length === 0) {
          const userDoc = await User.findOne({ userId: state.userId });
          const advanced = await advanceToNextWave(state, interaction.message, userDoc, discordUser);
          if (advanced) {
            aliveEnemies = state.marines.filter(m => m.currentHP > 0);
            if (aliveEnemies.length === 0) return interaction.followUp({ content: 'No valid targets remaining.', ephemeral: true });
          } else {
            return interaction.followUp({ content: 'No valid targets remaining.', ephemeral: true });
          }
        }

        // Deduct energy
        if (act === 'attack') {
          if (card.energy < 1) return interaction.followUp({ content: 'Not enough energy for attack.', ephemeral: true });
          card.energy -= 1;
        } else if (act === 'special') {
          const { isSpecialAttackUnlocked: _isailSpecCheck2 } = require('../utils/starLevel');
          if (!_isailSpecCheck2(card.userEntry?.starLevel)) {
            return interaction.followUp({ content: `**${card.def.character}** has not unlocked Special Attack yet. Reach **Star Level 4** to unlock it.`, ephemeral: true });
          }
          if (card.energy < 3) return interaction.followUp({ content: 'Special attack requires 3 <:energy:1478051414558118052>.', ephemeral: true });
          card.energy -= 3;
          if (card.def.special_attack && card.def.special_attack.gif) {
            state.embedImage = normalizeGifUrl(card.def.special_attack.gif);
          }
        }
        try {
          const energySpent = act === 'special' ? 3 : (act === 'attack' ? 1 : 0);
          const bleedLogs = applyBleedOnEnergyUse(card, energySpent);
          bleedLogs.forEach(l => appendLog(state, l));
        } catch (e) {}

        card.turnsUntilRecharge = 2;
        const confusionResolved = await handleConfusionAction(state, interaction, card, act);
        if (confusionResolved) return safeDefer(interaction);
        const user = await User.findOne({ userId: state.userId });
        const baseDmg = calculateUserDamage(card, act, user);

        const targets = selections.map(i => state.marines[i]).filter(Boolean);
        const basePerTarget = Math.max(0, Math.floor(baseDmg / Math.max(1, targets.length)));
        const perTargetDmg = [];
        for (const tgt of targets) {
          if (!tgt) continue;
          const attrMultiplier = getDamageMultiplier(card.def.attribute, tgt.attribute || tgt.def?.attribute);
          const proneMultiplier = getProneMultiplier(card, tgt);
          const attackModLocal = getAttackModifier(card);
          const defenseMultiplierLocal = getDefenseMultiplier(card, tgt);
          let dmg = Math.max(0, Math.floor(basePerTarget * attrMultiplier * proneMultiplier * attackModLocal * defenseMultiplierLocal));

          const reflect = getReflectStatus(tgt);
          if (reflect) {
            card.currentHP = Math.max(0, (card.currentHP || 0) - dmg);
            const reflectKO = handleKO(card);
            if (reflectKO) appendLog(state, reflectKO);
            appendLog(state, `${tgt.rank || tgt.def?.character}'s reflect sends the attack back to ${card.def.character} for **${dmg} DMG**!`);
          } else {
            tgt.currentHP -= dmg;
            if (tgt.currentHP <= 0) {
              tgt.currentHP = 0;
              const ko = handleKO(tgt);
              if (ko) appendLog(state, ko);
            }
          }
          if (tgt.status) {
            const freezeIdx = tgt.status.findIndex(st => st.type === 'freeze');
            if (freezeIdx >= 0) tgt.status.splice(freezeIdx, 1);
          }
          perTargetDmg.push(dmg);
        }

        let effectLogs = [];
        if (act === 'special') {
          let effectTarget = null;
          if (card.def.effect === 'team_stun') {
            effectTarget = state.marines.filter(m => m.currentHP > 0);
          } else if (card.def.all) {
            if (card.def.effect) effectTarget = targets;
          } else {
            // scount: apply effect to all selected targets (not just the first)
            effectTarget = card.def.scount ? targets : (targets[0] || null);
          }
          const { isStatusEffectUnlocked: _isailAutoEffUnlocked } = require('../utils/starLevel');
          if (effectTarget && _isailAutoEffUnlocked(card.userEntry?.starLevel)) {
            try {
              effectLogs = applyCardEffectShared(card, effectTarget, { playerTeam: state.cards, opponentTeam: state.marines, marines: state.marines, cards: state.cards });
            } catch (e) {
              console.error('Error applying effect:', e);
            }
          }
        }

        const names = targets.map(t => `${t.emoji || ''} ${t.rank || t.def?.character}`).join(', ');
        const dmgSummary = perTargetDmg.length ? (perTargetDmg.every(d => d === perTargetDmg[0]) ? `**${perTargetDmg[0]} DMG** each` : perTargetDmg.map(d => `**${d}**`).join('/')) : '**0 DMG**';
        const cost = act === 'attack' ? 1 : act === 'special' ? 3 : 0;
        const actionVerb = act === 'special' ? (card.def.special_attack?.name || 'Special Attack') : 'attacked';
        state.lastUserAction = `${card.def.emoji} **${card.def.character}** ${act === 'special' ? 'used' : 'attacked'} ${act === 'special' ? actionVerb : names} for ${dmgSummary}! **<:energy:1478051414558118052> -${cost}**`;

        if (effectLogs && effectLogs.length) effectLogs.forEach(l => appendLog(state, l));
        state.selected = null;
        try {
          const finished = await finalizeUserAction(state, interaction.message, interaction);
          if (finished) battleStates.delete(interaction.message.id);
        } catch (e) {
          if (e.code === 10008 || e.code === 10062) {
            battleStates.delete(interaction.message.id);
            if (!interaction.deferred && !interaction.replied) {
              try { await interaction.reply({ content: 'Battle session ended (message deleted or expired).', ephemeral: true }); } catch {}
            }
          } else {
            throw e;
          }
        }
        return safeDefer(interaction);
      }

      // Single-target flow (existing behavior)
      const act = state.awaitingTarget;
      state.awaitingTarget = null;
      if (!act || (act !== 'attack' && act !== 'special')) {
        return interaction.followUp({ content: 'Invalid target action.', ephemeral: true });
      }
      const card = state.cards[state.selected];
      if (!card || !card.alive) {
        return interaction.followUp({ content: 'Selected card is unavailable.', ephemeral: true });
      }

      // Full action logic mirroring the main attack/special handler
      if (hasStatusLock(card)) {
        return interaction.followUp({ content: `${card.def.character} is ${getStatusLockReason(card)} and cannot act!`, ephemeral: true });
      }
      let aliveEnemies = state.marines.filter(m => m.currentHP > 0);
      if (aliveEnemies.length === 0) {
        const userDoc = await User.findOne({ userId: state.userId });
        const advanced = await advanceToNextWave(state, interaction.message, userDoc, discordUser);
        if (advanced) {
          aliveEnemies = state.marines.filter(m => m.currentHP > 0);
          if (aliveEnemies.length === 0) return interaction.followUp({ content: 'No valid targets remaining.', ephemeral: true });
        } else {
          return interaction.followUp({ content: 'No valid targets remaining.', ephemeral: true });
        }
      }
      let m = state.marines[targetIdx];
      if (!m || m.currentHP <= 0) {
        return interaction.followUp({ content: 'Target is already defeated.', ephemeral: true });
      }

      // Deduct energy
      if (act === 'attack') {
        card.energy -= 1;
      } else if (act === 'special') {
        const { isSpecialAttackUnlocked: _isailSpecCheck2 } = require('../utils/starLevel');
        if (!_isailSpecCheck2(card.userEntry?.starLevel)) {
          return interaction.followUp({ content: `**${card.def.character}** has not unlocked Special Attack yet. Reach **Star Level 4** to unlock it.`, ephemeral: true });
        }
        card.energy -= 3;
        // Set gif display for special attacks
        if (card.def.special_attack && card.def.special_attack.gif) {
          state.embedImage = normalizeGifUrl(card.def.special_attack.gif);
        }
      }
      // Apply bleed if present when energy is spent
      try {
        const energySpent = act === 'special' ? 3 : (act === 'attack' ? 1 : 0);
        const bleedLogs = applyBleedOnEnergyUse(card, energySpent);
        bleedLogs.forEach(l => appendLog(state, l));
      } catch (e) {}

      card.turnsUntilRecharge = 2;
      const confusionResolved = await handleConfusionAction(state, interaction, card, act);
      if (confusionResolved) return safeDefer(interaction);
      // Drunk: redirect attack to a random different alive marine
      {
        const drunkChance = getDrunkChance(card);
        if (drunkChance > 0 && Math.random() * 100 < drunkChance) {
          const otherMarines = state.marines.filter(other => other.currentHP > 0 && other !== m);
          if (otherMarines.length > 0) {
            const newTarget = otherMarines[Math.floor(Math.random() * otherMarines.length)];
            appendLog(state, `${card.def.character} is drunk and staggers — attacks ${newTarget.rank || newTarget.def?.character} instead!`);
            m = newTarget;
          }
        }
      }
      const user = await User.findOne({ userId: state.userId });
      const baseDmg = calculateUserDamage(card, act, user);
      let attrMultiplier = 1;
      let isDodgedByTruesight = false;
      let attackMod = getAttackModifier(card);
      let proneMultiplier = getProneMultiplier(card, m);
      let defenseMultiplier = getDefenseMultiplier(card, m);
      let effectTarget = resolveEffectTarget(card, state, m);
      
      if (hasTruesight(m)) {
        isDodgedByTruesight = true;
        consumeTruesight(m);
        const dodgeMsg = `${m.def.character} dodges with truesight!`;
        appendLog(state, dodgeMsg);
        state.lastUserAction = `${card.def.character} tries to attack but ${m.def.character} evades with truesight!`;
      } else {
        attrMultiplier = getDamageMultiplier(card.def.attribute, m.attribute || m.def?.attribute);
      }

      const dmg = isDodgedByTruesight ? 0 : Math.max(0, Math.floor(baseDmg * attrMultiplier * proneMultiplier * attackMod * defenseMultiplier));
      const _reflectSt2 = !isDodgedByTruesight ? getReflectStatus(m) : null;
      if (_reflectSt2) {
        card.currentHP = Math.max(0, (card.currentHP || 0) - dmg);
        const reflectKO = handleKO(card);
        if (reflectKO) appendLog(state, reflectKO);
        appendLog(state, `${m.rank || m.def?.character}'s reflect sends the attack back to ${card.def.character} for **${dmg} DMG**!`);
      } else if (!isDodgedByTruesight) {
        m.currentHP -= dmg;
        if (m.currentHP <= 0) {
          m.currentHP = 0;
          const ko = handleKO(m);
          if (ko) appendLog(state, ko);
        }
      }

      // Unfreeze the damage target if it was frozen
      if (m.status) {
        const freezeIdx = m.status.findIndex(st => st.type === 'freeze');
        if (freezeIdx >= 0) {
          m.status.splice(freezeIdx, 1);
        }
      }

      // Apply effects for special attacks
        if (!isDodgedByTruesight && act === 'special') {
          try {
            console.log(`[isail] applying effect=${card.def.effect} id=${card.def.id} all=${!!card.def.all} targetIsArray=${Array.isArray(effectTarget)} targetCount=${Array.isArray(effectTarget) ? effectTarget.length : (effectTarget ? 1 : 0)}`);
          } catch (e) {}
        }
      const effectLogs = (!isDodgedByTruesight && act === 'special') ? applyCardEffectShared(card, effectTarget, { playerTeam: state.cards, opponentTeam: state.marines, marines: state.marines, cards: state.cards }) : [];
      effectLogs.forEach(l => appendLog(state, l));

      // Send GIF for special attacks
      if (!isDodgedByTruesight && act === 'special' && card.def.special_attack?.gif) {
        try {
          let desc = `${card.def.character} uses ${card.def.special_attack.name || 'Special Attack'}!`;
          if (card.def.effect && card.def.effectDuration) {
            const effectDesc = getEffectDescription(card.def.effect, card.def.effectDuration, !!card.def.itself, card.def.effectAmount, card.def.effectChance);
            if (effectDesc) desc += `\n*${effectDesc}*`;
          }
          const normalizedGifUrl = normalizeGifUrl(card.def.special_attack.gif);
          try {
            const gifBuf = await fetchBuffer(normalizedGifUrl);
            const att = new AttachmentBuilder(gifBuf, { name: 'special.gif' });
            const gifEmbed = new EmbedBuilder()
              .setColor(state.startingPlayer === 'user' ? '#FFFFFF' : '#000000')
              .setImage('attachment://special.gif')
              .setDescription(desc);
            const gifMsg = await interaction.channel.send({ embeds: [gifEmbed], files: [att] });
            state.gifMessageId = gifMsg.id;
          } catch (innerErr) {
            state.embedImage = null;
            const gifEmbed = new EmbedBuilder()
              .setColor(state.startingPlayer === 'user' ? '#FFFFFF' : '#000000')
              .setImage(normalizedGifUrl)
              .setDescription(desc);
            const gifMsg = await interaction.channel.send({ embeds: [gifEmbed] }).catch(() => null);
            if (gifMsg) state.gifMessageId = gifMsg.id;
          }
        } catch (e) {
          console.error('Failed to send special attack GIF:', e);
        }
      }

      const cost = act === 'attack' ? 1 : act === 'special' ? 3 : 1;
      const effectivenessStr = attrMultiplier > 1 ? ' (Effective!)' : attrMultiplier < 1 ? ' (Weak)' : '';
      const effectMessages = effectLogs.length > 0 ? ` *${effectLogs.join(', ')}*` : '';
      if (act === 'special') {
        state.lastUserAction = `${card.def.emoji} **${card.def.character}** used ${card.def.special_attack ? card.def.special_attack.name : 'Special Attack'} on ${m.emoji} **${m.rank}** for **${dmg} DMG**!${effectivenessStr}${effectMessages} **<:energy:1478051414558118052> -${cost}**`;
      } else {
        state.lastUserAction = `${card.def.emoji} **${card.def.character}** attacked ${m.emoji} **${m.rank}** for **${dmg} DMG**!${effectivenessStr}${effectMessages} **<:energy:1478051414558118052> -${cost}**`;
      }

      state.selected = null;
      try {
        const finished = await finalizeUserAction(state, interaction.message, interaction);
        if (finished) battleStates.delete(msgId);
      } catch (e) {
        if (e.code === 10008 || e.code === 10062) {
          battleStates.delete(msgId);
          if (!interaction.deferred && !interaction.replied) {
            try {
              await interaction.reply({ content: 'Battle session ended (message deleted or expired).', ephemeral: true });
            } catch {}
          }
        } else {
          throw e;
        }
      }
      return safeDefer(interaction);
    }

    // default fallback
    return interaction.followUp({ content: 'Unsupported interaction.', ephemeral: true });
  } catch (e) {
    console.error('Error handling isail button:', e);
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({ content: 'An error occurred handling the interaction.', ephemeral: true });
      } else {
        await interaction.followUp({ content: 'An error occurred handling the interaction.', ephemeral: true });
      }
    } catch {}
  }
},
startBattleWithMarines,
battleStates,
buildStageWaveSlices
}
