const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder
} = require('discord.js');
const User = require('../models/User');
const { CHEST_EMOJIS } = require('../data/chests');
const { normal: normalQuestions, hard: hardQuestions } = require('../data/quiz');

const activeTriviaSessions = new Map();
const QUESTION_COUNT = 5;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

function formatCooldown(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function getValidQuestions(category) {
  const questions = category === 'hard' ? hardQuestions : normalQuestions;
  return questions.filter((q) => {
    return q && q.question && q.answer && q.options && q.options.A && q.options.B && q.options.C && q.options.D;
  });
}

function chooseQuestions(category) {
  const validQuestions = getValidQuestions(category);
  return shuffle(validQuestions).slice(0, Math.min(QUESTION_COUNT, validQuestions.length));
}

function buildDifficultySelectRow(userId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`trivia_diff:${userId}`)
    .setPlaceholder('Options')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions([
      { label: 'Normal', value: 'normal' },
      { label: 'Hard', value: 'hard' }
    ]);

  return new ActionRowBuilder().addComponents(menu);
}

function buildQuestionEmbed(question, index, total) {
  const lines = [
    '**Question**',
    question.question,
    '',
    '**Options**',
    `**A.** ${question.options.A}`,
    `**B.** ${question.options.B}`,
    `**C.** ${question.options.C}`,
    `**D.** ${question.options.D}`
  ];

  return new EmbedBuilder()
    .setDescription(lines.join('\n'))
    .setColor('#ffffff')
    .setFooter({ text: `Question ${index + 1}/${total}` });
}

function buildAnswerRow(userId, questionIndex) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`trivia_answer:${userId}:${questionIndex}:A`).setLabel('A').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`trivia_answer:${userId}:${questionIndex}:B`).setLabel('B').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`trivia_answer:${userId}:${questionIndex}:C`).setLabel('C').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`trivia_answer:${userId}:${questionIndex}:D`).setLabel('D').setStyle(ButtonStyle.Secondary)
  );
}

function buildFeedbackEmbed(question, isCorrect, selectedChoice) {
  const lines = [
    '**Question**',
    question.question,
    '',
    '**Options**',
    `**A.** ${question.options.A}`,
    `**B.** ${question.options.B}`,
    `**C.** ${question.options.C}`,
    `**D.** ${question.options.D}`,
    '',
    isCorrect
      ? `Correct! The answer was **${question.answer}**.`
      : `Wrong! The answer was **${question.answer}**.`
  ];

  return new EmbedBuilder()
    .setDescription(lines.join('\n'))
    .setColor(isCorrect ? '#94ffb9' : '#ff7070');
}

function buildContinueRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`trivia_continue:${userId}`)
      .setLabel('Continue')
      .setStyle(ButtonStyle.Primary)
  );
}

function buildRewardSummary(session) {
  const lines = [];
  if (session.totalBeli) lines.push(`**Beli:** <:beri:1490738445319016651> ${session.totalBeli}`);
  if (session.gems) lines.push(`**Gems:** ${session.gems}`);
  if (session.aChestCount) lines.push(`**A Chest:** ${session.aChestCount}x ${CHEST_EMOJIS.a_chest}`);
  if (session.bChestCount) lines.push(`**B Chest:** ${session.bChestCount}x ${CHEST_EMOJIS.b_chest}`);
  if (session.cChestCount) lines.push(`**C Chest:** ${session.cChestCount}x ${CHEST_EMOJIS.c_chest}`);
  if (!lines.length) lines.push('No rewards earned this time.');
  return lines.join('\n');
}

function addChest(user, itemId, amount) {
  if (!amount || amount <= 0) return;
  user.items = user.items || [];
  const existing = user.items.find((entry) => entry.itemId === itemId);
  if (existing) existing.quantity += amount;
  else user.items.push({ itemId, quantity: amount });
}

async function applySessionRewards(user, session) {
  user.balance = (user.balance || 0) + session.totalBeli;
  user.gems = (user.gems || 0) + session.gems;
  addChest(user, 'a_chest', session.aChestCount);
  addChest(user, 'b_chest', session.bChestCount);
  addChest(user, 'c_chest', session.cChestCount);
  await user.save();
}

function addPerQuestionReward(session) {
  const amount = session.difficulty === 'hard'
    ? Math.floor(Math.random() * 76) + 25
    : Math.floor(Math.random() * 50) + 1;
  session.totalBeli += amount;
  const chestAwarded = session.correctCount % 2 === 0;

  if (chestAwarded) {
    session.cChestCount += 1;
    return `You earned **<:beri:1490738445319016651> ${amount}** and **1x** <:Cchest:1492559506868146307> **C Chest**.`;
  }

  return `You earned **<:beri:1490738445319016651> ${amount}**.`;
}

function applyPerfectBonus(session) {
  if (session.correctCount !== session.questions.length) return '';
  if (session.difficulty === 'hard') {
    const bChestBonus = Math.floor(Math.random() * 2) + 1;
    session.aChestCount += 1;
    session.bChestCount += bChestBonus;
    return `Perfect run bonus: **1x** <:Achest:1492559635507450068> **A Chest** and **${bChestBonus}x** <:Bchest:1492559568738451567> **B Chest**.`;
  }

  session.bChestCount += 1;
  return 'Perfect run bonus: **1x** <:Bchest:1492559568738451567> **B Chest**.';
}

function clearTriviaTimeout(session) {
  if (!session) return;
  try {
    if (session.timeout) {
      clearTimeout(session.timeout);
      session.timeout = null;
    }
  } catch (e) {
    // ignore
  }
}

async function startTriviaTimeout(session, interaction) {
  if (!session || !interaction) return;
  clearTriviaTimeout(session);
  try {
    const ownerId = session.userId;
    const channel = interaction.channel;
    session.timeout = setTimeout(async () => {
      try {
        const user = await User.findOne({ userId: ownerId });
        if (user) await applySessionRewards(user, session);
        activeTriviaSessions.delete(ownerId);
        const timeoutEmbed = new EmbedBuilder()
          .setColor('#ff7070')
          .setTitle('Trivia Timed Out')
          .setDescription(`No response received for 30 seconds. Your session has ended and rewards earned so far have been granted.\n\n**Final Rewards:**\n${buildRewardSummary(session)}`);
        
        // Use editReply to update the existing message instead of sending a new one
        if (session.interaction) {
          try {
            await session.interaction.editReply({ embeds: [timeoutEmbed], components: [] });
            return;
          } catch (e) {
            // If editReply fails, fall back to channel send
            if (e.code !== 10062) console.error('Failed to edit reply on timeout:', e);
          }
        }
        
        // Fallback: send new message if editReply unavailable
        if (channel && typeof channel.send === 'function') {
          try { await channel.send({ content: `<@${ownerId}>`, embeds: [timeoutEmbed] }); } catch (e) {}
        }
      } catch (e) {
        console.error('Trivia timeout error', e);
      }
    }, 30000);
  } catch (e) {
    console.error('Failed to start trivia timeout', e);
  }
}

module.exports = {
  name: 'trivia',
  description: 'Start a trivia quiz for rewards',
  async execute({ message, interaction }) {
    const userId = message ? message.author.id : interaction.user.id;
    const user = await User.findOne({ userId });
    if (!user) {
      const reply = 'You don\'t have an account. Run `op start` or /start to register.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    const now = new Date();
    if (user.triviaCooldownUntil && user.triviaCooldownUntil > now) {
      const remaining = formatCooldown(user.triviaCooldownUntil - now);
      const reply = `You must wait another \`${remaining}\` before starting another trivia quiz.`;
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    if (activeTriviaSessions.has(userId)) {
      const reply = 'You already have an active trivia session. Please finish it before starting a new one.';
      if (message) return message.channel.send(reply);
      return interaction.reply({ content: reply, ephemeral: true });
    }

    user.triviaCooldownUntil = new Date(Date.now() + COOLDOWN_MS);
    await user.save();

    const selectRow = buildDifficultySelectRow(userId);
    const embed = new EmbedBuilder()
      .setDescription('**Choose a difficulty**')
      .setColor('#ffffff');

    if (message) {
      return message.channel.send({ content: '', embeds: [embed], components: [selectRow] });
    }

    return interaction.reply({ content: '', embeds: [embed], components: [selectRow] });
  },

  async handleDifficultySelect(interaction) {
    const selected = interaction.values && interaction.values[0];
    if (!selected || !['normal', 'hard'].includes(selected)) {
      return interaction.reply({ content: 'Invalid difficulty selection.', ephemeral: true });
    }

    const [, ownerId] = interaction.customId.split(':');
    if (ownerId && interaction.user.id !== ownerId) {
      return interaction.reply({ content: 'This trivia menu is not for you.', ephemeral: true });
    }

    const userId = interaction.user.id;
    if (activeTriviaSessions.has(userId)) {
      return interaction.reply({ content: 'You already have an active trivia quiz.', ephemeral: true });
    }

    const questions = chooseQuestions(selected);
    if (!questions.length) {
      if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { content: 'No trivia questions are available for that difficulty yet.', embeds: [], components: [] });
      return global.safeUpdate(interaction, { content: 'No trivia questions are available for that difficulty yet.', embeds: [], components: [] });
    }

    const session = {
      userId,
      difficulty: selected,
      questions,
      currentIndex: 0,
      correctCount: 0,
      totalBeli: 0,
      gems: 0,
      aChestCount: 0,
      bChestCount: 0,
      cChestCount: 0,
      pendingNext: false
    };

    activeTriviaSessions.set(userId, session);

    const questionEmbed = buildQuestionEmbed(questions[0], 0, questions.length);
    const answerRow = buildAnswerRow(userId, 0);
    if (global && typeof global.safeUpdate === 'function') await global.safeUpdate(interaction, { content: null, embeds: [questionEmbed], components: [answerRow] });
    else await interaction.update({ content: null, embeds: [questionEmbed], components: [answerRow] });
    // Store interaction reference in session for timeout handler to use editReply
    session.interaction = interaction;
    await startTriviaTimeout(session, interaction);
    return;
  },

  async handleButton(interaction) {
    const [action, ownerId, questionIndexRaw, selectedChoice] = interaction.customId.split(':');
    if (!ownerId || ownerId !== interaction.user.id) {
      return interaction.reply({ content: 'This trivia button is not for your session.', ephemeral: true });
    }

    const session = activeTriviaSessions.get(ownerId);
    if (!session) {
      return interaction.reply({ content: 'Your trivia session is no longer active.', ephemeral: true });
    }
    // clear any pending question timeout since the user interacted
    clearTriviaTimeout(session);

    if (action === 'trivia_answer') {
      if (session.pendingNext) {
        return interaction.reply({ content: 'Please continue to the next question first.', ephemeral: true });
      }

      const questionIndex = parseInt(questionIndexRaw, 10);
      const question = session.questions[questionIndex];
      if (!question) {
        return interaction.reply({ content: 'Unable to resolve the trivia question.', ephemeral: true });
      }

      const isCorrect = question.answer.toUpperCase() === (selectedChoice || '').toUpperCase();
      if (!isCorrect) {
        const feedbackEmbed = buildFeedbackEmbed(question, false, selectedChoice);
        const user = await User.findOne({ userId: ownerId });
        if (user) {
          await applySessionRewards(user, session);
        }
        activeTriviaSessions.delete(ownerId);

        const summary = session.totalBeli || session.gems || session.aChestCount || session.bChestCount || session.cChestCount
          ? `\n\n**Rewards earned so far:**\n${buildRewardSummary(session)}`
          : '';

        feedbackEmbed.setDescription(`${feedbackEmbed.data.description}${summary}`);
        if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { embeds: [feedbackEmbed], components: [] });
        return global.safeUpdate(interaction, { embeds: [feedbackEmbed], components: [] });
      }

      session.correctCount += 1;
      const rewardText = addPerQuestionReward(session);
      const feedbackEmbed = buildFeedbackEmbed(question, true, selectedChoice);
      feedbackEmbed.setDescription(`${feedbackEmbed.data.description}\n\n${rewardText}`);

      const isLast = questionIndex === session.questions.length - 1;
      if (isLast) {
        const bonusText = applyPerfectBonus(session);
        if (bonusText) {
          feedbackEmbed.setDescription(`${feedbackEmbed.data.description}\n\n${bonusText}`);
        }
        const summary = `\n\n**Final Rewards:**\n${buildRewardSummary(session)}`;
        feedbackEmbed.setDescription(`${feedbackEmbed.data.description}${summary}`);

        const user = await User.findOne({ userId: ownerId });
        if (user) {
          await applySessionRewards(user, session);
        }

        activeTriviaSessions.delete(ownerId);
        if (global && typeof global.safeUpdate === 'function') return global.safeUpdate(interaction, { embeds: [feedbackEmbed], components: [] });
        return global.safeUpdate(interaction, { embeds: [feedbackEmbed], components: [] });
      }

      session.currentIndex += 1;
      session.pendingNext = true;
      if (global && typeof global.safeUpdate === 'function') await global.safeUpdate(interaction, { embeds: [feedbackEmbed], components: [buildContinueRow(ownerId)] });
      else await global.safeUpdate(interaction, { embeds: [feedbackEmbed], components: [buildContinueRow(ownerId)] });
      await startTriviaTimeout(session, interaction);
      return;
    }

    if (action === 'trivia_continue') {
      if (!session.pendingNext) {
        return interaction.reply({ content: 'There is no next question available right now.', ephemeral: true });
      }

      const nextQuestion = session.questions[session.currentIndex];
      if (!nextQuestion) {
        activeTriviaSessions.delete(ownerId);
        return interaction.reply({ content: 'Unable to load the next trivia question.', ephemeral: true });
      }

      session.pendingNext = false;
      const questionEmbed = buildQuestionEmbed(nextQuestion, session.currentIndex, session.questions.length);
      const answerRow = buildAnswerRow(ownerId, session.currentIndex);
      if (global && typeof global.safeUpdate === 'function') await global.safeUpdate(interaction, { embeds: [questionEmbed], components: [answerRow] });
      else await global.safeUpdate(interaction, { embeds: [questionEmbed], components: [answerRow] });
      await startTriviaTimeout(session, interaction);
      return;
    }

    return interaction.reply({ content: 'Unknown trivia action.', ephemeral: true });
  }
};
