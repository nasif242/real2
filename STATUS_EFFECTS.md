# Status Effects Documentation

This document lists all status effects available in the battle system, their mechanics, icons, and usage.

## Status Effects

### Stun
- **Icon**: <:Stun:1479135399573061751>
- **Mechanics**: Prevents the affected card from taking actions for the duration.
- **Duration**: Specified in turns (doubled internally for proper timing).
- **Application**: Can be applied to self or target based on "itself" flag.


### Cut
- **Icon**: <:Cut:1479136751397109771>
- **Mechanics**: Deals 1 HP damage at the start of each turn.
- **Duration**: Specified in turns.
- **Application**: Can be applied to self or target based on "itself" flag.

### Bleed
- **Icon**: <:1000043584:1479138154572156928>
- **Mechanics**: Deals 2 HP damage at the start of each turn.
- **Duration**: Specified in turns.
- **Application**: Can be applied to self or target based on "itself" flag.

### Regen
- **Icon**: <:regen:1485292289827016734>
- **Mechanics**: Restores a percentage of max HP (rounded up) at the start of each turn.
- **Parameters**: `effectAmount` (default 10%) - percentage of HP to regenerate.
- **Duration**: Specified in turns (use -1 for permanent).
- **Application**: Can be applied to self or target based on "itself" flag.

### Confusion
- **Icon**: <:confused:1485292931597209811>
- **Mechanics**: Chance to miss attacks during the duration.
- **Parameters**: `effectChance` (default 50%) - percentage chance to miss.
- **Duration**: Specified in turns (use -1 for permanent).
- **Application**: Can be applied to self or target based on "itself" flag.

### Attack Up
- **Icon**: <:atkup:1485295694053900328>
- **Mechanics**: Increases attack damage by a percentage.
- **Parameters**: `effectAmount` (default 12%) - percentage increase.
- **Duration**: Specified in turns (use -1 for permanent).
- **Application**: Can be applied to self or target based on "itself" flag.

### Attack Down
- **Icon**: <:attackdown:1485296830295314492>
- **Mechanics**: Decreases attack damage by a percentage.
- **Parameters**: `effectAmount` (default 12%) - percentage decrease.
- **Duration**: Specified in turns (use -1 for permanent).
- **Application**: Can be applied to self or target based on "itself" flag.

### Defense Up
- **Icon**: <:defenseup:1485297398942269510>
- **Mechanics**: Reduces the attack damage of attackers by a percentage.
- **Parameters**: `effectAmount` (default 12%) - percentage reduction in incoming attack.
- **Duration**: Specified in turns (use -1 for permanent).
- **Application**: Can be applied to self or target based on "itself" flag.

### Defense Down
- **Icon**: <:defensedown:1485297768535949524>
- **Mechanics**: Increases the attack damage of attackers by a percentage.
- **Parameters**: `effectAmount` (default 12%) - percentage increase in incoming attack.
- **Duration**: Specified in turns (use -1 for permanent).
- **Application**: Can be applied to self or target based on "itself" flag.

### Truesight
- **Icon**: <:truesight:1485299663879012484>
- **Mechanics**: Dodges all incoming attacks during the duration.
- **Duration**: Specified in turns.
- **Application**: Can be applied to self or target based on "itself" flag.

### Undead
- **Icon**: <:undead:1485300491930959882>
- **Mechanics**: Card remains alive at 0 HP. Dies when effect expires, but can be revived if HP is restored before expiration.
- **Duration**: Specified in turns.
- **Application**: Can be applied to self or target based on "itself" flag.

### Reflect
- **Icon**: <:refelct:1492516882954190898>
- **Mechanics**: Redirects incoming attacks back to the attacker.
- **Duration**: Specified in turns.
- **Application**: Can be applied to self or target based on "itself" flag.

### Acid
- **Icon**: <:acid:1492617822851829770>
- **Mechanics**: Deals damage each turn, with damage increasing by the same amount each turn.
- **Duration**: Specified in turns.
- **Application**: Can be applied to self or target based on "itself" flag.

### Prone
- **Icon**: <:prone:1492621344825937970>
- **Mechanics**: Makes the affected card take extra damage from effective attributes.
- **Parameters**: `effectAmount` (default 20%) - extra damage taken from effective attributes.
- **Duration**: Specified in turns.
- **Application**: Can be applied to self or target based on "itself" flag.

### Blessed
- **Icon**: <:blessed:placeholder>
- **Mechanics**: Gains energy faster for the duration.
- **Duration**: Specified in turns.
- **Application**: Can be applied to self or target based on "itself" flag.

### Charmed
- **Icon**: <:charmed:placeholder>
- **Mechanics**: Cannot attack same-attribute targets for the duration.
- **Duration**: Specified in turns.
- **Application**: Can be applied to self or target based on "itself" flag.

### Doomed
- **Icon**: <:doomed:placeholder>
- **Mechanics**: The affected card will die when the effect expires.
- **Duration**: Specified in turns.
- **Application**: Can be applied to self or target based on "itself" flag.

### Drunk
- **Icon**: <:drunk:placeholder>
- **Mechanics**: Chance to hit a wrong target for the duration.
- **Parameters**: `effectChance` (default 20%) - chance to hit another target.
- **Duration**: Specified in turns.
- **Application**: Can be applied to self or target based on "itself" flag.

### Hungry
- **Icon**: <:hungry:placeholder>
- **Mechanics**: Takes damage every turn until rested for the duration.
- **Parameters**: `effectAmount` or `amount` (default 1) - damage taken each turn.
- **Duration**: Specified in turns.
- **Application**: Can be applied to self or target based on "itself" flag.

## Usage in Cards

Status effects are defined in card data with the following properties:
- `effect`: The effect type (string)
- `effectDuration`: Number of turns (optional, default 1; use -1 for permanent)
- `effectAmount`: Percentage for regen/attack/defense modifiers (optional, default 10 for regen, 12 for attack/defense)
- `effectChance`: Percentage for confusion miss chance (optional, default 50)
- `itself`: Boolean flag - if true, applies to the attacker; if false or missing, applies to the target

Example:
```javascript
{
  effect: 'regen',
  effectDuration: 3,
  effectAmount: 10,
  itself: true
}
```

## Logging

Status effects are logged in battle action text with their icons and details. For example:
- `Monkey D. Luffy used Gomu Gomu no Giant Pistol for **12 damage**! (<:undead:1485300491930959882> undead's itself for 3 turns) :energy: -3`