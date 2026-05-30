const express = require('express');
const User = require('../models/User');

const VOTE_CHEST_IDS = ['c_chest', 'b_chest', 'a_chest'];
const GOD_TOKEN_STREAK_INTERVAL = 5;
const CHEST_NAMES = { c_chest: 'C Chest', b_chest: 'B Chest', a_chest: 'A Chest' };
const CHEST_EMOJIS = {
  c_chest: '<:Cchest:1492559506868146307>',
  b_chest: '<:Bchest:1492559568738451567>',
  a_chest: '<:Achest:1492559635507450068>'
};

let _client = null;

function setClient(client) {
  _client = client;
  console.log('[vote-webhook] Discord client attached.');
}

function randomChestId() {
  return VOTE_CHEST_IDS[Math.floor(Math.random() * VOTE_CHEST_IDS.length)];
}

async function processVote(voterId) {
  let user = await User.findOne({ userId: voterId });
  if (!user) {
    console.warn(`[vote-webhook] User ${voterId} voted but has no bot account — no rewards given`);
    return;
  }

  console.log(`[vote-webhook] Found account for user ${voterId} (current streak: ${user.voteStreak || 0})`);

  // Streak logic — reset if more than 48 hours since last vote
  const now = new Date();
  const lastVoted = user.lastVoted ? new Date(user.lastVoted) : null;
  const hoursSinceLast = lastVoted ? (now - lastVoted) / (1000 * 60 * 60) : Infinity;
  if (hoursSinceLast > 48) {
    console.log(`[vote-webhook] Streak reset for ${voterId} (${hoursSinceLast.toFixed(1)}h since last vote)`);
    user.voteStreak = 0;
  }

  user.voteStreak = (user.voteStreak || 0) + 1;
  user.totalVotes = (user.totalVotes || 0) + 1;
  user.lastVoted = now;
  // Schedule a vote reminder DM 12 hours from now
  user.nextVoteReminder = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  // Reward: 1 reset token
  user.resetTokens = (user.resetTokens || 0) + 1;
  console.log(`[vote-webhook] Gave 1 reset token to ${voterId}`);

  // Reward: 1 random chest
  const chestId = randomChestId();
  user.items = user.items || [];
  const existingChest = user.items.find(i => i.itemId === chestId);
  if (existingChest) {
    existingChest.quantity = (existingChest.quantity || 0) + 1;
  } else {
    user.items.push({ itemId: chestId, quantity: 1 });
  }
  console.log(`[vote-webhook] Gave 1x ${CHEST_NAMES[chestId]} to ${voterId}`);

  // Reward: god token every 5-streak
  const earnedGodToken = user.voteStreak % GOD_TOKEN_STREAK_INTERVAL === 0;
  if (earnedGodToken) {
    const godToken = user.items.find(i => i.itemId === 'god_token');
    if (godToken) {
      godToken.quantity = (godToken.quantity || 0) + 1;
    } else {
      user.items.push({ itemId: 'god_token', quantity: 1 });
    }
    console.log(`[vote-webhook] Gave 1x God Token to ${voterId} (streak milestone: ${user.voteStreak})`);
  }

  await user.save();
  console.log(`[vote-webhook] Rewards saved for user ${voterId} — streak: ${user.voteStreak}${earnedGodToken ? ', +God Token' : ''}`);

  // DM the voter
  if (_client) {
    try {
      const discordUser = await _client.users.fetch(voterId).catch(() => null);
      if (!discordUser) {
        console.warn(`[vote-webhook] Could not fetch Discord user ${voterId} for DM`);
        return;
      }

      const { EmbedBuilder } = require('discord.js');
      const rewardLines = [
        `<:resettoken:1490738386540171445> **1x Reset Token**`,
        `${CHEST_EMOJIS[chestId]} **1x ${CHEST_NAMES[chestId]}**`
      ];
      if (earnedGodToken) {
        rewardLines.push(`<:godtoken:1499957056650608753> **1x God Token** (Vote Streak x${user.voteStreak}!)`);
      }

      const nextMilestone = GOD_TOKEN_STREAK_INTERVAL - (user.voteStreak % GOD_TOKEN_STREAK_INTERVAL);
      const footerText = nextMilestone === GOD_TOKEN_STREAK_INTERVAL
        ? `Vote streak: ${user.voteStreak} — vote again in 12 hours!`
        : `Vote streak: ${user.voteStreak} — ${nextMilestone} more vote(s) until a God Token!`;

      const embed = new EmbedBuilder()
        .setColor('#FFFFFF')
        .setTitle('Thanks for voting!')
        .setDescription(`You voted for the bot on top.gg and received:\n\n${rewardLines.join('\n')}`)
        .setFooter({ text: footerText })
        .setThumbnail(_client.user.displayAvatarURL());

      await discordUser.send({ embeds: [embed] });
      console.log(`[vote-webhook] DM sent successfully to ${voterId}`);
    } catch (dmErr) {
      console.error(`[vote-webhook] Failed to DM user ${voterId}:`, dmErr.message);
    }
  } else {
    console.warn('[vote-webhook] Discord client not attached yet — DM skipped');
  }
}

function startVoteWebhook() {
  const app = express();

  // Parse all incoming bodies as JSON (Hookdeck forwards clean JSON)
  app.use(express.json());

  app.post('/webhook/topgg', async (req, res) => {
    console.log('[vote-webhook] Incoming POST /webhook/topgg');

    try {
      const payload = req.body || {};
      const type = payload.type;
      console.log(`[vote-webhook] Payload type: ${type}`);

      // Always respond 200 immediately so Hookdeck marks delivery as successful
      res.status(200).send({ status: 'success' });

      // Hookdeck test ping
      if (type === 'webhook.test') {
        console.log('[vote-webhook] Test ping received — webhook is working!');
        return;
      }

      // Real vote from Top.gg via Hookdeck: { type: "vote.create", data: { user: { platform_id: "..." } } }
      // Legacy direct Top.gg format: { type: "upvote", user: "..." }
      let voterId = null;
      if (type === 'vote.create' && payload.data && payload.data.user) {
        voterId = String(payload.data.user.platform_id || payload.data.user.id || '');
      } else if (payload.user) {
        voterId = String(payload.user);
      }

      if (!voterId) {
        console.warn('[vote-webhook] Could not extract voter ID from payload:', JSON.stringify(payload));
        return;
      }

      console.log(`[vote-webhook] Vote from user: ${voterId}`);
      await processVote(voterId);

    } catch (err) {
      console.error('[vote-webhook] UNCAUGHT ERROR processing vote:', err);
    }
  });

  // Keep legacy /dblwebhook route working too
  app.post('/dblwebhook', async (req, res) => {
    console.log('[vote-webhook] Incoming POST /dblwebhook');
    try {
      const payload = req.body || {};
      const voterId = payload.user ? String(payload.user) : null;
      res.status(200).send({ status: 'success' });
      if (!voterId) return;
      await processVote(voterId);
    } catch (err) {
      console.error('[vote-webhook] Error on /dblwebhook:', err);
    }
  });

  app.get('/webhook-status', (req, res) => {
    res.json({
      status: 'running',
      discordClientReady: !!_client,
      webhookUrl: 'POST /webhook/topgg',
      hookdeckUrl: 'https://hkdk.events/j3hyk0vlbg9m22'
    });
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is officially online and listening on port ${PORT}`);
  });
}

async function postServerCount(token, client) {
  try {
    if (!token) return console.warn('[top.gg] No token provided — skipping server count post');
    if (!client || !client.user) return console.warn('[top.gg] Discord client not available — skipping server count post');
    const botId = client.user.id;
    const url = `https://top.gg/api/bots/${botId}/stats`;
    const body = { server_count: client.guilds.cache.size };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify(body)
    });
    if (res.ok) {
      console.log(`[top.gg] Posted server count: ${body.server_count}`);
    } else {
      const txt = await res.text().catch(() => '');
      console.error('[top.gg] Failed to post server count:', res.status, txt);
    }
  } catch (err) {
    console.error('[top.gg] postServerCount error:', err);
  }
}

module.exports = { startVoteWebhook, setClient, postServerCount };
