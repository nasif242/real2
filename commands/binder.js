const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  AttachmentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const User = require('../models/User');
const { cards: allCards } = require('../data/cards');
const { generateBinderCanvas, DEFAULT_COLS, DEFAULT_ROWS } = require('../utils/binderCanvas');

// Available grid presets — label shown in the select menu, cols×rows per page
const GRID_PRESETS = [
  { label: '3 × 2  (6 cards)',    value: '3x2',  cols: 3, rows: 2 },
  { label: '4 × 3  (12 cards)',   value: '4x3',  cols: 4, rows: 3 },
  { label: '5 × 3  (15 cards)',   value: '5x3',  cols: 5, rows: 3 },
  { label: '5 × 4  (20 cards)',   value: '5x4',  cols: 5, rows: 4 },
  { label: '5 × 5  (25 cards)',   value: '5x5',  cols: 5, rows: 5 },
  { label: '10 × 5  (50 cards)',  value: '10x5', cols: 10, rows: 5 },
  { label: 'All cards (auto-fit, max 50)', value: 'auto', cols: null, rows: null },
];

// Pick the smallest preset that fits all `count` cards (up to 50)
function bestAutoGrid(count) {
  const n = Math.min(count, 50);
  for (const p of GRID_PRESETS) {
    if (p.cols !== null && p.cols * p.rows >= n) return { cols: p.cols, rows: p.rows };
  }
  return { cols: 10, rows: 5 };
}

const RANK_ORDER = { D: 1, C: 2, B: 3, A: 4, S: 5, SS: 6, UR: 7 };

function normalizeFaculty(f) {
  if (!f || f === 'null') return null;
  const t = f.trim();
  if (t.toLowerCase() === 'marines') return 'Marines';
  return t;
}

const FACTIONS = [...new Set(
  allCards.map(c => normalizeFaculty(c.faculty)).filter(Boolean)
)].sort();

const TOTAL_CARDS = allCards.length;

// Ships and artifacts always go to the end
function isSpecial(cardDef) {
  return !!(cardDef.ship || cardDef.artifact);
}

// Sort cards purely by rank/mastery, regardless of owned status.
// Favorites and team always float first (they require ownership anyway).
// Ships/artifacts are always last.
function sortFilteredCards(cards, user) {
  const favSet = new Set(user.favoriteCards || []);
  const teamSet = new Set(user.team || []);

  return [...cards].sort((a, b) => {
    const aSpec = isSpecial(a.cardDef) ? 1 : 0;
    const bSpec = isSpecial(b.cardDef) ? 1 : 0;
    if (aSpec !== bSpec) return aSpec - bSpec;

    const aFav = favSet.has(a.cardDef.id) ? 1 : 0;
    const bFav = favSet.has(b.cardDef.id) ? 1 : 0;
    if (bFav !== aFav) return bFav - aFav;

    const aTeam = teamSet.has(a.cardDef.id) ? 1 : 0;
    const bTeam = teamSet.has(b.cardDef.id) ? 1 : 0;
    if (bTeam !== aTeam) return bTeam - aTeam;

    const ra = RANK_ORDER[a.cardDef.rank] || 0;
    const rb = RANK_ORDER[b.cardDef.rank] || 0;
    if (rb !== ra) return rb - ra;

    if (b.cardDef.mastery !== a.cardDef.mastery) return b.cardDef.mastery - a.cardDef.mastery;

    return a.cardDef.character.localeCompare(b.cardDef.character);
  });
}

function buildCharacterCards(query, user) {
  const q = query.toLowerCase().trim();
  const ownedSet = new Set((user.ownedCards || []).map(e => e.cardId));
  // Prefer exact name/alias matches first, then fall back to substring matching
  let matched = allCards.filter(c => {
    if (c.character.toLowerCase() === q) return true;
    if (Array.isArray(c.alias) && c.alias.some(a => a.toLowerCase() === q)) return true;
    return false;
  });
  if (!matched.length) {
    matched = allCards.filter(c => {
      if (c.character.toLowerCase().includes(q)) return true;
      if (Array.isArray(c.alias) && c.alias.some(a => a.toLowerCase().includes(q))) return true;
      return false;
    });
  }
  return sortFilteredCards(matched.map(cardDef => ({ cardDef, owned: ownedSet.has(cardDef.id) })), user);
}

function buildFactionCards(faction, user) {
  const facNorm = normalizeFaculty(faction);
  const ownedSet = new Set((user.ownedCards || []).map(e => e.cardId));
  const matched = allCards.filter(c => normalizeFaculty(c.faculty) === facNorm);
  return sortFilteredCards(matched.map(cardDef => ({ cardDef, owned: ownedSet.has(cardDef.id) })), user);
}

// Main binder: history order (latest/oldest), non-special cards first then special
function buildMainCards(user, direction) {
  const history = user.history || [];
  const ownedSet = new Set((user.ownedCards || []).map(e => e.cardId));
  const ordered = direction === 'oldest' ? [...history] : [...history].reverse();

  const regular = [];
  const special = [];
  for (const id of ordered) {
    if (!ownedSet.has(id)) continue;
    const cardDef = allCards.find(c => c.id === id);
    if (!cardDef) continue;
    if (isSpecial(cardDef)) special.push({ cardDef, owned: true });
    else regular.push({ cardDef, owned: true });
  }
  return [...regular, ...special];
}

function perPage(session) {
  return session.gridCols * session.gridRows;
}

function buildTitle(session) {
  if (session.view === 'main') return 'Main binder';
  if (session.view === 'character') return `${session.filterName} binder`;
  if (session.view === 'faction') return `${session.filterName} binder`;
  return 'Binder';
}

function buildFooter(session) {
  const total = session.allCards.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage(session)));
  const pageStr = `Page ${session.page + 1} / ${totalPages}`;
  const gridStr = `${session.gridCols}×${session.gridRows}`;

  if (session.view === 'main') {
    const ownedCount = (session.user.ownedCards || []).length;
    return `${ownedCount} / ${TOTAL_CARDS} cards owned • ${pageStr} • grid ${gridStr}`;
  }

  const ownedInFilter = session.allCards.filter(c => c.owned).length;
  return `${ownedInFilter} / ${total} owned • ${pageStr} • grid ${gridStr}`;
}

function buildComponents(session) {
  const uid = session.userId;
  const total = session.allCards.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage(session)));
  const prevDisabled = session.page <= 0;
  const nextDisabled = session.page >= totalPages - 1;

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`binder_prev:${uid}`)
      .setLabel('Previous')
      .setEmoji({ id: '1489374714379112449' })
      .setStyle(prevDisabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(prevDisabled),
    new ButtonBuilder()
      .setCustomId(`binder_next:${uid}`)
      .setLabel('Next')
      .setEmoji({ id: '1489374606916714706' })
      .setStyle(nextDisabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(nextDisabled),
    new ButtonBuilder()
      .setCustomId(`binder_char:${uid}`)
      .setLabel('Search Character')
      .setEmoji('🔍')
      .setStyle(ButtonStyle.Secondary)
  );

  const factionSelect = new StringSelectMenuBuilder()
    .setCustomId(`binder_faction:${uid}`)
    .setPlaceholder('Filter by faction...')
    .addOptions(
      { label: 'Main binder (all owned)', value: '__main__' },
      ...FACTIONS.map(f => ({ label: f, value: f }))
    );

  // Current grid value for placeholder
  const currentPreset = GRID_PRESETS.find(p => p.cols === session.gridCols && p.rows === session.gridRows);
  const gridPlaceholder = currentPreset ? `Grid: ${currentPreset.label}` : `Grid: ${session.gridCols}×${session.gridRows}`;
  const gridSelect = new StringSelectMenuBuilder()
    .setCustomId(`binder_grid:${uid}`)
    .setPlaceholder(gridPlaceholder)
    .addOptions(GRID_PRESETS.map(p => ({ label: p.label, value: p.value })));

  return [
    navRow,
    new ActionRowBuilder().addComponents(factionSelect),
    new ActionRowBuilder().addComponents(gridSelect),
  ];
}

async function renderBinder(interaction, session, isNew = false) {
  const pp = perPage(session);
  const start = session.page * pp;
  const pageSlots = session.allCards.slice(start, start + pp);
  const slots = Array.from({ length: pp }, (_, i) => pageSlots[i] || null);

  let imgBuffer;
  try {
    imgBuffer = await generateBinderCanvas(slots, session.gridCols, session.gridRows);
  } catch (err) {
    console.error('[binder] Canvas generation failed:', err);
    const msg = { content: 'Failed to generate binder image. Please try again.', ephemeral: true };
    return isNew
      ? interaction.reply(msg)
      : global.safeUpdate(interaction, { content: msg.content, embeds: [], files: [], components: [] });
  }

  const file = new AttachmentBuilder(imgBuffer, { name: 'binder.png' });
  const embed = new EmbedBuilder()
    .setColor('#FFFFFF')
    .setTitle(buildTitle(session))
    .setImage('attachment://binder.png')
    .setFooter({ text: buildFooter(session) });

  const components = buildComponents(session);
  const payload = { embeds: [embed], files: [file], components };

  if (isNew) return interaction.reply(payload);
  return global.safeUpdate(interaction, payload);
}

function getSession(userId) {
  if (!global.binderSessions) global.binderSessions = new Map();
  return global.binderSessions.get(`${userId}_binder`);
}
function setSession(userId, session) {
  if (!global.binderSessions) global.binderSessions = new Map();
  global.binderSessions.set(`${userId}_binder`, session);
}

module.exports = {
  name: 'binder',
  description: 'View your card collection binder (5×3 grid)',

  async execute({ interaction, message, args }) {
    const userId = interaction ? interaction.user.id : message.author.id;
    const user = await User.findOne({ userId });
    if (!user) {
      const reply = "You don't have an account. Use `/start` or `op start` to register.";
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const cards = buildMainCards(user, 'latest');
    if (!cards.length) {
      const reply = "You don't own any cards yet. Use `/pull` or `op pull` to get started!";
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const session = {
      userId, view: 'main', filterName: 'Main', allCards: cards, page: 0,
      gridCols: DEFAULT_COLS, gridRows: DEFAULT_ROWS, user
    };
    setSession(userId, session);

    // Prefix args: "op binder boroque works" → faction, "op binder luf" → character search
    if (message && args && args.length) {
      const query = args.join(' ').toLowerCase().trim();
      const matchedFaction = FACTIONS.find(f =>
        f.toLowerCase().includes(query) || query.includes(f.toLowerCase())
      );
      if (matchedFaction) {
        const factionCards = buildFactionCards(matchedFaction, user);
        if (factionCards.length) {
          session.view = 'faction';
          session.filterName = matchedFaction;
          session.allCards = factionCards;
        }
      } else {
        const charCards = buildCharacterCards(query, user);
        if (charCards.length) {
          const displayName =
            charCards.find(c => !isSpecial(c.cardDef))?.cardDef.character
            || charCards[0].cardDef.character
            || (query.charAt(0).toUpperCase() + query.slice(1));
          session.view = 'character';
          session.filterName = displayName;
          session.filterQuery = query;
          session.allCards = charCards;
        }
      }
    }

    if (message) {
      const pp = perPage(session);
      const slots = Array.from({ length: pp }, (_, i) => session.allCards[i] || null);
      let imgBuffer;
      try { imgBuffer = await generateBinderCanvas(slots, session.gridCols, session.gridRows); } catch (e) { return message.reply('Failed to generate binder.'); }
      const file = new AttachmentBuilder(imgBuffer, { name: 'binder.png' });
      const embed = new EmbedBuilder()
        .setColor('#FFFFFF')
        .setTitle(buildTitle(session))
        .setImage('attachment://binder.png')
        .setFooter({ text: buildFooter(session) });
      return message.channel.send({ embeds: [embed], files: [file], components: buildComponents(session) });
    }

    return renderBinder(interaction, session, true);
  },

  async handleButton(interaction, customId) {
    const [action] = customId.split(':');
    const session = getSession(interaction.user.id);

    if (!session || session.userId !== interaction.user.id) {
      return interaction.reply({ content: 'Binder session expired. Run `/binder` again.', ephemeral: true });
    }

    if (action === 'binder_char') {
      const modal = new ModalBuilder()
        .setCustomId('binder_char_modal')
        .setTitle('Search Character Binder');
      const input = new TextInputBuilder()
        .setCustomId('binder_char_query')
        .setLabel('Character name (e.g. Luffy, Zoro, Nami)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter character name...')
        .setRequired(true)
        .setMaxLength(50);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (action === 'binder_prev') {
      if (session.page > 0) session.page--;
      return renderBinder(interaction, session);
    }

    if (action === 'binder_next') {
      const totalPages = Math.ceil(session.allCards.length / perPage(session));
      if (session.page < totalPages - 1) session.page++;
      return renderBinder(interaction, session);
    }
  },

  async handleModal(interaction) {
    const query = interaction.fields.getTextInputValue('binder_char_query').trim();
    if (!query) return interaction.reply({ content: 'Please enter a character name.', ephemeral: true });

    const session = getSession(interaction.user.id);
    if (!session) return interaction.reply({ content: 'Binder session expired. Run `/binder` again.', ephemeral: true });

    const cards = buildCharacterCards(query, session.user);
    if (!cards.length) return interaction.reply({ content: `No cards found matching **${query}**.`, ephemeral: true });

    const displayName = cards.find(c => !isSpecial(c.cardDef))?.cardDef.character
      || cards[0].cardDef.character
      || (query.charAt(0).toUpperCase() + query.slice(1));

    session.view = 'character';
    session.filterName = displayName;
    session.filterQuery = query;
    session.allCards = cards;
    session.page = 0;

    return renderBinder(interaction, session);
  },

  async handleSelect(interaction) {
    const customId = interaction.customId || '';
    const value = interaction.values?.[0];
    const session = getSession(interaction.user.id);
    if (!session) return interaction.reply({ content: 'Binder session expired. Run `/binder` again.', ephemeral: true });

    // Grid size selector
    if (customId.startsWith('binder_grid:')) {
      const preset = GRID_PRESETS.find(p => p.value === value);
      if (!preset) return interaction.reply({ content: 'Unknown grid size.', ephemeral: true });

      if (preset.value === 'auto') {
        const { cols, rows } = bestAutoGrid(session.allCards.length);
        session.gridCols = cols;
        session.gridRows = rows;
      } else {
        session.gridCols = preset.cols;
        session.gridRows = preset.rows;
      }
      session.page = 0;
      return renderBinder(interaction, session);
    }

    // Faction selector
    if (value === '__main__') {
      session.view = 'main';
      session.filterName = 'Main';
      session.allCards = buildMainCards(session.user, 'latest');
      session.page = 0;
      return renderBinder(interaction, session);
    }

    const cards = buildFactionCards(value, session.user);
    if (!cards.length) return interaction.reply({ content: `No cards found for **${value}**.`, ephemeral: true });

    session.view = 'faction';
    session.filterName = value;
    session.allCards = cards;
    session.page = 0;
    return renderBinder(interaction, session);
  }
};
