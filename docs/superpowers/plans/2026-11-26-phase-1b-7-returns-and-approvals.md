# Phase 1b-7: Returns, Refunds, and Manager Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff can take back items from a receipt and refund them (cash, MoMo, card, bank, or store credit), take a return without a receipt as store credit, and get a manager's approval by PIN when a refund needs it.

**Architecture:** A reusable approval service (`approvals.ts`) issues a single-use, two-minute token bound to an action and its context after checking another person's PIN. `returns.ts` records a return and its lines, works out each refund from the sale line, refuses returning more than was sold (the sale row is locked), puts saleable stock back, and issues store credit when that is the refund method.

**Tech Stack:** Next.js 16, Drizzle, PGlite tests, Vitest, zod 4.

**Spec:** `docs/superpowers/specs/2026-10-20-multishop-pos-design.md` sections 6.7, 6.12, 6.33.

## Not in this plan (Plan 1b-8)
Exchanges (6.32), counter orders paid at another counter (6.39), cash rounding (6.40), refunds in pot actual sales and food reports.

## Global Constraints
- **Approvals (6.7):** actions `refund`, `refund_other_method`, `no_receipt_return`. The approver is another active user at the branch holding `approve_actions`, checked with `verifyStaffPin` (the till lockout). The token is random, stored as a hash, valid 2 minutes, single use, and bound to `{ action, contextKey }` (for a refund: the sale id and the refund total in pesewas); a changed amount needs a new approval. Audit `approved_<action>`.
- **Refund per item:** `round_half_up(line.total × returnQty / line.quantity)`; refund total = sum.
- **Approval needed when:** the refund method differs from the sale's first tender method and the user lacks `refund_other_method`; or the total is above `tenants.refund_limit_pesewas` (default 0 = always) and the user lacks `refund_without_approval`.
- **Quantities:** never more than sold minus already returned for that line (sale row locked `for update`).
- **Conditions:** `saleable` (back on hand, movement `return_restock`, into the batch it was sold from when batch-tracked), `damaged`, `expired` (recorded on the return; stock unchanged). Shortcut: bundles, recipes, combos, and serial items are refused for return in this plan (`not_returnable`); they come with exchanges.
- **Refund methods:** `cash`, `momo_manual`, `card_terminal`, `bank_transfer` (reference required for non-cash), `store_credit` (needs the sale's customer). Returns are recorded in `returns`; no negative payments.
- **No-receipt returns (6.33):** only when `tenants.allow_no_receipt_returns`; customer name and Ghana phone (an existing customer by phone, or a new one); at most `tenants.no_receipt_monthly_limit` (default 2) per customer per calendar month; always approval `no_receipt_return`; value = the lowest unit price the item sold for in the last 90 days at this shop (refused if never sold: `no_price_history`); always store credit, never cash.
- **Permissions:** `process_return` (owner, manager; cashier preset too, and `TILL_PERMISSIONS`), `refund_without_approval`, `refund_other_method` (owner, manager).
- **Audit:** `return_processed`, `no_receipt_return`.

## Review Focus
1. **Two returns of the same line at once** never return more than was sold. → Task 4 `two returns at once never exceed what was sold`.
2. **An approval token reused, expired, or for a different amount** is refused. → Task 3 `an approval is single use, short-lived, and bound to its amount`.
3. **A cashier approving their own refund** is refused. → Task 3 `self-approval is refused`.
4. **A no-receipt return paid in cash** is impossible; it is always store credit. → Task 5.
5. **A batch item returned** goes back into the batch it came from. → Task 4 `saleable items go back on hand, into their batch`.

---

### Task 1: Schema and permissions
**Files:** `src/db/schema/{selling,stock,tenancy}.ts`, `src/lib/permissions.ts`, `src/lib/permission-labels.ts`, migrations `0022_returns` (generated) and `0023_returns_rls` (custom). Test `tests/db/returns-schema.test.ts`, `tests/lib/permissions.test.ts`.
- `returns`: `id, tenantId, branchId, saleId uuid null, customerId uuid null, kind ('receipt'|'no_receipt'), reason text, refundMethod text, refundPesewas integer >= 0, reference text, requestedBy, approvedBy uuid null, createdAt`; composite FKs.
- `returnLines`: `id, tenantId, returnId, saleLineId uuid null, variantId, unitId, quantity numeric(14,3) > 0, baseQuantity, condition ('saleable'|'damaged'|'expired'), refundPesewas >= 0`.
- `approvals`: `id, tenantId, action, contextKey text, tokenHash text unique, requestedBy, approvedBy, expiresAt, usedAt`.
- `MovementType` + `'return_restock'` (check updated); `tenants.refund_limit_pesewas integer default 0`, `allow_no_receipt_returns boolean default false`, `no_receipt_monthly_limit integer default 2`.
- Permissions and labels: `process_return` 'Take returns and refunds', `refund_without_approval` 'Refund without a manager', `refund_other_method` 'Refund by a different method'.
- `0023`: tenant isolation on the three tables; `process_return` for owners, managers, cashiers; the other two for owners and managers.
- [ ] Failing tests (`a return line quantity must be positive`, `an approval token is unique`, permissions); schema; generate; PASS; commit `feat(db): returns, return lines, approvals`.

### Task 2: Store credit inside a transaction
**Files:** `src/server/customers.ts`. Extract `creditStoreCreditTx(tx, { tenantId, customerId, amountPesewas, source, reason, userId })` from `issueStoreCredit` (which then calls it); add source `'no_receipt_return'`. Existing customer tests stay green. Commit `refactor(customers): store credit inside a caller's transaction`.

### Task 3: Approvals
**Files:** create `src/server/approvals.ts`. Test `tests/server/approvals.test.ts`.
```ts
export type ApprovalAction = 'refund' | 'refund_other_method' | 'no_receipt_return';
export async function requestApproval(db: Db, ctx: Ctx, input: { action: ApprovalAction; contextKey: string; approverId: string; pin: string }, now: Date):
  Promise<{ ok: true; token: string } | Fail<'invalid_input' | 'self_approval' | 'not_authorised' | 'wrong_pin' | 'pin_locked'>>;
export async function consumeApproval(tx: Tx, ctx: Ctx, input: { token: string; action: ApprovalAction; contextKey: string }, now: Date): Promise<{ approverId: string } | null>;
```
- [ ] Failing tests `a manager approves with their PIN`, `self-approval is refused`, `an approval is single use, short-lived, and bound to its amount`; implement; commit `feat(controls): manager approval tokens`.

### Task 4: Returns with a receipt
**Files:** create `src/server/returns.ts`. Test `tests/server/returns.test.ts`.
```ts
export type ReturnLineView = { saleLineId: string; name: string; unitName: string; sold: string; returned: string; returnable: string; unitRefundPesewas: number };
export async function findReturnableSale(db: Db, ctx: Ctx, receiptNumber: string): Promise<{ saleId: string; receiptNumber: string; method: TenderMethod; customerId: string | null; lines: ReturnLineView[] } | null>;
export async function quoteReturn(...same items...): refund total and whether approval is needed (`refund` / `refund_other_method` / none);
export async function processReturn(db: Db, ctx: Ctx, input: {
  saleId: string; items: Array<{ saleLineId: string; quantity: string; condition: 'saleable' | 'damaged' | 'expired' }>; reason: string;
  refundMethod: 'cash' | 'momo_manual' | 'card_terminal' | 'bank_transfer' | 'store_credit'; reference?: string; approvalToken?: string;
}, now: Date): Promise<{ ok: true; returnId: string; refundPesewas: number } | Fail<'invalid_input' | 'not_found' | 'too_many' | 'not_returnable' | 'approval_required' | 'reference_required' | 'needs_customer'>>;
```
- [ ] Failing tests: `refunds part of a line by its share of the line total`, `saleable items go back on hand, into their batch`, `damaged items do not go back on hand`, `two returns at once never exceed what was sold`, `a refund by another method needs approval`, `a refund over the limit needs approval`, `store credit goes to the sale's customer`, `bundles and serial items are not returnable yet`; implement; commit `feat(controls): returns and refunds`.

### Task 5: Returns without a receipt
**Files:** `src/server/returns.ts`. Test `tests/server/returns.test.ts`.
```ts
export async function returnWithoutReceipt(db: Db, ctx: Ctx, input: { customer: { name: string; phone: string }; items: Array<{ variantId: string; unitId: string; quantity: string; condition: 'saleable' | 'damaged' | 'expired' }>; reason: string; approvalToken: string }, now: Date):
  Promise<{ ok: true; returnId: string; creditPesewas: number } | Fail<'invalid_input' | 'not_allowed' | 'monthly_limit' | 'approval_required' | 'no_price_history' | 'not_returnable'>>;
```
- [ ] Failing tests `gives store credit at the lowest price of the last 90 days`, `refused when the shop does not allow it`, `at most the monthly limit per customer`, `always needs approval`; implement; commit `feat(controls): returns without a receipt`.

### Task 6: Screens
`/[slug]/app/returns`: find a receipt → returnable lines with quantity and condition, refund method, reference, reason → quote; when approval is needed, a manager and PIN field set (requestApproval then processReturn) → return slip. A "No receipt" form (shop setting on) with customer, items, manager PIN. Shop settings: refund limit, no-receipt returns on/off and monthly limit. Home link "Returns" (`process_return`). Build green; commit.

### Task 7: Verify and hand over
Full suite, build, browser walk-through (return part of a sale to cash, a refund needing approval), hand-over note, merge.
