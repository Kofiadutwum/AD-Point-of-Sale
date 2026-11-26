# Phase 2-1: Shifts, cash paid in and out, and expenses

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A till's cash is accounted for: a shift opens with a float, cash paid in or out is recorded with a reason, and at close the counted cash is compared with what should be there. Expenses are recorded, and a cash expense comes out of the open shift.

**Spec:** 4.6, 4.7, 6.14, 6.43.

## Global constraints
- **Setting** `tenants.require_shifts` (off). When on, an online sale at a till with no open shift is refused (`no_open_shift`); an offline sale is kept and flagged for review. Shifts can be used with the setting off too.
- **Shift** (table `shifts`): one open shift per register (partial unique index). Open needs `make_sale`; opening float ≥ 0.
- **Cash movements** (table `cash_movements`, `paid_in` / `paid_out`, reason required) need `manage_cash` (owner and manager presets, usable by PIN).
- **Expected cash at close** = opening float + cash tendered on the shift's completed sales − change given + paid in − paid out − cash refunds made at that register during the shift (returns and the money given back on exchanges). Sales and returns carry `shift_id` (the register's open shift when they are made).
- **Variance** = counted − expected. When |variance| is above `tenants.cash_variance_limit_pesewas` (default 0) and the person closing lacks `approve_actions`, a reason and a manager's PIN approval are needed (action `cash_variance`, context `<shiftId>:<variance>`).
- **Expenses** (table `expenses`: branch, category, amount, method cash / MoMo / card / bank, reference for non-cash, note, recorded by, approved by, shift): permission `record_expenses` (owner and manager presets). Above `tenants.expense_approval_limit_pesewas` (default 0) without `approve_actions` needs approval (action `expense`, context `<branchId>:<amount>`). A cash expense at a till with an open shift is also a `paid_out` movement. Receipt photos: later.
- **Audit:** `shift_opened`, `cash_paid_in`, `cash_paid_out`, `shift_closed`, `expense_recorded`.

## Tasks
1. Schema, permissions, approval actions; exact-list tests.
2. `shifts.ts`: `openShift`, `currentShift`, `cashMovement`, `shiftSummary` (expected so far), `closeShift`; `completeSaleTx` and returns link the open shift and enforce the setting. Tests: `one open shift per till`, `expected cash counts sales, change, paid in and out, and cash refunds`, `a variance above the limit needs a reason and approval`, `sales need an open shift when the shop requires it`.
3. `expenses.ts`: `recordExpense`, `listExpenses`. Tests: `a cash expense comes out of the open shift`, `an expense above the limit needs approval`.
4. Screens: `/app/shift` (open, paid in/out, live summary, close), `/app/expenses`, settings (require shifts, variance limit, expense limit), home links.
5. Verify, hand over, merge.
