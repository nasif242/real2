const { EmbedBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User = require('../models/User');
const { cards } = require('../data/cards');
const { getMaxStarForRank } = require('./starLevel');

// Centralized ability definitions and handlers.
// Each ability has: id, name, matches(cardDef) -> bool, description, handler(interaction, cardId)
const ABILITIES = [
  {
    id: 'nami_beli_boost',
    name: 'Nami — Beli Boost',
    matches: (card) => card && card.character === 'Nami',
    description: 'Nami boosts the Beli you receive from gambling depending on her star level. 1 ✮ = 1% beli boost.',
    handler: async (interaction, cardId) => {
      const cardDef = cards.find(c => c.id === cardId);
      if (!cardDef) return interaction.reply({ content: 'Unknown card.', ephemeral: true });
      const user = await User.findOne({ userId: interaction.user.id });
      if (!user) return interaction.reply({ content: 'You don\'t have an account.', ephemeral: true });
      const owned = user.ownedCards.find(e => e.cardId === cardId);
      if (!owned) {
        return interaction.reply({ content: `${cardDef.character} boosts the Beli you receive from gambling depending on her star level.\n1 ✮ = 1% beli boost`, ephemeral: true });
      }
      const starLevel = owned.starLevel || 0;
      const mult = (1 + starLevel * 0.01).toFixed(2);
      const pct = (starLevel * 1);
      const activation = starLevel === 0 ? ' — reach ★1 to activate!' : '.';
      return interaction.reply({ content: `${cardDef.character} boosts the Beli you receive from gambling depending on her star level.\n1 ✮ = 1% beli boost\n\nCurrent: ${starLevel} ✮ = ${pct}% boost (×${mult})${activation}`, ephemeral: true });
    }
  },
  {
    id: 'pull_bonus',
    name: 'Pull Bonus',
    matches: (card) => card && ['4162', '4037', '3786'].includes(card.id),
    description: 'This card unlocks +1 pull per reset when upgraded to Max ★ for its rank.',
    handler: async (interaction, cardId) => {
      const cardDef = cards.find(c => c.id === cardId);
      if (!cardDef) return interaction.reply({ content: 'Unknown card.', ephemeral: true });
      const user = await User.findOne({ userId: interaction.user.id });
      if (!user) return interaction.reply({ content: 'You don\'t have an account.', ephemeral: true });
      const maxStar = getMaxStarForRank(cardDef.rank);
      const owned = user.ownedCards.find(e => e.cardId === cardId);
      const starLevel = owned ? (owned.starLevel || 0) : null;
      const isMaxed = owned && starLevel >= maxStar;
      let statusLine = '';
      if (!owned) {
        statusLine = `\nYou don't own this card yet.`;
      } else if (isMaxed) {
        statusLine = `\nCurrent: Max ★ — **+1 pull per reset is active!**`;
      } else {
        statusLine = `\nCurrent: ${starLevel} ✮ — upgrade to Max ★ (${maxStar} ✮) to unlock.`;
      }
      return interaction.reply({ content: `This card unlocks +1 pull per reset when upgraded to Max ★ for its rank.${statusLine}`, ephemeral: true });
    }
  },
  {
    id: 'zoro_multi_artifact',
    name: 'Zoro — Multi-Artifact',
    matches: (card) => card && card.character && String(card.character).toLowerCase() === 'roronoa zoro',
    description: 'Roronoa Zoro can equip up to 3 artifacts when the card reaches Star Level 7 (otherwise 1).',
    handler: async (interaction, cardId) => {
      const cardDef = cards.find(c => c.id === cardId);
      if (!cardDef) return interaction.reply({ content: 'Unknown card.', ephemeral: true });
      const user = await User.findOne({ userId: interaction.user.id });
      if (!user) return interaction.reply({ content: 'You don\'t have an account.', ephemeral: true });
      const owned = user.ownedCards.find(e => e.cardId === cardId);
      const starLevel = owned ? (owned.starLevel || 0) : 0;
      const allowed = starLevel >= 7 ? 3 : 1;
      const status = owned ? `Current: ${starLevel} ✮ — this copy can equip up to ${allowed} artifact(s).` : `You don't own this card yet. When you own it, it can equip up to ${allowed} artifact(s) (needs ✮7 to reach 3).`;
      return interaction.reply({ content: `${cardDef.character} ability — Roronoa Zoro can equip up to 3 artifacts when the card reaches Star Level 7 (otherwise 1).\n\n${status}`, ephemeral: true });
    }
  }
];

function getMatchingAbilities(cardDef) {
  if (!cardDef) return [];
  return ABILITIES.filter(a => {
    try { return !!a.matches(cardDef); } catch (e) { return false; }
  });
}

function hasAbility(cardDef) {
  return getMatchingAbilities(cardDef).length > 0;
}

function makeAbilityButton(cardDef) {
  if (!cardDef) return null;
  return new ButtonBuilder()
    .setCustomId(`ability:${cardDef.id}`)
    .setLabel('Ability')
    .setStyle(ButtonStyle.Secondary);
}

async function handleButton(interaction, cardId) {
  const cardDef = cards.find(c => c.id === cardId);
  if (!cardDef) return interaction.reply({ content: 'Unknown card.', ephemeral: true });
  const matches = getMatchingAbilities(cardDef);
  if (!matches.length) return interaction.reply({ content: 'This card has no special ability.', ephemeral: true });

  // If multiple abilities match, show a consolidated embed
  const lines = [];
  for (const a of matches) {
    // Prefer calling the handler if present
    if (typeof a.handler === 'function') {
      try {
        // let handler decide response — if it replies we'll return
        const res = await a.handler(interaction, cardId);
        // If the handler already replied, stop processing further
        return res;
      } catch (err) {
        console.error('Ability handler error', err);
      }
    }
    lines.push(`**${a.name}** — ${a.description}`);
  }

  const embed = new EmbedBuilder().setTitle(`${cardDef.character} — Abilities`).setColor('#2b2d31').setDescription(lines.join('\n\n'));
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

function listAllAbilities() {
  // Return a mapping of card identifiers / characters to ability metadata for documentation
  const out = [];
  for (const a of ABILITIES) {
    const matchedCards = cards.filter(c => {
      try { return !!a.matches(c); } catch (e) { return false; }
    }).map(c => ({ id: c.id, character: c.character }));
    out.push({ id: a.id, name: a.name, description: a.description, matches: matchedCards });
  }
  return out;
}

module.exports = { hasAbility, makeAbilityButton, handleButton, getMatchingAbilities, listAllAbilities };
