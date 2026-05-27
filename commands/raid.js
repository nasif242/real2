const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const User  = require('../models/User');
const Crew  = require('../models/Crew');
const { getCardById, searchCards }        = require('../utils/cards');
const { resolveStats }                    = require('../utils/statResolver');
const { getDamageMultiplier }             = require('../utils/attributeSystem');
const { calculateUserDamage, hasStatusLock, getStatusLockReason } = require('../src/battle/statusManager');
const { RANK_MAX_LEVEL, isSpecialAttackUnlocked } = require('../utils/starLevel');

// ─── Constants ────────────────────────────────────────────────────────────────

const raidStates    = new Map();   // channelId → state
const BELI_BY_RANK  = { D: 100, C: 300, B: 700, A: 1200, S: 2000, SS: 2800, UR: 3500 };
const RAID_TIMEOUT  = 3 * 60 * 1000;
const MAX_PLAYERS   = 10;
const MIN_PLAYERS   = 3;

const EMOJI = {
  godToken:  '<:godtoken:1499957056650608753>',
  captain:   '<:captain:1508200434274406470>',
  viceCap:   '🔱',
  member:    '⚓',
  energy:    '<:energy:1478051414558118052>',
  hpFL:      '<:Healthfullleft:1481750264074469437>',
  hpFM:      '<:healthfullmiddle:1481750286795149435>',
  hpFR:      '<:healthfullright:1481750302679105710>',
  hpEL:      '<:Healthemptyleft:1481750325151928391>',
  hpEM:      '<:Healthemptymiddle:1481750341489004596>',
  hpER:      '<:healthemptyright:1481750363286667334>',
};

// ─── Small utilities ──────────────────────────────────────────────────────────

function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function findItemCount(items, id) {
  if (!Array.isArray(items)) return 0;
  const it = items.find(i => i.itemId === id);
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

function hpBar(cur, max) {
  if (max <= 0 || cur <= 0) return EMOJI.hpEL + EMOJI.hpEM.repeat(6) + EMOJI.hpER;
  const filled = Math.floor(Math.max(0, Math.min(1, cur / max)) * 6);
  return EMOJI.hpFL
    + EMOJI.hpFM.repeat(filled)
    + EMOJI.hpEM.repeat(6 - filled)
    + (filled === 6 ? EMOJI.hpFR : EMOJI.hpER);
}

function energyBar(e) { return e > 0 ? EMOJI.energy.repeat(Math.min(e, 3)) : '0'; }

function getEmojiId(emoji) {
  if (!emoji) return null;
  const m = emoji.match(/<a?:[^:]+:(\d+)>/);
  return m ? m[1] : null;
}

function findCardByQuery(q) {
  if (!q) return null;
  const byId = getCardById(q.trim());
  if (byId) return byId;
  const r = searchCards(q.trim());
  return r && r.length ? r[0] : null;
}

// ─── ctx reply helpers ────────────────────────────────────────────────────────

async function reply(ctx, content, ephemeral = true) {
  if (typeof content === 'string') content = { content };
  if (ctx.interaction) {
    if (ctx.interaction.deferred || ctx.interaction.replied)
      return ctx.interaction.followUp({ ...content, ephemeral }).catch(() => {});
    return ctx.interaction.reply({ ...content, ephemeral }).catch(() => {});
  }
  if (ctx.message) return ctx.message.reply(content).catch(() => {});
}

// ─── Crew role helper ─────────────────────────────────────────────────────────

async function resolveHostRole(crew, userId) {
  if (crew.captainId === userId) return { role: 'captain', emoji: EMOJI.captain };
  try {
    const docs = await User.find({ userId: { $in: crew.members } }, 'userId bounty');
    const non  = docs.filter(d => d.userId !== crew.captainId);
    if (non.length) {
      const vc = non.reduce((b, u) => (u.bounty ?? 100) > (b.bounty ?? 100) ? u : b);
      if (vc.userId === userId) return { role: 'vicecaptain', emoji: EMOJI.viceCap };
    }
  } catch (_) {}
  return { role: 'member', emoji: EMOJI.member };
}

// ─── Boss / player card builders ──────────────────────────────────────────────

function buildBossFromDef(def) {
  const hp   = def.health || def.hp || 100;
  const bMin = typeof def.attack_min === 'number' ? def.attack_min : (def.power || 20);
  const bMax = typeof def.attack_max === 'number' ? def.attack_max : bMin;
  return {
    name: def.character || 'Boss', title: def.title || '',
    emoji: def.emoji || '', image: def.image_url || def.image || null,
    cardId: def.id, rank: def.rank || 'D', attribute: def.attribute || 'STR',
    maxHP: Math.floor(hp * 5), currentHP: Math.floor(hp * 5),
    attack_min: Math.floor(bMin * 2),
    attack_max: Math.max(Math.floor(bMin * 2), Math.floor(bMax * 2)),
    status: []
  };
}

function buildPlayerCard(def, entry, ownedCards) {
  const scaled = resolveStats(entry, ownedCards);
  const maxHP  = scaled ? scaled.health : (def.health || def.hp || 100);
  return { def, entry, scaled, maxHP, currentHP: maxHP, energy: 3, alive: true, status: [], turnsUntilRecharge: 0 };
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

// ─── Embed builders ───────────────────────────────────────────────────────────

function buildLobbyEmbed(state) {
  const boss  = state.boss;
  const title = `${boss.name}${boss.title ? ` - ${boss.title}` : ''} | Boss Raid`;
  const embed = new EmbedBuilder().setColor('#FFFFFF').setTitle(title);

  // Description: host + crew
  const roleEmoji = state.hostRoleEmoji || EMOJI.member;
  embed.setDescription(
    `**Host:** ${state.ownerUsername} ${roleEmoji}\n**Crew:** ${state.crewName}`
  );

  const emojiId = getEmojiId(boss.emoji);
  if (emojiId) embed.setThumbnail(`https://cdn.discordapp.com/emojis/${emojiId}.png`);
  if (boss.image) embed.setImage(boss.image);

  embed.addFields({
    name: `${boss.emoji || ''} **${boss.name}**`.trim(),
    value: `${hpBar(boss.currentHP, boss.maxHP)}\n${boss.name} | Raid boss\n${boss.currentHP}/${boss.maxHP}`,
    inline: false
  });

  embed.addFields({ name: '\u200b', value: '\u200b', inline: false });

  if (state.players.length === 0) {
    embed.addFields({ name: '\u200b', value: '_no cards added yet …_', inline: false });
  } else {
    const sorted = [...state.players].sort((a, b) => (b.card?.def?.speed || 0) - (a.card?.def?.speed || 0));
    for (const p of sorted) {
      if (!p.card) continue;
      embed.addFields({
        name: `${p.card.def.emoji || ''} ${p.username}`.trim(),
        value: `${p.card.def.character} | Lv. ${p.entry?.level ?? 1} | Spd: ${p.card.def.speed || 0}\n${hpBar(p.card.currentHP, p.card.maxHP)}\n${p.card.currentHP}/${p.card.maxHP} ${energyBar(p.card.energy)}`,
        inline: true
      });
    }
  }

  embed.setFooter({ text: `Click "Join Raid" or use \`op raid add <card>\` • ${state.players.length}/${MAX_PLAYERS} players` });
  return embed;
}

function buildBattleEmbed(state) {
  const boss  = state.boss;
  const title = `${boss.name}${boss.title ? ` - ${boss.title}` : ''} | Boss Raid`;
  const embed = new EmbedBuilder().setColor('#FFFFFF').setTitle(title);

  const emojiId = getEmojiId(boss.emoji);
  if (emojiId) embed.setThumbnail(`https://cdn.discordapp.com/emojis/${emojiId}.png`);
  if (boss.image) embed.setImage(boss.image);

  embed.addFields({
    name: `${boss.emoji || ''} **${boss.name}**`.trim(),
    value: `${hpBar(boss.currentHP, boss.maxHP)}\n${boss.name} | Raid boss\n${boss.currentHP}/${boss.maxHP}`,
    inline: false
  });

  embed.addFields({ name: '\u200b', value: '\u200b', inline: false });

  const cp     = currentPlayer(state);
  const sorted = [...state.players].sort((a, b) => (b.card?.def?.speed || 0) - (a.card?.def?.speed || 0));

  for (const p of sorted) {
    if (!p.card) continue;
    const isTurn = !state.finished && cp && p.userId === cp.userId;
    const val = p.card.alive
      ? `${hpBar(p.card.currentHP, p.card.maxHP)}\nLv. ${p.entry?.level ?? 1} | ${energyBar(p.card.energy)}`
      : `**KO'd**\n${hpBar(0, p.card.maxHP)}`;
    embed.addFields({
      name: `${isTurn ? '▶ ' : ''}${p.card.def.emoji || ''} ${p.username} — ${p.card.def.character}`.trim(),
      value: val,
      inline: true
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
    new ButtonBuilder().setCustomId('raid_start').setLabel('Start Raid').setStyle(ButtonStyle.Danger)
  )];
}

function makeBattleComponents(state) {
  if (state.finished) return [];
  const cp = currentPlayer(state);
  if (!cp || !cp.card || !cp.card.alive) return [];

  const card   = cp.card;
  const locked = hasStatusLock(card);
  const row    = new ActionRowBuilder();

  row.addComponents(
    new ButtonBuilder()
      .setCustomId('raid_action:attack')
      .setLabel('Attack')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(locked || card.energy < 1)
  );

  if (card.def.special_attack && isSpecialAttackUnlocked(card.entry?.starLevel)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('raid_action:special')
        .setLabel('Special Attack')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(locked || card.energy < 3)
    );
  }

  row.addComponents(
    new ButtonBuilder().setCustomId('raid_action:rest').setLabel('Rest').setStyle(ButtonStyle.Success)
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

// Sends a fresh battle embed each turn; strips buttons from the previous one.
async function sendTurnMessage(state) {
  try {
    // Strip components from the previous battle message
    if (state.battleMessageId) {
      const old = await state.channel.messages.fetch(state.battleMessageId).catch(() => null);
      if (old) await old.edit({ components: [] }).catch(() => {});
    }

    const cp         = currentPlayer(state);
    const embed      = buildBattleEmbed(state);
    const components = makeBattleComponents(state);
    const content    = (cp && !state.finished) ? `<@${cp.userId}> it's your turn!` : null;

    const payload = { embeds: [embed], components };
    if (content) payload.content = content;

    const msg = await state.channel.send(payload);
    state.battleMessageId = msg.id;
  } catch (e) {
    console.error('[raid] sendTurnMessage:', e);
  }
}

// ─── Battle logic ─────────────────────────────────────────────────────────────

async function startRaidBattle(state) {
  state.phase = 'battle';
  if (state.startTimeoutId) { clearTimeout(state.startTimeoutId); state.startTimeoutId = null; }

  // Disable lobby buttons
  try {
    const lobbyMsg = await state.channel.messages.fetch(state.messageId).catch(() => null);
    if (lobbyMsg) await lobbyMsg.edit({ components: [] }).catch(() => {});
  } catch (_) {}

  rebuildRoundQueue(state);
  state.lastAction = '⚔️ The raid has begun! Players attack in order of speed.';
  state.battleMessageId = null;
  await sendTurnMessage(state);
}

async function processBossAttack(state) {
  const alive = state.players.filter(p => p.card && p.card.alive);
  if (!alive.length) return;

  const target = alive[randomInt(0, alive.length - 1)];
  const atk    = randomInt(state.boss.attack_min, state.boss.attack_max);
  const mult   = getDamageMultiplier(state.boss.attribute, target.card.def.attribute);
  const dmg    = Math.max(1, Math.floor(atk * mult));

  target.card.currentHP = Math.max(0, target.card.currentHP - dmg);
  if (target.card.currentHP <= 0) {
    target.card.alive = false;
    target.card.currentHP = 0;
    target.card.energy = 0;
  }

  const eff = mult > 1 ? ' (Effective!)' : mult < 1 ? ' (Weak)' : '';
  const ko  = !target.card.alive ? ` **${target.card.def.character} is KO'd!**` : '';
  state.lastAction = `${state.boss.emoji || '⚔️'} **${state.boss.name}** strikes **${target.username}**'s ${target.card.def.character} for **${dmg} DMG**${eff}!${ko}`;
}

function rechargeAlivePlayers(state) {
  for (const p of state.players) {
    if (!p.card || !p.card.alive) continue;
    if (p.card.turnsUntilRecharge > 0) { p.card.turnsUntilRecharge--; }
    else { p.card.energy = Math.min(3, (p.card.energy || 0) + 1); }
  }
}

async function endRound(state) {
  // Boss attacks, then recharge, then rebuild queue
  await processBossAttack(state);
  if (state.players.every(p => !p.card || !p.card.alive)) { await handleDefeat(state); return true; }
  rechargeAlivePlayers(state);
  rebuildRoundQueue(state);
  if (state.roundQueue.length === 0) { await handleDefeat(state); return true; }
  return false;
}

async function advanceTurn(state) {
  state.roundIndex++;

  // Check if this round is exhausted
  if (state.roundIndex >= state.roundQueue.length) {
    if (await endRound(state)) return;
  } else {
    // Skip any dead players mid-round (edge case: status kills, etc.)
    while (state.roundIndex < state.roundQueue.length) {
      const pid = state.roundQueue[state.roundIndex];
      const pp  = state.players.find(p => p.userId === pid);
      if (pp && pp.card && pp.card.alive) break;
      state.roundIndex++;
    }
    // If skipping burned through the rest of the queue, trigger end-of-round
    if (state.roundIndex >= state.roundQueue.length) {
      if (await endRound(state)) return;
    }
  }

  await sendTurnMessage(state);
}

async function handleVictory(state) {
  state.finished = true;
  state.phase    = 'finished';

  const beli  = BELI_BY_RANK[state.boss.rank] || 100;
  const cardId = state.boss.cardId;
  const lines  = [];

  for (const p of state.players) {
    try {
      const user = await User.findOne({ userId: p.userId });
      if (!user) continue;
      user.balance = (user.balance || 0) + beli;

      const owned = user.ownedCards.find(e => e.cardId === cardId);
      if (!owned) {
        user.ownedCards.push({ cardId, level: 1, xp: 0, starLevel: 0 });
        lines.push(`**${p.username}**: received **${state.boss.name}** card + **${beli.toLocaleString()} Beli**`);
      } else {
        const def      = getCardById(cardId);
        const maxLevel = def ? (RANK_MAX_LEVEL[def.rank] || 10) : 10;
        const oldLv    = owned.level || 1;
        owned.level    = Math.min(maxLevel, oldLv + 10);
        owned.xp       = 0;
        lines.push(`**${p.username}**: ${state.boss.name} Lv. ${oldLv} → **${owned.level}** + **${beli.toLocaleString()} Beli**`);
      }
      await user.save();
    } catch (e) { console.error('[raid] reward error:', e); }
  }

  const embed = buildBattleEmbed(state);
  embed.setTitle(`🏆 Victory! ${state.boss.name} defeated!`);
  embed.setColor('#FFD700');
  embed.addFields({ name: '🎁 Rewards', value: lines.join('\n') || 'No surviving players.', inline: false });

  try {
    if (state.battleMessageId) {
      const msg = await state.channel.messages.fetch(state.battleMessageId).catch(() => null);
      if (msg) await msg.edit({ content: null, embeds: [embed], components: [] });
    } else {
      await state.channel.send({ embeds: [embed] });
    }
  } catch (e) { console.error('[raid] victory send error:', e); }

  raidStates.delete(state.channelId);
}

async function handleDefeat(state) {
  state.finished = true;
  state.phase    = 'finished';

  const embed = buildBattleEmbed(state);
  embed.setTitle(`💀 Raid Failed! ${state.boss.name} was victorious!`);
  embed.setColor('#000000');
  embed.addFields({ name: 'Result', value: 'All player cards were KO\'d. Better luck next time!', inline: false });

  try {
    if (state.battleMessageId) {
      const msg = await state.channel.messages.fetch(state.battleMessageId).catch(() => null);
      if (msg) await msg.edit({ content: null, embeds: [embed], components: [] });
    } else {
      await state.channel.send({ embeds: [embed] });
    }
  } catch (e) { console.error('[raid] defeat send error:', e); }

  raidStates.delete(state.channelId);
}

// ─── Shared add-card logic (used by prefix, slash, and modal) ─────────────────

async function addCardToRaid(state, userId, username, cardQuery) {
  if (!state || state.phase !== 'lobby') return { err: 'There is no active raid lobby in this channel.' };
  if (!state.crewMembers.includes(userId)) return { err: 'Only members of the raid crew can join!' };
  if (state.players.length >= MAX_PLAYERS) return { err: `The raid is full! (${MAX_PLAYERS} players max)` };
  if (state.players.find(p => p.userId === userId)) return { err: 'You are already in this raid. Remove yourself first.' };

  const def = findCardByQuery(cardQuery);
  if (!def || def.ship || def.artifact) return { err: `Could not find a card matching **${cardQuery}**.` };

  const user = await User.findOne({ userId });
  if (!user) return { err: 'You need an account first.' };

  const entry = (user.ownedCards || []).find(e => e.cardId === def.id);
  if (!entry) return { err: `You don't own **${def.character}**!` };

  const card = buildPlayerCard(def, entry, user.ownedCards);
  state.players.push({ userId, username, entry, card });
  await editLobbyMessage(state);
  return { ok: true, def };
}

// ─── Sub-command handlers ─────────────────────────────────────────────────────

async function execBoss(ctx, bossQuery) {
  const { channelId, userId, username, channel } = ctx;

  if (!bossQuery) return reply(ctx, 'Please provide a boss card name. e.g. `op raid luffy` or `/raid boss luffy`');
  if (raidStates.has(channelId)) return reply(ctx, 'There is already an active raid in this channel!');

  const user = await User.findOne({ userId });
  if (!user) return reply(ctx, 'You need an account first. Use `/start` or `op start` to register.');

  if (findItemCount(user.items || [], 'god_token') < 1) {
    return reply(ctx, `${EMOJI.godToken} You need **1 God Token** to start a raid! You currently have 0.`);
  }

  const def = findCardByQuery(bossQuery);
  if (!def || def.ship || def.artifact) return reply(ctx, `Could not find a card matching **${bossQuery}**.`);

  const crew = await Crew.findOne({ members: userId });
  if (!crew) return reply(ctx, 'You must be in a crew to start a raid! Only crew members can join.');

  const { emoji: hostRoleEmoji } = await resolveHostRole(crew, userId);

  // Deduct God Token
  user.items = removeItem(user.items || [], 'god_token', 1);
  await user.save();

  const boss  = buildBossFromDef(def);
  const state = {
    channelId,
    messageId: null,
    battleMessageId: null,
    channel,
    ownerId: userId,
    ownerUsername: username,
    crewId: crew.crewId,
    crewName: crew.name,
    crewMembers: [...(crew.members || [])],
    hostRoleEmoji,
    phase: 'lobby',
    boss,
    players: [],
    roundQueue: [],
    roundIndex: 0,
    finished: false,
    lastAction: '',
    startTimeoutId: null
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

  // Auto-cancel after 3 minutes if not enough players
  state.startTimeoutId = setTimeout(async () => {
    const s = raidStates.get(channelId);
    if (!s || s.phase !== 'lobby') return;

    if (s.players.length < MIN_PLAYERS) {
      try {
        const msg = await channel.messages.fetch(s.messageId).catch(() => null);
        if (msg) {
          const ce = buildLobbyEmbed(s);
          ce.setTitle(`${s.boss.name} | Raid Cancelled`);
          ce.setColor('#888888');
          ce.setFooter({ text: `Not enough players (${s.players.length}/${MIN_PLAYERS} needed). Raid cancelled — God Token refunded.` });
          await msg.edit({ embeds: [ce], components: [] });
        }
      } catch (_) {}
      await refundGodToken(s.ownerId);
      raidStates.delete(channelId);
      return;
    }
    await startRaidBattle(s);
  }, RAID_TIMEOUT);
}

async function execAdd(ctx, cardQuery) {
  if (!cardQuery) return reply(ctx, 'Please specify a card. e.g. `op raid add zoro` or `/raid add zoro`');
  const state  = raidStates.get(ctx.channelId);
  const result = await addCardToRaid(state, ctx.userId, ctx.username, cardQuery);
  if (result.err) return reply(ctx, result.err);

  if (ctx.interaction) {
    return ctx.interaction.reply({ content: `${result.def.emoji || ''} **${result.def.character}** joined the raid!`.trim(), ephemeral: false });
  }
  return ctx.channel.send(`${result.def.emoji || ''} **${ctx.username}**'s **${result.def.character}** joined the raid!`.trim());
}

async function execRemove(ctx) {
  const state = raidStates.get(ctx.channelId);
  if (!state || state.phase !== 'lobby') return reply(ctx, 'There is no active raid lobby in this channel.');
  const idx = state.players.findIndex(p => p.userId === ctx.userId);
  if (idx === -1) return reply(ctx, 'You are not in this raid.');
  const removed = state.players.splice(idx, 1)[0];
  await editLobbyMessage(state);
  return reply(ctx, `Removed **${removed.card?.def?.character || 'your card'}** from the raid.`);
}

async function execForceStart(ctx) {
  const state = raidStates.get(ctx.channelId);
  if (!state || state.phase !== 'lobby') return reply(ctx, 'There is no active raid lobby in this channel.');
  if (state.ownerId !== ctx.userId) return reply(ctx, 'Only the raid owner can force-start.');
  if (state.players.length === 0) return reply(ctx, 'No players have joined yet!');
  if (state.startTimeoutId) { clearTimeout(state.startTimeoutId); state.startTimeoutId = null; }

  if (ctx.interaction) {
    await ctx.interaction.reply({ content: '⚔️ Starting the raid!', ephemeral: true });
  } else {
    await ctx.channel.send('⚔️ Starting the raid!');
  }
  await startRaidBattle(state);
}

async function execCancel(ctx) {
  const state = raidStates.get(ctx.channelId);
  if (!state) return reply(ctx, 'There is no active raid in this channel.');
  if (state.ownerId !== ctx.userId) return reply(ctx, 'Only the raid host can cancel the raid.');
  if (state.phase !== 'lobby') return reply(ctx, 'You can only cancel a raid while it is in the lobby phase.');

  if (state.startTimeoutId) { clearTimeout(state.startTimeoutId); state.startTimeoutId = null; }

  try {
    const msg = await state.channel.messages.fetch(state.messageId).catch(() => null);
    if (msg) {
      const ce = buildLobbyEmbed(state);
      ce.setTitle(`${state.boss.name} | Raid Cancelled`);
      ce.setColor('#888888');
      ce.setFooter({ text: 'Raid cancelled by the host. God Token refunded.' });
      await msg.edit({ embeds: [ce], components: [] });
    }
  } catch (_) {}

  await refundGodToken(state.ownerId);
  raidStates.delete(ctx.channelId);

  return reply(ctx, `${EMOJI.godToken} Raid cancelled. Your God Token has been refunded.`);
}

async function refundGodToken(userId) {
  try {
    const u = await User.findOne({ userId });
    if (!u) return;
    u.items = addItem(u.items || [], 'god_token', 1);
    await u.save();
  } catch (e) { console.error('[raid] refund error:', e); }
}

// ─── Main execute (slash + prefix) ───────────────────────────────────────────

module.exports = {
  name: 'raid',

  async execute({ message, interaction, args }) {
    const userId   = message ? message.author.id : interaction.user.id;
    const username = message ? message.author.username : interaction.user.username;
    const channelId = message ? message.channelId : interaction.channelId;
    const channel  = message ? message.channel : interaction.channel;
    const ctx      = { message, interaction, userId, username, channelId, channel };

    if (interaction) {
      const sub = interaction.options.getSubcommand(false);
      if (!sub || sub === 'boss')   return execBoss(ctx, interaction.options.getString('boss'));
      if (sub === 'add')            return execAdd(ctx, interaction.options.getString('card'));
      if (sub === 'remove')         return execRemove(ctx);
      if (sub === 'start')          return execForceStart(ctx);
      if (sub === 'cancel')         return execCancel(ctx);
      return;
    }

    // Prefix: op raid [subcommand] [rest...]
    const sub = (args?.[0] || '').toLowerCase();
    if (sub === 'add')    return execAdd(ctx, args.slice(1).join(' ').trim());
    if (sub === 'remove') return execRemove(ctx);
    if (sub === 'start')  return execForceStart(ctx);
    if (sub === 'cancel') return execCancel(ctx);
    // anything else = boss query
    return execBoss(ctx, args.join(' ').trim());
  },

  // ─── Button handler ───────────────────────────────────────────────────────

  async handleButton(interaction, customId) {
    const channelId = interaction.channelId;
    const userId    = interaction.user.id;
    const username  = interaction.user.username;
    const state     = raidStates.get(channelId);

    if (!state) return interaction.reply({ content: 'This raid is no longer active.', ephemeral: true });

    // ── Join Raid button — show modal ───────────────────────────────────────
    if (customId === 'raid_join') {
      if (state.phase !== 'lobby') {
        return interaction.reply({ content: 'The raid has already started!', ephemeral: true });
      }
      if (!state.crewMembers.includes(userId)) {
        return interaction.reply({ content: 'Only members of the raid crew can join!', ephemeral: true });
      }
      if (state.players.find(p => p.userId === userId)) {
        return interaction.reply({ content: 'You are already in this raid.', ephemeral: true });
      }
      if (state.players.length >= MAX_PLAYERS) {
        return interaction.reply({ content: `The raid is full! (${MAX_PLAYERS} players max)`, ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId('raid_join_modal')
        .setTitle('Join Raid');

      const input = new TextInputBuilder()
        .setCustomId('card_name')
        .setLabel('Enter your card name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Zoro, Luffy Gear 4, uss_luffy')
        .setRequired(true)
        .setMaxLength(100);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    // ── Start Raid button ───────────────────────────────────────────────────
    if (customId === 'raid_start') {
      if (state.ownerId !== userId) {
        return interaction.reply({ content: 'Only the raid owner can start the raid early.', ephemeral: true });
      }
      if (state.phase !== 'lobby') {
        return interaction.reply({ content: 'The raid has already started.', ephemeral: true });
      }
      if (state.players.length === 0) {
        return interaction.reply({ content: 'No players have joined yet!', ephemeral: true });
      }
      if (state.startTimeoutId) { clearTimeout(state.startTimeoutId); state.startTimeoutId = null; }
      await interaction.deferUpdate();
      await startRaidBattle(state);
      return;
    }

    // ── Battle action buttons ───────────────────────────────────────────────
    if (!customId.startsWith('raid_action:')) return;

    if (state.phase !== 'battle') {
      return interaction.reply({ content: 'The raid has not started yet.', ephemeral: true });
    }
    if (state.finished) {
      return interaction.reply({ content: 'The raid is already over.', ephemeral: true });
    }

    const cp = currentPlayer(state);
    if (!cp || cp.userId !== userId) {
      return interaction.reply({ content: "It's not your turn!", ephemeral: true });
    }
    const card = cp.card;
    if (!card || !card.alive) {
      return interaction.reply({ content: "Your card has been KO'd!", ephemeral: true });
    }

    const action = customId.split(':')[1];
    await interaction.deferUpdate();

    if (action === 'rest') {
      if (card.turnsUntilRecharge > 0) { card.turnsUntilRecharge = Math.max(0, card.turnsUntilRecharge - 1); }
      else { card.energy = Math.min(3, (card.energy || 0) + 1); }
      state.lastAction = `${card.def.emoji || ''} **${cp.username}**'s ${card.def.character} rests and recharges. ${energyBar(card.energy)}`.trim();
      await advanceTurn(state);
      return;
    }

    if (action === 'attack' || action === 'special') {
      const cost = action === 'special' ? 3 : 1;
      if (card.energy < cost) {
        return interaction.followUp({ content: `Not enough energy! (need ${cost}, have ${card.energy})`, ephemeral: true });
      }

      card.energy = Math.max(0, card.energy - cost);
      card.turnsUntilRecharge = 2;

      if (hasStatusLock(card)) {
        const reason = getStatusLockReason(card);
        state.lastAction = `${card.def.emoji || ''} **${cp.username}**'s ${card.def.character} is ${reason} and cannot act!`.trim();
        await advanceTurn(state);
        return;
      }

      const baseDmg = calculateUserDamage(card, action);
      const mult    = getDamageMultiplier(card.def.attribute, state.boss.attribute);
      const dmg     = Math.max(1, Math.floor(baseDmg * mult));
      state.boss.currentHP = Math.max(0, state.boss.currentHP - dmg);

      const eff      = mult > 1 ? ' (Effective!)' : mult < 1 ? ' (Weak)' : '';
      const atkLabel = action === 'special' ? (card.def.special_attack || 'Special') : 'attacks';
      state.lastAction = `${card.def.emoji || ''} **${cp.username}**'s ${card.def.character} ${atkLabel} **${state.boss.name}** for **${dmg} DMG**${eff}!`.trim();

      if (state.boss.currentHP <= 0) {
        state.boss.currentHP = 0;
        await handleVictory(state);
        return;
      }

      await advanceTurn(state);
    }
  },

  // ─── Modal handler (Join Raid card picker) ────────────────────────────────

  async handleJoinModal(interaction) {
    const channelId = interaction.channelId;
    const userId    = interaction.user.id;
    const username  = interaction.user.username;
    const cardQuery = interaction.fields.getTextInputValue('card_name');
    const state     = raidStates.get(channelId);

    const result = await addCardToRaid(state, userId, username, cardQuery);
    if (result.err) {
      return interaction.reply({ content: result.err, ephemeral: true });
    }
    return interaction.reply({
      content: `${result.def.emoji || ''} **${username}**'s **${result.def.character}** joined the raid!`.trim(),
      ephemeral: false
    });
  },

  getRaidState(channelId) { return raidStates.get(channelId); }
};
