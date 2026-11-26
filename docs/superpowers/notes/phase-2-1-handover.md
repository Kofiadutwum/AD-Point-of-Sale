# Phase 2-1 hand-over: shifts, cash paid in and out, expenses

## Migrations
- `0034_shifts`: tables `shifts` (one open per register, partial unique index), `cash_movements`, `expenses`; `sales.shift_id`, `returns.shift_id`; tenant settings `require_shifts` (off), `cash_variance_limit_pesewas` (0), `expense_approval_limit_pesewas` (0).
- `0035_shifts_rls`: tenant isolation on the three tables; `manage_cash` and `record_expenses` given to owners and managers.
- Local dev: stop the dev server, then `npm run db:migrate`.

## How it works
- **Shifts** (`src/server/shifts.ts`): `openShift` (at a till, opening float), `currentShift` (live summary), `cashMovement` (paid in / out with a reason, `manage_cash`), `closeShift`. Sales and returns made at a till carry its open shift (`src/server/shift-link.ts`).
- **Expected cash** = opening float + cash tendered on the shift's completed sales − change given + paid in − paid out − cash given back on returns and exchanges (refund less exchange credit).
- **Closing:** variance = counted − expected. Above the shop's limit a reason is needed, and someone without `approve_actions` needs a manager's PIN approval (`cash_variance`, context `<shiftId>:<variance>`). Managers (who hold `approve_actions`, also on the till) close without one.
- **Require shifts:** when on, an online sale at a till without an open shift is refused (`no_open_shift`); an offline sale is kept and flagged for review. Shortcut: an offline sale joins whatever shift is open when it syncs.
- **Expenses** (`src/server/expenses.ts`): category, amount, method (cash, MoMo, card, bank; a reference for non-cash), note. Above the shop's limit without `approve_actions` a manager approves (`expense`, context `<branchId>:<amount>`). A cash expense at a till with an open shift is also a paid-out movement in that shift. `listExpenses` by date range with a total.
- **Screens:** `/app/shift` (open, summary, cash in or out, close with reason and manager PIN), `/app/expenses` (record and list), shop settings "Shifts and cash". Home links "Shift and cash" and "Expenses".

## Checked
- 4 shift tests and 2 expense tests; type check and build green.
- Browser: recorded a GHS 25 cash expense on the demo shop (owner, not at a till); the shift page shows the "at a till" message for a password session.

## Not done
- The shift screens were not used from a till PIN session in the browser.
- A printed shift summary; sales by shift in reports; expense receipt photos; credit debt payments in expected cash (credit sales come later).
