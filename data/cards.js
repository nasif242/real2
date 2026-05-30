// rank metadata (color and optional image) – used by embeds
exports.rankData = {
  D: { color: '#B87333', badge: 'https://files.catbox.moe/a1sid9.webp' },
  C: { color: '#f9a53f', badge: 'https://files.catbox.moe/a2v0t7.webp' },
  B: { color: '#c6c6c7', badge: 'https://files.catbox.moe/zkcg1y.webp' },
  A: { color: '#bfddff', badge: 'https://files.catbox.moe/bljs3q.webp' },
  S: { color: '#9966CC', badge: 'https://files.catbox.moe/5ep3w0.webp' },
  SS: { color: '#26619C', badge: 'https://files.catbox.moe/z8oqdf.png' },
  UR: { color: '#ff00f0', badge: 'https://files.catbox.moe/bst9ds.png' }
};

// Optional per-rank thumbnails used specifically for artifact embeds. These
// can be replaced with the provided CDN links for custom artifact thumbnails
// per-rank (D/C/B/A/S). By default these point to the same badge assets as
// the normal rank badges — override as needed.
exports.artifactThumbnails = {
  D: exports.rankData.D && exports.rankData.D.badge,
  C: exports.rankData.C && exports.rankData.C.badge,
  B: exports.rankData.B && exports.rankData.B.badge,
  A: exports.rankData.A && exports.rankData.A.badge,
  S: exports.rankData.S && exports.rankData.S.badge
};

const ATTRIBUTE_RANDOM_EMOJI = {
  STR: '<:STRrandom:1492293852873232455>',
  DEX: '<:Dexrandom:1492293859785441400>',
  QCK: '<:Qckrandom:1492293854265868300>',
  INT: '<:INTrandom:1492293858170765466>',
  PSY: '<:psyrandom:1492293855700062258>'
};

const OLD_RANDOM_EMOJI_TOKENS = new Set([
  '<:randomenemy:1491916913960423645>',
  '<:randomenemygreen:1491937401860259982>',
  '<:randomenemyqck:1491937598690820267>',
  '<:randomenemyint:1491938030611861574>',
  '<:randomenemypsy:1491937909060931847>'
]);

function getAttributeEmoji(card) {
  if (!card || !card.attribute) return card && card.emoji;
  const mappedEmoji = ATTRIBUTE_RANDOM_EMOJI[card.attribute];
  if (!mappedEmoji) return card.emoji;
  if (card.title === 'Random enemy' || OLD_RANDOM_EMOJI_TOKENS.has(card.emoji)) {
    return mappedEmoji;
  }
  return card.emoji;
}

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32 algorithm.
// Produces a deterministic sequence from a numeric seed so the same card id
// always generates the same stats across bot restarts.
// ---------------------------------------------------------------------------
function seedRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Hash a card id string to a 32-bit unsigned integer seed.
function cardIdSeed(id) {
  const str = String(id);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
  return h;
}

// ---------------------------------------------------------------------------
// Stat ranges per rank.
// Each stat has [min, max] for the full rank band.
// UR uses finite upper bounds so generation is always well-defined.
//
// Rank modifier sub-bands (applied per stat independently):
//   "S-"  → bottom 25 %  of the band  [min,  min + span*0.25]
//   "S"   → middle 50 %               [min + span*0.25, min + span*0.75]
//   "S+"  → top 25 %                  [min + span*0.75, max]
// ---------------------------------------------------------------------------
const RANK_STAT_RANGES = {
  D:  { power: [0,  5],  health: [1,   8],  speed: [1,  1],  attack_min: [1,  1],  attack_max: [1,  2]  },
  C:  { power: [5,  10], health: [8,   15], speed: [1,  3],  attack_min: [1,  3],  attack_max: [3,  6]  },
  B:  { power: [10, 15], health: [15,  26], speed: [1,  5],  attack_min: [2,  5],  attack_max: [5,  10] },
  A:  { power: [15, 20], health: [26,  35], speed: [3,  8],  attack_min: [4,  8],  attack_max: [8,  14] },
  S:  { power: [20, 30], health: [35,  50], speed: [6,  12], attack_min: [6,  12], attack_max: [12, 20] },
  SS: { power: [30, 50], health: [50,  80], speed: [10, 20], attack_min: [10, 18], attack_max: [18, 30] },
  UR: { power: [50, 80], health: [75, 120], speed: [18, 30], attack_min: [15, 25], attack_max: [25, 40] }
};

// Parse a rank string that may have a +/- modifier (e.g. "S-", "SS+", "UR").
// Returns { baseRank: string, modifier: -1 | 0 | 1 }.
function parseRank(rank) {
  if (!rank) return { baseRank: rank, modifier: 0 };
  const last = rank[rank.length - 1];
  if (last === '-') return { baseRank: rank.slice(0, -1), modifier: -1 };
  if (last === '+') return { baseRank: rank.slice(0, -1), modifier:  1 };
  return { baseRank: rank, modifier: 0 };
}

// Generate stats for a card deterministically from its rank and id.
// isBoost: if true, attack_min / attack_max are forced to 0.
function generateStatsForRank(rank, cardId, isBoost) {
  const { baseRank, modifier } = parseRank(rank);
  const r = RANK_STAT_RANGES[baseRank];
  if (!r) return null;

  const rng = seedRng(cardIdSeed(cardId));

  // Pick a random integer within the modifier-adjusted sub-band.
  function randStat(lo, hi) {
    const span = hi - lo;
    let bandLo, bandHi;
    if (modifier === -1) { bandLo = lo;               bandHi = lo + span * 0.25; }
    else if (modifier === 1) { bandLo = lo + span * 0.75; bandHi = hi; }
    else                  { bandLo = lo + span * 0.25; bandHi = lo + span * 0.75; }
    // For tiny / flat ranges both ends may be equal
    if (bandHi <= bandLo) return Math.round(bandLo);
    return Math.max(Math.round(lo), Math.min(Math.round(hi),
      Math.round(bandLo + rng() * (bandHi - bandLo))));
  }

  const power      = randStat(r.power[0],      r.power[1]);
  const health     = randStat(r.health[0],     r.health[1]);
  const speed      = randStat(r.speed[0],      r.speed[1]);
  let attack_min = 0, attack_max = 0;
  if (!isBoost) {
    attack_min = randStat(r.attack_min[0], r.attack_min[1]);
    attack_max = randStat(r.attack_max[0], r.attack_max[1]);
    if (attack_max < attack_min) attack_max = attack_min;
  }

  return { power, health, speed, attack_min, attack_max };
}

// Generate special-attack damage values from the card's base attack stats.
// min_atk ≈ 1.5× attack_min, max_atk ≈ 2× attack_max.
function generateSpecialStats(attack_min, attack_max) {
  return {
    min_atk: Math.max(1, Math.ceil(attack_min * 1.5)),
    max_atk: Math.max(1, Math.ceil(attack_max * 2))
  };
}

// ---------------------------------------------------------------------------
// Flatten the grouped format (faculty → characters → cards[]) into the flat
// array expected by the rest of the codebase.
// Stats (power/health/speed/attack) are generated deterministically from the
// card's rank + id using seeded RNG — they are NOT stored in the source data.
// ---------------------------------------------------------------------------
function flattenCards(groupedData) {
  const result = [];
  const usedIds = new Set();
  const COUNT_ICON_BY_VALUE = {
    2: '<:2_:1503002986560094228>',
    3: '<:3_:1503002985578365118>'
  };

  for (const facultyGroup of groupedData) {
    const faculty = facultyGroup.faculty || null;

    for (const charGroup of (facultyGroup.characters || [])) {
      const { character, alias } = charGroup;

      for (const card of (charGroup.cards || [])) {
        if (!card.id) {
          console.warn(`Card for ${character} has no explicit id, skipping`);
          continue;
        }
        if (usedIds.has(card.id)) {
          throw new Error(`Duplicate card id ${card.id} in card data`);
        }
        usedIds.add(card.id);

        const isBoost = !!card.boost;

        // Generate stats from rank (full rank string including modifier for sub-band math)
        const stats = generateStatsForRank(card.rank, card.id, isBoost);
        // Store only the base rank on the card — the +/- only affects stat generation
        const { baseRank } = parseRank(card.rank);

        const flatCard = {
          id: card.id,
          character,
          alias,
          title: card.title,
          faculty,
          group: card.group,
          rank: baseRank,
          mastery: 1,
          pullable: true,
          image_url: card.image_url
        };

        if (stats) {
          flatCard.power      = stats.power;
          flatCard.health     = stats.health;
          flatCard.speed      = stats.speed;
          flatCard.attack_min = stats.attack_min;
          flatCard.attack_max = stats.attack_max;
        }

        // Special attack: generate damage values from the card's attack stats
        if (card.special_attack) {
          const sa = { ...card.special_attack };
          if (stats && !isBoost) {
            const saStats = generateSpecialStats(stats.attack_min, stats.attack_max);
            sa.min_atk = saStats.min_atk;
            sa.max_atk = saStats.max_atk;
          }
          flatCard.special_attack = sa;
        }

        if (card.effect !== undefined) flatCard.effect = card.effect;
        if (card.effectDuration !== undefined) flatCard.effectDuration = card.effectDuration;
        if (card.effectAmount !== undefined) flatCard.effectAmount = card.effectAmount;
        if (card.effectChance !== undefined) flatCard.effectChance = card.effectChance;
        if (card.itself !== undefined) flatCard.itself = card.itself;

        // count / scount — multi-target attack/special-attack
        if (card.count !== undefined) flatCard.count = card.count;
        if (card.scount !== undefined) flatCard.scount = card.scount;
        // Legacy `all` migration
        if (card.all !== undefined) {
          const val = card.all === true ? 3 : card.all;
          if (card.special_attack) flatCard.scount = val;
          else flatCard.count = val;
        }

        if (flatCard.count !== undefined && COUNT_ICON_BY_VALUE[flatCard.count]) {
          flatCard.countIcon = COUNT_ICON_BY_VALUE[flatCard.count];
        }
        if (flatCard.scount !== undefined && COUNT_ICON_BY_VALUE[flatCard.scount]) {
          flatCard.scountIcon = COUNT_ICON_BY_VALUE[flatCard.scount];
        }

        const isArtifact = !!card.artifact;
        if (card.attribute && !isArtifact) flatCard.attribute = card.attribute;
        if (card.emoji) {
          flatCard.emoji = card.emoji;
        } else if (card.attribute && !isArtifact) {
          flatCard.emoji = getAttributeEmoji(card);
        }
        if (card.boost) flatCard.boost = card.boost;
        if (card.artifact) flatCard.artifact = card.artifact;
        if (card.ship) flatCard.ship = true;
        if (card.color) flatCard.color = card.color;
        if (card.incomeMultiplier !== undefined) flatCard.incomeMultiplier = card.incomeMultiplier;
        if (card.capacity !== undefined) flatCard.capacity = card.capacity;
        if (card.startingBalance !== undefined) flatCard.startingBalance = card.startingBalance;
        if (card.cola !== undefined) flatCard.cola = card.cola;
        if (card.maxCola !== undefined) flatCard.maxCola = card.maxCola;

        result.push(flatCard);
      }
    }
  }

  return result;
}

// Consolidated card definitions - upgrades are nested to reduce repetition

const consolidatedCardData = [
  {
    faculty: "Strawhat Pirates",
    characters: [
      {
        character: "Monkey D. Luffy",
        alias: ["luffy", "monkey d luffy", "strawhat"],
        cards: [
        {
          id: "0001",
          attribute: "STR",
          rank: "D",
          emoji: "<:MonkeyD:1492353158960124037>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0001.png",
          special_attack: {
            gif: "https://media1.tenor.com/m/eTo-ytFNLX8AAAAC/luffy-pistol.gif"
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Gum-Gum Pistol",
          id: "0002",
          attribute: "STR",
          rank: "B",
          emoji: "<:Luffygumgumpistol:1492353926257971341>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0002.png",
          special_attack: {
            name: "Gum-Gum Pistol",
            gif: "https://media1.tenor.com/m/eTo-ytFNLX8AAAAC/luffy-pistol.gif"
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Gum-Gum Bazooka",
          id: "0003",
          attribute: "STR",
          rank: "A",
          emoji: "<:Luffygumgumbazooka:1492505343291297874>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0003.png",
          special_attack: {
            name: "Gum-Gum Bazooka",
            gif: ""
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Gear 2",
          id: "0004",
          attribute: "STR",
          rank: "S",
          emoji: "<:0004:1492514154349723770>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0004.png",
          special_attack: {
            name: "Gear 2",
            gif: "https://media1.tenor.com/m/d1s-yLh9hcsAAAAC/one-piece.gif"
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        },
        {
          title: "Gum-Gum Baloon",
          id: "0216",
          attribute: "STR",
          rank: "A",
          emoji: "<:0216:1492515036340555949>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0216.png",
          special_attack: {
            name: "Gum-Gum Baloon",
            gif: "https://media1.tenor.com/m/YZqF7Vz-zeAAAAAC/fuusen-gomu.gif"
          },
          effect: "reflect",
          effectDuration: 1,
          itself: true
        },
        {
          title: "Gear Third",
          id: "0217",
          attribute: "STR",
          rank: "S",
          emoji: "<:0217:1492517167210565652>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0217.png",
          special_attack: {
            name: "Gear Third",
            gif: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0217.png"
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Gum-Gum Bazooka: Supermacy",
          id: "0420",
          attribute: "STR",
          rank: "S",
          emoji: "<:0420:1492517825594654902>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/400/0420.png",
          special_attack: {
            name: "Gum-Gum Bazooka",
            gif: "https://media1.tenor.com/m/niocnoxo9kcAAAAC/luffy.gif"
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Merveille's Adventurer",
          id: "0519",
          attribute: "STR",
          rank: "A",
          emoji: "<:0519:1492519794476318822>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0519.png"
        },
        {
          title: "Pirates' Attack",
          id: "0520",
          attribute: "STR",
          rank: "S",
          emoji: "<:0520:1492520316885401610>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0520.png",
          special_attack: {
            name: "Gum-Gum Giant Thor Axe",
            gif: "https://media1.tenor.com/m/qATRdgVYZo0AAAAd/one-piece-one-piece-strong-world.gif"
          },
          effect: "attackup",
          effectDuration: 1,
          itself: true
        },
        {
          title: "Davy Back Fight: Afro",
          id: "0570",
          attribute: "STR",
          rank: "B",
          emoji: "<:0570:1492524332940001381>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0570.png"
        },
        {
          title: "Davy Back Fight: Combat",
          id: "0571",
          attribute: "STR",
          rank: "A",
          emoji: "<:0571:1492526058745106634>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0571.png"
        },
        {
          title: "Voyage Log: Straw Hat Pirates",
          id: "0577",
          attribute: "STR",
          rank: "S",
          emoji: "<:0577:1492526330875482353>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0577.png"
        },
        {
          title: "Voyage Dream: Pirate King",
          id: "0578",
          attribute: "STR",
          rank: "S",
          emoji: "<:0578:1492526792773341234>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0578.png",
          special_attack: {
            name: "Gum-Gum Jet Gatling",
            gif: "https://media1.tenor.com/m/dMFIkRa_YTgAAAAC/luffy-one.gif"
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Swim Ring",
          id: "0659",
          attribute: "QCK",
          rank: "A",
          emoji: "<:0659:1492527517670838363>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0659.png"
        },
        {
          title: "Gum-Gum Gatling",
          id: "0727",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0727:1492527817903313086>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0727.png",
          special_attack: {
            name: "Gum-Gum Gatling",
            gif: "https://media1.tenor.com/m/NOneFWcoDMUAAAAC/ratiobymuuk.gif"
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Halloween Monster",
          id: "0761",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0761:1492528212880654386>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0761.png"
        },
        {
          title: "Star of Hope",
          id: "0794",
          attribute: "INT",
          rank: "A",
          emoji: "<:0794:1492528601281859694>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0794.png"
        },
        {
          title: "Nightmare Luffy, Star of Hope",
          id: "0795",
          attribute: "INT",
          rank: "S",
          emoji: "<:0795:1492528899848933516>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0795.png",
          special_attack: {
            name: "Gum-Gum Storm",
            gif: "https://media1.tenor.com/m/jydojpfOT7UAAAAd/nightmare-luffy-gum-gum-storm.gif"
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Summit War Survivor",
          id: "0936",
          attribute: "QCK",
          rank: "A",
          emoji: "<:0936:1492531934817947769>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0936.png"
        },
        {
          title: "Crew's Promise",
          id: "0937",
          attribute: "QCK",
          rank: "S",
          emoji: "<:0937:1492532329535635548>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0937.png"
        },
        {
          title: "Marked Enemy to Shoot",
          id: "4448",
          attribute: "STR",
          rank: "SS",
          emoji: "<:1000047644:1495181602286731395>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/400/4448.png",
          special_attack: {
            name: "Vanquishing Gum-Gum Dawn Rocket",
            gif: null
          },
          effect: "confusion",
          effectDuration: 2
        },
        {
          title: "Laugh Echoing on the Battlefield",
          id: "4447",
          attribute: "STR",
          rank: "S",
          emoji: "<:1000047646:1495182649201922068>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/400/4447.png",
          special_attack: {
            name: "Vanquishing Gum-Gum Dawn Rocket",
            gif: null
          },
          effect: "confusion",
          effectDuration: 2
        },
        {
          title: "Rampage in the Future City",
          id: "4432",
          attribute: "QCK",
          rank: "SS",
          emoji: "<:1000047647:1495183096981491812>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/400/4432.png",
          special_attack: {
            name: "Gum-Gum Dawn Cymbal",
            gif: null
          },
          effect: "confusion",
          effectDuration: 2
        },
        {
          title: "Escape! Impel Down",
          id: "4362",
          attribute: "INT",
          rank: "S",
          emoji: "<:1000047648:1495183576243769505>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4362.png"
        },
        {
          title: "Neo - Warrior in White Going Wild",
          id: "4352",
          attribute: "STR",
          rank: "S",
          emoji: "<:1000047649:1495184123114029076>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4352.png"
        },
        {
          title: "Mysterious suit of the Nation of science",
          id: "4351",
          attribute: "STR",
          rank: "A",
          emoji: "<:1000047650:1495184521295958127>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4351.png"
        },
        {
          title: "Reaching the Pinnacle",
          id: "4290",
          attribute: "STR",
          rank: "SS",
          emoji: "<:1000047651:1495184928046846146>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/200/4290.png",
          special_attack: {
            name: "Gomu Gomu no Gigant",
            gif: null
          },
          effect: "confusion",
          effectDuration: 1
        },
        {
          title: "Memories of Straw Hat Pirates",
          id: "4162",
          attribute: "DEX",
          rank: "UR",
          emoji: "<:4162:1502049156678553640>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4162.png",
          special_attack: {
            name: "Gum-Gum Pistol",
            gif: null
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Rushing Heartbeat",
          id: "4150",
          attribute: "INT",
          rank: "SS",
          emoji: "<:1000047653:1495186186510008370>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4150.png",
          special_attack: {
            name: "Gomu Gomu no Gigant",
            gif: null
          },
          effect: "confusion",
          effectDuration: 2
        },
        {
          title: "Awakened powers",
          id: "4149",
          attribute: "INT",
          rank: "S",
          emoji: "<:1000047655:1495187568067874906>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4149.png"
        },
        {
          title: "Warrior in white going wild",
          id: "4131",
          attribute: "DEX",
          rank: "SS",
          emoji: "<:1000047654:1495186628874862675>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4131.png",
          special_attack: {
            name: "Gomu Gomu no Gigant",
            gif: null
          },
          effect: "confusion",
          effectDuration: 2
        },
        {
          title: "Mysterious suit of the nation of science",
          id: "4130",
          attribute: "INT",
          rank: "S",
          emoji: "<:1000047656:1495188221947023550>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4130.png"
        },
        {
          title: "Age 70 - A different Future",
          id: "4129",
          attribute: "INT",
          rank: "S",
          emoji: "<:1000047657:1495188576508444873>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4129.png"
        },
        {
          title: "Encounter of the next journey",
          id: "4085",
          attribute: "INT",
          rank: "S",
          emoji: "<:1000047658:1495189127627280414>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4085.png"
        },
        {
          title: "Excitement before the feast",
          id: "4071",
          attribute: "QCK",
          rank: "SS",
          emoji: "<:1000047659:1495189635758821386>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4071.png",
          special_attack: {
            name: "Gum Gum Gatling",
            gif: null
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Fireworks lighting the skies of Wano",
          id: "4053",
          attribute: "QCK",
          rank: "SS",
          emoji: "<:1000047660:1495190237251637470>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4053.png",
          special_attack: {
            name: "Gum Gum Gatling",
            gif: null
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Enjoying the flavor of the Festival",
          id: "4047",
          attribute: "QCK",
          rank: "S",
          emoji: "<:1000047661:1495190825125154999>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4047.png"
        },
        {
          title: "Carving out his own Adventure",
          id: "4037",
          attribute: "PSY",
          rank: "UR",
          emoji: "<:1000047662:1495191490412937457>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4037.png",
          special_attack: {
            name: "King Kong Gun Finisher",
            gif: null
          },
          effect: "confusion",
          effectDuration: 1
        },
        {
          title: "Final Blow against the Demon King.",
          id: "4012",
          attribute: "STR",
          rank: "SS",
          emoji: "<:1000047664:1495192400895676436>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4012.png",
          special_attack: {
            name: "Gum-Gum Ryou Bazooka",
            gif: null
          },
          effect: "confusion",
          effectDuration: 2
        }
        ]
      },
      {
        character: "Roronoa Zoro",
        alias: ["zoro", "roronoa zoro", "pirate hunter"],
        cards: [
        {
          title: "",
          id: "0005",
          attribute: "DEX",
          rank: "B",
          emoji: "<:0005:1492532805434081510>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0005.png"
        },
        {
          title: "Three Thousand Worlds",
          id: "0006",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0006:1492533856388124885>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0006.png",
          special_attack: {
            name: "Three Thousand Worlds",
            gif: null
          },
          effect: "cut",
          effectDuration: 3
        },
        {
          title: "Pound Phoenix",
          id: "0007",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0007:1492534760810090737>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0007.png",
          special_attack: {
            name: "108 Pound Phoenix",
            gif: "https://media1.tenor.com/m/GbiM4UcfKX4AAAAC/zoro-roronoa-zoro.gif"
          },
          effect: "cut",
          effectDuration: 3
        },
        {
          title: "Ashura Ichibugin",
          id: "0008",
          attribute: "DEX",
          rank: "S",
          emoji: "<:0008:1492535386617155768>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0008.png",
          special_attack: {
            name: "Ashura Ichibugin",
            gif: "https://media1.tenor.com/m/OrUXc8YuElgAAAAd/demon-asura-nine-sword-style.gif"
          },
          effect: "cut",
          effectDuration: 3
        },
        {
          title: "Streaming Wolf Swords",
          id: "0218",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0218:1492536048356556992>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0218.png"
        },
        {
          title: "Lion's song",
          id: "0219",
          attribute: "DEX",
          rank: "S",
          emoji: "<:0219:1492537617156280460>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0219.png",
          special_attack: {
            name: "Lion's Song",
            gif: "https://media1.tenor.com/m/CbYM0rXR3BwAAAAC/zoro-film-gold.gif"
          },
          effect: "cut",
          effectDuration: 3
        },
        {
          title: "Three Thousand Worlds: The Final Stroke",
          id: "0421",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0421:1492538132594167891>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/400/0421.png",
          special_attack: {
            name: "Three Thousand Worlds: The Final Stroke",
            gif: null
          },
          effect: "cut",
          effectDuration: 3
        },
        {
          title: "Merveille's Wonder",
          id: "0553",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0553:1492539398821118062>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0553.png"
        },
        {
          title: "Straw Hat Pirates' Attack",
          id: "0554",
          attribute: "DEX",
          rank: "S",
          emoji: "<:0554:1492539868067139756>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0554.png"
        },
        {
          title: "Voyage Log: Straw Hat Pirates",
          id: "0579",
          attribute: "QCK",
          rank: "A",
          emoji: "<:0579:1492540212600115422>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0579.png"
        },
        {
          title: "Voyage Dream: Master Swordsman",
          id: "0580",
          attribute: "QCK",
          rank: "S",
          emoji: "<:0580:1492540767875366932>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0580.png"
        },
        {
          title: "Jack the Ripper",
          id: "0766",
          attribute: "QCK",
          rank: "A",
          emoji: "<:0766:1492541145895665685>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0766.png"
        },
        {
          title: "Gloom Island Swordsman",
          id: "0905",
          attribute: "STR",
          rank: "A",
          emoji: "<:0905:1492541781055897799>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0905.png"
        },
        {
          title: "Swordsman Disciple",
          id: "0906",
          attribute: "STR",
          rank: "S",
          emoji: "<:0906:1492542082622160957>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0906.png"
        },
        {
          title: "Zorojuro: Pursuing-Slasher Two Sword Style",
          id: "4378",
          attribute: "DEX",
          rank: "UR",
          emoji: "<:1000047665:1495193197918556412>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4378.png",
          special_attack: {
            name: "Cross-Slashing Blades",
            gif: null
          },
          effect: "bleed",
          effectDuration: -1,
          effectAmount: 5
        },
        {
          title: "Aiming for a Pinnacle",
          id: "4371",
          attribute: "QCK",
          rank: "UR",
          emoji: "<:1000048388:1498069571834216629>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4371.png",
          special_attack: {
            name: "Cross-Slashing Blades",
            gif: null
          },
          effect: "bleed",
          effectDuration: -1,
          effectAmount: 5
        },
        {
          title: "Determining his true potential",
          id: "4266",
          attribute: "INT",
          rank: "SS",
          emoji: "<:1000048390:1498070535345541171>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/200/4266.png",
          special_attack: {
            name: "True Potential of the Katana",
            gif: null
          },
          effect: "bleed",
          effectDuration: -1,
          effectAmount: 5
        },
        {
          title: "Strike against the flame",
          id: "4265",
          attribute: "INT",
          rank: "S",
          emoji: "<:1000048391:1498071118123372564>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/200/4265.png"
        },
        {
          title: "Paying respects to the dead",
          id: "4214",
          attribute: "STR",
          rank: "S",
          emoji: "<:1000048392:1498072101914017923>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/200/4214.png"
        },
        {
          title: "Memories of Straw hat Pirates",
          id: "4171",
          attribute: "DEX",
          rank: "SS",
          emoji: "<:1000048393:1498073057187860741>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4171.png",
          special_attack: {
            name: "One Sword Style: Lion's Strike",
            gif: null
          },
          effect: "bleed",
          effectDuration: -1,
          effectAmount: 5
        },
        {
          title: "Future Clothing of the science Island",
          id: "4155",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1000048394:1498073609045020862>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4155.png"
        },
        {
          title: "Splitting the warm Eddy",
          id: "4090",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000048395:1498074353294901358>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4090.png",
          special_attack: {
            name: "Splitting One-Sword Style: Bird Dance",
            gif: null
          }
        }
        ]
      },
      {
        character: "Nami",
        alias: ["nami", "tornado tempo", "mirage tempo", "thunderbolt tempo", "fine tempo", "happiness punch", "mirage tempo the heavens", "merveille's adventurer", "and billy the thunder bird", "blossom cloud", "blossom climate", "tea time", "voyage log: strawhat pirates", "voyage dream: world map", "on vacation", "ice cream loving nami", "ice cream loving lemon ice cream", "jackie o lantern", "angel in white wedding", "goddess in white wedding", "snowscape", "weather researcher", "weatheria cat burglar"],
        cards: [
        {
          title: "Nami",
          id: "0009",
          attribute: "INT",
          rank: "B",
          emoji: "<:0009:1492609629807448094>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0009.png"
        },
        {
          title: "Tornado Tempo",
          id: "0010",
          attribute: "INT",
          rank: "A",
          emoji: "<:0010:1492610844695986276>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0010.png",
          special_attack: {
            name: "Tornado Tempo",
            gif: null
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Mirage Tempo",
          id: "0011",
          attribute: "INT",
          rank: "A",
          emoji: "<:0011:1492646094125924553>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0011.png",
          special_attack: {
            name: "Mirage Tempo",
            gif: "https://media1.tenor.com/m/DjG8UDDaw7IAAAAd/one-piece-nami.gif"
          },
          effect: "confusion",
          effectDuration: 1
        },
        {
          title: "Thunderbolt Tempo",
          id: "0012",
          attribute: "INT",
          rank: "S",
          emoji: "<:0012:1492646615738220646>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0012.png",
          special_attack: {
            name: "Thunderbolt Tempo",
            gif: "https://media1.tenor.com/m/04rqkR4x6CgAAAAd/nami.gif"
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Fine Tempo",
          id: "0220",
          attribute: "INT",
          rank: "A",
          emoji: "<:0220:1492647395098624081>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0220.png",
          special_attack: {
            name: "Fine Tempo",
            gif: null
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Happiness Punch",
          id: "0221",
          attribute: "INT",
          rank: "S",
          emoji: "<:0221:1492647790126305400>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0221.png",
          special_attack: {
            name: "Happiness Punch",
            gif: "https://media1.tenor.com/m/NM44zX9jYasAAAAd/nami-vivi.gif"
          },
          effect: "confusion",
          effectDuration: 3
        },
        {
          title: "Mirage Tempo: The Heavens",
          id: "0422",
          attribute: "INT",
          rank: "A",
          emoji: "<:0422:1492648422547656724>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/400/0422.png",
          special_attack: {
            name: "Mirage Tempo",
            gif: "https://media1.tenor.com/m/DjG8UDDaw7IAAAAd/one-piece-nami.gif"
          },
          effect: "confusion",
          effectDuration: 1
        },
        {
          title: "Merveille's Adventurer",
          id: "0523",
          attribute: "QCK",
          rank: "A",
          emoji: "<:0523:1492648873913618652>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0523.png"
        },
        {
          title: "And billy the Thunder Bird",
          id: "0524",
          attribute: "QCK",
          rank: "S",
          emoji: "<:0524:1492651626035548222>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0524.png"
        },
        {
          title: "Blossom Cloud",
          id: "0535",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0535:1492652002948153394>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0535.png",
          special_attack: {
            name: "Mirage Tempo Fata Morgana: Blossom",
            gif: "https://media1.tenor.com/m/4bXHBKQLDQcAAAAC/nami-mirage-tempo.gif"
          },
          effect: "confusion",
          effectDuration: 1
        },
        {
          title: "Blossom Climate",
          id: "0536",
          attribute: "DEX",
          rank: "S",
          emoji: "<:0536:1492652666059227217>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0536.png",
          special_attack: {
            name: "Mirage Tempo Fata Morgana: Blossom",
            gif: "https://media1.tenor.com/m/4bXHBKQLDQcAAAAC/nami-mirage-tempo.gif"
          },
          effect: "confusion",
          effectDuration: 1
        },
        {
          title: "Tea Time",
          id: "0576",
          attribute: "INT",
          rank: "A",
          emoji: "<:0576:1492653026119254046>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0576.png"
        },
        {
          title: "Voyage Log: Strawhat Pirates",
          id: "0650",
          attribute: "INT",
          rank: "A",
          emoji: "<:0650:1492653333654016141>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0650.png"
        },
        {
          title: "Voyage Dream: World Map",
          id: "0651",
          attribute: "INT",
          rank: "S",
          emoji: "<:0651:1492653995460657272>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0651.png"
        },
        {
          title: "On vacation",
          id: "0662",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0662:1492655163134181476>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0662.png"
        },
        {
          title: "Ice Cream Loving Nami",
          id: "0680",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0680:1492655465455161434>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0680.png"
        },
        {
          title: "Ice Cream loving - Lemon Ice Cream",
          id: "0681",
          attribute: "DEX",
          rank: "S",
          emoji: "<:0681:1492655780099264662>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0681.png"
        },
        {
          title: "Jackie 'o Lantern",
          id: "0764",
          attribute: "QCK",
          rank: "A",
          emoji: "<:0764:1492656117946384457>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0764.png"
        },
        {
          title: "Angel in White: Wedding",
          id: "0807",
          attribute: "PSY",
          rank: "B",
          emoji: "<:0807:1492656519135625368>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/800/0807.png"
        },
        {
          title: "Goddess In White: Wedding",
          id: "0808",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0808:1492656853895610460>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/800/0808.png"
        },
        {
          title: "Snowscape",
          id: "0863",
          attribute: "QCK",
          rank: "A",
          emoji: "<:0863:1492657325188841732>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/800/0863.png"
        },
        {
          title: "Weather Researcher",
          id: "0938",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0938:1492657715208786062>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0938.png"
        },
        {
          title: "Weatheria Cat Burglar",
          id: "0939",
          attribute: "PSY",
          rank: "S",
          emoji: "<:0939:1492658221410812154>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0939.png"
        },
        {
          title: "Ordering the Helssman",
          id: "4531",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1000048396:1498074913045483520>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/500/4531.png"
        },
        {
          title: "Wave-Riding navigator",
          id: "4394",
          attribute: "STR",
          rank: "SS",
          emoji: "<:1000048397:1498075411119079524>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4394.png",
          special_attack: {
            name: "Zeus Tempo",
            gif: null
          },
          effect: "confusion",
          effectDuration: 3
        },
        {
          title: "Three-Sword Style Swordsman",
          id: "4367",
          attribute: "PSY",
          rank: "SS",
          emoji: "<:1000048398:1498076118597636317>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4367.png",
          special_attack: {
            name: "Eye Catching Swordplay",
            gif: null
          }
        },
        {
          title: "Riding the waver",
          id: "4361",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000048399:1498076614309970031>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4361.png"
        },
        {
          title: "Memories of strawhat Pirates",
          id: "4186",
          attribute: "DEX",
          rank: "SS",
          emoji: "<:1000048400:1498076896263405618>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4186.png",
          special_attack: {
            name: "Thunder Lance Tempo",
            gif: null
          },
          effect: "confusion",
          effectDuration: 3
        },
        {
          title: "Light and Cute future Clothing",
          id: "4157",
          attribute: "INT",
          rank: "S",
          emoji: "<:1000048401:1498077677960040583>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4157.png"
        },
        {
          title: "foreseeing a new place",
          id: "4093",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000048402:1498077936421568634>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4093.png"
        },
        {
          title: "Relaxing moment in the bath",
          id: "4072",
          attribute: "QCK",
          rank: "S",
          emoji: "<:1000048403:1498078451813322883>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4072.png"
        }
        ]
      },
      {
        character: "Usopp",
        alias: ["usopp", "tabasco star", "usopp golden pound", "sogeking", "usopp hammer", "impact", "usopp-un", "hercules' student", "merveille's adventurer", "straw hat pirates attack", "davy back fight cornerman", "voyage log strawhat pirates", "voyage dream brave warrior", "lying wolf", "pepper sauce star strike", "bowin islands food addict", "hero fighter of the forest"],
        cards: [
        {
          title: "Usopp",
          id: "0013",
          attribute: "PSY",
          rank: "B",
          emoji: "<:0013:1492660263441137825>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0013.png"
        },
        {
          title: "Tabasco Star",
          id: "0014",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0014:1492660530299539496>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0014.png",
          special_attack: {
            name: "Tabasco Star",
            gif: "https://media1.tenor.com/m/fL__PyRJTuYAAAAC/usopp-one-piece.gif"
          },
          effect: "bleed",
          effectDuration: 3
        },
        {
          title: "Usopp Golden Pound",
          id: "0015",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0015:1492661033280733205>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0015.png",
          special_attack: {
            name: "Golden Pound",
            gif: "https://media1.tenor.com/m/2KCIdLi3NJ4AAAAd/usopp-one-piece.gif"
          },
          effect: "confusion",
          effectDuration: 1
        },
        {
          title: "Sogeking",
          id: "0016",
          attribute: "PSY",
          rank: "S",
          emoji: "<:0016:1492662917760422009>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0016.png"
        },
        {
          title: "Usopp Hammer",
          id: "0222",
          attribute: "PSY",
          rank: "B",
          emoji: "<:0222:1492663511661416458>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0222.png",
          special_attack: {
            name: "Usopp Hammer",
            gif: "https://media1.tenor.com/m/NG52898sDosAAAAd/usopp-usopp-hammer.gif"
          },
          effect: "confusion",
          effectDuration: 1
        },
        {
          title: "Impact",
          id: "0223",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0223:1492663948510625925>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0223.png",
          special_attack: {
            name: "Impact Dial",
            gif: "https://media1.tenor.com/m/-M-KbgWbDuUAAAAd/usopp-one-piece.gif"
          },
          effect: "attackdown",
          effectDuration: 3,
          effectAmount: 80
        },
        {
          title: "Usopp-un",
          id: "0517",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0517:1492665046113980537>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0517.png"
        },
        {
          title: "Hercules' Student",
          id: "0518",
          attribute: "PSY",
          rank: "S",
          emoji: "<:0518:1492665322455433391>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0518.png"
        },
        {
          title: "Merveille's Adventurer",
          id: "0555",
          attribute: "QCK",
          rank: "A",
          emoji: "<:0555:1492665883405975634>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0555.png"
        },
        {
          title: "Straw Hat Pirates' Attack",
          id: "0556",
          attribute: "QCK",
          rank: "S",
          emoji: "<:0556:1492666157931696178>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0556.png"
        },
        {
          title: "Davy Back Fight: Cornerman",
          id: "0572",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0572:1492666486215544904>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0572.png"
        },
        {
          title: "Voyage Log: Strawhat Pirates",
          id: "0660",
          attribute: "QCK",
          rank: "A",
          emoji: "<:0660:1492666702587236422>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0660.png"
        },
        {
          title: "Voyage Dream: Brave Warrior",
          id: "0661",
          attribute: "QCK",
          rank: "S",
          emoji: "<:0661:1492666946758381608>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0661.png"
        },
        {
          title: "Lying Wolf",
          id: "0762",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0762:1492667260693774407>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0762.png"
        },
        {
          title: "Pepper Sauce Star: Strike",
          id: "0867",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0867:1492667722142715995>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0762.png",
          special_attack: {
            name: "Pepper Sauce Star: Strike",
            gif: "https://media1.tenor.com/m/L3Zfs1_z5gkAAAAd/usopp-one-piece.gif"
          },
          effect: "bleed",
          effectDuration: 3
        },
        {
          title: "Bowin Islands Food Addict",
          id: "0940",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0940:1492669371082870956>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0940.png"
        },
        {
          title: "Hero Fighter of the forest",
          id: "0941",
          attribute: "DEX",
          rank: "S",
          emoji: "<:0941:1492669607977423041>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0941.png"
        },
        {
          title: "the real bearer of communication",
          id: "4368",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1000048404:1498078779132870806>",
          image_url: null
        },
        {
          title: "Memories of strawhat Pirates",
          id: "4179",
          attribute: "DEX",
          rank: "SS",
          emoji: "<:1000048405:1498079147841552485>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4179.png",
          special_attack: {
            name: "Killer Long Distance Bagworm",
            gif: null
          },
          effect: "stun",
          effectDuration: 2
        }
        ]
      },
      {
        character: "Vinsmoke Sanji",
        alias: ["vinsmoke sanji", "sanji", "plastic surgery shot", "chef sanji hot rock stew", "diable jambe", "mr prince mutton shot", "mr prince veau shot", "parage shot the storm", "kamabakka queendom traditional fighting style", "candy", "merveille's wonder", "straw hat pirates attack", "voyage log strawhat pirates", "voyage dream all blue", "ghost knight", "kamabakka queendome escapee", "chef of love", "vinsmoke"],
        cards: [
        {
          title: "Vinsmoke Sanji",
          id: "0017",
          attribute: "QCK",
          rank: "B",
          emoji: "<:0017:1492692959739510885>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0017.png"
        },
        {
          title: "Plastic Surgery Shot",
          id: "0018",
          attribute: "QCK",
          rank: "A",
          emoji: "<:0018:1492693787409907895>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0018.png",
          special_attack: {
            name: "Plastic Surgery Shot",
            gif: "https://tenor.com/bWrQf.gif"
          },
          effect: "confusion",
          effectDuration: 3
        },
        {
          title: "Chef Sanji: Hot Rock Stew",
          id: "0019",
          attribute: "QCK",
          rank: "A",
          emoji: "<:0019:1492696111973138433>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0019.png"
        },
        {
          title: "Diable Jambe",
          id: "0020",
          attribute: "QCK",
          rank: "S",
          emoji: "<:0020:1492696839106068711>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0020.png",
          special_attack: {
            name: "Diable Jambe",
            gif: "https://tenor.com/bPHBt.gif"
          },
          effect: "cut",
          effectDuration: 3
        },
        {
          title: "Mr Prince: Mutton Shot",
          id: "0224",
          attribute: "QCK",
          rank: "B",
          emoji: "<:0224:1492698130452578366>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0224.png"
        },
        {
          title: "Mr Prince: Veau Shot",
          id: "0225",
          attribute: "QCK",
          rank: "A",
          emoji: "<:0225:1492699141003018340>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0225.png"
        },
        {
          title: "Parage Shot: The Storm",
          id: "0419",
          attribute: "QCK",
          rank: "A",
          emoji: "<:0419:1492699817879666831>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/400/0419.png"
        },
        {
          title: "Kamabakka Queendom Traditional Fighting Style",
          id: "0435",
          attribute: "QCK",
          rank: "B",
          emoji: "<:435:1492700841025736724>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/400/0435.png"
        },
        {
          title: "Candy",
          id: "0436",
          attribute: "QCK",
          rank: "A",
          emoji: "<:1000046913:1492702146972487762>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/400/0436.png"
        },
        {
          title: "Merveille's Wonder",
          id: "0521",
          attribute: "INT",
          rank: "A",
          emoji: "<:521:1492701594012356628>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0521.png"
        },
        {
          title: "Straw Hat Pirates' Attack",
          id: "0522",
          attribute: "INT",
          rank: "S",
          emoji: "<:0522:1492702640147271872>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0522.png"
        },
        {
          title: "Voyage Log: Strawhat Pirates",
          id: "0604",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0604:1492703176552484984>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0604.png"
        },
        {
          title: "Voyage Dream: All Blue",
          id: "0605",
          attribute: "DEX",
          rank: "S",
          emoji: "<:0605:1492703787008393347>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0605.png"
        },
        {
          title: "Ghost Knight",
          id: "0768",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0768:1492704205067260025>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0768.png"
        },
        {
          title: "Kamabakka Queendome Escapee",
          id: "0911",
          attribute: "DEX",
          rank: "A",
          emoji: "<:911:1492704800348045414>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0911.png"
        },
        {
          title: "Chef of Love",
          id: "0912",
          attribute: "DEX",
          rank: "S",
          emoji: "<:0912:1492705228900798484>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0912.png"
        },
        {
          title: "Soba Mask: Shooting star Jet-Black Warrior",
          id: "4335",
          attribute: "QCK",
          rank: "UR",
          emoji: "<:1000048406:1498082145590313041>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4335.png",
          special_attack: {
            name: "Shooting Star Soba Kick",
            gif: null
          },
          effect: "stun",
          effectDuration: 2
        },
        {
          title: "Kicking the highest autority",
          id: "4470",
          attribute: "STR",
          rank: "S",
          emoji: "<:1000048407:1498083789128077403>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/400/4470.png"
        },
        {
          title: "Love that surpasses light",
          id: "4435",
          attribute: "QCK",
          rank: "S",
          emoji: "<:1000048408:1498084056087265330>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/400/4435.png"
        },
        {
          title: "Puzzled Aloha",
          id: "4156",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000048409:1498084349382234232>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4156.png"
        }
        ]
      },
      {
        character: "Tony Tony Chopper",
        alias: ["chopper", "tony tony chopper"],
        cards: [
        {
          title: "",
          id: "0021",
          attribute: "PSY",
          rank: "B",
          emoji: "<:0021:1492986160669003776>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0021.png"
        },
        {
          title: "Heavy Point",
          id: "0022",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0022:1492986611670192239>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0022.png",
          special_attack: {
            name: "Heavy point",
            gif: "https://files.catbox.moe/ka2rro.gif"
          },
          effect: "defenseup",
          effectDuration: -1,
          itself: true
        },
        {
          title: "Brain Point",
          id: "0023",
          attribute: "INT",
          rank: "A",
          emoji: "<:0023:1492993621761200218>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0023.png",
          special_attack: {
            name: "Brain point",
            gif: "https://files.catbox.moe/b6i8ap.gif"
          },
          effect: "prone",
          effectDuration: -1
        },
        {
          title: "Arm Point",
          id: "0024",
          attribute: "STR",
          rank: "A",
          emoji: "<:0024:1492994983752368181>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0024.png",
          special_attack: {
            name: "Arm Point",
            gif: "https://files.catbox.moe/wekczr.gif"
          },
          effect: "attackup",
          effectDuration: 3,
          itself: true
        },
        {
          title: "Horn Point",
          id: "0025",
          attribute: "QCK",
          rank: "A",
          emoji: "<:0025:1492995638869360791>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0025.png",
          special_attack: {
            name: "Horn point",
            gif: "https://files.catbox.moe/acuej9.gif"
          },
          effect: "cut",
          effectDuration: 3
        },
        {
          title: "Guard Point",
          id: "0026",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0026:1492996588422037504>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0026.png",
          special_attack: {
            name: "Guard Point",
            gif: "https://files.catbox.moe/y3776u.gif"
          },
          effect: "reflect",
          effectDuration: 1,
          itself: true
        },
        {
          title: "Chopper man",
          id: "0247",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0247:1492997210764214432>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0247.png"
        },
        {
          title: "Pre-Rampage",
          id: "0248",
          attribute: "STR",
          rank: "A",
          emoji: "<:0248:1492998812976025660>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0248.png"
        },
        {
          title: "Monster Point",
          id: "0249",
          attribute: "STR",
          rank: "S",
          emoji: "<:0249:1492999758795640842>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0249.png",
          special_attack: {
            name: "Monster Point",
            gif: "https://files.catbox.moe/7eg2wl.gif"
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        },
        {
          title: "Merveille's Adventurer",
          id: "0527",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0527:1493001159814938788>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0527.png"
        },
        {
          title: "Straw Hat Pirates' Attack",
          id: "0528",
          attribute: "DEX",
          rank: "S",
          emoji: "<:0528:1493005166910112044>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0528.png"
        },
        {
          title: "Davy Back Fight: Mask",
          id: "0573",
          attribute: "PSY",
          rank: "B",
          emoji: "<:1000047005:1493005560197550223>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0573.png"
        },
        {
          title: "Voyage Log: Straw hat Pirates",
          id: "0596",
          attribute: "STR",
          rank: "A",
          emoji: "<:0596:1493006221689622539>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0596.png"
        },
        {
          title: "Voyage Dream: Great Doctor",
          id: "0597",
          attribute: "STR",
          rank: "S",
          emoji: "<:0597:1493006633079537704>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0597.png"
        },
        {
          title: "Lil' Vampire",
          id: "0765",
          attribute: "INT",
          rank: "A",
          emoji: "<:0765:1493007061259124846>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0765.png"
        },
        {
          title: "Chopper's snow day",
          id: "0854",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0854:1493007416353357834>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/800/0854.png"
        },
        {
          title: "Heavy Gong: Beast",
          id: "0868",
          attribute: "STR",
          rank: "S",
          emoji: "<:868:1493007763654054019>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/800/0868.png",
          special_attack: {
            name: "Heavy Gong",
            gif: "https://files.catbox.moe/ybhnh7.gif"
          },
          effect: "attackup",
          effectDuration: 3,
          itself: true
        },
        {
          title: "Birdie Kingdom Peace Broker",
          id: "0909",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0909:1493008837404397788>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0909.png"
        },
        {
          title: "Chopper mask: Defender of Peace",
          id: "0910",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000047013:1493009299583013135>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0910.png"
        },
        {
          title: "Caring for the crew",
          id: "4369",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000048418:1498088835748335817>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4369.png"
        },
        {
          title: "Memories of strawhat Pirates",
          id: "4182",
          attribute: "INT",
          rank: "SS",
          emoji: "<:1000048416:1498088118107115722>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4182.png",
          special_attack: {
            name: "Chopper's Miracle Cure",
            gif: null
          },
          effect: "regen",
          effectDuration: 3,
          effectAmount: 20,
          itself: true
        },
        {
          title: "Astonished by Future Science",
          id: "4148",
          attribute: "INT",
          rank: "S",
          emoji: "<:1000048417:1498088731159171164>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4148.png"
        },
        {
          title: "Amigasa hat Chopper",
          id: "4086",
          attribute: "INT",
          rank: "S",
          emoji: "<:1000048419:1498089259708452915>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4086.png"
        }
        ]
      },
      {
        character: "Nico Robin",
        alias: ["robin", "nico robin"],
        cards: [
        {
          title: "Nico Robin",
          id: "0210",
          attribute: "INT",
          rank: "S",
          emoji: "<:0210:1493012364998475878>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0210.png"
        },
        {
          title: "Tropical",
          id: "0514",
          attribute: "INT",
          rank: "A",
          emoji: "<:0514:1493012748517511238>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0514.png"
        },
        {
          title: "Cherry Blossom Falling",
          id: "0531",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0531:1493013069981286520>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0531.png"
        },
        {
          title: "Cherry Blossoms in full Bloom",
          id: "0532",
          attribute: "DEX",
          rank: "S",
          emoji: "<:0532:1493013458013126706>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0532.png"
        },
        {
          title: "Merveille's Adventurer",
          id: "0557",
          attribute: "INT",
          rank: "A",
          emoji: "<:0557:1493013823643324466>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0557.png"
        },
        {
          title: "Straw Hat Pirates' Attack",
          id: "0558",
          attribute: "INT",
          rank: "S",
          emoji: "<:0558:1493016421129654353>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0558.png"
        },
        {
          title: "Voyage Log: Strawhat Pirates",
          id: "0678",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0678:1493016867672166460>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0678.png"
        },
        {
          title: "Voyage Dream: 100 Year Void",
          id: "0679",
          attribute: "PSY",
          rank: "S",
          emoji: "<:0679:1493017338260230345>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0679.png"
        },
        {
          title: "Ice Cream-loving Robin",
          id: "0682",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0682:1493017709862977797>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0682.png"
        },
        {
          title: "Ice Cream Loving: Chocolate Ice Cream",
          id: "0683",
          attribute: "PSY",
          rank: "S",
          emoji: "<:0683:1493018376400932944>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0683.png"
        },
        {
          title: "Devil Child",
          id: "0708",
          attribute: "PSY",
          rank: "B",
          emoji: "<:0708:1493018796955402300>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0708.png"
        },
        {
          title: "Straw Hat Pirate",
          id: "0709",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0709:1493019102367846430>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0709.png"
        },
        {
          title: "Devil Girl",
          id: "0767",
          attribute: "DEX",
          rank: "A",
          emoji: "<:0767:1493019453775151416>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0767.png"
        },
        {
          title: "Cien Fleurs Wing: Flower",
          id: "0866",
          attribute: "INT",
          rank: "A",
          emoji: "<:0866:1493019896374624256>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/800/0866.png",
          special_attack: {
            name: "Cien Fleur",
            gif: "https://files.catbox.moe/vrhbn8.gif"
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Tequila Wolf Prisoner",
          id: "0907",
          attribute: "INT",
          rank: "A",
          emoji: "<:0907:1493021561618174053>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0907.png"
        },
        {
          title: "Flame of the revolution",
          id: "0908",
          attribute: "INT",
          rank: "S",
          emoji: "<:0908:1493021999008710778>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0908.png"
        },
        {
          title: "Bride of ohara",
          id: "0915",
          attribute: "QCK",
          rank: "A",
          emoji: "<:0915:1493022383118745620>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0915.png"
        },
        {
          title: "Beauty and Genius: Wedding",
          id: "0916",
          attribute: "QCK",
          rank: "S",
          emoji: "<:0916:1493022711621091530>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0916.png"
        },
        {
          title: "Geinsha Confronting the Shinobi",
          id: "4514",
          attribute: "DEX",
          rank: "SS",
          emoji: "<:1000048410:1498085046274359428>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/500/4514.png",
          special_attack: {
            name: "Mi Fleurs Gigantesco Mano of the Geisha",
            gif: null
          },
          effect: "stun",
          effectDuration: 2
        },
        {
          title: "Infiltrating geisha",
          id: "4513",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1000048411:1498085879179120861>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/500/4513.png"
        },
        {
          title: "Gratititude to the ships doctor",
          id: "4375",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000048412:1498086207496654998>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4375.png"
        },
        {
          title: "Memories of Strawhat pirares",
          id: "4187",
          attribute: "PSY",
          rank: "SS",
          emoji: "<:1000048413:1498086488179736626>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4187.png",
          special_attack: {
            name: "Mother's Hands",
            gif: null
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Cool and fashionable future clothing",
          id: "4158",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1000048414:1498087190960279572>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4158.png"
        },
        {
          title: "Locating the enemy",
          id: "4094",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000048415:1498087542090895370>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4094.png"
        }
        ]
      },
      {
        character: "Franky",
        alias: ["franky"],
        cards: [
        {
          title: "",
          id: "0336",
          attribute: "PSY",
          rank: "B",
          emoji: "<:0336:1493023840886853683>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/300/0336.png"
        },
        {
          title: "Dismantler",
          id: "0337",
          attribute: "INT",
          rank: "A",
          emoji: "<:0337:1493024139940987102>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/300/0337.png"
        },
        {
          title: "Merveille's Adventurer",
          id: "0559",
          attribute: "STR",
          rank: "A",
          emoji: "<:0559:1493024447639322695>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0559.png"
        },
        {
          title: "Straw Hat pirates' attack",
          id: "0560",
          attribute: "STR",
          rank: "S",
          emoji: "<:0560:1493024749889126600>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0560.png"
        },
        {
          title: "Voyage log: Strawhat Pirates",
          id: "0710",
          attribute: "PSY",
          rank: "A",
          emoji: "<:0710:1493026418110496950>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0710.png"
        },
        {
          title: "Voyage Dream: Ship of the seven seas",
          id: "0711",
          attribute: "PSY",
          rank: "S",
          emoji: "<:0711:1493026895196061989>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0711.png"
        },
        {
          title: "Straw Hat Pirates",
          id: "0739",
          attribute: "INT",
          rank: "A",
          emoji: "<:0739:1493027324327624814>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0739.png"
        },
        {
          title: "Frankenstein",
          id: "0763",
          attribute: "STR",
          rank: "A",
          emoji: "<:0763:1493027666830557224>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0763.png"
        },
        {
          title: "Fresh: Health comes first!",
          id: "0900",
          attribute: "DEX",
          rank: "A",
          emoji: "<:1000047047:1493029241028349992>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0900.png"
        },
        {
          title: "Cyborg Franky",
          id: "0901",
          attribute: "DEX",
          rank: "S",
          emoji: "<:901:1493029758236365042>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0901.png",
          special_attack: {
            name: "Centauros",
            gif: null
          },
          effect: "attackup",
          effectDuration: 3,
          itself: true
        },
        {
          title: "Mech-Animal Fighting Cyborg",
          id: "0942",
          attribute: "STR",
          rank: "A",
          emoji: "<:1000047050:1493031080935166215>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0942.png"
        },
        {
          title: "Cyborg: Baldimore's sacred Beast",
          id: "0943",
          attribute: "STR",
          rank: "S",
          emoji: "<:1000047051:1493031747603009688>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0943.png",
          special_attack: {
            name: "Baldimore",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        },
        {
          title: "beam against the Godhead",
          id: "4425",
          attribute: "QCK",
          rank: "SS",
          emoji: "<:1000048420:1498089500893515899>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/400/4425.png",
          special_attack: {
            name: "Benefactor-Protecting Radical Beam",
            gif: null
          },
          effect: "stun",
          effectDuration: 3
        },
        {
          title: "Losing the Method of Transportation",
          id: "4370",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000048421:1498090222443954246>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4370.png"
        },
        {
          title: "Reactive Counter",
          id: "4309",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1000048422:1498090459455688764>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4309.png"
        },
        {
          title: "Memories of Straw Hat Pirates",
          id: "4193",
          attribute: "DEX",
          rank: "SS",
          emoji: "<:1000048423:1498090659134050315>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4193.png",
          special_attack: {
            name: "Weapon Left",
            gif: null
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Perv in future clothing",
          id: "4168",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1000048424:1498091036604498111>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4168.png"
        },
        {
          title: "Arms to catch the swordsman",
          id: "4076",
          attribute: "QCK",
          rank: "S",
          emoji: "<:1000048425:1498091339332452485>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4076.png"
        }
        ]
      },
      {
        character: "Brook",
        alias: ["brook"],
        cards: [
        {
          title: "",
          id: "0423",
          attribute: "QCK",
          rank: "B",
          emoji: "<:1000047052:1493032674464501930>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/400/0423.png"
        },
        {
          title: "Humming Swordsman",
          id: "0424",
          attribute: "QCK",
          rank: "A",
          emoji: "<:1000047053:1493032871219429396>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/400/0424.png"
        },
        {
          title: "Merveille's Adventurer",
          id: "0525",
          attribute: "PSY",
          rank: "A",
          emoji: "<:1000047054:1493033135116652574>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0525.png"
        },
        {
          title: "Straw Hat pirates' attack",
          id: "0526",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000047055:1493033567696191588>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0526.png"
        },
        {
          title: "Cherry blossom Hair",
          id: "0533",
          attribute: "QCK",
          rank: "A",
          emoji: "<:1000047056:1493033870109704323>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0533.png"
        },
        {
          title: "Cherry blossom melody",
          id: "0534",
          attribute: "QCK",
          rank: "S",
          emoji: "<:1000047057:1493034323497193593>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0534.png"
        },
        {
          title: "Voyage log: Strawhat Pirates",
          id: "0612",
          attribute: "DEX",
          rank: "A",
          emoji: "<:1000047058:1493034639747453078>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0612.png"
        },
        {
          title: "Voyage Dream: Promised meeting",
          id: "0613",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1000047059:1493034990613823528>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0613.png"
        },
        {
          title: "Cowardly Skeleton",
          id: "0769",
          attribute: "INT",
          rank: "A",
          emoji: "<:1000047060:1493035322160971796>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0769.png"
        },
        {
          title: "Gentlemany skeleton",
          id: "0895",
          attribute: "DEX",
          rank: "B",
          emoji: "<:1000047061:1493035641871667210>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/800/0895.png"
        },
        {
          title: "Straw Hat Pirates",
          id: "0896",
          attribute: "DEX",
          rank: "A",
          emoji: "<:1000047062:1493036063474712659>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/800/0896.png"
        },
        {
          title: "Demon King of hungeria",
          id: "0913",
          attribute: "QCK",
          rank: "A",
          emoji: "<:1000047063:1493036498809782443>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0913.png"
        },
        {
          title: "Bone to be Wild",
          id: "0914",
          attribute: "QCK",
          rank: "S",
          emoji: "<:1000047064:1493037102730973305>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0914.png"
        },
        {
          title: "freezing chill of the dead",
          id: "4426",
          attribute: "PSY",
          rank: "SS",
          emoji: "<:1000048426:1498091761946464366>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/400/4426.png",
          special_attack: {
            name: "Freezing Slash",
            gif: null
          },
          effect: "stun",
          effectDuration: 2
        },
        {
          title: "Remembering bitter movies",
          id: "4372",
          attribute: "QCK",
          rank: "S",
          emoji: "<:1000048427:1498092145570222110>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4372.png"
        },
        {
          title: "Memories of strawhat pirates",
          id: "4197",
          attribute: "INT",
          rank: "SS",
          emoji: "<:1000048428:1498092550656098444>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4197.png",
          special_attack: {
            name: "Aube Coup Droit",
            gif: null
          },
          effect: "stun",
          effectDuration: 2
        },
        {
          title: "Charging to save the crew",
          id: "4310",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1000048429:1498092949194543254>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4310.png"
        },
        {
          title: "Excited over future clothing",
          id: "4169",
          attribute: "INT",
          rank: "S",
          emoji: "<:1000048430:1498093275800801410>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4169.png"
        },
        {
          title: "Unexplainable familiarity",
          id: "4091",
          attribute: "INT",
          rank: "S",
          emoji: "<:1000048431:1498093551475494922>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4091.png"
        }
        ]
      },
      {
        character: "Jinbe",
        alias: ["jinbe", "jimbei"],
        cards: [
        {
          title: "",
          id: "0409",
          attribute: "QCK",
          rank: "A",
          emoji: "<:1000047065:1493039454246666370>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/400/0409.png"
        },
        {
          title: "Warrior Shark",
          id: "0885",
          attribute: "PSY",
          rank: "A",
          emoji: "<:1000047067:1493040692216467546>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/800/0885.png"
        },
        {
          title: "Knight of the Sea",
          id: "0934",
          attribute: "INT",
          rank: "S",
          emoji: "<:1000047068:1493040998136156251>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0934.png"
        },
        {
          title: "Knight of the sea: Ex. Seven warlords of the Sea",
          id: "0935",
          attribute: "INT",
          rank: "SS",
          emoji: "<:1000047069:1493045625392988292>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0935.png",
          special_attack: {
            name: "Fishman Karatee!! Shark fist tile breaker",
            gif: null
          },
          effect: "confusion",
          effectDuration: 1
        },
        {
          title: "Hurried rendevus",
          id: "4530",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1000048432:1498093937376624810>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/500/4530.png"
        },
        {
          title: "Path-Clearing Fish-Man Karate",
          id: "4431",
          attribute: "PSY",
          rank: "SS",
          emoji: "<:1000048434:1498096131580624940>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/400/4431.png",
          special_attack: {
            name: "Seven Thousand Tile Roundhouse Kick",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        }
        ]
      },
      {
        character: "Nerfeltari Vivi",
        alias: ["nerfeltari vivi", "vivi", "princess vivi", "voyage log", "voyage dream", "pirate queen", "endless dream"],
        cards: [
        {
          id: "0072",
          attribute: "PSY",
          rank: "A",
          emoji: "<:1000048916:1499848586807218247>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0072.png"
        },
        {
          id: "0073",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000048917:1499849013107888268>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0073.png"
        },
        {
          title: "Voyage log: Princess of alabasta",
          id: "0725",
          attribute: "QCK",
          rank: "A",
          emoji: "<:1000048923:1499851593976385677>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0725.png"
        },
        {
          title: "Voyage Dream: Queen of the pirates",
          id: "0726",
          attribute: "QCK",
          rank: "S",
          emoji: "<:1000048924:1499851901993353337>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0726.png"
        },
        {
          title: "A vow in the great age of pirates: Pirate queen",
          id: "5030",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1000048925:1499856450095153222>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/5/000/5030.png"
        },
        {
          title: "In the Wake of Endless Dream: Princess of Alabasta",
          id: "5029",
          attribute: "DEX",
          rank: "A",
          emoji: "<:1000048926:1499856695655141386>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/5/000/5029.png"
        }
        ]
      },
      {
        character: "Zeus",
        alias: ["zeus", "thundercloud"],
        cards: [
        {
          id: "5001",
          attribute: "BASE",
          rank: "S",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/9/9b/Zeus_Anime_Infobox.png/revision/latest/scale-to-width-down/1000?cb=20220602000228"
        },
        {
          title: "The thundercloud",
          id: "5002",
          attribute: "BASE",
          rank: "SS",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/a/a8/Darken_Zeus_While_Attacking.png/revision/latest/scale-to-width-down/1000?cb=20180107062950",
          special_attack: {
            name: "Thunderbolt",
            gif: null
          },
          effect: "stun",
          effectDuration: 2
        }
        ]
      },
      {
        character: "Karoo",
        alias: ["karoo"],
        cards: [
        {
          id: "0444",
          attribute: "PSY",
          rank: "B",
          emoji: "<:1000048943:1499904851587371038>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/400/0444.png",
          boost: "Nerfeltari Vivi (10%)",
          type: "boost"
        }
        ]
      },
      {
        character: "Sunny-Kun",
        alias: ["sunny-kun", "sunny"],
        cards: [
        {
          id: "3700",
          attribute: "QCK",
          rank: "S",
          emoji: "<:1000048962:1499950664132984892>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/700/3700.png",
          boost: "Strawhat Pirates (5%)",
          type: "boost"
        }
        ]
      }
    ]
  },
  {
    faculty: null,
    characters: [
      {
        character: "Monkey D. Luffy",
        alias: ["luffy", "monkey d luffy", "strawhat"],
        cards: [
        {
          title: "Mt. Convo's Brothers 3",
          id: "0547",
          attribute: "STR",
          rank: "A",
          emoji: "<:0547:1492521943084302366>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0547.png"
        },
        {
          title: "Mt. Convo's Brothers 3, Cup of Sworn Brotherhood",
          id: "0548",
          attribute: "STR",
          rank: "S",
          emoji: "<:0548:1492523207889260544>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0548.png"
        }
        ]
      },
      {
        character: "Franky",
        alias: ["franky"],
        cards: [
        {
          title: "Franky's Familly",
          id: "0629",
          attribute: "INT",
          rank: "B",
          emoji: "<:0629:1493025115762589906>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0629.png"
        },
        {
          title: "Cutty Flam: Tom's Workers",
          id: "0849",
          attribute: "STR",
          rank: "B",
          emoji: "<:0849:1493028080355119134>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/800/0849.png"
        }
        ]
      },
      {
        character: "Jinbe",
        alias: ["jinbe", "jimbei"],
        cards: [
        {
          title: "Warlord of the Sea",
          id: "0410",
          attribute: "QCK",
          rank: "S",
          emoji: "<:1000047066:1493040336342220850>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/400/0410.png"
        }
        ]
      },
      {
        character: "Nerfeltari Vivi",
        alias: ["nerfeltari vivi", "vivi", "princess vivi", "princess of alabasta", "sand sand band sub-leader", "vivi wapol", "memories of alabasta"],
        cards: [
        {
          title: "~love~",
          id: "0439",
          attribute: "PSY",
          rank: "A",
          emoji: "<:1000048918:1499849203336347759>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/400/0439.png"
        },
        {
          title: "Princess Vivi: love",
          id: "0440",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000048919:1499849956570173551>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/400/0440.png"
        },
        {
          title: "Princess of alabasta kingdom",
          id: "0663",
          attribute: "PSY",
          rank: "B",
          emoji: "<:1000048920:1499850265119948810>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0663.png"
        },
        {
          title: "Sand Sand Band Sub-Leader",
          id: "0664",
          attribute: "PSY",
          rank: "A",
          emoji: "<:1000048921:1499850573040713768>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0664.png"
        },
        {
          title: "On Break",
          id: "0686",
          attribute: "QCK",
          rank: "A",
          emoji: "<:1000048922:1499851076130832464>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0686.png"
        },
        {
          title: "Vivi & Wapol",
          id: "4271",
          attribute: "QCK",
          rank: "S",
          emoji: "<:1000048927:1499857297445359749>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/200/4271.png",
          count: 2
        },
        {
          title: "Memories of Alabasta",
          id: "4238",
          attribute: "DEX",
          rank: "SS",
          emoji: "<:1000048928:1499857587431280822>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/200/4238.png",
          boost: "Strawhat Pirates (3%)",
          type: "boost"
        }
        ]
      },
      {
        character: "Blueno",
        alias: ["blueno", "bepo", "sunny-kun"],
        cards: [
        {
          id: "4025",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000048963:1499951101024403586>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4025.png",
          count: 3
        },
        {
          id: "4033",
          attribute: "PSY",
          rank: "SS",
          emoji: "<:1000048964:1499951561810645094>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4033.png",
          special_attack: {
            name: "Dashing little ones",
            gif: null
          },
          effect: "confusion",
          effectDuration: 2
        }
        ]
      },
      {
        character: "Silvers Rayleigh",
        cards: [
        {
          title: "Aiding the Dark King",
          id: "4098",
          attribute: "PSY",
          rank: "UR",
          emoji: "<:4098:1510283071918964897>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4098.png",
          special_attack: {
            name: "Overwhelming Aura of the Dark King"
          },
          effect: "drunk",
          effectDuration: 3
        },
        {
          title: "Rayleigh & Gaban",
          id: "3517",
          attribute: "PSY",
          rank: "S",
          emoji: "<:3517:1510312152190156891>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/500/3517.png",
          count: 2
        }
        ]
      },
      {
        character: "Gol D. Roger & Silvers Rayleigh & Gaban",
        cards: [
        {
          title: "Aiming to Become the World's Greatest Pirates",
          id: "4257",
          attribute: "<:STR:1490476222755639476>/<:INT:1490476207601483816>",
          rank: "SS",
          emoji: "<:4257:1510285392920973464>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/200/4257.png",
          special_attack: {
            name: "Furious Onslaught"
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true,
          scount: 3,
          count: 3
        }
        ]
      }
    ]
  },
  {
    faculty: "Boroque Works",
    characters: [
      {
        character: "Nico Robin",
        alias: ["robin", "nico robin"],
        cards: [
        {
          title: "Miss All Sunday - Boroque Works VP",
          id: "0209",
          attribute: "INT",
          rank: "A",
          emoji: "<:0209:1493010298750107689>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/200/0209.png"
        }
        ]
      },
      {
        character: "Nerfeltari Vivi",
        alias: ["nerfeltari vivi", "miss wednesday"],
        cards: [
        {
          title: "Miss wednesday",
          id: "0071",
          attribute: "PSY",
          rank: "B",
          emoji: "<:1000048915:1499845759233953842>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0071.png"
        }
        ]
      }
    ]
  },
  {
    faculty: "Roger Pirates",
    characters: [
      {
        character: "Gol D. Roger",
        alias: ["gol d roger", "roger", "king of the pirates", "captain roger"],
        cards: [
        {
          id: "3176",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000051509:1506032208522121247>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/100/3176.png"
        },
        {
          title: "Captain of the Roger Pirates",
          id: "3177",
          attribute: "PSY",
          rank: "SS",
          emoji: "<:1000051510:1506032443206144222>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/100/3177.png",
          special_attack: {
            name: "God of Fire Ace",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        },
        {
          title: "Great Pirate with Grand Dreams",
          id: "3626",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1000051511:1506033038490996917>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/600/3626.png"
        },
        {
          title: "Reaching the Final Island",
          id: "3627",
          attribute: "DEX",
          rank: "SS",
          emoji: "<:1000051512:1506033313981136947>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/600/3627.png",
          special_attack: {
            name: "God of Fire Ace",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        },
        {
          title: "Clash of the Formidable Forces",
          id: "3786",
          attribute: "PSY",
          rank: "UR",
          emoji: "<:1000051513:1506033775794978826>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/700/3786.png",
          special_attack: {
            name: "Divine Departure",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        },
        {
          title: "Parting of The King of The Pirates",
          id: "3885",
          attribute: "QCK",
          rank: "S",
          emoji: "<:1000051514:1506034071191556126>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/800/3885.png"
        },
        {
          title: "Roger & Oden - Set sail to the vast ocean",
          id: "4057",
          attribute: "QCK",
          rank: "S",
          emoji: "<:1000051515:1506034344274428075>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4057.png",
          count: 2
        },
        {
          title: "Roger & Oden - Remarkable grand adventure",
          id: "4058",
          attribute: "QCK",
          rank: "SS",
          emoji: "<:1000051516:1506034685111832697>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4058.png",
          special_attack: {
            name: "God of Fire Ace",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true,
          count: 2
        },
        {
          title: "King of the Pirates - the Man who Achieved it All",
          id: "4151",
          attribute: "DEX",
          rank: "SS",
          emoji: "<:1000051517:1506035162448662689>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4151.png",
          special_attack: {
            name: "God of Fire Ace",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        },
        {
          title: "Roger & Rayleigh & Gaban - Stepping onto God Valley",
          id: "4387",
          attribute: "INT",
          rank: "SS",
          emoji: "<:1000051518:1506036346836353145>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/300/4387.png",
          special_attack: {
            name: "God of Fire Ace",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true,
          count: 3
        },
        {
          title: "Recalling the Promise",
          id: "4572",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000051519:1506036798571151430>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/500/4572.png"
        },
        {
          title: "The Begging of the Great Age of Pirates",
          id: "4573",
          attribute: "PSY",
          rank: "SS",
          emoji: "<:1000051520:1506037079090401380>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/500/4573.png",
          special_attack: {
            name: "God of Fire Ace",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        }
        ]
      },
      {
        character: "Crocus",
        alias: ["crocus", "doctor crocus"],
        cards: [
        {
          id: "0587",
          attribute: "INT",
          rank: "B",
          emoji: "<:0587:1510314031657914610>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0587.png"
        },
        {
          title: "Twin Cape Lighthouse Keeper",
          id: "0588",
          attribute: "INT",
          rank: "A",
          emoji: "<:0588:1510314234301387024>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0588.png"
        },
        {
          title: "Lighthouse Keeper",
          id: "3182",
          attribute: "PSY",
          rank: "A",
          emoji: "<:3182:1510314542297780224>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/100/3182.png"
        },
        {
          title: "Waiting at the Cape to Fulfil a Promise",
          id: "3183",
          attribute: "PSY",
          rank: "S",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/100/3183.png",
          special_attack: {
            name: "Silent Intimidation"
          },
          effect: "regen",
          itself: true,
          all: true
        },
        {
          title: "Ship Doctor of the Roger Pirates",
          id: "3817",
          attribute: "PSY",
          rank: "S",
          emoji: "<:3817:1510316240655093830>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/800/3817.png"
        }
        ]
      },
      {
        character: "Rayleigh & Gaban",
        alias: ["rayleigh gaban", "rayleigh & gaban"],
        cards: [
        {
          title: "The Mighty Duo",
          id: "3810",
          attribute: "PSY/DEX",
          rank: "S",
          emoji: "<:3810:1510312834574188594>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/800/3810.png",
          special_attack: {
            name: "Unstoppable Onslaught"
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true,
          scount: 2,
          count: 2
        },
        {
          title: "The Assaulting Duo",
          id: "3811",
          attribute: "PSY/DEX",
          rank: "SS",
          emoji: "<:3811:1510313452789563664>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/800/3811.png",
          special_attack: {
            name: "Unstoppable Onslaught"
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true,
          scount: 2,
          count: 2
        }
        ]
      },
      {
        character: "Gaban",
        alias: ["gaban", "scopper gaban"],
        cards: [
        {
          id: "3395",
          attribute: "PSY",
          rank: "S",
          emoji: "<:3395:1510311641294704812>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/300/3395.png"
        }
        ]
      },
      {
        character: "Nozudon & Sambel",
        alias: ["nozudon", "sambel", "nozudon sambel"],
        cards: [
        {
          id: "3818",
          attribute: "PSY",
          rank: "S",
          emoji: "<:3818:1510335506498584656>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/800/3818.png",
          count: 2
        }
        ]
      },
      {
        character: "Kozuki Oden",
        alias: ["oden", "kozuki oden"],
        cards: [
        {
          title: "Aspiring to the Grand Voyage",
          id: "3619",
          attribute: "DEX",
          rank: "S",
          emoji: "<:3619:1510340070698123495>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/600/3619.png"
        },
        {
          title: "Welcoming Feast",
          id: "3620",
          attribute: "DEX",
          rank: "SS",
          emoji: "<:3620:1510339915005693992>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/600/3620.png",
          special_attack: {
            name: "Entertaining the Voyage"
          },
          effect: "bleed",
          effectDuration: -1,
          effectAmount: 5
        }
        ]
      },
      {
        character: "Moon Isaac Jr.",
        alias: ["moon isaac", "moon isaac jr", "isaac jr"],
        cards: [
        {
          title: "Tactical Staff Officer of the Roger Pirates",
          id: "6000",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/6/64/Moon_Isaac_Jr._Anime_Infobox.png/revision/latest?cb=20210411032337"
        }
        ]
      },
      {
        character: "Donquino",
        alias: ["donquino"],
        cards: [
        {
          title: "Helmsman of the Roger Pirates",
          id: "6003",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/4/49/Donquino_Anime_Infobox.png/revision/latest?cb=20210124103408"
        }
        ]
      },
      {
        character: "Millet Pine",
        alias: ["millet pine", "milletpine"],
        cards: [
        {
          title: "Torturer of the Roger Pirates",
          id: "6004",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/8/8d/Millet_Pine_Anime_Infobox.png/revision/latest?cb=20210412131305"
        }
        ]
      },
      {
        character: "Rowing",
        alias: ["rowing"],
        cards: [
        {
          title: "Scholar of the Roger Pirates",
          id: "6005",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/4/45/Rowing_Anime_Infobox.png/revision/latest?cb=20210124102143"
        }
        ]
      },
      {
        character: "Erio",
        alias: ["erio"],
        cards: [
        {
          title: "Information Broker of the Roger Pirates",
          id: "6006",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/3/36/Erio_Anime_Infobox.png/revision/latest?cb=20210321043944"
        }
        ]
      },
      {
        character: "Spencer",
        alias: ["spencer"],
        cards: [
        {
          title: "Member of the Roger Pirates",
          id: "6007",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/9/95/Spencer_Anime_Infobox.png/revision/latest?cb=20210714034828"
        }
        ]
      },
      {
        character: "Petermoo",
        alias: ["petermoo"],
        cards: [
        {
          title: "Gunner of the Roger Pirates",
          id: "6008",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/4/45/Petermoo_Anime_Infobox.png/revision/latest?cb=20210412130635"
        }
        ]
      },
      {
        character: "JacksonBanner",
        alias: ["jacksonbanner", "jackson banner"],
        cards: [
        {
          title: "Musician of the Roger Pirates",
          id: "6009",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/c/c6/Jacksonbanner_Anime_Infobox.png/revision/latest?cb=20210404035046"
        }
        ]
      },
      {
        character: "Bluemarine",
        alias: ["bluemarine", "blumarine"],
        cards: [
        {
          title: "Shipwright of the Roger Pirates",
          id: "6010",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/7/7b/Blumarine_Anime_Infobox.png/revision/latest?cb=20210124102746"
        }
        ]
      },
      {
        character: "MAX Marx",
        alias: ["max marx", "marx"],
        cards: [
        {
          title: "Cook of the Roger Pirates",
          id: "6011",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/9/91/MAX_Marx_Anime_Infobox.png/revision/latest?cb=20210328040737"
        }
        ]
      },
      {
        character: "Taro",
        alias: ["taro"],
        cards: [
        {
          title: "Member of the Roger Pirates",
          id: "6012",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/3/3c/Taro_Anime_Infobox.png/revision/latest?cb=20210403112556"
        }
        ]
      },
      {
        character: "Doringo",
        alias: ["doringo"],
        cards: [
        {
          title: "Member of the Roger Pirates",
          id: "6013",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/3/33/Doringo_Anime_Infobox.png/revision/latest/scale-to-width-down/1000?cb=20210328040148"
        }
        ]
      },
      {
        character: "Ganryu",
        alias: ["ganryu"],
        cards: [
        {
          title: "Member of the Roger Pirates",
          id: "6014",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/9/95/Ganryu_%28Roger_Pirates%29_Anime_Infobox.png/revision/latest?cb=20210404034431"
        }
        ]
      },
      {
        character: "CB Gallant",
        alias: ["cb gallant", "gallant"],
        cards: [
        {
          title: "Member of the Roger Pirates",
          id: "6015",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/7/77/CB_Gallant_Anime_Infobox.png/revision/latest?cb=20210321032722"
        }
        ]
      },
      {
        character: "Mr. Momora",
        alias: ["mr momora", "momora"],
        cards: [
        {
          title: "Member of the Roger Pirates",
          id: "6016",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/2/22/Mr._Momora_Anime_Infobox.png/revision/latest?cb=20210321035947"
        }
        ]
      },
      {
        character: "Yui",
        alias: ["yui"],
        cards: [
        {
          title: "Member of the Roger Pirates",
          id: "6017",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/2/2f/Yui_Anime_Infobox.png/revision/latest?cb=20210321033432"
        }
        ]
      },
      {
        character: "Rangram",
        alias: ["rangram"],
        cards: [
        {
          title: "Member of the Roger Pirates",
          id: "6018",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/f/fa/Rangram_Manga_Infobox.png/revision/latest?cb=20250915073155"
        }
        ]
      },
      {
        character: "Mugren",
        alias: ["mugren", "colonel mugren"],
        cards: [
        {
          title: "Colonel Mugren - Member of the Roger Pirates",
          id: "6019",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/5/5a/Mugren_Anime_Infobox.png/revision/latest?cb=20210404031141"
        }
        ]
      },
      {
        character: "Bankuro",
        alias: ["bankuro"],
        cards: [
        {
          title: "Member of the Roger Pirates",
          id: "6020",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/8/81/Bankuro_Anime_Infobox.png/revision/latest?cb=20210321040028"
        }
        ]
      },
      {
        character: "Yamon",
        alias: ["yamon"],
        cards: [
        {
          title: "Member of the Roger Pirates",
          id: "6021",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/c/ca/Yamon_Manga_Infobox.png/revision/latest?cb=20260405211900"
        }
        ]
      },
      {
        character: "Inurashi (Child)",
        alias: ["inurashi", "dogstorm child", "inurashi age 7", "inurashi child"],
        cards: [
        {
          title: "Inurashi at Age 7 - Roger Apprentice",
          id: "6022",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/5/50/Inuarashi_at_Age_7.png/revision/latest/scale-to-width-down/1000?cb=20211211002827"
        }
        ]
      },
      {
        character: "Nekomamushi (Child)",
        alias: ["nekomamushi", "cat viper child", "nekomamushi age 7", "nekomamushi child"],
        cards: [
        {
          title: "Nekomamushi at Age 7 - Roger Apprentice",
          id: "6023",
          attribute: "BASE",
          rank: "C",
          image_url: "https://static.wikia.nocookie.net/onepiece/images/2/21/Nekomamushi_at_Age_7.png/revision/latest/scale-to-width-down/1000?cb=20211211002655"
        }
        ]
      }
    ]
  },
  {
    faculty: "Red-Haired Pirates",
    characters: [
      {
        character: "Shanks",
        alias: ["shanks", "red-haired shanks", "red-haired", "black clad redhead", "black clad emperor", "pirate apprentice",],
        cards: [
        {
          id: "076",
          attribute: "PSY",
          rank: "A",
          emoji: "<:1000051521:1506038074042486995>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0076.png"
        },
        {
          id: "077",
          attribute: "PSY",
          rank: "A",
          emoji: "<:1000051522:1506038356943966218>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0077.png"
        },
        {
          title: "Black Clad Redhead",
          id: "529",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000051523:1506038607729922178>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0529.png"
        },
        {
          title: "Black Clad Emperor",
          id: "530",
          attribute: "PSY",
          rank: "SS",
          emoji: "<:1000051524:1506038942808674378>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/500/0530.png",
          special_attack: {
            name: "Divine Departure",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        },
        {
          title: "Pirate Apprentice",
          id: "600",
          attribute: "PSY",
          rank: "B",
          emoji: "<:1000051525:1506042090226974831>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0600.png"
        },
        {
          title: "Roger Pirates",
          id: "601",
          attribute: "PSY",
          rank: "A",
          emoji: "<:1000051526:1506042605262078144>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/600/0601.png"
        },
        {
          title: "Emperor and Captain of the Red-Haired Pirates",
          id: "4560",
          attribute: "STR",
          rank: "SS",
          emoji: "<:1000051527:1506042813941416037>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/500/4560.png",
          special_attack: {
            name: "Divine Departure",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        },
        {
          title: "Emperor Witnessing the End of the World",
          id: "4599",
          attribute: "STR",
          rank: "SS",
          emoji: "<:1000051528:1506043123686703297>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/500/4559.png",
          special_attack: {
            name: "Divine Departure",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        },
        {
          title: "Moon Knight Warrior",
          id: "4465",
          attribute: "INT",
          rank: "UR",
          emoji: "<:1000051529:1506043596556730468>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/400/4465.png"
        },
        {
          title: "Shanks & Beckman",
          id: "4270",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1000051530:1506043984399564901>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/200/4270.png",
          count: 2
        },
        {
          title: "Shaking the Great Era of Piracy",
          id: "4153",
          attribute: "PSY",
          rank: "SS",
          emoji: "<:1000051531:1506044279104082081>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4153.png",
          special_attack: {
            name: "Divine Departure",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        },
        {
          title: "Regaining Over the New Era",
          id: "4152",
          attribute: "PSY",
          rank: "SS",
          emoji: "<:1000051532:1506044666901037189>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/100/4152.png",
          special_attack: {
            name: "Divine Departure",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        },
        {
          title: "Approaching the New Era",
          id: "4056",
          attribute: "INT",
          rank: "UR",
          emoji: "<:1000051533:1506044962800795811>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4056.png",
          special_attack: {
            name: "Divine Departure",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        },
        {
          title: "Final Blow Against the Demon King",
          id: "4011",
          attribute: "PSY",
          rank: "SS",
          emoji: "<:1000051534:1506045348412391495>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4011.png",
          special_attack: {
            name: "Divine Departure",
            gif: null
          },
          effect: "attackup",
          effectDuration: -1,
          itself: true
        }
        ]
      },
      {
        character: "Lucky Roux",
        alias: ["lucky roux", "roux", "harbor town pirate"],
        cards: [
        {
          id: "776",
          attribute: "PSY",
          rank: "B",
          emoji: "<:1000051535:1506047834443747509>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0776.png"
        },
        {
          title: "Red-Hair Pirates",
          id: "777",
          attribute: "PSY",
          rank: "A",
          emoji: "<:1000051536:1506048075339399229>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/700/0777.png"
        },
        {
          title: "Harbor Town Pirate",
          id: "2045",
          attribute: "PSY",
          rank: "A",
          emoji: "<:1000051537:1506048325651267775>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/2/000/2045.png"
        },
        {
          id: "2555",
          attribute: "QCK",
          rank: "S",
          emoji: "<:1000051538:1506048543855607969>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/2/500/2555.png",
          effect: "attackdown",
          effectDuration: -1
        }
        ]
      },
      {
        character: "Ben Beckman",
        alias: ["ben beckman", "beckman", "beckman roux", "leading officers", "beckman yasopp"],
        cards: [
        {
          id: "952",
          attribute: "DEX",
          rank: "B",
          emoji: "<:1000051539:1506049998020808765>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0952.png"
        },
        {
          id: "953",
          attribute: "DEX",
          rank: "A",
          emoji: "<:1000051540:1506050222529314877>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/900/0953.png"
        },
        {
          title: "Red-Hair Pirates First Mate",
          id: "1769",
          attribute: "INT",
          rank: "A",
          emoji: "<:1000051541:1506050564562354428>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/1/700/1769.png"
        },
        {
          title: "Emperor's Right-Hand Man",
          id: "1770",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1000051542:1506050867445497978>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/1/700/1770.png"
        },
        {
          title: "Harbor Town Pirates",
          id: "2044",
          attribute: "PSY",
          rank: "A",
          emoji: "<:1000051543:1506051246631555273>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/2/000/2044.png"
        },
        {
          title: "Light-Stopping Gun Barrel",
          id: "2059",
          attribute: "STR",
          rank: "A",
          emoji: "<:1000051544:1506051530589995008>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/2/000/2059.png"
        },
        {
          title: "Light-Threatening Gun Barrel",
          id: "2060",
          attribute: "STR",
          rank: "S",
          emoji: "<:1000051545:1506051829447004230>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/2/000/2060.png"
        },
        {
          title: "Evening Respite",
          id: "3120",
          attribute: "INT",
          rank: "S",
          emoji: "<:1000051546:1506052267164307576>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/100/3120.png"
        },
        {
          title: "First Mate's Respose",
          id: "3358",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000051547:1506052706706522172>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/300/3358.png",
          special_attack: {
            name: "Haki Flintlock",
            gif: null
          },
          effect: "stun",
          effectDuration: 1
        },
        {
          title: "Ben Beckman",
          id: "3696",
          attribute: "STR",
          rank: "S",
          emoji: "<:1000051548:1506052986726518904>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/600/3696.png",
          count: 2
        },
        {
          title: "Beckman",
          id: "4547",
          attribute: "STR",
          rank: "SS",
          emoji: "<:1000051549:1506053611724079124>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/500/4547.png",
          special_attack: {
            name: "Double Snipe",
            gif: null
          },
          effect: "bleed",
          effectDuration: 3,
          count: 2
        }
        ]
      },
      {
        character: "Yasopp",
        alias: ["yasopp", "red-hair officer"],
        cards: [
        {
          title: "Harbor Town Pirate",
          id: "2046",
          attribute: "STR",
          rank: "A",
          emoji: "<:1000051550:1506055165948465182>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/2/000/2046.png"
        },
        {
          title: "Red-Hair Pirates Officer",
          id: "2554",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000051551:1506055383192436766>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/2/500/2554.png",
          special_attack: {
            name: "Sneak Attack",
            gif: null
          }
        },
        {
          title: "Sharpshooter in the Night",
          id: "3121",
          attribute: "INT",
          rank: "S",
          emoji: "<:1000051552:1506055656610730044>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/100/3121.png"
        }
        ]
      },
      {
        character: "Lime Juice",
        alias: ["lime juice"],
        cards: [
        {
          title: "Lime Juice",
          id: "4023",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000051553:1506057154149224618>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/4/000/4023.png",
          special_attack: {
            name: "Emotional Electrocution",
            gif: null
          },
          effect: "confusion",
          effectDuration: 2
        }
        ]
      },
      {
        character: "Gabu",
        alias: ["gabu", "gabu & snake"],
        cards: [
        {
          title: "Gabu & Snake",
          id: "3997",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000051554:1506058205229219960>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/900/3997.png",
          special_attack: {
            name: "Roars and Swords",
            gif: null
          },
          effect: "attackdown",
          effectDuration: -1,
          count: 2
        }
        ]
      },
      {
        character: "Bonk Punch",
        alias: ["bonk punch"],
        cards: [
        {
          title: "Bonk Punch & Monster",
          id: "3998",
          attribute: "PSY",
          rank: "S",
          emoji: "<:1000051555:1506058835801149470>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/3/900/3998.png",
          special_attack: {
            name: "Fists of the Coordinated Duo",
            gif: null
          },
          effect: "confusion",
          effectDuration: 3,
          count: 2
        }
        ]
      },
      {
        character: "Silvers Rayleigh",
        alias: ["silvers rayleigh", "rayleigh", "dark king", "cracked shiki"],
        cards: [
        {
          id: "0366",
          attribute: "INT",
          rank: "S",
          emoji: "<:0366:1509365140750078043>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/300/0366.png"
        },
        {
          title: "Dark King",
          id: "0367",
          attribute: "INT",
          rank: "SS",
          emoji: "<:0367:1509365530665156668>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/300/0367.png",
          special_attack: {
            name: "Dark king's aura"
          },
          effect: "doomed",
          effectDuration: 6
        },
        {
          title: "Pirate King Crewman",
          id: "1353",
          attribute: "QCK",
          rank: "A",
          emoji: "<:1353:1509368509023518830>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/1/300/1353.png"
        },
        {
          title: "Master of a Sleepless Town",
          id: "1354",
          attribute: "DEX",
          rank: "A",
          emoji: "<:1354:1509368986968785098>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/1/300/1354.png"
        },
        {
          title: "Dark King Shining in the Limelight",
          id: "1355",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1355:1509369658346573864>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/1/300/1355.png"
        },
        {
          title: "Straw Hat Pirates Contributor",
          id: "1533",
          attribute: "QCK",
          rank: "A",
          emoji: "<:1533:1509370109645426829>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/1/500/1533.png"
        },
        {
          title: "Straw Hat Pirates Conspirator",
          id: "1534",
          attribute: "QCK",
          rank: "S",
          emoji: "<:1534:1509370536818507786>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/1/500/1534.png"
        },
        {
          title: "The Dark King - Pirate King's Right-Hand Man",
          id: "1619",
          attribute: "INT",
          rank: "UR",
          emoji: "<:1619:1510246650583715970>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/1/600/1619.png",
          special_attack: {
            name: "Netherworld Conqueror"
          },
          effect: "drunk",
          effectDuration: -1
        },
        {
          title: "Old Man Watching Over the New Age",
          id: "1882",
          attribute: "DEX",
          rank: "S",
          emoji: "<:1882:1509708020504985600>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/1/800/1882.png"
        },
        {
          title: "Dark King - Old Man Watching Over the New Age",
          id: "1883",
          attribute: "DEX",
          rank: "SS",
          emoji: "<:1883:1509708919818293329>",
          image_url: "https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/1/800/1883.png",
          special_attack: {
            name: "Signaling the Begging of a Bright Future"
          },
          effect: "drunk",
          effectDuration: 3
        }
        ]
      }
    ]
  }
];



// Merge morecards (also grouped format) then flatten everything into the flat array
// expected by the rest of the codebase
const moreCardGroups = require('./morecards').moreCards || [];
exports.cards = flattenCards([...consolidatedCardData, ...moreCardGroups]);

// Merge artifact cards from data/artifactcards.js to preserve previous runtime
// behavior while keeping artifact definitions in their own file. This keeps
// backwards compatibility for code that expects artifacts to be present in
// `require('../data/cards').cards`.
try {
  const artifactCards = require('./artifactcards').cards || [];
  exports.cards = exports.cards.concat(artifactCards);
  exports.artifactCards = artifactCards;
} catch (e) {
  // ignore missing artifact file during transitional states
}

// Merge ship cards from data/shipcards.js
try {
  const shipCards = require('./shipcards').ships || [];
  exports.cards = exports.cards.concat(shipCards);
  exports.shipCards = shipCards;
} catch (e) {
  // ignore missing ship file during transitional states
}
