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

function clampStatsForRank(card) {
  if (!card || !card.rank) return card;
  const ranges = {
    D: { power: [0,5], health: [1,8], speed: [1,1], attack_min: [1,1], attack_max: [1,1] },
    C: { power: [5,10], health: [8,15], speed: [1,3], attack_min: [1,3], attack_max: [1,3] },
    B: { power: [10,15], health: [15,26], speed: [1,5], attack_min: [1,5], attack_max: [1,5] },
    A: { power: [15,20], health: [26,35], speed: [3,8], attack_min: [3,8], attack_max: [3,8] },
    S: { power: [20,30], health: [35,50], speed: [6,12], attack_min: [6,12], attack_max: [6,12] },
    SS: { power: [30,50], health: [50,80], speed: [10,20], attack_min: [10,20], attack_max: [10,20] },
    UR: { power: [50, Infinity], health: [75, Infinity], speed: [18, Infinity], attack_min: [10, Infinity], attack_max: [20, Infinity] }
  };

  const r = ranges[card.rank];
  if (!r) return card;

  const clamp = (v, mn, mx) => {
    if (v == null || Number.isNaN(Number(v))) return v;
    let n = Number(v);
    if (Number.isFinite(mn) && n < mn) n = mn;
    return n;
  };

  const isBoost = !!card.boost || !!card.type && String(card.type).toLowerCase() === 'boost' || !!card.artifact;

  card.power = clamp(card.power, r.power[0], r.power[1]);
  card.health = clamp(card.health, r.health[0], r.health[1]);
  card.speed = clamp(card.speed, r.speed[0], r.speed[1]);
  if (!isBoost) {
    card.attack_min = clamp(card.attack_min, r.attack_min[0], r.attack_min[1]);
    card.attack_max = clamp(card.attack_max, r.attack_max[0], r.attack_max[1]);
    if (card.attack_min > card.attack_max) card.attack_max = card.attack_min;
  } else {
    if (typeof card.attack_min === 'number' && card.attack_min > 0) card.attack_min = 0;
    if (typeof card.attack_max === 'number' && card.attack_max > 0) card.attack_max = 0;
  }

  return card;
}

function flattenCards(consolidatedCards) {
  const result = [];
  const usedIds = new Set();
  consolidatedCards.forEach(card => {
    if (!card.id) return;
    if (usedIds.has(card.id)) throw new Error(`Duplicate card id ${card.id} in artifactcards`);
    usedIds.add(card.id);

    const flattedCard = {
      id: card.id,
      character: card.character,
      alias: card.alias,
      title: card.title,
      faculty: card.faculty !== undefined ? card.faculty : null,
      group: card.group,
      rank: card.rank,
      mastery: 1,
      pullable: card.pullable !== undefined ? card.pullable : true,
      power: card.power,
      health: card.health,
      speed: card.speed,
      attack_min: card.attack_min,
      attack_max: card.attack_max,
      image_url: card.image_url
    };

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

    const COUNT_ICON_BY_VALUE = { 2: '<:2_:1503002986560094228>', 3: '<:3_:1503002985578365118>' };
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

    try { clampStatsForRank(flattedCard); } catch (e) { console.error('Error clamping artifact stats', flattedCard.id, e); }
    result.push(flattedCard);
  });
  return result;
}

// Consolidated artifact entries (moved from data/cards.js)
const consolidatedArtifactData = [
  {
    character: 'Strawhat',
    alias: ['strawhat artifact', 'artifact strawhat'],
    id: 'a001',
    attribute: 'STR',
    emoji: '<:strawhat:1492324127590322238>',
    pullable: true,
    title: "Monkey D. Luffy's Strawhat",
    faculty: 'Strawhat Pirates',
    rank: 'A',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Monkey D. Luffy, (15%), Figarland Shanks, (15%)',
    artifact: true,
    image_url: 'https://files.catbox.moe/ia6kin.webp'
  },
  {
    character: "Usopp's Hammer",
    alias: ['usopps hammer', 'usopp hammer', 'hammer'],
    id: 'a002',
    attribute: 'STR',
    emoji: '<:1000048122:1497621468975206441>',
    pullable: true,
    title: "Usopp's Hammer",
    faculty: 'Strawhat Pirates',
    rank: 'B',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Usopp, Attack (10%)',
    artifact: true,
    image_url: 'https://files.catbox.moe/tjvn6x.webp'
  },
  {
    character: 'Wado Ichimonji',
    alias: ['wado ichimonji', 'wado'],
    id: 'a003',
    attribute: 'STR',
    emoji: '<:1000048114:1497621621215854694>',
    pullable: true,
    title: 'Wado Ichimonji',
    faculty: 'Strawhat Pirates',
    rank: 'S',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Shimotsuki Kouzaburou, Attack (20%), Koushirou, Attack (20%), Kuina, Attack (20%), Roronoa Zoro, Attack (20%)',
    artifact: true,
    image_url: 'https://files.catbox.moe/unxsgx.webp'
  },
  {
    character: 'Soul Solid',
    alias: ['soul solid'],
    id: 'a004',
    attribute: 'STR',
    emoji: '<:1000048129:1497621484594528296>',
    pullable: true,
    title: 'Soul Solid',
    faculty: 'Strawhat Pirates',
    rank: 'A',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Brook, Attack (15%)',
    artifact: true,
    image_url: 'https://files.catbox.moe/ap6t9v.webp'
  },
  {
    character: "Chopper's Post-ts Hat",
    alias: ['chopper post-ts hat', 'chopper hat', 'post-ts hat'],
    id: 'a005',
    attribute: 'STR',
    emoji: '<:1000048128:1497621759350935693>',
    pullable: true,
    title: "Chopper's Post-ts Hat",
    faculty: 'Strawhat Pirates',
    rank: 'A',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Tony Tony Chopper (10%)',
    artifact: true,
    image_url: 'https://files.catbox.moe/v9gj1d.webp'
  },
  {
    character: "Chopper's Pre-ts Hat",
    alias: ['chopper pre-ts hat', 'chopper hat', 'pre-ts hat'],
    id: 'a006',
    attribute: 'STR',
    emoji: '<:1000048127:1497621483097427968>',
    pullable: true,
    title: "Chopper's Pre-ts Hat",
    faculty: 'Strawhat Pirates',
    rank: 'A',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Tony Tony Chopper (10%)',
    artifact: true,
    image_url: 'https://files.catbox.moe/de8b59.webp'
  },
  {
    character: "Sanji's Germa Suit",
    alias: ['sanji germa suit', 'germa suit', 'sanji suit'],
    id: 'a007',
    attribute: 'STR',
    emoji: '<:1000048126:1497621470774296717>',
    pullable: true,
    title: "Sanji's Germa Suit",
    faculty: 'Strawhat Pirates',
    rank: 'S',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Vinsmoke Sanji (15%)',
    artifact: true,
    image_url: 'https://files.catbox.moe/vrj5u0.webp'
  },
  {
    character: 'Clima-tact',
    alias: ['clima-tact', 'climatact', 'clima tact'],
    id: 'a008',
    attribute: 'STR',
    emoji: '<:1000048125:1497621482199580672>',
    pullable: true,
    title: 'Clima-tact',
    faculty: 'Strawhat Pirates',
    rank: 'S',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Nami,  Attack (20%)',
    artifact: true,
    image_url: 'https://files.catbox.moe/urz30u.webp'
  },
  {
    character: "Usopp's Goggles",
    alias: ['usopps goggles', 'usopp goggles', 'goggles'],
    id: 'a009',
    attribute: 'STR',
    emoji: '<:1000048123:1497621887004704838>',
    pullable: true,
    title: "Usopp's Goggles",
    faculty: 'Strawhat Pirates',
    rank: 'C',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Usopp, Health (5%)',
    artifact: true,
    image_url: 'https://files.catbox.moe/nm0cuv.webp'
  },
  {
    character: "Usopp's Rubber band of Doom",
    alias: ['usopp rubber band of doom', 'rubber band of doom', 'usopp rubberband'],
    id: 'a010',
    attribute: 'STR',
    emoji: '<:1000048124:1497621480970653726>',
    pullable: true,
    title: "Usopp's Rubber band of Doom",
    faculty: 'Strawhat Pirates',
    rank: 'C',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Usopp, Attack (5%)',
    artifact: true,
    image_url: 'https://files.catbox.moe/m29d0n.webp'
  },
  {
    character: 'Kuro Kabuto',
    alias: ['kuro kabuto'],
    id: 'a011',
    attribute: 'STR',
    emoji: '<:1000048121:1497621855786238185>',
    pullable: true,
    title: 'Kuro Kabuto',
    faculty: 'Strawhat Pirates',
    rank: 'A',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Usopp, Attack(15%)',
    artifact: true,
    image_url: 'https://files.catbox.moe/vojng7.webp'
  },
  {
    character: 'Ginga Kabuto',
    alias: ['ginga kabuto'],
    id: 'a012',
    attribute: 'STR',
    emoji: '<:1000048120:1497621694054137956>',
    pullable: true,
    title: 'Ginga Kabuto',
    faculty: 'Strawhat Pirates',
    rank: 'C',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Usopp, Attack (5%)',
    artifact: true,
    image_url: 'https://files.catbox.moe/vspiir.webp'
  },
  {
    character: 'Shusui',
    alias: ['shusui'],
    id: 'a014',
    attribute: 'STR',
    emoji: '<:1000048117:1497621497043357768>',
    pullable: true,
    title: 'Shusui',
    faculty: 'Strawhat Pirates',
    rank: 'A',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Shimotsuki Ryuma, Attack(10%), Roronoa Zoro, Attack (10%)',
    artifact: true,
    image_url: 'https://files.catbox.moe/nryljj.webp'
  },
  {
    character: 'Enma',
    alias: ['enma'],
    id: 'a015',
    attribute: 'STR',
    emoji: '<:1000048116:1497621487547322480>',
    pullable: true,
    title: 'Enma',
    faculty: 'Strawhat Pirates',
    rank: 'S',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Shimotsuki Kouzaburou, Attack (20%), Koushirou, Attack (20%), Kuina, Attack (20%), Roronoa Zoro, Attack (20%)',
    artifact: true,
    image_url: 'https://files.catbox.moe/qc7gci.webp'
  },
  {
    character: 'Sandai Kitetsu',
    alias: ['sandai kitetsu'],
    id: 'a016',
    attribute: 'STR',
    emoji: '<:1000048115:1497621486108934295>',
    pullable: true,
    title: 'Sandai Kitetsu',
    faculty: 'Strawhat Pirates',
    rank: 'A',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Kouzuki Sukiyaki, Attack (15%), Ipponmatsu, Attack (15%), Roronoa Zoro, Attack (15%)',
    artifact: true,
    image_url: 'https://files.catbox.moe/jmgiu1.webp'
  },
  // New artifacts requested by user
  {
    character: 'Iron Mace',
    alias: ['iron mace', 'iron-mace'],
    id: 'a017',
    attribute: 'STR',
    emoji: '<:Ironmace:1507743863975051394>',
    pullable: true,
    title: 'Iron Mace',
    faculty: 'Buggy Pirates',
    rank: 'C',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Alvida, Attack (5%)',
    artifact: true,
    image_url: null
  },
  {
    character: 'Daisenso',
    alias: ['daisenso'],
    id: 'a018',
    attribute: 'STR',
    emoji: '<:Daisenso:1507741769389834301>',
    pullable: true,
    title: 'Daisenso',
    faculty: null,
    rank: 'C',
    power: 1,
    health: 1,
    speed: 1,
    attack_min: 0,
    attack_max: 0,
    boost: 'Don Krieg, Attack (5%)',
    artifact: true,
    image_url: null
  }
];

exports.cards = flattenCards(consolidatedArtifactData);
