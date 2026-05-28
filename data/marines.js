// simple marine rank dataset used for the Infinite Sail encounter
// ranks run from lowly choreboy up to captain. additional stats can be
// added later when more granularity is needed.

const marines = [
  { 
    rank: 'Choreboy', // appears from isail 1
    minHP: 1, maxHP: 5, 
    atk: 1, 
    speed: 1, 
    attribute: 'INT',
    stagerange: [1, 3],
    pool: [
      { emoji: '<:INTcabinboy:1490381950958043206>', attribute: 'INT' },
      { emoji: '<:PSYcabinboy:1490382699934777506>', attribute: 'PSY' },
    ]
  },
  { 
    rank: 'Seaman Recruit', // appears from isail 1
    minHP: 2, maxHP: 6, 
    atk: 1, 
    speed: 1, 
    attribute: 'STR',
    stagerange: [2, 5],
    pool: [
      { emoji: '<:STRseasmanrecruit:1490383182745309405>', attribute: 'STR' },
      { emoji: '<:DEXseasmanrecruit:1490384443439841281>', attribute: 'DEX' }
    ]
  },
  { 
    rank: 'Seaman Apprentice', // appears from isail 2
    minHP: 3, maxHP: 8, 
    atk: 2, 
    speed: 2, 
    attribute: 'DEX',
    stagerange: [3, 7],
    pool: [
      { emoji: '<:DEXseasmanapprentice:1490385316765241526>', attribute: 'DEX' },
      { emoji: '<:INTseasmanapprentice:1490385511397724391>', attribute: 'INT' },
      { emoji: '<:STRseasmanapprentice:1490385663621730525>', attribute: 'STR' }
    ]
  },
  { 
    rank: 'Seaman First Class', // appears from isail 4
    minHP: 5, maxHP: 10, 
    atk: 2, 
    speed: 2, 
    attribute: 'DEX',
    stagerange: [6, 10],
    pool: [
      { emoji: '<:DEXseasmanapprentice:1490385316765241526>', attribute: 'DEX' },
      { emoji: '<:INTseasmanapprentice:1490385511397724391>', attribute: 'INT' },
      { emoji: '<:STRseasmanapprentice:1490385663621730525>', attribute: 'STR' }
    ]
  },
  { 
    rank: 'Petty Officer', // appears from isail 6
    minHP: 10, maxHP: 15, 
    atk: 3, 
    speed: 3, 
    attribute: 'STR',
    stagerange: [10, 15],
    pool: [
      { emoji: '<:STRpettyofficer:1490386643637633104>', attribute: 'STR' },
      { emoji: '<:DEXpettyofficer:1490386795479961762>', attribute: 'DEX' },
      { emoji: '<:PSYpettyofficer:1490387070387097860>', attribute: 'PSY' }
    ]
  },
  { 
    rank: 'Chief Petty Officer', // appears from isail 8
    minHP: 15, maxHP: 20, 
    atk: 3, 
    speed: 3, 
    attribute: 'STR',
    stagerange: [11, 16],
    pool: [
      { emoji: '<:STRchiefpettyofficer:1490387685838159882>', attribute: 'STR' },
      { emoji: '<:INTchiefpettyofficer:1490387722446045268>', attribute: 'INT' }
    ]
  },
  { 
    rank: 'Master Chief Petty Officer', // appears from isail 10
    minHP: 20, maxHP: 25, 
    atk: 4, 
    speed: 3, 
    attribute: 'QCK',
    stagerange: [12, 18],
    pool: [
      { emoji: '<:QCKmasterchiefpettyofficer:1490388129222365414>', attribute: 'QCK' },
      { emoji: '<:PSYmasterchiefpettyofficer:1490388321518747869>', attribute: 'PSY' }
    ]
  },
  { 
    rank: 'Warrant Officer', // appears from isail 12
    minHP: 25, maxHP: 30, 
    atk: 4, 
    speed: 4, 
    attribute: 'PSY',
    stagerange: [15, 22],
    pool: [
      { emoji: '<:PSYwarrantofficer:1490389260040278077>', attribute: 'PSY' },
      { emoji: '<:STRwarrantofficer:1490389232571777054>', attribute: 'STR' },
      { emoji: '<:INTwarrantofficer:1490389211545600062>', attribute: 'INT' }
    ]
  },
  { 
    rank: 'Ensign', // appears from isail 14
    minHP: 30, maxHP: 36, 
    atk: 5, 
    speed: 4, 
    attribute: 'QCK',
    stagerange: [18, 25],
    pool: [
      { emoji: '<:QCKenseign:1490389522968613035>', attribute: 'QCK' },
      { emoji: '<:INTensign:1490389758285975753>', attribute: 'INT' },
      { emoji: '<:STRensign:1490389776673542184>', attribute: 'STR' },
      { emoji: '<:PSYensign:1490389809594892492>', attribute: 'PSY' },
      { emoji: '<:DEXensign:1490389857627803678>', attribute: 'DEX' }
    ]
  },
  { 
    rank: 'Lieutenant Junior Grade', // appears from isail 16
    minHP: 35, maxHP: 47, 
    atk: 5, 
    speed: 5, 
    attribute: 'QCK',
    stagerange: [24, 30],
    pool: [
      { emoji: '<:QCKenseign:1490389522968613035>', attribute: 'QCK' },
      { emoji: '<:INTensign:1490389758285975753>', attribute: 'INT' },
      { emoji: '<:STRensign:1490389776673542184>', attribute: 'STR' },
      { emoji: '<:PSYensign:1490389809594892492>', attribute: 'PSY' },
      { emoji: '<:DEXensign:1490389857627803678>', attribute: 'DEX' }
    ]
  },
  { 
    rank: 'Lieutenant', // appears from isail 18
    minHP: 46, maxHP: 55, 
    atk: 6, 
    speed: 5, 
    attribute: 'QCK',
    stagerange: [25, 31],
    pool: [
      { emoji: '<:QCKenseign:1490389522968613035>', attribute: 'QCK' },
      { emoji: '<:INTensign:1490389758285975753>', attribute: 'INT' },
      { emoji: '<:STRensign:1490389776673542184>', attribute: 'STR' },
      { emoji: '<:PSYensign:1490389809594892492>', attribute: 'PSY' },
      { emoji: '<:DEXensign:1490389857627803678>', attribute: 'DEX' }
    ]
  },
  { 
    rank: 'Lieutenant Commander', // appears from isail 20
    minHP: 54, maxHP: 68, 
    atk: 6, 
    speed: 6, 
    attribute: 'INT',
    stagerange: [26, 32],
    pool: [
      { emoji: '<:INTlieutenant:1490390781540962537>', attribute: 'INT' },
      { emoji: '<:PSYlieutenantcommander:1490390996519747654>', attribute: 'PSY' },
      { emoji: '<:strlieutenantcommander:1490391335855722667>', attribute: 'STR' }
    ]
  },
  { 
    rank: 'Captain', // appears from isail 22
    minHP: 66, maxHP: 80, 
    atk: 8, 
    speed: 6, 
    attribute: 'PSY',
    stagerange: [30, 35],
    pool: [
      { emoji: '<:psycaptain:1490392429495586907>', attribute: 'PSY' },
      { emoji: '<:INTcaptain:1490392199693733899>', attribute: 'INT' },
      { emoji: '<:INTcaptain2:1490392724669599914>', attribute: 'INT' },
      { emoji: '<:QCKcaptain:1490392956639907941>', attribute: 'QCK' },
      { emoji: '<:Dexcaptain:1490393253487579300>', attribute: 'DEX' }
    ]
  },
  { 
    rank: 'Commodore', // appears from isail 24
    minHP: 75, maxHP: 90, 
    atk: 9, 
    speed: 6, 
    attribute: 'PSY',
    stagerange: [32, 40],
    pool: [
      { emoji: '<:INTcommodore:1491525969243279411>', attribute: 'INT' },
      { emoji: '<:DEXcommodore:1491526702478921761>', attribute: 'DEX' }
    ]
  },
  { 
    rank: 'Rear admiral', // appears from isail 26
    minHP: 80, maxHP: 100, 
    atk: 10, 
    speed: 7, 
    attribute: 'PSY',
    stagerange: [37, 45],
    pool: [
      { emoji: '<:QCKrearadmiral:1491527615293689949>', attribute: 'QCK' },
      { emoji: '<:INTrearadmiral:1491527898119667863>', attribute: 'INT' },
      { emoji: '<:PSYrearadmiral:1491528314207338626>', attribute: 'PSY' }
    ]
  },
  { 
    rank: 'Vice admiral', // appears from isail 34
    minHP: 95, maxHP: 120, 
    atk: 13, 
    speed: 10, 
    attribute: 'PSY',
    stagerange: [40, 50],
    pool: [
      { emoji: '<:DEXviceadmiral:1491532324033134726>', attribute: 'DEX' },
      { emoji: '<:INT2viceadmiral:1491532051587924129>', attribute: 'INT' },
      { emoji: '<:INTviceadmiral:1491531375650668624>', attribute: 'INT' },
      { emoji: '<:QCKviceadmiral:1491532505122214061>', attribute: 'QCK' },
      { emoji: '<:PSYviceadmiral:1491533004105973880>', attribute: 'PSY' },
      { emoji: '<:STRviceadmiral:1491533609574858892>', attribute: 'STR' },
      { emoji: '<:DEX2viceadmiral:1491533376921010226>', attribute: 'DEX' },
      { emoji: '<:QCK2Viceadmiral:1491534250921693254>', attribute: 'QCK' },
      { emoji: '<:PSYviceadmiral:1491533004105973880>', attribute: 'PSY' },
      { emoji: '<:DEX3Viceadmiral:1491534415225032824>', attribute: 'DEX' },
      { emoji: '<:PSY3viceadmiral:1491534627628646410>', attribute: 'PSY' },
      { emoji: '<:STR2Viceadmiral:1491534817161117816>>', attribute: 'STR' }
    ]
  },
  { 
    rank: 'Admiral', // appears from isail 38
    minHP: 105, maxHP: 140, 
    atk: 15, 
    speed: 11, 
    attribute: 'PSY',
    stagerange: [42, 50],
    pool: [
      { emoji: '<:PSYAdmiral:1491535320720867328>', attribute: 'PSY' },
      { emoji: '<:INTadmiral:1491535479198187554>', attribute: 'INT' },
      { emoji: '<:QCKamiral:1491536135967739945>', attribute: 'QCK' },
      { emoji: '<:INT2admiral:1491536432941240422>', attribute: 'INT' }
    ]
  },
    { 
    rank: 'Gorosei', // appears from isail 42
    minHP: 150, maxHP: 200, 
    atk: 15, 
    speed: 15, 
    attribute: 'PSY',
    stagerange: [40, 999],
    pool: [
      { emoji: '<:4440:1503924159183458414>', attribute: 'DEX' },
      { emoji: '<:4442:1503923955004608582>', attribute: 'PSY' },
      { emoji: '<:4450:1503923795273056267>', attribute: 'QCK' },
      { emoji: '<:4379:1503923393563590718>', attribute: 'INT' },
      { emoji: '<:4452:1503924514424225932>', attribute: 'STR' },
      { emoji: '<:4568:1503924642489045142>', attribute: 'STR' }
    ]
  },
  { 
    rank: 'Fleet Admiral', // appears from isail 42
    minHP: 135, maxHP: 160, 
    atk: 20, 
    speed: 15, 
    attribute: 'PSY',
    stagerange: [45, 999],
    pool: [
      { emoji: '<:STRfleetadmiral:1491537014435352657>', attribute: 'STR' },
      { emoji: '<:PSYfleetadmiral:1491537308036370614>', attribute: 'PSY' },
      { emoji: '<:QCKamiral:1491536135967739945>', attribute: 'QCK' },
      { emoji: '<:INT2admiral:1491536432941240422>', attribute: 'INT' }
    ]
  }
];


function getMarineHPRange(rank, stageNumber = 1) {
  const marine = marines.find(m => m.rank === rank);
  if (!marine) return { minHP: 1, maxHP: 1 };
  return {
    minHP: marine.minHP,
    maxHP: marine.maxHP
  };
}

function getRandomMarineHP(rank, stageNumber = 1) {
  const range = getMarineHPRange(rank, stageNumber);
  const minHP = Math.max(1, range.minHP);
  const maxHP = Math.max(minHP, range.maxHP);
  return Math.floor(Math.random() * (maxHP - minHP + 1)) + minHP;
}

marines.getMarineHPRange = getMarineHPRange;
marines.getRandomMarineHP = getRandomMarineHP;

module.exports = marines;