# Phase 1b · Food Plan 3 of 3: Delivery-App Orders, Phone Orders, Basic Food Reports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cashiers enter Bolt Food, Chowdeck, phone, and WhatsApp orders at the till with their channel, the platform's order ID, and the channel's own prices, so they reach the kitchen, reduce stock, and appear in reports. A platform order ID cannot be entered twice. Commission is worked out per sale, money owed by each app is tracked until its payout is recorded, and phone orders can be paid in advance or on collection. Managers get the basic food reports (6.59) on screen and as CSV.

**Architecture:** A new `sales_channels` table holds each shop's channels. The Plan 1b-1 `food` block on `SaleInput` gains channel fields; `completeSale` uses the channel's price list as the cart list, records commission, and (when the app collects the money) requires one `channel_settlement` tender and creates a receivable. A partial unique index on `(tenant_id, channel_id, external_order_id)` makes a repeated platform ID impossible even under a race. Phone orders paid on collection are kitchen orders without a sale: they hold the lines as JSON and get their sale when the till collects them. Reports are read-only queries in `src/server/food-reports.ts`; pure maths (commission, combo price split, CSV) lives in `src/lib/`.

**Tech Stack:** As Plan 1b-1.

**Spec:** `docs/superpowers/specs/2026-10-20-multishop-pos-design.md` (v4). Sections 4.24 (delivery-app and phone orders, basic food reports), 10.1, 10.2 (commission rates are entered per shop), 10.3 (no direct app connections, no own riders); pseudocode 6.52 (report split), 6.57, 6.59; records in section 7 (Channel, Channel Receivable / Payout, Sale, Kitchen Order); acceptance tests in section 13 (delivery-app order ID, channel reports, packing check, CSV neutralising).

**Depends on:** Plans 1b-1 and 1b-2. Roadmap and shared Global Constraints: `2026-10-26-phase-1b-1-counter-orders.md`.

## Not in this plan

- Direct connections to Bolt Food or Chowdeck, own delivery riders, delivery zones and fees (10.3).
- A phone order paid on delivery by the shop's own rider: without rider management (10.3) the order is paid when it is collected at the counter, or in advance by MoMo.
- Expiry of unpaid phone orders (6.39's job): there is no job runner. Staff cancel them on the kitchen screen; the reports count only paid sales.
- Refunds in channel and item figures: returns do not exist yet.
- Detailed food analytics beyond 6.59 (10.3).
- Price-list editing for a channel: channels point at an existing price list (Phase 1a price lists).

## Global Constraints

All of Plan 1b-1's and Plan 1b-2's Global Constraints apply. New here:

- **Channels** (6.57): kinds `'delivery_app' | 'phone' | 'whatsapp'`; walk-in is "no channel" (`channel_id` null). Each has an optional price list, `commission_bp` 0–10000, and `collected_by` `'app' | 'shop'` (phone and WhatsApp are always `'shop'`). Commission rates are typed in by each shop (10.2).
- **Commission:** `round_half_up(total × commission_bp / 10000)` pesewas, saved on the sale. When `collected_by = 'app'` a receivable of `total − commission` is created.
- **Delivery-app orders:** `externalOrderId` 1–64 characters after trimming, required, unique per `(shop, channel)`. Paid with exactly one `channel_settlement` tender for the full total whose reference is the platform order ID. Price list = the channel's, if set.
- **Phone and WhatsApp orders:** customer name (1–80) and a Ghana phone (`normaliseGhanaPhone`) are required, plus a pickup time or a delivery address (1–200 chars, e.g. a GhanaPostGPS address or landmark). Paid now (normal tenders) or on collection.
- **Every channel order** is Counter mode, `takeaway` or `delivery`, and needs the packing check (6.58): `needsPacking(diningOption, hasChannel)`.
- `channel_settlement` is a tender only for a channel collected by the app; nowhere else.
- **Reports** (6.59): only completed sales; time of a sale = `min(deviceCreatedAt, receivedAt)` in the shop timezone; date range at most 92 days; filters: branch, dates, service mode. CSV text cells that start with `=`, `+`, `-`, `@`, tab, or carriage return get a leading `'`.
- Permissions: `enter_channel_orders` (owner, manager, cashier; in `TILL_PERMISSIONS`), `manage_channels` (owner, manager: channels and payouts). Reports use the existing `view_reports`; CSV uses `export_data`.
- New audit actions: `channel_saved`, `phone_order_created`, `phone_order_cancelled`, `channel_payout_recorded`.

## Review Focus

1. **The same Bolt Food order ID entered on two tills at once, or once offline and once online,** must make one sale; the other is refused or held for review. → Task 4 `two tills entering one platform order at once make one sale`; `an outbox duplicate is refused and held`.
2. **The same platform order ID on two different apps** is two different orders and both must be allowed. → Task 4 `the same order ID on two channels is allowed`.
3. **A phone order collected after the menu price changed** must be charged today's price for exactly the lines ordered; the cashier cannot add or drop lines. → Task 5 `collecting checks the lines match the order`.
4. **A combo sold for GHS 45 whose parts normally cost GHS 50** must split into item sales that add up to exactly GHS 45. → Task 2 `splits a combo net price in proportion and keeps every pesewa`.
5. **A customer or item name like `=HYPERLINK(...)` or `-Special`** must not run as a formula in the exported CSV. → Task 2 `neutralises formula cells`; Task 7 `the CSV export neutralises formula cells`.

## File Structure

```text
src/lib/permissions.ts          + enter_channel_orders, manage_channels
src/lib/food.ts                 + ChannelKind, commissionPesewas, splitComboNet; needsPacking(diningOption, hasChannel)
src/lib/csv.ts                  toCsv
src/db/schema/food.ts           + salesChannels, channelReceivables, channelPayouts; kitchenOrders phone fields
src/db/schema/selling.ts        + sales.channel_id, external_order_id, commission_pesewas; tender 'channel_settlement'
drizzle/0014_*.sql (generated), drizzle/0015_food_channels_rls.sql (custom)
src/server/channels.ts          listChannels, saveChannel
src/server/sales.ts             + channel orders, collecting phone orders
src/server/phone-orders.ts      createPhoneOrder, findPhoneOrder, cancelPhoneOrder
src/server/kitchen.ts           + channel and customer on the view; unpaid orders cannot be handed over
src/server/channel-payouts.ts   listOpenReceivables, recordChannelPayout
src/server/food-reports.ts      foodReport, foodReportCsv
src/server/device-cache.ts, src/lib/device-contract.ts, src/device/{catalogue,sale}.ts   + channels, channel price list, channel_settlement
src/app/[slug]/till/{actions.ts,sell/use-device.ts,sell/sell-screen.tsx}   channel orders, phone orders, collection
src/app/[slug]/app/settings/channels/{page.tsx,actions.ts}, src/app/[slug]/app/channels/payouts/{page.tsx,actions.ts}
src/app/[slug]/app/reports/food/{page.tsx,export/route.ts}
tests/lib/{food,csv}.test.ts, tests/db/food-schema.test.ts (+)
tests/server/{channels,channel-sales,phone-orders,channel-payouts,food-reports,kitchen,device-cache}.test.ts (+), tests/device/{catalogue,device}.test.ts (+)
```

---

### Task 1: Channel schema and permissions

**Files:**
- Create: `drizzle/0014_*.sql` (generated), `drizzle/0015_food_channels_rls.sql` (custom)
- Modify: `src/lib/permissions.ts`, `src/lib/permission-labels.ts`, `src/db/schema/{food,selling}.ts`
- Test: `tests/db/food-schema.test.ts`, `tests/lib/permissions.test.ts`

**Interfaces:**
- Produces:
  - `salesChannels`: `id, tenantId, name, kind text` (check `in ('delivery_app','phone','whatsapp')`), `priceListId uuid` (composite FK), `commissionBp integer not null default 0` (check 0..10000), `collectedBy text not null default 'shop'` (check `in ('app','shop')` and `kind = 'delivery_app' or collected_by = 'shop'`), `active boolean not null default true, createdAt`; unique `(tenant_id, id)`, unique index on `(tenant_id, lower(name))`.
  - `sales` + `channelId uuid` (composite FK), `externalOrderId text`, `commissionPesewas integer not null default 0` (>= 0); unique index `sales_channel_order` on `(tenant_id, channel_id, external_order_id) where external_order_id is not null`; check `external_order_id is null or channel_id is not null`.
  - `TenderMethod` + `'channel_settlement'` (`TENDER_METHODS`, `payments_method` check; it needs a reference like the other non-cash methods).
  - `kitchenOrders` + `channelId uuid` (composite FK), `customerName text`, `customerPhone text`, `pickupAt timestamptz`, `deliveryAddress text`, `payOnCollect boolean not null default false`, `pendingLines jsonb` typed `PendingLine[] = Array<{ variantId: string; unitId: string; quantity: string; byAmount?: boolean; amountPesewas?: number; choices?: ComboChoice[] }>`; checks `pay_on_collect or sale_id is not null`, `not pay_on_collect or pending_lines is not null`.
  - `channelReceivables`: `id, tenantId, saleId (unique per tenant), channelId, expectedPesewas integer not null, payoutId uuid, createdAt`; composite FKs to sales, channels, payouts.
  - `channelPayouts`: `id, tenantId, channelId, amountPesewas integer not null (> 0), reference text not null, periodFrom date, periodTo date, expectedPesewas integer not null, differencePesewas integer not null, recordedBy uuid, createdAt`; unique `(tenant_id, id)`, unique `(tenant_id, channel_id, reference)`; check `period_to >= period_from`.
  - Permissions `'enter_channel_orders'` (label `'Enter delivery-app and phone orders'`; cashier preset, `TILL_PERMISSIONS`) and `'manage_channels'` (label `'Set up channels and record app payouts'`; owner and manager presets only).
- `0015_food_channels_rls.sql`: RLS on the three new tables; cache trigger on `sales_channels`; backfill `enter_channel_orders` for every user and `manage_channels` for owners and managers (`WHERE role_preset IN ('owner','manager')`).

- [ ] **Step 1: Write the failing tests:** `a platform order ID is unique per channel`, `the same order ID on two channels is allowed at the database`, `a phone channel cannot be collected by the app`, `a paid kitchen order needs its sale; an unpaid one needs its lines`, `channel_settlement needs a reference`; permissions: `a cashier PIN can enter channel orders but not manage channels`.
- [ ] **Step 2: Run** `npx vitest run tests/db tests/lib/permissions.test.ts` → FAIL.
- [ ] **Step 3: Write the schema**, then `npx drizzle-kit generate --name food_channels` and `npx drizzle-kit generate --custom --name food_channels_rls`. Check statement order: `channel_receivables`' FK to `channel_payouts` must follow `channel_payouts_tenant_id`; the FKs from `kitchen_orders` and `sales` to `sales_channels` must follow `sales_channels_tenant_id`.
- [ ] **Step 4: Run** `npx vitest run tests/db tests/lib` → PASS.
- [ ] **Step 5: Commit** `git add src/lib src/db drizzle tests/db tests/lib && git commit -m "feat(db): add sales channels, channel orders, receivables, and payouts"`

---

### Task 2: Commission, combo split, and CSV rules

**Files:**
- Create: `src/lib/csv.ts`
- Modify: `src/lib/food.ts`
- Test: `tests/lib/food.test.ts`, `tests/lib/csv.test.ts`

**Interfaces:**
- Produces:

```ts
// src/lib/food.ts
export type ChannelKind = 'delivery_app' | 'phone' | 'whatsapp';
export function commissionPesewas(totalPesewas: number, commissionBp: number): number;               // half up
export function splitComboNet(netPesewas: number, parts: Array<{ key: string; weightPesewas: number }>): Map<string, number>;
export function needsPacking(diningOption: DiningOption, hasChannel?: boolean): boolean;           // widens the Plan 1b-1 signature; old calls keep working
// src/lib/csv.ts
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string;          // CRLF line ends, RFC 4180 quoting
```

`splitComboNet` gives each part `floor(net × weight / Σweight)` and the leftover pesewas to the largest weight (the first on a tie); all weights 0 → everything to the first part. Shares always add up to `net`. `toCsv` neutralises text cells only; numbers (including negative variances) are written as they are.

- [ ] **Step 1: Write the failing tests:**

```ts
it('works out commission half up', () => {
  expect(commissionPesewas(10_000, 2250)).toBe(2250);
  expect(commissionPesewas(333, 1500)).toBe(50);   // 49.95 → 50
  expect(commissionPesewas(5_000, 0)).toBe(0);
});
it('splits a combo net price in proportion and keeps every pesewa', () => {
  const s = splitComboNet(4500, [{ key: 'chicken', weightPesewas: 3000 }, { key: 'chips', weightPesewas: 1200 }, { key: 'coke', weightPesewas: 800 }]);
  expect([...s.values()].reduce((a, b) => a + b, 0)).toBe(4500);
  expect(s.get('chicken')).toBe(2700);
});
it('every channel order needs packing; walk-in eat in does not', () => {
  expect(needsPacking('eat_in')).toBe(false);
  expect(needsPacking('takeaway')).toBe(true);
  expect(needsPacking('eat_in', true)).toBe(true);
});
it('neutralises formula cells', () => {
  expect(toCsv([['=HYPERLINK("x")', '-Special', '@a', '+1', 'Ok, "fine"', -2400, null]]))
    .toBe(`"'=HYPERLINK(""x"")",'-Special,'@a,'+1,"Ok, ""fine""",-2400,\r\n`);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/lib/food.test.ts tests/lib/csv.test.ts` → FAIL.
- [ ] **Step 3: Implement** (BigInt for the split and commission).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/lib tests/lib && git commit -m "feat(food): add commission, combo split, and safe CSV rules"`

---

### Task 3: Channel setup

**Files:**
- Create: `src/server/channels.ts`
- Test: `tests/server/channels.test.ts`

**Interfaces:**
- Produces:

```ts
export type Channel = { id: string; name: string; kind: ChannelKind; priceListId: string | null; commissionBp: number; collectedBy: 'app' | 'shop'; active: boolean };
export async function listChannels(db: Db, ctx: Ctx): Promise<Channel[]>;                    // make_sale or manage_channels
export async function saveChannel(db: Db, ctx: Ctx, input: Omit<Channel, 'id'> & { id?: string }): Promise<{ ok: true; channelId: string } | Fail<'invalid_input' | 'duplicate_name' | 'unknown_price_list' | 'module_off'>>;
```

`manage_channels`; name 1–40; a phone or WhatsApp channel forces `collectedBy = 'shop'`; channels are never deleted, only made inactive. Audit `channel_saved`.

- [ ] **Step 1: Write the failing tests:** `adds Bolt Food with a price list and 22.5% commission`, `refuses another shop's price list`, `refuses a duplicate name in any case`, `a phone channel is always collected by the shop`, `a cashier cannot set up channels`.
- [ ] **Step 2: Run** `npx vitest run tests/server/channels.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/server/channels.ts tests/server/channels.test.ts && git commit -m "feat(food): set up delivery-app and phone channels"`

---

### Task 4: Channel orders on a sale

**Files:**
- Modify: `src/server/sales.ts`, `src/lib/device-contract.ts`
- Test: `tests/server/channel-sales.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; Plan 1b-1 `food` block.
- Produces:

```ts
// SaleInput['food'] / SaleRequest['food'] gain:
channelId?: string; externalOrderId?: string;
customer?: { name: string; phone: string }; pickupAt?: string; deliveryAddress?: string;
kitchenOrderId?: string;                                  // Task 5
// SaleError gains:
'unknown_channel' | 'channel_not_allowed' | 'external_order_id_required' | 'channel_order_exists' | 'channel_settlement_required'
  | 'invalid_tender' | 'customer_details_required' | 'dining_option_not_allowed'
```

Rules, with a `food.channelId`:
1. Both the signed-in user and the recorded cashier need `enter_channel_orders` → else `channel_not_allowed`. Unknown channel → `unknown_channel`; inactive → `unknown_channel` online, review `channel_inactive` from the outbox.
2. `serviceMode` must be `'counter'` and `diningOption` `'takeaway'` or `'delivery'` → else `dining_option_not_allowed`.
3. Price list: `choosePriceList(rules, { cartListId: channel.priceListId, … })`.
4. Delivery app: `externalOrderId` (trimmed, 1–64) → else `external_order_id_required`. An existing sale with the same `(channel, externalOrderId)` → `channel_order_exists`, from the outbox too (a real duplicate goes to manager review). Catch the unique-index violation on insert and return the same error.
5. `collectedBy = 'app'`: tenders = exactly one `channel_settlement` for the total with a reference → else `channel_settlement_required`. A `channel_settlement` tender on any other sale → `invalid_tender`.
6. Phone or WhatsApp: customer name and a valid Ghana phone, plus `pickupAt` (ISO datetime) or `deliveryAddress` → else `customer_details_required`.
7. Save `channel_id`, `external_order_id`, `commission_pesewas = commissionPesewas(total, bp)`; when collected by the app insert a receivable of `total − commission`. The kitchen order gets the channel, customer, pickup, and address fields and `needsPacking = true`.

- [ ] **Step 1: Write the failing tests:**

```ts
it('a Bolt Food order uses the channel prices, records commission, and owes a receivable', async () => {
  // channel: price list with jollof at GHS 50 (walk-in GHS 45), 22.5%, collected by app
  // → sale total 5000, commission 1125, receivable 3875, kitchen order needsPacking
});
it('two tills entering one platform order at once make one sale', async () => {
  const [x, y] = await Promise.all([completeSale(db, tillA, boltSale('BF-123'), t), completeSale(db, tillB, boltSale('BF-123', 'T2'), t)]);
  expect([x, y].filter((r) => r.ok)).toHaveLength(1);
  expect([x, y].find((r) => !r.ok)).toEqual({ ok: false, error: 'channel_order_exists' });
});
it('an outbox duplicate is refused and held', async () => { /* fromOfflineOutbox → channel_order_exists (409) */ });
it('the same order ID on two channels is allowed', async () => { /* Bolt 'A1' and Chowdeck 'A1' → both ok */ });
it('an app-collected order must be paid by channel settlement', async () => { /* cash → channel_settlement_required; settlement on walk-in → invalid_tender */ });
it('a phone order needs the customer and a pickup time or address', async () => { /* missing phone → customer_details_required */ });
it('channel orders need the permission and a takeaway or delivery option', async () => { /* PIN without it → channel_not_allowed; eat_in → dining_option_not_allowed */ });
```

- [ ] **Step 2: Run** `npx vitest run tests/server/channel-sales.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/server` → PASS.
- [ ] **Step 5: Commit** `git add src/server/sales.ts src/lib/device-contract.ts tests/server && git commit -m "feat(food): enter delivery-app and phone orders with commission and duplicate checks"`

---

### Task 5: Phone orders paid on collection

**Files:**
- Create: `src/server/phone-orders.ts`
- Modify: `src/server/sales.ts`, `src/server/kitchen.ts`
- Test: `tests/server/phone-orders.test.ts`, `tests/server/kitchen.test.ts`

**Interfaces:**
- Produces:

```ts
export async function createPhoneOrder(db: Db, ctx: Ctx, input: {
  channelId: string; diningOption: 'takeaway' | 'delivery'; customer: { name: string; phone: string }; pickupAt?: string; deliveryAddress?: string;
  lines: PendingLine[];
}, now: Date): Promise<{ ok: true; kitchenOrderId: string; orderNumber: string } | Fail<'invalid_input' | 'no_register' | 'unknown_channel' | 'channel_not_allowed' | 'customer_details_required' | 'unknown_item' | 'not_sellable' | 'invalid_quantity' | 'invalid_choices' | 'sold_out'>>;
export async function findPhoneOrder(db: Db, ctx: Ctx, orderNumber: string, now: Date): Promise<{ kitchenOrderId: string; channelId: string; diningOption: DiningOption; customerName: string; lines: PendingLine[] } | null>; // today's unpaid order in the register's branch
export async function cancelPhoneOrder(db: Db, ctx: Ctx, input: { kitchenOrderId: string; reason: string }, now: Date): Promise<{ ok: true } | Fail<'not_found' | 'already_paid' | 'invalid_input'>>;
// SaleError gains 'order_changed' | 'order_not_open'; handOverOrder's errors gain 'not_paid'
```

`createPhoneOrder` (`enter_channel_orders`, branch from `ctx.registerId`): the channel must be `phone` or `whatsapp`; every line must be a sellable item of this shop, with a valid quantity, valid combo choices, and not sold out (the same checks as `completeSale`, without prices; a by-amount line needs `amountPesewas` at or above the minimum); it takes the next branch order number (Plan 1b-1 counter) and inserts a kitchen order with `payOnCollect = true`, `pendingLines`, `needsPacking = true`. Audit `phone_order_created`. Online only.

Collecting: a sale with `food.kitchenOrderId` must point at an open (`preparing` or `ready`), unpaid, pay-on-collect order of the register's branch (`order_not_open`), and its lines (without the pack line) must equal `pendingLines` on variant, unit, quantity, amount, and choices (`order_changed`). Prices are checked as for any sale. On success the kitchen order gets `sale_id`; no new order number. `handOverOrder` refuses an unpaid pay-on-collect order (`not_paid`). `KitchenOrderView` gains `channelName`, `customerName`, `pickupAt`, `deliveryAddress`, `payOnCollect`, `paid`; packing lines come from `pendingLines` while unpaid (line numbers 1…n, the same numbers the sale lines get). `cancelPhoneOrder` (`enter_channel_orders`, reason 1–200) sets `cancelled` and audits `phone_order_cancelled`.

- [ ] **Step 1: Write the failing tests:** `creates an unpaid phone order with the next number and sends it to the kitchen`, `refuses a sold-out item or a delivery-app channel`, `finds today's open order by number`, `collecting checks the lines match the order` (an extra line → `order_changed`; same lines → ok, kitchen order linked, number unchanged), `a paid or cancelled order cannot be collected again` (`order_not_open`), `an unpaid order cannot be handed over`, `cancels an unpaid order with a reason; a paid order cannot be cancelled`.
- [ ] **Step 2: Run** `npx vitest run tests/server/phone-orders.test.ts tests/server/kitchen.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/server` → PASS.
- [ ] **Step 5: Commit** `git add src/server tests/server && git commit -m "feat(food): phone orders paid on collection"`

---

### Task 6: App payouts

**Files:**
- Create: `src/server/channel-payouts.ts`
- Test: `tests/server/channel-payouts.test.ts`

**Interfaces:**
- Produces:

```ts
export async function listOpenReceivables(db: Db, ctx: Ctx, channelId: string): Promise<Array<{ saleId: string; receiptNumber: string; externalOrderId: string; businessDate: string; expectedPesewas: number }>>;
export async function recordChannelPayout(db: Db, ctx: Ctx, input: { channelId: string; amountPesewas: number; reference: string; periodFrom: string; periodTo: string }, now: Date):
  Promise<{ ok: true; matched: number; expectedPesewas: number; differencePesewas: number } | Fail<'invalid_input' | 'unknown_channel' | 'duplicate_reference' | 'nothing_to_match'>>;
```

`manage_channels`. The payout matches every open receivable of that channel whose sale's business date is in `[periodFrom, periodTo]` (locked `for update`), sets their `payout_id`, and saves `expected` and `difference = amount − expected` (negative = the app paid less: extra deductions or missing orders). Audit `channel_payout_recorded`.

- [ ] **Step 1: Write the failing tests:** `matches a payout to the period's open receivables and shows the difference`, `a receivable is matched once` (a second payout for the same period → `nothing_to_match`), `refuses a reused payout reference`, `a cashier cannot record payouts`.
- [ ] **Step 2: Run** `npx vitest run tests/server/channel-payouts.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/server/channel-payouts.ts tests/server/channel-payouts.test.ts && git commit -m "feat(food): match delivery-app payouts to receivables"`

---

### Task 7: Basic food reports

**Files:**
- Create: `src/server/food-reports.ts`
- Test: `tests/server/food-reports.test.ts`

**Interfaces:**
- Consumes: Plans 1b-1 and 1b-2 tables; `splitComboNet`, `toCsv`.
- Produces:

```ts
export type FoodReportInput = { from: string; to: string; branchId?: string; serviceMode?: 'counter' | 'quick' };
export type FoodReport = {
  byHour: Array<{ hour: number; orders: number; valuePesewas: number }>;                         // 0–23, every hour present
  items: Array<{ variantId: string; name: string; quantity: string; valuePesewas: number }>;      // all sold items, value desc
  best: FoodReport['items']; slowest: FoodReport['items'];                                       // top 10 by value; bottom 10 by quantity, including active sellable items with no sales
  channels: Array<{ channelId: string | null; name: string; orders: number; salesPesewas: number; commissionPesewas: number; afterCommissionPesewas: number }>;
  wastage: Array<{ reason: string; entries: number; costPesewas: number }>;
  pots: Array<{ businessDate: string; name: string; expectedPesewas: number | null; actualPesewas: number | null; variancePesewas: number | null; flagged: boolean }>;
  avgKitchenSeconds: number | null;                                                               // sentAt → readyAt
  avgCounterWaitSeconds: number | null;                                                           // sentAt (paid) → closedAt
};
export async function foodReport(db: Db, ctx: Ctx, input: FoodReportInput, now: Date): Promise<{ ok: true; report: FoodReport } | Fail<'invalid_input' | 'range_too_long'>>;
export async function foodReportCsv(db: Db, ctx: Ctx, input: FoodReportInput, now: Date): Promise<{ ok: true; csv: string } | Fail<'invalid_input' | 'range_too_long'>>; // export_data
```

`view_reports`. Value of a line = gross − discount. A combo line's value is split over its fixed items and choices with `splitComboNet`, weights = each part's current base price × quantity, and each part counts toward that item's quantity; a by-amount line counts quantity 1 per line. The CSV has one section per block, each with a title row, then a header row, all through `toCsv`.

- [ ] **Step 1: Write the failing tests:** `groups orders and value by local hour`, `item sales split combos into their parts`, `best and slowest include items with no sales`, `channel figures show sales minus commission`, `wastage by reason with cost`, `average kitchen time and counter wait`, `filters by branch and service mode`, `ignores pending sales`, `refuses a range longer than 92 days`, `the CSV export neutralises formula cells` (a product named `=cmd` appears as `'=cmd`).
- [ ] **Step 2: Run** `npx vitest run tests/server/food-reports.test.ts` → FAIL.
- [ ] **Step 3: Implement** with SQL aggregates for plain sums and counts (hour bucket: `extract(hour from least(device_created_at, received_at) at time zone <shop timezone>)`), and the combo split in TypeScript.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/server/food-reports.ts tests/server/food-reports.test.ts && git commit -m "feat(food): basic food reports with CSV export"`

---

### Task 8: Channel and phone orders on the device

**Files:**
- Modify: `src/server/device-cache.ts`, `src/lib/device-contract.ts`, `src/device/{catalogue,sale}.ts`
- Test: `tests/server/device-cache.test.ts`, `tests/device/{catalogue,device}.test.ts`

**Interfaces:**
- Produces:

```ts
// DeviceCache
channels: Array<{ id: string; name: string; kind: ChannelKind; priceListId: string | null; collectedBy: 'app' | 'shop' }>; // active only
// src/device/catalogue.ts
priceCart(cache, lines, today, opts?: { priceListId?: string | null }): …;     // the channel's list as cartListId
// src/device/sale.ts
TenderInput['method'] gains 'channel_settlement'; checkTenders requires its reference
export function outboxHasChannelOrder(entries: OutboxEntry[], channelId: string, externalOrderId: string): boolean;
```

- [ ] **Step 1: Write the failing tests:** device-cache `includes active channels only`; catalogue `prices with the channel's price list`; device `refuses a platform order ID already waiting in the outbox`.
- [ ] **Step 2: Run** `npx vitest run tests/device tests/server/device-cache.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/server/device-cache.ts src/lib/device-contract.ts src/device tests && git commit -m "feat(device): channel prices, settlement tender, and duplicate order checks offline"`

---

### Task 9: Till, kitchen, channel, payout, and report screens

**Files:**
- Modify: `src/app/[slug]/till/{actions.ts,sell/use-device.ts,sell/sell-screen.tsx}`, `src/app/[slug]/app/kitchen/page.tsx`, `src/app/[slug]/app/layout.tsx`
- Create: `src/app/[slug]/app/settings/channels/{page.tsx,actions.ts}`, `src/app/[slug]/app/channels/payouts/{page.tsx,actions.ts}`, `src/app/[slug]/app/reports/food/{page.tsx,export/route.ts}`

Till (cashier with `enter_channel_orders`): a "Channel" picker (Walk-in first). Delivery app: a required "Order ID" field; when the app collects, the only tender is "Paid by the app" (`channel_settlement`, reference = order ID). Phone / WhatsApp: name, phone, and pickup time or address; then "Paid now" (normal tenders) or "Pay on collection" (online only: `createPhoneOrderAction` → prints the kitchen slip with the number). A "Collect phone order" button takes a number (`findPhoneOrderAction`), loads its lines into a locked cart (lines cannot be added or removed), and takes payment with `food.kitchenOrderId`. Kitchen screen: shows channel, customer name, pickup time or address, and "Not paid" for unpaid phone orders, with "Cancel" (reason). Settings: channel list and form. Payouts: open receivables per channel and the payout form showing the difference. Reports: date range, branch, service mode, the 6.59 blocks, and "Download CSV" (`export_data`).

- [ ] **Step 1: Build the screens**, then check by hand on `npm start`: a Bolt Food order with its prices and commission; the same order ID refused; a Chowdeck order offline that syncs; a phone order paid on collection through to hand-over; a payout with a difference; the food report and CSV opened in a spreadsheet with no formula running.
- [ ] **Step 2: Commit** `git add src/app && git commit -m "feat(food): channel and phone orders at the till, payouts, and the food report"`

---

### Task 10: Verify and hand over

- [ ] **Step 1: Run** `npx vitest run`, `npx tsc --noEmit`, `npm run lint`, `npm run build` → all green.
- [ ] **Step 2: Check the acceptance tests by hand** (section 13): a delivery-app order cannot be entered twice with the same platform order ID; channel reports show sales minus commission; a takeaway, delivery, phone, or delivery-app order cannot be handed over until every item is ticked; exported CSV cells starting with `=`, `+`, `-`, or `@` are neutralised.
- [ ] **Step 3: Write** `phase-1b-3-handover.md` in the session notes folder; commit any fixes.
