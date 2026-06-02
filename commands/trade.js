const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User = require('../models/User');
const { getCardById, formatCardId } = require('../utils/cards');
const { levelers } = require('../data/levelers');

// Local item display mapping (kept in sync with `commands/inventory.js`)
const ITEM_DISPLAY_NAMES = {
  red_shard: 'Red Shard',
  blue_shard: 'Blue Shard',
  green_shard: 'Green Shard',
  yellow_shard: 'Yellow Shard',
  purple_shard: 'Purple Shard'
};
const ITEM_DISPLAY_EMOJIS = {
  red_shard: '<:RedShard:1494106374492131439>',
  blue_shard: '<:Blueshard:1494106500149411980>',
  green_shard: '<:GreenShard:1494106686963581039>',
  yellow_shard: '<:YellowShard:1494106825627406530>',
  purple_shard: '<:PurpleShard:1494106958582776008>'
};

function parseMention(mention) {
  if (!mention) return null;
  const m = mention.match(/^<@!?(\d+)>$/);
  return m ? m[1] : null;
}

function shardCostForRank(rank) {
  switch ((rank || '').toUpperCase()) {
    case 'A': return 1;
    case 'S': return 2;
    case 'SS': return 3;
    case 'UR': return 4;
    default: return 0;
  }
}

function shardIdForAttribute(attr) {
  switch ((attr || '').toUpperCase()) {
    case 'DEX': return 'green_shard';
    case 'STR': return 'red_shard';
    case 'PSY': return 'yellow_shard';
    case 'QCK': return 'blue_shard';
    case 'INT': return 'purple_shard';
    default: return null;
  }
}

function findItemCount(items, itemId) {
  if (!Array.isArray(items)) return 0;
  const it = items.find(i => i.itemId === itemId);
  return it ? (it.quantity || 0) : 0;
}

function removeItem(items, itemId, count) {
  if (!Array.isArray(items) || count <= 0) return items;
  const idx = items.findIndex(i => i.itemId === itemId);
  if (idx === -1) return items;
  items[idx].quantity = (items[idx].quantity || 0) - count;
  if (items[idx].quantity <= 0) items.splice(idx, 1);
  return items;
}

function totalXpFromEntry(entry) {
  const lvl = (entry && typeof entry.level === 'number') ? entry.level : 1;
  const xp = (entry && typeof entry.xp === 'number') ? entry.xp : 0;
  // Treat each physical card copy as worth `level * 100 + xp` XP when
  // converting duplicates into XP. This makes a level 1 copy worth 100 XP
  // (matching duplicate rewards) and preserves higher-level progress.
  return (lvl * 100) + xp;
}

function applyIncomingEntryAsXp(user, incomingEntry) {
  if (!user || !incomingEntry) return false;
  user.ownedCards = user.ownedCards || [];
  const existing = user.ownedCards.find(e => e.cardId === incomingEntry.cardId);
  if (!existing) return false;
  const incomingXp = totalXpFromEntry(incomingEntry);
  existing.xp = (existing.xp || 0) + incomingXp;
  const gained = Math.floor(existing.xp / 100);
  if (gained > 0) {
    existing.level = (existing.level || 1) + gained;
    existing.xp = existing.xp % 100;
  }
  return true;
}

function cardHasArtifactEquipped(user, cardId) {
  if (!user || !Array.isArray(user.ownedCards) || !cardId) return false;
  return user.ownedCards.some(e => {
    const def = getCardById(e.cardId);
    return def && def.artifact && e.equippedTo === cardId;
  });
}

// Simple in-memory session map for pending trades
if (!global.tradeSessions) global.tradeSessions = new Map();

module.exports = {
  name: 'trade',
  description: 'Propose a trade: card-for-card or beli-for-card. Use `*` prefix for beli (e.g. *100)',
  options: [
    { name: 'offer', type: 3, description: 'Offered cardId or *<beli>', required: true },
    { name: 'want', type: 3, description: 'Requested cardId', required: true },
    { name: 'target', type: 6, description: 'Target user', required: true }
  ],

  async execute({ message, interaction, args }) {
    const initiatorId = message ? message.author.id : interaction.user.id;
    const initiatorName = message ? message.author.username : interaction.user.username;
    // Parse arguments. Support legacy single-item format and a new
    // multi-item format for message commands: "offer1, offer2, *50 . want1, *700 @user"
    let offered = null;
    let requested = null;
    let offeredList = null;
    let requestedList = null;
    let targetId = null;

    // Leveler class keywords used by parseTradeItem (define early to avoid TDZ when parsing message-mode lists)
    const LEVELER_CLASSES = new Set(['str', 'qck', 'int', 'psy', 'dex', 'all']);

    // helper to find a leveler by id or name (accept id or compact name without spaces)
    function findLeveler(query) {
      if (!query) return null;
      const q = String(query).toLowerCase().replace(/\s+/g, '');
      const exact = levelers.find(l => l.id.toLowerCase() === q || l.name.toLowerCase().replace(/\s+/g, '') === q || l.name.toLowerCase() === q);
      if (exact) return exact;
      // acronym match: first letter of each word e.g. "prp" → "Purple Robber Penguin"
      const acronym = levelers.find(l => l.name.toLowerCase().split(/\s+/).map(w => w[0] || '').join('') === q);
      return acronym || null;
    }

    // Build card acronym index once per trade invocation
    const { cards: allCards } = require('../data/cards');
    const crews = require('../data/crews');
    function getAcronym(name) {
      return String(name).toLowerCase().split(/\s+/).map(w => w[0] || '').join('');
    }

    function findCardByAcronym(query) {
      const q = String(query).toLowerCase();
      // Exact acronym match first
      const exact = allCards.filter(c => !c.artifact && !c.ship && !c.boost && getAcronym(c.character || '') === q);
      if (exact.length === 1) return exact[0];
      // If multiple exact matches, prefer non-ship/artifact (already filtered) — return first
      if (exact.length > 1) return exact[0];
      return null;
    }

    function parseTradeItem(raw) {
      if (typeof raw === 'string' && raw.startsWith('*')) {
        const amt = parseInt(raw.slice(1).replace(/[^0-9]/g, ''), 10);
        if (isNaN(amt) || amt < 1) return null;
        return { kind: 'beli', amount: amt };
      }

      // Leveler class shorthand (STR, QCK, INT, PSY, DEX, ALL)
      if (typeof raw === 'string' && LEVELER_CLASSES.has(raw.toLowerCase())) {
        return { kind: 'leveler_class', attribute: raw.toUpperCase() };
      }

      // Strip optional trailing quantity (e.g. "prp10" → base="prp", qty=10)
      const qtyMatch = typeof raw === 'string' ? raw.match(/^([a-zA-Z_\-]+?)(\d+)$/) : null;
      const baseRaw = qtyMatch ? qtyMatch[1] : raw;
      const qty = qtyMatch ? parseInt(qtyMatch[2], 10) : 1;

      // leveler? (try both full raw and base)
      const levelerDef = findLeveler(raw) || (qtyMatch ? findLeveler(baseRaw) : null);
      if (levelerDef) return { kind: 'leveler', id: levelerDef.id, def: levelerDef, qty };

      // card by exact id/name?
      const cardDef = getCardById(raw) || (qtyMatch ? getCardById(baseRaw) : null);
      if (cardDef) return { kind: 'card', id: cardDef.id, def: cardDef, qty };

      // card by acronym (e.g. "prp" → purple robber penguin)
      const acronymCard = findCardByAcronym(baseRaw);
      if (acronymCard) return { kind: 'card', id: acronymCard.id, def: acronymCard, qty };

      // crew pack? accept compact names (spadepirates), with/without 'pack', or acronyms (SPP)
      if (typeof baseRaw === 'string') {
        const q = baseRaw.toLowerCase().replace(/[^a-z0-9]/g, '');
        for (const crew of crews) {
          const normalized = String(crew.name).toLowerCase().replace(/[^a-z0-9]/g, '');
          if (normalized === q || (normalized + 'pack') === q || q.includes(normalized)) {
            return { kind: 'pack', crewName: crew.name, qty };
          }
          // acronym match: first letters of words, also try with 'p' for pack (e.g. Spade Pirates Pack -> spp)
          const words = String(crew.name).toLowerCase().split(/\s+/).filter(Boolean);
          const acr = words.map(w => w[0] || '').join('');
          if (acr === q || (acr + 'p') === q) return { kind: 'pack', crewName: crew.name, qty };
        }
      }

      return null;
    }

    if (message) {
      const joined = (args || []).join(' ').trim();

      // Prefer explicit Discord mention if present
      if (message.mentions && message.mentions.users && message.mentions.users.size > 0) {
        targetId = message.mentions.users.first().id;
      } else {
        // Try to detect a numeric user id token in args (fallback)
        const maybe = (args || []).find(a => /^\d{17,19}$/.test(a));
        if (maybe) targetId = maybe;
      }

      // Strip mentions from the joined string so parsing isn't affected
      let rawNoMention = joined.replace(/<@!?\d+>/g, '').trim();
      if (targetId && !rawNoMention) rawNoMention = joined; // fallback

      // Dot (.) separates offered side from requested side. Commas separate multiple items.
      if (rawNoMention.includes('.')) {
        const dotIndex = rawNoMention.indexOf('.');
        const left = rawNoMention.slice(0, dotIndex).trim();
        const right = rawNoMention.slice(dotIndex + 1).trim();
        const leftItems = left.split(',').map(s => s.trim()).filter(Boolean).map(s => s.replace(/^[.,]+|[.,]+$/g, ''));
        const rightItems = right.split(',').map(s => s.trim()).filter(Boolean).map(s => s.replace(/^[.,]+|[.,]+$/g, ''));
        offeredList = leftItems.map(i => i.trim()).filter(Boolean);
        requestedList = rightItems.map(i => i.trim()).filter(Boolean);
      } else {
        // Legacy: first two tokens are offer and want
        if (args && args.length) offeredList = [args[0]];
        if (args && args.length > 1) requestedList = [args[1]];
        // last possible token may be a mention (id or <@...>) - if not already found, try args[2]
        if (!targetId && args && args.length > 2) {
          const maybe = args[2];
          targetId = parseMention(maybe) || ( /^\d{17,19}$/.test(maybe) ? maybe : null );
        }
      }

      if (!offeredList || !requestedList || !offeredList.length || !requestedList.length || !targetId) {
        const reply = 'Usage: op trade <offer|*<beli>|<leveler>> <wanted|*<beli>|<leveler>> <@user>  OR  op trade item1,item2 . want1,want2 @user';
        if (message) return message.reply(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }

      // Parse each offered/requested token
      const parsedOffered = offeredList.map(parseTradeItem);
      const parsedRequested = requestedList.map(parseTradeItem);
      if (parsedOffered.some(p => !p) || parsedRequested.some(p => !p)) {
        const r = 'Unable to find one or more offered/requested items. Use card id/acronym, leveler id/name, or *<amount> for beli.';
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }

      // If both sides have only one item, keep legacy single-item flow
        if (parsedOffered.length === 1 && parsedRequested.length === 1) {
          offered = parsedOffered[0];
          requested = parsedRequested[0];
          // If either side is a pack, convert to multi-session so pack logic is handled
          if ((offered && offered.kind === 'pack') || (requested && requested.kind === 'pack')) {
            offeredList = [offered];
            requestedList = [requested];
            offered = null; requested = null;
          }
          // targetId already computed
        } else {
          offeredList = parsedOffered;
          requestedList = parsedRequested;
          // create a multi-item session below
        }
    } else {
      // Interaction (slash) path: keep original single-item option parsing
      const rawOffer = interaction.options.getString('offer');
      const rawWant = interaction.options.getString('want');
      const mention = interaction.options.getUser('target')?.id;
      targetId = mention;
      offered = parseTradeItem(rawOffer);
      requested = parseTradeItem(rawWant);
      if (!offered || !requested || !targetId) {
        const reply = 'Usage: /trade <offer> <want> <target>'; 
        return interaction.reply({ content: reply, ephemeral: true });
      }
      // If either side is a pack in slash mode, convert to multi session handling
      if ((offered && offered.kind === 'pack') || (requested && requested.kind === 'pack')) {
        offeredList = [offered];
        requestedList = [requested];
        offered = null; requested = null;
      }
    }

    if (targetId === initiatorId) {
      const r = 'Cannot trade with yourself.';
      if (message) return message.reply(r);
      return interaction.reply({ content: r, ephemeral: true });
    }

    const initiator = await User.findOne({ userId: initiatorId });
    const target = await User.findOne({ userId: targetId });
    if (!initiator) return (message ? message.reply('You have no account.') : interaction.reply({ content: 'You have no account.', ephemeral: true }));
    if (!target) return (message ? message.reply('Target has no account.') : interaction.reply({ content: 'Target has no account.', ephemeral: true }));

    

    const sessionId = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const session = { id: sessionId, initiatorId, targetId, createdAt: Date.now() };

    // If we built multi lists, create a multi-type session
    if (!offered && !requested && offeredList && requestedList) {
      session.type = 'multi';
      session.offeredList = offeredList;
      session.requestedList = requestedList;
    }

    // Validate ownership / funds depending on kinds
    // Multi-item trade handling
    if (session.type === 'multi') {
      const offeredListLocal = session.offeredList || [];
      const requestedListLocal = session.requestedList || [];

      // helper to sum beli amounts
      const sumBeli = (list) => (list || []).filter(i => i.kind === 'beli').reduce((s, i) => s + (i.amount || 0), 0);
      const offeredBeliTotal = sumBeli(offeredListLocal);
      const requestedBeliTotal = sumBeli(requestedListLocal);

      // basic balance checks
      if ((initiator.balance || 0) < offeredBeliTotal) {
        const r = `You do not have ¥${offeredBeliTotal}.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if ((target.balance || 0) < requestedBeliTotal) {
        const r = `Target does not have ¥${requestedBeliTotal}.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }

      // verify ownership/availability for cards/levelers
      for (const it of offeredListLocal) {
        if (!it) continue;
        if (it.kind === 'card') {
          const have = (initiator.ownedCards || []).some(e => e.cardId === it.id);
          if (!have) {
            const r = `You do not own ${it.def?.emoji || ''} **${it.def?.character || it.id}**.`;
            if (message) return message.reply(r);
            return interaction.reply({ content: r, ephemeral: true });
          }
          if ((initiator.team || []).includes(it.id)) {
            const r = 'You must remove the offered card from your team before trading it.';
            if (message) return message.reply(r);
            return interaction.reply({ content: r, ephemeral: true });
          }
          if (cardHasArtifactEquipped(initiator, it.id)) {
            const r = 'You must unequip any artifact attached to the offered card before trading it.';
            if (message) return message.reply(r);
            return interaction.reply({ content: r, ephemeral: true });
          }
        }
        if (it.kind === 'leveler') {
          const qtyNeed = Math.max(1, it.qty || 1);
          const itemHave = (initiator.items || []).find(i => i.itemId === it.id && (i.quantity || 0) >= qtyNeed);
          if (!itemHave) {
            const r = `You do not have ${qtyNeed}x **${it.def?.name || it.id}**.`;
            if (message) return message.reply(r);
            return interaction.reply({ content: r, ephemeral: true });
          }
        }
        if (it.kind === 'leveler_class') {
          const r = 'Trading by leveler class is not supported in multi-item trades. Use single-item trades.';
          if (message) return message.reply(r);
          return interaction.reply({ content: r, ephemeral: true });
        }
        if (it.kind === 'pack') {
          const need = Math.max(1, it.qty || 1);
          const have = (initiator.packInventory && initiator.packInventory[it.crewName]) || 0;
          if (have < need) {
            const r = `You do not have ${need}x ${it.crewName} packs.`;
            if (message) return message.reply(r);
            return interaction.reply({ content: r, ephemeral: true });
          }
        }
      }

      for (const it of requestedListLocal) {
        if (!it) continue;
        if (it.kind === 'card') {
          const have = (target.ownedCards || []).some(e => e.cardId === it.id);
          if (!have) {
            const r = `Target does not own ${it.def?.emoji || ''} **${it.def?.character || it.id}**.`;
            if (message) return message.reply(r);
            return interaction.reply({ content: r, ephemeral: true });
          }
          if ((target.team || []).includes(it.id)) {
            const r = 'Target must remove the requested card from their team before trading.';
            if (message) return message.reply(r);
            return interaction.reply({ content: r, ephemeral: true });
          }
          if (cardHasArtifactEquipped(target, it.id)) {
            const r = 'Target must unequip any artifact attached to the requested card before trading.';
            if (message) return message.reply(r);
            return interaction.reply({ content: r, ephemeral: true });
          }
        }
        if (it.kind === 'leveler') {
          const qtyNeed = Math.max(1, it.qty || 1);
          const itemHave = (target.items || []).find(i => i.itemId === it.id && (i.quantity || 0) >= qtyNeed);
          if (!itemHave) {
            const r = `Target does not have ${qtyNeed}x **${it.def?.name || it.id}**.`;
            if (message) return message.reply(r);
            return interaction.reply({ content: r, ephemeral: true });
          }
        }
        if (it.kind === 'leveler_class') {
          const r = 'Trading by leveler class is not supported in multi-item trades. Use single-item trades.';
          if (message) return message.reply(r);
          return interaction.reply({ content: r, ephemeral: true });
        }
        if (it.kind === 'pack') {
          const need = Math.max(1, it.qty || 1);
          const have = (target.packInventory && target.packInventory[it.crewName]) || 0;
          if (have < need) {
            const r = `Target does not have ${need}x ${it.crewName} packs.`;
            if (message) return message.reply(r);
            return interaction.reply({ content: r, ephemeral: true });
          }
        }
      }

      // Compute and validate shard requirements aggregated per side
      const aggShards = (list) => {
        const map = {};
        for (const it of list) {
          if (it.kind !== 'card') continue;
          const sid = shardIdForAttribute(it.def?.attribute || '');
          const cnt = shardCostForRank(it.def?.rank || '');
          if (sid && cnt > 0) map[sid] = (map[sid] || 0) + cnt;
        }
        return map;
      };
      const offeredShards = aggShards(offeredListLocal);
      const requestedShards = aggShards(requestedListLocal);
      // Persist shard aggregates into the session so the confirmation embed can show them
      session.offeredShardTotals = offeredShards;
      session.requestedShardTotals = requestedShards;

      for (const [sid, cnt] of Object.entries(offeredShards)) {
        const have = findItemCount(initiator.items || [], sid);
        if (have < cnt) {
          const sname = ITEM_DISPLAY_NAMES[sid] || sid;
          const semoji = ITEM_DISPLAY_EMOJIS[sid] || '';
          const r = `You need ${semoji} ${sname} x${cnt} to offer these cards (you have ${have}).`;
          if (message) return message.reply(r);
          return interaction.reply({ content: r, ephemeral: true });
        }
      }
      for (const [sid, cnt] of Object.entries(requestedShards)) {
        const have = findItemCount(target.items || [], sid);
        if (have < cnt) {
          const sname = ITEM_DISPLAY_NAMES[sid] || sid;
          const semoji = ITEM_DISPLAY_EMOJIS[sid] || '';
          const r = `Target needs ${semoji} ${sname} x${cnt} to offer these cards (they have ${have}).`;
          if (message) return message.reply(r);
          return interaction.reply({ content: r, ephemeral: true });
        }
      }

      // All validations passed — proceed to confirmation embed below using the same session object
    }
    // card <-> card
    else if (offered.kind === 'card' && requested.kind === 'card') {
      const offeredEntry = (initiator.ownedCards || []).find(e => e.cardId === offered.id);
      if (!offeredEntry) {
        const r = `You do not own ${offered.def.emoji || ''} **${offered.def.character || offered.id}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      const targetEntry = (target.ownedCards || []).find(e => e.cardId === requested.id);
      if (!targetEntry) {
        const r = `Target does not own ${requested.def.emoji || ''} **${requested.def.character || requested.id}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      // Prevent trading cards that are on teams
      if ((initiator.team || []).includes(offered.id)) {
        const r = 'You must remove the offered card from your team before trading it.';
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if ((target.team || []).includes(requested.id)) {
        const r = 'Target must remove the requested card from their team before trading.';
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if (cardHasArtifactEquipped(target, requested.id)) {
        const r = 'Target must unequip any artifact attached to this card before trading.';
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if (cardHasArtifactEquipped(initiator, offered.id)) {
        const r = 'You must unequip any artifact attached to this card before trading.';
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }

      session.type = 'card_for_card';
      session.offered = { cardId: offered.id, entry: offeredEntry };
      session.requested = { cardId: requested.id, entry: targetEntry };

      // compute shard requirements for both sides (based on card attribute & rank)
      const offeredShardId = shardIdForAttribute(offered.def.attribute || '');
      const offeredShardCount = shardCostForRank(offered.def.rank || '');
      const requestedShardId = shardIdForAttribute(requested.def.attribute || '');
      const requestedShardCount = shardCostForRank(requested.def.rank || '');
      session.offeredShard = { shardId: offeredShardId, count: offeredShardCount };
      session.requestedShard = { shardId: requestedShardId, count: requestedShardCount };

      if (session.offeredShard.count > 0 && session.offeredShard.shardId) {
        const have = findItemCount(initiator.items || [], session.offeredShard.shardId);
        if (have < session.offeredShard.count) {
          const sname = ITEM_DISPLAY_NAMES[session.offeredShard.shardId] || session.offeredShard.shardId;
          const semoji = ITEM_DISPLAY_EMOJIS[session.offeredShard.shardId] || '';
          const r = `You need ${semoji} ${sname} x${session.offeredShard.count} to offer this card (you have ${have}).`;
          if (message) return message.reply(r);
          return interaction.reply({ content: r, ephemeral: true });
        }
      }
    }
    // beli <-> card (initiator beli buying card)
    else if (offered.kind === 'beli' && requested.kind === 'card') {
      const beliAmt = offered.amount;
      if ((initiator.balance || 0) < beliAmt) {
        const r = `You do not have ¥${beliAmt}.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      const targetEntry = (target.ownedCards || []).find(e => e.cardId === requested.id);
      if (!targetEntry) {
        const r = `Target does not own ${requested.def.emoji || ''} **${requested.def.character || requested.id}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if ((target.team || []).includes(requested.id)) {
        const r = 'Target must remove the requested card from their team before trading.';
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      session.type = 'beli_for_card';
      session.beli = beliAmt;
      session.requested = { cardId: requested.id, entry: targetEntry };
      // compute shard requirement for the requested card (buyer may need shards)
      const shardId = shardIdForAttribute(requested.def.attribute || '');
      const shardCount = shardCostForRank(requested.def.rank || '');
      if (shardCount > 0 && shardId) session.shardReq = { shardId, count: shardCount };
    }
    // card offered, requesting beli (reverse)
    else if (offered.kind === 'card' && requested.kind === 'beli') {
      const requestedAmt = requested.amount;
      const offeredEntry = (initiator.ownedCards || []).find(e => e.cardId === offered.id);
      if (!offeredEntry) {
        const r = `You do not own ${offered.def.emoji || ''} **${offered.def.character || offered.id}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if ((initiator.team || []).includes(offered.id)) {
        const r = 'You must remove the offered card from your team before trading it.';
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if (cardHasArtifactEquipped(initiator, offered.id)) {
        const r = 'You must unequip any artifact attached to this card before trading.';
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      session.type = 'card_for_beli';
      session.offered = { cardId: offered.id, entry: offeredEntry };
      session.requested = { beli: requestedAmt };
    }
    // leveler related trades (no shards)
    else if (offered.kind === 'beli' && requested.kind === 'leveler') {
      const amount = offered.amount;
      const qty = Math.max(1, requested.qty || 1);
      if ((initiator.balance || 0) < amount) {
        const r = `You do not have ¥${amount}.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      const item = (target.items || []).find(i => i.itemId === requested.id && (i.quantity || 0) >= qty);
      if (!item) {
        const r = `Target does not have ${qty}x **${requested.def.name}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      session.type = 'beli_for_leveler';
      session.beli = amount;
      session.qty = qty;
      session.requested = { levelerId: requested.id };
    }
    else if (offered.kind === 'leveler' && requested.kind === 'beli') {
      const qty = Math.max(1, offered.qty || 1);
      const item = (initiator.items || []).find(i => i.itemId === offered.id && (i.quantity || 0) >= qty);
      if (!item) {
        const r = `You do not have ${qty}x **${offered.def.name}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      session.type = 'leveler_for_beli';
      session.qty = qty;
      session.offered = { levelerId: offered.id };
      session.requested = { beli: requested.amount };
    }
    else if (offered.kind === 'leveler' && requested.kind === 'leveler') {
      const offeredQty = Math.max(1, offered.qty || 1);
      const requestedQty = Math.max(1, requested.qty || 1);
      const itemA = (initiator.items || []).find(i => i.itemId === offered.id && (i.quantity || 0) >= offeredQty);
      const itemB = (target.items || []).find(i => i.itemId === requested.id && (i.quantity || 0) >= requestedQty);
      if (!itemA) {
        const r = `You do not have ${offeredQty}x **${offered.def.name}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if (!itemB) {
        const r = `Target does not have ${requestedQty}x **${requested.def.name}**.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      session.type = 'leveler_for_leveler';
      session.offeredQty = offeredQty;
      session.requestedQty = requestedQty;
      session.offered = { levelerId: offered.id };
      session.requested = { levelerId: requested.id };
    }
    // leveler_class offered for beli: e.g. "trade STR *40 @user"
    else if (offered.kind === 'leveler_class' && requested.kind === 'beli') {
      const attr = offered.attribute;
      // Collect all levelers of this class from the initiator's inventory
      const isRainbow = l => typeof l.xp === 'object' && l.xp !== null;
      const matchingLevelers = levelers.filter(l => {
        if (attr === 'ALL') return true;
        if (isRainbow(l)) return false;
        return l.attribute === attr;
      });
      const snapshot = [];
      for (const def of matchingLevelers) {
        const it = (initiator.items || []).find(i => i.itemId === def.id && (i.quantity || 0) > 0);
        if (it) snapshot.push({ levelerId: def.id, name: def.name, emoji: def.emoji, qty: it.quantity });
      }
      if (!snapshot.length) {
        const r = `You have no ${attr === 'ALL' ? '' : attr + ' '}levelers to trade.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      session.type = 'leveler_class_for_beli';
      session.attribute = attr;
      session.snapshot = snapshot;
      session.requested = { beli: requested.amount };
    }
    // beli offered for leveler class: e.g. "trade *40 STR @user"
    else if (offered.kind === 'beli' && requested.kind === 'leveler_class') {
      const attr = requested.attribute;
      const isRainbow = l => typeof l.xp === 'object' && l.xp !== null;
      const matchingLevelers = levelers.filter(l => {
        if (attr === 'ALL') return true;
        if (isRainbow(l)) return false;
        return l.attribute === attr;
      });
      const snapshot = [];
      for (const def of matchingLevelers) {
        const it = (target.items || []).find(i => i.itemId === def.id && (i.quantity || 0) > 0);
        if (it) snapshot.push({ levelerId: def.id, name: def.name, emoji: def.emoji, qty: it.quantity });
      }
      if (!snapshot.length) {
        const r = `Target has no ${attr === 'ALL' ? '' : attr + ' '}levelers to trade.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      if ((initiator.balance || 0) < offered.amount) {
        const r = `You do not have ¥${offered.amount}.`;
        if (message) return message.reply(r);
        return interaction.reply({ content: r, ephemeral: true });
      }
      session.type = 'beli_for_leveler_class';
      session.attribute = attr;
      session.snapshot = snapshot;
      session.beli = offered.amount;
    }
    else {
      const r = 'This combination of trade types is not supported.';
      if (message) return message.reply(r);
      return interaction.reply({ content: r, ephemeral: true });
    }

    // Build confirmation embed for target to accept/decline
    // Build user-friendly display strings from the parsed offer/request
    function formatItemDisplay(item) {
      if (!item) return 'Unknown';
      if (item.kind === 'beli') return `¥${(item.amount || 0).toLocaleString()}`;
      if (item.kind === 'leveler') {
        const qtyLabel = item.qty && item.qty > 1 ? `${item.qty}x ` : '';
        return `${qtyLabel}${item.def?.name || item.id} (leveler)`;
      }
      if (item.kind === 'leveler_class') {
        return `All ${item.attribute} levelers`;
      }
      if (item.kind === 'card') {
        const def = item.def || getCardById(item.id) || {};
        if (def.ship) return `${def.character || item.id} (ship) (${def.rank || ''})`;
        return `${def.emoji || ''} ${def.character || item.id} (${def.rank || ''})`;
      }
      if (item.kind === 'pack') {
        const qtyLabel = item.qty && item.qty > 1 ? ` x${item.qty}` : '';
        return `${item.crewName} Pack${qtyLabel}`;
      }
      return String(item.id || item.amount || item);
    }

    let offeredDisplay;
    let requestedDisplay;
    if (session.type === 'multi') {
      offeredDisplay = (session.offeredList || []).map(formatItemDisplay).join(', ');
      requestedDisplay = (session.requestedList || []).map(formatItemDisplay).join(', ');
    } else {
      offeredDisplay = formatItemDisplay(offered);
      requestedDisplay = formatItemDisplay(requested);
    }

    const embed = new EmbedBuilder()
      .setTitle('Trade Proposal')
      .setColor('#2b2d31')
      .setDescription(`<@${initiatorId}> proposes a trade to <@${targetId}>`)
      .addFields(
        { name: 'Offered', value: offeredDisplay, inline: true },
        { name: 'Requested', value: requestedDisplay, inline: true }
      )
      .setFooter({ text: 'Accept to complete the trade. Both users will have items updated.' });

    // For class-based leveler trades, show what's in the snapshot
    if (session.type === 'leveler_class_for_beli' || session.type === 'beli_for_leveler_class') {
      const snap = session.snapshot || [];
      const snapDisplay = snap.map(e => `${e.emoji || ''} **${e.name}** x${e.qty}`).join('\n') || 'None';
      embed.addFields({ name: `Levelers (${session.attribute})`, value: snapDisplay, inline: false });
    }

    // If this is a card-for-card trade and either side requires shards, show both sides' requirements
    if (session.type === 'card_for_card' && (session.offeredShard?.count > 0 || session.requestedShard?.count > 0)) {
      const lines = [];
      if (session.offeredShard?.count > 0 && session.offeredShard?.shardId) {
        const sid = session.offeredShard.shardId;
        const sname = ITEM_DISPLAY_NAMES[sid] || sid;
        const semoji = ITEM_DISPLAY_EMOJIS[sid] || '';
        lines.push(`<@${initiatorId}> (offering): ${semoji} ${sname} x${session.offeredShard.count}`);
      } else {
        lines.push(`<@${initiatorId}> (offering): None`);
      }
      if (session.requestedShard?.count > 0 && session.requestedShard?.shardId) {
        const sid = session.requestedShard.shardId;
        const sname = ITEM_DISPLAY_NAMES[sid] || sid;
        const semoji = ITEM_DISPLAY_EMOJIS[sid] || '';
        lines.push(`<@${targetId}> (offering): ${semoji} ${sname} x${session.requestedShard.count}`);
      } else {
        lines.push(`<@${targetId}> (offering): None`);
      }
      embed.addFields({ name: 'Shard Requirements', value: lines.join('\n'), inline: false });
    }

    // For multi-item trades, show aggregated shard requirements if any
    if (session.type === 'multi' && (session.offeredShardTotals || session.requestedShardTotals)) {
      const lines = [];
      if (session.offeredShardTotals && Object.keys(session.offeredShardTotals).length) {
        for (const [sid, cnt] of Object.entries(session.offeredShardTotals)) {
          const sname = ITEM_DISPLAY_NAMES[sid] || sid;
          const semoji = ITEM_DISPLAY_EMOJIS[sid] || '';
          lines.push(`<@${initiatorId}> (offering): ${semoji} ${sname} x${cnt}`);
        }
      } else {
        lines.push(`<@${initiatorId}> (offering): None`);
      }
      if (session.requestedShardTotals && Object.keys(session.requestedShardTotals).length) {
        for (const [sid, cnt] of Object.entries(session.requestedShardTotals)) {
          const sname = ITEM_DISPLAY_NAMES[sid] || sid;
          const semoji = ITEM_DISPLAY_EMOJIS[sid] || '';
          lines.push(`<@${targetId}> (offering): ${semoji} ${sname} x${cnt}`);
        }
      } else {
        lines.push(`<@${targetId}> (offering): None`);
      }
      embed.addFields({ name: 'Shard Requirements', value: lines.join('\n'), inline: false });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`trade_confirm:${sessionId}`)
        .setLabel('Accept Trade')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`trade_cancel:${sessionId}`)
        .setLabel('Decline')
        .setStyle(ButtonStyle.Secondary)
    );

    // Persist session
    global.tradeSessions.set(sessionId, session);

    const replyContent = `<@${targetId}>, you have a trade proposal:`;
    if (message) return message.channel.send({ content: replyContent, embeds: [embed], components: [row] });
    return interaction.reply({ content: replyContent, embeds: [embed], components: [row] });
  },

  async handleButton(interaction, customId) {
    const parts = customId.split(':');
    const key = parts[0];
    const sessionId = parts[1];
    if (!key.startsWith('trade')) return;
    const session = global.tradeSessions.get(sessionId);
    if (!session) return interaction.reply({ content: 'Trade session expired or not found.', ephemeral: true });

    // Only target can accept/decline
    if (interaction.user.id !== session.targetId) {
      return interaction.reply({ content: 'Only the trade recipient may accept or decline this trade.', ephemeral: true });
    }

    if (key === 'trade_cancel') {
      global.tradeSessions.delete(sessionId);
      return global.safeUpdate(interaction, { content: 'Trade declined.', embeds: [], components: [] });
    }

    // Accept flow
    if (key === 'trade_confirm') {
      // Re-fetch fresh docs to validate
      const initiator = await User.findOne({ userId: session.initiatorId });
      const target = await User.findOne({ userId: session.targetId });
      if (!initiator || !target) {
        global.tradeSessions.delete(sessionId);
        return global.safeUpdate(interaction, { content: 'One of the users no longer has an account. Trade cancelled.', embeds: [], components: [] });
      }

      try {
        if (session.type === 'multi') {
          const offeredListLocal = session.offeredList || [];
          const requestedListLocal = session.requestedList || [];

          const sumBeli = (list) => (list || []).filter(i => i.kind === 'beli').reduce((s, i) => s + (i.amount || 0), 0);
          const offeredBeli = sumBeli(offeredListLocal);
          const requestedBeli = sumBeli(requestedListLocal);

          if ((initiator.balance || 0) < offeredBeli) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Buyer no longer has enough Beli. Trade cancelled.', embeds: [], components: [] });
          }
          if ((target.balance || 0) < requestedBeli) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Target no longer has enough Beli. Trade cancelled.', embeds: [], components: [] });
          }

          // recompute shard totals if not present
          const aggShards = (list) => {
            const map = {};
            for (const it of list) {
              if (it.kind !== 'card') continue;
              const sid = shardIdForAttribute(it.def?.attribute || '');
              const cnt = shardCostForRank(it.def?.rank || '');
              if (sid && cnt > 0) map[sid] = (map[sid] || 0) + cnt;
            }
            return map;
          };
          const offeredShards = session.offeredShardTotals || aggShards(offeredListLocal);
          const requestedShards = session.requestedShardTotals || aggShards(requestedListLocal);

          for (const [sid, cnt] of Object.entries(offeredShards)) {
            const have = findItemCount(initiator.items || [], sid);
            if (have < cnt) {
              global.tradeSessions.delete(sessionId);
              return global.safeUpdate(interaction, { content: `<@${session.initiatorId}> lacks required shards. Trade cancelled.`, embeds: [], components: [] });
            }
          }
          for (const [sid, cnt] of Object.entries(requestedShards)) {
            const have = findItemCount(target.items || [], sid);
            if (have < cnt) {
              global.tradeSessions.delete(sessionId);
              return global.safeUpdate(interaction, { content: `<@${session.targetId}> lacks required shards. Trade cancelled.`, embeds: [], components: [] });
            }
          }

          // verify cards still owned and not on teams / equipped
          for (const it of offeredListLocal) {
            if (it.kind === 'card') {
              const idx = (initiator.ownedCards || []).findIndex(e => e.cardId === it.id);
              if (idx === -1) {
                global.tradeSessions.delete(sessionId);
                return global.safeUpdate(interaction, { content: 'Either user no longer owns the required card. Trade cancelled.', embeds: [], components: [] });
              }
              if ((initiator.team || []).includes(it.id)) {
                global.tradeSessions.delete(sessionId);
                return global.safeUpdate(interaction, { content: 'Offered card is on a team. Trade cancelled.', embeds: [], components: [] });
              }
              if (cardHasArtifactEquipped(initiator, it.id)) {
                global.tradeSessions.delete(sessionId);
                return global.safeUpdate(interaction, { content: 'Offered card has an artifact equipped. Trade cancelled.', embeds: [], components: [] });
              }
            }
            if (it.kind === 'leveler') {
              const qtyNeed = Math.max(1, it.qty || 1);
              const itemHave = (initiator.items || []).find(i => i.itemId === it.id && (i.quantity || 0) >= qtyNeed);
              if (!itemHave) {
                global.tradeSessions.delete(sessionId);
                return global.safeUpdate(interaction, { content: `You no longer have ${qtyNeed}x ${it.def?.name || it.id}. Trade cancelled.`, embeds: [], components: [] });
              }
            }
          }
          for (const it of requestedListLocal) {
            if (it.kind === 'card') {
              const idx = (target.ownedCards || []).findIndex(e => e.cardId === it.id);
              if (idx === -1) {
                global.tradeSessions.delete(sessionId);
                return global.safeUpdate(interaction, { content: 'Target no longer owns required card. Trade cancelled.', embeds: [], components: [] });
              }
              if ((target.team || []).includes(it.id)) {
                global.tradeSessions.delete(sessionId);
                return global.safeUpdate(interaction, { content: 'Requested card is on a team. Trade cancelled.', embeds: [], components: [] });
              }
              if (cardHasArtifactEquipped(target, it.id)) {
                global.tradeSessions.delete(sessionId);
                return global.safeUpdate(interaction, { content: 'Requested card has an artifact equipped. Trade cancelled.', embeds: [], components: [] });
              }
            }
            if (it.kind === 'leveler') {
              const qtyNeed = Math.max(1, it.qty || 1);
              const itemHave = (target.items || []).find(i => i.itemId === it.id && (i.quantity || 0) >= qtyNeed);
              if (!itemHave) {
                global.tradeSessions.delete(sessionId);
                return global.safeUpdate(interaction, { content: `Target no longer has ${qtyNeed}x ${it.def?.name || it.id}. Trade cancelled.`, embeds: [], components: [] });
              }
            }
          }

          // Perform resource transfers
          // Transfer shards first: initiator -> target
          for (const [sid, cnt] of Object.entries(offeredShards)) {
            initiator.items = removeItem(initiator.items || [], sid, cnt);
            target.items = target.items || [];
            const existing = target.items.find(i => i.itemId === sid);
            if (existing) existing.quantity = (existing.quantity || 0) + cnt;
            else target.items.push({ itemId: sid, quantity: cnt });
          }
          // Transfer shards target -> initiator
          for (const [sid, cnt] of Object.entries(requestedShards)) {
            target.items = removeItem(target.items || [], sid, cnt);
            initiator.items = initiator.items || [];
            const existing = initiator.items.find(i => i.itemId === sid);
            if (existing) existing.quantity = (existing.quantity || 0) + cnt;
            else initiator.items.push({ itemId: sid, quantity: cnt });
          }

          // Transfer cards: initiator -> target
          for (const it of offeredListLocal) {
            if (it.kind !== 'card') continue;
            const idx = (initiator.ownedCards || []).findIndex(e => e.cardId === it.id);
            if (idx === -1) continue;
            const entry = initiator.ownedCards.splice(idx, 1)[0];
            if (!applyIncomingEntryAsXp(target, entry)) {
              target.ownedCards.push(entry);
              // Remove from target's wishlist now that they own it
              if (Array.isArray(target.wishlistCards) && target.wishlistCards.includes(it.id)) {
                target.wishlistCards = target.wishlistCards.filter(w => w !== it.id);
                if (typeof target.markModified === 'function') target.markModified('wishlistCards');
              }
            }
          }
          // Transfer cards: target -> initiator
          for (const it of requestedListLocal) {
            if (it.kind !== 'card') continue;
            const idx = (target.ownedCards || []).findIndex(e => e.cardId === it.id);
            if (idx === -1) continue;
            const entry = target.ownedCards.splice(idx, 1)[0];
            if (!applyIncomingEntryAsXp(initiator, entry)) {
              initiator.ownedCards.push(entry);
              // Remove from initiator's wishlist now that they own it
              if (Array.isArray(initiator.wishlistCards) && initiator.wishlistCards.includes(it.id)) {
                initiator.wishlistCards = initiator.wishlistCards.filter(w => w !== it.id);
                if (typeof initiator.markModified === 'function') initiator.markModified('wishlistCards');
              }
            }
          }

          // Transfer packs: initiator -> target
          for (const it of offeredListLocal) {
            if (it.kind !== 'pack') continue;
            const qty = Math.max(1, it.qty || 1);
            initiator.packInventory = initiator.packInventory || {};
            target.packInventory = target.packInventory || {};
            initiator.packInventory[it.crewName] = Math.max(0, (initiator.packInventory[it.crewName] || 0) - qty);
            target.packInventory[it.crewName] = (target.packInventory[it.crewName] || 0) + qty;
          }
          // Transfer packs: target -> initiator
          for (const it of requestedListLocal) {
            if (it.kind !== 'pack') continue;
            const qty = Math.max(1, it.qty || 1);
            initiator.packInventory = initiator.packInventory || {};
            target.packInventory = target.packInventory || {};
            target.packInventory[it.crewName] = Math.max(0, (target.packInventory[it.crewName] || 0) - qty);
            initiator.packInventory[it.crewName] = (initiator.packInventory[it.crewName] || 0) + qty;
          }

          // Transfer levelers/items offered -> requested
          for (const it of offeredListLocal) {
            if (it.kind !== 'leveler') continue;
            const qty = Math.max(1, it.qty || 1);
            initiator.items = removeItem(initiator.items || [], it.id, qty);
            target.items = target.items || [];
            const existing = target.items.find(i => i.itemId === it.id);
            if (existing) existing.quantity = (existing.quantity || 0) + qty;
            else target.items.push({ itemId: it.id, quantity: qty });
          }
          for (const it of requestedListLocal) {
            if (it.kind !== 'leveler') continue;
            const qty = Math.max(1, it.qty || 1);
            target.items = removeItem(target.items || [], it.id, qty);
            initiator.items = initiator.items || [];
            const existing = initiator.items.find(i => i.itemId === it.id);
            if (existing) existing.quantity = (existing.quantity || 0) + qty;
            else initiator.items.push({ itemId: it.id, quantity: qty });
          }

          // Balance transfers
          initiator.balance = (initiator.balance || 0) - offeredBeli + requestedBeli;
          target.balance = (target.balance || 0) - requestedBeli + offeredBeli;

          initiator.markModified('items'); target.markModified('items');
          initiator.markModified('packInventory'); target.markModified('packInventory');
          await initiator.save();
          await target.save();

          // Build summary message
          const disp = (list) => list.map(i => {
            if (i.kind === 'beli') return `¥${(i.amount || 0).toLocaleString()}`;
            if (i.kind === 'card') return `${i.def?.emoji || ''} ${i.def?.character || i.id}`;
            if (i.kind === 'leveler') return `${i.qty && i.qty > 1 ? i.qty + 'x ' : ''}${i.def?.name || i.id}`;
            if (i.kind === 'pack') return `${i.crewName} Pack${i.qty && i.qty > 1 ? ' x' + i.qty : ''}`;
            return String(i.id || i.amount || i);
          }).join(', ');

          const leftStr = disp(offeredListLocal) || 'None';
          const rightStr = disp(requestedListLocal) || 'None';
          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: `Trade completed: ${leftStr} ↔ ${rightStr}.`, embeds: [], components: [] });
        }
        if (session.type === 'card_for_card') {
          // verify ownership still holds
          const offeredEntryIndex = (initiator.ownedCards || []).findIndex(e => e.cardId === session.offered.cardId);
          const requestedEntryIndex = (target.ownedCards || []).findIndex(e => e.cardId === session.requested.cardId);
          if (offeredEntryIndex === -1 || requestedEntryIndex === -1) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Either user no longer owns the required card. Trade cancelled.', embeds: [], components: [] });
          }

          // verify both parties still have required shards (if any)
          const offeredShardId = session.offeredShard?.shardId;
          const offeredShardCount = session.offeredShard?.count || 0;
          const requestedShardId = session.requestedShard?.shardId;
          const requestedShardCount = session.requestedShard?.count || 0;

          if (offeredShardCount > 0 && offeredShardId) {
            const have = findItemCount(initiator.items || [], offeredShardId);
            if (have < offeredShardCount) {
              const sname = ITEM_DISPLAY_NAMES[offeredShardId] || offeredShardId;
              const semoji = ITEM_DISPLAY_EMOJIS[offeredShardId] || '';
              global.tradeSessions.delete(sessionId);
              return global.safeUpdate(interaction, { content: `Trade cancelled: <@${session.initiatorId}> lacks required shards (${semoji} ${sname} x${offeredShardCount}).`, embeds: [], components: [] });
            }
          }

          if (requestedShardCount > 0 && requestedShardId) {
            const haveT = findItemCount(target.items || [], requestedShardId);
            if (haveT < requestedShardCount) {
              const sname = ITEM_DISPLAY_NAMES[requestedShardId] || requestedShardId;
              const semoji = ITEM_DISPLAY_EMOJIS[requestedShardId] || '';
                global.tradeSessions.delete(sessionId);
                return global.safeUpdate(interaction, { content: `Trade cancelled: <@${session.targetId}> lacks required shards (${semoji} ${sname} x${requestedShardCount}).`, embeds: [], components: [] });
            }
          }

          // prevent trading if artifacts have been equipped since proposal
          if (cardHasArtifactEquipped(initiator, session.offered.cardId)) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Trade cancelled: Offered card has an artifact equipped. Unequip it first.', embeds: [], components: [] });
          }
          if (cardHasArtifactEquipped(target, session.requested.cardId)) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Trade cancelled: Requested card has an artifact equipped. Target must unequip it first.', embeds: [], components: [] });
          }

          // perform transfers: remove entries
          const offeredEntry = initiator.ownedCards.splice(offeredEntryIndex, 1)[0];
          const requestedEntry = target.ownedCards.splice(requestedEntryIndex, 1)[0];

          // remove shards from initiator -> add to target
          if (offeredShardCount > 0 && offeredShardId) {
            initiator.items = removeItem(initiator.items || [], offeredShardId, offeredShardCount);
            target.items = target.items || [];
            const existingT = target.items.find(i => i.itemId === offeredShardId);
            if (existingT) existingT.quantity = (existingT.quantity || 0) + offeredShardCount;
            else target.items.push({ itemId: offeredShardId, quantity: offeredShardCount });
          }

          // remove shards from target -> add to initiator
          if (requestedShardCount > 0 && requestedShardId) {
            target.items = removeItem(target.items || [], requestedShardId, requestedShardCount);
            initiator.items = initiator.items || [];
            const existingI = initiator.items.find(i => i.itemId === requestedShardId);
            if (existingI) existingI.quantity = (existingI.quantity || 0) + requestedShardCount;
            else initiator.items.push({ itemId: requestedShardId, quantity: requestedShardCount });
          }

          // When recipient already owns the incoming card, convert incoming card's level/xp into XP on existing entry
          if (!applyIncomingEntryAsXp(initiator, requestedEntry)) {
            initiator.ownedCards.push(requestedEntry);
            if (Array.isArray(initiator.wishlistCards) && initiator.wishlistCards.includes(requestedEntry.cardId)) {
              initiator.wishlistCards = initiator.wishlistCards.filter(w => w !== requestedEntry.cardId);
              if (typeof initiator.markModified === 'function') initiator.markModified('wishlistCards');
            }
          }
          if (!applyIncomingEntryAsXp(target, offeredEntry)) {
            target.ownedCards.push(offeredEntry);
            if (Array.isArray(target.wishlistCards) && target.wishlistCards.includes(offeredEntry.cardId)) {
              target.wishlistCards = target.wishlistCards.filter(w => w !== offeredEntry.cardId);
              if (typeof target.markModified === 'function') target.markModified('wishlistCards');
            }
          }

          await initiator.save();
          await target.save();

          // build completion message with shard details
          const offeredCard = getCardById(session.offered.cardId) || {};
          const requestedCard = getCardById(session.requested.cardId) || {};
          const shardParts = [];
          if (offeredShardCount > 0 && offeredShardId) {
            const sname = ITEM_DISPLAY_NAMES[offeredShardId] || offeredShardId;
            const semoji = ITEM_DISPLAY_EMOJIS[offeredShardId] || '';
            shardParts.push(`<@${session.initiatorId}> -> <@${session.targetId}>: ${semoji} ${sname} x${offeredShardCount}`);
          }
          if (requestedShardCount > 0 && requestedShardId) {
            const sname = ITEM_DISPLAY_NAMES[requestedShardId] || requestedShardId;
            const semoji = ITEM_DISPLAY_EMOJIS[requestedShardId] || '';
            shardParts.push(`<@${session.targetId}> -> <@${session.initiatorId}>: ${semoji} ${sname} x${requestedShardCount}`);
          }

          let completeMsg = `Trade completed: ${offeredCard.character || offeredCard.id} ↔ ${requestedCard.character || requestedCard.id}.`;
          if (shardParts.length) completeMsg += ` Shards exchanged: ${shardParts.join(' | ')}.`;

          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: completeMsg, embeds: [], components: [] });
        }

        if (session.type === 'beli_for_card') {
          // validate buyer still has funds and shards
          const buyer = initiator; // initiator paid beli
          const seller = target;
          if ((buyer.balance || 0) < session.beli) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Buyer no longer has enough Beli. Trade cancelled.', embeds: [], components: [] });
          }

          const shardId = session.shardReq?.shardId;
          const shardCount = session.shardReq?.count || 0;
          if (shardCount > 0 && shardId) {
            const have = findItemCount(buyer.items || [], shardId);
            if (have < shardCount) {
              const sname = ITEM_DISPLAY_NAMES[shardId] || shardId;
              const semoji = ITEM_DISPLAY_EMOJIS[shardId] || '';
              global.tradeSessions.delete(sessionId);
              return global.safeUpdate(interaction, { content: `Buyer lacks required shards (${semoji} ${sname} x${shardCount}). Trade cancelled.`, embeds: [], components: [] });
            }
          }

          // find requested card on seller
          const requestedIndex = (seller.ownedCards || []).findIndex(e => e.cardId === session.requested.cardId);
          if (requestedIndex === -1) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Seller no longer owns the requested card. Trade cancelled.', embeds: [], components: [] });
          }

          // perform transfers: buyer pays seller, shards move, card moves
          buyer.balance = (buyer.balance || 0) - session.beli;
          seller.balance = (seller.balance || 0) + session.beli;

          if (shardCount > 0) {
            // remove from buyer, add to seller
            buyer.items = removeItem(buyer.items || [], shardId, shardCount);
            seller.items = seller.items || [];
            const existing = seller.items.find(i => i.itemId === shardId);
            if (existing) existing.quantity = (existing.quantity || 0) + shardCount;
            else seller.items.push({ itemId: shardId, quantity: shardCount });
          }

          // transfer card
          // prevent trading if seller's card has an artifact equipped
          if (cardHasArtifactEquipped(seller, session.requested.cardId)) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Trade cancelled: Seller has an artifact equipped to that card. Unequip first.', embeds: [], components: [] });
          }

          const requestedEntry = seller.ownedCards.splice(requestedIndex, 1)[0];
          buyer.ownedCards = buyer.ownedCards || [];
          // if buyer already owns the card, convert incoming entry's level/xp into XP on buyer's existing entry
          if (!applyIncomingEntryAsXp(buyer, requestedEntry)) {
            buyer.ownedCards.push(requestedEntry);
          }

          await buyer.save();
          await seller.save();

          const sname = ITEM_DISPLAY_NAMES[shardId] || shardId;
          const semoji = ITEM_DISPLAY_EMOJIS[shardId] || '';
          const shardPart = shardCount ? `${shardCount}x ${semoji} ${sname} ` : '';
          const requestedCard = getCardById(session.requested.cardId) || {};
          const reqName = requestedCard.ship ? `${requestedCard.character} (ship)` : `${requestedCard.emoji || ''} ${requestedCard.character}`;
          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: `Trade completed: ¥${session.beli.toLocaleString()} and ${shardPart}exchanged for ${reqName}.`, embeds: [], components: [] });
        }

        if (session.type === 'card_for_beli') {
          // initiator gives card, target pays beli
          const seller = initiator;
          const buyer = target;
          const beli = session.requested.beli;
          if ((buyer.balance || 0) < beli) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Buyer no longer has enough Beli. Trade cancelled.', embeds: [], components: [] });
          }
          const cardIndex = (seller.ownedCards || []).findIndex(e => e.cardId === session.offered.cardId);
          if (cardIndex === -1) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Seller no longer owns the card. Trade cancelled.', embeds: [], components: [] });
          }
          if (cardHasArtifactEquipped(seller, session.offered.cardId)) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Trade cancelled: Card has an artifact equipped. Unequip first.', embeds: [], components: [] });
          }
          const cardEntry = seller.ownedCards.splice(cardIndex, 1)[0];
          buyer.balance = (buyer.balance || 0) - beli;
          seller.balance = (seller.balance || 0) + beli;
          if (!applyIncomingEntryAsXp(buyer, cardEntry)) buyer.ownedCards.push(cardEntry);
          await initiator.save();
          await target.save();
          const soldCard = getCardById(session.offered.cardId) || {};
          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: `Trade completed: ${soldCard.emoji || ''} **${soldCard.character || 'card'}** sold for ¥${beli.toLocaleString()}.`, embeds: [], components: [] });
        }

        if (session.type === 'beli_for_leveler') {
          // initiator pays beli, target gives leveler
          const qty = session.qty || 1;
          const levelerId = session.requested.levelerId;
          if ((initiator.balance || 0) < session.beli) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Buyer no longer has enough Beli. Trade cancelled.', embeds: [], components: [] });
          }
          const sellerItem = (target.items || []).find(i => i.itemId === levelerId);
          if (!sellerItem || (sellerItem.quantity || 0) < qty) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: `Seller no longer has ${qty}x of that leveler. Trade cancelled.`, embeds: [], components: [] });
          }
          initiator.balance = (initiator.balance || 0) - session.beli;
          target.balance = (target.balance || 0) + session.beli;
          sellerItem.quantity -= qty;
          if (sellerItem.quantity <= 0) target.items = target.items.filter(i => i.itemId !== levelerId);
          const buyerItem = (initiator.items || []).find(i => i.itemId === levelerId);
          if (buyerItem) buyerItem.quantity = (buyerItem.quantity || 0) + qty;
          else initiator.items.push({ itemId: levelerId, quantity: qty });
          initiator.markModified('items'); target.markModified('items');
          await initiator.save();
          await target.save();
          const levDef = levelers.find(l => l.id === levelerId) || { name: levelerId, emoji: '' };
          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: `Trade completed: ¥${session.beli.toLocaleString()} for **${qty > 1 ? qty + 'x ' : ''}${levDef.emoji} ${levDef.name}**.`, embeds: [], components: [] });
        }

        if (session.type === 'leveler_for_beli') {
          // initiator gives leveler, target pays beli
          const qty = session.qty || 1;
          const levelerId = session.offered.levelerId;
          const beli = session.requested.beli;
          if ((target.balance || 0) < beli) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Buyer no longer has enough Beli. Trade cancelled.', embeds: [], components: [] });
          }
          const sellerItem = (initiator.items || []).find(i => i.itemId === levelerId);
          if (!sellerItem || (sellerItem.quantity || 0) < qty) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: `Seller no longer has ${qty}x of that leveler. Trade cancelled.`, embeds: [], components: [] });
          }
          sellerItem.quantity -= qty;
          if (sellerItem.quantity <= 0) initiator.items = initiator.items.filter(i => i.itemId !== levelerId);
          const buyerItem = (target.items || []).find(i => i.itemId === levelerId);
          if (buyerItem) buyerItem.quantity = (buyerItem.quantity || 0) + qty;
          else target.items.push({ itemId: levelerId, quantity: qty });
          target.balance = (target.balance || 0) - beli;
          initiator.balance = (initiator.balance || 0) + beli;
          initiator.markModified('items'); target.markModified('items');
          await initiator.save();
          await target.save();
          const levDef = levelers.find(l => l.id === levelerId) || { name: levelerId, emoji: '' };
          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: `Trade completed: **${qty > 1 ? qty + 'x ' : ''}${levDef.emoji} ${levDef.name}** sold for ¥${beli.toLocaleString()}.`, embeds: [], components: [] });
        }

        if (session.type === 'leveler_class_for_beli') {
          // initiator gives all class levelers, target pays beli
          const beli = session.requested.beli;
          const snapshot = session.snapshot || [];
          if ((target.balance || 0) < beli) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Buyer no longer has enough Beli. Trade cancelled.', embeds: [], components: [] });
          }
          // Verify and transfer all levelers
          const transferred = [];
          for (const entry of snapshot) {
            const sellerItem = (initiator.items || []).find(i => i.itemId === entry.levelerId);
            if (!sellerItem || (sellerItem.quantity || 0) < entry.qty) continue;
            sellerItem.quantity -= entry.qty;
            if (sellerItem.quantity <= 0) initiator.items = initiator.items.filter(i => i.itemId !== entry.levelerId);
            const buyerItem = (target.items || []).find(i => i.itemId === entry.levelerId);
            if (buyerItem) buyerItem.quantity = (buyerItem.quantity || 0) + entry.qty;
            else { target.items = target.items || []; target.items.push({ itemId: entry.levelerId, quantity: entry.qty }); }
            transferred.push(entry);
          }
          if (!transferred.length) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Seller no longer has any of those levelers. Trade cancelled.', embeds: [], components: [] });
          }
          target.balance = (target.balance || 0) - beli;
          initiator.balance = (initiator.balance || 0) + beli;
          initiator.markModified('items'); target.markModified('items');
          await initiator.save();
          await target.save();
          const listStr = transferred.map(e => `${e.emoji || ''} ${e.name} x${e.qty}`).join(', ');
          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: `Trade completed: ${listStr} sold for ¥${beli.toLocaleString()}.`, embeds: [], components: [] });
        }

        if (session.type === 'beli_for_leveler_class') {
          // initiator pays beli, target gives all class levelers
          const beli = session.beli;
          const snapshot = session.snapshot || [];
          if ((initiator.balance || 0) < beli) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Buyer no longer has enough Beli. Trade cancelled.', embeds: [], components: [] });
          }
          const transferred = [];
          for (const entry of snapshot) {
            const sellerItem = (target.items || []).find(i => i.itemId === entry.levelerId);
            if (!sellerItem || (sellerItem.quantity || 0) < entry.qty) continue;
            sellerItem.quantity -= entry.qty;
            if (sellerItem.quantity <= 0) target.items = target.items.filter(i => i.itemId !== entry.levelerId);
            const buyerItem = (initiator.items || []).find(i => i.itemId === entry.levelerId);
            if (buyerItem) buyerItem.quantity = (buyerItem.quantity || 0) + entry.qty;
            else { initiator.items = initiator.items || []; initiator.items.push({ itemId: entry.levelerId, quantity: entry.qty }); }
            transferred.push(entry);
          }
          if (!transferred.length) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: 'Seller no longer has any of those levelers. Trade cancelled.', embeds: [], components: [] });
          }
          initiator.balance = (initiator.balance || 0) - beli;
          target.balance = (target.balance || 0) + beli;
          initiator.markModified('items'); target.markModified('items');
          await initiator.save();
          await target.save();
          const listStr = transferred.map(e => `${e.emoji || ''} ${e.name} x${e.qty}`).join(', ');
          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: `Trade completed: ¥${beli.toLocaleString()} for ${listStr}.`, embeds: [], components: [] });
        }

        if (session.type === 'leveler_for_leveler') {
          const offeredQty = session.offeredQty || 1;
          const requestedQty = session.requestedQty || 1;
          const offeredId = session.offered.levelerId;
          const requestedId = session.requested.levelerId;
          const initItem = (initiator.items || []).find(i => i.itemId === offeredId);
          const targItem = (target.items || []).find(i => i.itemId === requestedId);
          if (!initItem || (initItem.quantity || 0) < offeredQty) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: `<@${session.initiatorId}> no longer has enough of the offered leveler. Trade cancelled.`, embeds: [], components: [] });
          }
          if (!targItem || (targItem.quantity || 0) < requestedQty) {
            global.tradeSessions.delete(sessionId);
            return global.safeUpdate(interaction, { content: `<@${session.targetId}> no longer has enough of the requested leveler. Trade cancelled.`, embeds: [], components: [] });
          }
          initItem.quantity -= offeredQty;
          if (initItem.quantity <= 0) initiator.items = initiator.items.filter(i => i.itemId !== offeredId);
          targItem.quantity -= requestedQty;
          if (targItem.quantity <= 0) target.items = target.items.filter(i => i.itemId !== requestedId);
          const initGets = (initiator.items || []).find(i => i.itemId === requestedId);
          if (initGets) initGets.quantity = (initGets.quantity || 0) + requestedQty;
          else initiator.items.push({ itemId: requestedId, quantity: requestedQty });
          const targGets = (target.items || []).find(i => i.itemId === offeredId);
          if (targGets) targGets.quantity = (targGets.quantity || 0) + offeredQty;
          else target.items.push({ itemId: offeredId, quantity: offeredQty });
          initiator.markModified('items'); target.markModified('items');
          await initiator.save();
          await target.save();
          const offDef = levelers.find(l => l.id === offeredId) || { name: offeredId, emoji: '' };
          const reqDef = levelers.find(l => l.id === requestedId) || { name: requestedId, emoji: '' };
          global.tradeSessions.delete(sessionId);
          return global.safeUpdate(interaction, { content: `Trade completed: **${offeredQty > 1 ? offeredQty + 'x ' : ''}${offDef.emoji} ${offDef.name}** ↔ **${requestedQty > 1 ? requestedQty + 'x ' : ''}${reqDef.emoji} ${reqDef.name}**.`, embeds: [], components: [] });
        }

        } catch (err) {
        console.error('Trade accept failed:', err);
        global.tradeSessions.delete(sessionId);
        return global.safeUpdate(interaction, { content: 'Trade failed due to an error. Check logs.', embeds: [], components: [] });
      }
    }
  }
};
