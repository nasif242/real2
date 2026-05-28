# Abilities Summary

This document lists the centralized ability definitions and which cards they apply to.

- **Nami — Beli Boost**
  - Applies to: All `Nami` cards (matches by character name)
  - Effect: Nami boosts the Beli you receive from gambling depending on her star level (1 ✮ = 1% beli boost).

- **Pull Bonus**
  - Applies to: Card IDs `4162`, `4037`, `3786`
  - Effect: When the card is upgraded to Max ★ for its rank, it unlocks **+1 pull per reset**.

- **Zoro — Multi-Artifact**
  - Applies to: All `Roronoa Zoro` cards (matches by character name)
  - Effect: A Zoro copy can equip up to **3 artifacts** when that copy reaches **Star Level 7**; otherwise the default is 1 artifact.

Notes
- All ability logic has been moved to `utils/abilities.js` so adding a new ability is as simple as adding a definition to the `ABILITIES` array.
- The UI will automatically show an "Ability" button for any card that matches an ability definition.
- `utils/abilities.js` exposes `listAllAbilities()` which programmatically returns which card ids/characters match each ability.
