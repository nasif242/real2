const User = require('../models/User');
const duelCmd = require('./duel');
const isailCmd = require('./isail');

module.exports = {
  name: 'forfeit',
  description: 'Forfeit your currentbattle',
  async execute({ message, interaction }) {
    const userId = message ? message.author.id : interaction.user.id;
    const user = await User.findOne({ userId });
    const displayName = message ? message.author.username : (interaction ? interaction.user.username : `<@${userId}>`);
    if (!user) {
      const reply = 'You don\'t have an account. Run `op start` or /start to register.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // Check for active duel
    let state = null;
    let isDuel = false;
    let duelMsgId = null;
    if (duelCmd && duelCmd.duelStates) {
      for (const [msgId, s] of duelCmd.duelStates) {
        // duel state stores player1Id/player2Id
        if ((s.player1Id && s.player1Id === userId) || (s.player2Id && s.player2Id === userId)) {
          state = s;
          isDuel = true;
          duelMsgId = msgId;
          break;
        }
      }
    }

    // Check for active isail
    if (!state && isailCmd && isailCmd.battleStates) {
      for (const [msgId, s] of isailCmd.battleStates) {
        // older states may have s.player, newer use s.userId
        if ((s.player && s.player.id === userId) || s.userId === userId) {
          state = s;
          isDuel = false;
          break;
        }
      }
    }

    if (!state) {
      const reply = 'You are not in an active battle.';
      if (message) return message.reply(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // Forfeit logic
    if (isDuel) {
      // Use player1Id/player2Id to determine winner/loser
      if (!state.player1Id || !state.player2Id) {
        const reply = 'Invalid duel state.';
        if (message) return message.reply(reply);
        return interaction.reply({ content: reply, ephemeral: true });
      }
      const winnerId = state.player1Id === userId ? state.player2Id : state.player1Id;
      const loserId = state.player1Id === userId ? state.player1Id : state.player2Id;

      // Load user documents for bounty updates
      const winnerUser = await User.findOne({ userId: winnerId });
      const loserUser = await User.findOne({ userId: loserId });

      state.finished = true;
      state.winnerId = winnerId;
      state.loserId = loserId;

      // Clear any duel timeout on this state
      try {
        if (state.timeout) {
          clearTimeout(state.timeout);
          state.timeout = null;
        }
      } catch (err) {}

      // Remove any in-memory duel records for both players (pending or active)
      try {
        if (typeof duelCmd.clearUserState === 'function') {
          duelCmd.clearUserState(winnerId);
          duelCmd.clearUserState(loserId);
        }
        if (duelMsgId && duelCmd.duelStates && duelCmd.duelStates.has(duelMsgId)) {
          duelCmd.duelStates.delete(duelMsgId);
        }
      } catch (err) {
        // ignore cleanup errors
      }

      // resolve display names from discord users if available
      const winnerName = (state.discordUser1 && state.discordUser1.id === winnerId) ? state.discordUser1.username : (state.discordUser2 && state.discordUser2.id === winnerId) ? state.discordUser2.username : `<@${winnerId}>`;
      const loserName = (state.discordUser1 && state.discordUser1.id === loserId) ? state.discordUser1.username : (state.discordUser2 && state.discordUser2.id === loserId) ? state.discordUser2.username : `<@${loserId}>`;
      state.lastAction = `${loserName} forfeited. ${winnerName} wins!`;

      // Update bounty if applicable (mirror duel logic and support bounty captures)
      let bountyGain = 0;
      let bountyClaimed = 0;
      let beliGain = 0;
      if (winnerUser && loserUser) {
        const winnerBounty = winnerUser.bounty || 100;
        const loserBounty = loserUser.bounty || 100;

        // Small percentage gain when defeating a higher-bounty player
        if (loserBounty > winnerBounty) {
          if (loserBounty > winnerBounty * 3) {
            bountyGain = 0;
          } else {
            bountyGain = Math.floor(loserBounty * 0.03);
          }
        }
        if (bountyGain > 0) {
          const winnerAllowed = !state.rewardsAllowed || !!state.rewardsAllowed[winnerId];
          if (winnerAllowed) {
            winnerUser.bounty = (winnerUser.bounty || 100) + bountyGain;
            try {
            } catch (err) {
              console.error('Achievement check after bounty gain failed', err);
            }
            // Deduct gained bounty from the loser
            try {
              if (loserUser) {
                loserUser.bounty = Math.max(0, (loserUser.bounty || 100) - bountyGain);
                await loserUser.save();
              }
            } catch (err) {
              console.error('Failed to deduct bounty from loser after forfeit:', err);
            }
          }
        }

        // If this was a bounty duel and the hunter (bountyHunter) won, capture bounty
        if (state.isBountyDuel && winnerId === state.bountyHunter) {
          const targetBounty = loserUser.bounty || 100;
          const bountyGain = Math.floor(targetBounty * 0.2);
          bountyClaimed = bountyGain;
          const winnerAllowed = !state.rewardsAllowed || !!state.rewardsAllowed[winnerId];
          if (winnerAllowed) {
            // Award 20% (2/10) of the target's bounty to the hunter's bounty total
            winnerUser.bounty = (winnerUser.bounty || 100) + bountyGain;
            // proportional beli reward (2x advertised)
            const baseBeli = Math.ceil(targetBounty / 100000);
            beliGain = baseBeli * 2;
            winnerUser.balance = (winnerUser.balance || 0) + beliGain;
            winnerUser.activeBountyTarget = null;
            winnerUser.lastBountyTarget = loserId;
            winnerUser.bountyCooldownUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
            // Deduct 10% (1/10) of the loser's bounty
            try {
              if (loserUser) {
                const bountyLoss = Math.floor((loserUser.bounty || 100) * 0.1);
                loserUser.bounty = Math.max(100, (loserUser.bounty || 100) - bountyLoss);
                await loserUser.save();
              }
            } catch (err) {
              console.error('Failed to deduct bounty from loser after forfeit capture:', err);
            }
            try {
            } catch (err) {
              console.error('Achievement check after bounty capture failed', err);
            }
          }
        } else if (state.isBountyDuel && loserId === state.bountyHunter) {
          // Hunter lost, reset their cooldown but keep target
          const hunterUser = await User.findOne({ userId: state.bountyHunter });
          if (hunterUser) {
            hunterUser.bountyCooldownUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
            await hunterUser.save();
          }
        }

        // persist any changes to the winner
        await winnerUser.save();
      }

      const { EmbedBuilder } = require('discord.js');
      // Build victory embed (include bounty info when applicable)
      let extra = '';
      if (bountyGain > 0) extra += `\n\nBounty Gained: **${bountyGain}**`;
      if (bountyClaimed > 0) extra += `\n\nBounty Claimed: **${bountyClaimed}**`;
      if (beliGain > 0) extra += `\n\nBeli Earned: ¥**${beliGain}**`;

      const embed = new EmbedBuilder()
        .setTitle('Duel Forfeited')
        .setDescription(`${loserName} forfeited.\n${winnerName} wins!${extra}`)
        .setColor('#ff0000');

      if (message) return message.channel.send({ embeds: [embed] });
      return interaction.reply({ embeds: [embed] });
    } else {
      // Isail forfeit
      state.finished = true;
      state.lastUserAction = `${displayName} forfeited.`;

      // Clean up battle state from the map to prevent blocking future sails
      for (const [msgId, s] of isailCmd.battleStates) {
        if (s && s.userId === userId) {
          try {
            if (s.timeout) {
              clearTimeout(s.timeout);
              s.timeout = null;
            }
          } catch (err) {}
          isailCmd.battleStates.delete(msgId);
        }
      }

      // Also clear any timeout on the matched state reference
      try {
        if (state && state.timeout) {
          clearTimeout(state.timeout);
          state.timeout = null;
        }
      } catch (err) {}

      // Reset any persistent sail progress for this user so a forfeited run
      // does not leave them partway through the Infinite Sail on restart.
      try {
        user.isailProgress = 1;
        user.lastIsailEnemies = [];
        await user.save();
      } catch (err) {
        console.error('Failed to reset isail progress on forfeit for user', userId, err);
      }

      const { EmbedBuilder } = require('discord.js');
      const embed = new EmbedBuilder()
        .setTitle('Sail forfeited')
        .setDescription(`${displayName} forfeited the sail battle.`)
        .setColor('#ff8686');

      if (message) return message.channel.send({ embeds: [embed] });
      return interaction.reply({ embeds: [embed] });
    }
  }
};