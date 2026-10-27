# Phase 1b-1 hand-over: counter orders

## Migrations
- `0010_food_counter` (generated): `food_settings`, `branch_order_counters`, `sold_out`, `kitchen_orders`, `packing_ticks`; `branches.service_modes`, `branches.board_token_hash`; `variants.needs_pack`; `sales.service_mode`, `dining_option`, `order_number`.
- `0011_food_counter_rls` (custom): tenant isolation on the five tables, cache-version triggers on `food_settings` and `sold_out`, the `branches` trigger now also watches `service_modes`, and every user gains `mark_sold_out` and `run_kitchen`.

## The `food` contract on a sale
`SaleInput.food = { serviceMode: 'counter' | 'quick', diningOption, orderNumber? }`; results carry `orderNumber: string | null`.
- Counter: the server numbers `001`–`999` per branch per business date; an offline till sends its own `T1-047`, and a repeat carrying a different device number replaces the stored one.
- Quick serve: always eat in, no number, no kitchen order.
- Refusals: `sold_out`, `pack_fee_mismatch`, `service_mode_not_allowed` (all three become review reasons from the outbox), `invalid_order_number`, and `invalid_input` when the kitchen module is off.

## Pages
- Till: mode and dining buttons, the pack line, sold-out marking, the order number and a kitchen slip on the receipt.
- `/[slug]/app/kitchen`: ready, packing check, and hand-over. `/[slug]/app/settings/food`: the pack item, service modes, and board links. `/[slug]/board/[token]`: the public Ready board.
- `scripts/dev-seed-food.ts` seeds `demo-food` for browser checks.

## Deferred
- Table mode, open tickets, kitchen printing through the print helper, "order ready" SMS, and storefront sold-out filtering (`isSoldOut` is exported for it).
- The offline order number path was checked by unit tests only, not by hand in a browser.
- Lint: two pre-existing errors on `main` (the `use-device` effect and the admin layout links).
