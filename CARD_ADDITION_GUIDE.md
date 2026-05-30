
# Card Addition Guide

This guide explains how to properly add new cards to the game. Follow these instructions for consistent card creation.

## Card ID Format

All cards should have an ID field given from the requester.

## File Structure

Cards are defined in two main files:
- **cards.js** - Primary cards (main story characters), Ships, and Artifacts
- **morecards.js** - Secondary cards (early arc and side characters)
- **crews.js** - Faculty/crew definitions and their ranks
- **marines.js** - Marine organization characters

---

## Input Layout (New Format)

All card submissions must follow this layout exactly. **Do not add any field that is not stated. Do not change any stated value.**

```
"faculty":
"character" (alias1, alias2, ...):
cardtitle, cardID, cardAttribute, cardRank, cardemoji, cardImage
cardspecialattack, cardstatuseffect, cardEffectDuration, cardEffectAmount, itself=true, all=true, count=N, scount=N
```

- **Line 1** — faculty name, or omit if no faculty
- **Line 2** — character name with optional aliases in parentheses
- **Line 3** — card fields (title is optional; minimum required: ID, attribute, rank, emoji, image)
- **Line 4** — special attack line (entire line is optional; only include fields that are stated)

### Minimum valid card (all required fields):
```
ID, attribute, rank, emoji, imageURL
```

### Full example (all optional fields stated):
```
Roger Pirates:
Silvers Rayleigh (dark king, cracked shiki):
Dark King - Old Man Watching Over the New Age, 1883, DEX, SS, <:1883:1509708919818293329>, https://...url...
Signaling the Beginning of a Bright Future, drunk, 3 turns, 25%, itself=true, all=true, count=3, scount=2
```

### Rules for the new format:
- `gif` is **never** part of the input layout. Do **not** add `gif` to `special_attack` in cards.js.
- If a field is not stated in the input, do **not** add it to cards.js.
- Card adding must **strictly** respect what is stated — do not infer, guess, or add anything extra.
- `effectAmount` maps to `effectAmount` in cards.js (used for percentage-based effects like attackup/down).
- `itself=true` maps to `itself: true` in cards.js.
- `all=true` maps to `all: true` in cards.js.
- `count=N` maps to `count: N` in cards.js.
- `scount=N` maps to `scount: N` in cards.js.
- Effect duration in "turns" maps to `effectDuration` (integer). `-1` means permanent.

---

## How Stats Work

**You do not write stat values.** Power, health, speed, attack_min, and attack_max are all **automatically generated at runtime** from the card's `rank` field using a seeded random algorithm. The same card always gets the same stats (seeded by its ID), so stats are stable across restarts.

Special attack damage (min_atk / max_atk) is also **auto-generated** — approximately 1.5× attack_min and 2× attack_max. You only write the attack name.

The only fields you write are: `id`, `rank`, `attribute`, `emoji`, `image_url`, and optional fields like `title`, `special_attack` (name only), `effect`, `effectDuration`, `effectAmount`, `itself`, `all`, `count`, `scount`, `boost`.

---

## Rank Modifiers

Any rank can be followed by `-` or `+` to place the card in the lower or upper portion of that rank's stat range:

| Suffix | Sub-band | Example (S power range 20–30) |
|--------|----------|-------------------------------|
| `-`    | Bottom 25 % of the band | 20 – 22 |
| *(none)* | Middle 50 % of the band | 22 – 27 |
| `+`    | Top 25 % of the band | 27 – 30 |

```javascript
rank: 'S-'   // lower-end S card (20–22 power)
rank: 'S'    // mid S card (22–27 power)
rank: 'S+'   // high-end S card (27–30 power)
```

Modifiers work on all ranks: `B-`, `A+`, `SS-`, `UR+`, etc.

---

## Source Layout in cards.js

Both `cards.js` and `morecards.js` use the same **grouped format**:

```
Faculty block
  └── Character block  (character name + aliases — shared by all cards below)
        └── Card block   (id, rank, emoji, image_url, optional special attack…)
        └── Card block
        …
  └── Character block
        └── Card block
        …
Faculty block
  └── …
```

### Faculty Block

```javascript
{
  faculty: 'Strawhat Pirates',   // string, or null for no-faculty characters
  characters: [ … ]
}
```

### Character Block

```javascript
{
  character: 'Monkey D. Luffy',
  alias: ['luffy', 'monkey d luffy', 'strawhat'],  // all lowercase
  cards: [ … ]
}
```

- `character` and `alias` are **shared** by every card nested inside — do not repeat them per card.
- Aliases must be lowercase.
- `pullable: true` is **not needed** — every card is pullable by default.

### Card Block (normal fighter)

```javascript
{
  title: 'Gum-Gum Pistol',      // card display name (omit if not stated in input)
  id: '0002',                    // unique string id
  attribute: 'STR',              // STR | QCK | INT | DEX | PSY
  rank: 'B',                     // D | C | B | A | S | SS | UR  (optional +/-)
  emoji: '<:Luffygumgumpistol:1492353926257971341>',
  image_url: 'https://...',
  special_attack: {              // optional; only include if stated in input
    name: 'Gum-Gum Pistol'
    // NO gif field — gif is not part of the input layout
  },
  effect: 'stun',               // only if stated in input
  effectDuration: 1             // only if stated in input
}
```

### Card Block (boost type)

Some characters don't fight (doctors, cooks, etc.) — use a boost card:

```javascript
{
  title: 'Barmaid of the Partys Bar',
  id: '9999',
  attribute: 'PSY',
  rank: 'C',
  boost: 'Monkey D. Luffy (5%), Figarland Shanks (5%)',
  emoji: '<:Makino:1234567890>',
  image_url: null
}
```

Boost cards have **NO** `special_attack`.

---

## Full Example (two characters, same faculty)

```javascript
{
  faculty: 'Strawhat Pirates',
  characters: [
    {
      character: 'Monkey D. Luffy',
      alias: ['luffy', 'monkey d luffy', 'strawhat'],
      cards: [
        {
          id: '0001',
          attribute: 'STR',
          rank: 'C',
          emoji: '<:MonkeyD:1492353158960124037>',
          image_url: 'https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0001.png'
        },
        {
          title: 'Gum-Gum Pistol',
          id: '0002',
          attribute: 'STR',
          rank: 'B',
          emoji: '<:Luffygumgumpistol:1492353926257971341>',
          image_url: 'https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0002.png',
          special_attack: {
            name: 'Gum-Gum Pistol'
          },
          effect: 'stun', effectDuration: 1
        }
      ]
    },
    {
      character: 'Roronoa Zoro',
      alias: ['zoro', 'roronoa zoro', 'pirate hunter'],
      cards: [
        {
          id: '0005',
          attribute: 'DEX',
          rank: 'B',
          emoji: '<:0005:1492532805434081510>',
          image_url: 'https://2shankz.github.io/optc-db.github.io/api/images/full/transparent/0/000/0005.png'
        }
      ]
    }
  ]
}
```

---

## Grouping Rules

- **All cards for the same character must be inside the same character block.**
- **All characters in the same faculty must be inside the same faculty block.**
- **Faculty takes priority** — if a character could belong to two faculties, put them in the one that best fits their primary affiliation.
- Characters with no faculty use `faculty: null`.
- When a character only appears in `morecards.js`, their character block lives there (keep the two files separate).

---

## Rank Reference

| Rank | Power Generated | When to Use |
|------|-----------------|-------------|
| D    | 0 – 5           | Background characters, weak enemies |
| C    | 5 – 10          | Early arc characters, weak fighters |
| B    | 10 – 15         | Solid crew members, average fighters |
| A    | 15 – 20         | Strong crew members, commanders |
| S    | 20 – 30         | Very strong characters, senior leaders |
| SS   | 30 – 50         | Elite level, major characters |
| UR   | 50 – 80         | Peak tier, protagonists |

Use `rank: 'S+'` (or similar) to push a card to the top of its band without moving up a full tier.

---

## Special Attacks

- Include `special_attack` only when stated in the input
- Only write `name` — damage is auto-generated (≈ 1.5× and 2× the card's attack stats)
- **Do NOT write `gif`** — it is not part of the input layout and must not be added
- All special attacks should include a status effect:
  - Weaker cards: confuse, attackdown, defensedown
  - Stronger cards: stun, freeze, bleed, undead
  - Elite/Yonko level: undead, stun, or bleed with high duration/amount

---

## Multi-target (`count` / `scount`)

- `count: 2` or `count: 3` — splits normal attack across that many targets
- `scount: 2` or `scount: 3` — splits special attack across that many targets
- Only add these when the card input explicitly includes them
- Matching `countIcon` / `scountIcon` are set automatically at flatten-time — do NOT add them manually

---

## Attributes

| Color | Icon Letter | Attribute | Examples |
|-------|-------------|-----------|---------|
| Red | S | STR | Luffy, Zoro, Whitebeard |
| Green | D | DEX | Sanji, Nami, Usopp |
| Blue | Q | QCK | Luffy (QCK forms), Yassopp |
| Yellow | P | PSY | Chopper, Robin |
| Purple | I | INT | Nami, Robin |
| White | — | BASE | Zeus, special/crossover cards (ID ≥ 6000) |

### BASE attribute rules

- **BASE** is a special attribute for cards with ID ≥ 6000 (or explicitly set `attribute: 'BASE'`).
- BASE cards are **neutral in combat**: they deal and receive 1× damage against every attribute — never effective or weak.
- Only **BASE levelers** can be fed to a BASE card (no STR/DEX/QCK/PSY/INT levelers).
- BASE cards **do not use an emoji** for their visuals in binder/team/slots displays. Instead, the bot detects the character's face in the `image_url` and shows a circular face crop with a golden border.
- Embed color for BASE cards is always **white** (`#FFFFFF`).
- Emoji in the attribute embed/info field: `<:BASE:1510322504194064404>`

---

## Faculty Management

If a character belongs to a crew not yet in `crews.js`, add it:

```javascript
{
  name: "Crew/Faculty Name",
  icon: '<:FacultyEmoji:1234567890>',
  rank: 'A'
}
```

Crew ranks:
- D: Small/minor crews
- C: Notable but small crews
- B: Mid-tier crews
- A: Major pirate crews, strong factions
- S: Yonko crews, top-tier organizations
- SS: Only for Yonko + Marines combo

---

## Placeholder Values

Use `null` (never a placeholder string) for missing assets:

- `image_url: null`
- `emoji: null`

---

## Valid Status Effects

- **stun** — Prevents action for duration
- **freeze** — Prevents action, unfrozen by taking damage
- **cut** — 1 HP damage per turn
- **bleed** — 2 HP damage per turn
- **regen** — Restores percentage of max HP per turn
- **confusion** — Chance to miss attacks (use `effectChance` for miss %)
- **drunk** — Target hits the wrong target with X% chance for N turns (use `effectChance` for the wrong-target %)
- **doomed** — Target dies after N turns; use `effectDuration: -1` for instant-doom
- **attackup** — Increases attack by percentage
- **attackdown** — Decreases attack by percentage
- **defenseup** — Increases defense by percentage
- **defensedown** — Decreases defense by percentage
- **truesight** — Dodges all incoming attacks
- **undead** — Card remains alive at 0 HP
- **reflect** — Reflects opponent's attack back

⚠️ **Does NOT exist:** `burn`, `poison`, `speeddown`, `paralysis`

⚠️ **All effect names must appear in the list above.** If an effect name is not listed here it will NOT display on the card info embed and will NOT work in battle. Do not invent effect names — use only the ones above.

---

## Pre-submission Checklist

- [ ] All required fields are filled (`id`, `rank`, `emoji`, `image_url`)
- [ ] Only fields stated in the input layout are added — nothing extra
- [ ] **`gif` is NOT added** anywhere in cards.js
- [ ] Use `null` for missing assets, never placeholder strings
- [ ] Character block is inside the correct faculty block
- [ ] All cards for the same character are grouped in the same character block
- [ ] Aliases are lowercase
- [ ] Attributes match character abilities
- [ ] Ranks are appropriate for anime importance (use +/- to fine-tune)
- [ ] SS+ rank cards have special attacks with status effects (if stated)
- [ ] Special attacks only include `name` — NO `gif`, NO stat values
- [ ] Status effects are from the valid list only
- [ ] Stronger cards have stronger/more impactful status effects
- [ ] Non-combat support characters use `boost` field (no special_attack)
- [ ] All effect names are lowercase (attackdown, not "Attack Down")
- [ ] Effect durations are reasonable (1–5 turns, or -1 for permanent)
- [ ] `pullable: true` is NOT written (not needed)
- [ ] All faculties exist in crews.js
