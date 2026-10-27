# Phase 1b-5 hand-over: tables, tickets, kitchen stations, service charge

## Migrations
- `0018_food_tickets` (generated): `dining_tables`, `tickets` (one open ticket per table: partial unique index `tickets_open_table`; a paid ticket needs its sale), `ticket_lines` (station, kitchen status new/sent/ready/void, a void needs a reason); `products.kitchen_station`; `tenants.service_charge_bp` (0–2500); `sales.service_charge_pesewas`.
- `0019_food_tickets_rls` (custom): tenant isolation; `take_orders` for sellers in kitchen-module shops, `void_sent_items` for owners and managers. No till cache trigger: tickets are online only.
- `0020_sales_table_mode`: `sales.service_mode` accepts `table`.

## Services
- `tables.ts`: tables per branch (unique name in any case, made inactive, never deleted), service charge setting.
- `tickets.ts`: open (a table or a name; table → ordering), add lines (the same item checks as phone orders, `checkOrderLine` in `sales.ts`; packs are added at payment), remove new lines, send to kitchen (→ waiting for food), void sent lines with another person's manager PIN (`verifyStaffPin`, the till lockout; "already prepared" records waste), move lines (moving all merges and frees the table), print bill, cancel (only with nothing sent), `quoteTicket` (the bill priced as the sale will be), `payTicket`.
- Paying: `completeSale` with `food.ticketId` and `serviceMode: 'table'` (only from `payTicket`, never from the outbox); the sale is the ticket's live lines in order plus packs, priced from the catalogue at payment; the untaxed service charge is added to the total; the ticket becomes paid and the table free.
- `kitchen-display.ts`: a station's sent lines grouped by ticket, oldest first; Ready per line.

## Screens
- `/[slug]/app/tables`: tables with status, open tickets, named tickets; managers add tables and set the service charge.
- `/[slug]/app/tickets/[id]`: lines with station and status, add item (add-ons and note), send, remove, void with manager PIN, move, the bill with prices and service charge, print, pay (users with `make_sale`), cancel.
- `/[slug]/app/kitchen/stations?station=kitchen|bar|grill`: coloured by waiting time, Ready per item.
- Product page: "Table orders go to" station.

## Review fixes
- Remove and void lock the ticket first and read the line again, so a send or move in between is seen.
- The bill shows prices, tax, service charge, and total before payment; receipts show the service charge.
- Paying needs `make_sale`; table mode needs a ticket and is refused from the outbox; ticket reads check the user's branches.

## Shortcuts
- Tickets offer plain and recipe items only (no combos or by-amount items).
- A prepared void of a combo or by-amount line records no waste.
- The service charge is untaxed until the GRA E-VAT phase.
- Offline tickets on the holding device and kitchen printing come later; split bills are Plan 1b-6.
