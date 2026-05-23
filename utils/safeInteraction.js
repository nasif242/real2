const { EmbedBuilder, ActionRowBuilder } = require('discord.js');

function isBuilder(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return typeof obj.toJSON === 'function' || obj instanceof EmbedBuilder || obj instanceof ActionRowBuilder;
}

function cleanPayload(obj) {
  if (obj === undefined || obj === null) return undefined;
  if (Array.isArray(obj)) {
    const arr = obj.map(cleanPayload).filter(x => x !== undefined);
    return arr.length ? arr : undefined;
  }
  if (isBuilder(obj)) return obj;
  if (typeof obj !== 'object') return obj;
  const out = {};
  Object.keys(obj).forEach(k => {
    const v = cleanPayload(obj[k]);
    if (v !== undefined) out[k] = v;
  });
  return Object.keys(out).length ? out : undefined;
}

async function safeReply(interaction, payload) {
  try {
    const cleaned = cleanPayload(payload) || {};
    if (interaction.replied || interaction.deferred) {
      if (typeof interaction.followUp === 'function') return interaction.followUp(cleaned).catch(() => null);
      if (typeof interaction.editReply === 'function') return interaction.editReply(cleaned).catch(() => null);
    }
    return interaction.reply(cleaned).catch(() => null);
  } catch (err) {
    console.error('safeReply error', err);
    try { return interaction.reply({ content: 'An error occurred.', ephemeral: true }); } catch (e) { return null; }
  }
}

async function safeUpdate(interaction, payload) {
  try {
    const cleaned = cleanPayload(payload) || {};
    // If interaction already deferred or replied, prefer editReply/followUp
    if (interaction.deferred || interaction.replied) {
      if (typeof interaction.editReply === 'function') {
        return interaction.editReply(cleaned).catch(async (e) => {
          if (e && e.code === 10062) return null;
          try { return interaction.followUp ? interaction.followUp(cleaned) : null; } catch (e2) { return null; }
        });
      }
      if (typeof interaction.followUp === 'function') {
        return interaction.followUp(cleaned).catch(() => null);
      }
    }

    // If we can directly update the original message for a component interaction
    if (typeof interaction.update === 'function' && !interaction.deferred && !interaction.replied) {
      return interaction.update(cleaned).catch(async (e) => {
        if (e && e.code === 10062) return null;
        try { return interaction.reply ? interaction.reply(cleaned) : null; } catch (e2) {
          try { return interaction.followUp ? interaction.followUp(cleaned) : null; } catch (e3) { return null; }
        }
      });
    }

    if (typeof interaction.editReply === 'function') {
      return interaction.editReply(cleaned).catch(async (e) => {
        if (e && e.code === 10062) return null;
        try { return interaction.reply ? interaction.reply(cleaned) : null; } catch (e2) {
          try { return interaction.followUp ? interaction.followUp(cleaned) : null; } catch (e3) { return null; }
        }
      });
    }

    return safeReply(interaction, cleaned);
  } catch (err) {
    console.error('safeUpdate error', err);
    try { return interaction.reply({ content: 'An error occurred.', ephemeral: true }); } catch (e) { return null; }
  }
}

async function safeDefer(interaction) {
  if (interaction.deferred || interaction.replied) return;
  try {
    await interaction.deferUpdate().catch(() => {});
  } catch (e) {
    if (e && e.code !== 10062) console.error('Failed to defer interaction safely:', e);
  }
}

module.exports = { cleanPayload, safeReply, safeUpdate, safeDefer };
