# Phase 1a · Plan 3 of 4: Selling and Stock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cashier sells on a registered till: scans (scanner or phone camera) or searches items, sees exact totals, takes cash, MoMo, card-terminal, bank-transfer, or store-credit payments (split allowed), and completes the sale exactly once; stock goes down exactly once in base units (bundles, recipes, batches earliest-expiry-first, serials); the customer gets a printed (58/80 mm), linked, or WhatsApp receipt; managers receive stock, see negative-stock alerts, and read a basic dashboard. The device-side outbox (Plan 4) posts the same sale to `POST /api/[slug]/sales`.

**Architecture:** Same shape as Plans 1 and 2. Pure rules (cart totals, receipt numbers and share text, weighted average cost, business date) live in `src/lib/` with no server imports, so the device runs identical maths. `completeSale` in `src/server/sales.ts` validates every line against the server's catalogue and prices, then in **one** `withTenant` transaction creates the sale as `pending`, records payments (store credit is reduced atomically), and calls `finaliseSaleTx`, which locks the sale row, deducts stock once through `deductStockForLine`, and marks it `completed`. A refusal discovered during finalising rolls the whole transaction back. The sale id made on the device is the primary key and the idempotency key; the register row is locked for the length of the transaction so receipt numbers from one till are checked one at a time. The HTTP handlers are plain functions over `Request` in `src/server/sales-http.ts` (tested without Next), and the route files only call them.

**Tech Stack:** As Plan 2 (Next.js 16.4, Drizzle 0.45, PGlite tests, postgres.js for Supabase, zod 4, Vitest 5), plus `@zxing/browser` and `@zxing/library` as the camera-scanning fallback (spec 11).

**Spec:** `docs/superpowers/specs/2026-10-20-multishop-pos-design.md` (v4). Sections 4.1, 4.2, 4.3, 4.7, 4.9, 4.10, 4.17, 4.18, pseudocode 6.0, 6.5, 6.6, 6.8, 6.9, 6.10 (server part), 6.21, 6.23, 6.28, 6.31 (store credit only), records in section 7, acceptance tests in section 13. Roadmap: `docs/superpowers/plans/2026-10-20-phase-1a-1-foundation.md`. Plan 2 decisions: `docs/superpowers/plans/2026-10-20-phase-1a-2-catalogue.md`.

**Shared contract with Plan 4 (offline PWA).** Agreed with the Plan 4 session; do not change it without messaging that session. Details: shared notes `plan-3-selling-contract.md`.

```ts
// src/server/sales.ts
completeSale(db: Db, ctx: Ctx, input: SaleInput, now: Date): Promise<SaleResult>;
type SaleInput = {
  saleId: string;                    // uuid made on the device
  receiptNumber: string;             // '<branchCode>-<registerCode>-<6 digits>'
  lines: Array<{ variantId: string; unitId: string; quantity: string; unitPricePesewas: number; discountPesewas: number; serials?: string[] }>;
  tenders: Array<{ id: string; method: TenderMethod; amountPesewas: number; reference?: string }>;
  customerId?: string; cashierId?: string; deviceCreatedAt: string; fromOfflineOutbox?: boolean;
};
type TenderMethod = 'cash' | 'momo_manual' | 'card_terminal' | 'bank_transfer' | 'store_credit';
type SaleResult = { ok: true; saleId: string; status: 'completed' | 'pending'; changeDuePesewas: number; alreadyExisted: boolean } | { ok: false; error: SaleError };
// HTTP: POST /api/[slug]/sales (200 ok, 400 invalid_input, 401/403 auth, 409 business errors)
//       GET  /api/[slug]/register/counter → { registerCode: string; lastCounter: number }
```

`serials` and `cashierId` are the two agreed additions to the brief's contract; both are optional. `src/lib/cart-totals.ts` has the signature Plan 4 proposed and is shared byte for byte through the notes folder.

## Not in this plan

- Manager approvals and approval tokens (6.7), price overrides, discount limits, cash rounding (6.40), returns, refunds, exchanges, voids, and cancelling a pending sale → Phase 1b. Here a line discount needs the `give_discount` permission and may not exceed the line amount; there is no cart-level discount at the till (the totals helper supports one for later).
- Returns that refund to store credit (6.12, 6.33) → Phase 1b. This plan provides `creditStoreCredit(tx, …)` for them to call, plus a manager-only goodwill or refund credit (6.31).
- Store-credit top-ups paid in advance and gift cards → Phase 5 (they need "money held for customers" reporting). Credit sales (6.13), shifts (6.14) → Phase 2.
- Integrated payment providers and webhooks (6.11) → Phase 6. Every tender here is confirmed when recorded, so `pending` happens only for an underpaid outbox sale.
- Suppliers, purchase orders, supplier bills, transfers, stock counts, adjustments, the expired bucket, reserved stock → Phase 4. Receiving records a free-text supplier name only.
- A cashier choosing a batch, the near-expiry report, prescriptions, add-ons, combos → Phase 1b.
- Price-carrying scale labels: the contract has no label price, so the line is priced `round(unit price × quantity)`, which can differ from the printed label by a pesewa (spec 6.6 uses the label price). → revisit with Plan 4 if shops complain.
- SMS or email alerts: negative stock is recorded as an audit entry and listed on the dashboard; SMS arrives in Phase 2. Shop logo and storefront link on receipts → Phase 2. PDF receipts → Phase 1b (the print view can be saved as PDF from the browser).
- Device outbox, catalogue cache, the local-first till at `src/app/[slug]/till/sell/`, owner MFA → Plan 4. This plan's sell page (`/[slug]/app/sell`) is a small online screen for testing and store-credit sales.

## Global Constraints

Plan 1 and Plan 2 Global Constraints still apply. The ones this plan leans on most, restated:

- Money is whole pesewas in integers; never floating point (spec 6.0). Rounding is half up, once per line (4.2).
- `tenant_id` comes from the session (`ctx.tenantId`), never from the URL or request body.
- Every new table has `tenant_id` and an RLS policy keyed on `app.tenant_id`; `tests/db/rls.test.ts` checks every public table. Links between shop rows are composite `(tenant_id, x_id) → x(tenant_id, id)` foreign keys.
- Shop data only through `withTenant()`. `asPlatform()` is allowed in the Plan 1 list plus `src/server/receipts.ts` (public receipt link: slug → tenant id, nothing else). App code never reads `tx.execute()` results.
- Services take `now: Date` last when they read the clock, return `{ ok: true, … } | { ok: false, error }`, throw only `AccessError` or programming errors, and call `assertPermission(ctx, …)` first. Every file in `src/server/` and `src/db/` starts with `import 'server-only';`; `src/lib/` never imports server code.
- Quantities are `numeric(14,3)` strings with 3 places; arithmetic in `src/lib/decimal.ts` (BigInt) or in SQL. Stock balances may be negative, and `decimal.ts` handles only non-negative values, so stock is added and subtracted in SQL (`on_hand = on_hand - $qty`) and compared in SQL.

New for this plan:

- **Stock is in base units:** `base_qty = multiplyQty(quantity, unit.factor)`. Bundles and recipes hold no stock; selling one deducts `component.quantity × base_qty` of each component, recursively (6.28).
- **Expired** means `expiry_date <= today` in the shop timezone, both when receiving (6.23 refuses it) and when selling (never sold; earliest unexpired expiry first; ties by received time).
- **Weighted average cost** is per variant across all branches: `unit_cost = total_cost / base_qty` (4 places, half up); when shop-wide on-hand ≤ 0 the new average is `unit_cost`, otherwise `(on_hand × avg + base_qty × unit_cost) / (on_hand + base_qty)`, 4 places, half up (6.23).
- **Sale status:** `pending` then `completed`, exactly once. Pending sales never count in totals and never reduce stock (6.9).
- **Tenders:** `momo_manual`, `card_terminal`, `bank_transfer` need a reference (1–100 characters); only cash may make the tenders exceed the total, so non-cash tenders together may not exceed it; `changeDue = max(0, Σ tenders − total)` (4.3, 6.8). `store_credit` needs the sale's customer, and the balance never goes below zero (`update … where store_credit_pesewas >= amount`).
- **Receipt numbers** match `/^([A-Z0-9]{1,6})-([A-Z0-9]{1,6})-(\d{6})$/`, start with the sale register's branch and register codes, are unique per shop, and `registers.receipt_counter` keeps the highest counter accepted (6.0).
- **Business date:** `businessDate(timezone, cutoff, at)` with `at = min(deviceCreatedAt, now)`; a local time before the cutoff (`'HH:MM'`, default `'00:00'`) belongs to the previous day (4.7).
- **Outbox leniency** (6.10): with `fromOfflineOutbox: true` a changed price, an archived item, negative stock in a blocking shop, only-expired batch stock, missing or unknown serials, and underpayment are accepted and recorded in `review_reasons` with `needs_review = true`; every other error refuses the sale as it would online.
- **Negative stock** is allowed unless the shop switches `allow_negative_stock` off (4.1). Every balance that goes below zero writes one `negative_stock` audit row (actor `system`) and shows on the dashboard.
- Stock movements, store-credit entries, and the audit log are append-only for `pos_app`.
- Audit actions added: `sale_completed`, `stock_received`, `customer_added`, `store_credit_issued`, `negative_stock`, `receipt_reprinted`, `sales_settings_saved`.

## Review Focus

Inputs the spec implies but does not spell out. Each has a test in the task named.

1. **The same sale sent twice at the same moment** (double tap, or the outbox retrying while the first request is still running) must create one sale, one receipt, one deduction. → Task 6 `two identical requests at once make one sale and deduct once`.
2. **Two sales spending one customer's store credit at the same moment** must never take the balance below zero. → Task 3 `two redemptions at once never overdraw store credit`.
3. **A batch that expires today** is expired: receiving it is refused, and the till takes the next batch instead. → Task 4 `needs a batch number and expiry for batch items, and refuses stock that expires today`; Task 5 `skips expired batches, including one that expires today`.
4. **A device clock that is wrong, or a sale synced after midnight**, must count for the day it happened and never for a future day. → Task 2 `works out the business date with a cutoff`; Task 6 `an outbox sale made before midnight counts for that day; a future device time counts as now`.
5. **Another shop's ids in a sale body** (variant, unit, customer, or a sale id already used by shop B) must be refused, never sold or overwritten. → Task 6 `refuses another shop's items, customer, and sale id`.

## File Structure

```text
src/db/schema/stock.ts        stock_balances, stock_batches, serials, stock_receipts, stock_movements
src/db/schema/selling.ts      customers, store_credit_entries, sales, sale_lines, payments
src/db/schema/tenancy.ts      + tenants.allow_negative_stock, tax_number, receipt_footer; registers unique (tenant_id, id)
src/db/schema/people.ts       + users unique (tenant_id, id)
drizzle/0006_*.sql            generated; drizzle/0007_selling_rls.sql custom (RLS + append-only grants)
src/lib/cart-totals.ts        calculateCartTotals (spec 6.6) — shared with Plan 4 byte for byte
src/lib/receipt.ts            receipt number parse/format, share text, WhatsApp link
src/lib/stock.ts              unitCostOf, weightedAverageCost
src/lib/dates.ts              + businessDate
src/server/usage.ts           variantsInUse (blocks tracking, fractions, factor edits)
src/server/customers.ts       customers, store credit issue/credit/redeem
src/server/stock.ts           receiveStock, lookupStockItem, deductStockForLine
src/server/sales.ts           completeSale, finaliseSale, finaliseSaleTx, listRecentSales
src/server/till.ts            tillRegister, lookupTillItem, tillItemForVariant
src/server/sales-http.ts      handleSalePost, handleCounterGet
src/server/receipts.ts        getReceipt, getPublicReceipt
src/server/dashboard.ts       getDashboard
src/server/shop-settings.ts   + getSalesSettings, saveSalesSettings
src/app/api/[slug]/sales/route.ts, src/app/api/[slug]/register/counter/route.ts
src/app/[slug]/app/sell/...           online sell screen (page, actions)
src/components/till/{sell-screen,camera-scanner}.tsx
src/components/receipt-view.tsx       receipt body shared by staff and public pages
src/app/[slug]/app/receipts/[saleId]/page.tsx   print view 58/80 mm, share buttons
src/app/[slug]/r/[code]/page.tsx                public receipt link
src/app/[slug]/app/{dashboard,sales,customers,stock/receive}/...
tests/lib/{cart-totals,receipt,stock}.test.ts, tests/lib/dates.test.ts (+)
tests/db/selling-schema.test.ts
tests/server/{customers,stock,deduct,sales,sales-http,receipts,dashboard,till}.test.ts
tests/helpers/fixtures.ts     + tillCtxFor, stockFor, saleInput
```

---

### Task 1: Selling and stock schema with row-level security

**Files:**
- Create: `src/db/schema/stock.ts`, `src/db/schema/selling.ts`, `drizzle/0006_*.sql` (generated), `drizzle/0007_selling_rls.sql` (custom)
- Modify: `src/db/schema/index.ts`, `src/db/schema/tenancy.ts`, `src/db/schema/people.ts`
- Test: `tests/db/selling-schema.test.ts`

**Interfaces:**
- Produces (Drizzle tables; quantities `numeric(14,3)`, money `integer`, ids `uuid`):
  - `tenants` + `allowNegativeStock boolean not null default true`, `taxNumber text`, `receiptFooter text`. `registers` + `unique('registers_tenant_id').on(tenantId, id)`; `users` + `unique('users_tenant_id').on(tenantId, id)`.
  - `stockBalances`: `tenantId, branchId, variantId, onHand (default '0'), updatedAt`; primary key `(tenant_id, branch_id, variant_id)`; FKs to branches and variants.
  - `stockBatches`: `id, tenantId, branchId, variantId, batchNumber, expiryDate (date string), onHand, createdAt`; unique `(tenant_id, branch_id, variant_id, batch_number)` and `(tenant_id, id)`.
  - `serials`: `id, tenantId, variantId, branchId, serial, status 'in_stock' | 'sold', saleId (nullable), soldAt, createdAt`; unique `(tenant_id, variant_id, serial)` and `(tenant_id, id)`; check on status.
  - `stockReceipts`: `id, tenantId, branchId, kind 'received' | 'opening_stock', supplierName, note, receivedBy (users), createdAt`.
  - `stockMovements`: `id bigint identity, tenantId, branchId, variantId, type 'opening_stock' | 'received' | 'sale', quantity (signed, ≠ 0), batchId, serialId, unitCost numeric(14,4) (receipts only), referenceType 'stock_receipt' | 'sale', referenceId uuid, saleLineId uuid, userId, createdAt`; index `(tenant_id, variant_id, created_at)`; composite FKs to batch and serial.
  - `customers`: `id, tenantId, name, phone (not null, 233 + 9 digits), priceListId (nullable, composite FK), storeCreditPesewas integer not null default 0 check ≥ 0, createdAt`; unique `(tenant_id, phone)` and `(tenant_id, id)`.
  - `storeCreditEntries`: `id bigint identity, tenantId, customerId, type 'issued' | 'redeemed', source 'refund' | 'goodwill' | 'sale', amountPesewas (signed, ≠ 0), saleId, reason, userId, createdAt`.
  - `sales`: `id uuid primary key (no default), tenantId, branchId, registerId, cashierId, customerId, receiptNumber, status 'pending' | 'completed', taxMode, subtotalPesewas, discountPesewas, taxPesewas, totalPesewas, paidPesewas, changeDuePesewas, fromOffline, needsReview, reviewReasons text[] default '{}', deviceCreatedAt, receivedAt, completedAt, businessDate (date string, not null), shareCode (unique, not null)`; unique `(tenant_id, receipt_number)` and `(tenant_id, id)`; index `(tenant_id, business_date)`; composite FKs to branches, registers, users, customers.
  - `saleLines`: `id uuid default, tenantId, saleId, lineNo, variantId, unitId (no FK; unit rows can be removed), name, unitName, quantity, baseQuantity, unitPricePesewas, currentPricePesewas, discountPesewas, grossPesewas, taxRateBp, taxPesewas, totalPesewas, serials text[] default '{}'`; unique `(sale_id, line_no)` and `(tenant_id, id)`; composite FKs to sales and variants.
  - `payments`: `id uuid primary key (device tender id), tenantId, saleId, method, amountPesewas (> 0), reference, status 'confirmed' | 'pending' default 'confirmed', confirmedBy, createdAt`; composite FK to sales; check `method in ('cash', 'momo_manual', 'card_terminal', 'bank_transfer', 'store_credit')`; check `method in ('cash', 'store_credit') or reference is not null`.
  - Exported types: `TenderMethod`, `SaleStatus`, `MovementType`.
- `0007_selling_rls.sql`: the Plan 2 `tenant_isolation` policy on every new table; `REVOKE UPDATE, DELETE ON stock_movements, store_credit_entries FROM pos_app;`.

- [ ] **Step 1: Write the failing tests** in `tests/db/selling-schema.test.ts` (two seeded shops `a`, `b`; rows inserted with `asPlatform`, checks with `withTenant` and `dbError`):

```ts
it('composite keys stop a sale line or payment pointing at another shop', async () => {
  // a sale in shop a; a sale line for shop a whose variant belongs to shop b → foreign key error
  expect(await dbError(insertLine(a, saleA.id, variantOfB))).toMatch(/foreign key/);
  expect(await dbError(insertPayment(b, saleA.id))).toMatch(/foreign key/);
});
it('receipt numbers are unique per shop but may repeat across shops', async () => {
  await insertSale(a, { receiptNumber: 'B1-T1-000001' });
  expect(await dbError(insertSale(a, { receiptNumber: 'B1-T1-000001' }))).toMatch(/sales_receipt_number/);
  await expect(insertSale(b, { receiptNumber: 'B1-T1-000001' })).resolves.toBeDefined();
});
it('store credit cannot go below zero', async () => {
  expect(await dbError(asPlatform(db, (tx) => tx.update(customers).set({ storeCreditPesewas: -1 })))).toMatch(/customers_store_credit/);
});
it('non-cash payments need a reference', async () => {
  expect(await dbError(insertPayment(a, saleA.id, { method: 'momo_manual', reference: null }))).toMatch(/payments_reference/);
});
it('stock movements and store credit entries are append-only for pos_app', async () => {
  expect(await dbError(withTenant(db, a.tenantId, (tx) => tx.update(stockMovements).set({ quantity: '1' })))).toMatch(/permission denied/);
  expect(await dbError(withTenant(db, a.tenantId, (tx) => tx.delete(storeCreditEntries)))).toMatch(/permission denied/);
});
```

(`insertSale`, `insertLine`, `insertPayment` are small local helpers in the test file. `tests/db/rls.test.ts` needs no change: it already checks every public table.)

- [ ] **Step 2: Run** `npx vitest run tests/db` → FAIL (tables missing).
- [ ] **Step 3: Write the schema**, then generate: `npx drizzle-kit generate --name selling` and `npx drizzle-kit generate --custom --name selling_rls`, and fill the custom file with the policies and revokes above.
- [ ] **Step 4: Run** `npx vitest run tests/db` → PASS, including `rls.test.ts`.
- [ ] **Step 5: Commit**

```bash
git add src/db drizzle tests/db
git commit -m "feat(db): add stock, customer, sale, and payment tables with row-level security"
```

---

### Task 2: Pure selling helpers

**Files:**
- Create: `src/lib/cart-totals.ts`, `src/lib/receipt.ts`, `src/lib/stock.ts`
- Modify: `src/lib/dates.ts`
- Test: `tests/lib/cart-totals.test.ts`, `tests/lib/receipt.test.ts`, `tests/lib/stock.test.ts`, `tests/lib/dates.test.ts`

**Interfaces:**
- Produces:

```ts
// src/lib/cart-totals.ts (shared with Plan 4: copy the same file to the notes folder as cart-totals.ts and cart-totals.test.ts)
export type CartLineInput = { unitPricePesewas: number; quantity: string; discountPesewas: number; labelPricePesewas?: number | null; taxRateBp: number };
export type CartLineTotals = { grossPesewas: number; discountPesewas: number; netPesewas: number; taxPesewas: number; totalPesewas: number };
export type CartTotals = { lines: CartLineTotals[]; subtotalPesewas: number; discountPesewas: number; taxPesewas: number; totalPesewas: number };
export function calculateCartTotals(lines: CartLineInput[], opts: { taxMode: 'inclusive' | 'exclusive'; cartDiscountPesewas?: number }): CartTotals;
// src/lib/receipt.ts
export const RECEIPT_NUMBER: RegExp; // /^([A-Z0-9]{1,6})-([A-Z0-9]{1,6})-(\d{6})$/
export function parseReceiptNumber(s: string): { branchCode: string; registerCode: string; counter: number } | null;
export function formatReceiptNumber(branchCode: string, registerCode: string, counter: number): string;
export function receiptShareText(r: { shopName: string; receiptNumber: string; totalPesewas: number; url: string }): string;
export function whatsappShareUrl(text: string, phone?: string | null): string;
// src/lib/stock.ts
export function unitCostOf(totalCostPesewas: number, baseQty: string): string;          // 4 places, half up; baseQty > 0
export function weightedAverageCost(onHand: string, averageCost: string, addedQty: string, addedUnitCost: string): string;
// src/lib/dates.ts
export function businessDate(timeZone: string, cutoff: string, at: Date): string;
```

**Rules:**
- `calculateCartTotals` follows spec 6.6: `gross = labelPricePesewas ?? pesewasTimesQty(unitPrice, quantity)`; the cart discount is spread in proportion to gross (`floor(cart × gross / Σ gross)`), leftover pesewas to the largest-gross line (the first one on a tie); line `discountPesewas` in the result = line discount + its share; `net = gross − discount`; inclusive `tax = net − round(net × 10000 / (10000 + rate))`, `total = net`; exclusive `tax = round(net × rate / 10000)`, `total = net + tax`; every round is half up with `divHalfUp`. It throws `RangeError` when a line discount exceeds its gross or the cart discount exceeds the subtotal (callers validate first).
- `receiptShareText`: `` `${shopName}\nReceipt ${receiptNumber}\nTotal ${formatCedis(totalPesewas)}\n${url}` ``. `whatsappShareUrl`: `https://wa.me/?text=<encodeURIComponent(text)>`, or `https://wa.me/<phone>?text=…` when a `233…` phone is given.
- `weightedAverageCost`: `onHand` may be negative (starts with `-`); when it is ≤ 0 the result is `addedUnitCost`.
- `businessDate`: local date and `HH:MM` of `at` in `timeZone`; when the local time is before `cutoff`, the previous day.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/cart-totals.test.ts
const line = (unitPricePesewas: number, quantity: string, extra: Partial<CartLineInput> = {}): CartLineInput =>
  ({ unitPricePesewas, quantity, discountPesewas: 0, taxRateBp: 0, ...extra });
it('takes tax out of inclusive prices', () => {
  const t = calculateCartTotals([line(1150, '2.000', { taxRateBp: 1500 })], { taxMode: 'inclusive' });
  expect(t).toMatchObject({ subtotalPesewas: 2300, taxPesewas: 300, totalPesewas: 2300 });
  expect(calculateCartTotals([line(999, '1.000', { taxRateBp: 1500 })], { taxMode: 'inclusive' }).taxPesewas).toBe(130);
});
it('adds tax to exclusive prices after the discount', () => {
  const t = calculateCartTotals([line(1000, '1.000', { taxRateBp: 1500, discountPesewas: 100 })], { taxMode: 'exclusive' });
  expect(t.lines[0]).toEqual({ grossPesewas: 1000, discountPesewas: 100, netPesewas: 900, taxPesewas: 135, totalPesewas: 1035 });
});
it('rounds half up once per line', () => {
  const t = calculateCartTotals([line(1999, '0.250'), line(333, '1.500')], { taxMode: 'exclusive' });
  expect(t.lines.map((l) => l.grossPesewas)).toEqual([500, 500]);
});
it('uses a label price as the gross', () => {
  expect(calculateCartTotals([line(1999, '0.500', { labelPricePesewas: 1000 })], { taxMode: 'inclusive' }).totalPesewas).toBe(1000);
});
it('spreads a cart discount by line amount, leftover to the largest line', () => {
  const t = calculateCartTotals([line(1000, '1.000'), line(500, '1.000')], { taxMode: 'inclusive', cartDiscountPesewas: 100 });
  expect(t.lines.map((l) => l.discountPesewas)).toEqual([67, 33]);
  expect(t).toMatchObject({ subtotalPesewas: 1500, discountPesewas: 100, totalPesewas: 1400 });
});
it('refuses discounts above the amount', () => {
  expect(() => calculateCartTotals([line(100, '1.000', { discountPesewas: 101 })], { taxMode: 'inclusive' })).toThrow(RangeError);
});
// tests/lib/receipt.test.ts
it('formats and parses receipt numbers', () => {
  expect(formatReceiptNumber('ACC1', 'T2', 123)).toBe('ACC1-T2-000123');
  expect(parseReceiptNumber('ACC1-T2-000123')).toEqual({ branchCode: 'ACC1', registerCode: 'T2', counter: 123 });
  for (const bad of ['ACC1-T2-123', 'acc1-T2-000123', 'ACC1-T2-0001234', 'ACC1T2000123']) expect(parseReceiptNumber(bad), bad).toBeNull();
});
it('builds the WhatsApp share link', () => {
  const text = receiptShareText({ shopName: 'Ama Shop', receiptNumber: 'B1-T1-000007', totalPesewas: 2300, url: 'https://x.test/ama/r/abc' });
  expect(text).toBe('Ama Shop\nReceipt B1-T1-000007\nTotal GHS 23.00\nhttps://x.test/ama/r/abc');
  expect(whatsappShareUrl('a b')).toBe('https://wa.me/?text=a%20b');
  expect(whatsappShareUrl('a', '233241234567')).toBe('https://wa.me/233241234567?text=a');
});
// tests/lib/stock.test.ts
it('works out unit cost per base unit', () => {
  expect(unitCostOf(4500, '1000.000')).toBe('4.5000');
  expect(unitCostOf(1000, '3.000')).toBe('333.3333');
});
it('updates the weighted average cost', () => {
  expect(weightedAverageCost('10.000', '400.0000', '10.000', '500.0000')).toBe('450.0000');
  expect(weightedAverageCost('0.000', '400.0000', '5.000', '500.0000')).toBe('500.0000');
  expect(weightedAverageCost('-2.000', '400.0000', '5.000', '500.0000')).toBe('500.0000');
});
// tests/lib/dates.test.ts (add)
it('works out the business date with a cutoff', () => {
  expect(businessDate('Africa/Accra', '00:00', new Date('2026-10-20T23:30:00Z'))).toBe('2026-10-20');
  expect(businessDate('Africa/Accra', '04:00', new Date('2026-10-21T02:00:00Z'))).toBe('2026-10-20');
  expect(businessDate('Africa/Accra', '04:00', new Date('2026-10-21T04:00:00Z'))).toBe('2026-10-21');
});
```

- [ ] **Step 2: Run** `npx vitest run tests/lib` → FAIL (missing modules).
- [ ] **Step 3: Implement** the four files from the rules, using `divHalfUp`, `toMilli`, `pesewasTimesQty`, and `formatCedis`.
- [ ] **Step 4: Run** `npx vitest run tests/lib` → PASS. Copy `src/lib/cart-totals.ts` and `tests/lib/cart-totals.test.ts` into the shared notes folder and tell the Plan 4 session they are there.
- [ ] **Step 5: Commit**

```bash
git add src/lib tests/lib
git commit -m "feat(lib): add cart totals, receipt numbers, average cost, and business date helpers"
```

---

### Task 3: Customers and store credit

**Files:**
- Create: `src/server/customers.ts`
- Modify: `tests/helpers/fixtures.ts` (add `tillCtxFor`)
- Test: `tests/server/customers.test.ts`

**Interfaces:**
- Consumes: `customers`, `storeCreditEntries` (Task 1); `normaliseGhanaPhone`; `fail`, `isUuid` from `products.ts`.
- Produces:

```ts
export type Customer = { id: string; name: string; phone: string; priceListId: string | null; storeCreditPesewas: number };
export async function addCustomer(db: Db, ctx: Ctx, input: { name: string; phone: string; priceListId?: string | null }): Promise<{ ok: true; customerId: string } | Fail<'invalid_input' | 'duplicate_phone' | 'unknown_price_list'>>; // make_sale
export async function listCustomers(db: Db, ctx: Ctx, opts: { query?: string; limit?: number }): Promise<Customer[]>; // any member; name or phone
export async function issueStoreCredit(db: Db, ctx: Ctx, input: { customerId: string; amountPesewas: number; source: 'refund' | 'goodwill'; reason: string }, now: Date): Promise<{ ok: true; balancePesewas: number } | Fail<'invalid_input' | 'not_found'>>; // approve_actions
export async function creditStoreCredit(tx: Tx, e: { tenantId: string; customerId: string; amountPesewas: number; source: 'refund' | 'goodwill'; userId: string; saleId?: string; reason?: string }): Promise<number | null>; // new balance; null = unknown customer
export async function redeemStoreCredit(tx: Tx, e: { tenantId: string; customerId: string; amountPesewas: number; saleId: string; userId: string }): Promise<boolean>; // false = not enough
// tests/helpers/fixtures.ts
export async function tillCtxFor(db: Db, shop: SeededShop, userKey: string, now: Date): Promise<Ctx>; // PIN-kind session on shop.registerId
```

`issueStoreCredit` requires a reason of 1–200 characters and an amount of 1–2 000 000 000 pesewas, and writes `store_credit_issued`. `redeemStoreCredit` is a single `update … set store_credit_pesewas = store_credit_pesewas - $amount where id = $id and store_credit_pesewas >= $amount returning`, then a `redeemed` entry with a negative amount and source `sale`.

- [ ] **Step 1: Write the failing tests**

```ts
it('adds a customer with a normalised phone, once per phone', async () => {
  expect(await addCustomer(db, cashier, { name: 'Esi', phone: '024 123 4567' })).toMatchObject({ ok: true });
  expect(await addCustomer(db, cashier, { name: 'Esi B', phone: '+233241234567' })).toEqual({ ok: false, error: 'duplicate_phone' });
  expect((await listCustomers(db, cashier, { query: '0241234567' }))[0]).toMatchObject({ name: 'Esi', phone: '233241234567', storeCreditPesewas: 0 });
});
it('only a manager can issue goodwill credit, with a reason, and it is audited', async () => {
  await expectAccess(issueStoreCredit(db, cashier, { customerId, amountPesewas: 500, source: 'goodwill', reason: 'late order' }, t0), 'forbidden');
  expect(await issueStoreCredit(db, owner, { customerId, amountPesewas: 500, source: 'goodwill', reason: '' }, t0)).toEqual({ ok: false, error: 'invalid_input' });
  expect(await issueStoreCredit(db, owner, { customerId, amountPesewas: 500, source: 'goodwill', reason: 'late order' }, t0)).toEqual({ ok: true, balancePesewas: 500 });
  // one store_credit_entries row (issued, +500, goodwill) and one store_credit_issued audit row
});
it("refuses another shop's customer", async () => {
  expect(await issueStoreCredit(db, ownerB, { customerId, amountPesewas: 1, source: 'refund', reason: 'x' }, t0)).toEqual({ ok: false, error: 'not_found' });
});
it('two redemptions at once never overdraw store credit', async () => {
  // balance 1000; two withTenant transactions each redeem 600 via Promise.all
  expect(results.sort()).toEqual([false, true]);
  // balance 400; exactly one redeemed entry of -600
});
```

- [ ] **Step 2: Run** `npx vitest run tests/server/customers.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/server/customers.ts` and `tillCtxFor`.
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/server/customers.ts tests/server/customers.test.ts tests/helpers/fixtures.ts
git commit -m "feat(customers): add customers and store credit with an append-only ledger"
```

---

### Task 4: Receiving stock and opening stock

**Files:**
- Create: `src/server/stock.ts`, `src/server/usage.ts`
- Modify: `src/server/products.ts` (`updateProduct`), `src/server/variants.ts` (`updateVariant`, `updateUnit`), `src/app/[slug]/app/products/form-data.ts` and `src/app/[slug]/app/products/[productId]/actions.ts` (message for `in_use`), `tests/helpers/fixtures.ts` (add `stockFor`)
- Test: `tests/server/stock.test.ts`, `tests/server/variants.test.ts` (+), `tests/server/products.test.ts` (+)

**Interfaces:**
- Consumes: `unitCostOf`, `weightedAverageCost` (Task 2); `multiplyQty`, `parseQuantity`, `validSaleQuantity`; `todayIn`.
- Produces:

```ts
export type ReceiveLine = { variantId: string; unitId: string; quantity: string; totalCostPesewas: number; batchNumber?: string; expiryDate?: string; serials?: string[] };
export type ReceiveError = 'invalid_input' | 'unknown_branch' | 'unknown_item' | 'not_purchasable' | 'not_stocked' | 'invalid_quantity'
  | 'batch_required' | 'expired_batch' | 'batch_expiry_mismatch' | 'serials_mismatch' | 'duplicate_serial';
export async function receiveStock(
  db: Db, ctx: Ctx, input: { branchId: string; kind: 'received' | 'opening_stock'; supplierName?: string; note?: string; lines: ReceiveLine[] }, now: Date,
): Promise<{ ok: true; receiptId: string } | Fail<ReceiveError>>; // receive_stock; detail = the 0-based line index
export async function lookupStockItem(db: Db, ctx: Ctx, code: string): Promise<{ variantId: string; unitId: string; name: string; unitName: string; tracking: Tracking } | null>; // receive_stock; SKU → base unit, barcode → its unit
export async function stockOnHand(tx: Tx, branchId: string, variantId: string): Promise<string>; // '0.000' when no row
// src/server/usage.ts
export async function variantsInUse(tx: Tx, variantIds: string[]): Promise<boolean>; // any stock movement or sale line
// tests/helpers/fixtures.ts
export async function stockFor(db: Db, ctx: Ctx, branchId: string, line: ReceiveLine, now: Date): Promise<void>; // throws on refusal
```

**Rules:** 1–100 lines; `totalCostPesewas` 0–2 000 000 000; the unit must belong to the variant and be `purchasable`; bundles and recipes are `not_stocked`; quantity follows `validSaleQuantity(q, unit.isBase && variant.allowsFractions)`. Batch items need `batchNumber` (1–40 characters) and `expiryDate` (ISO date) after today, and a saved batch with the same number must have the same expiry. Serial items need exactly `base_qty` serials (trimmed, 1–64 characters), unique in the request and new for the variant. For each line, in order: the average cost uses the shop-wide on-hand before this line; the balance is upserted (`on conflict … do update set on_hand = stock_balances.on_hand + excluded.on_hand`); one movement per line (per batch line, or per serial with quantity `1`) with `unitCost` and `referenceType 'stock_receipt'`. One `stock_received` audit row with `{ kind, lines: n }`. `updateProduct` (tracking), `updateVariant` (allowsFractions), and `updateUnit` (factor) return `{ ok: false, error: 'in_use' }` when the change touches a variant that `variantsInUse`.

- [ ] **Step 1: Write the failing tests**

```ts
it('receiving one carton of 24 adds 24 pieces and records the movement', async () => {
  // carton unit factor 24 on a piece item; receive quantity '1' of the carton at total cost 9600
  expect(await stockOnHandOf(p.variantId)).toBe('24.000');
  // one stock_movements row: type 'received', quantity '24.000', unitCost '400.0000'
});
it('weighted average cost is correct after receiving at a new cost', async () => {
  // product cost 400; receive 10 at 4000 total, then 10 at 6000 total → average '500.0000'
  // with 10 already on hand at 400, receiving 10 at 5000 total gives '450.0000'
});
it('records opening stock as its own kind', async () => {
  expect(await receiveStock(db, owner, { branchId: shop.branchId, kind: 'opening_stock', lines: [line] }, t0)).toMatchObject({ ok: true });
  // movement type 'opening_stock'
});
it('needs a batch number and expiry for batch items, and refuses stock that expires today', async () => {
  expect(await receiveStock(db, owner, receipt({ ...batchLine, batchNumber: undefined }), t0)).toMatchObject({ ok: false, error: 'batch_required', detail: '0' });
  expect(await receiveStock(db, owner, receipt({ ...batchLine, expiryDate: '2026-10-20' }), t0)).toMatchObject({ ok: false, error: 'expired_batch' });
  expect(await receiveStock(db, owner, receipt({ ...batchLine, batchNumber: 'L1', expiryDate: '2027-01-31' }), t0)).toMatchObject({ ok: true });
  expect(await receiveStock(db, owner, receipt({ ...batchLine, batchNumber: 'L1', expiryDate: '2027-02-28' }), t0)).toMatchObject({ ok: false, error: 'batch_expiry_mismatch' });
});
it('needs one new serial per unit for serial items', async () => {
  expect(await receiveStock(db, owner, receipt({ ...serialLine, quantity: '2', serials: ['IMEI1'] }), t0)).toMatchObject({ ok: false, error: 'serials_mismatch' });
  expect(await receiveStock(db, owner, receipt({ ...serialLine, quantity: '2', serials: ['IMEI1', 'IMEI2'] }), t0)).toMatchObject({ ok: true });
  expect(await receiveStock(db, owner, receipt({ ...serialLine, quantity: '1', serials: ['IMEI2'] }), t0)).toMatchObject({ ok: false, error: 'duplicate_serial' });
});
it("refuses bundles, units that cannot be bought, and another shop's branch or item", async () => { /* not_stocked, not_purchasable, unknown_branch, unknown_item */ });
it('needs the receive_stock permission', async () => {
  await expectAccess(receiveStock(db, cashier, receipt(line), t0), 'forbidden');
});
// tests/server/products.test.ts and variants.test.ts (add)
it('blocks changing tracking, fractions, or a unit factor once the item has stock', async () => {
  // after stockFor(...): updateProduct tracking 'batch' → in_use; updateVariant allowsFractions → in_use; updateUnit factor '12' → in_use; renaming still works
});
```

- [ ] **Step 2: Run** `npx vitest run tests/server/stock.test.ts tests/server/products.test.ts tests/server/variants.test.ts` → FAIL.
- [ ] **Step 3: Implement** `stock.ts` (receiving part), `usage.ts`, the three `in_use` checks, and the `in_use` message "This item already has stock or sales, so its tracking, fractions, and unit sizes cannot change."
- [ ] **Step 4: Run** the tests → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/server tests/server tests/helpers/fixtures.ts src/app
git commit -m "feat(stock): receive stock and opening stock with batches, serials, and weighted average cost"
```

---

### Task 5: Deduct stock for a sale line

**Files:**
- Modify: `src/server/stock.ts`
- Test: `tests/server/deduct.test.ts`

**Interfaces:**
- Produces:

```ts
export type DeductProblems = { negative: boolean; onlyExpired: boolean; serialsMissing: boolean };
export async function deductStockForLine(
  tx: Tx, s: { tenantId: string; branchId: string; saleId: string; saleLineId: string; userId: string; today: string },
  line: { variantId: string; baseQty: string; serials: string[] },
): Promise<DeductProblems>;
```

**Algorithm (spec 6.28):**
- Bundle or recipe: for each component, recurse with `baseQty = multiplyQty(component.quantity, line.baseQty)` and no serials; OR the problems together; return. No movement for the parent.
- Batch: lock this branch's batches of the variant with `on_hand > 0 and expiry_date > today`, ordered by `expiry_date, created_at`; take from each in turn; any remainder goes to the first of them, or, when none has stock, to the earliest unexpired batch, or to no batch. One `sale` movement per batch piece. `onlyExpired` = the variant had batch stock (`on_hand > 0`) but none of it unexpired.
- Serial: for each given serial, `update serials set status 'sold', sale_id, sold_at where variant, branch, serial, status 'in_stock'`; one movement of `-1` per serial found; any units not covered by a found serial get one movement without a serial and set `serialsMissing`.
- Otherwise one movement of `-baseQty`.
- Then upsert the balance with `-baseQty`, returning `on_hand < 0`. When negative, write `negative_stock` (actor `system`, record `variant`, changes `{ branchId, saleId }`) and set `negative`.

- [ ] **Step 1: Write the failing tests** (each runs `deductStockForLine` inside `withTenant` with a made-up `saleId`/`saleLineId`; `today = '2026-10-20'`):

```ts
it('selling one strip of 10 tablets reduces stock by 10 tablets', async () => { /* baseQty '10.000' from 30 → '20.000' */ });
it('selling a recipe reduces each ingredient by the recipe amount', async () => {
  // jollof = 0.250 kg rice + 0.050 L oil; sell baseQty '2.000' → rice −0.500, oil −0.100; no movement for jollof
});
it('takes the earliest-expiring batch first and splits across batches', async () => {
  // L1 exp 2026-12-01 qty 3, L2 exp 2026-11-15 qty 2; deduct 4 → L2 0, L1 1; two movements
});
it('skips expired batches, including one that expires today', async () => {
  // L0 exp 2026-10-20 qty 5, L1 exp 2027-01-01 qty 5; deduct 2 → L0 stays 5, L1 3
});
it('reports only-expired stock and puts the rest on the first batch, negative', async () => {
  // only L0 (exp today) qty 5: deduct 1 → onlyExpired true, negative false, balance 4, movement without a batch
});
it('a serial number can be sold only once', async () => {
  // IMEI1 in stock: first deduct with ['IMEI1'] → serial sold; second with ['IMEI1'] → serialsMissing true
});
it('records a negative balance with one audit row', async () => {
  // no stock, deduct 1 → negative true, balance '-1.000', one negative_stock audit row
});
```

(Batches for these tests are set up with `stockFor` at an earlier `now`, so the one that "expires today" was received while still in date.)

- [ ] **Step 2: Run** `npx vitest run tests/server/deduct.test.ts` → FAIL.
- [ ] **Step 3: Implement** `deductStockForLine` per the algorithm.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/server/stock.ts tests/server/deduct.test.ts
git commit -m "feat(stock): deduct sale stock through bundles, recipes, batches, and serials"
```

---

### Task 6: Complete and finalise a sale

**Files:**
- Create: `src/server/sales.ts`
- Modify: `tests/helpers/fixtures.ts` (add `saleInput`)
- Test: `tests/server/sales.test.ts`

**Interfaces:**
- Consumes: `calculateCartTotals`, `parseReceiptNumber`, `businessDate` (Task 2); `redeemStoreCredit` (Task 3); `deductStockForLine` (Task 5); `loadPriceRules` (price-lists.ts); `choosePriceList`, `resolvePrice`; `chooseTaxRule`, `effectiveRateBp`; `itemLabel`.
- Produces: `completeSale`, `SaleInput`, `SaleResult`, `TenderMethod` (see the contract at the top), and

```ts
export type SaleError = 'invalid_input' | 'no_register' | 'not_assigned' | 'cashier_not_allowed' | 'wrong_receipt_prefix' | 'duplicate_receipt_number'
  | 'sale_id_taken' | 'duplicate_tender_id' | 'unknown_item' | 'item_unavailable' | 'not_sellable' | 'invalid_quantity' | 'empty_bundle'
  | 'price_changed' | 'discount_not_allowed' | 'discount_too_large' | 'serials_required' | 'unknown_serial' | 'not_enough_stock'
  | 'only_expired_stock' | 'reference_required' | 'reduce_non_cash_amount' | 'payment_incomplete' | 'unknown_customer'
  | 'store_credit_needs_customer' | 'insufficient_store_credit';
export async function finaliseSale(db: Db, ctx: Ctx, saleId: string, now: Date): Promise<{ ok: true; status: 'completed' | 'pending' } | Fail<'not_found'>>; // make_sale
export async function finaliseSaleTx(tx: Tx, tenantId: string, saleId: string, now: Date): Promise<{ status: 'completed' | 'pending'; problems: DeductProblems }>;
export async function listRecentSales(db: Db, ctx: Ctx, opts: { limit?: number }): Promise<Array<{ id: string; receiptNumber: string; totalPesewas: number; status: string; needsReview: boolean; createdAt: Date; cashierName: string }>>; // view_dashboard
// tests/helpers/fixtures.ts
export function saleInput(overrides: Partial<SaleInput> & Pick<SaleInput, 'lines'>): SaleInput; // fresh saleId, 'B1-T1-' + next 6-digit counter, one cash tender = 100 000 unless given, deviceCreatedAt = t0
```

**Flow of `completeSale`** (spec 6.8, 6.9, 6.10):
1. `assertPermission(ctx, 'make_sale')`; zod-parse the input (uuids, 1–200 lines, 0–10 tenders, amounts 1–2 000 000 000, `deviceCreatedAt` ISO with offset, serials 1–64 characters, reference trimmed ≤ 100) → `invalid_input`; `parseQuantity` null or repeated tender ids → `invalid_input`; bad receipt format → `invalid_input`; `ctx.registerId` null → `no_register`.
2. In one `withTenant`: lock the register row (`for update`); missing or retired → `no_register`. A sale with this id → if `pending`, run `finaliseSaleTx`; return `alreadyExisted: true` with its status and change. Receipt prefix ≠ the register's `branchCode-registerCode-` → `wrong_receipt_prefix`. Session user not on the register's branch → `not_assigned`. `cashierId` given and ≠ session user: online → `cashier_not_allowed`; outbox → that user must be active, hold `make_sale`, and be on the branch, else `cashier_not_allowed`. Receipt number used by another sale → `duplicate_receipt_number`; a tender id in `payments` → `duplicate_tender_id`; customer not found → `unknown_customer`.
3. Price list = `choosePriceList(loadPriceRules, { cartListId: null, customerListId: customer?.priceListId ?? null, branchId, today })`. Per line: unit not of that variant or not found → `unknown_item`; product or variant archived → `item_unavailable`; variant or unit not sellable → `not_sellable`; bad quantity → `invalid_quantity`; bundle/recipe without components → `empty_bundle`; `resolvePrice(...) ≠ unitPricePesewas` → `price_changed`; discount > 0 without the cashier's `give_discount` → `discount_not_allowed`; discount > gross → `discount_too_large`; serial item without exactly `base_qty` serials → `serials_required`. Tax rate = `effectiveRateBp` of `chooseTaxRule(taxEnabled, product.taxRuleId, active rules)`, else 0. Lines are priced at the device's `unitPricePesewas` (the price paid).
4. Totals = `calculateCartTotals(lines, { taxMode })`. Tenders: missing reference → `reference_required`; non-cash sum > total → `reduce_non_cash_amount`; store credit without customer → `store_credit_needs_customer`; sum < total → `payment_incomplete`. `changeDue = max(0, sum − total)`.
5. Insert the sale (`pending`, `businessDate(timezone, cutoff, min(deviceCreatedAt, now))`, `receivedAt = now`, `shareCode` = 16 random bytes base64url) with `onConflictDoNothing` on id; nothing inserted → re-read: found → `alreadyExisted: true`, else `sale_id_taken`. Insert lines and payments (`confirmedBy` = session user for non-cash); store credit through `redeemStoreCredit` → false → `insufficient_store_credit`. `registers.receipt_counter = greatest(receipt_counter, counter)`.
6. `finaliseSaleTx`: lock the sale; completed → return; paid (confirmed) < total → `pending`; deduct every line in line order (problems OR-ed), set `completed`, `completedAt = now`, audit `sale_completed` (actor = cashier, record `sale`).
7. Problems: online → `onlyExpired` → `only_expired_stock`, `serialsMissing` → `unknown_serial`, `negative` with `allow_negative_stock` off → `not_enough_stock`.

The errors marked lenient in the Global Constraints, from the outbox, become `review_reasons` (`price_changed`, `item_archived`, `negative_stock`, `only_expired_stock`, `serials_missing`, `underpaid`) instead of refusals, and set `needs_review`. A refusal found after the first insert throws a private `SaleRefused` error inside the transaction so everything rolls back; `completeSale` catches only that class.

- [ ] **Step 1: Write the failing tests** (shop with tax rule 1500 bp default and tax on; `cashier = tillCtxFor(...)`):

```ts
it('completes a cash sale with change and reduces stock once', async () => {
  const r = await completeSale(db, cashier, saleInput({ lines: [line(p, '2', 500)], tenders: [cash(2000)] }), t0);
  expect(r).toEqual({ ok: true, saleId: expect.any(String), status: 'completed', changeDuePesewas: 1000, alreadyExisted: false });
  // stock 10 → 8; sale row: total 1000, tax 130 (inclusive), business_date '2026-10-20'; one sale_completed audit
});
it('a sale sent twice with the same id makes one sale, one receipt, one deduction', async () => {
  const input = saleInput({ lines: [line(p, '1', 500)] });
  await completeSale(db, cashier, input, t0);
  expect(await completeSale(db, cashier, input, t0)).toMatchObject({ ok: true, alreadyExisted: true, status: 'completed' });
  // stock 10 → 9; one sale, one payment
});
it('two identical requests at once make one sale and deduct once', async () => {
  const [x, y] = await Promise.all([completeSale(db, cashier, input, t0), completeSale(db, cashier, input, t0)]);
  expect([x, y].filter((r) => r.ok && r.alreadyExisted)).toHaveLength(1);
});
it('takes split tenders; only cash may go over the total', async () => {
  // total 1000: momo 600 (ref 'MP123') + cash 500 → change 100
  // momo 1200 → reduce_non_cash_amount; momo without reference → reference_required; cash 900 → payment_incomplete
});
it('spends store credit as a tender and never below zero', async () => {
  // customer with 300 credit: store_credit 300 + cash 700 → ok, balance 0; again store_credit 1 → insufficient_store_credit, nothing saved
});
it('refuses a changed price online but keeps the paid price from the outbox and flags it', async () => {
  // current price 500, device sent 450: online → price_changed; outbox → ok, needs_review, review_reasons ['price_changed'], line unitPrice 450, currentPrice 500
});
it('applies the customer price list and quantity breaks', async () => { /* wholesale list on customer: 400; break at 10 → 350 */ });
it('checks the receipt number belongs to this till and is not reused', async () => { /* wrong_receipt_prefix, duplicate_receipt_number; register receipt_counter follows */ });
it('needs give_discount for a discount, never above the line amount', async () => { /* discount_not_allowed for a cashier without it; discount_too_large */ });
it('blocks negative stock when the shop says so, but not from the outbox', async () => { /* not_enough_stock and nothing saved; outbox → ok, needs_review ['negative_stock'] */ });
it('refuses an empty bundle and an archived item online', async () => { /* empty_bundle; item_unavailable; outbox archived → item_archived */ });
it('sells serial items only with their serials', async () => { /* serials_required; unknown_serial; ok marks the serial sold */ });
it('records the offline cashier after checking them', async () => { /* outbox cashierId of an active cashier → cashier_id recorded; inactive → cashier_not_allowed; online other id → cashier_not_allowed */ });
it('an outbox sale made before midnight counts for that day; a future device time counts as now', async () => {
  // deviceCreatedAt 2026-10-19T23:50Z synced at t0 → business_date '2026-10-19'; deviceCreatedAt t0 + 1 day → '2026-10-20'
});
it('an underpaid outbox sale stays pending, does not reduce stock, and is flagged', async () => { /* status 'pending', stock unchanged, review_reasons ['underpaid'] */ });
it("refuses another shop's items, customer, and sale id", async () => {
  // shop B variant → unknown_item; shop B customer → unknown_customer; saleId already used by shop B → sale_id_taken
});
it('finalising twice deducts once', async () => { /* finaliseSale on a completed sale → ok completed; stock unchanged */ });
it('a read-only shop cannot sell', async () => { /* expectAccess(..., 'read_only') */ });
```

- [ ] **Step 2: Run** `npx vitest run tests/server/sales.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/server/sales.ts` per the flow, and `saleInput`.
- [ ] **Step 4: Run** `npx vitest run tests/server` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/server/sales.ts tests/server/sales.test.ts tests/helpers/fixtures.ts
git commit -m "feat(sales): complete and finalise sales exactly once with manual tenders and store credit"
```

---

### Task 7: Sale and counter HTTP routes

**Files:**
- Create: `src/server/till.ts` (register part), `src/server/sales-http.ts`, `src/app/api/[slug]/sales/route.ts`, `src/app/api/[slug]/register/counter/route.ts`
- Test: `tests/server/sales-http.test.ts`

**Interfaces:**
- Consumes: `completeSale` (Task 6); `requireContext`, `AccessError`; `findDeviceRegister`; `SESSION_COOKIE`, `DEVICE_COOKIE`.
- Produces:

```ts
// src/server/till.ts
export type TillRegister = { registerId: string; registerCode: string; branchId: string; branchCode: string; lastCounter: number };
export async function tillRegister(db: Db, ctx: Ctx, deviceToken: string | undefined): Promise<TillRegister | null>; // session register, else the device cookie's register of the same shop
// src/server/sales-http.ts
export async function handleSalePost(db: Db, request: Request, slug: string, now: Date): Promise<Response>;
export async function handleCounterGet(db: Db, request: Request, slug: string, now: Date): Promise<Response>;
```

**Rules:** cookies are read from the request's `Cookie` header. Sale: `requireContext(..., permission: 'make_sale')`; `not_signed_in` or `wrong_shop` → 401, other `AccessError` → 403; content type not `application/json` or body not JSON → 400 `{ ok: false, error: 'invalid_input' }`; `ctx.registerId` replaced by `tillRegister(...)?.registerId`; result `ok` → 200, `invalid_input` → 400, other errors → 409; JSON responses with `Cache-Control: no-store`. Counter: a `pos_device` cookie whose register belongs to the slug's shop is enough; else a session (`permission: null`) and `tillRegister`; no device and no session → 401; signed in but no register → 409 `{ error: 'no_register' }`; body `{ registerCode, lastCounter }`. The route files are one line each: `return handleSalePost(getDb(), request, (await params).slug, new Date())`.

- [ ] **Step 1: Write the failing tests** (build `new Request('http://x/api/shop/sales', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body })`):

```ts
it('completes a sale for a PIN session and returns the contract JSON', async () => {
  const res = await handleSalePost(db, post(pinCookie, input), shop.slug, t0);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, saleId: input.saleId, status: 'completed', changeDuePesewas: 0, alreadyExisted: false });
});
it('a password session sells on the registered device in its cookie', async () => { /* cookie pos_session + pos_device → 200; without pos_device → 409 no_register */ });
it('maps errors to status codes', async () => {
  // no cookie → 401; shop A cookie at shop B → 401; a user whose make_sale was removed → 403; 'not json' → 400; price_changed → 409
});
it('returns the register counter by device cookie alone', async () => {
  // after a sale B1-T1-000041 → GET with only pos_device → 200 { registerCode: 'T1', lastCounter: 41 }; device of another shop → 401
});
```

- [ ] **Step 2: Run** `npx vitest run tests/server/sales-http.test.ts` → FAIL.
- [ ] **Step 3: Implement** `tillRegister`, the two handlers, and the two route files.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/server/till.ts src/server/sales-http.ts src/app/api tests/server/sales-http.test.ts
git commit -m "feat(api): add the sale and receipt counter routes for tills and the offline outbox"
```

---

### Task 8: Receipts

**Files:**
- Create: `src/server/receipts.ts`, `src/components/receipt-view.tsx`, `src/components/print-button.tsx`, `src/app/[slug]/app/receipts/[saleId]/page.tsx`, `src/app/[slug]/r/[code]/page.tsx`
- Test: `tests/server/receipts.test.ts`

**Interfaces:**
- Produces:

```ts
export type ReceiptView = {
  shopName: string; branchName: string; branchAddress: string | null; branchPhone: string | null; taxNumber: string | null; footer: string | null;
  receiptNumber: string; createdAt: Date; timezone: string; cashierName: string; customerName: string | null; customerPhone: string | null;
  status: 'pending' | 'completed'; taxMode: 'inclusive' | 'exclusive';
  lines: Array<{ name: string; unitName: string; quantity: string; unitPricePesewas: number; discountPesewas: number; taxPesewas: number; totalPesewas: number; serials: string[] }>;
  subtotalPesewas: number; discountPesewas: number; taxPesewas: number; totalPesewas: number;
  payments: Array<{ method: TenderMethod; amountPesewas: number; reference: string | null }>; changeDuePesewas: number; shareCode: string;
};
export async function getReceipt(db: Db, ctx: Ctx, saleId: string, opts: { reprint: boolean }): Promise<ReceiptView | null>; // any member; reprint → receipt_reprinted audit
export async function getPublicReceipt(db: Db, slug: string, code: string): Promise<ReceiptView | null>; // no sign-in; references, customer name and phone removed
export const TENDER_LABELS: Record<TenderMethod, string>; // Cash, Mobile money, Card, Bank transfer, Store credit
```

Pages: the staff page reads `?w=58|80` (default 80) and `?reprint=1`, sets the receipt width to `58mm` or `80mm`, adds `@page { size: <w>mm auto; margin: 0 }`, and shows (hidden when printing) Print, 58 mm / 80 mm links, "Share on WhatsApp" (`whatsappShareUrl(receiptShareText(...), customerPhone)`), and the copyable public link `${APP_URL}/${slug}/r/${shareCode}`. The public page renders the same `ReceiptView` without buttons and returns `notFound()` when the code is unknown. Times show in the shop timezone. Inclusive shops print "Prices include tax"; tax lines show the total tax.

- [ ] **Step 1: Write the failing tests**

```ts
it('shows a receipt with lines, tax, payments, and change', async () => { /* after a sale: getReceipt fields match; cashierName; payments method momo_manual with reference */ });
it('logs a reprint', async () => { /* getReceipt(..., { reprint: true }) → one receipt_reprinted audit row; reprint false → none */ });
it('shares a receipt by code without references or customer details', async () => {
  // getPublicReceipt(db, shop.slug, shareCode) → payments[0].reference null, customerName null, customerPhone null
  // wrong code, or the right code at another shop's slug → null
});
it("does not show another shop's receipt", async () => { /* getReceipt with shop B ctx → null */ });
```

- [ ] **Step 2: Run** `npx vitest run tests/server/receipts.test.ts` → FAIL.
- [ ] **Step 3: Implement** the service and the pages (`receipt-view.tsx` is a server component; `print-button.tsx` is a client button calling `window.print()`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/server/receipts.ts src/components src/app tests/server/receipts.test.ts
git commit -m "feat(receipts): add 58/80 mm print view, shareable link, and WhatsApp share"
```

---

### Task 9: Basic dashboard

**Files:**
- Create: `src/server/dashboard.ts`, `src/app/[slug]/app/dashboard/page.tsx`, `src/app/[slug]/app/sales/page.tsx`
- Modify: `src/app/[slug]/app/page.tsx` (links)
- Test: `tests/server/dashboard.test.ts`

**Interfaces:**
- Produces:

```ts
export type Dashboard = {
  businessDate: string; salesCount: number; grossPesewas: number; discountPesewas: number; netPesewas: number; taxPesewas: number;
  totalPesewas: number; averagePesewas: number; payments: Array<{ method: TenderMethod; amountPesewas: number }>;
  lowStock: Array<{ variantId: string; name: string; branchName: string; onHand: string; reorderLevel: string }>;
  negativeStock: Array<{ variantId: string; name: string; branchName: string; onHand: string }>;
  needsReview: number;
};
export async function getDashboard(db: Db, ctx: Ctx, now: Date): Promise<Dashboard>; // view_dashboard
```

**Rules:** today = `businessDate(timezone, cutoff, now)`; completed sales of that business date only; `net = gross − discount`; `average = round_half_up(total / count)` (0 with no sales); payments summed by method in the order cash, momo_manual, card_terminal, bank_transfer, store_credit, cash minus the day's change given; methods with no money left out; low stock = `0 ≤ on_hand ≤ reorder_level` (reorder level set), negative = `on_hand < 0`, each at most 50, by name; `needsReview` = all sales with `needs_review`. Home links added: Sell (`make_sale`), Dashboard and Sales (`view_dashboard`), Receive stock (`receive_stock`), Customers (`make_sale`).

- [ ] **Step 1: Write the failing tests**

```ts
it("counts only today's completed sales", async () => {
  // two sales today (1000 cash with 200 change; 1500 momo), one underpaid outbox sale (pending), one with deviceCreatedAt yesterday
  expect(d).toMatchObject({ salesCount: 2, totalPesewas: 2500, averagePesewas: 1250, needsReview: 1 });
  expect(d.payments).toEqual([{ method: 'cash', amountPesewas: 1000 }, { method: 'momo_manual', amountPesewas: 1500 }]);
});
it('lists low and negative stock', async () => { /* reorder level 5, on hand 3 → lowStock; sold past zero → negativeStock '-1.000' */ });
it('needs view_dashboard', async () => { await expectAccess(getDashboard(db, cashier, t0), 'forbidden'); });
```

- [ ] **Step 2: Run** `npx vitest run tests/server/dashboard.test.ts` → FAIL.
- [ ] **Step 3: Implement** the service and the two pages (the sales list links to `receipts/<id>?reprint=1`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/server/dashboard.ts src/app tests/server/dashboard.test.ts
git commit -m "feat(dashboard): add sales today, payment breakdown, and low and negative stock"
```

---

### Task 10: Back-office pages for stock, customers, and sales settings

**Files:**
- Create: `src/app/[slug]/app/stock/receive/page.tsx`, `src/app/[slug]/app/stock/receive/actions.ts`, `src/app/[slug]/app/customers/page.tsx`, `src/app/[slug]/app/customers/actions.ts`
- Modify: `src/server/shop-settings.ts`, `src/app/[slug]/app/settings/page.tsx`, `src/app/[slug]/app/settings/actions.ts`
- Test: `tests/server/shop-settings.test.ts` (+)

**Interfaces:**
- Produces:

```ts
export type SalesSettings = { allowNegativeStock: boolean; taxNumber: string | null; receiptFooter: string | null };
export async function getSalesSettings(db: Db, ctx: Ctx): Promise<SalesSettings>; // any member
export async function saveSalesSettings(db: Db, ctx: Ctx, input: SalesSettings): Promise<{ ok: true } | { ok: false; error: 'invalid_input' }>; // manage_shop_settings; tax number ≤ 30, footer ≤ 300 characters; trimmed, blank → null; audit sales_settings_saved
```

Pages: **Receive stock** — branch, kind (Received / Opening stock), supplier name, then one line: item code (barcode or SKU, found with `lookupStockItem`), quantity, total cost in GHS (`parseCedis`), batch number and expiry (for batch items), serials (one per line, for serial items); success shows "Received. On hand now: X". **Customers** — search, add (name, phone, price list), and for `approve_actions` holders a "Give store credit" form per customer (amount, refund or goodwill, reason). **Settings** — a "Sales and receipts" section with the three fields.

- [ ] **Step 1: Write the failing test**

```ts
it('saves the sales settings and audits them', async () => {
  expect(await saveSalesSettings(db, owner, { allowNegativeStock: false, taxNumber: ' C0001234567 ', receiptFooter: 'No returns after 7 days.' })).toEqual({ ok: true });
  expect(await getSalesSettings(db, owner)).toEqual({ allowNegativeStock: false, taxNumber: 'C0001234567', receiptFooter: 'No returns after 7 days.' });
  await expectAccess(saveSalesSettings(db, manager, { allowNegativeStock: true, taxNumber: null, receiptFooter: null }), 'forbidden');
});
```

- [ ] **Step 2: Run** `npx vitest run tests/server/shop-settings.test.ts` → FAIL.
- [ ] **Step 3: Implement** the service and the three pages with their server actions.
- [ ] **Step 4: Run** `npx vitest run` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/server/shop-settings.ts src/app tests/server/shop-settings.test.ts
git commit -m "feat(shop): add stock receiving, customers, and sales settings pages"
```

---

### Task 11: Online sell screen with camera scanning

**Files:**
- Create: `src/app/[slug]/app/sell/page.tsx`, `src/app/[slug]/app/sell/actions.ts`, `src/components/till/sell-screen.tsx`, `src/components/till/camera-scanner.tsx`
- Modify: `src/server/till.ts` (item lookup), `package.json` (`@zxing/browser`, `@zxing/library`)
- Test: `tests/server/till.test.ts`

**Interfaces:**
- Consumes: `parseScannedCode`, `searchCatalogue`, `loadPriceRules`, `choosePriceList`, `resolvePrice`, `chooseTaxRule`, `effectiveRateBp`, `calculateCartTotals`, `formatReceiptNumber`, `listCustomers`, `tillRegister`.
- Produces:

```ts
export type TillItem = {
  variantId: string; unitId: string; name: string; unitName: string; quantity: string; unitPricePesewas: number; taxRateBp: number;
  tracking: Tracking; fractions: boolean; available: boolean;
};
export async function lookupTillItem(db: Db, ctx: Ctx, input: { code: string; branchId: string; customerId: string | null }, now: Date): Promise<TillItem | null>; // make_sale
export async function tillItemForVariant(db: Db, ctx: Ctx, input: { variantId: string; unitId?: string; quantity: string; branchId: string; customerId: string | null }, now: Date): Promise<TillItem | null>; // make_sale; also re-prices a quantity change
```

Sell screen (client): a code field that keeps focus (a scanner types the code and Enter); text that finds nothing as a code runs a catalogue search and lists hits to tap; the camera button opens `CameraScanner`, which uses `BarcodeDetector` when the browser has it, else `@zxing/browser` loaded with `import()`, and calls `onCode` once then stops the camera. Scanning the same variant and unit again adds 1 (not for scale labels). Each line shows quantity (editable; re-priced through `tillItemForVariant`), discount (only with `give_discount`), and amount; totals come from `calculateCartTotals`. Optional customer by phone. Tenders: cash received, MoMo / card / bank with reference, store credit when a customer is chosen; change due shown. **Complete** builds the contract body (saleId from `crypto.randomUUID()` kept until success; receipt number `formatReceiptNumber(branchCode, registerCode, next)` where `next = max(localStorage['receipt-counter:<registerId>'], lastCounter) + 1`; on `duplicate_receipt_number` move past it and retry once) and `fetch`es `POST /api/<slug>/sales`. Success shows the change and links: Print 80 mm, Print 58 mm, Share on WhatsApp, New sale. The page shows "This device is not a till. Sign in with your PIN on a registered till." when `tillRegister` is null.

- [ ] **Step 1: Write the failing tests**

```ts
it('finds a scanned barcode with its unit price and tax rate', async () => { /* carton barcode → unit carton, price 10000, taxRateBp 1500 */ });
it('finds a scale label with its weight', async () => { /* weight label 1.250 kg */ });
it('prices a quantity break and the customer price list', async () => { /* tillItemForVariant quantity '10' → break price */ });
it('returns null for an unknown code', async () => { expect(await lookupTillItem(db, cashier, { code: '999', branchId, customerId: null }, t0)).toBeNull(); });
```

- [ ] **Step 2: Run** `npx vitest run tests/server/till.test.ts` → FAIL.
- [ ] **Step 3: Implement** the lookups, `npm install @zxing/browser @zxing/library`, the page, actions, and both components.
- [ ] **Step 4: Run** `npx vitest run` and `npm run build` → both pass.
- [ ] **Step 5: Browser check** with preview `multishop-pos-selling-dev` (port 3003): seed a shop (owner, a product with stock, a registered device), sign in, open Sell, scan or type a barcode, take cash with change, complete, open the 80 mm receipt and the public link, then check the dashboard shows the sale and stock went down by one. Screenshot the receipt and the dashboard.
- [ ] **Step 6: Commit**

```bash
git add src package.json package-lock.json tests/server/till.test.ts
git commit -m "feat(till): add the online sell screen with scanner, camera, and search"
```
