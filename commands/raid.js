const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const User  = require('../models/User');
const Crew  = require('../models/Crew');
const { getCardById, searchCards }  = require('../utils/cards');
const { resolveStats }              = require('../utils/statResolver');
const { getDamageMultiplier }       = require('../utils/attributeSystem');
const {
  calculateUserDamage,
  hasStatusLock,
  hasAttackDisabled,
  getStatusLockReason,
  applyStartOfTurnEffects,
  getAttackModifier,
  getDefenseMultiplier,
  getConfusionChance,
  applyBleedOnEnergyUse,
} = require('../src/battle/statusManager');
const {
  RANK_MAX_LEVEL,
  isSpecialAttackUnlocked,
  isStatusEffectUnlocked,
} = require('../utils/starLevel');
const { OWNER_ID } = require('../config');

// ─── Owner solo-mode toggle ───────────────────────────────────────────────────
// When enabled the bot owner can start and run a raid alone (no crew needed,
// no minimum player count). Toggled via `op owner toggleraid`.

let raidSoloMode = false;
function toggleRaidSoloMode()    { raidSoloMode = !raidSoloMode; return raidSoloMode; }
function isRaidSoloMode()        { return raidSoloMode; }

// ─── Constants ────────────────────────────────────────────────────────────────

const raidStates       = new Map();
const BELI_BY_RANK     = { D: 300, C: 300, B: 300, A: 300, S: 500, SS: 700, UR: 1000 };
const RAID_TIMEOUT     = 3 * 60 * 1000;  // lobby auto-cancel
const TURN_TIMEOUT_MS  = 30 * 1000;      // per-turn inactivity
const INACT_TIMEOUT_MS = 60 * 1000;      // whole-raid inactivity → cancel
const MAX_PLAYERS      = 10;
const MIN_PLAYERS      = 3;

const EMOJI = {
  godToken: '<:godtoken:1499957056650608753>',
  captain:  '<:captain:1508200434274406470>',
  viceCap:  '<:vc:1508270658763751434>',
  member:   '<:user:1490731587564736643>',
  energy:   '<:energy:1478051414558118052>',
  hpFL:     '<:Healthfullleft:1481750264074469437>',
  hpFM:     '<:healthfullmiddle:1481750286795149435>',
  hpFR:     '<:healthfullright:1481750302679105710>',
  hpEL:     '<:Healthemptyleft:1481750325151928391>',
  hpEM:     '<:Healthemptymiddle:1481750341489004596>',
  hpER:     '<:healthemptyright:1481750363286667334>',
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function hpBar(cur, max) {
  if (max <= 0 || cur <= 0) return EMOJI.hpEL + EMOJI.hpEM.repeat(6) + EMOJI.hpER;
  const f = Math.floor(Math.max(0, Math.min(1, cur / max)) * 6);
  return EMOJI.hpFL + EMOJI.hpFM.repeat(f) + EMOJI.hpEM.repeat(6 - f) + (f === 6 ? EMOJI.hpFR : EMOJI.hpER);
}

function energyBar(e) { return e > 0 ? EMOJI.energy.repeat(Math.min(e, 3)) : '0'; }

function getEmojiId(emoji) {
  const m = (emoji || '').match(/<a?:[^:]+:(\d+)>/);
  return m ? m[1] : null;
}

function findItemCount(items, id) {
  const it = Array.isArray(items) ? items.find(i => i.itemId === id) : null;
  return it ? (it.quantity || 0) : 0;
}

function removeItem(items, id, n) {
  if (!Array.isArray(items)) return items;
  const idx = items.findIndex(i => i.itemId === id);
  if (idx === -1) return items;
  items[idx].quantity = (items[idx].quantity || 0) - n;
  if (items[idx].quantity <= 0) items.splice(idx, 1);
  return items;
}

function addItem(items, id, n) {
  if (!Array.isArray(items)) items = [];
  const it = items.find(i => i.itemId === id);
  if (it) { it.quantity = (it.quantity || 0) + n; }
  else { items.push({ itemId: id, quantity: n }); }
  return items;
}

// ─── Card search with team/favorites priority ─────────────────────────────────

// If multiple cards match a query, prefer the user's team cards, then
// favorites, then remaining results. Falls back to plain search if no user.
function findCardByQuery(query) {
  if (!query) return null;
  const byId = getCardById(query.trim());
  if (byId) return byId;
  const results = searchCards(query.trim());
  return results && results.length ? results[0] : null;
}

function findCardForUser(query, user) {
  if (!query) return null;
  const byId = getCardById(query.trim());
  if (byId) return byId;

  const results = searchCards(query.trim());
  if (!results || !results.length) return null;
  if (!user) return results[0];

  const teamIds = user.team || [];
  const favIds  = user.favoriteCards || [];

  // Priority: owned team card → owned favorite → anything
  const ownedIds = new Set((user.ownedCards || []).map(e => e.cardId));
  results.sort((a, b) => {
    const score = r => {
      if (teamIds.includes(r.id) && ownedIds.has(r.id)) return 0;
      if (favIds.includes(r.id)  && ownedIds.has(r.id)) return 1;
      return 2;
    };
    return score(a) - score(b);
  });

  return results[0];
}

// ─── Star-level gated battle def (same approach as isail.js) ─────────────────

function buildBattleDef(def, entry) {
  if (isStatusEffectUnlocked((entry && entry.starLevel) || 0)) return def;
  return Object.assign({}, def, {
    effect: undefined, effectDuration: undefined,
    effectAmount: undefined, effectChance: undefined, effectTarget: undefined,
  });
}

// ─── ctx helpers ──────────────────────────────────────────────────────────────

async function reply(ctx, content, ephemeral = true) {
  if (typeof content === 'string') content = { content };
  if (ctx.interaction) {
    if (ctx.interaction.deferred || ctx.interaction.replied)
      return ctx.interaction.followUp({ ...content, ephemeral }).catch(() => {});
    return ctx.interaction.reply({ ...content, ephemeral }).catch(() => {});
  }
  if (ctx.message) return ctx.message.reply(content).catch(() => {});
}

// ─── Crew role lookup ─────────────────────────────────────────────────────────

async function resolveHostRole(crew, userId) {
  if (crew.captainId === userId) return { emoji: EMOJI.captain };
  try {
    const docs = await User.find({ userId: { $in: crew.members } }, 'userId bounty');
    const non  = docs.filter(d => d.userId !== crew.captainId);
    if (non.length) {
      const vc = non.reduce((b, u) => (u.bounty ?? 100) > (b.bounty ?? 100) ? u : b);
      if (vc.userId === userId) return { emoji: EMOJI.viceCap };
    }
  } catch (_) {}
  return { emoji: EMOJI.member };
}

// ─── Builders ─────────────────────────────────────────────────────────────────

function buildBossFromDef(def) {
  const hp   = def.health || def.hp || 100;
  const bMin = typeof def.attack_min === 'number' ? def.attack_min : (def.power || 20);
  const bMax = typeof def.attack_max === 'number' ? def.attack_max : bMin;
  return {
    name: def.character || 'Boss', title: def.title || '',
    emoji: def.emoji || '', image: def.image_url || def.image || null,
    cardId: def.id, rank: def.rank || 'D', attribute: def.attribute || 'STR',
    baseHP: hp,
    maxHP: Math.floor(hp * 6), currentHP: Math.floor(hp * 6),
    attack_min: Math.floor(bMin * 2),
    attack_max: Math.max(Math.floor(bMin * 2), Math.floor(bMax * 2)),
    status: [],
  };
}

function buildPlayerCard(def, entry, ownedCards) {
  const battleDef = buildBattleDef(def, entry);
  const scaled    = resolveStats(entry, ownedCards);
  const maxHP     = scaled ? scaled.health : (def.health || def.hp || 100);
  return {
    def: battleDef,      // star-level-gated def for battle logic
    displayDef: def,     // original def for display (emoji, name, image)
    entry,
    scaled,
    maxHP,
    currentHP: maxHP,
    energy: 3,
    alive: true,
    status: [],
    turnsUntilRecharge: 0,
  };
}

// ─── Round queue ──────────────────────────────────────────────────────────────

function rebuildRoundQueue(state) {
  state.roundQueue = [...state.players]
    .filter(p => p.card && p.card.alive)
    .sort((a, b) => (b.card?.def?.speed || 0) - (a.card?.def?.speed || 0))
    .map(p => p.userId);
  state.roundIndex = 0;
}

function currentPlayer(state) {
  const uid = state.roundQueue[state.roundIndex];
  return uid ? state.players.find(p => p.userId === uid) : null;
}

// ─── Timer helpers ────────────────────────────────────────────────────────────

function clearRaidTimers(state) {
  if (state.turnTimeoutId)  { clearTimeout(state.turnTimeoutId);  state.turnTimeoutId  = null; }
  if (state.inactTimeoutId) { clearTimeout(state.inactTimeoutId); state.inactTimeoutId = null; }
}

// Starts (or restarts) the per-turn 30 s timer. When it fires the current
// player is auto-skipped (treated as a rest). The whole-raid 60 s inactivity
// timer is NOT reset here — only real player actions reset that.
function startTurnTimer(state) {
  if (state.turnTimeoutId) { clearTimeout(state.turnTimeoutId); state.turnTimeoutId = null; }
  if (state.finished || state.phase !== 'battle') return;

  state.turnTimeoutId = setTimeout(async () => {
    state.turnTimeoutId = null;
    if (state.finished || state.phase !== 'battle') return;
    const cp = currentPlayer(state);
    if (!cp || !cp.card || !cp.card.alive) return;
    // Auto-skip: give +1 energy (same as rest), log, advance
    if (cp.card.turnsUntilRecharge > 0) { cp.card.turnsUntilRecharge = Math.max(0, cp.card.turnsUntilRecharge - 1); }
    else { cp.card.energy = Math.min(3, (cp.card.energy || 0) + 1); }
    state.lastAction = `⏱️ **${cp.username}** didn't respond — **${cp.card.displayDef.character}** auto-rested. ${energyBar(cp.card.energy)}`;
    await advanceTurn(state);
  }, TURN_TIMEOUT_MS);
}

// Starts (or restarts) the 60 s whole-raid inactivity timer.
// Should be called whenever a real player action happens.
function resetInactivityTimer(state) {
  if (state.inactTimeoutId) { clearTimeout(state.inactTimeoutId); state.inactTimeoutId = null; }
  if (state.finished || state.phase !== 'battle') return;

  state.inactTimeoutId = setTimeout(async () => {
    state.inactTimeoutId = null;
    if (state.finished || state.phase !== 'battle') return;
    await handleTimeout(state);
  }, INACT_TIMEOUT_MS);
}

// ─── Embed builders ───────────────────────────────────────────────────────────

function buildLobbyEmbed(state) {
  const boss  = state.boss;
  const embed = new EmbedBuilder()
    .setColor('#FFFFFF')
    .setTitle(`${boss.name}${boss.title ? ` - ${boss.title}` : ''} | Boss Raid`)
    .setDescription(`**Host:** ${state.ownerUsername} ${state.hostRoleEmoji || EMOJI.member}\n**Crew:** ${state.crewName}`);

  const emojiId = getEmojiId(boss.emoji);
  if (emojiId) embed.setThumbnail(`https://cdn.discordapp.com/emojis/${emojiId}.png`);
  if (boss.image) embed.setImage(boss.image);

  embed.addFields({
    name: `${boss.emoji || ''} **${boss.name}**`.trim(),
    value: `${hpBar(boss.currentHP, boss.maxHP)}\n${boss.name} | Raid boss\n${boss.currentHP}/${boss.maxHP}`,
    inline: false,
  });
  embed.addFields({ name: '\u200b', value: '\u200b', inline: false });

  if (state.players.length === 0) {
    embed.addFields({ name: '\u200b', value: '_no cards added yet …_', inline: false });
  } else {
    const sorted = [...state.players].sort((a, b) => (b.card?.displayDef?.speed || 0) - (a.card?.displayDef?.speed || 0));
    for (const p of sorted) {
      if (!p.card) continue;
      const d = p.card.displayDef;
      embed.addFields({
        name:  `${d.emoji || ''} ${p.username}`.trim(),
        value: `${d.character} | Lv. ${p.entry?.level ?? 1} | Spd: ${d.speed || 0}\n${hpBar(p.card.currentHP, p.card.maxHP)}\n${p.card.currentHP}/${p.card.maxHP} ${energyBar(p.card.energy)}`,
        inline: true,
      });
    }
  }

  embed.setFooter({ text: `Click "Join Raid" or use \`op raid add <card>\` • ${state.players.length}/${MAX_PLAYERS} players` });
  return embed;
}

function buildBattleEmbed(state) {
  const boss  = state.boss;
  const embed = new EmbedBuilder()
    .setColor('#FFFFFF')
    .setTitle(`${boss.name}${boss.title ? ` - ${boss.title}` : ''} | Boss Raid`);

  const emojiId = getEmojiId(boss.emoji);
  if (emojiId) embed.setThumbnail(`https://cdn.discordapp.com/emojis/${emojiId}.png`);
  if (boss.image) embed.setImage(boss.image);

  embed.addFields({
    name:  `${boss.emoji || ''} **${boss.name}**`.trim(),
    value: `${hpBar(boss.currentHP, boss.maxHP)}\n${boss.name} | Raid boss\n${boss.currentHP}/${boss.maxHP}`,
    inline: false,
  });
  embed.addFields({ name: '\u200b', value: '\u200b', inline: false });

  const cp     = currentPlayer(state);
  const sorted = [...state.players].sort((a, b) => (b.card?.displayDef?.speed || 0) - (a.card?.displayDef?.speed || 0));

  for (const p of sorted) {
    if (!p.card) continue;
    const d      = p.card.displayDef;
    const isTurn = !state.finished && cp && p.userId === cp.userId;
    const val    = p.card.alive
      ? `${hpBar(p.card.currentHP, p.card.maxHP)}\nLv. ${p.entry?.level ?? 1} | ${energyBar(p.card.energy)}`
      : `**KO'd**\n${hpBar(0, p.card.maxHP)}`;
    embed.addFields({
      name:  `${isTurn ? '▶ ' : ''}${d.emoji || ''} ${p.username} — ${d.character}`.trim(),
      value: val,
      inline: true,
    });
  }

  if (state.lastAction) {
    embed.addFields({ name: 'Battle Log', value: state.lastAction.slice(-1024), inline: false });
  }
  if (!state.finished && cp) {
    embed.setFooter({ text: `It's ${cp.username}'s turn!` });
  }
  return embed;
}

// ─── Components ───────────────────────────────────────────────────────────────

function makeLobbyComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('raid_join').setLabel('Join Raid').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('raid_start').setLabel('Start Raid').setStyle(ButtonStyle.Danger),
  )];
}

function makeBattleComponents(state) {
  if (state.finished) return [];
  const cp = currentPlayer(state);
  if (!cp || !cp.card || !cp.card.alive) return [];

  const card   = cp.card;
  const locked = hasStatusLock(card) || hasAttackDisabled(card);
  const row    = new ActionRowBuilder();

  row.addComponents(
    new ButtonBuilder()
      .setCustomId('raid_action:attack')
      .setLabel('Attack')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(locked || card.energy < 1),
  );

  if (card.def.special_attack && isSpecialAttackUnlocked(card.entry?.starLevel)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('raid_action:special')
        .setLabel('Special Attack')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(locked || card.energy < 3),
    );
  }

  row.addComponents(
    new ButtonBuilder().setCustomId('raid_action:rest').setLabel('Rest').setStyle(ButtonStyle.Success),
  );
  return [row];
}

// ─── Message helpers ──────────────────────────────────────────────────────────

async function editLobbyMessage(state) {
  try {
    const msg = await state.channel.messages.fetch(state.messageId).catch(() => null);
    if (msg) await msg.edit({ embeds: [buildLobbyEmbed(state)], components: makeLobbyComponents() });
  } catch (e) {
    if (e.code !== 10008) console.error('[raid] editLobbyMessage:', e);
  }
}

async function sendTurnMessage(state) {
  try {
    if (state.battleMessageId) {
      const old = await state.channel.messages.fetch(state.battleMessageId).catch(() => null);
      if (old) await old.edit({ components: [] }).catch(() => {});
    }
    const cp         = currentPlayer(state);
    const embed      = buildBattleEmbed(state);
    const components = makeBattleComponents(state);
    const content    = (cp && !state.finished) ? `<@${cp.userId}> it's your turn!` : undefined;
    const payload    = { embeds: [embed], components };
    if (content) payload.content = content;
    const msg = await state.channel.send(payload);
    state.battleMessageId = msg.id;
    // Start per-turn 30 s countdown for the current player
    startTurnTimer(state);
  } catch (e) {
    console.error('[raid] sendTurnMessage:', e);
  }
}

// ─── Battle logic ─────────────────────────────────────────────────────────────

async function startRaidBattle(state) {
  state.phase = 'battle';
  if (state.startTimeoutId) { clearTimeout(state.startTimeoutId); state.startTimeoutId = null; }

  try {
    const lm = await state.channel.messages.fetch(state.messageId).catch(() => null);
    if (lm) await lm.edit({ components: [] }).catch(() => {});
  } catch (_) {}

  rebuildRoundQueue(state);
  // Scale boss HP based on number of joined players: HP multiplier = players_count * 2
  try {
    const playersCount = Math.max(1, (state.players || []).length);
    if (state.boss && typeof state.boss.baseHP === 'number') {
      const multiplier = 2 + playersCount * 0.1;
      const newMax = Math.floor(state.boss.baseHP * multiplier);
      state.boss.maxHP = newMax;
      state.boss.currentHP = newMax;
    }
  } catch (e) { console.error('[raid] scaling boss HP failed:', e); }
  state.lastAction      = 'The raid has begun! Players attack in order of speed.';
  state.battleMessageId = null;
  // Start the 60 s whole-raid inactivity watchdog
  resetInactivityTimer(state);
  await sendTurnMessage(state);
}

async function processBossAttack(state) {
  const alive = state.players.filter(p => p.card && p.card.alive);
  if (!alive.length) return;
  // Increment boss special counter and decide whether this attack is special (every other attack)
  state.bossSpecialCounter = (state.bossSpecialCounter || 0) + 1;
  const isSpecial = state.bossSpecialCounter % 2 === 0;

  const target = alive[randomInt(0, alive.length - 1)];
  const atkBase = randomInt(state.boss.attack_min, state.boss.attack_max);
  const atkMod = getAttackModifier(state.boss);   // boss attackdown/up status
  let atk = Math.max(1, Math.floor(atkBase * atkMod));

  if (isSpecial) {
    // Special attack: stronger hit (2x attack modifier) and no status effects
    atk = Math.max(1, Math.floor(atkBase * atkMod * 2));
  }

  const mult = getDamageMultiplier(state.boss.attribute, target.card.def.attribute);
  const dmg  = Math.max(1, Math.floor(atk * mult));

  target.card.currentHP = Math.max(0, target.card.currentHP - dmg);
  if (target.card.currentHP <= 0) {
    target.card.alive     = false;
    target.card.currentHP = 0;
    target.card.energy    = 0;
  }

  const eff = mult > 1 ? ' (Effective!)' : mult < 1 ? ' (Weak)' : '';
  const ko  = !target.card.alive ? ` **${target.card.displayDef.character} is KO'd!**` : '';
  if (isSpecial) {
    state.lastAction = `${state.boss.emoji || '⚔️'} **${state.boss.name}** unleashes a **special attack** on **${target.username}**'s ${target.card.displayDef.character} for **${dmg} DMG**${eff}!${ko}`;
  } else {
    state.lastAction = `${state.boss.emoji || '⚔️'} **${state.boss.name}** strikes **${target.username}**'s ${target.card.displayDef.character} for **${dmg} DMG**${eff}!${ko}`;
  }
}

function rechargeAlivePlayers(state) {
  for (const p of state.players) {
    if (!p.card || !p.card.alive) continue;
    if (p.card.turnsUntilRecharge > 0) { p.card.turnsUntilRecharge--; }
    else { p.card.energy = Math.min(3, (p.card.energy || 0) + 1); }
  }
}

// Runs boss attack + recharge + rebuild queue. Returns true if raid ended.
async function endRound(state) {
  await processBossAttack(state);
  if (state.players.every(p => !p.card || !p.card.alive)) { await handleDefeat(state); return true; }
  rechargeAlivePlayers(state);
  rebuildRoundQueue(state);
  if (state.roundQueue.length === 0) { await handleDefeat(state); return true; }
  return false;
}

async function advanceTurn(state) {
  state.roundIndex++;

  // End of round?
  if (state.roundIndex >= state.roundQueue.length) {
    if (await endRound(state)) return;
  } else {
    // Skip any mid-round dead players (edge: status kill, future features)
    while (state.roundIndex < state.roundQueue.length) {
      const uid = state.roundQueue[state.roundIndex];
      const pp  = state.players.find(p => p.userId === uid);
      if (pp && pp.card && pp.card.alive) break;
      state.roundIndex++;
    }
    if (state.roundIndex >= state.roundQueue.length) {
      if (await endRound(state)) return;
    }
  }

  // ── Auto-skip 0-energy players (iterative, no recursion) ─────────────────
  // We loop up to roundQueue.length times to avoid getting stuck.
  for (let attempts = 0; attempts < state.roundQueue.length * 2; attempts++) {
    const cp = currentPlayer(state);
    if (!cp || !cp.card || !cp.card.alive) break;
    if (cp.card.energy > 0) break;

    // Auto-rest
    cp.card.energy = Math.min(3, (cp.card.energy || 0) + 1);
    const skipNote = `⏭️ **${cp.username}**'s ${cp.card.displayDef.character} has no energy and rests automatically. ${energyBar(cp.card.energy)}`;
    state.lastAction = skipNote + (state.lastAction ? '\n' + state.lastAction.slice(0, 900) : '');

    state.roundIndex++;
    if (state.roundIndex >= state.roundQueue.length) {
      if (await endRound(state)) return;
    } else {
      // Skip dead
      while (state.roundIndex < state.roundQueue.length) {
        const uid = state.roundQueue[state.roundIndex];
        const pp  = state.players.find(p => p.userId === uid);
        if (pp && pp.card && pp.card.alive) break;
        state.roundIndex++;
      }
      if (state.roundIndex >= state.roundQueue.length) {
        if (await endRound(state)) return;
      }
    }
  }

  // ── Apply start-of-turn status effects to the new current player ──────────
  const cp = currentPlayer(state);
  if (cp && cp.card && cp.card.alive) {
    const sotLogs = applyStartOfTurnEffects([cp.card]);
    if (sotLogs.length) {
      state.lastAction = sotLogs.join('\n') + (state.lastAction ? '\n' + state.lastAction.slice(0, 800) : '');
    }
    // Did the card die from bleed/cut?
    if (!cp.card.alive) {
      state.lastAction += `\n💀 **${cp.username}**'s ${cp.card.displayDef.character} was KO'd by a status effect!`;
      if (state.players.every(p => !p.card || !p.card.alive)) {
        await handleDefeat(state);
        return;
      }
      // Recurse once to find next alive player
      await advanceTurn(state);
      return;
    }
  }

  await sendTurnMessage(state);
}

// ─── Full damage pipeline (mirrors isail/duel logic) ─────────────────────────

// Returns { ok, dmg, logs, confused, locked, victory }
function executePlayerAttack(card, action, boss, allPlayerCards) {
  const logs = [];
  const cost = action === 'special' ? 3 : 1;

  // ── Confusion check ───────────────────────────────────────────────────────
  const confChance = getConfusionChance(card);
  if (confChance > 0 && randomInt(1, 100) <= confChance) {
    card.energy = Math.max(0, card.energy - cost);
    card.turnsUntilRecharge = 2;
    const baseDmg  = calculateUserDamage(card, action);
    const attackMod = getAttackModifier(card);
    const selfDmg  = Math.max(0, Math.floor(baseDmg * attackMod));
    card.currentHP = Math.max(0, card.currentHP - selfDmg);
    if (card.currentHP <= 0) { card.alive = false; card.energy = 0; }
    return { confused: true, selfDmg, logs };
  }

  // ── Deduct energy ─────────────────────────────────────────────────────────
  card.energy = Math.max(0, card.energy - cost);
  card.turnsUntilRecharge = 2;

  // ── Bleed on energy use ───────────────────────────────────────────────────
  const bleedLogs = applyBleedOnEnergyUse(card, cost);
  if (bleedLogs.length) logs.push(...bleedLogs);

  // ── Status lock (stun / freeze / dissattack) ──────────────────────────────
  if (hasStatusLock(card)) {
    const reason = getStatusLockReason(card);
    return { locked: true, reason, logs };
  }
  if (hasAttackDisabled(card)) {
    return { locked: true, reason: 'attack-disabled', logs };
  }

  // ── Damage calculation ────────────────────────────────────────────────────
  const baseDmg     = calculateUserDamage(card, action);
  const attrMult    = getDamageMultiplier(card.def.attribute, boss.attribute);
  const attackMod   = getAttackModifier(card);
  const defenseMult = getDefenseMultiplier(card, boss); // uses boss.status (attackdown on boss etc.)
  const dmg         = Math.max(1, Math.floor(baseDmg * attrMult * attackMod * defenseMult));

  boss.currentHP = Math.max(0, boss.currentHP - dmg);
  const victory  = boss.currentHP <= 0;
  if (victory) boss.currentHP = 0;

  const eff = attrMult > 1 ? ' (Effective!)' : attrMult < 1 ? ' (Weak)' : '';

  // ── Card effect on special (star-level gated via buildBattleDef)
  // In raids, special attacks do damage but DO NOT inflict status conditions.
  const effectLogs = [];

  return { ok: true, dmg, eff, effectLogs, logs, victory };
}

// Build a simple result embed: white, boss thumbnail only (no image).
function buildResultEmbed(state) {
  const boss  = state.boss;
  const embed = new EmbedBuilder().setColor('#FFFFFF');
  const emojiId = getEmojiId(boss.emoji);
  if (emojiId) embed.setThumbnail(`https://cdn.discordapp.com/emojis/${emojiId}.png`);
  return embed;
}

async function sendResultEmbed(state, embed) {
  try {
    if (state.battleMessageId) {
      const msg = await state.channel.messages.fetch(state.battleMessageId).catch(() => null);
      if (msg) { await msg.edit({ content: null, embeds: [embed], components: [] }); return; }
    }
    await state.channel.send({ embeds: [embed] });
  } catch (e) { console.error('[raid] sendResultEmbed:', e); }
}

async function handleVictory(state) {
  state.finished = true;
  state.phase    = 'finished';
  clearRaidTimers(state);

  const beli   = BELI_BY_RANK[state.boss.rank] || 100;
  const cardId = state.boss.cardId;
  const lines  = [];
  try {
    console.log(`[raid] handleVictory: rank=${state.boss.rank}, beli=${beli}, players=${(state.players || []).length}`);
  } catch (e) {}

  for (const p of state.players) {
    try {
      const user = await User.findOne({ userId: String(p.userId) });
      if (!user) continue;
      const oldBal = Number(user.balance || 0);
      const newBal = oldBal + Number(beli || 0);
      console.log(`[raid] reward -> user=${user.userId} old=${oldBal} +${beli} => new=${newBal}`);
      user.balance = newBal;
      const owned = (user.ownedCards || []).find(e => String(e.cardId) === String(cardId));
      if (!owned) {
        user.ownedCards.push({ cardId, level: 1, xp: 0, starLevel: 0 });
        lines.push(`- **${p.username}**: received **${state.boss.name}** card + **${beli.toLocaleString()} Beli**`);
      } else {
        const def   = getCardById(cardId);
        const maxLv = def ? (RANK_MAX_LEVEL[def.rank] || 10) : 10;
        const oldLv = owned.level || 1;
        owned.level = Math.min(maxLv, oldLv + 10);
        owned.xp    = 0;
        lines.push(`- **${p.username}**: ${state.boss.name} Lv. ${oldLv} → **${owned.level}** + **${beli.toLocaleString()} Beli**`);
      }
      await user.save();
    } catch (e) { console.error('[raid] reward error:', e); }
  }

  const rewardBlock = lines.join('\n') || '- No surviving players.';
  const embed = buildResultEmbed(state)
    .setTitle('**Victory!**')
    .setDescription(
      `The **${state.crewName}** Crew defeated **${state.boss.name}** and earned:\n\n${rewardBlock}`
    );

  await sendResultEmbed(state, embed);
  raidStates.delete(state.channelId);
}

async function handleDefeat(state) {
  state.finished = true;
  state.phase    = 'finished';
  clearRaidTimers(state);

  const embed = buildResultEmbed(state)
    .setTitle('**Raid Failed!**')
    .setDescription(
      `The **${state.crewName}** Crew was defeated by **${state.boss.name}**.\nAll cards were KO'd — better luck next time!`
    );

  await sendResultEmbed(state, embed);
  raidStates.delete(state.channelId);
}

async function handleTimeout(state) {
  state.finished = true;
  state.phase    = 'finished';
  clearRaidTimers(state);

  const embed = buildResultEmbed(state)
    .setTitle('**Raid Timed Out!**')
    .setDescription(
      `The **${state.crewName}** Crew's raid against **${state.boss.name}** was abandoned due to inactivity.`
    );

  await sendResultEmbed(state, embed);
  raidStates.delete(state.channelId);
}

// ─── Shared card-add logic ────────────────────────────────────────────────────

async function addCardToRaid(state, userId, username, cardQuery, user) {
  if (!state || state.phase !== 'lobby') return { err: 'There is no active raid lobby in this channel.' };
  // Solo mode: the owner bypasses the crew-membership gate
  const ownerSolo = raidSoloMode && userId === OWNER_ID;
  if (!ownerSolo && !state.crewMembers.includes(userId)) return { err: 'Only members of the raid crew can join!' };
  if (state.players.length >= MAX_PLAYERS)   return { err: `The raid is full! (${MAX_PLAYERS} players max)` };
  if (state.players.find(p => p.userId === userId)) return { err: 'You are already in this raid. Remove yourself first.' };

  // Use user-aware search (team/favorites priority) when user doc is provided
  const def = findCardForUser(cardQuery, user);
  if (!def || def.ship || def.artifact) return { err: `Could not find a card matching **${cardQuery}**.` };

  if (!user) user = await User.findOne({ userId });
  if (!user) return { err: 'You need an account first.' };

  const entry = (user.ownedCards || []).find(e => e.cardId === def.id);
  if (!entry) return { err: `You don't own **${def.character}**!` };

  const card = buildPlayerCard(def, entry, user.ownedCards);
  state.players.push({ userId, username, entry, card });
  // Recalculate boss HP scaling whenever a card is added to the lobby.
  try {
    if (state.boss && typeof state.boss.baseHP === 'number') {
      const playersCount = Math.max(1, (state.players || []).length);
      const newMax = Math.floor(state.boss.baseHP * playersCount * 2);
      state.boss.maxHP = newMax;
      state.boss.currentHP = newMax;
    }
  } catch (e) { console.error('[raid] failed to scale boss HP on join:', e); }

  await editLobbyMessage(state);
  return { ok: true, def };
}

async function refundGodToken(userId) {
  try {
    const u = await User.findOne({ userId });
    if (!u) return;
    u.items = addItem(u.items || [], 'god_token', 1);
    await u.save();
  } catch (e) { console.error('[raid] refund error:', e); }
}

// Create a raid state from an external spawn (owner doesn't spend a god token)
async function createRaidFromSpawn(ownerId, ownerUsername, channel, def, crew) {
  const channelId = channel.id;
  if (raidStates.has(channelId)) throw new Error('There is already an active raid in this channel.');

  const boss = buildBossFromDef(def);
  const ownerSolo = false;

  const crewId = crew && crew.crewId ? crew.crewId : null;
  const crewName = crew && crew.name ? crew.name : (ownerUsername + "'s Crew");
  const crewMembers = Array.isArray(crew && crew.members) && crew.members.length ? crew.members.slice() : [String(ownerId)];
  const hostRole = await resolveHostRole(crew || { members: crewMembers }, ownerId).catch(() => ({ emoji: EMOJI.member }));

  const state = {
    channelId,
    messageId: null,
    battleMessageId: null,
    channel,
    ownerId: String(ownerId),
    ownerUsername,
    crewId,
    crewName,
    crewMembers: crewMembers.map(String),
    hostRoleEmoji: hostRole.emoji || EMOJI.member,
    phase: 'lobby',
    boss,
    players: [],
    roundQueue: [],
    roundIndex: 0,
    finished: false,
    lastAction: '',
    startTimeoutId: null,
    turnTimeoutId: null,
    inactTimeoutId: null,
    soloMode: ownerSolo,
    bossSpecialCounter: 0,
    ownerPaidGodToken: false,
  };

  raidStates.set(channelId, state);

  try {
    const msg = await channel.send({ embeds: [buildLobbyEmbed(state)], components: makeLobbyComponents() });
    state.messageId = msg.id;
  } catch (e) {
    // if message send fails, cleanup
    raidStates.delete(channelId);
    throw e;
  }

  // auto-cancel if not enough players join within RAID_TIMEOUT
  state.startTimeoutId = setTimeout(async () => {
    const s = raidStates.get(channelId);
    if (!s || s.phase !== 'lobby') return;
    const minNeeded = s.soloMode ? 1 : MIN_PLAYERS;
    if (s.players.length < minNeeded) {
      try {
        const emojiId = getEmojiId(s.boss.emoji);
        const ce = new EmbedBuilder()
          .setColor('#FFFFFF')
          .setTitle('**Raid Cancelled**')
          .setDescription(`Not enough players joined the raid against **${s.boss.name}** (${s.players.length}/${minNeeded} needed).`);
        if (emojiId) ce.setThumbnail(`https://cdn.discordapp.com/emojis/${emojiId}.png`);
        const msg = await s.channel.messages.fetch(s.messageId).catch(() => null);
        if (msg) await msg.edit({ embeds: [ce], components: [] });
      } catch (_) {}
      raidStates.delete(channelId);
      return;
    }
    await startRaidBattle(s);
  }, RAID_TIMEOUT);

  return state;
}

// ─── Sub-command handlers ─────────────────────────────────────────────────────

async function execBoss(ctx, bossQuery) {
  const { channelId, userId, username, channel } = ctx;

  if (!bossQuery)              return reply(ctx, 'Please provide a boss card name. e.g. `op raid luffy` or `/raid boss luffy`');
  if (raidStates.has(channelId)) return reply(ctx, 'There is already an active raid in this channel!');

  const user = await User.findOne({ userId });
  if (!user) return reply(ctx, 'You need an account first. Use `/start` or `op start`.');

  if (findItemCount(user.items || [], 'god_token') < 1)
    return reply(ctx, `${EMOJI.godToken} You need **1 God Token** to start a raid! You currently have 0.`);

  const def = findCardByQuery(bossQuery);
  if (!def || def.ship || def.artifact) return reply(ctx, `Could not find a card matching **${bossQuery}**.`);

  // ── Solo-mode bypass (owner only) ────────────────────────────────────────
  const ownerSolo = raidSoloMode && userId === OWNER_ID;

  let crew, hostRoleEmoji, crewId, crewName, crewMembers;
  if (ownerSolo) {
    crew          = null;
    hostRoleEmoji = EMOJI.captain;
    crewId        = 'solo';
    crewName      = `${username}'s Solo Raid`;
    crewMembers   = [userId];
  } else {
    crew = await Crew.findOne({ members: userId });
    if (!crew) return reply(ctx, 'You must be in a crew to start a raid! Only crew members can join.');
    const resolved = await resolveHostRole(crew, userId);
    hostRoleEmoji  = resolved.emoji;
    crewId         = crew.crewId;
    crewName       = crew.name;
    crewMembers    = [...(crew.members || [])];
  }

  user.items = removeItem(user.items || [], 'god_token', 1);
  await user.save();

  const boss  = buildBossFromDef(def);
  const state = {
    channelId, messageId: null, battleMessageId: null, channel,
    ownerId: userId, ownerUsername: username, crewId, crewName, crewMembers, hostRoleEmoji,
    phase: 'lobby', boss, players: [],
    roundQueue: [], roundIndex: 0,
    finished: false, lastAction: '', startTimeoutId: null,
    turnTimeoutId: null, inactTimeoutId: null,
    soloMode: ownerSolo,
    bossSpecialCounter: 0,
    ownerPaidGodToken: true,
  };

  raidStates.set(channelId, state);

  const embed = buildLobbyEmbed(state);
  let sentMsg;
  if (ctx.interaction) {
    sentMsg = await ctx.interaction.reply({ embeds: [embed], components: makeLobbyComponents(), fetchReply: true });
  } else {
    sentMsg = await channel.send({ embeds: [embed], components: makeLobbyComponents() });
  }
  state.messageId = sentMsg.id;

  // Auto-cancel after 3 min if not enough players
  state.startTimeoutId = setTimeout(async () => {
    const s = raidStates.get(channelId);
    if (!s || s.phase !== 'lobby') return;
    // Solo-mode raids only need 1 player (the owner); normal raids need MIN_PLAYERS
    const minNeeded = s.soloMode ? 1 : MIN_PLAYERS;
    if (s.players.length < minNeeded) {
      try {
        const emojiId = getEmojiId(s.boss.emoji);
        const ce = new EmbedBuilder()
          .setColor('#FFFFFF')
          .setTitle('**Raid Cancelled**')
          .setDescription(`Not enough players joined the raid against **${s.boss.name}** (${s.players.length}/${minNeeded} needed).` +
            (s.ownerPaidGodToken ? `\n${EMOJI.godToken} God Token refunded to **${s.ownerUsername}**.` : ''));
        if (emojiId) ce.setThumbnail(`https://cdn.discordapp.com/emojis/${emojiId}.png`);
        const msg = await channel.messages.fetch(s.messageId).catch(() => null);
        if (msg) await msg.edit({ embeds: [ce], components: [] });
      } catch (_) {}
      if (s.ownerPaidGodToken) await refundGodToken(s.ownerId);
      raidStates.delete(channelId);
      return;
    }
    await startRaidBattle(s);
  }, RAID_TIMEOUT);
}

async function execAdd(ctx, cardQuery) {
  if (!cardQuery) return reply(ctx, 'Please specify a card. e.g. `op raid add zoro`');
  const state = raidStates.get(ctx.channelId);
  const user  = await User.findOne({ userId: ctx.userId });
  const result = await addCardToRaid(state, ctx.userId, ctx.username, cardQuery, user);
  if (result.err) return reply(ctx, result.err);
  const d = result.def;
  if (ctx.interaction)
    return ctx.interaction.reply({ content: `${d.emoji || ''} **${d.character}** joined the raid!`.trim(), ephemeral: false });
  return ctx.channel.send(`${d.emoji || ''} **${ctx.username}**'s **${d.character}** joined the raid!`.trim());
}

async function execRemove(ctx) {
  const state = raidStates.get(ctx.channelId);
  if (!state || state.phase !== 'lobby') return reply(ctx, 'There is no active raid lobby in this channel.');
  const idx = state.players.findIndex(p => p.userId === ctx.userId);
  if (idx === -1) return reply(ctx, 'You are not in this raid.');
  const removed = state.players.splice(idx, 1)[0];
  // Recalculate boss HP scaling when a card is removed from the lobby
  try {
    if (state.boss && typeof state.boss.baseHP === 'number') {
      const playersCount = Math.max(1, (state.players || []).length);
      const newMax = Math.floor(state.boss.baseHP * playersCount * 2);
      state.boss.maxHP = newMax;
      state.boss.currentHP = newMax;
    }
  } catch (e) { console.error('[raid] failed to scale boss HP on remove:', e); }

  await editLobbyMessage(state);
  return reply(ctx, `Removed **${removed.card?.displayDef?.character || 'your card'}** from the raid.`);
}

async function execForceStart(ctx) {
  const state = raidStates.get(ctx.channelId);
  if (!state || state.phase !== 'lobby') return reply(ctx, 'There is no active raid lobby in this channel.');
  if (state.ownerId !== ctx.userId)      return reply(ctx, 'Only the raid owner can force-start.');
  if (state.players.length === 0)        return reply(ctx, 'No players have joined yet!');
  if (state.startTimeoutId) { clearTimeout(state.startTimeoutId); state.startTimeoutId = null; }
  if (ctx.interaction) {
    await ctx.interaction.reply({ content: 'Starting the raid!', ephemeral: true });
  } else {
    await ctx.channel.send('Starting the raid!');
  }
  await startRaidBattle(state);
}

async function execCancel(ctx) {
  const state = raidStates.get(ctx.channelId);
  if (!state)                        return reply(ctx, 'There is no active raid in this channel.');
  if (state.ownerId !== ctx.userId)  return reply(ctx, 'Only the raid host can cancel.');
  if (state.phase !== 'lobby')       return reply(ctx, 'You can only cancel during the lobby phase.');
  if (state.startTimeoutId) { clearTimeout(state.startTimeoutId); state.startTimeoutId = null; }
  try {
    const msg = await state.channel.messages.fetch(state.messageId).catch(() => null);
    if (msg) {
      const ce = buildLobbyEmbed(state);
      ce.setTitle(`${state.boss.name} | Raid Cancelled`);
      ce.setColor('#888888');
      ce.setFooter({ text: state.ownerPaidGodToken ? 'Raid cancelled by the host. God Token refunded.' : 'Raid cancelled by the host.' });
      await msg.edit({ embeds: [ce], components: [] });
    }
  } catch (_) {}
  if (state.ownerPaidGodToken) await refundGodToken(state.ownerId);
  raidStates.delete(ctx.channelId);
  return reply(ctx, state.ownerPaidGodToken ? `${EMOJI.godToken} Raid cancelled. Your God Token has been refunded.` : 'Raid cancelled.');
}

// ─── Main execute ─────────────────────────────────────────────────────────────

module.exports = {
  name: 'raid',

  async execute({ message, interaction, args }) {
    const userId    = message ? message.author.id       : interaction.user.id;
    const username  = message ? message.author.username : interaction.user.username;
    const channelId = message ? message.channelId       : interaction.channelId;
    const channel   = message ? message.channel         : interaction.channel;
    const ctx       = { message, interaction, userId, username, channelId, channel };

    if (interaction) {
      const sub = interaction.options.getSubcommand(false);
      if (!sub || sub === 'boss') return execBoss(ctx, interaction.options.getString('boss'));
      if (sub === 'add')          return execAdd(ctx, interaction.options.getString('card'));
      if (sub === 'remove')       return execRemove(ctx);
      if (sub === 'start')        return execForceStart(ctx);
      if (sub === 'cancel')       return execCancel(ctx);
      return;
    }

    const sub = (args?.[0] || '').toLowerCase();
    if (sub === 'add')    return execAdd(ctx, args.slice(1).join(' ').trim());
    if (sub === 'remove') return execRemove(ctx);
    if (sub === 'start')  return execForceStart(ctx);
    if (sub === 'cancel') return execCancel(ctx);
    return execBoss(ctx, args.join(' ').trim());
  },

  // ─── Button handler ───────────────────────────────────────────────────────

  async handleButton(interaction, customId) {
    const channelId = interaction.channelId;
    const userId    = interaction.user.id;
    const username  = interaction.user.username;
    const state     = raidStates.get(channelId);

    if (!state) return interaction.reply({ content: 'This raid is no longer active.', ephemeral: true });

    // ── Join Raid — show modal ────────────────────────────────────────────────
    if (customId === 'raid_join') {
      if (state.phase !== 'lobby')
        return interaction.reply({ content: 'The raid has already started!', ephemeral: true });
      if (!state.crewMembers.includes(userId))
        return interaction.reply({ content: 'Only members of the raid crew can join!', ephemeral: true });
      if (state.players.find(p => p.userId === userId))
        return interaction.reply({ content: 'You are already in this raid.', ephemeral: true });
      if (state.players.length >= MAX_PLAYERS)
        return interaction.reply({ content: `The raid is full! (${MAX_PLAYERS} players max)`, ephemeral: true });

      const modal = new ModalBuilder().setCustomId('raid_join_modal').setTitle('Join Raid');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('card_name')
          .setLabel('Enter your card name')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Zoro, Luffy Gear 4, uss_luffy')
          .setRequired(true)
          .setMaxLength(100),
      ));
      return interaction.showModal(modal);
    }

    // ── Start Raid button ────────────────────────────────────────────────────
    if (customId === 'raid_start') {
      if (state.ownerId !== userId)
        return interaction.reply({ content: 'Only the raid owner can start the raid early.', ephemeral: true });
      if (state.phase !== 'lobby')
        return interaction.reply({ content: 'The raid has already started.', ephemeral: true });
      if (state.players.length === 0)
        return interaction.reply({ content: 'No players have joined yet!', ephemeral: true });
      const minNeeded = state.soloMode ? 1 : MIN_PLAYERS;
      if (state.players.length < minNeeded)
        return interaction.reply({ content: `You need at least **${minNeeded} players** to start a raid. (${state.players.length}/${minNeeded} joined)`, ephemeral: true });
      if (state.startTimeoutId) { clearTimeout(state.startTimeoutId); state.startTimeoutId = null; }
      await interaction.deferUpdate();
      await startRaidBattle(state);
      return;
    }

    // ── Battle action buttons ────────────────────────────────────────────────
    if (!customId.startsWith('raid_action:')) return;

    if (state.phase !== 'battle')
      return interaction.reply({ content: 'The raid has not started yet.', ephemeral: true });
    if (state.finished)
      return interaction.reply({ content: 'The raid is already over.', ephemeral: true });

    const cp = currentPlayer(state);
    if (!cp || cp.userId !== userId)
      return interaction.reply({ content: "It's not your turn!", ephemeral: true });

    const card = cp.card;
    if (!card || !card.alive)
      return interaction.reply({ content: "Your card has been KO'd!", ephemeral: true });

    const action = customId.split(':')[1];
    await interaction.deferUpdate();

    // Reset the whole-raid inactivity watchdog — a human responded
    resetInactivityTimer(state);

    // ── Rest ─────────────────────────────────────────────────────────────────
    if (action === 'rest') {
      if (card.turnsUntilRecharge > 0) { card.turnsUntilRecharge = Math.max(0, card.turnsUntilRecharge - 1); }
      else { card.energy = Math.min(3, (card.energy || 0) + 1); }
      state.lastAction = `${card.displayDef.emoji || ''} **${cp.username}**'s ${card.displayDef.character} rests and recharges. ${energyBar(card.energy)}`.trim();
      await advanceTurn(state);
      return;
    }

    // ── Attack / Special ─────────────────────────────────────────────────────
    if (action === 'attack' || action === 'special') {
      const cost = action === 'special' ? 3 : 1;
      if (card.energy < cost) {
        await interaction.followUp({ content: `Not enough energy! (need ${cost}, have ${card.energy})`, ephemeral: true });
        return;
      }

      const allPlayerCards = state.players.map(p => p.card).filter(c => c && c.alive);
      const result         = executePlayerAttack(card, action, state.boss, allPlayerCards);

      if (result.confused) {
        const logs = result.logs.length ? '\n' + result.logs.join('\n') : '';
        state.lastAction = `${card.displayDef.emoji || ''} **${cp.username}**'s ${card.displayDef.character} is confused and strikes themselves for **${result.selfDmg} DMG**!${logs}`.trim();
        if (!card.alive) {
          if (state.players.every(p => !p.card || !p.card.alive)) { await handleDefeat(state); return; }
        }
        await advanceTurn(state);
        return;
      }

      if (result.locked) {
        const reason = result.reason === 'attack-disabled' ? 'attack-disabled' : getStatusLockReason(card);
        const bleedPart = result.logs.length ? '\n' + result.logs.join('\n') : '';
        state.lastAction = `${card.displayDef.emoji || ''} **${cp.username}**'s ${card.displayDef.character} is ${reason || 'locked'} and cannot act!${bleedPart}`.trim();
        await advanceTurn(state);
        return;
      }

      // Build battle log
      const atkLabel   = action === 'special' ? (card.def.special_attack?.name || 'Special') : 'attacks';
      const dmgLine    = `${card.displayDef.emoji || ''} **${cp.username}**'s ${card.displayDef.character} ${atkLabel} **${state.boss.name}** for **${result.dmg} DMG**${result.eff}!`.trim();
      const allLogs    = [dmgLine, ...result.effectLogs, ...result.logs].filter(Boolean);
      state.lastAction = allLogs.join('\n').slice(0, 1024);

      if (result.victory) {
        await handleVictory(state);
        return;
      }

      await advanceTurn(state);
      return;
    }
  },

  // ─── Modal handler — Join Raid card picker ────────────────────────────────

  async handleJoinModal(interaction) {
    const channelId = interaction.channelId;
    const userId    = interaction.user.id;
    const username  = interaction.user.username;
    const cardQuery = interaction.fields.getTextInputValue('card_name');
    const state     = raidStates.get(channelId);
    const user      = await User.findOne({ userId });
    const result    = await addCardToRaid(state, userId, username, cardQuery, user);
    if (result.err) return interaction.reply({ content: result.err, ephemeral: true });
    return interaction.reply({
      content: `${result.def.emoji || ''} **${username}**'s **${result.def.character}** joined the raid!`.trim(),
      ephemeral: false,
    });
  },

  getRaidState(channelId) { return raidStates.get(channelId); },
  createRaidFromSpawn,
  toggleRaidSoloMode,
  isRaidSoloMode,
};
