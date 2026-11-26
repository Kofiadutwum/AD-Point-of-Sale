# Phase 1b-7 hand-over: returns, refunds, and manager approvals

## Migrations
- `0022_returns`: tables `returns`, `return_lines`, `approvals`; movement type `return_restock`; tenant settings `refund_limit_pesewas` (0 = always ask), `allow_no_receipt_returns` (off), `no_receipt_monthly_limit` (2).
- `0023_returns_rls`: tenant isolation on the three tables; `process_return` given to everyone who sells, `refund_without_approval` and `refund_other_method` to owners and managers.
- `0024_returns_reference`: stock movements may reference a `return`.

## How it works
- **Approvals (`approvals.ts`):** `requestApproval` checks another active user with `approve_actions` at a shared branch and their PIN (`verifyStaffPin`, so the till lockout applies), then issues a random token stored as a hash, valid 2 minutes. `consumeApproval` uses it once, only for the requester, the same action, and the same context key. For a refund the key is `<saleId>:<refund pesewas>`, so a changed amount needs a new approval. `listApprovers` feeds the screens.
- **Returns with a receipt (`returns.ts`):** the sale row is locked, so two returns of one line queue and never exceed what was sold. Refund per line is its share of the line total, rounded half up; the last return of a line gets exactly what is left. Approval is needed when the refund method differs from the sale's main tender (the largest payment) without `refund_other_method`, or the total is above the shop's limit without `refund_without_approval`. Non-cash refunds need a reference; store credit needs the sale's customer. Saleable items go back on hand and into the batches the line took from; damaged and expired are recorded only.
- **No receipt:** shop setting on; customer found or added by Ghana phone (row locked); at most the monthly limit per calendar month in the shop's time zone; always a `no_receipt_return` approval; worth the lowest price per unit the item sold for in the last 90 days; always store credit.
- **Not returnable yet** (`not_returnable`): bundles, recipes, combos, serial and by-amount items, and batch items without a receipt. They come with exchanges in 1b-8.

## Screens
- `/app/returns`: find a receipt, quantities and condition per line, refund method, reference, reason, manager and PIN; no-receipt form when the setting is on. Home link "Returns" (`process_return`).
- Shop settings: "Returns" section (refund limit, no-receipt on/off, monthly limit).
- `lookupStockItem` takes an optional permission so the returns screen can look items up.

## Checked
- 595 tests pass; type check and build green.
- Browser: returned 1 of 3 Waakye to cash as the owner; the page showed 1 back, 2 left, refund GHS 30.00.

## Not done
- Approval and no-receipt flows were not walked through in the browser (owners never need approval); unit tests cover them.
- No separate review agent was run for this plan.
- The local dev database at `.data/pglite` would not open (likely an unclean stop). It was moved to `.data/pglite-broken-2026-11-26` and reseeded; delete the old folder when no longer needed.
