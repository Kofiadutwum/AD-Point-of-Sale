# Phase 1b-8: Exchanges, Counter Orders, Cash Rounding, Refunds in Reports

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A customer can swap items in one step and pay or get back only the difference; a salesperson can send an order to the cashier by number; cash totals can round to the smallest coin; refunds show in the food report.

**Architecture:** `completeSale` and `processReturn` get transaction-level cores (`completeSaleTx`, `processReturnTx`) so an exchange runs the return and the new sale in one transaction. The new sale is paid partly by an `exchange_credit` tender worth the returned items (capped at the new total). Counter orders store the cart and are completed through `completeSaleTx` with server prices and the order's creator as salesperson. Cash rounding is one pure function shared by the server and the till.

**Spec:** sections 6.32, 6.39, 6.40, 6.12.

## Global constraints
- **Rounding (6.40):** `tenants.cash_rounding_step` in pesewas, one of 0 (off), 5, 10, 50, 100. Only when the sale has a cash tender: `cashPart = total - nonCash`, `rounded = round_half_up(cashPart / step) * step`, `rounding = rounded - cashPart`. Amount due = total + rounding; change and "payment incomplete" use it. Saved as `sales.rounding_pesewas` (may be negative); shown on the receipt and the till. The device cache carries the step; the till uses the same function (`src/lib/cash-rounding.ts`).
- **Exchange (6.32):** online only, at a till (needs a register). Return value as 6.12; credit used = min(return value, new total); the customer pays the rest with normal tenders; leftover credit is refunded by cash, MoMo, card, bank, or store credit under the approval rules of 6.12 (context key `<saleId>:<leftover>`). `payments.method` gains `exchange_credit` (no reference). `returns.exchange_sale_id` and `returns.exchange_credit_pesewas` link the two. Same refusals as returns (`not_returnable`, `too_many`, ...). Audit `exchange_processed`.
- **Counter orders (6.39):** table `counter_orders` (branch, 4-digit number per branch and business day, lines as sent, `created_by`, status `awaiting_payment | paid | cancelled`, `sale_id`, `expires_at`). `tenants.counter_order_expiry_minutes` (default 120). Stock is not touched until payment. Collecting locks the order, refuses `expired` past `expires_at` (no scheduled job: an expired order is simply refused and hidden), completes the sale with server prices and `sales.salesperson_id` = creator, then marks it paid. Permission `make_sale` for both sides. Audit `counter_order_sent`, `counter_order_cancelled`.
- **Food report:** refunds in the range (returns with a receipt for food sales, by return date) shown as a "Refunds" line and subtracted for "Net sales". Pots are unaffected: by-amount items cannot be returned.

## Tasks
1. **Transaction cores.** Split `completeSale` into `completeSaleTx(tx, ctx, input, now, opts)` (opts: `serverPrices`, `exchangeCreditPesewas`, `salespersonId`) and `processReturn` into `processReturnTx`. No behaviour change; full sales and returns suites stay green. Commit `refactor(sales): transaction-level sale and return cores`.
2. **Cash rounding.** Migration (tenant step, `sales.rounding_pesewas`); `roundCash` pure function with tests; server uses it; device cache, `checkTenders`, till screen, receipt, shop setting. Tests: `rounds the cash part to the step`, `no rounding without cash or when off`, `change uses the rounded amount`. Commit `feat(sales): cash rounding`.
3. **Exchanges.** Migration (`exchange_credit` tender, return link columns); `processExchange(db, ctx, { saleId, items, reason, newLines, tenders, refundMethod?, reference?, approvalToken? }, now)` and `quoteExchange`. Tests: `customer pays only the difference`, `leftover credit is refunded and may need approval`, `exchange is all or nothing`, `returned stock comes back before the new items go out`. Screen: "Exchange" on the returns page with new items by barcode or SKU. Commit `feat(controls): exchanges`.
4. **Counter orders.** Migration (table, RLS, tenant expiry, `sales.salesperson_id`); `sendCounterOrder`, `listCounterOrders`, `collectCounterOrder`, `cancelCounterOrder`. Tests: `stock moves only when paid`, `an order is paid once`, `expired orders cannot be collected`, `the sale records the salesperson`. Screen `/app/counter-orders`. Commit `feat(sales): order at one counter, pay at another`.
5. **Refunds in the food report.** Test `refunds reduce net sales in the food report`. Commit `feat(food): refunds in the food report`.
6. **Verify and hand over.** Full suite, build, browser walk-through, hand-over note, merge.

## Not in this plan
Receipt printed as one combined exchange slip (the new sale's receipt shows the exchange credit tender); exchanges and counter orders offline; counter orders from the till's selling screen (web screen only for now).
