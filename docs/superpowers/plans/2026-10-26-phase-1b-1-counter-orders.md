# Phase 1b · Food Plan 1 of 3: Service Modes, Order Numbers, Ready Board, Sold Out, Pack Fee, Packing Check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A food branch sells in Counter mode (pay first, get an order number, collect when the Ready board shows it) or Quick serve mode (pay first, no kitchen step), online and offline. Staff mark items sold out for the day, takeaway and delivery orders get the pack fee automatically, a kitchen screen marks orders ready, and takeaway or delivery orders cannot be handed over until every line is ticked on the packing check.

**Architecture:** One new schema file `src/db/schema/food.ts` holds food settings, per-day order counters, sold-out flags, kitchen orders, and packing ticks. `SaleInput` gains an optional `food` block. `completeSale` checks sold-out items and the pack line, then creates the kitchen order and its number in the same transaction as the sale, so a sale and its order are saved together or not at all. Pure rules (order number format, pack count, whether an order needs packing) live in `src/lib/food.ts` and are shared with the device. The till stays local-first: online it shows the number the server gives; offline (or when the outcome of an online send is unknown) it gives a register-prefixed number such as `T2-047` from a local per-day counter, and that printed number is what the server keeps. The kitchen screen and the Ready board are online pages, as the spec allows (4.24 "Offline").

**Tech Stack:** As Phase 1a (Next.js 16 App Router, TypeScript, Drizzle + drizzle-kit, PGlite in tests and local dev, postgres.js on Neon, zod 4, Vitest, `idb` on the device).

**Spec:** `docs/superpowers/specs/2026-10-20-multishop-pos-design.md` (v4). Sections 4.24, 4.14, 10.1, 10.3; pseudocode 6.51, 6.55, 6.56, 6.58 and the parts of 6.37 that 6.51 calls; records in section 7 (Branch, Variant, Kitchen Order, Packing Record, Sold Out, Sale); acceptance tests in section 13 (order numbers, sold out, pack fee, packing check).

## Phase 1b food roadmap

The brief's food items 1–9 and the basic item-14 reports are split into three plans, each ending in working, tested software. Plan 2 and Plan 3 build on this plan's tables and `food` block.

| Plan | File | Brief items | Spec |
| --- | --- | --- | --- |
| 1b-1 (this) | `2026-10-26-phase-1b-1-counter-orders.md` | 1 service modes, 2 order numbers and Ready board, 5 sold out, 6 pack fee, 9 packing check | 6.51, 6.55, 6.56, 6.58 |
| 1b-2 | `2026-10-26-phase-1b-2-menu-and-pots.md` | 3 combos, 4 sell by amount and pot tracking (+ wastage entries the reports need) | 6.52, 6.53, 6.54 |
| 1b-3 | `2026-10-26-phase-1b-3-channels-and-reports.md` | 7 delivery-app orders, 8 phone orders, 14 basic food reports | 6.57, 6.59 |

The spec does not number its food features; the brief's 1–9 map to the bullets of 4.24 and to 6.51–6.58 in the order above, and "item 14" is 6.59 (Basic Food Reports). Migrations: this plan `0010` + `0011`, Plan 2 `0012` + `0013`, Plan 3 `0014` + `0015`. Run the plans in order; whichever branch merges second regenerates its migrations, as in Phase 1a.

## Not in this plan

- **Table mode.** `branches.service_modes` accepts `'table'`, but the till offers it only once open tickets, tables, and split bills exist (6.37, 6.38). Those are Phase 1b spec features outside this brief; Table mode needs its own plan.
- **The local print helper and per-station kitchen routing** (4.10, 6.37). Here the till prints a kitchen slip with the browser's print dialog right after the receipt, which also works offline. A kitchen display per station, cancel slips, and voiding sent items come with the tickets plan.
- **"Order ready" SMS** (6.51). SMS sending arrives in Phase 2; the kitchen order stores nothing extra for it now.
- **Storefront.** It does not exist yet (Phase 2). `isSoldOut` is exported for it, and the storefront plan must filter on it.
- **Dining options that change price or tax** (4.24). The dining option only drives the pack fee and the packing check here.
- **Counter orders that wait for payment** (6.39) and their expiry job. Counter mode here is pay first.
- **Add-ons and notes per item.** The packing list shows item, quantity, and the pack line only.

## Global Constraints

Phase 1a Global Constraints still apply (Plans 1–4). The ones these plans lean on most, restated:

- Money is whole pesewas in integers; never floating point. Rounding is half up.
- `tenant_id` comes from the session (`ctx.tenantId`), never from the URL or body. Shop data only through `withTenant()`; `asPlatform()` only to turn a public slug into a tenant id (receipts, and now the Ready board).
- Every new table has `tenant_id`, the `tenant_isolation` RLS policy keyed on `app.tenant_id`, and composite `(tenant_id, x_id) → x(tenant_id, id)` foreign keys. `tests/db/rls.test.ts` checks every public table.
- **Migration order:** in every new SQL file, a foreign key must come after the unique constraint it references. Check the generated SQL before committing; move `ADD CONSTRAINT … FOREIGN KEY` statements below the `UNIQUE` they need.
- Services take `now: Date` last, return `{ ok: true, … } | Fail<E>`, throw only `AccessError` or programming errors, and call `assertPermission(ctx, p)` first. Files in `src/server/` and `src/db/` start with `import 'server-only';`; `src/lib/` and `src/device/` never import server code.
- PIN sessions carry only `TILL_PERMISSIONS`.
- Business date: `businessDate(timezone, cutoff, at)`; for a sale `at = min(deviceCreatedAt, now)` (Phase 1a Plan 3).
- Outbox leniency (6.10): with `fromOfflineOutbox: true`, a refusal that only reflects stale device data becomes a `review_reasons` entry instead.

New for the food plans:

- **Food features are on when the shop has the `kitchen` module** (`tenants.modules`, already a food default). With it off, a `food` block on a sale is refused with `invalid_input` and the till shows no food controls.
- **Service modes:** `'counter' | 'table' | 'quick'`, stored per branch in `branches.service_modes` (a branch can use several). A sale's `food.serviceMode` must be one of its branch's modes and not `'table'` (until the tickets plan).
- **Dining options:** `'eat_in' | 'takeaway' | 'delivery'`. Quick serve is always `'eat_in'`.
- **Order numbers** (6.51): online, one counter per branch per business date, shown as `String(((n - 1) % 999) + 1).padStart(3, '0')` (`001`–`999`). Offline, `<registerCode>-<3 digits>` from the device's own per-business-date counter, e.g. `T2-047`. Pattern: `^(?:[A-Z0-9]{1,6}-)?\d{3}$`. Only Counter-mode sales get one.
- **The printed number wins:** when a repeat of a sale carries a device number different from the stored one, the stored sale and kitchen order take the device's number.
- **Ready board** shows numbers only: never names, phones, or items. A ready number stays 10 minutes after `ready_at` or until collected.
- **Sold out** is keyed by `(branch, variant, business date)`, so it clears itself when the business date changes. Permission `mark_sold_out` (cashier, manager, owner).
- **Pack fee** (6.56): the shop picks one variant as its pack (`food_settings.pack_variant_id`), so the pack's price, tax rule, and container stock come from the catalogue. Mode `'per_order'` (1 pack) or `'per_item'` (units of `needs_pack` items, rounded up to whole packs). It applies when the dining option is `'takeaway'` or `'delivery'`; never to `'eat_in'`.
- **Packing check** (6.58): needed when the dining option is not `'eat_in'` (Plan 3 adds every channel order). Hand-over needs every line ticked. Permission `run_kitchen` (cashier, manager, owner) for ready, packing, and hand-over.
- New audit actions: `food_settings_saved`, `service_modes_saved`, `board_link_created`, `sold_out`, `sold_out_cleared`, `order_ready`, `order_handed_over`, `order_collected`, `order_number_changed`.

## Review Focus

1. **Two tills offline in one branch at the same time** must never print the same order number. → Task 2 `offline numbers carry the register code`; Task 8 `two device stores give different numbers on the same day`.
2. **A sale whose online send times out after the server saved it** gets a device number printed; the board must then show the printed number. → Task 5 `a repeat with a device order number replaces the stored one`.
3. **A sold-out flag set yesterday** must not block today's sale, on the server or on a till whose cache is a day old. → Task 4 `sold out clears on the next business day`; Task 8 `ignores a sold-out list from another business date`.
4. **A cart switched from takeaway to eat-in after the pack line was added** must lose the pack line; a tampered pack quantity is refused online. → Task 8 `switching to eat in removes the pack line`; Task 5 `refuses a takeaway sale with the wrong pack quantity`.
5. **A staff member at branch A** must not see or change branch B's kitchen orders or board. → Task 6 `refuses orders of a branch the user is not assigned to`; Task 7 `a board link shows only its own branch`.

## File Structure

```text
src/lib/permissions.ts          + mark_sold_out, run_kitchen (cashier preset, TILL_PERMISSIONS)
src/lib/permission-labels.ts    + labels
src/lib/food.ts                 ServiceMode, DiningOption, order numbers, packCount, needsPacking (shared with the device)
src/db/schema/food.ts           foodSettings, branchOrderCounters, soldOut, kitchenOrders, packingTicks
src/db/schema/tenancy.ts        + branches.service_modes, branches.board_token_hash
src/db/schema/catalogue.ts      + variants.needs_pack
src/db/schema/selling.ts        + sales.service_mode, dining_option, order_number
drizzle/0010_*.sql (generated), drizzle/0011_food_counter_rls.sql (custom: RLS, cache triggers, permissions backfill)
src/server/food-settings.ts     getFoodSettings, saveFoodSettings, setServiceModes, foodEnabled
src/server/sold-out.ts          markSoldOut, markAvailable, listSoldOut, isSoldOut
src/server/sales.ts             + food block, orderNumber in the result
src/server/kitchen.ts           listKitchenOrders, markOrderReady, tickPackedLine, handOverOrder
src/server/ready-board.ts       createBoardLink, readReadyBoard, handleBoardGet
src/server/device-cache.ts      + food section, variants.needsPack, shop.businessDayCutoff
src/lib/device-contract.ts      + SaleRequest.food, SaleResponse.orderNumber, DeviceCache.food
src/device/store.ts             + takeOrderNumber
src/device/catalogue.ts         + sold-out check, withPackLine
src/device/sale.ts              + buildSaleRequest food
src/app/[slug]/till/sell/{use-device.ts,sell-screen.tsx}   mode, dining option, number, kitchen slip, sold-out tap
src/app/[slug]/till/actions.ts  + markSoldOutAction, markAvailableAction
src/app/[slug]/app/kitchen/{page.tsx,actions.ts}           kitchen screen and packing
src/app/[slug]/app/settings/food/{page.tsx,actions.ts}     food settings, service modes, board link
src/app/[slug]/board/[token]/page.tsx, src/app/api/[slug]/board/[token]/route.ts
tests/lib/food.test.ts, tests/db/food-schema.test.ts
tests/server/{food-settings,sold-out,food-sales,kitchen,ready-board}.test.ts
tests/server/device-cache.test.ts (+), tests/device/{catalogue,device}.test.ts (+)
```

---

### Task 1: Food permissions, schema, and row-level security

**Files:**
- Create: `src/db/schema/food.ts`, `drizzle/0010_*.sql` (generated), `drizzle/0011_food_counter_rls.sql` (custom)
- Modify: `src/lib/permissions.ts`, `src/lib/permission-labels.ts`, `src/db/schema/{index,tenancy,catalogue,selling}.ts`
- Test: `tests/db/food-schema.test.ts`, `tests/lib/permissions.test.ts`

**Interfaces:**
- Produces:
  - `PERMISSIONS` + `'mark_sold_out'`, `'run_kitchen'`; both in `ROLE_PRESETS.cashier` and in `TILL_PERMISSIONS`. Labels: `'Mark items sold out'`, `'Run the kitchen screen and packing check'`.
  - `branches` + `serviceModes text[] not null default '{}'` with check `service_modes <@ array['counter','table','quick']::text[]`, `boardTokenHash text unique` (sha256 hex of the board token).
  - `variants` + `needsPack boolean not null default false`.
  - `sales` + `serviceMode text` (check in `('counter','quick')`), `diningOption text` (check in `('eat_in','takeaway','delivery')`), `orderNumber text`.
  - `foodSettings`: `tenantId uuid primary key → tenants`, `packVariantId uuid` (composite FK to variants), `packFeeMode text not null default 'per_order'` (check `in ('per_item','per_order')`), `updatedAt`.
  - `branchOrderCounters`: `tenantId, branchId, businessDate (date string), last integer not null default 0`; primary key `(tenant_id, branch_id, business_date)`; FK to branches.
  - `soldOut`: `tenantId, branchId, variantId, businessDate, setBy uuid (users), setAt timestamptz not null`; primary key `(tenant_id, branch_id, variant_id, business_date)`; composite FKs to branches, variants, users.
  - `kitchenOrders`: `id uuid default, tenantId, branchId, saleId uuid (nullable; Plan 3 adds unpaid phone orders), orderNumber text not null, businessDate, diningOption, status text not null default 'preparing'` (check `in ('preparing','ready','collected','handed_over','cancelled')`), `needsPacking boolean not null, sentAt timestamptz not null, readyAt, closedAt, closedBy uuid, handedTo text`; unique `(tenant_id, id)` and `(tenant_id, sale_id)`; index `(tenant_id, branch_id, business_date, status)`; composite FKs to branches and sales.
  - `packingTicks`: `tenantId, kitchenOrderId, lineNo integer, packedBy uuid, packedAt`; primary key `(kitchen_order_id, line_no)`; composite FK to kitchen orders. Keyed by line number so Plan 3's unpaid phone orders (no sale lines yet) use the same table.
  - Type exported from the food schema: `KitchenOrderStatus`.
- `0011_food_counter_rls.sql`: `tenant_isolation` policy on the five new tables; `device_cache_version` triggers (function from `0007`) on `food_settings` and `sold_out` (insert, update, delete); replace the `branches` update trigger's `WHEN` with `(OLD.name, OLD.branch_code, OLD.service_modes) IS DISTINCT FROM (NEW.name, NEW.branch_code, NEW.service_modes)`; backfill permissions: `UPDATE users SET permissions = permissions || array['mark_sold_out','run_kitchen'] WHERE NOT ('run_kitchen' = ANY(permissions));` (every preset gets both).

- [ ] **Step 1: Write the failing tests** in `tests/db/food-schema.test.ts` (shops `a`, `b` from `seedShop`; inserts with `asPlatform`; `dbError` from `tests/helpers/test-db.ts`; small local insert helpers):

```ts
it('refuses a service mode that does not exist', async () => {
  expect(await dbError(asPlatform(db, (tx) => tx.update(branches).set({ serviceModes: ['counter', 'drive_thru'] })))).toMatch(/branches_service_modes/);
});
it('one sold-out row per branch, item, and day', async () => {
  await insertSoldOut(a, variantA, '2026-10-26');
  expect(await dbError(insertSoldOut(a, variantA, '2026-10-26'))).toMatch(/sold_out_pk|duplicate key/);
  await expect(insertSoldOut(a, variantA, '2026-10-27')).resolves.toBeDefined();
});
it("a kitchen order cannot point at another shop's sale", async () => {
  expect(await dbError(insertKitchenOrder(a, { saleId: saleOfB }))).toMatch(/foreign key/);
});
it('a sale has at most one kitchen order', async () => {
  await insertKitchenOrder(a, { saleId: saleA });
  expect(await dbError(insertKitchenOrder(a, { saleId: saleA }))).toMatch(/kitchen_orders_sale/);
});
it('marking an item sold out bumps the device cache version', async () => {
  const before = await cacheVersion(a.tenantId);
  await insertSoldOut(a, variantA, '2026-10-26');
  expect(await cacheVersion(a.tenantId)).toBeGreaterThan(before);
});
```

and in `tests/lib/permissions.test.ts`: `it('a cashier PIN can mark sold out and run the kitchen', …)` asserting both are in `ROLE_PRESETS.cashier` and `TILL_PERMISSIONS`.

- [ ] **Step 2: Run** `npx vitest run tests/db tests/lib/permissions.test.ts` → FAIL (tables and permissions missing).
- [ ] **Step 3: Write the schema and permissions**, then `npx drizzle-kit generate --name food_counter` and `npx drizzle-kit generate --custom --name food_counter_rls`; fill the custom file as above. Check the generated SQL's statement order (foreign keys after the unique constraints they reference).
- [ ] **Step 4: Run** `npx vitest run tests/db tests/lib` → PASS, including `rls.test.ts`.
- [ ] **Step 5: Commit**

```bash
git add src/lib/permissions.ts src/lib/permission-labels.ts src/db drizzle tests/db tests/lib/permissions.test.ts
git commit -m "feat(db): add food settings, order counters, sold-out flags, kitchen orders, and packing ticks"
```

---

### Task 2: Pure food rules shared with the device

**Files:**
- Create: `src/lib/food.ts`
- Test: `tests/lib/food.test.ts`

**Interfaces:**
- Produces:

```ts
export type ServiceMode = 'counter' | 'table' | 'quick';
export type DiningOption = 'eat_in' | 'takeaway' | 'delivery';
export const SERVICE_MODES: readonly ServiceMode[];
export const DINING_OPTIONS: readonly DiningOption[];
export const ORDER_NUMBER: RegExp;                                   // /^(?:[A-Z0-9]{1,6}-)?\d{3}$/
export function formatOrderNumber(counter: number): string;          // 1 → '001', 999 → '999', 1000 → '001'
export function offlineOrderNumber(registerCode: string, counter: number): string; // ('T2', 47) → 'T2-047'
export function packCount(
  lines: Array<{ variantId: string; quantity: string }>,
  opts: { diningOption: DiningOption; mode: 'per_item' | 'per_order'; needsPack: (variantId: string) => boolean; packVariantId: string | null },
): number;                                                           // 0 when no pack is due
export function needsPacking(diningOption: DiningOption): boolean;   // Plan 3 adds a channel argument
```

`packCount` ignores lines whose variant is the pack itself; `'per_item'` sums quantities of `needsPack` lines and rounds up to a whole number (`1.500` → 2); `'per_order'` gives 1 when any other line remains; `'eat_in'` or a null `packVariantId` gives 0.

- [ ] **Step 1: Write the failing tests**

```ts
it('order numbers run 001 to 999 and wrap', () => {
  expect([1, 47, 999, 1000, 1998].map(formatOrderNumber)).toEqual(['001', '047', '999', '001', '999']);
});
it('offline numbers carry the register code', () => {
  expect(offlineOrderNumber('T2', 47)).toBe('T2-047');
  expect(ORDER_NUMBER.test('T2-047') && ORDER_NUMBER.test('047')).toBe(true);
  expect(ORDER_NUMBER.test('47') || ORDER_NUMBER.test('t2-047')).toBe(false);
});
it('counts packs per order and per item, never for eat in', () => {
  const lines = [{ variantId: 'rice', quantity: '2.000' }, { variantId: 'coke', quantity: '1.000' }, { variantId: 'pack', quantity: '1.000' }];
  const opts = { needsPack: (id: string) => id === 'rice', packVariantId: 'pack' };
  expect(packCount(lines, { ...opts, diningOption: 'takeaway', mode: 'per_order' })).toBe(1);
  expect(packCount(lines, { ...opts, diningOption: 'delivery', mode: 'per_item' })).toBe(2);
  expect(packCount(lines, { ...opts, diningOption: 'eat_in', mode: 'per_item' })).toBe(0);
  expect(packCount(lines, { ...opts, packVariantId: null, diningOption: 'takeaway', mode: 'per_order' })).toBe(0);
});
it('rounds part units up to whole packs', () => {
  expect(packCount([{ variantId: 'rice', quantity: '1.500' }], { needsPack: () => true, packVariantId: 'pack', diningOption: 'takeaway', mode: 'per_item' })).toBe(2);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/lib/food.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** in `src/lib/food.ts`, quantities through `toMilli` from `src/lib/decimal.ts` (no floating point).
- [ ] **Step 4: Run** `npx vitest run tests/lib/food.test.ts` → PASS.
- [ ] **Step 5: Commit** `git add src/lib/food.ts tests/lib/food.test.ts && git commit -m "feat(food): add order number and pack fee rules"`

---

### Task 3: Food settings and service modes

**Files:**
- Create: `src/server/food-settings.ts`
- Test: `tests/server/food-settings.test.ts`

**Interfaces:**
- Consumes: Task 1 tables; `ServiceMode` from Task 2.
- Produces:

```ts
export type FoodSettings = { packVariantId: string | null; packFeeMode: 'per_item' | 'per_order' };
export async function getFoodSettings(db: Db, ctx: Ctx): Promise<FoodSettings>;           // defaults when no row
export async function saveFoodSettings(db: Db, ctx: Ctx, input: FoodSettings): Promise<{ ok: true } | Fail<'invalid_input' | 'unknown_item' | 'module_off'>>;
export async function setServiceModes(db: Db, ctx: Ctx, branchId: string, modes: ServiceMode[]): Promise<{ ok: true } | Fail<'invalid_input' | 'unknown_branch' | 'module_off'>>;
export async function foodEnabled(tx: Tx): Promise<boolean>;                               // tenants.modules includes 'kitchen'
```

Both writers need `manage_shop_settings`, upsert, and write an audit row. The pack variant must be an active, sellable `standard` variant. Modes are de-duplicated; an empty list is allowed (the branch sells without food controls).

- [ ] **Step 1: Write the failing tests:** `saves the pack variant and fee mode`, `refuses a pack that is another shop's or archived` (`unknown_item`), `refuses food settings when the kitchen module is off` (`module_off`), `saves service modes for a branch and refuses unknown modes`, `a cashier cannot change food settings` (`expectAccess(…, 'forbidden')`).
- [ ] **Step 2: Run** `npx vitest run tests/server/food-settings.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/server/food-settings.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/server/food-settings.ts tests/server/food-settings.test.ts && git commit -m "feat(food): add food settings and per-branch service modes"`

---

### Task 4: Sold-out switch

**Files:**
- Create: `src/server/sold-out.ts`
- Test: `tests/server/sold-out.test.ts`

**Interfaces:**
- Produces:

```ts
export async function markSoldOut(db: Db, ctx: Ctx, input: { branchId: string; variantId: string }, now: Date): Promise<{ ok: true } | Fail<'invalid_input' | 'unknown_item' | 'not_assigned'>>;
export async function markAvailable(db: Db, ctx: Ctx, input: { branchId: string; variantId: string }, now: Date): Promise<{ ok: true } | Fail<'invalid_input' | 'not_assigned'>>;
export async function listSoldOut(db: Db, ctx: Ctx, branchId: string, now: Date): Promise<Array<{ variantId: string; name: string; setAt: Date }>>;
export async function isSoldOut(tx: Tx, branchId: string, variantIds: string[], businessDate: string): Promise<Set<string>>; // for completeSale, the cache, and the storefront
```

`mark*` need `mark_sold_out` and the user assigned to the branch; the business date is today's (`businessDate(shop.timezone, shop.cutoff, now)`). Marking twice is a no-op (`onConflictDoNothing`). Audit `sold_out` / `sold_out_cleared`.

- [ ] **Step 1: Write the failing tests:**

```ts
it('a cashier PIN marks an item sold out for today only', async () => {
  const till = await tillCtxFor(db, shop, 'cashier', at('2026-10-26T12:00:00Z'));
  expect(await markSoldOut(db, till, { branchId, variantId }, at('2026-10-26T12:00:00Z'))).toEqual({ ok: true });
  expect((await listSoldOut(db, till, branchId, at('2026-10-26T18:00:00Z'))).map((r) => r.variantId)).toEqual([variantId]);
});
it('sold out clears on the next business day', async () => {
  // marked 2026-10-26T12:00Z; listSoldOut at 2026-10-27T08:00Z → []
});
it('respects the business-day cutoff', async () => {
  // cutoff '03:00', Africa/Accra; marked 2026-10-27T01:00Z (still the 26th) → listed at 2026-10-27T02:30Z, gone at 2026-10-27T03:30Z
});
it('refuses a branch the user is not assigned to', async () => { /* → not_assigned */ });
it('marking twice keeps one row; available again removes it', async () => { /* … */ });
```

- [ ] **Step 2: Run** `npx vitest run tests/server/sold-out.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/server/sold-out.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/server/sold-out.ts tests/server/sold-out.test.ts && git commit -m "feat(food): add the sold-out switch"`

---

### Task 5: Food block on a sale: order numbers, kitchen orders, sold out, pack fee

**Files:**
- Modify: `src/server/sales.ts`, `src/lib/device-contract.ts` (types only), `tests/helpers/fixtures.ts`, `tests/server/sales.test.ts`
- Test: `tests/server/food-sales.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 (`formatOrderNumber`, `ORDER_NUMBER`, `packCount`, `needsPacking`, `DINING_OPTIONS`, `foodEnabled`, `isSoldOut`).
- Produces:

```ts
// SaleInput and SaleRequest gain:
food?: { serviceMode: 'counter' | 'quick'; diningOption: DiningOption; orderNumber?: string };
// SaleResult / SaleResponse ok branch gains:
orderNumber: string | null;
// SaleError gains:
'sold_out' | 'pack_fee_mismatch' | 'service_mode_not_allowed' | 'invalid_order_number'
// tests/helpers/fixtures.ts:
export async function foodShop(db: Db, now: Date): Promise<SeededShop & { packVariantId: string }>; // kitchen module on, branch modes ['counter','quick'], a GHS 1 pack, 'per_order'
```

Rules, in `completeSale`, after the line loop and before the sale insert:
1. `food` present but the `kitchen` module off → `invalid_input`. `serviceMode` not in the branch's `service_modes` → `service_mode_not_allowed` (outbox: review `service_mode`). `'quick'` forces `diningOption = 'eat_in'`.
2. Any line variant in `isSoldOut(tx, branch, ids, saleBusinessDate)` → `sold_out` (outbox: review `sold_out`).
3. Expected packs = `packCount(lines, …)`; the quantity on the pack variant's line(s) must equal it (0 = no pack line) → else `pack_fee_mismatch` (outbox: review `pack_fee`). A sale without `food` skips this check.
4. `orderNumber` that fails `ORDER_NUMBER`, has no prefix, or is prefixed with another register's code → `invalid_order_number`. Allowed only for Counter mode (the server alone gives unprefixed numbers).

After `finaliseSaleTx`, for Counter mode: the number is `food.orderNumber` if given, otherwise `formatOrderNumber(n)` with `n` from `insert into branch_order_counters … on conflict do update set last = last + 1 returning last` for `(branch, saleBusinessDate)`. Insert the kitchen order (`sentAt = now`, `needsPacking = needsPacking(diningOption)`), and write `service_mode`, `dining_option`, `order_number` on the sale. Quick serve writes the sale columns only.

`repeat()` returns the stored `order_number`. When the repeated request carries a valid `food.orderNumber` different from the stored one, update the sale and kitchen order to it and audit `order_number_changed` (the number the customer holds wins).

- [ ] **Step 1: Write the failing tests** in `tests/server/food-sales.test.ts`:

```ts
it('a counter sale gets the next number and a preparing kitchen order', async () => {
  const r1 = await completeSale(db, till, counterSale(), t);
  const r2 = await completeSale(db, till, counterSale(), t);
  expect([r1, r2].map((r) => r.ok && r.orderNumber)).toEqual(['001', '002']);
  expect(await kitchenOrderOf(r1)).toMatchObject({ status: 'preparing', orderNumber: '001', needsPacking: false });
});
it('numbers restart each business day per branch', async () => { /* day 1: 001, 002; next business day: 001; branch 2 same day: 001 */ });
it('a quick serve sale gets no number and no kitchen order', async () => { /* orderNumber null; no kitchen_orders row */ });
it('keeps a device number from an offline till', async () => { /* outbox sale with food.orderNumber 'T1-005' → stored 'T1-005' */ });
it("refuses an order number with another till's prefix", async () => { /* 'T9-005' → invalid_order_number */ });
it('a repeat with a device order number replaces the stored one', async () => {
  const input = counterSale();
  await completeSale(db, till, input, t);                                    // server gave '001'
  const again = await completeSale(db, till, { ...input, food: { ...input.food!, orderNumber: 'T1-004' }, fromOfflineOutbox: true }, t);
  expect(again).toMatchObject({ ok: true, alreadyExisted: true, orderNumber: 'T1-004' });
});
it('refuses a sold-out item online and flags it from the outbox', async () => {
  // sold_out; online → 'sold_out'; outbox → ok, needs_review with 'sold_out'
});
it('refuses a takeaway sale with the wrong pack quantity', async () => {
  // per_order: no pack line → pack_fee_mismatch; 1 pack line → ok; eat in with a pack line → pack_fee_mismatch
});
it('a takeaway counter order needs packing', async () => { /* kitchen order needsPacking true */ });
it('refuses a service mode the branch does not use', async () => { /* branch ['counter'], quick → service_mode_not_allowed */ });
it('refuses a food block when the kitchen module is off', async () => { /* → invalid_input */ });
it('two counter sales at once get different numbers', async () => {
  const [x, y] = await Promise.all([completeSale(db, tillA, counterSale(), t), completeSale(db, tillB, counterSale('T2'), t)]); // two registers, one branch
  expect(new Set([x, y].map((r) => r.ok && r.orderNumber)).size).toBe(2);
});
```

Existing ok-result expectations in `tests/server/sales.test.ts` gain `orderNumber: null`.

- [ ] **Step 2: Run** `npx vitest run tests/server/food-sales.test.ts` → FAIL.
- [ ] **Step 3: Implement** the rules above in `src/server/sales.ts`; extend the zod `inputSchema` with `food: z.object({ serviceMode: z.enum(['counter', 'quick']), diningOption: z.enum(DINING_OPTIONS), orderNumber: z.string().max(10).optional() }).optional()`; mirror the types in `src/lib/device-contract.ts`. `handleSalePost` needs no change.
- [ ] **Step 4: Run** `npx vitest run tests/server` → PASS (all sale tests).
- [ ] **Step 5: Commit**

```bash
git add src/server/sales.ts src/lib/device-contract.ts tests/helpers/fixtures.ts tests/server
git commit -m "feat(food): number counter orders, create kitchen orders, and check sold-out items and pack fees on sale"
```

---

### Task 6: Kitchen orders, packing check, and hand-over

**Files:**
- Create: `src/server/kitchen.ts`
- Test: `tests/server/kitchen.test.ts`

**Interfaces:**
- Consumes: Task 5 kitchen orders.
- Produces:

```ts
export type KitchenOrderView = {
  id: string; orderNumber: string; status: KitchenOrderStatus; diningOption: DiningOption; needsPacking: boolean;
  sentAt: Date; readyAt: Date | null; lines: Array<{ lineNo: number; name: string; quantity: string; packed: boolean }>;
};
export async function listKitchenOrders(db: Db, ctx: Ctx, branchId: string, now: Date): Promise<{ ok: true; orders: KitchenOrderView[] } | Fail<'not_assigned'>>; // today's preparing and ready, oldest first
export async function markOrderReady(db: Db, ctx: Ctx, orderId: string, now: Date): Promise<{ ok: true } | Fail<'not_found' | 'wrong_status'>>;
export async function tickPackedLine(db: Db, ctx: Ctx, input: { orderId: string; lineNo: number; packed: boolean }, now: Date): Promise<{ ok: true } | Fail<'not_found' | 'no_packing' | 'unknown_line'>>;
export async function handOverOrder(db: Db, ctx: Ctx, input: { orderId: string; handedTo?: string }, now: Date): Promise<{ ok: true } | Fail<'not_found' | 'not_packed' | 'wrong_status' | 'invalid_input'>>;
```

All need `run_kitchen` and the user assigned to the order's branch (`not_found` for another branch, so ids leak nothing). `markOrderReady`: `preparing → ready`, `readyAt = now`. `handOverOrder`: from `preparing` or `ready`; when `needsPacking`, every line must have a tick (`not_packed`, shown as "Pack every item before handing over"), `handedTo` is required (1–80 chars: customer, or rider name and app), status `handed_over`; otherwise status `collected`. Sets `closedAt`, `closedBy`. The packing lines are the sale's lines, including the pack line.

- [ ] **Step 1: Write the failing tests:** `lists today's orders oldest first with their lines`, `refuses orders of a branch the user is not assigned to`, `marks an order ready once` (second call → `wrong_status`), `an eat-in order is collected without packing`, `a takeaway order cannot be handed over until every line is ticked` (one tick missing → `not_packed`; all ticked → `handed_over` with `handedTo`), `unticking a line blocks hand-over again`, `ticking on an eat-in order is refused` (`no_packing`).
- [ ] **Step 2: Run** `npx vitest run tests/server/kitchen.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/server/kitchen.ts`; ticks are inserted `onConflictDoNothing` and deleted to untick.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/server/kitchen.ts tests/server/kitchen.test.ts && git commit -m "feat(food): add kitchen order status, packing check, and hand-over"`

---

### Task 7: Ready board

**Files:**
- Create: `src/server/ready-board.ts`, `src/app/api/[slug]/board/[token]/route.ts`, `src/app/[slug]/board/[token]/page.tsx`
- Test: `tests/server/ready-board.test.ts`

**Interfaces:**
- Produces:

```ts
export async function createBoardLink(db: Db, ctx: Ctx, branchId: string): Promise<{ ok: true; token: string } | Fail<'unknown_branch'>>; // manage_devices; replaces any old token
export async function readReadyBoard(db: Db, input: { slug: string; token: string }, now: Date): Promise<{ branchName: string; preparing: string[]; ready: string[] } | null>;
export async function handleBoardGet(db: Db, slug: string, token: string, now: Date): Promise<Response>; // 200 JSON, 404 when null, Cache-Control: no-store
```

The token is 32 random bytes, base64url; only its sha256 hex is stored in `branches.board_token_hash`. `readReadyBoard` resolves slug → tenant with `asPlatform` (add `src/server/ready-board.ts` to the documented `asPlatform` allow-list), then reads with `withTenant`. `preparing`: today's orders with status `preparing`, by `sentAt`. `ready`: status `ready` and `readyAt > now − 10 min`, newest first. Only order numbers leave the server. The page is a client component polling the route every 5 seconds, large type, two columns headed exactly "Preparing" and "Ready".

- [ ] **Step 1: Write the failing tests:**

```ts
it('shows numbers only, in two columns', async () => {
  const board = await readReadyBoard(db, { slug, token }, t);
  expect(board).toEqual({ branchName: 'Main', preparing: ['002'], ready: ['001'] });
  expect(JSON.stringify(board)).not.toMatch(/Jollof|233/);
});
it('a ready number goes after 10 minutes or once collected', async () => { /* ready at t; listed at t+9m; gone at t+11m; collected → gone */ });
it('a board link shows only its own branch', async () => { /* branch 2 orders never appear */ });
it("a wrong token, another shop's slug, or a replaced token shows nothing", async () => { /* → null */ });
it('only the token hash is stored', async () => { /* board_token_hash !== token, length 64 */ });
```

- [ ] **Step 2: Run** `npx vitest run tests/server/ready-board.test.ts` → FAIL.
- [ ] **Step 3: Implement** the service, the route (`GET` calling `handleBoardGet(getDb(), slug, token, new Date())`), and the page.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/server/ready-board.ts src/app/api/[slug]/board src/app/[slug]/board tests/server/ready-board.test.ts && git commit -m "feat(food): add the Ready board"`

---

### Task 8: Device cache and till logic for food

**Files:**
- Modify: `src/server/device-cache.ts`, `src/lib/device-contract.ts`, `src/device/store.ts`, `src/device/catalogue.ts`, `src/device/sale.ts`
- Test: `tests/server/device-cache.test.ts`, `tests/device/catalogue.test.ts`, `tests/device/device.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:

```ts
// DeviceCache
shop: { …; businessDayCutoff: string };
variants: Array<{ …; needsPack: boolean }>;
food: {
  serviceModes: Array<'counter' | 'quick'>;            // the register's branch modes, 'table' left out
  packVariantId: string | null; packFeeMode: 'per_item' | 'per_order';
  businessDate: string; soldOutVariantIds: string[];   // the branch's flags for businessDate
} | null;                                              // null when the kitchen module is off
// src/device/store.ts — DeviceMeta gains orderCounter: number, orderCounterDate: string | null
takeOrderNumber(businessDate: string): Promise<number>; // restarts at 1 on a new date, inside one IndexedDB transaction
// src/device/catalogue.ts
canAdd(cache, found, today?: string): 'unavailable' | 'serial_item' | 'invalid_quantity' | 'sold_out' | null;
withPackLine(cache: DeviceCache, lines: CartLine[], diningOption: DiningOption): CartLine[]; // adds, resizes, or removes the pack line (lineId 'pack')
// src/device/sale.ts
buildSaleRequest(i: { …; food?: SaleRequest['food'] }): SaleRequest;
```

`canAdd` returns `'sold_out'` only when `cache.food.businessDate` equals the device's business date `today` (a stale list is ignored; the server still checks on sync). The device business date is `businessDate(cache.shop.timezone, cache.shop.businessDayCutoff, new Date())`.

- [ ] **Step 1: Write the failing tests:**
  - device-cache: `includes the branch food settings and today's sold-out items`, `food is null when the kitchen module is off`, `leaves table mode out of the till's service modes`.
  - catalogue: `refuses a sold-out item`, `ignores a sold-out list from another business date`, `adds one pack line for a takeaway order`, `switching to eat in removes the pack line`, `per-item packs follow the cart quantity`.
  - device (fake-indexeddb): `order numbers restart on a new business date`, `two device stores give different numbers on the same day` (stores for registers `T1` and `T2` each take number 1 → `T1-001`, `T2-001`).
- [ ] **Step 2: Run** `npx vitest run tests/device tests/server/device-cache.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `withPackLine` uses `packCount` from `src/lib/food.ts`; its line uses the pack variant's base unit.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/server/device-cache.ts src/lib/device-contract.ts src/device tests && git commit -m "feat(device): cache food settings and sold-out items, add pack lines and offline order numbers"`

---

### Task 9: Till screen for counter and quick serve

**Files:**
- Modify: `src/app/[slug]/till/sell/use-device.ts`, `src/app/[slug]/till/sell/sell-screen.tsx`, `src/app/[slug]/till/actions.ts`

**Interfaces:**
- Consumes: Task 8; `markSoldOut`, `markAvailable` (Task 4).
- Produces: `useDevice().completeSale(lines, totals, tenders, food?: { serviceMode; diningOption })`; `Receipt` gains `orderNumber: string | null`, `serviceMode`, `diningOption`; server actions `markSoldOutAction(slug, variantId)` and `markAvailableAction(slug, variantId)` (PIN session; branch = the session register's branch).

Order number rules in the device `completeSale`:
- Online send `'sent'` → `orderNumber = response.orderNumber`.
- Offline, or an online send that was neither `'sent'` nor `'rejected'` → `n = await store.takeOrderNumber(deviceBusinessDate)`, `orderNumber = offlineOrderNumber(registerCode, n)`; write it into the outbox entry's `request.food.orderNumber` (`store.putOutbox`) before showing the receipt.
- Quick serve → no number.

Screen changes:
- When `cache.food` has more than one mode, a two-button switch "Counter" / "Quick serve" (remembered in `sessionStorage`). Counter shows dining buttons "Eat in", "Takeaway", "Delivery"; the cart passes through `withPackLine` whenever lines or the dining option change.
- Quick serve: large item buttons (search results as 2-column tiles), cash and MoMo first.
- Sold-out items show greyed with "Sold out today"; adding one shows that text. Each search result has a "Sold out" button (online only; offline it shows "Connect to the internet to mark sold out"), which calls the action and then forces a cache refresh.
- Receipt: the order number in large type above the items. A second print block "Kitchen" with the number, dining option, time, items and quantities; `window.print()` prints both (receipt, then the kitchen slip after a page break). Quick serve prints the receipt only.
- A "Kitchen" link to `/[slug]/app/kitchen` when the cashier has `run_kitchen` and the till is online.

- [ ] **Step 1: Build the screen**, then check by hand with `npm run build && npm start` (offline checks need `next start`, Phase 1a Plan 4 note): register a till in a food shop with modes counter + quick and a pack variant. A counter takeaway sale shows `001` and one pack line; offline, the next sale shows `T1-001` and prints a kitchen slip; back online it syncs and the kitchen screen lists `T1-001`; an item marked sold out greys out on a second till within about a minute.
- [ ] **Step 2: Commit** `git add src/app/[slug]/till && git commit -m "feat(till): counter and quick serve selling with order numbers, kitchen slips, pack fee, and sold-out items"`

---

### Task 10: Kitchen screen, food settings page, and "needs a pack"

**Files:**
- Create: `src/app/[slug]/app/kitchen/{page.tsx,actions.ts}`, `src/app/[slug]/app/settings/food/{page.tsx,actions.ts}`
- Modify: `src/app/[slug]/app/layout.tsx` (navigation), `src/server/variants.ts` (`VariantFields.needsPack`), `src/app/[slug]/app/products/[productId]/variant-section.tsx`
- Test: `tests/server/variants.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 6, 7.

Kitchen page (`run_kitchen`): branch picker from the user's branches; columns "Preparing" and "Ready" with each order's number, minutes waiting, dining option, and lines; buttons "Ready", then "Collected" (eat in) or "Pack" (a checkbox per line, then "Hand over" with a "Handed to" field). Errors show the service's message. The page refreshes every 10 seconds.
Food settings page (`manage_shop_settings`): pack item picker, "Per order" / "Per item", each branch with Counter / Table / Quick serve checkboxes (Table disabled, labelled "Needs open tickets — coming later"), and "Create board link" per branch showing the full URL once.

- [ ] **Step 1: Write the failing test** `saves needs pack on a variant` in `tests/server/variants.test.ts`.
- [ ] **Step 2: Run** → FAIL; add `needsPack` to `VariantFields` and `updateVariant`; run → PASS.
- [ ] **Step 3: Build the pages**, then check by hand on `npm start`: settings save; the board link opens the board; the kitchen screen moves an order preparing → ready → packed → handed over, and the board follows within 5 seconds.
- [ ] **Step 4: Commit** `git add src/app/[slug]/app src/server/variants.ts tests/server/variants.test.ts && git commit -m "feat(food): kitchen screen, food settings, board links, and needs-a-pack items"`

---

### Task 11: Verify and hand over

- [ ] **Step 1: Run** `npx vitest run` → all pass (346 before this plan, plus the new tests). `npx tsc --noEmit` and `npm run lint` → clean. `npm run build` → succeeds.
- [ ] **Step 2: Check the acceptance tests by hand** (section 13): order numbers restart per day and branch and never repeat across two offline tills; the board shows only numbers; a sold-out item cannot be added at any till in the branch and returns the next business day; takeaway and delivery get the pack fee and eat in does not; a takeaway order cannot be handed over until every line is ticked.
- [ ] **Step 3: Write** a short hand-over note in the session notes folder (`phase-1b-1-handover.md`): migrations, the `food` contract on `SaleInput`, and anything deferred.
- [ ] **Step 4: Commit** any fixes.
