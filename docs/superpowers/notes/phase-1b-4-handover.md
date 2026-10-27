# Phase 1b-4 hand-over: add-ons and item notes

## Migrations
- `0016_food_add_ons` (generated): `add_on_groups` (min/max choices, unique name per shop in any case), `add_on_options` (price, optional ingredient and quantity, `active`), `variant_add_on_groups` (an item's groups in order); `sale_lines.add_ons` and `sale_lines.note` (at most 140).
- `0017_food_add_ons_rls` (custom): tenant isolation and till cache triggers on the three tables.

## Sale contract
Sale lines gain `addOns?: [{ groupId, optionId }]` and `note?` (trimmed, at most 140).
- Unit price = resolved price + combo upgrades + chosen add-on prices.
- A wrong count or a repeated option is always refused (`invalid_add_ons`). An add-on the item no longer offers is `invalid_add_ons` online and review `add_ons_changed` from the outbox; it is stored by name at price 0.
- Combos and by-amount lines take no add-ons.
- Stock: each chosen option with an ingredient deducts ingredient quantity × the line's base quantity, in `finaliseSaleTx`.

## Services and screens
- `add-ons.ts`: list and save groups (omitted options become inactive, never deleted), link groups to items (not combos or by-amount items).
- Phone orders keep add-ons and the note; collecting compares them (`order_changed`).
- Kitchen screen, receipts, and the till's receipt and kitchen slip show add-ons and the note.
- Device cache: `addOnGroups`, `itemAddOnGroups`; the till checks and prices add-ons offline and merges cart lines only when add-ons and note match (`mergeLine`).
- `/[slug]/app/add-ons` to set up groups; the product page ticks an item's groups; the till asks for add-ons and a note before adding the item.

## Shortcuts
- An item's groups are ordered as the add-ons list shows them, not dragged into a custom order.

## Not checked by hand
The browser walk-through has not been done. Tests, type check, and build cover the rest.
