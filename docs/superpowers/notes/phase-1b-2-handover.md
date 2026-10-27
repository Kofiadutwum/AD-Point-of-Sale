# Phase 1b-2 hand-over: combos, sell by amount, pots, wastage

## Migrations
- `0012_food_menu` (generated): variant kind `combo`; `variants.sell_by_amount`, `min_amount_pesewas`, `value_per_pot_pesewas`; `combo_slots`, `combo_choices`, `pot_records`, `wastage_entries`; `sale_lines.by_amount` and `choices`; stock movement types `used_in_production` and `waste`; `food_settings.keep_pot_leftovers` and `pot_variance_limit_bp`.
- `0013_food_menu_rls` (custom): tenant isolation on the four tables, cache triggers on combo slots and choices, wastage entries append-only for `pos_app`, and `record_kitchen_stock` for sellers in kitchen-module shops.

## Sale contract
Sale lines gain `byAmount?: boolean` and `choices?: Array<{ slotId, variantId }>`.
- A combo's price is its resolved price plus the chosen upgrades. Bad choices are always refused (`invalid_choices`). A sold-out choice follows the sold-out rule.
- A by-amount line is quantity 1 at the amount typed, never moves stock at sale, and is refused below the minimum online (`below_minimum_amount`; outbox: review `below_minimum`).

## Stock
- A combo gives its fixed items, then each chosen item (a chosen recipe gives its ingredients).
- Pots take one pot recipe per pot (`used_in_production`). The closing count carries the leftover to the next day, or records it as wastage with its cost without taking the ingredients out again (they left stock when cooked).
- Only recipe items move stock with pots; a plain by-amount item has no pot recipe.

## Pages
- Till: amount pad (GHS 5, 10, 15, 20 or typed; minimum shown) and a combo picker (one step per slot, sold-out choices hidden, upgrades shown).
- Product page: sell-by-amount fields in food shops, and a choice slot editor for combos.
- `/[slug]/app/kitchen-stock`: pots, the closing count with its check, and wastage or staff meals.
- Dashboard: open pot counts and flagged gaps of the last 7 days.

## Checked by hand
Meal 2 with the Large Coke upgrade (GHS 50), GHS 10 jollof by amount, GHS 4 shown as below the minimum, sale 001. Then one pot cooked, half left, expected GHS 300 against GHS 10 sold (−97%), flagged.

## Noticed
After the code changed under a running till, its service worker kept serving the old JavaScript until it was unregistered. In production a new deployment could leave tills on old code until the service worker updates. Worth a look in the PWA update flow (Phase 1a Plan 4).

## Deferred
Splitting a combo's price across its parts for reports (Plan 1b-3), refunds in pot actual sales (returns do not exist yet), the cutoff reminder job, and SMS for pot variance.
