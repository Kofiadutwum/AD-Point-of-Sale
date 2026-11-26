# Phase 1b-8 hand-over: exchanges, counter orders, cash rounding, refunds in reports

## Migrations
- `0025_cash_rounding`: `tenants.cash_rounding_step` (0, 5, 10, 50, 100) and `sales.rounding_pesewas`.
- `0026_exchanges`: `exchange_credit` tender (no reference); `returns.exchange_sale_id` and `returns.exchange_credit_pesewas`.
- `0027_counter_orders` / `0028_counter_orders_rls`: table `counter_orders`, `tenants.counter_order_expiry_minutes` (120), `sales.salesperson_id`.
- The local dev database needs `npm run db:migrate` (with the dev server stopped); the dev server does not migrate on start.

## How it works
- **Transaction cores:** `completeSaleTx` and `processReturnTx` run inside a caller's transaction. Refusals after a write throw (`throwSaleFailure` / `saleFailure`), so the caller's whole transaction rolls back. `SaleOptions`: `serverPrices` (charge today's catalogue price), `exchangeCreditPesewas`, `quote` (allow unpaid, for a rolled-back quote), `salespersonId`.
- **Cash rounding (`src/lib/cash-rounding.ts`):** only when the sale has cash; the cash part (total less non-cash) rounds half up to the step. The server, `checkTenders` on the till, both selling screens, and the receipt use the same function. The device cache carries `cashRoundingStep` (optional: older caches mean no rounding). Set in shop settings under "Sales and receipts".
- **Exchanges (`processExchange`, `quoteExchange` in `returns.ts`):** one transaction. The return is recorded and stock put back first, then the new sale is made with an `exchange_credit` tender of min(return value, new total). Leftover credit is given back by the chosen method under the refund approval rules (key `<original sale id>:<leftover>`). The quote runs the real steps and rolls back. Needs a till session (register).
- **Counter orders (`counter-orders.ts`):** `sendCounterOrder` saves checked lines with a 4-digit number per branch and day (branch row locked); `collectCounterOrder` locks the order, refuses `not_open`, `expired`, `wrong_branch`, sells at today's prices with the creator as salesperson, and marks it paid. Expired orders are hidden and refused; there is no scheduled job. `cancelCounterOrder` drops an unpaid order.
- **Food report:** `totals` = sales, refunds (returns with a receipt, by return date, with the branch and service-mode filters), net sales; on the page and in the CSV.
- Returns now record `created_at` from the given time.

## Screens
- Returns page: "Exchange" form (returned quantities, up to 3 new items by barcode or SKU, "Work out the difference", payment, give-back method, manager PIN).
- `/app/counter-orders` with home link "Counter orders": send an order; waiting orders with the total and payment (at a till), or cancel.
- Shop settings: "Round cash totals to".

## Checked
- 608 tests pass; type check and build green.
- Browser: sent counter order 0001 (2 × Chicken piece) from the web page; it shows as waiting, and payment asks for a till session as it should. Shop settings shows the rounding choice.

## Not done
- Paying a counter order, an exchange, and rounding on the till were not walked through in the browser (they need a registered till PIN session); tests cover them.
- Exchanges and counter orders are web pages only and online only; not on the till selling screen yet.
- No combined exchange slip is printed; the new sale's receipt shows the exchange credit tender.
- No separate review agent was run.
