# Additional Card Addition Rules (user-specified)

- **gif field**: The `gif` field is **not part of the card input layout** and must **never** be added to `special_attack` in cards.js. If existing cards have `gif: null`, do not copy that pattern for new cards.

- **Strict layout adherence**: Card adding must strictly follow what is stated in the input layout (see CARD_ADDITION_GUIDE.md). Do not add any field that was not explicitly stated. Do not change any stated value.

- Boost attack penalty: When a card has a `boost` specified, the card's attack should be set to be two times worse than the average attack for its declared rank (or two times worse than the intended attack). This is a content-guideline for card creators.

- SS/UR boost behavior: If an `SS` or `UR` rank card is a boost (i.e., it has a `boost` field) and does not include a special attack, do NOT add a special attack for that card.

- Team boost behavior: When a card grants a team boost, that boost only applies to cards in the same user's active team, and only if the boosting card is also present in that team. UI note: render the boost percentage on the team image canvas (small text at the bottom-left), e.g. "20% boost".

- Multi-target rules: `count` / `scount` must only be added when the card input explicitly included them. Mapping:
        - `2` => `count: 2`
        - `3` => `count: 3`
        - `-2` => `scount: 2`
        - `-3` => `scount: 3`
        Use `scripts/validate-card-counts.js` to check repository-wide conformance.

Note: The repository currently enforces that `boost`/`artifact` cards have `attack_min` and `attack_max` set to `0` at flatten-time. If you want the engine to reflect the "two times worse" rule instead of zeroing attacks, the runtime clamping logic in `data/cards.js` must be adjusted accordingly.
