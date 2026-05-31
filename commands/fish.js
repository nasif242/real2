const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User = require('../models/User');
const { levelers } = require('../data/levelers');
const { cards } = require('../data/cards');
const { rods } = require('../data/rods');
const { applyDefaultEmbedStyle } = require('../utils/embedStyle');
const { simulatePull } = require('../utils/cards');
const { sanitizeUserRods } = require('../utils/inventoryHelper');

function getRodColor(rodId) {
  switch (rodId) {
    case 'basic_rod': return '#8B4513'; // brown
    case 'gold_rod': return '#FFD700'; // golden
    case 'white_rod': return '#F8F8FF'; // shiny white
    default: return '#FFFFFF';
  }
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getLevelerWeight(leveler) {
  if (leveler.id.startsWith('all_')) return 3;
  if (leveler.name.toLowerCase().includes('crab')) return 2;
  return 1;
}

function chooseLeveler(levelers, qualityModifier) {
  const weighted = levelers.map(leveler => {
    let weight = getLevelerWeight(leveler);
    if (weight > 1) weight *= qualityModifier;
    return { leveler, weight };
  });
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let pick = Math.random() * totalWeight;
  for (const entry of weighted) {
    pick -= entry.weight;
    if (pick <= 0) return entry.leveler;
  }
  return weighted[weighted.length - 1].leveler;
}

// Map to store fishing state per user
const fishingStates = new Map();

module.exports = {
  name: 'fish',
  description: 'Go fishing for levelers and cards',
  async execute({ message, interaction }) {
    const userId = message ? message.author.id : interaction.user.id;
    const discordUser = message ? message.author : interaction.user;
    const user = await User.findOne({ userId });
    if (!user) {
      const reply = 'You don\'t have an account. Run `/start` to register.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    if (sanitizeUserRods(user)) {
      await user.save();
    }

    const rodIds = rods.map(r => r.id);
    let currentRodItem = user.items?.find(
      it => it.itemId === user.currentRod && it.durability !== undefined && it.durability > 0
    );
    if (fishingStates.has(userId)) {
      const reply = 'You already have an active fishing session in progress!';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // reserve a placeholder state synchronously to prevent race-starts
    fishingStates.set(userId, { pending: true, message: null, interaction });

    if (!currentRodItem) {
      currentRodItem = user.items?.find(
        it => rodIds.includes(it.itemId) && it.durability !== undefined && it.durability > 0
      );
      if (currentRodItem) {
        user.currentRod = currentRodItem.itemId;
        await user.save();
      }
    }
    if (!currentRodItem) {
      // cleanup placeholder and inform user
      fishingStates.delete(userId);
      const reply = "You don't have a **fishing rod** to fish with! Buy one in the shop with `op buy <rodname>` or `buy`";
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const formatDuration = seconds => {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins}m ${secs.toString().padStart(2, '0')}s`;
    };

    // Check cooldown
    if (user.lastFishFail && Date.now() - user.lastFishFail.getTime() < 120000) {
      const remainingSeconds = Math.ceil((120000 - (Date.now() - user.lastFishFail.getTime())) / 1000);
      // cleanup placeholder and inform user
      fishingStates.delete(userId);
      const reply = `You scared the fish away... Wait another \`${formatDuration(remainingSeconds)}\` before fishing again`;
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    // Interactive version for both message and slash commands
    const currentRodData = rods.find(r => r.id === user.currentRod);
    const embed = new EmbedBuilder()
      .setTitle(null)
      .setDescription('**Waiting for a nibble...**')
      .setColor(getRodColor(user.currentRod));
    if (currentRodData && currentRodData.thumbnail) {
      embed.setThumbnail(currentRodData.thumbnail);
    }
    applyDefaultEmbedStyle(embed, discordUser);

    let replyMsg;
    if (message) {
      replyMsg = await message.reply({ embeds: [embed], components: [] });
    } else {
      await interaction.reply({ embeds: [embed], components: [] });
      replyMsg = null;
    }
    // update placeholder with the message reference (will be replaced when interval starts)
    const existing = fishingStates.get(userId) || {};
    existing.message = replyMsg;
    existing.interaction = interaction;
    fishingStates.set(userId, existing);

    // Random delay 1-10 seconds adjusted by rod speed multiplier
    const rodMultiplier = currentRodData?.multiplier || 1;
    const delay = (Math.random() * 9000 + 1000) / rodMultiplier;
    setTimeout(async () => {
      // Check if still valid
      if (!message && !interaction.replied) return;

      // Start the progress bar with a random target position
      let position = 0;
      const barLength = 8;
      const targetIndex = randomInt(1, barLength - 2);
      const updateBar = () => {
        const bar = Array(barLength).fill('□');
        bar[position] = '■';
        bar[targetIndex] = position === targetIndex ? '◉' : '◯';
        return bar.join('');
      };

      const embed2 = new EmbedBuilder()
        .setTitle(null)
        .setDescription(`Progress: ${updateBar()}\n\nAim for the target (◉)! Click the button when the ■ is on the ◉ for the best catch!`)
        .setColor(getRodColor(user.currentRod));
      
      // Get user's rod and set thumbnail
      const currentRodData2 = rods.find(r => r.id === user.currentRod);
      if (currentRodData2 && currentRodData2.thumbnail) {
        embed2.setThumbnail(currentRodData2.thumbnail);
      }
      applyDefaultEmbedStyle(embed2, discordUser);

      const button = new ButtonBuilder()
        .setCustomId(`fish_catch:${userId}`)
        .setLabel('Reel In!')
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder().addComponents(button);

      if (message) {
        await replyMsg.edit({ embeds: [embed2], components: [row] });
      } else {
        await interaction.editReply({ embeds: [embed2], components: [row] });
      }

      // Start moving the tick - simple 1.5 second intervals
      let tickCount = 0;
      const maxTicks = 24; // 24 ticks total
      
      const interval = setInterval(async () => {
        tickCount++;
        position = (position + 1) % barLength;
        
        // Check if we've reached the timeout
        if (tickCount >= maxTicks) {
          clearInterval(interval);
          fishingStates.delete(userId);
          
          const timeoutEmbed = new EmbedBuilder()
            .setTitle(null)
            .setDescription(`Progress: ${Array(barLength).fill('□').join('')}\n\n-# timed out`)
            .setColor(getRodColor(user.currentRod));

          // Get user's rod and set thumbnail
          const currentRodData3 = rods.find(r => r.id === user.currentRod);
          if (currentRodData3 && currentRodData3.thumbnail) {
            timeoutEmbed.setThumbnail(currentRodData3.thumbnail);
          }
          applyDefaultEmbedStyle(timeoutEmbed, discordUser);
          
          try {
            if (message) {
              await replyMsg.edit({ embeds: [timeoutEmbed], components: [] });
            } else {
              await interaction.editReply({ embeds: [timeoutEmbed], components: [] });
            }
          } catch (e) {
            // Message might be deleted or interaction expired
          }
          return;
        }
        
        const newBar = Array(barLength).fill('□');
        newBar[position] = '■';
        newBar[targetIndex] = position === targetIndex ? '◉' : '◯';
        embed2.setDescription(`Progress: ${newBar.join('')}\n\nAim for the target (◉)! Click the button when the ■ is on the ◉ for the best catch!`);
        
        try {
          if (message) {
            await replyMsg.edit({ embeds: [embed2], components: [row] });
          } else {
            await interaction.editReply({ embeds: [embed2], components: [row] });
          }
        } catch (e) {
          // Message might be deleted or interaction expired
          clearInterval(interval);
          fishingStates.delete(userId);
        }
      }, 1500); // 1.5 seconds per tick

      // Store/replace with the real active state for the running session
      fishingStates.set(userId, {
        interval,
        position: () => position,
        targetIndex,
        clear: () => clearInterval(interval),
        message: replyMsg,
        interaction: interaction,
        createdAt: Date.now()
      });
    }, delay);
  },

  // Function to handle the catch
  async handleCatch(interaction, userId) {
    // Only allow the user who created the embed to click the button
    if (interaction.user.id !== userId) {
      return interaction.reply({ content: 'This is not your fishing session!', ephemeral: true });
    }

    const state = fishingStates.get(userId);
    if (!state) {
      return interaction.reply({ content: 'Your fishing session has expired. Try fishing again!', ephemeral: true });
    }

    // If the interval hasn't started yet (still warming up), inform the user
    if (!state.interval) {
      return interaction.reply({ content: 'Your fishing session is still starting. Wait a moment and try again.', ephemeral: true });
    }

    state.clear();
    fishingStates.delete(userId);

    // Fetch user once for the whole function
    const user = await User.findOne({ userId });
    const discordUser = interaction.user;
    const rodIds = rods.map(r => r.id);
    const currentRodItem = user.items?.find(
      it => it.itemId === user.currentRod && rodIds.includes(it.itemId) && it.durability !== undefined && it.durability > 0
    );

    const position = state.position();
    const targetIndex = state.targetIndex ?? 3;
    const distance = Math.abs(position - targetIndex);

    let outcome;
    if (distance === 0) {
      outcome = 'Perfect catch!';
    } else if (distance === 1) {
      outcome = 'Good catch!';
    } else {
      outcome = 'The fish got away!';
      // Set cooldown
      await User.findOneAndUpdate({ userId }, { lastFishFail: new Date() });
    }

    const embed = new EmbedBuilder()
      .setTitle(null)
      .setDescription(`${outcome}`)
      .setColor(getRodColor(user.currentRod));
    applyDefaultEmbedStyle(embed, interaction.user);

    // Get user's rod and set thumbnail
    const currentRodData = rods.find(r => r.id === user.currentRod);
    if (currentRodData && currentRodData.thumbnail) {
      embed.setThumbnail(currentRodData.thumbnail);
    }

    if (outcome === 'The fish got away!') {
      // Try to edit the original message to remove the button first
      try {
        if (state.message && typeof state.message.edit === 'function') {
          await state.message.edit({ embeds: [embed], components: [] }).catch(() => {});
          try { await interaction.deferUpdate().catch(() => {}); } catch (e) {}
          return null;
        }
      } catch (e) {}

      if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { embeds: [embed], components: [] });
      return global.safeUpdate(interaction, { embeds: [embed], components: [] });
    }

    // Determine number of items based on rod and catch quality
    let itemCount = 1;
    const rodMultiplier = currentRodData?.multiplier || 1;
    const qualityPenalty = distance === 1 ? 0.75 : 1;
    if (rodMultiplier >= 1.5) {
      if (Math.random() < 0.3) itemCount = 3;
      else itemCount = 2;
    } else if (rodMultiplier >= 1.25) {
      if (Math.random() < 0.4) itemCount = 2;
    }

    // Determine loot
    const isCard = Math.random() < 0.1; // 10% chance for card
    const lootLines = [];
    const cardRankModifier = rodMultiplier * qualityPenalty;
    const levelerQualityModifier = rodMultiplier * qualityPenalty;

    if (isCard) {
      // Fishing now only yields artifact cards
      const artifactPool = cards.filter(c => c.artifact && c.pullable);
      if (artifactPool.length) {
        const card = artifactPool[Math.floor(Math.random() * artifactPool.length)];
        // Determine target id (artifacts typically have no higher mastery but keep logic for safety)
        let targetCardId = card.id;
        let targetMastery = card.mastery || 1;
        for (let i = 2; i <= 4; i++) {
          const higherCard = cards.find(c => c.character === card.character && c.mastery === i);
          if (higherCard && user.ownedCards.some(oc => oc.cardId === higherCard.id)) {
            targetCardId = higherCard.id;
            targetMastery = i;
          }
        }

        const targetCard = cards.find(c => c.id === targetCardId);
        const emoji = targetCard.emoji || '<:artifact:1492550000000000000>';

        const existing = user.ownedCards.find(c => c.cardId === targetCardId);
        if (existing) {
          existing.xp = (existing.xp || 0) + 100;
          const levelsGained = Math.floor(existing.xp / 100);
          if (levelsGained > 0) {
            existing.level = (existing.level || 1) + levelsGained;
            existing.xp = existing.xp % 100;
          }
          lootLines.push(`${emoji} ${targetCard.character} *(duplicate → +100 XP)*`);
        } else {
          user.ownedCards.push({ cardId: targetCardId, level: 1, xp: 0 });
          lootLines.push(`${emoji} ${targetCard.character}`);
        }
      }
    } else {
      // Add multiple levelers based on rod quality
      for (let i = 0; i < itemCount; i++) {
        const randomLeveler = chooseLeveler(levelers, levelerQualityModifier);
        lootLines.push(`${randomLeveler.emoji} ${randomLeveler.name}`);

        const existingItem = user.items.find(it => it.itemId === randomLeveler.id);
        if (existingItem) {
          existingItem.quantity += 1;
        } else {
          user.items.push({ itemId: randomLeveler.id, quantity: 1 });
        }
      }
    }

    const chestRoll = Math.random();
    const chestMultiplier = 1 + (currentRodData?.luckBonus || 0);
    if (chestRoll < 0.001 * chestMultiplier) {
      user.items = user.items || [];
      const existingChest = user.items.find(it => it.itemId === 'a_chest');
      if (existingChest) {
        existingChest.quantity += 1;
      } else {
        user.items.push({ itemId: 'a_chest', quantity: 1 });
      }
      lootLines.push('<:Achest:1492559635507450068> A Chest');
    } else if (chestRoll < 0.021 * chestMultiplier) {
      user.items = user.items || [];
      const existingChest = user.items.find(it => it.itemId === 'b_chest');
      if (existingChest) {
        existingChest.quantity += 1;
      } else {
        user.items.push({ itemId: 'b_chest', quantity: 1 });
      }
      lootLines.push('<:Bchest:1492559568738451567> B Chest');
    } else if (chestRoll < 0.051 * chestMultiplier) {
      user.items = user.items || [];
      const existingChest = user.items.find(it => it.itemId === 'c_chest');
      if (existingChest) {
        existingChest.quantity += 1;
      } else {
        user.items.push({ itemId: 'c_chest', quantity: 1 });
      }
      lootLines.push('<:Cchest:1492559506868146307> C Chest');
    }

    // Decrement rod durability
    if (currentRodItem && currentRodItem.durability !== undefined) {
      currentRodItem.durability -= 1;
      if (currentRodItem.durability <= 0) {
        const brokenRodData = rods.find(r => r.id === currentRodItem.itemId);
        const brokenRodName = brokenRodData?.name || 'fishing rod';
        const brokenRodEmoji = brokenRodData?.emoji || '';

        // Remove broken rod from inventory
        user.items = user.items.filter(it => it.itemId !== currentRodItem.itemId);

        // Switch to any remaining valid rod or clear currentRod
        const nextRodItem = user.items.find(
          it => rodIds.includes(it.itemId) && it.durability !== undefined && it.durability > 0
        );
        if (nextRodItem) {
          user.currentRod = nextRodItem.itemId;
        } else {
          user.currentRod = null;
        }

        const breakEmbed = new EmbedBuilder()
          .setDescription(
            `** <a:rodbroke:1491957963248767017> Your fishing rod broke..**\n` +
            `Your fishing rod, **${brokenRodEmoji} ${brokenRodName}** Broke and can no longer be used. to keep fishing, buy a new rod from the shop with \`op buy <rodname>\` or \`/buy\`!`
          )
          .setColor('#ffffff');
        await discordUser.send({ embeds: [breakEmbed] }).catch(() => null);
      }
    }

    embed.addFields({ name: 'Loot', value: lootLines.join('\n') });
    user.totalFishCaught = (user.totalFishCaught || 0) + 1;
    await user.save();

    // Try to edit the original message to remove the button first
    try {
      if (state.message && typeof state.message.edit === 'function') {
        await state.message.edit({ embeds: [embed], components: [] }).catch(() => {});
        try { await interaction.deferUpdate().catch(() => {}); } catch (e) {}
        return null;
      }
    } catch (e) {}

    if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { embeds: [embed], components: [] });
    return global.safeUpdate(interaction, { embeds: [embed], components: [] });
  }
};