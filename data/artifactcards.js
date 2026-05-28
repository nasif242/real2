// Consolidated artifact definitions and flattening logic
// This file mirrors the flattening behavior used by data/cards.js
// and exports a `cards` array containing only artifact cards.

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

// Seeded PRNG + stat generation — mirrors cards.js so artifacts get consistent
// rank-derived stats without hardcoding them in the source data.
function seedRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function cardIdSeed(id) {
  const str = String(id);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
  return h;
}
const RANK_STAT_RANGES = {
  D:  { power: [0,  5],  health: [1,   8],  speed: [1,  1]  },
  C:  { power: [5,  10], health: [8,   15], speed: [1,  3]  },
  B:  { power: [10, 15], health: [15,  26], speed: [1,  5]  },
  A:  { power: [15, 20], health: [26,  35], speed: [3,  8]  },
  S:  { power: [20, 30], health: [35,  50], speed: [6,  12] },
  SS: { power: [30, 50], health: [50,  80], speed: [10, 20] },
  UR: { power: [50, 80], health: [75, 120], speed: [18, 30] }
};
function parseRank(rank) {
  if (!rank) return { baseRank: rank, modifier: 0 };
  const last = rank[rank.length - 1];
  if (last === '-') return { baseRank: rank.slice(0, -1), modifier: -1 };
  if (last === '+') return { baseRank: rank.slice(0, -1), modifier:  1 };
  return { baseRank: rank, modifier: 0 };
}
function generateArtifactStats(rank, cardId) {
  const { baseRank, modifier } = parseRank(rank);
  const r = RANK_STAT_RANGES[baseRank];
  if (!r) return null;
  const rng = seedRng(cardIdSeed(cardId));
  function randStat(lo, hi) {
    const span = hi - lo;
    let bandLo, bandHi;
    if (modifier === -1) { bandLo = lo;               bandHi = lo + span * 0.25; }
    else if (modifier === 1) { bandLo = lo + span * 0.75; bandHi = hi; }
    else                  { bandLo = lo + span * 0.25; bandHi = lo + span * 0.75; }
    if (bandHi <= bandLo) return Math.round(bandLo);
    return Math.max(Math.round(lo), Math.min(Math.round(hi),
      Math.round(bandLo + rng() * (bandHi - bandLo))));
  }
  return {
    power:      randStat(r.power[0],  r.power[1]),
    health:     randStat(r.health[0], r.health[1]),
    speed:      randStat(r.speed[0],  r.speed[1]),
    attack_min: 0,
    attack_max: 0
  };
}

function flattenCards(consolidatedCards) {
  const result = [];
  const usedIds = new Set();
  const COUNT_ICON_BY_VALUE = { 2: '<:2_:1503002986560094228>', 3: '<:3_:1503002985578365118>' };

  consolidatedCards.forEach(card => {
    if (!card.id) return;
    if (usedIds.has(card.id)) throw new Error(`Duplicate card id ${card.id} in artifactcards`);
    usedIds.add(card.id);

    // Generate stats from rank — artifacts always have 0 attack
    const stats = generateArtifactStats(card.rank, card.id);
    // Store only the base rank — the +/- only affects stat generation
    const { baseRank } = parseRank(card.rank);

    const flattedCard = {
      id: card.id,
      character: card.character,
      alias: card.alias,
      title: card.title,
      faculty: card.faculty !== undefined ? card.faculty : null,
      group: card.group,
      rank: baseRank,
      mastery: 1,
      pullable: card.pullable !== undefined ? card.pullable : true,
      image_url: card.image_url
    };

    if (stats) {
      flattedCard.power      = stats.power;
      flattedCard.health     = stats.health;
      flattedCard.speed      = stats.speed;
      flattedCard.attack_min = 0;
      flattedCard.attack_max = 0;
    }

    if (card.special_attack) flattedCard.special_attack = card.special_attack;
    if (card.effect !== undefined) flattedCard.effect = card.effect;
    if (card.effectDuration !== undefined) flattedCard.effectDuration = card.effectDuration;
    if (card.effectAmount !== undefined) flattedCard.effectAmount = card.effectAmount;
    if (card.effectChance !== undefined) flattedCard.effectChance = card.effectChance;
    if (card.itself !== undefined) flattedCard.itself = card.itself;
    if (card.count !== undefined) flattedCard.count = card.count;
    if (card.scount !== undefined) flattedCard.scount = card.scount;
    if (card.all !== undefined) {
      const val = card.all === true ? 3 : card.all;
      if (card.special_attack) flattedCard.scount = val;
      else flattedCard.count = val;
    }

    if (flattedCard.count !== undefined && COUNT_ICON_BY_VALUE[flattedCard.count]) {
      flattedCard.countIcon = COUNT_ICON_BY_VALUE[flattedCard.count];
    }
    if (flattedCard.scount !== undefined && COUNT_ICON_BY_VALUE[flattedCard.scount]) {
      flattedCard.scountIcon = COUNT_ICON_BY_VALUE[flattedCard.scount];
    }

    const isArtifact = !!card.artifact;
    if (card.attribute && !isArtifact) flattedCard.attribute = card.attribute;
    if (card.emoji) {
      flattedCard.emoji = isArtifact ? card.emoji : getAttributeEmoji(card);
    }
    if (card.boost) flattedCard.boost = card.boost;
    if (card.artifact) flattedCard.artifact = card.artifact;
    if (card.ship) flattedCard.ship = true;
    if (card.color) flattedCard.color = card.color;
    if (card.incomeMultiplier !== undefined) flattedCard.incomeMultiplier = card.incomeMultiplier;
    if (card.capacity !== undefined) flattedCard.capacity = card.capacity;
    if (card.startingBalance !== undefined) flattedCard.startingBalance = card.startingBalance;
    if (card.cola !== undefined) flattedCard.cola = card.cola;
    if (card.maxCola !== undefined) flattedCard.maxCola = card.maxCola;

    result.push(flattedCard);
  });
  return result;
}

// Consolidated artifact entries (moved from data/cards.js)
const consolidatedArtifactData = [
  {
    character: "Strawhat",
    alias: ["strawhat artifact", "artifact strawhat"],
    id: "a001",
    attribute: "STR",
    rank: "A",
    pullable: true,
    emoji: "<:strawhat:1492324127590322238>",
    title: "Monkey D. Luffy's Strawhat",
    faculty: "Strawhat Pirates",
    boost: "Monkey D. Luffy, (15%), Shanks, (15%)",
    artifact: true,
    image_url: "https://files.catbox.moe/ia6kin.webp"
  },
  {
    character: "Usopp's Hammer",
    alias: ["usopps hammer", "usopp hammer", "hammer"],
    id: "a002",
    attribute: "STR",
    rank: "B",
    pullable: true,
    emoji: "<:1000048122:1497621468975206441>",
    title: "Usopp's Hammer",
    faculty: "Strawhat Pirates",
    boost: "Usopp, Attack (10%)",
    artifact: true,
    image_url: "https://files.catbox.moe/tjvn6x.webp"
  },
  {
    character: "Wado Ichimonji",
    alias: ["wado ichimonji", "wado"],
    id: "a003",
    attribute: "STR",
    rank: "S",
    pullable: true,
    emoji: "<:1000048114:1497621621215854694>",
    title: "Wado Ichimonji",
    faculty: "Strawhat Pirates",
    boost: "Shimotsuki Kouzaburou, Attack (20%), Koushirou, Attack (20%), Kuina, Attack (20%), Roronoa Zoro, Attack (20%)",
    artifact: true,
    image_url: "https://files.catbox.moe/unxsgx.webp"
  },
  {
    character: "Soul Solid",
    alias: ["soul solid"],
    id: "a004",
    attribute: "STR",
    rank: "A",
    pullable: true,
    emoji: "<:1000048129:1497621484594528296>",
    title: "Soul Solid",
    faculty: "Strawhat Pirates",
    boost: "Brook, Attack (15%)",
    artifact: true,
    image_url: "https://files.catbox.moe/ap6t9v.webp"
  },
  {
    character: "Chopper's Post-ts Hat",
    alias: ["chopper post-ts hat", "chopper hat", "post-ts hat"],
    id: "a005",
    attribute: "STR",
    rank: "A",
    pullable: true,
    emoji: "<:1000048128:1497621759350935693>",
    title: "Chopper's Post-ts Hat",
    faculty: "Strawhat Pirates",
    boost: "Tony Tony Chopper (10%)",
    artifact: true,
    image_url: "https://files.catbox.moe/v9gj1d.webp"
  },
  {
    character: "Chopper's Pre-ts Hat",
    alias: ["chopper pre-ts hat", "chopper hat", "pre-ts hat"],
    id: "a006",
    attribute: "STR",
    rank: "A",
    pullable: true,
    emoji: "<:1000048127:1497621483097427968>",
    title: "Chopper's Pre-ts Hat",
    faculty: "Strawhat Pirates",
    boost: "Tony Tony Chopper (10%)",
    artifact: true,
    image_url: "https://files.catbox.moe/de8b59.webp"
  },
  {
    character: "Sanji's Germa Suit",
    alias: ["sanji germa suit", "germa suit", "sanji suit"],
    id: "a007",
    attribute: "STR",
    rank: "S",
    pullable: true,
    emoji: "<:1000048126:1497621470774296717>",
    title: "Sanji's Germa Suit",
    faculty: "Strawhat Pirates",
    boost: "Vinsmoke Sanji (15%)",
    artifact: true,
    image_url: "https://files.catbox.moe/vrj5u0.webp"
  },
  {
    character: "Clima-tact",
    alias: ["clima-tact", "climatact", "clima tact"],
    id: "a008",
    attribute: "STR",
    rank: "S",
    pullable: true,
    emoji: "<:1000048125:1497621482199580672>",
    title: "Clima-tact",
    faculty: "Strawhat Pirates",
    boost: "Nami,  Attack (20%)",
    artifact: true,
    image_url: "https://files.catbox.moe/urz30u.webp"
  },
  {
    character: "Usopp's Goggles",
    alias: ["usopps goggles", "usopp goggles", "goggles"],
    id: "a009",
    attribute: "STR",
    rank: "C",
    pullable: true,
    emoji: "<:1000048123:1497621887004704838>",
    title: "Usopp's Goggles",
    faculty: "Strawhat Pirates",
    boost: "Usopp, Health (5%)",
    artifact: true,
    image_url: "https://files.catbox.moe/nm0cuv.webp"
  },
  {
    character: "Usopp's Rubber band of Doom",
    alias: ["usopp rubber band of doom", "rubber band of doom", "usopp rubberband"],
    id: "a010",
    attribute: "STR",
    rank: "C",
    pullable: true,
    emoji: "<:1000048124:1497621480970653726>",
    title: "Usopp's Rubber band of Doom",
    faculty: "Strawhat Pirates",
    boost: "Usopp, Attack (5%)",
    artifact: true,
    image_url: "https://files.catbox.moe/m29d0n.webp"
  },
  {
    character: "Kuro Kabuto",
    alias: ["kuro kabuto"],
    id: "a011",
    attribute: "STR",
    rank: "A",
    pullable: true,
    emoji: "<:1000048121:1497621855786238185>",
    title: "Kuro Kabuto",
    faculty: "Strawhat Pirates",
    boost: "Usopp, Attack(15%)",
    artifact: true,
    image_url: "https://files.catbox.moe/vojng7.webp"
  },
  {
    character: "Ginga Kabuto",
    alias: ["ginga kabuto"],
    id: "a012",
    attribute: "STR",
    rank: "C",
    pullable: true,
    emoji: "<:1000048120:1497621694054137956>",
    title: "Ginga Kabuto",
    faculty: "Strawhat Pirates",
    boost: "Usopp, Attack (5%)",
    artifact: true,
    image_url: "https://files.catbox.moe/vspiir.webp"
  },
  {
    character: "Shusui",
    alias: ["shusui"],
    id: "a014",
    attribute: "STR",
    rank: "A",
    pullable: true,
    emoji: "<:1000048117:1497621497043357768>",
    title: "Shusui",
    faculty: "Strawhat Pirates",
    boost: "Shimotsuki Ryuma, Attack(10%), Roronoa Zoro, Attack (10%)",
    artifact: true,
    image_url: "https://files.catbox.moe/nryljj.webp"
  },
  {
    character: "Enma",
    alias: ["enma"],
    id: "a015",
    attribute: "STR",
    rank: "S",
    pullable: true,
    emoji: "<:1000048116:1497621487547322480>",
    title: "Enma",
    faculty: "Strawhat Pirates",
    boost: "Shimotsuki Kouzaburou, Attack (20%), Koushirou, Attack (20%), Kuina, Attack (20%), Roronoa Zoro, Attack (20%)",
    artifact: true,
    image_url: "https://files.catbox.moe/qc7gci.webp"
  },
  {
    character: "Sandai Kitetsu",
    alias: ["sandai kitetsu"],
    id: "a016",
    attribute: "STR",
    rank: "A",
    pullable: true,
    emoji: "<:1000048115:1497621486108934295>",
    title: "Sandai Kitetsu",
    faculty: "Strawhat Pirates",
    boost: "Kouzuki Sukiyaki, Attack (15%), Ipponmatsu, Attack (15%), Roronoa Zoro, Attack (15%)",
    artifact: true,
    image_url: "https://files.catbox.moe/jmgiu1.webp"
  },
  {
    character: "Iron Mace",
    alias: ["iron mace", "iron-mace"],
    id: "a017",
    attribute: "STR",
    rank: "C",
    pullable: true,
    emoji: "<:Ironmace:1507743863975051394>",
    title: "Iron Mace",
    faculty: "Buggy Pirates",
    boost: "Alvida, Attack (5%)",
    artifact: true,
    image_url: null
  },
  {
    character: "Daisenso",
    alias: ["daisenso"],
    id: "a018",
    attribute: "STR",
    rank: "C",
    pullable: true,
    emoji: "<:Daisenso:1507741769389834301>",
    title: "Daisenso",
    faculty: null,
    boost: "Don Krieg, Attack (5%)",
    artifact: true,
    image_url: null
  },
  {
    character: "Kiribashi",
    alias: ["kiribashi"],
    id: "a019",
    attribute: "STR",
    rank: "A",
    pullable: true,
    emoji: "<:Kiribachi:1507792775922319560>",
    title: "Kiribashi",
    faculty: null,
    boost: "Arlong, Attack (10%)",
    artifact: true,
    image_url: null
  },
  {
    character: "Nanashaku Jite",
    alias: ["nanashaku jite", "nanashaku"],
    id: "a020",
    attribute: "STR",
    rank: "A",
    pullable: true,
    emoji: "<:Nanashaku:1507793172145897522>",
    title: "Nanashaku Jite",
    faculty: "Marines",
    boost: "Smoker, Attack (10%)",
    artifact: true,
    image_url: null
  },
  {
    character: "Shigure",
    alias: ["shigure"],
    id: "a021",
    attribute: "STR",
    rank: "B",
    pullable: true,
    emoji: "<:Shigure:1507795166046585022>",
    title: "Shigure",
    faculty: "Marines",
    boost: "Tashigi, Attack (7%)",
    artifact: true,
    image_url: null
  },
  {
    character: "Ace",
    alias: ["ace", "portgas d. ace's pistol", "ace pistol"],
    id: "a022",
    attribute: "STR",
    rank: "S",
    pullable: true,
    emoji: "<:ace:1507796067591393501>",
    title: "Ace",
    faculty: "Roger Pirates",
    boost: "Gol D. Roger, Attack (15%)",
    artifact: true,
    image_url: null
  },
  {
    character: "Gryphon",
    alias: ["gryphon"],
    id: "a023",
    attribute: "STR",
    rank: "S",
    pullable: true,
    emoji: "<:gryphon:1507796526771081236>",
    title: "Gryphon",
    faculty: "Red-Haired Pirates",
    boost: "Shanks, Attack (15%)",
    artifact: true,
    image_url: null
  }
];


exports.cards = flattenCards(consolidatedArtifactData);
