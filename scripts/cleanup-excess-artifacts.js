#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { getCardById } = require('../utils/cards');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Set it in .env or environment.');
    process.exit(1);
  }

  let totalUsers = 0;
  let modifiedUsers = 0;
  let totalUnequipped = 0;

  try {
    await mongoose.connect(uri);
    console.log('Connected to MongoDB');

    const cursor = User.find({}).cursor();
    for await (const user of cursor) {
      totalUsers++;
      if (!user || !Array.isArray(user.ownedCards) || user.ownedCards.length === 0) continue;

      let changed = false;
      let unequippedThisUser = 0;

      // Build map: targetCardId -> [artifactEntries...]
      const map = new Map();
      for (const entry of user.ownedCards) {
        if (!entry || !entry.equippedTo) continue;
        const def = getCardById(entry.cardId);
        if (!def || !def.artifact) continue;
        const arr = map.get(entry.equippedTo) || [];
        arr.push(entry);
        map.set(entry.equippedTo, arr);
      }

      for (const [targetId, artifacts] of map.entries()) {
        const targetDef = getCardById(targetId);
        if (!targetDef) continue;

        const targetOwnedEntry = user.ownedCards.find(e => e.cardId === targetId) || null;
        let allowed = 1;
        if (targetDef.character && String(targetDef.character).toLowerCase() === 'roronoa zoro' && targetOwnedEntry && (targetOwnedEntry.starLevel || 0) >= 7) {
          allowed = 3;
        }

        if (artifacts.length > allowed) {
          // Keep the first `allowed` artifacts (deterministic order), unequip the rest
          artifacts.sort((a, b) => String(a.cardId).localeCompare(String(b.cardId)));
          const extras = artifacts.slice(allowed);
          for (const ex of extras) {
            ex.equippedTo = null;
            unequippedThisUser++;
          }
          changed = true;
        }
      }

      if (changed) {
        await user.save();
        modifiedUsers++;
        totalUnequipped += unequippedThisUser;
        console.log(`Fixed user ${user.userId}: unequipped ${unequippedThisUser} artifact(s)`);
      }
    }

    console.log(`Finished. Processed ${totalUsers} users. Modified ${modifiedUsers} users. Total unequipped artifacts: ${totalUnequipped}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Cleanup failed:', err);
    try { await mongoose.disconnect(); } catch (_) {}
    process.exit(1);
  }
}

main();
