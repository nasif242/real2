const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

// wrapper for deferring interactions safely (avoids 10062 Unknown interaction)
async function safeDefer(interaction) {
  if (interaction.deferred || interaction.replied) return;

  try {
    await interaction.deferUpdate();
  } catch (e) {
    if (e.code !== 10062) {
      console.error('Failed to defer interaction:', e);
    }
  }
}
const User = require('../models/User');
const { cards: cardDefs } = require('../data/cards');
const { resolveStats } = require('../utils/statResolver');
const { getEffectDescription, normalizeGifUrl, getCardById, searchCards, normalizeCardId } = require('../utils/cards');
const { getDamageMultiplier, getAttributeDescription } = require('../utils/attributeSystem');
const { getNextPullResetDate } = require('../src/stock');

const statusManager = require('../src/battle/statusManager');
const STATUS_EMOJIS = statusManager.STATUS_EMOJIS;
const {
  addStatus,
  hasStatusLock,
  hasAttackDisabled,
  getStatusLockReason,
  applyStartOfTurnEffects: applyStatusesForTurn,
  applyCardEffect: applyCardEffectShared,
  calculateUserDamage: calculateUserDamageShared,
  getAttackModifier,
  getDefenseMultiplier,
  getConfusionChance,
  getProneMultiplier,
  getDrunkChance,
  applyBleedOnEnergyUse,
  removeStatusTypes,
  hasTruesight,
  consumeTruesight,
  handleKO
} = statusManager;

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatAmount(value) {
  const absValue = Math.abs(value);
  const str = absValue.toString();
  if (str.length < 5) return value.toString();
  const formatted = str.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return value < 0 ? `-${formatted}` : formatted;
}

function getReflectStatus(entity) {
  return entity?.status?.find(st => st.type === 'reflect');
}

function isCharmedAgainstTarget(attacker, target) {
  if (!attacker || !target || !attacker.status) return false;
  return attacker.status.some(st => st.type === 'charmed') && attacker.def.attribute === target.def.attribute;
}

function resolveDuelEffectTarget(card, myTeam, opponentTeam, selectedTarget) {
  if (!card) return selectedTarget;
    if (card.def.effect === 'team_stun') {
    return opponentTeam.filter(c => c.currentHP > 0);
  }
  // Prefer special-attack multi-target (`scount`) for effect targeting, fall back to normal `count`
  if (card.def.scount) {
    return card.def.itself ? myTeam.filter(c => c.alive) : opponentTeam.filter(c => c.currentHP > 0);
  }
  if (card.def.count) {
    return card.def.itself ? myTeam.filter(c => c.alive) : opponentTeam.filter(c => c.currentHP > 0);
  }
  return selectedTarget;
}

const calculateUserDamage = calculateUserDamageShared;

// Find the best matching card from a player's pool using the repo's search
// helpers and prioritizing the player's team/favorites like other commands.
async function findCardInPoolByQuery(query, userId, pool) {
  if (!query || !Array.isArray(pool) || pool.length === 0) return null;
  const q = String(query).trim();
  const ql = q.toLowerCase();
  const poolIds = new Set((pool || []).map(p => String(normalizeCardId(p.def.id))));

  // direct id match
  try {
    const byId = getCardById(q);
    if (byId && poolIds.has(normalizeCardId(byId.id))) return pool.find(p => normalizeCardId(p.def.id) === normalizeCardId(byId.id));
  } catch (e) {}

  // Load user to access team/favorites/owned lists
  let userDoc = null;
  try { userDoc = await User.findOne({ userId }); } catch (e) {}
  const teamIds = (userDoc && Array.isArray(userDoc.team)) ? userDoc.team : [];
  const favIds = (userDoc && Array.isArray(userDoc.favoriteCards)) ? userDoc.favoriteCards : [];
  const ownedIds = (userDoc && Array.isArray(userDoc.ownedCards)) ? userDoc.ownedCards.map(e => e.cardId) : [];

  // Search general results and prefer those in the pool
  try {
    const results = searchCards(q);
    if (results && results.length) {
      const filtered = results.filter(r => poolIds.has(normalizeCardId(r.id)));
      if (filtered.length) {
        // sort by priority: team+owned, fav+owned, owned, else
        filtered.sort((a, b) => {
          function score(r) {
            if (teamIds.includes(r.id) && ownedIds.includes(r.id)) return 0;
            if (favIds.includes(r.id) && ownedIds.includes(r.id)) return 1;
            if (ownedIds.includes(r.id)) return 2;
            return 3;
          }
          const sa = score(a), sb = score(b);
          if (sa !== sb) return sa - sb;
          return 0;
        });
        return pool.find(p => normalizeCardId(p.def.id) === normalizeCardId(filtered[0].id));
      }
    }
  } catch (e) {}

  // Fallback to matching by character name within the pool
  // try matching by title first (exact, then partial)
  let chosen = pool.find(c => (c.def.title || '').toLowerCase() === ql);
  if (chosen) return chosen;
  chosen = pool.find(c => (c.def.title || '').toLowerCase().includes(ql));
  if (chosen) return chosen;

  // then try character exact/partial
  chosen = pool.find(c => (c.def.character || '').toLowerCase() === ql);
  if (chosen) return chosen;
  chosen = pool.find(c => (c.def.character || '').toLowerCase().includes(ql));
  if (chosen) return chosen;

  return null;
}

// Map to track pending duel requests (messageId => pendingState)
const pendingDuelRequests = new Map();
const duelStates = new Map();
const stratDrafts = new Map();

// global cut damage helper
function applyGlobalCut(state) {
  const logs = [];
  logs.push(...applyStatusesForTurn(state.player1Cards));
  logs.push(...applyStatusesForTurn(state.player2Cards));
  logs.forEach(l => appendLog(state, l));
}

// refresh the duel embed by deleting old message and sending a new one
async function refreshDuelMessage(oldMsg, state) {
  try {
    await updateDuelMessage(oldMsg, state);
  } catch (e) {
    console.error('refreshDuelMessage failed to delegate to updateDuelMessage', e);
  }
  return oldMsg;
}


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

function getEffectString(card, target) {
  if (!card.def.effect) return '';
  if (card.def.effect === 'team_stun') {
    const duration = card.def.effectDuration || 1;
    if (duration === -1) {
      return ` (${STATUS_EMOJIS.stun} stuns the whole team permanently)`;
    }
    return ` (${STATUS_EMOJIS.stun} stuns the whole team for **${duration}** turn(s))`;
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
      'undead': 'grants undead to',
      'reflect': 'reflects attacks',
      'acid': 'applies acid to',
      'prone': 'makes',
      'blessed': 'blesses',
      'charmed': 'charms',
      'doomed': 'dooms',
      'drunk': 'makes',
      'hungry': 'hunts'
    };
    const verb = effectVerbs[card.def.effect] || 'affects';
    const duration = card.def.effectDuration ?? (card.def.effect === 'doomed' ? 3 : 1);
    const isPermanent = duration === -1 || duration === 0 || card.def.effect === 'freeze' || card.def.effect === 'hungry';
    const targetIsMulti = !!(card.def.scount || card.def.count);
    const targetName = targetIsMulti ? (card.def.itself ? 'your whole team' : 'the whole team') : (card.def.itself ? card.def.character : (target ? target.def.character : 'target'));
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
    if (card.def.effect === 'acid') details = ` (${effectAmount} initial)`;
    if (card.def.effect === 'prone') details = ` (${effectAmount}% extra)`;
    if (card.def.effect === 'drunk') details = ` (${effectChance}% wrong target chance)`;
    if (card.def.effect === 'hungry') details = ` (${effectAmount} damage/turn)`;

    if (isPermanent) {
      const permanentVerbs = {
        'stun': 'permanently stuns',
        'freeze': 'permanently freezes',
        'cut': 'permanently cuts',
        'bleed': 'permanently bleeds',
        'regen': 'permanently regenerates',
        'confusion': 'permanently confuses',
        'attackup': 'Permanently boosts attack by',
        'attackdown': 'Permanently reduces attack by',
        'defenseup': 'Permanently boosts defense by',
        'defensedown': 'Permanently reduces defense by',
        'truesight': 'permanently grants truesight to',
        'undead': 'permanently grants undead to',
        'freeze': 'permanently freezes',
        'hungry': 'permanently makes',
        'reflect': 'permanently reflects attacks',
        'acid': 'permanently applies acid to',
        'prone': 'permanently makes',
        'blessed': 'permanently blesses',
        'charmed': 'permanently charms',
        'doomed': 'dooms'
      };
      const permVerb = permanentVerbs[card.def.effect] || 'permanently affects';
      if (['attackup', 'attackdown', 'defenseup', 'defensedown'].includes(card.def.effect)) {
        return ` (${icon} ${permVerb} ${effectAmount}%)`;
      } else if (card.def.effect === 'confusion') {
        return ` (${icon} ${permVerb} ${targetName} (${effectChance}% miss chance))`;
      } else if (card.def.effect === 'regen') {
        return ` (${icon} ${permVerb} ${targetName} (${effectAmount}%))`;
      } else {
        return ` (${icon} ${permVerb} ${targetName}${details})`;
      }
    } else {
      return ` (${icon} ${verb} ${targetName}${details} for **${duration}** turn(s))`;
    }
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

function energyDisplay(energy) {
  if (energy <= 0) return '0';
  return '<:energy:1478051414558118052>'.repeat(energy);
}

function buildEmbed(state) {
  // Embed color based on turn: blue for player 1, red for player 2
  const embedColor = state.turn === 'player1' ? '#0000FF' : '#FF0000';
  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle('Duel: Interactive Battle')
    .setDescription(`${state.discordUser1.username} vs ${state.discordUser2.username}`);
  // attach any queued gif image
  if (state.embedImage) {
    embed.setImage(state.embedImage);
  }
  const { applyDefaultEmbedStyle } = require('../utils/embedStyle');
  applyDefaultEmbedStyle(embed, state.discordUser1);

  // Bounty indication
  if (state.isBountyDuel) {
    const hunter = state.bountyHunter === state.player1Id ? state.discordUser1.username : state.discordUser2.username;
    const target = state.bountyHunter === state.player1Id ? state.discordUser2.username : state.discordUser1.username;
    embed.addFields({ name: 'Bounty Duel', value: `${hunter} is hunting ${target}!`, inline: false });
  }

  // Player 1 team - filter out KO, add each as separate inline field
  const p1Alive = state.player1Cards.filter(c => c.currentHP > 0);
  if (p1Alive.length > 0) {
    for (const c of p1Alive) {
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
      const idx = state.player1Cards.indexOf(c);
      const isSelected = state.selected !== null && idx === state.selected && state.turn === 'player1';
      const level = c.userEntry ? c.userEntry.level : 1;
      const _starLvl1 = c.userEntry ? (c.userEntry.starLevel || 0) : 0;
      let value = `${hpBar(c.currentHP, c.maxHP)}`;
      value += `\n${c.def.character} | Lv. ${level} S${_starLvl1}`;
      value += `\n${c.currentHP}/${c.maxHP} ${energyDisplay(c.energy)}`;
      if (isSelected) value = `**> ${value}**`;
      embed.addFields({ name: fieldName, value, inline: true });
    }
  } else {
    embed.addFields({ name: `${state.discordUser1.username}`, value: 'All cards defeated!', inline: false });
  }

  // Separator between teams
  embed.addFields({ name: '\u200B', value: '\u200B' });

  // Player 2 team - filter out KO, add each as separate inline field
  const p2Alive = state.player2Cards.filter(c => c.currentHP > 0);
  if (p2Alive.length > 0) {
    for (const c of p2Alive) {
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
      const idx = state.player2Cards.indexOf(c);
      const isSelected = state.selected !== null && idx === state.selected && state.turn === 'player2';
      const level = c.userEntry ? c.userEntry.level : 1;
      const _starLvl2 = c.userEntry ? (c.userEntry.starLevel || 0) : 0;
      let value = `${hpBar(c.currentHP, c.maxHP)}`;
      value += `\n${c.def.character} | Lv. ${level} S${_starLvl2}`;
      value += `\n${c.currentHP}/${c.maxHP} ${energyDisplay(c.energy)}`;
      if (isSelected) value = `**> ${value}**`;
      embed.addFields({ name: fieldName, value, inline: true });
    }
  } else {
    embed.addFields({ name: `${state.discordUser2.username}`, value: 'All cards defeated!', inline: false });
  }

  // footer: forfeit hint
  embed.setFooter({ text: 'Use /forfeit to forfeit the battle' });

  // If we're awaiting multiple target selections, show a short hint
  if (state.awaitingTarget && typeof state.awaitingTarget === 'object') {
    const isPlayer1Turn = state.turn === 'player1';
    const targetTeam = isPlayer1Turn ? state.player2Cards : state.player1Cards;
    const sel = state.awaitingTarget.selections || [];
    const names = sel.map(i => (targetTeam[i] && targetTeam[i].def ? `${targetTeam[i].def.emoji || ''} ${targetTeam[i].def.character}` : null)).filter(Boolean).join(', ') || 'None';
    embed.addFields({ name: 'Select Targets', value: `Pick ${state.awaitingTarget.required} target(s): ${names} (${sel.length}/${state.awaitingTarget.required})`, inline: false });
  }

  // action columns
  if (state.lastP1Action || state.lastP2Action) {
    embed.addFields(
      { name: `${state.discordUser1.username}'s Action`, value: state.lastP1Action || '—', inline: true },
      { name: `${state.discordUser2.username}'s Action`, value: state.lastP2Action || '—', inline: true }
    );
  }

  return embed;
}

function makeSelectionRow(state, isPlayer1Turn) {
  const row = new ActionRowBuilder();
  const cards = isPlayer1Turn ? state.player1Cards : state.player2Cards;
  cards.forEach((c, i) => {
    const locked = c.status && c.status.some(st => st.type === 'stun' || st.type === 'freeze');
    const disabled = !c.alive || (isPlayer1Turn ? state.turn !== 'player1' : state.turn !== 'player2') || c.energy === 0 || !!state.awaitingTarget || locked;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`duel_select:${i}`)
        .setLabel(c.def.character)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    );
  });
  // Rest button - only shown when no card is currently selected
  if (state.selected === null) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('duel_action:rest')
        .setLabel('Rest')
        .setStyle(ButtonStyle.Success)
    );
  }
  return row;
}

function makeActionRow(state, isPlayer1Turn) {
  if (state.selected === null || state.awaitingTarget) return null;
  const card = isPlayer1Turn ? state.player1Cards[state.selected] : state.player2Cards[state.selected];
  if (!card) return null;
  const isUndead = card.status && card.status.some(st => st.type === 'undead');
  
  const row = new ActionRowBuilder();
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('duel_action:attack')
      .setLabel('Attack')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isUndead)
  );
  const { isSpecialAttackUnlocked: _duelSpecUnlocked } = require('../utils/starLevel');
  if (card.def.special_attack && card.energy >= 3 && _duelSpecUnlocked(card.userEntry?.starLevel)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('duel_action:special')
        .setLabel('Special Attack')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(isUndead)
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('duel_action:card_rest')
      .setLabel('Rest')
      .setStyle(ButtonStyle.Success)
  );
  return row;
}

function makeTargetRow(state, isPlayer1Turn) {
  if (!state.awaitingTarget) return null;
  const row = new ActionRowBuilder();
  const targetTeam = isPlayer1Turn ? state.player2Cards : state.player1Cards;
  const attackerTeam = isPlayer1Turn ? state.player1Cards : state.player2Cards;
  const attacker = attackerTeam[state.selected];
  // All live cards can be targeted (no tank restriction)
  // If awaitingTarget is an object, it contains multi-select state
  const awaiting = state.awaitingTarget && typeof state.awaitingTarget === 'object' ? state.awaitingTarget : null;
  const preselected = awaiting && Array.isArray(awaiting.selections) ? awaiting.selections : [];
  targetTeam.forEach((c, i) => {
    const disabled = c.currentHP <= 0 || preselected.includes(i);
    const multiplier = getDamageMultiplier(attacker.def.attribute, c.def.attribute);
    let style = ButtonStyle.Secondary; // Grey for neutral
    if (multiplier > 1) style = ButtonStyle.Success; // Green for effective
    else if (multiplier < 1) style = ButtonStyle.Danger; // Red for resisted
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`duel_target:${i}`)
        .setLabel(`${c.def.character}`)
        .setStyle(style)
        .setDisabled(disabled)
    );
  });
  return row;
}

async function updateDuelMessage(msg, state) {
  const embed = buildEmbed(state);
  const components = [];

  const isPlayer1Turn = state.turn === 'player1';
  const s1Row = makeSelectionRow(state, isPlayer1Turn);
  if (s1Row) components.push(s1Row);

  if (state.awaitingTarget) {
    const tRow = makeTargetRow(state, isPlayer1Turn);
    if (tRow) components.push(tRow);
  } else {
    const aRow = makeActionRow(state, isPlayer1Turn);
    if (aRow) components.push(aRow);
  }

  if (state.finished) {
    components.forEach(r => r.components.forEach(b => b.setDisabled(true)));
    try {
      await msg.edit({ embeds: [embed], components });
    } catch (e) {
      // If the message is gone, attempt to send the final embed
      try { await msg.channel.send({ embeds: [embed], components: [] }); } catch (err) {}
    }
    clearDuelTimeout(state);
    state._lastShownTurn = state.turn;
    return;
  }

  // Determine whether this update should replace the message (turn transition)
  const lastShownTurn = typeof state._lastShownTurn !== 'undefined' ? state._lastShownTurn : null;
  const shouldReplace = (lastShownTurn !== null && lastShownTurn !== state.turn && !state.awaitingTarget);

  // If we should not replace, edit the existing message in-place (preserves component state)
  if (!shouldReplace) {
    try {
      await msg.edit({ embeds: [embed], components });
      state._lastShownTurn = state.turn;
      state.lastMsg = msg;
      setupTimeout(state, msg);
      return;
    } catch (e) {
      // fallthrough to replace behavior
      console.error('Failed to edit duel message in-place, will replace:', e);
    }
  }

  // Replace the message to reset interaction timers when the turn has changed
  try { await msg.edit({ components: [] }); } catch (e) {}
  // record previous message ID so interactions referencing it can still locate the state
  state.messageHistory = state.messageHistory || [];
  try { if (msg && msg.id) state.messageHistory.push(msg.id); } catch (e) {}
  const newMsg = await msg.channel.send({ embeds: [embed], components });
  // Remap the duelStates entry to the new message ID
  duelStates.delete(msg.id);
  duelStates.set(newMsg.id, state);
  state.lastMsg = newMsg;
  state._lastShownTurn = state.turn;
  setupTimeout(state, newMsg);
}

function rechargeEnergy(state) {
  state.player1Cards.forEach(c => {
    const locked = c.status && c.status.some(st => st.type === 'stun' || st.type === 'freeze');
    const gain = c.status && c.status.some(st => st.type === 'blessed') ? 2 : 1;
    if (c.turnsUntilRecharge > 0) {
      c.turnsUntilRecharge--;
    } else if (c.alive && c.energy < 3 && !locked) {
      c.energy = Math.min(3, c.energy + gain);
    }
  });
  state.player2Cards.forEach(c => {
    const locked = c.status && c.status.some(st => st.type === 'stun' || st.type === 'freeze');
    const gain = c.status && c.status.some(st => st.type === 'blessed') ? 2 : 1;
    if (c.turnsUntilRecharge > 0) {
      c.turnsUntilRecharge--;
    } else if (c.alive && c.energy < 3 && !locked) {
      c.energy = Math.min(3, c.energy + gain);
    }
  });
}

function checkTeamDefeated(team) {
  return team.every(c => !c.alive);
}

function clearDuelTimeout(state) {
  if (state.timeout) {
    clearTimeout(state.timeout);
    state.timeout = null;
  }
}

async function endDuelByInactivity(state, msg) {
  if (state.finished) return;
  state.finished = true;
  clearDuelTimeout(state);

  const p1HP = state.player1Cards.reduce((sum, c) => sum + (c.alive ? (c.currentHP || 0) : 0), 0);
  const p2HP = state.player2Cards.reduce((sum, c) => sum + (c.alive ? (c.currentHP || 0) : 0), 0);

  let resultLine;
  if (p1HP > p2HP) {
    resultLine = `${state.discordUser1.username} wins by HP! (${formatAmount(p1HP)} vs ${formatAmount(p2HP)})`;
  } else if (p2HP > p1HP) {
    resultLine = `${state.discordUser2.username} wins by HP! (${formatAmount(p2HP)} vs ${formatAmount(p1HP)})`;
  } else {
    resultLine = `It\'s a draw — both teams have equal HP! (${formatAmount(p1HP)} each)`;
  }

  const inactivityEmbed = new EmbedBuilder()
    .setColor('#FFFFFF')
    .setTitle('Duel Ended — Inactivity')
    .setDescription(`Both players failed to act twice in a row. Duel decided by remaining HP.\n\n${resultLine}`)
    .setAuthor({ name: state.discordUser1.username, iconURL: state.discordUser1.displayAvatarURL() });

  const latestMsg = state.lastMsg || msg;
  try {
    await latestMsg.edit({ embeds: [inactivityEmbed], components: [] });
  } catch (e) {
    try { if (latestMsg && latestMsg.channel) await latestMsg.channel.send({ embeds: [inactivityEmbed] }); } catch {}
  }
  try {
    duelStates.delete(latestMsg.id);
    if (Array.isArray(state.messageHistory)) {
      for (const mid of state.messageHistory) { try { duelStates.delete(mid); } catch {} }
    }
  } catch {}
}

function setupTimeout(state, msg) {
  clearDuelTimeout(state);
  if (!state.finished) {
    state.timeout = setTimeout(async () => {
      try {
        const currentMsg = state.lastMsg || msg;
        if (state.finished) return;
        const timedOutTeam = state.turn === 'player1' ? state.player1Cards : state.player2Cards;
        const timedOutUsername = state.turn === 'player1' ? state.discordUser1.username : state.discordUser2.username;
        // Apply team rest (5% heal) for the timed-out player
        timedOutTeam.forEach(c => {
          if (c.alive) {
            c.currentHP = Math.min(c.maxHP || c.def.health, c.currentHP + Math.floor((c.maxHP || c.def.health) * 0.05));
          }
        });
        const actionText = `${timedOutUsername} took too long — team rested for 5% HP!`;
        if (state.turn === 'player1') state.lastP1Action = actionText;
        else state.lastP2Action = actionText;
        appendLog(state, `${timedOutUsername} took too long. Turn passed.`);
        state.consecutiveTimeouts = (state.consecutiveTimeouts || 0) + 1;
        if (state.consecutiveTimeouts >= 2) {
          try {
            await endDuelByInactivity(state, currentMsg);
          } catch (e) {
            console.error('Inactivity end error:', e);
          }
          return;
        }
        try {
          await finalizeAction(state, currentMsg, true);
        } catch (e) {
          console.error('Timeout error:', e);
        }
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

// Check if a team has any valid moves (at least one unlocked card with energy)
function canTeamAct(team) {
  if (!team || team.length === 0) return false;
  return team.some(c => c.alive && !hasStatusLock(c) && c.energy > 0);
}

async function finalizeAction(state, msg, timedOut = false, appliedCut = false) {
  // Reset consecutive timeout counter whenever a player makes a real move
  if (!timedOut) state.consecutiveTimeouts = 0;

  // Check if player's team is defeated
  const currentTeam = state.turn === 'player1' ? state.player1Cards : state.player2Cards;
  const opponentTeam = state.turn === 'player1' ? state.player2Cards : state.player1Cards;

    if (checkTeamDefeated(currentTeam)) {
    state.finished = true;
    const latestMsg = state.lastMsg || msg;
    const winnerId = state.turn === 'player1' ? state.player2Id : state.player1Id;
    const loserId = state.turn === 'player1' ? state.player1Id : state.player2Id;
    const winner = state.turn === 'player1' ? state.discordUser2 : state.discordUser1;
    const loser = state.turn === 'player1' ? state.discordUser1 : state.discordUser2;
    
    // Load user documents and calculate bounty change
    let winnerUser = await User.findOne({ userId: winnerId });
    let loserUser = await User.findOne({ userId: loserId });
    let bountyGain = 0;
    let awardedBountyGain = 0; // actual awarded amount (subject to eligibility)

    if (winnerUser && loserUser) {
      const winnerBounty = winnerUser.bounty || 100;
      const loserBounty = loserUser.bounty || 100;

      // Only award bounty rewards when the loser's bounty is within ±50% of the winner's bounty
      const rewardsEligibleByBounty = (loserBounty >= Math.floor(winnerBounty * 0.5) && loserBounty <= Math.ceil(winnerBounty * 1.5));

      // Calculate bounty gain based on the rules:
      // If Winner's Bounty >= Loser's Bounty: 0 Bounty gain
      // If Loser's Bounty > Winner's Bounty: Winner gains 3% of the Loser's bounty
      // Cap: If the Loser has > 3x the Winner's bounty, the Winner earns 0 Bounty
      if (loserBounty > winnerBounty) {
        if (loserBounty > winnerBounty * 3) {
          bountyGain = 0; // Cap reached
        } else {
          bountyGain = Math.floor(loserBounty * 0.03);
        }
      }

      if (bountyGain > 0) {
        const winnerAllowed = !state.rewardsAllowed || !!state.rewardsAllowed[winnerId];
        if (winnerAllowed && rewardsEligibleByBounty) {
          awardedBountyGain = bountyGain;
          winnerUser.bounty = (winnerUser.bounty || 100) + awardedBountyGain;
          await winnerUser.save();
          try {
          } catch (err) {
            console.error('Achievement check after duel bounty gain failed', err);
          }
          // Deduct the same amount from the loser
          try {
            if (loserUser) {
              loserUser.bounty = Math.max(0, (loserUser.bounty || 100) - awardedBountyGain);
              await loserUser.save();
            }
          } catch (err) {
            console.error('Failed to deduct bounty from loser after duel:', err);
          }
        }
      }
    }
    
    // Handle bounty rewards
    let xpGain = 0;
    let beliGain = 0;
    let bountyClaimed = 0;
    let awardedBountyClaimed = 0;
    if (state.isBountyDuel && winnerId === state.bountyHunter) {
      const targetBounty = loserUser.bounty || 100;
      xpGain = 0;
      // Bounty duel rewards are granted only when target bounty is within ±50% of hunter's bounty
      const winnerBounty = winnerUser ? (winnerUser.bounty || 100) : 100;
      const rewardsEligibleByBounty_capture = (targetBounty >= Math.floor(winnerBounty * 0.5) && targetBounty <= Math.ceil(winnerBounty * 1.5));
      const winnerAllowed = true;
      if (winnerAllowed && rewardsEligibleByBounty_capture) {
        // Award 5% (1/20) of the target's bounty to the hunter's bounty total
        const bountyGain = Math.floor(targetBounty * 0.05);
        awardedBountyClaimed = bountyGain;
        winnerUser.bounty = (winnerUser.bounty || 100) + bountyGain;
        bountyClaimed = bountyGain;
        // Compute proportional beli reward
        const baseBeli = Math.ceil(targetBounty / 100000);
        // Bounty challenge advertises 2x reward; apply 2x to beli payout
        beliGain = baseBeli * 2;

        winnerUser.balance = (winnerUser.balance || 0) + beliGain;
        winnerUser.activeBountyTarget = null;
        // record last bounty target and set 24h cooldown before claiming a new bounty
        winnerUser.lastBountyTarget = loserId;
        winnerUser.bountyCooldownUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await winnerUser.save();
        // Deduct 2.5% (1/40) of the loser's bounty
        try {
          if (loserUser) {
            const bountyLoss = Math.floor((loserUser.bounty || 100) * 0.025);
            loserUser.bounty = Math.max(100, (loserUser.bounty || 100) - bountyLoss);
            await loserUser.save();
          }
        } catch (err) {
          console.error('Failed to deduct bounty from loser after capture:', err);
        }
        try {
        } catch (err) {
          console.error('Achievement check after bounty capture failed', err);
        }
      }
    } else if (state.isBountyDuel && loserId === state.bountyHunter) {
      // Hunter lost, reset cooldown but keep target
      const hunterUser = await User.findOne({ userId: state.bountyHunter });
      if (hunterUser) {
        hunterUser.bountyCooldownUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await hunterUser.save();
      }
    }

    // Increment daily duel counts for both participants
    try {
      const now = new Date();
      const todayStr = now.toDateString();
      if (winnerUser) {
        if (!winnerUser.dailyDuelsReset || new Date(winnerUser.dailyDuelsReset).toDateString() !== todayStr) {
          winnerUser.dailyDuels = 0;
          winnerUser.dailyDuelsReset = now;
        }
        if ((winnerUser.dailyDuels || 0) < 3) winnerUser.dailyDuels = (winnerUser.dailyDuels || 0) + 1;
        await winnerUser.save();
      }
      if (loserUser) {
        if (!loserUser.dailyDuelsReset || new Date(loserUser.dailyDuelsReset).toDateString() !== todayStr) {
          loserUser.dailyDuels = 0;
          loserUser.dailyDuelsReset = now;
        }
        if ((loserUser.dailyDuels || 0) < 3) loserUser.dailyDuels = (loserUser.dailyDuels || 0) + 1;
        await loserUser.save();
      }
    } catch (err) {
      console.error('Failed to increment daily duel counters:', err);
    }
    
    // Create victory embed with bounty information
    let description = `${winner.username} wins!`;
    if (awardedBountyGain > 0) {
      description += `\n\nBounty Gained: **${formatAmount(awardedBountyGain)}**`;
    }
    if (awardedBountyClaimed > 0) {
      description += `\n\nBounty Claimed: **${formatAmount(awardedBountyClaimed)}**`;
    }
    if (beliGain > 0) {
      description += `\n\nBeli Earned: ¥**${formatAmount(beliGain)}**`;
    }
    
    const victorEmbed = new EmbedBuilder()
      .setColor('#FFFFFF')
      .setTitle('Duel Victory!')
      .setDescription(description)
      .setAuthor({ name: state.discordUser1.username, iconURL: state.discordUser1.displayAvatarURL() });
    
    clearDuelTimeout(state);
    try {
      await latestMsg.edit({ embeds: [victorEmbed], components: [] });
    } catch (e) {
      try { await (latestMsg && latestMsg.channel ? latestMsg.channel.send({ embeds: [victorEmbed] }) : null); } catch {}
    }
    try {
      duelStates.delete(latestMsg.id);
      if (Array.isArray(state.messageHistory)) {
        for (const mid of state.messageHistory) {
          try { duelStates.delete(mid); } catch (e) {}
        }
      }
    } catch (e) {}
  } else {
    // Recharge and switch turn
    rechargeEnergy(state);
    state.turn = state.turn === 'player1' ? 'player2' : 'player1';
    state.selected = null;
    state.lastP1Action = state.lastP1Action || '';
    state.lastP2Action = state.lastP2Action || '';
    // do not clear log here – we want current log entries to show on the
    // upcoming embed (especially status messages or skip notices)
    state.embedImage = null; // Clear special attack gif
    state.gifMessageId = null; // Clear special attack gif message

    // Apply start-of-turn effects to ALL cards (both teams) unless already applied
    if (!appliedCut) applyGlobalCut(state);

    // Check if opponent's team is already defeated BEFORE updating the embed
    // so the victory embed replaces the battle embed directly (no "All cards defeated!" flash)
    if (checkTeamDefeated(state.turn === 'player1' ? state.player1Cards : state.player2Cards)) {
      state.finished = true;
      const winnerId = state.turn === 'player1' ? state.player2Id : state.player1Id;
      const loserId = state.turn === 'player1' ? state.player1Id : state.player2Id;
      const winner = state.turn === 'player1' ? state.discordUser2 : state.discordUser1;
      
      // Load user documents and calculate bounty change
      let winnerUser = await User.findOne({ userId: winnerId });
      let loserUser = await User.findOne({ userId: loserId });
      let bountyGain = 0;
      let awardedBountyGain = 0;
      let bountyClaimed = 0;
      let awardedBountyClaimed = 0;
      let beliGain = 0;

      if (winnerUser && loserUser) {
        const winnerBounty = winnerUser.bounty || 100;
        const loserBounty = loserUser.bounty || 100;

        // Eligibility check: only award when loser's bounty is within ±50% of winner's bounty
        const rewardsEligibleByBounty = (loserBounty >= Math.floor(winnerBounty * 0.5) && loserBounty <= Math.ceil(winnerBounty * 1.5));

        // Calculate bounty gain based on the rules (non-bounty-capture case)
        if (loserBounty > winnerBounty) {
          if (loserBounty > winnerBounty * 3) {
            bountyGain = 0; // Cap reached
          } else {
            bountyGain = Math.floor(loserBounty * 0.03);
          }
        }

        if (bountyGain > 0) {
          const winnerAllowed = !state.rewardsAllowed || !!state.rewardsAllowed[winnerId];
          if (winnerAllowed && rewardsEligibleByBounty) {
            awardedBountyGain = bountyGain;
            winnerUser.bounty = (winnerUser.bounty || 100) + awardedBountyGain;
            await winnerUser.save();
            try {
            } catch (err) {
              console.error('Achievement check after duel bounty gain failed', err);
            }
            // Deduct the same amount from the loser
            try {
              if (loserUser) {
                loserUser.bounty = Math.max(0, (loserUser.bounty || 100) - awardedBountyGain);
                await loserUser.save();
              }
            } catch (err) {
              console.error('Failed to deduct bounty from loser after duel:', err);
            }
          }
        }

        // Handle bounty duel where hunter captured their target
        if (state.isBountyDuel && winnerId === state.bountyHunter) {
          const targetBounty = loserUser.bounty || 100;
          const winnerBountyLocal = winnerUser.bounty || 100;
          const rewardsEligibleByBounty_capture = (targetBounty >= Math.floor(winnerBountyLocal * 0.5) && targetBounty <= Math.ceil(winnerBountyLocal * 1.5));
          const winnerAllowed = !state.rewardsAllowed || !!state.rewardsAllowed[winnerId];
          if (winnerAllowed && rewardsEligibleByBounty_capture) {
            const bountyGainCaptured = Math.floor(targetBounty * 0.05);
            awardedBountyClaimed = bountyGainCaptured;
            bountyClaimed = bountyGainCaptured;
            // Award 5% (1/20) of the target's bounty to the hunter's bounty
            winnerUser.bounty = (winnerUser.bounty || 100) + bountyGainCaptured;
            // proportional beli reward
            const baseBeli = Math.ceil(targetBounty / 100000);
            beliGain = baseBeli * 2; // 2x reward for bounty claim
            winnerUser.balance = (winnerUser.balance || 0) + beliGain;
            winnerUser.activeBountyTarget = null;
            winnerUser.lastBountyTarget = loserId;
            winnerUser.bountyCooldownUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
            await winnerUser.save();
            // Deduct 2.5% (1/40) of the loser's bounty
            try {
              if (loserUser) {
                const bountyLoss = Math.floor((loserUser.bounty || 100) * 0.025);
                loserUser.bounty = Math.max(100, (loserUser.bounty || 100) - bountyLoss);
                await loserUser.save();
              }
            } catch (err) {
              console.error('Failed to deduct loser bounty after capture:', err);
            }
            try {
            } catch (err) {
              console.error('Achievement check after bounty capture failed', err);
            }
          }
        } else if (state.isBountyDuel && loserId === state.bountyHunter) {
          // Hunter lost, reset cooldown but keep target
          const hunterUser = await User.findOne({ userId: state.bountyHunter });
          if (hunterUser) {
            hunterUser.bountyCooldownUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
            await hunterUser.save();
          }
        }
      }

      // Increment daily duel counters for both players
      try {
        const now = new Date();
        const todayStr = now.toDateString();
        if (winnerUser) {
          if (!winnerUser.dailyDuelsReset || new Date(winnerUser.dailyDuelsReset).toDateString() !== todayStr) {
            winnerUser.dailyDuels = 0;
            winnerUser.dailyDuelsReset = now;
          }
          if ((winnerUser.dailyDuels || 0) < 3) winnerUser.dailyDuels = (winnerUser.dailyDuels || 0) + 1;
          await winnerUser.save();
        }
        if (loserUser) {
          if (!loserUser.dailyDuelsReset || new Date(loserUser.dailyDuelsReset).toDateString() !== todayStr) {
            loserUser.dailyDuels = 0;
            loserUser.dailyDuelsReset = now;
          }
          if ((loserUser.dailyDuels || 0) < 3) loserUser.dailyDuels = (loserUser.dailyDuels || 0) + 1;
          await loserUser.save();
        }
      } catch (err) {
        console.error('Failed to increment daily duel counters:', err);
      }

      // Create victory embed with bounty information
      let description = `${winner.username} wins!`;
      if (awardedBountyGain > 0) {
        description += `\n\nBounty Gained: **${formatAmount(awardedBountyGain)}**`;
      }
      if (awardedBountyClaimed > 0) {
        description += `\n\nBounty Claimed: **${formatAmount(awardedBountyClaimed)}**`;
      }
      if (beliGain > 0) {
        description += `\n\nBeli Earned: ¥**${formatAmount(beliGain)}**`;
      }
      const victorEmbed = new EmbedBuilder()
        .setColor('#FFFFFF')
        .setTitle('Duel Victory!')
        .setDescription(description)
        .setAuthor({ name: state.discordUser1.username, iconURL: state.discordUser1.displayAvatarURL() });

      clearDuelTimeout(state);
      const latestMsg = state.lastMsg || msg;
      try {
        await latestMsg.edit({ embeds: [victorEmbed], components: [] });
      } catch (e) {
        try { await latestMsg.channel.send({ embeds: [victorEmbed] }); } catch {}
      }
      duelStates.delete(latestMsg.id);
      return;
    }

    // Check if current player can act; if not, automatically skip their turn
    const activeTeam = state.turn === 'player1' ? state.player1Cards : state.player2Cards;
    if (!canTeamAct(activeTeam)) {
      appendLog(state, `${state.turn === 'player1' ? state.discordUser1.username : state.discordUser2.username} has no valid moves. Turn skipped.`);
      return finalizeAction(state, msg, false, true);
    }

    // Edit the existing message in place so the interaction's original message
    // is never deleted mid-duel (deletion causes "This interaction failed" on
    // the deferred component interaction even though the defer was acknowledged).
    const latestMsg2 = state.lastMsg || msg;
    await updateDuelMessage(latestMsg2, state);
    // clear log now that we have shown it on the latest embed
    state.log = '';
  }
}

function clearUserState(userId) {
  for (const [msgId, state] of duelStates) {
    if (state.player1Id === userId || state.player2Id === userId) {
      duelStates.delete(msgId);
    }
  }
  for (const [msgId, pending] of pendingDuelRequests) {
    if (pending.player1Id === userId || pending.player2Id === userId) {
      pendingDuelRequests.delete(msgId);
    }
  }
}

// Start a STRAT draft session: players take turns picking cards into their duel teams
async function startStratDraft(pending, interaction) {
  const startingPlayer = pending.p1Speed >= pending.p2Speed ? 'player1' : 'player2';
  const firstPicker = startingPlayer === 'player1' ? 'player2' : 'player1';
  const other = firstPicker === 'player1' ? 'player2' : 'player1';
  const pickOrder = [firstPicker, other, firstPicker, other, firstPicker, other];

  const draftState = {
    pending,
    pickOrder,
    currentPick: 0,
    picks: { player1: [], player2: [] }
  };

  // honor optional rank restriction for rank-drafts
  if (pending && pending.rankRestriction) draftState.rankRestriction = pending.rankRestriction;

  const nextPicker = draftState.pickOrder[0];
  const nextName = nextPicker === 'player1' ? pending.discordUser1.username : pending.discordUser2.username;
  const p1Names = 'None';
  const p2Names = 'None';
  const embed = new EmbedBuilder()
    .setColor('#FFFFFF')
    .setTitle('STRAT Duel | Draft')
    .setDescription(`Players pick a card one at a time.\n\n**${nextName}'s turn to pick.**\n\n**${pending.discordUser1.username}'s team:**\n${p1Names}\n\n**${pending.discordUser2.username}'s team:**\n${p2Names}`);

  // single add button that opens a modal for the picker
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`duel_strat_add:${nextPicker}`)
      .setLabel('add a card')
      .setStyle(ButtonStyle.Secondary)
  );

  // send draft message and set a 90s inactivity timeout
  const draftMsg = await interaction.channel.send({ embeds: [embed], components: [row] });
  draftState.messageId = draftMsg.id;
  stratDrafts.set(draftMsg.id, draftState);
  // 90 second timeout for drafts
  draftState.timeout = setTimeout(async () => {
    const expired = new EmbedBuilder()
      .setColor('#FFFFFF')
      .setTitle('STRAT Duel | Draft')
      .setDescription(`Players pick a card one at a time.\n\n**${nextName}'s turn to pick.**\n\n**${pending.discordUser1.username}'s team:**\n${p1Names}\n\n**${pending.discordUser2.username}'s team:**\n${p2Names}` + (draftState.rankRestriction ? `\n\nAllowed Rank: **${draftState.rankRestriction}**` : ''))
      .setFooter({ text: 'Expired' });
    try {
      const msg = await interaction.channel.messages.fetch(draftState.messageId).catch(() => null);
      if (msg) await msg.edit({ embeds: [expired], components: [] }).catch(() => {});
    } catch (e) {
      // ignore errors while expiring the draft
    }
    try { stratDrafts.delete(draftState.messageId); } catch (e) {}
  }, 90 * 1000);

}

  // Handle duel-type select menu (challenger changes duel type)
  async function handleSelect(interaction) {
    const msgId = interaction.message.id;
    const pending = pendingDuelRequests.get(msgId);
    if (!pending) return interaction.reply({ content: 'This duel request has expired.', ephemeral: true });
    // Only the challenger (player1) may change the duel type
    if (interaction.user.id !== pending.player1Id) return interaction.reply({ content: 'Only the challenger can change the duel type.', ephemeral: true });
    const val = interaction.values && interaction.values[0];

    if (val === 'rank') {
      // Transition embed: remove Accept/Decline buttons, show rank dropdown
      const embed = EmbedBuilder.from ? EmbedBuilder.from(interaction.message.embeds[0] || {}) : new EmbedBuilder().setDescription(interaction.message.embeds[0]?.description || '');
      embed.setFooter({ text: 'RANK Duel — select a rank to restrict the draft:' });
      const rankSelectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('duel_rank_select')
          .setPlaceholder('Choose a rank')
          .addOptions([
            { label: 'D', value: 'D', description: 'D rank cards only' },
            { label: 'C', value: 'C', description: 'C rank cards only' },
            { label: 'B', value: 'B', description: 'B rank cards only' },
            { label: 'A', value: 'A', description: 'A rank cards only' },
            { label: 'S', value: 'S', description: 'S rank cards only' },
            { label: 'SS', value: 'SS', description: 'SS rank cards only' },
            { label: 'UR', value: 'UR', description: 'UR rank cards only' }
          ])
      );
      try { await interaction.update({ embeds: [embed], components: [rankSelectRow] }); } catch (e) { try { await interaction.followUp({ embeds: [embed], components: [rankSelectRow] }); } catch {} }
      return;
    }

    // STRAT selected
    pending.duelType = 'strat';
    const embed = EmbedBuilder.from ? EmbedBuilder.from(interaction.message.embeds[0] || {}) : new EmbedBuilder().setDescription(interaction.message.embeds[0]?.description || '');
    embed.setFooter({ text: 'Duel type: STRAT (Draft)' });
    try { await interaction.update({ embeds: [embed] }); } catch (e) { try { await interaction.followUp({ embeds: [embed] }); } catch {} }
  }

  // Handle rank dropdown selection (starts rank draft directly)
  async function handleRankSelect(interaction) {
    const msgId = interaction.message.id;
    const pending = pendingDuelRequests.get(msgId);
    if (!pending) return interaction.reply({ content: 'This duel request has expired.', ephemeral: true });
    if (interaction.user.id !== pending.player1Id) return interaction.reply({ content: 'Only the challenger can select the rank.', ephemeral: true });

    const rawRank = (interaction.values && interaction.values[0] || '').toUpperCase();
    const VALID = ['D', 'C', 'B', 'A', 'S', 'SS', 'UR'];
    if (!VALID.includes(rawRank)) return interaction.reply({ content: 'Invalid rank. Use one of: D, C, B, A, S, SS, UR', ephemeral: true });

    pending.duelType = 'strat';
    pending.rankRestriction = rawRank;

    // Acknowledge the interaction first, then delete the challenge message
    try { await interaction.deferUpdate(); } catch (e) {}
    try { await interaction.message.delete(); } catch {}

    await startStratDraft(pending, interaction);
    pendingDuelRequests.delete(msgId);
  }

// Handle modal submit for STRAT draft picks
async function handleStratModalSubmit(interaction) {
  const parts = interaction.customId.split(':');
  const msgId = parts[1];
  const expectedIdx = parseInt(parts[2], 10);
  const draft = stratDrafts.get(msgId);
  if (!draft) return interaction.reply({ content: 'This draft session has expired.', ephemeral: true });
  if (isNaN(expectedIdx) || expectedIdx !== draft.currentPick) {
    return interaction.reply({ content: 'This pick is no longer valid.', ephemeral: true });
  }

  const cardQuery = (interaction.fields.getTextInputValue('card_input') || '').trim();
  if (!cardQuery) return interaction.reply({ content: 'No card specified.', ephemeral: true });

  const expected = draft.pickOrder[draft.currentPick];
  let pool = expected === 'player1' ? draft.pending.player1Cards : draft.pending.player2Cards;
  // If this is a rank-restricted draft, limit available picks to that rank
  if (draft.rankRestriction) {
    pool = pool.filter(p => (p.def && (p.def.rank || p.rank) ? (p.def.rank || p.rank) : '').toUpperCase() === String(draft.rankRestriction).toUpperCase());
    if (!pool || pool.length === 0) return interaction.reply({ content: `You have no cards of rank **${draft.rankRestriction}** to pick.`, ephemeral: true });
  }
  const allowedUserId = expected === 'player1' ? draft.pending.player1Id : draft.pending.player2Id;
  if (interaction.user.id !== allowedUserId) return interaction.reply({ content: 'It is not your pick.', ephemeral: true });
  let chosen = await findCardInPoolByQuery(cardQuery, allowedUserId, pool);
  // Safety: ensure the chosen card actually belongs to the picker's pool/team
  if (!chosen || !pool.some(p => normalizeCardId(p.def.id) === normalizeCardId(chosen.def.id))) {
    return interaction.reply({ content: 'That card is not in your team. Pick a card from your team only.', ephemeral: true });
  }
  if (!chosen) return interaction.reply({ content: 'No matching card found in your team. Type the character name or ID from your team.', ephemeral: true });

  // Prevent duplicate picks within the same player's selections
  if (draft.picks[expected].find(c => c.def.id === chosen.def.id)) {
    return interaction.reply({ content: 'You have already picked that card.', ephemeral: true });
  }

  draft.picks[expected].push(chosen);
  draft.currentPick += 1;

  // Clear previous inactivity timeout and set a fresh one if needed
  if (draft.timeout) try { clearTimeout(draft.timeout); } catch (e) {}

  const nextPicker = draft.currentPick < draft.pickOrder.length ? draft.pickOrder[draft.currentPick] : null;
  const nextName = nextPicker ? (nextPicker === 'player1' ? draft.pending.discordUser1.username : draft.pending.discordUser2.username) : null;
  const p1Names = draft.picks.player1.map(c => `${c.def.emoji || ''} ${c.def.character}`).join('\n') || 'None';
  const p2Names = draft.picks.player2.map(c => `${c.def.emoji || ''} ${c.def.character}`).join('\n') || 'None';
  const embed = new EmbedBuilder()
    .setColor('#FFFFFF')
    .setTitle('STRAT Duel | Draft')
    .setDescription(`Players pick a card one at a time.\n\n**${nextName ? `${nextName}'s turn to pick.` : 'Draft complete.'}**\n\n**${draft.pending.discordUser1.username}'s team:**\n${p1Names}\n\n**${draft.pending.discordUser2.username}'s team:**\n${p2Names}`);

  // If drafting complete, start the duel
  if (!nextPicker) {
    stratDrafts.delete(msgId);
    try { await interaction.channel.messages.fetch(msgId).then(m => m.delete()).catch(() => {}); } catch (e) {}

    const pending = draft.pending;
    const startingPlayer = pending.p1Speed >= pending.p2Speed ? 'player1' : 'player2';
    const rewardsAllowedMap = {};
    const p1User = await User.findOne({ userId: pending.player1Id });
    const p2User = await User.findOne({ userId: pending.player2Id });
    rewardsAllowedMap[pending.player1Id] = !(p1User && (p1User.dailyDuels || 0) >= 3);
    rewardsAllowedMap[pending.player2Id] = !(p2User && (p2User.dailyDuels || 0) >= 3);

    const state = {
      player1Id: pending.player1Id,
      player2Id: pending.player2Id,
      player1Cards: draft.picks.player1,
      player2Cards: draft.picks.player2,
      turn: startingPlayer,
      startingPlayer: startingPlayer,
      selected: null,
      awaitingTarget: null,
      finished: false,
      log: '',
      lastP1Action: '',
      lastP2Action: '',
      timeout: null,
      embedImage: null,
      gifMessageId: null,
      discordUser1: pending.discordUser1,
      discordUser2: pending.discordUser2,
      isBountyDuel: false,
      bountyHunter: null,
      rewardsAllowed: rewardsAllowedMap,
      messageHistory: []
    };
    applyGlobalCut(state);
    appendLog(state, `${state.startingPlayer === 'player1' ? state.discordUser1.username : state.discordUser2.username} goes first!`);
    const battleEmbed = buildEmbed(state);
    const row = makeSelectionRow(state, state.turn === 'player1');
    const battleMsg = await interaction.channel.send({ embeds: [battleEmbed], components: [row] });
    state.lastMsg = battleMsg;
    duelStates.set(battleMsg.id, state);
    await setupTimeout(state, battleMsg);
    // respond to modal submit
    try { await interaction.reply({ content: `Picked ${chosen.def.character}`, ephemeral: true }); } catch (e) {}
    return;
  }

  // Otherwise update draft message to show next pick and reset timeout
  const nextOwner = nextPicker;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`duel_strat_add:${nextOwner}`)
      .setLabel('add a card')
      .setStyle(ButtonStyle.Secondary)
  );
  try {
    const draftMsg = await interaction.channel.messages.fetch(msgId).catch(() => null);
    if (draftMsg) await draftMsg.edit({ embeds: [embed], components: [row] });
  } catch (e) {
    console.error('Failed to update draft message after pick:', e);
  }

  // schedule new inactivity timeout
  draft.timeout = setTimeout(async () => {
    try {
      const expired = new EmbedBuilder()
        .setColor('#FFFFFF')
        .setTitle('STRAT Duel | Draft')
        .setDescription(`${draft.pending.discordUser1.username} vs ${draft.pending.discordUser2.username}\n\nDraft timed out due to inactivity.`);
      await interaction.channel.messages.fetch(msgId).then(m => m.edit({ embeds: [expired], components: [] })).catch(() => {});
    } catch (e) {}
    stratDrafts.delete(msgId);
  }, 90 * 1000);

  try { await interaction.reply({ content: `Picked ${chosen.def.character}`, ephemeral: true }); } catch (e) {}
}

// Handle Rank Draft modal submit (choose rank to restrict the draft)
async function handleRankDraftModalSubmit(interaction) {
  const parts = interaction.customId.split(':');
  const msgId = parts[1];
  const pending = pendingDuelRequests.get(msgId);
  if (!pending) return interaction.reply({ content: 'This duel request has expired.', ephemeral: true });
  if (interaction.user.id !== pending.player2Id) return interaction.reply({ content: 'Only the challenged player can start a Rank Draft.', ephemeral: true });

  const rawRank = (interaction.fields.getTextInputValue('rank_input') || '').trim().toUpperCase();
  const VALID = new Set(['D','C','B','A','S','SS','UR']);
  if (!VALID.has(rawRank)) {
    return interaction.reply({ content: 'Invalid rank. Use one of: D, C, B, A, S, SS, UR', ephemeral: true });
  }

  // configure pending to perform a STRAT draft limited to this rank
  pending.duelType = 'strat';
  pending.rankRestriction = rawRank;

  // remove the accept message and start the strat draft
  try { await interaction.channel.messages.fetch(msgId).then(m => m.delete()).catch(() => {}); } catch (e) {}
  try { await startStratDraft(pending, interaction); } catch (e) { console.error('Failed to start Rank Draft:', e); }
  pendingDuelRequests.delete(msgId);
  try { await interaction.reply({ content: `Started Rank Draft (${rawRank})`, ephemeral: true }); } catch (e) {}
}

module.exports = {
  name: 'duel',
  description: 'Duel another player',
  options: [
    { name: 'opponent', type: 6, description: 'The player to duel', required: true }
  ],
  clearUserState,
  duelStates,
  handleSelect,
  handleRankSelect,
  handleStratModalSubmit,
  handleRankDraftModalSubmit,
  async execute({ message, interaction, args }) {
    const userId = message ? message.author.id : interaction.user.id;
    let user1 = await User.findOne({ userId });
    if (!user1) {
      const reply = 'You need an account first – run `op start` or /start.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // Get opponent — support flags in message-mode: `draft` or a rank token (e.g. 'UR', 'SS')
    let opponentId;
    let forcedMode = null; // 'strat' when draft/rank enforced
    let forcedRank = null;
    if (message) {
      const rawArgs = Array.isArray(args) ? args.slice() : [];
      const low = rawArgs.map(a => String(a).toLowerCase());
      // detect explicit 'draft' or 'strat' flag
      const idxDraft = low.findIndex(a => a === 'draft' || a === 'strat');
      if (idxDraft !== -1) {
        forcedMode = 'strat';
        rawArgs.splice(idxDraft, 1);
      }
      // detect rank token anywhere
      const RANKS = ['d','c','b','a','s','ss','ur'];
      const idxRank = low.findIndex(a => RANKS.includes(a));
      if (idxRank !== -1) {
        forcedMode = 'strat';
        forcedRank = String(rawArgs[idxRank]).toUpperCase();
        rawArgs.splice(idxRank, 1);
      }

      const mentionMatch = message.mentions.users.first();
      if (mentionMatch) opponentId = mentionMatch.id;
      else opponentId = rawArgs[0]?.match(/(\d{17,19})/)?.[1] || null;
      // fallback: if first arg was numeric in original args
      if (!opponentId && args && args.length) opponentId = args[0]?.match(/(\d{17,19})/)?.[1] || null;
      // persist forcedMode/rank to `args` for later usage when building pending state
      if (forcedMode) args = rawArgs;
    } else {
      opponentId = interaction.options.getUser('opponent').id;
    }

    if (!opponentId) {
      const reply = 'Please specify an opponent.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    let user2 = await User.findOne({ userId: opponentId });
    if (!user2) {
      const reply = 'That user doesn\'t have an account.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    if (opponentId === userId) {
      const reply = 'You cannot duel yourself.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // Ensure daily counters are reset when necessary (do not block duels after limit)
    try {
      const now = new Date();
      const todayStr = now.toDateString();
      if (!user1.dailyDuelsReset || new Date(user1.dailyDuelsReset).toDateString() !== todayStr) {
        user1.dailyDuels = 0;
        user1.dailyDuelsReset = now;
        await user1.save();
      }

      if (!user2.dailyDuelsReset || new Date(user2.dailyDuelsReset).toDateString() !== todayStr) {
        user2.dailyDuels = 0;
        user2.dailyDuelsReset = now;
        await user2.save();
      }
    } catch (err) {
      console.error('Failed to check daily duel limits:', err);
    }

    // Check if either player is already in an active duel
    for (const [_, state] of duelStates) {
      if (!state.finished && (state.player1Id === userId || state.player2Id === userId || state.player1Id === opponentId || state.player2Id === opponentId)) {
        const reply = 'One or both players are already in an active duel.';
        if (message) return message.reply(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }
    }

    // Check if there's already a pending duel request between these players
    for (const [_, pending] of pendingDuelRequests) {
      if ((pending.player1Id === userId && pending.player2Id === opponentId) || (pending.player1Id === opponentId && pending.player2Id === userId)) {
        const reply = 'There is already a pending duel request between you and this player.';
        if (message) return message.reply(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }
    }

    // Get user objects for discord
    const discordUser1 = message ? message.author : interaction.user;
    const discordUser2 = await (message ? message.client.users.fetch(opponentId) : interaction.client.users.fetch(opponentId));

    // Check both have at least 1 card on their team
    if (!Array.isArray(user1.team) || user1.team.length === 0) {
      const reply = 'Your team must have at least 1 card.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    if (!Array.isArray(user2.team) || user2.team.length === 0) {
      const opponent2Username = discordUser2?.username || 'That user';
      const reply = `${opponent2Username} must have at least 1 card on their team.`;
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // Resolve teams with stats
    const resolveTeam = (user, teamIds) => {
      return teamIds.slice(0, 3).map(id => {
        const def = cardDefs.find(c => c.id === id);
        if (!def) return null;
        const entry = (user.ownedCards || []).find(e => e.cardId === id) || { cardId: id, level: 1, xp: 0 };
        const scaled = resolveStats(entry, user.ownedCards || []);
        return {
          def,
          userEntry: entry,
          scaled: scaled || {
            health: def.health,
            power: def.power,
            speed: def.speed,
            attack_min: def.attack_min,
            attack_max: def.attack_max,
            special_attack: def.special_attack ? { min: def.special_attack.min_atk || def.special_attack.min, max: def.special_attack.max_atk || def.special_attack.max } : undefined
          },
          currentHP: (scaled && scaled.health) || def.health,
          maxHP: (scaled && scaled.health) || def.health,
          energy: 3,
          alive: true,
          turnsUntilRecharge: 0,
          status: []
        };
      }).filter(Boolean);
    };

    const p1Team = resolveTeam(user1, user1.team);
    const p2Team = resolveTeam(user2, user2.team);

    if (p1Team.length < 1 || p2Team.length < 1) {
      const reply = 'Duel requires at least 1 valid card per player.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // Determine who goes first BY CARD SPEED, not who initiated
    const p1Speed = Math.max(...p1Team.map(c => c.def.speed || 0));
    const p2Speed = Math.max(...p2Team.map(c => c.def.speed || 0));
    
    // Swap if p2 is faster (so player 1 always has higher speed)
    let team1 = p1Team, team2 = p2Team, user1Id = userId, user2Id = opponentId, disc1 = discordUser1, disc2 = discordUser2, speed1 = p1Speed, speed2 = p2Speed;
    if (p2Speed > p1Speed) {
      team1 = p2Team;
      team2 = p1Team;
      user1Id = opponentId;
      user2Id = userId;
      disc1 = discordUser2;
      disc2 = discordUser1;
      speed1 = p2Speed;
      speed2 = p1Speed;
    }

    // If forcedMode, skip challenge embed and go directly to draft
    if (forcedMode === 'strat') {
      const pendingState = {
        player1Id: userId,
        player2Id: opponentId,
        player1Cards: p1Team,
        player2Cards: p2Team,
        p1Speed: p1Speed,
        p2Speed: p2Speed,
        discordUser1: discordUser1,
        discordUser2: discordUser2,
        duelType: 'strat'
      };
      if (forcedRank) pendingState.rankRestriction = forcedRank;
      const channelRef = message ? message.channel : interaction.channel;
      await startStratDraft(pendingState, { channel: channelRef });
      if (message) return;
      return;
    }

    // Send acceptance message
    const crews = require('../data/crews');
    const challengerTeamLines = p1Team.map(c => {
      let emoji = c.def.emoji || '•';
      // For ships, prefer faculty icon if available
      if (!emoji || emoji === '•') {
        if (c.def.ship && c.def.faculty) {
          const crew = crews.find(cr => cr.name === c.def.faculty);
          if (crew && crew.icon) emoji = crew.icon;
        }
      }
      return `${emoji} ${c.def.character} (${c.def.rank})`;
    }).join('\n');
    const starterUser = disc1.username; // disc1 has higher speed
    const acceptEmbed = new EmbedBuilder()
      .setColor('#FFFFFF')
      .setDescription(`** <:bounty:1490738541448400976> ${discordUser1.username} challenged you to a duel! **\n\n${discordUser1.username}'s team \n ${challengerTeamLines}\n\n-# ${starterUser} would start this duel first.`);
    
    const acceptRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('duel_accept:accept')
          .setLabel('Accept')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('<:accept:1489632023600697454>'),
        new ButtonBuilder()
          .setCustomId('duel_accept:decline')
          .setLabel('Decline')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('<:decline:1489632232942342154>')
      );
    const typeSelectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('duel_type')
        .setPlaceholder('Select duel type')
        .addOptions([
          { label: 'STRAT Duel', value: 'strat', description: 'Drafting duel — pick cards before start' },
          { label: 'RANK Duel', value: 'rank', description: 'Draft restricted to a specific rank' }
        ])
    );
    
    const componentsToSend = [acceptRow];
    // If challenger pre-specified a duel type (draft or rank), skip the type selector
    if (!forcedMode) componentsToSend.push(typeSelectRow);
    let acceptMsg;
    if (message) {
      acceptMsg = await message.channel.send({ embeds: [acceptEmbed], components: componentsToSend });
    } else {
      acceptMsg = await interaction.reply({ embeds: [acceptEmbed], components: componentsToSend, fetchReply: true });
    }
    
    // Store pending duel request temporarily
    const pendingState = {
      player1Id: userId, // Challenger (who initiated the duel)
      player2Id: opponentId, // Opponent (who was challenged)
      player1Cards: p1Team, // Challenger's team
      player2Cards: p2Team, // Opponent's team
      p1Speed: p1Speed,
      p2Speed: p2Speed,
      discordUser1: discordUser1,
      discordUser2: discordUser2,
      duelType: 'strat' // default to STRAT (no casual option)
    };
    // apply any forced modes (draft or rank) requested by the challenger
    if (forcedMode) pendingState.duelType = forcedMode;
    if (forcedRank) pendingState.rankRestriction = forcedRank;
    pendingDuelRequests.set(acceptMsg.id, pendingState);
    // Expire after 5 minutes
    // setTimeout(() => pendingDuelRequests.delete(acceptMsg.id), 5 * 60 * 1000);
  },

  async handleButton(interaction, rawAction, cardId) {
    const msgId = interaction.message.id;
    
    // Open Rank Draft modal (challenged player chooses rank)
    if (rawAction === 'duel_rankdraft') {
      const pending = pendingDuelRequests.get(msgId);
      if (!pending) return interaction.reply({ content: 'This duel request has expired.', ephemeral: true });
      if (interaction.user.id !== pending.player2Id) return interaction.reply({ content: 'Only the challenged player can start a Rank Draft.', ephemeral: true });
      try {
        const modal = new ModalBuilder()
          .setCustomId(`duel_rank_modal:${msgId}`)
          .setTitle('Rank Draft — Enter Rank');
        const input = new TextInputBuilder()
          .setCustomId('rank_input')
          .setLabel('Rank (D, C, B, A, S, SS, UR)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('e.g. UR');
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
      } catch (e) {
        console.error('Failed to show Rank Draft modal:', e);
        return interaction.reply({ content: 'Failed to open Rank Draft form.', ephemeral: true });
      }
      return;
    }

    // Handle accept/decline actions
    if (rawAction === 'duel_accept') {
      const pending = pendingDuelRequests.get(msgId);
      if (!pending) {
        return interaction.reply({ content: 'This duel request has expired.', ephemeral: true });
      }
      
      // Check if the challenger is trying to accept their own challenge
      if (interaction.user.id === pending.player1Id) {
        return interaction.reply({ content: 'You cannot accept your own challenge. Waiting for your opponent...', ephemeral: true });
      }
      
      // Only the challenged player (player2) can respond
      if (interaction.user.id !== pending.player2Id) {
        return interaction.reply({ content: 'Only the challenged player can respond to this duel request.', ephemeral: true });
      }
      
      if (cardId === 'decline') {
        try { await interaction.message.delete(); } catch {}
        pendingDuelRequests.delete(msgId);
        return interaction.reply({ content: 'Duel request declined.' });
      }
      
      if (cardId === 'accept') {
        // Acknowledge immediately — Discord requires a response within 3 seconds.
        // The DB lookups below can exceed that window without this early defer.
        await safeDefer(interaction);

        // Check if either player already has an active duel
        let alreadyDueling = false;
        for (const [_, state] of duelStates) {
          if (!state.finished && (state.player1Id === pending.player1Id || state.player1Id === pending.player2Id || state.player2Id === pending.player1Id || state.player2Id === pending.player2Id)) {
            alreadyDueling = true;
            break;
          }
        }
        
        if (alreadyDueling) {
          return interaction.followUp({ content: 'One or both players are already in an active duel.', ephemeral: true });
        }
        
        // Check for bounty duel
        let isBountyDuel = false;
        let bountyHunter = null;
        const p1User = await User.findOne({ userId: pending.player1Id });
        const p2User = await User.findOne({ userId: pending.player2Id });
        // Ensure daily counters are fresh, but do not block acceptance; we'll record reward eligibility below
        try {
          const now = new Date();
          const todayStr = now.toDateString();
          if (p1User) {
            if (!p1User.dailyDuelsReset || new Date(p1User.dailyDuelsReset).toDateString() !== todayStr) {
              p1User.dailyDuels = 0;
              p1User.dailyDuelsReset = now;
              await p1User.save();
            }
          }
          if (p2User) {
            if (!p2User.dailyDuelsReset || new Date(p2User.dailyDuelsReset).toDateString() !== todayStr) {
              p2User.dailyDuels = 0;
              p2User.dailyDuelsReset = now;
              await p2User.save();
            }
          }
        } catch (err) {
          console.error('Failed to enforce daily duel limits on accept:', err);
        }
        if (p1User && p1User.activeBountyTarget === pending.player2Id) {
          isBountyDuel = true;
          bountyHunter = pending.player1Id;
        } else if (p2User && p2User.activeBountyTarget === pending.player1Id) {
          isBountyDuel = true;
          bountyHunter = pending.player2Id;
        }
        
        // If this is a STRAT duel, begin drafting phase instead of starting immediately
        if (pending.duelType === 'strat') {
          try { await interaction.message.delete(); } catch {}
          await startStratDraft(pending, interaction);
          pendingDuelRequests.delete(msgId);
          return;
        }

        // Start the duel
        const rewardsAllowedMap = {};
        rewardsAllowedMap[pending.player1Id] = !(p1User && (p1User.dailyDuels || 0) >= 3);
        rewardsAllowedMap[pending.player2Id] = !(p2User && (p2User.dailyDuels || 0) >= 3);
        const state = {
          player1Id: pending.player1Id,
          player2Id: pending.player2Id,
          player1Cards: pending.player1Cards,
          player2Cards: pending.player2Cards,
          turn: pending.p1Speed >= pending.p2Speed ? 'player1' : 'player2',
          // remember who started so we can keep embed colors stable
          startingPlayer: pending.p1Speed >= pending.p2Speed ? 'player1' : 'player2',
          selected: null,
          awaitingTarget: null,
          finished: false,
          log: '',
          lastP1Action: '',
          lastP2Action: '',
          timeout: null,
          consecutiveTimeouts: 0,
          embedImage: null,
          gifMessageId: null,
          discordUser1: pending.discordUser1,
          discordUser2: pending.discordUser2,
          isBountyDuel,
          bountyHunter,
          rewardsAllowed: rewardsAllowedMap,
          messageHistory: []
        };
        applyGlobalCut(state);
        appendLog(state, `${state.startingPlayer === 'player1' ? state.discordUser1.username : state.discordUser2.username} goes first!`);
        
        const embed = buildEmbed(state);
        const row = makeSelectionRow(state, state.turn === 'player1');
        
        try { await interaction.message.delete(); } catch {}
        const battleMsg = await interaction.channel.send({ embeds: [embed], components: [row] });
        state.lastMsg = battleMsg;
        duelStates.set(battleMsg.id, state);
        pendingDuelRequests.delete(msgId);
        await setupTimeout(state, battleMsg);

        // 3-minute expiration timeout
        setTimeout(() => {
          const expiredEmbed = buildEmbed(state);
          expiredEmbed.setFooter({ text: 'Expired' });
          battleMsg.edit({ embeds: [expiredEmbed], components: [] }).catch(() => {});
        }, 180000);
        return; // already deferred above
      }
    }

    // STRAT draft: open a modal to add a card
    if (rawAction === 'duel_strat_add') {
      const draft = stratDrafts.get(msgId);
      if (!draft) return interaction.reply({ content: 'This draft session has expired.', ephemeral: true });

      const parts = interaction.customId.split(':');
      const owner = parts[1];

      const expected = draft.pickOrder[draft.currentPick];
      const allowedUserId = expected === 'player1' ? draft.pending.player1Id : draft.pending.player2Id;
      if (interaction.user.id !== allowedUserId) {
        return interaction.reply({ content: 'It is not your pick.', ephemeral: true });
      }

      // show modal for card input
      try {
        const modal = new ModalBuilder()
          .setCustomId(`duel_strat_modal:${msgId}:${draft.currentPick}`)
          .setTitle('Pick a card');
        const input = new TextInputBuilder()
          .setCustomId('card_input')
          .setLabel('Card name or ID')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('Type the character name or ID from your team');
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
      } catch (e) {
        console.error('Failed to show draft modal:', e);
        return interaction.reply({ content: 'Failed to open pick form.', ephemeral: true });
      }
      return;
    }

    let state = duelStates.get(msgId);

    // If not found directly by message id, attempt to locate by lastMsg or messageHistory
    if (!state) {
      for (const s of duelStates.values()) {
        try {
          if (s.lastMsg && s.lastMsg.id === msgId) { state = s; break; }
          if (Array.isArray(s.messageHistory) && s.messageHistory.includes(msgId)) { state = s; break; }
        } catch (e) {}
      }
    }
    // If we located the state via history, rebind the lookup for faster future access
    if (state && !duelStates.has(msgId)) {
      try { duelStates.set(msgId, state); } catch (e) {}
    }
    const logs = [];

    if (!state) {
      return interaction.reply({ content: 'This duel session has expired.', ephemeral: true });
    }

    const isPlayer1 = interaction.user.id === state.player1Id;
    const isPlayer2 = interaction.user.id === state.player2Id;

    if (!isPlayer1 && !isPlayer2) {
      return interaction.reply({ content: 'You are not part of this duel.', ephemeral: true });
    }

    const expectedTurn = isPlayer1 ? 'player1' : 'player2';
    if (state.turn !== expectedTurn) {
      return interaction.reply({ content: 'It is not your turn.', ephemeral: true });
    }

    // Defer FIRST — before any async work — so Discord's 3-second clock is stopped
    // immediately after the quick synchronous checks above pass.
    await safeDefer(interaction);

    // Clear any active special attack GIF (done after defer so its latency doesn't count)
    if (state.gifMessageId) {
      try {
        const gifMsg = await interaction.channel.messages.fetch(state.gifMessageId);
        await gifMsg.delete();
      } catch (e) {
        // Message might already be deleted
      }
      state.gifMessageId = null;
    }

    const myTeam = isPlayer1 ? state.player1Cards : state.player2Cards;
    const opponentTeam = isPlayer1 ? state.player2Cards : state.player1Cards;
    const myId = isPlayer1 ? state.player1Id : state.player2Id;
    const opponentId = isPlayer1 ? state.player2Id : state.player1Id;
    let myUser = await User.findOne({ userId: myId });
    let opponentUser = await User.findOne({ userId: opponentId });
    const discordUser1 = await interaction.client.users.fetch(state.player1Id);
    const discordUser2 = await interaction.client.users.fetch(state.player2Id);

    // Handle target selection (single or multi-select)
    if (rawAction === 'duel_target') {
      const targetIdx = parseInt(cardId, 10);
      if (isNaN(targetIdx) || targetIdx < 0 || targetIdx >= opponentTeam.length) {
        return interaction.reply({ content: 'Invalid target.', ephemeral: true });
      }

      const awaiting = state.awaitingTarget;
      if (!awaiting) return interaction.reply({ content: 'No action is awaiting a target.', ephemeral: true });

      const card = myTeam[state.selected];
      if (!card) return interaction.reply({ content: 'Selected card is unavailable.', ephemeral: true });

      // Multi-select flow: accumulate selections until required count reached
      let action;
      let selectedIndices = [];
      if (typeof awaiting === 'object') {
        action = awaiting.action;
        awaiting.selections = awaiting.selections || [];
        if (awaiting.selections.includes(targetIdx)) {
          return interaction.reply({ content: 'That target is already selected.', ephemeral: true });
        }
        awaiting.selections.push(targetIdx);
        // still need more picks
        if (awaiting.selections.length < awaiting.required) {
          state.awaitingTarget = awaiting;
          await updateDuelMessage(interaction.message, state);
          return safeDefer(interaction);
        }
        // have enough picks
        selectedIndices = awaiting.selections.slice();
        state.awaitingTarget = null;
      } else {
        action = awaiting;
        selectedIndices = [targetIdx];
        state.awaitingTarget = null;
      }

      // Check if card is locked by status effect
      if (hasStatusLock(card)) {
        const reason = getStatusLockReason(card);
        appendLog(state, `${card.def.character} is ${reason} and cannot act!`);
        state.lastP1Action = state.lastP1Action || '';
        state.lastP2Action = state.lastP2Action || '';
        state.selected = null;
        await finalizeAction(state, interaction.message);
        return safeDefer(interaction);
      }

      // Confusion: hits self instead of performing multi-attack
      const confusionStatus = getConfusionChance(card);
      if (confusionStatus > 0 && randomInt(1, 100) <= confusionStatus) {
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
        if (selfKo) logs.push(selfKo);
        const actionText = `${card.def.character} is confused and hits themselves for **${selfDmg} DMG**! <:energy:1478051414558118052> -${cost}`;
        if (isPlayer1) state.lastP1Action = actionText;
        else state.lastP2Action = actionText;
        state.selected = null;
        await finalizeAction(state, interaction.message);
        return safeDefer(interaction);
      }

      // Resolve target objects and filter alive
      const targets = Array.from(new Set(selectedIndices)).map(i => opponentTeam[i]).filter(t => t && t.currentHP > 0);
      if (!targets.length) return interaction.reply({ content: 'No valid targets selected.', ephemeral: true });

      // Drunk: redirect a single-target attack to a random different alive opponent
      let resolvedTargets = targets;
      {
        const drunkChance = getDrunkChance(card);
        if (drunkChance > 0 && resolvedTargets.length === 1 && Math.random() * 100 < drunkChance) {
          const otherTargets = opponentTeam.filter(c => c.currentHP > 0 && c !== resolvedTargets[0]);
          if (otherTargets.length > 0) {
            const newTarget = otherTargets[Math.floor(Math.random() * otherTargets.length)];
            logs.push(`${card.def.character} is drunk and staggers — attacks ${newTarget.def.character} instead!`);
            resolvedTargets = [newTarget];
          }
        }
      }

      // Apply energy cost and bleed once per action
      if (action === 'attack') {
        if (card.energy < 1) return interaction.reply({ content: 'Not enough energy.', ephemeral: true });
        card.energy -= 1;
        card.turnsUntilRecharge = 2;
        try { const bleedLogsLocal = applyBleedOnEnergyUse(card, 1); if (bleedLogsLocal && bleedLogsLocal.length) bleedLogsLocal.forEach(l => logs.push(l)); } catch (e) {}
      } else if (action === 'special') {
        if (card.energy < 3) return interaction.reply({ content: 'Not enough energy.', ephemeral: true });
        card.energy -= 3;
        card.turnsUntilRecharge = 2;
        try { const bleedLogsLocal = applyBleedOnEnergyUse(card, 3); if (bleedLogsLocal && bleedLogsLocal.length) bleedLogsLocal.forEach(l => logs.push(l)); } catch (e) {}
      }

      // Perform damage for each target
      const perTargetDmg = [];
      let base = calculateUserDamage(card, action);
      // If attacking multiple targets, divide the base damage across them
      if (resolvedTargets.length > 1) base = Math.max(0, Math.floor(base / resolvedTargets.length));
      for (const tgt of resolvedTargets) {
        if (!tgt) continue;
        const attrMultiplier = getDamageMultiplier(card.def.attribute, tgt.def.attribute);
        const proneMultiplier = getProneMultiplier(card, tgt);
        const attackMod = getAttackModifier(card);
        const defenseMultiplier = getDefenseMultiplier(card, tgt);
        let dmg = Math.max(0, Math.floor(base * attrMultiplier * proneMultiplier * attackMod * defenseMultiplier));

        const reflect = getReflectStatus(tgt);
        if (reflect) {
          card.currentHP = Math.max(0, (card.currentHP || 0) - dmg);
          const reflectKO = handleKO(card);
          if (reflectKO) logs.push(reflectKO);
          logs.push(`${tgt.def.character}'s reflect sends the attack back to ${card.def.character} for **${dmg} DMG**!`);
        } else {
          tgt.currentHP -= dmg;
          if (tgt.currentHP <= 0) {
            tgt.currentHP = 0;
            const ko = handleKO(tgt);
            if (ko) logs.push(ko);
          }
        }
        // unfreeze the damage target if it was frozen
        if (tgt.status) {
          const freezeIdx = tgt.status.findIndex(st => st.type === 'freeze');
          if (freezeIdx >= 0) tgt.status.splice(freezeIdx, 1);
        }
        perTargetDmg.push(dmg);
      }

      // Apply status effects for specials according to `all` rules
      let effectLogs = [];
      if (action === 'special') {
        let effectTarget = null;
        if (card.def.effect === 'team_stun') {
          effectTarget = opponentTeam.filter(c => c.currentHP > 0);
        } else if (card.def.all) {
          // `all` effects target the selected group of targets as intended
          if (card.def.effect) effectTarget = resolvedTargets;
        } else {
          // scount only splits damage; special effect still applies to the primary selected target
          effectTarget = resolvedTargets[0] || null;
        }
        const { isStatusEffectUnlocked: _duelAwaitEffUnlocked } = require('../utils/starLevel');
        if (effectTarget && _duelAwaitEffUnlocked(card.userEntry?.starLevel)) {
          try {
            effectLogs = applyCardEffectShared(card, effectTarget, { playerTeam: myTeam, opponentTeam });
          } catch (e) {
            console.error('Error applying effect:', e);
          }
        }
      }

      // Build a compact action summary
      const names = resolvedTargets.map(t => `${t.def.emoji || ''} ${t.def.character}`).join(', ');
      const dmgSummary = perTargetDmg.length
        ? (perTargetDmg.length === 1
          ? `**${perTargetDmg[0]} DMG**`
          : (perTargetDmg.every(d => d === perTargetDmg[0]) ? `**${perTargetDmg[0]} DMG** each` : perTargetDmg.map(d => `**${d}**`).join('/')))
        : '**0 DMG**';
      const cost = action === 'attack' ? 1 : action === 'special' ? 3 : 0;
      const actionVerb = action === 'special' ? (card.def.special_attack?.name || 'Special Attack') : 'attacked';
      const effectMessages = (effectLogs && effectLogs.length) ? ` *${effectLogs.join(', ')}*` : '';
      const actionText = `${card.def.emoji} **${card.def.character}** ${action === 'special' ? 'used' : 'attacked'} ${action === 'special' ? actionVerb : names} for ${dmgSummary}!${effectMessages} **<:energy:1478051414558118052> -${cost}**`;
      if (isPlayer1) state.lastP1Action = actionText; else state.lastP2Action = actionText;

      // Append reflection/KO logs
      if (logs.length > 0) logs.forEach(l => appendLog(state, l));

      state.selected = null;
      await finalizeAction(state, interaction.message);
      return safeDefer(interaction);
    }

    // Handle selection
    if (rawAction === 'duel_select') {
      const idx = parseInt(cardId, 10);
      if (isNaN(idx) || idx < 0 || idx >= myTeam.length) {
        return interaction.reply({ content: 'Invalid selection.', ephemeral: true });
      }

      if (state.finished) {
        return interaction.reply({ content: 'This duel has finished.', ephemeral: true });
      }

      const card = myTeam[idx];
      if (!card.alive) {
        return interaction.reply({ content: 'That card is knocked out.', ephemeral: true });
      }

      // Hard stun/freeze block - prevent selection of stunned/frozen cards
      if (hasStatusLock(card)) {
        const reason = getStatusLockReason(card);
        return interaction.reply({ content: `${card.def.character} is ${reason}!`, ephemeral: true });
      }

      state.selected = idx;
      await updateDuelMessage(interaction.message, state);
      return safeDefer(interaction);
    }

    // Handle action
    if (rawAction === 'duel_action') {
      const act = cardId;

      if (state.finished) {
        return interaction.reply({ content: 'The duel has already ended.', ephemeral: true });
      }

      // Team Rest without a selected card — heals 5% HP only
      if (act === 'rest') {
        myTeam.forEach(c => {
          if (c.alive) {
            c.currentHP = Math.min(c.maxHP || c.def.health, c.currentHP + Math.floor((c.maxHP || c.def.health) * 0.05));
          }
        });
        const actionText = `The team took a rest and healed 5% HP!`;
        if (isPlayer1) state.lastP1Action = actionText;
        else state.lastP2Action = actionText;
        state.log = '';
        await finalizeAction(state, interaction.message);
        return safeDefer(interaction);
      }

      const card = myTeam[state.selected];
      if (!card || !card.alive) {
        state.selected = null;
        await updateDuelMessage(interaction.message, state);
        return interaction.reply({ content: 'Selected card is unavailable.', ephemeral: true });
      }

      if (act === 'attack' || act === 'special') {
        // block stunned/frozen cards from initiating an action
        if (hasStatusLock(card)) {
          return interaction.reply({ content: `${card.def.character} is ${getStatusLockReason(card)} and cannot act!`, ephemeral: true });
        }
        if (hasAttackDisabled(card)) {
          return interaction.reply({ content: `${card.def.character} cannot attack or special attack right now!`, ephemeral: true });
        }
        const aliveOpponents = opponentTeam.filter(c => c.currentHP > 0);
        if (aliveOpponents.length === 0) {
          return interaction.reply({ content: 'No valid targets remaining.', ephemeral: true });
        }
        // pick a target index now, default to first alive opponent
        let targetIdx = opponentTeam.findIndex(c => c.currentHP > 0);
        
        // Determine if this card should trigger multi-target selection
        let required = 1;
        if (act === 'attack' && card.def.count) {
          if (typeof card.def.count === 'number') required = Math.min(card.def.count, aliveOpponents.length);
          else required = aliveOpponents.length;
        } else if (act === 'special' && card.def.scount) {
          if (typeof card.def.scount === 'number') required = Math.min(card.def.scount, aliveOpponents.length);
          else required = aliveOpponents.length;
        }

        // If multi-target is required and we have multiple opponents to choose from, decide between
        // prompting the player (when they must pick specific targets) or auto-selecting all targets
        // when the required count equals or exceeds the number of alive opponents.
        let autoTargets = null;
        if (!state.awaitingTarget && aliveOpponents.length > 1) {
          if (required > 1) {
            if (required >= aliveOpponents.length) {
              // auto-target all alive opponents
              autoTargets = opponentTeam.filter(c => c.currentHP > 0);
            } else {
              // require player to pick `required` targets
              state.awaitingTarget = { action: act, required, selections: [] };
              await updateDuelMessage(interaction.message, state);
              return safeDefer(interaction);
            }
          } else {
            // single target: prompt user to pick one
            state.awaitingTarget = act;
            await updateDuelMessage(interaction.message, state);
            return safeDefer(interaction);
          }
        }

        // Energy checks
        if (act === 'attack') {
          if (card.energy < 1) return interaction.reply({ content: 'Not enough energy for attack.', ephemeral: true });
          card.energy -= 1;
          try { const bleedLocal = applyBleedOnEnergyUse(card, 1); if (bleedLocal && bleedLocal.length) bleedLocal.forEach(l => logs.push(l)); } catch (e) {}
        } else if (act === 'special') {
          const { isSpecialAttackUnlocked: _duelSpecCheck } = require('../utils/starLevel');
          if (!_duelSpecCheck(card.userEntry?.starLevel)) {
            return interaction.reply({ content: `**${card.def.character}** has not unlocked Special Attack yet. Reach **Star Level 4** to unlock it.`, ephemeral: true });
          }
          if (card.energy < 3) return interaction.reply({ content: 'Special attack requires 3 energy.', ephemeral: true });
          card.energy -= 3;
          try { const bleedLocal = applyBleedOnEnergyUse(card, 3); if (bleedLocal && bleedLocal.length) bleedLocal.forEach(l => logs.push(l)); } catch (e) {}
        }

        card.turnsUntilRecharge = 2;
        const baseDmg = calculateUserDamage(card, act, myUser);

        // If we auto-selected multiple targets (e.g., scount:3 hitting all enemies), apply
        // per-target damage distributed across targets, then apply effects to the appropriate targets.
        // Single alive opponent — auto-target them directly (no prompt needed)
        if (!autoTargets && aliveOpponents.length === 1) {
          autoTargets = aliveOpponents;
        }

        if (autoTargets && autoTargets.length) {
          const targets = autoTargets;
          // divide base damage evenly across targets so the card's attack stat is split
          const basePerTarget = Math.max(0, Math.floor(baseDmg / Math.max(1, targets.length)));
          const perTargetDmg = [];
          for (const tgt of targets) {
            if (!tgt) continue;
            const attrMultiplier = getDamageMultiplier(card.def.attribute, tgt.def.attribute);
            const proneMultiplier = getProneMultiplier(card, tgt);
            const attackMod = getAttackModifier(card);
            const defenseMultiplier = getDefenseMultiplier(card, tgt);
            let dmg = Math.max(0, Math.floor(basePerTarget * attrMultiplier * proneMultiplier * attackMod * defenseMultiplier));

            const reflect = getReflectStatus(tgt);
            if (reflect) {
              card.currentHP = Math.max(0, (card.currentHP || 0) - dmg);
              const reflectKO = handleKO(card);
              if (reflectKO) logs.push(reflectKO);
              logs.push(`${tgt.def.character}'s reflect sends the attack back to ${card.def.character} for **${dmg} DMG**!`);
            } else {
              tgt.currentHP -= dmg;
              if (tgt.currentHP <= 0) {
                tgt.currentHP = 0;
                const ko = handleKO(tgt);
                if (ko) logs.push(ko);
              }
            }
            // unfreeze the damage target if it was frozen
            if (tgt.status) {
              const freezeIdx = tgt.status.findIndex(st => st.type === 'freeze');
              if (freezeIdx >= 0) tgt.status.splice(freezeIdx, 1);
            }
            perTargetDmg.push(dmg);
          }

          // Apply status effects for specials according to multi-target rules
          let effectLogs = [];
          if (act === 'special') {
            let effectTarget = null;
            if (card.def.effect === 'team_stun') {
              effectTarget = opponentTeam.filter(c => c.currentHP > 0);
            } else if (card.def.all) {
              if (card.def.effect) effectTarget = targets;
            } else {
              effectTarget = targets[0] || null;
            }
            const { isStatusEffectUnlocked: _duelAutoEffUnlocked } = require('../utils/starLevel');
            if (effectTarget && _duelAutoEffUnlocked(card.userEntry?.starLevel)) {
              try {
                effectLogs = applyCardEffectShared(card, effectTarget, { playerTeam: myTeam, opponentTeam });
              } catch (e) {
                console.error('Error applying effect:', e);
              }
            }
          }

          // Build action summary
          const names = targets.map(t => `${t.def.emoji || ''} ${t.def.character}`).join(', ');
          const dmgSummary = perTargetDmg.length
            ? (perTargetDmg.length === 1
              ? `**${perTargetDmg[0]} DMG**`
              : (perTargetDmg.every(d => d === perTargetDmg[0]) ? `**${perTargetDmg[0]} DMG** each` : perTargetDmg.map(d => `**${d}**`).join('/')))
            : '**0 DMG**';
          const cost = act === 'attack' ? 1 : act === 'special' ? 3 : 0;
          const actionVerb = act === 'special' ? (card.def.special_attack?.name || 'Special Attack') : 'attacked';
          const autoEffectMessages = (effectLogs && effectLogs.length) ? ` *${effectLogs.join(', ')}*` : '';
          const actionText = `${card.def.emoji} **${card.def.character}** ${act === 'special' ? 'used' : 'attacked'} ${act === 'special' ? actionVerb : names} for ${dmgSummary}!${autoEffectMessages} **<:energy:1478051414558118052> -${cost}**`;
          if (isPlayer1) state.lastP1Action = actionText; else state.lastP2Action = actionText;

          if (logs.length > 0) logs.forEach(l => appendLog(state, l));

          state.selected = null;
          await finalizeAction(state, interaction.message);
          return safeDefer(interaction);
        }
        // apply status effect only for specials
        let effectLogs = [];
        let effectSummary = '';
        if (act === 'special') {
          try {
            console.log(`[duel] applying effect=${card.def.effect} id=${card.def.id} count=${card.def.count || 0} scount=${card.def.scount || 0} targetIsArray=${Array.isArray(effectTarget)} targetCount=${Array.isArray(effectTarget) ? effectTarget.length : (effectTarget ? 1 : 0)}`);
          } catch (e) {}
          const { isStatusEffectUnlocked: _duelSingEffUnlocked } = require('../utils/starLevel');
          if (_duelSingEffUnlocked(card.userEntry?.starLevel)) {
            effectLogs = applyCardEffectShared(card, effectTarget, { playerTeam: myTeam, opponentTeam });
          }
          // Build effect summary for GIF embed (e.g., "and stuns Roronoa Zoro")
          if (card.def.effect === 'team_stun') {
            effectSummary = ' and stunned the whole team';
          } else if (card.def.effect && effectTarget.def) {
            const effectVerbs = {
              'stun': 'stuns',
              'freeze': 'freezes',
              'cut': 'cuts',
              'bleed': 'bleeds'
            };
            const verb = effectVerbs[card.def.effect] || 'hits';
            effectSummary = ` and ${verb} ${effectTarget.def.character}`;
          }
          // embed the gif on main duel embed as well
          if (card.def.special_attack?.gif) {
            const gifUrl = normalizeGifUrl(card.def.special_attack.gif);
            state.embedImage = gifUrl;
            try {
              let desc = `${card.def.character} uses ${card.def.special_attack.name || 'Special Attack'}!`;
              if (card.def.effect && card.def.effectDuration) {
                const effectDesc = getEffectDescription(card.def.effect, card.def.effectDuration, !!card.def.itself, card.def.effectAmount, card.def.effectChance, !!card.def.scount);
                if (effectDesc) desc += `\n*${effectDesc}*`;
              } else if (effectSummary) {
                // fallback to previous short summary if no duration available
                desc += effectSummary;
              }
              const gifEmbed = new EmbedBuilder()
                .setColor('#FFFFFF')
                .setImage(gifUrl)
                .setDescription(desc)
                .setAuthor({ name: state.discordUser1.username, iconURL: state.discordUser1.displayAvatarURL() });
              const gifMsg = await interaction.channel.send({ embeds: [gifEmbed] });
              state.gifMessageId = gifMsg.id;
            } catch (e) {
              console.error('Failed to send special attack GIF:', e);
            }
          } else {
            state.embedImage = null;
          }
        }
        effectLogs.forEach(l => appendLog(state, l));

        const cost = act === 'attack' ? 1 : act === 'special' ? 3 : 1;
        const effectivenessStr = attrMultiplier > 1 ? ' (Effective!)' : attrMultiplier < 1 ? ' (Weak)' : '';
        const effectMessages = effectLogs.length > 0 ? ` *${effectLogs.join(', ')}*` : '';
        let actionText;
        if (act === 'special') {
          if (card.def.effect === 'team_stun') {
            actionText = `${card.def.emoji} **${card.def.character}** used ${card.def.special_attack?.name || 'Special Attack'} on ${damageTarget?.def?.emoji || '⚔️'} **${damageTarget?.def?.character || 'target'}** for **${dmg} DMG**!${effectivenessStr} *stunned the whole team*${effectMessages} **<:energy:1478051414558118052> -${cost}**`;
          } else {
            actionText = `${card.def.emoji} **${card.def.character}** used ${card.def.special_attack?.name || 'Special Attack'} for **${dmg} DMG**!${effectivenessStr}${getEffectString(card, damageTarget)}${effectMessages} **<:energy:1478051414558118052> -${cost}**`;
          }
        } else {
          // Normal attacks should not display special-effect descriptions; only include per-action effect messages
          actionText = `${card.def.emoji} **${card.def.character}** attacked ${damageTarget.def.emoji} **${damageTarget.def.character}** for **${dmg} DMG**!${effectivenessStr}${effectMessages} **<:energy:1478051414558118052> -${cost}**`;
        }
        if (isPlayer1) state.lastP1Action = actionText;
        else state.lastP2Action = actionText;
      } else if (act === 'card_rest') {
        // Card-specific rest: heal 10% HP and replenish all energy
        card.energy = 3;
        card.turnsUntilRecharge = 2;
        const healAmount = Math.ceil(card.maxHP * 0.10);
        card.currentHP = Math.min(card.maxHP, card.currentHP + healAmount);
        const removed = card.status?.some(st => st.type === 'freeze' || st.type === 'hungry');
        if (removed) {
          removeStatusTypes(card, ['freeze', 'hungry']);
        }
        const actionText = `${card.def.character} rested, healed ${healAmount} HP and restored full energy${removed ? ', and recovered from freeze/hunger' : ''}!`;
        if (isPlayer1) state.lastP1Action = actionText;
        else state.lastP2Action = actionText;
      }

      // Clear log after action to prevent accumulation
      state.log = '';

      await finalizeAction(state, interaction.message);
      return safeDefer(interaction);
    }

    return interaction.reply({ content: 'Unsupported interaction.', ephemeral: true });
  }
};
