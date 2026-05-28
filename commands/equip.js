const User = require('../models/User');
const { searchCards, findBestOwnedCard, getCardById } = require('../utils/cards');

function findArtifactCard(query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  const results = searchCards(q).filter(c => c.artifact);
  return results.length ? results[0] : null;
}

function findTargetCard(query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  const results = searchCards(q).filter(c => !c.artifact);
  return results.length ? results[0] : null;
}

function normalizeName(name) {
  return name ? name.toLowerCase().trim() : '';
}

function artifactSupportsCard(artifactDef, cardDef) {
  if (!artifactDef || !artifactDef.boost || !cardDef) return false;
  const regex = /([\w .'-]+?)(?:,\s*([\w ]+))?\s*\((\d+)%\)/gi;
  let match;
  const targetName = normalizeName(cardDef.character);
  const facultyName = cardDef.faculty ? normalizeName(cardDef.faculty) : null;
  while ((match = regex.exec(artifactDef.boost)) !== null) {
    const target = normalizeName(match[1]);
    if (target === targetName || (facultyName && target === facultyName)) return true;
  }
  return false;
}

module.exports = {
  name: 'equip',
  description: 'Equip an artifact to a card',
  options: [
    { name: 'artifact', type: 3, description: 'Artifact name', required: true },
    { name: 'card', type: 3, description: 'Card to equip the artifact to', required: true }
  ],
  async execute({ message, interaction, args }) {
    const isInteraction = Boolean(interaction);
    const userId = isInteraction ? interaction.user.id : message.author.id;
    let artifactQuery;
    let targetQuery;
    if (isInteraction) {
      artifactQuery = interaction.options.getString('artifact');
      targetQuery = interaction.options.getString('card');
    } else {
      artifactQuery = null;
      targetQuery = null;
      for (let i = 1; i < args.length; i += 1) {
        const possibleArtifact = args.slice(0, i).join(' ').trim();
        const possibleTarget = args.slice(i).join(' ').trim();
        if (findArtifactCard(possibleArtifact) && findTargetCard(possibleTarget)) {
          artifactQuery = possibleArtifact;
          targetQuery = possibleTarget;
          break;
        }
      }
      if (!artifactQuery) {
        artifactQuery = args[0];
        targetQuery = args.slice(1).join(' ').trim();
      }
    }

    const reply = (content) => {
      if (message) return message.reply(content);
      return interaction.reply({ content, ephemeral: true });
    };

    if (!artifactQuery) return reply('Please state an artifact.');
    if (!targetQuery) return reply('Please state a target card to equip the artifact to.');

    const user = await User.findOne({ userId });
    if (!user) {
      return reply('You don\'t have an account. Run `op start` or /start to register.');
    }

    const artifactDef = findArtifactCard(artifactQuery);
    if (!artifactDef) {
      return reply(`**${artifactQuery}** is not a vaild artifact name.`);
    }

    const artifactEntry = user.ownedCards.find(e => e.cardId === artifactDef.id);
    if (!artifactEntry) {
      return reply(`You don't own **${artifactDef.character}**.`);
    }

    const targetDef = await findBestOwnedCard(userId, targetQuery);
    if (!targetDef) {
      return reply(`**${targetQuery}** is not a valid card name to equip this artifact to.`);
    }

    if (!artifactSupportsCard(artifactDef, targetDef)) {
      return reply(`This artifact cannot be equipped to **${targetDef.character}**.`);
    }

    const targetOwned = user.ownedCards.some(e => e.cardId === targetDef.id);
    if (!targetOwned) {
      return reply(`You don't own **${targetDef.character}**.`);
    }

    // Enforce per-card artifact slot limits (default 1). Roronoa Zoro can
    // equip up to 3 artifacts when that card's star level is >= 7.
    const targetOwnedEntry = user.ownedCards.find(e => e.cardId === targetDef.id) || null;
    let allowedArtifacts = 1;
    const targetChar = targetDef.character ? String(targetDef.character).toLowerCase().trim() : '';
    if (targetChar === 'roronoa zoro' && targetOwnedEntry && (targetOwnedEntry.starLevel || 0) >= 7) {
      allowedArtifacts = 3;
    }

    const currentEquippedCount = user.ownedCards.filter(e => e.equippedTo === targetDef.id && getCardById(e.cardId) && getCardById(e.cardId).artifact).length;
    if (currentEquippedCount >= allowedArtifacts) {
      const label = `${targetDef.emoji ? `${targetDef.emoji} ` : ''}${targetDef.character}`.trim();
      if (allowedArtifacts === 1) return reply(`**${label}** already has an artifact equipped. Unequip it first.`);
      return reply(`**${label}** already has ${currentEquippedCount} artifacts equipped. This card can have up to ${allowedArtifacts} artifacts.`);
    }

    if (artifactEntry.equippedTo) {
      const currentCard = require('../data/cards').cards.find(c => c.id === artifactEntry.equippedTo);
      const currentName = currentCard ? `${currentCard.emoji || ''} ${currentCard.character}`.trim() : artifactEntry.equippedTo;
      return reply(`This artifact is already equiped to **${currentName}**, Unequip it first.`);
    }

    artifactEntry.equippedTo = targetDef.id;
    await user.save();

    const targetLabel = `${targetDef.emoji ? `${targetDef.emoji} ` : ''}${targetDef.character}`.trim();
    return reply(`Successfully equiped **${artifactDef.character}** to **${targetLabel}**!`);
  }
};
