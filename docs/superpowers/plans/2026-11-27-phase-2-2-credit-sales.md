# Phase 2-2: Credit sales ("on book") and customer accounts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Named customers can buy on credit up to a limit a manager sets, pay off in parts by any method with a receipt showing the new balance, and the shop sees who owes, oldest debt first. The ledger is never edited.

**Spec:** 4.5, 6.13, 6.12 (returns on a credit sale).

## Global constraints
- **Customer account:** `customers.credit_limit_pesewas` (0 = no credit), `customers.balance_pesewas` (what they owe, ≥ 0), `customers.reminder_consent` (stored now; SMS reminders come with SMS). Limits are set by someone with `approve_actions`.
- **Ledger** (table `customer_ledger`): `sale` (+), `payment` (−), `return` (−), `adjustment` (±, reason and approver), with method, reference, sale, return, shift, user. Never updated or deleted; the balance always equals the sum.
- **Credit tender** `credit` (no reference). Online only: an offline sale with a credit tender is kept and flagged (`credit_offline`). Needs `sell_on_credit` (owner and manager presets, usable by PIN) and a customer on the sale. When balance + credit amount is over the limit, a manager approves (`credit_over_limit`, context `<saleId>:<amount>`, passed as `creditApprovalToken`). The customer row is locked so two sales cannot overrun the limit together.
- **Debt payments:** `receive_debt_payment` (owner, manager, and cashier presets; usable by PIN). Amount 1..balance; MoMo, card, and bank need a reference; cash at a till joins the open shift and counts in its expected cash.
- **Returns:** refund method `credit` (only for a sale paid on credit) reduces the balance by the refund, never below 0 (`credit_refund_exceeds_balance`).
- **Adjustments:** `approve_actions` only, with a reason; positive or negative; balance never below 0.
- **Who owes:** customers with a balance, oldest unpaid credit sale first (the oldest sale not covered by later payments, worked out first-in-first-out).
- **Audit:** `credit_sale`, `debt_payment`, `balance_adjusted`, `credit_terms_saved`.

## Tasks
1. Schema, permissions (cashier preset gains `receive_debt_payment`), approval action, tender method, exact-list tests.
2. Sales and returns: credit tender rules and ledger; credit refunds. Tests: `a credit sale adds to the balance`, `over the limit needs a manager`, `credit needs a customer and the permission`, `an offline credit sale is kept for review`, `a return on a credit sale reduces the balance`.
3. `customer-accounts.ts`: `saveCreditTerms`, `recordDebtPayment`, `adjustBalance`, `customerAccount` (ledger), `listDebtors`; shift expected cash adds cash debt payments. Tests: `part payments reduce the balance and cannot exceed it`, `a cash payment at a till counts in the shift`, `adjustments need a reason and a manager`, `debtors are listed oldest debt first`.
4. Screens: customer account section on the customers page (limit, consent, payments, adjustments, ledger), "Who owes" list, credit tender on the web selling screen.
5. Verify, hand over, merge.

## Not in this plan
Credit on the offline till screen, weekly SMS of debtors and reminders (with SMS), opening balances by CSV.
