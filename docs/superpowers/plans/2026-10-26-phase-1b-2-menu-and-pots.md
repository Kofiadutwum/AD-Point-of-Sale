# Phase 1b · Food Plan 2 of 3: Combo Meals, Sell by Amount, Pot Tracking, Wastage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A food shop sells combo meals with fixed items and choice slots (with paid upgrades), and sells rice, stew, soup, or waakye by cedi amount above a minimum. Stock for combos follows what the customer chose; stock for sell-by-amount items is tracked by pots cooked and leftovers at closing, with expected-versus-actual sales and an alert when the gap is above the shop's limit. Staff record wastage and staff meals with a reason. All of it works on the offline till.

**Architecture:** A combo is a variant of the new kind `'combo'`: its fixed items are ordinary `components` rows (Phase 1a), and its choice slots live in two new tables. A sale line carries the customer's choices as a JSON snapshot; `deductStockForLine` deducts the fixed items and each chosen item. A sell-by-amount line is quantity 1 at the typed amount and is skipped by stock deduction; its stock moves when pots are recorded (the pot recipe is the variant's `components`, per one pot). Pot records and wastage entries are new tables; leftovers either carry to the next business day or become wastage. The pure choice and variance rules live in `src/lib/food.ts`, shared with the device.

**Tech Stack:** As Plan 1b-1.

**Spec:** `docs/superpowers/specs/2026-10-20-multishop-pos-design.md` (v4). Sections 4.18, 4.24 (combo meals, sell by amount, pot tracking, wastage and staff meals), 10.1, 10.2; pseudocode 6.27 (as used by pots), 6.28, 6.52, 6.53, 6.54; records in section 7 (Variant, Combo Slot, Pot Record, Sale Line); acceptance tests in section 13 (combo, sell by amount and pot variance).

**Depends on:** Plan 1b-1 (`src/lib/food.ts`, `food_settings`, `isSoldOut`, the `food` block, `kitchen` module gating). Roadmap and shared Global Constraints: `2026-10-26-phase-1b-1-counter-orders.md`.

## Not in this plan

- Splitting a combo's price across its parts for item reports (6.52 "For reports") → Plan 1b-3, where the reports are.
- Refunds of by-amount sales in "actual" pot sales (6.54): returns do not exist yet. When returns land, `potActualSales` must subtract them.
- The scheduled reminder at the business-day cutoff (6.54): there is no job runner yet. The dashboard lists every pot record from earlier days still waiting for its leftover count instead.
- Manager SMS for pot variance: SMS arrives in Phase 2. The alert is an audit entry (`pot_variance`) listed on the dashboard, like negative stock.
- Add-ons with ingredient deductions (6.37) and production of items made in advance (6.27 as its own feature) — separate Phase 1b plans.
- Nested combos (a combo inside a combo slot) are refused.

## Global Constraints

All of Plan 1b-1's Global Constraints apply. New here:

- **Combo** (6.52): `variants.kind = 'combo'`, tracking `'none'`, base unit only, no fractions. Fixed items are `components`; a combo needs at least one component or one slot. Each slot has `0 ≤ min_choices ≤ max_choices`, `max_choices ≥ 1`; choices are `standard` or `recipe` variants of the same shop, never a combo, each once per slot. Line unit price = the combo's resolved price + the sum of chosen upgrade prices. A choice that is sold out today is hidden on the till and refused by the server.
- **Sell by amount** (6.53): `variants.sell_by_amount` with `min_amount_pesewas ≥ 1` (required when on). Only `standard` or `recipe` variants. A by-amount line has `quantity '1.000'`, `unitPricePesewas` = the amount typed, `byAmount: true`, and is never deducted from stock at sale. A sell-by-amount variant can only be sold by amount.
- **Pots** (6.54): quantities of pots are 3-decimal strings (`'0.250'` = a quarter pot). Recording pots deducts each pot-recipe component × pots (movement `'used_in_production'`, reference `'pot_record'`). Leftover must be `0 ≤ leftover ≤ cooked`. `expected = pesewasTimesQty(value_per_pot, cooked − leftover)`; `actual` = Σ (gross − discount) of completed by-amount lines of that variant, branch, and business date; `variance = actual − expected`. Flag when `expected > 0` and `|variance| × 10000 > expected × pot_variance_limit_bp` (default 1000 = 10%). No `value_per_pot` → no expected sales and no flag.
- **Leftovers:** with `food_settings.keep_pot_leftovers` the next business day's record gets `cooked += leftover` (`carried_in = leftover`); otherwise the leftover's pot-recipe ingredients become wastage (reason `'leftover'`, movement `'waste'`).
- **Wastage:** reasons `'spoiled' | 'dropped' | 'staff_meal' | 'leftover'`; cost = `round_half_up(costOf(variant) × quantity)` pesewas at the time of recording. Recipes deduct their ingredients; combos and sell-by-amount variants are refused (leftovers cover the pot).
- Permission `record_kitchen_stock` (pots, leftovers, wastage): owner, manager, cashier, and in `TILL_PERMISSIONS`.
- New audit actions: `combo_slots_saved`, `pots_recorded`, `pot_closed`, `pot_variance`, `wastage_recorded`.

## Review Focus

1. **The same choice picked twice, or more choices than a slot allows**, must be refused on the device and the server. → Task 2 `refuses too few, too many, repeated, or unknown choices`; Task 4 `refuses a combo with too many choices`.
2. **A combo whose chosen drink is a recipe** must deduct the recipe's ingredients, not the drink itself. → Task 4 `a combo deducts its fixed items and the recipe ingredients of a chosen item`.
3. **Leftover recorded twice, or larger than what was cooked**, must be refused and never waste stock twice. → Task 5 `refuses a leftover above the pots cooked` and `closing twice is refused and wastes stock once`.
4. **A pot carried over from yesterday** must count in today's expected sales and not be wasted. → Task 5 `keeps leftovers for tomorrow when the shop says so`.
5. **A by-amount sale typed below the minimum on an offline till after the owner raised the minimum** is held for review, not lost. → Task 4 `refuses an amount below the minimum online and flags it from the outbox`.

## File Structure

```text
src/lib/permissions.ts          + record_kitchen_stock
src/lib/food.ts                 + ComboSlotDef, ComboChoice, checkComboChoices, comboUpgradeTotal, potVariance
src/db/schema/catalogue.ts      + kind 'combo'; variants.sell_by_amount, min_amount_pesewas, value_per_pot_pesewas
src/db/schema/food.ts           + comboSlots, comboChoices, potRecords, wastageEntries; foodSettings.keep_pot_leftovers, pot_variance_limit_bp
src/db/schema/selling.ts        + sale_lines.by_amount, sale_lines.choices
src/db/schema/stock.ts          + movement types 'used_in_production', 'waste'; reference types 'pot_record', 'wastage'
drizzle/0012_*.sql (generated), drizzle/0013_food_menu_rls.sql (custom)
src/server/products.ts          + 'combo' in KINDS and trackingAllowed
src/server/variants.ts          + VariantFields food fields; combo parents; costOf for combos
src/server/combos.ts            getComboSlots, saveComboSlots
src/server/sales.ts             + by-amount and combo lines
src/server/stock.ts             + deductStockForLine choices; deductRecipe helper
src/server/pots.ts              recordPots, recordClosingLeftover, getPotDay, potActualSales, potReminders
src/server/wastage.ts           recordWastage
src/server/dashboard.ts         + pot reminders and pot variance alerts
src/server/device-cache.ts, src/lib/device-contract.ts, src/device/{catalogue,sale}.ts   + kind, by-amount fields, combo slots
src/app/[slug]/till/sell/sell-screen.tsx                 amount pad, combo picker
src/app/[slug]/app/products/[productId]/{variant-section.tsx,combo-slots.tsx}, src/app/[slug]/app/kitchen-stock/{page.tsx,actions.ts}
tests/lib/food.test.ts (+), tests/db/food-schema.test.ts (+)
tests/server/{combos,food-sales,deduct,pots,wastage,dashboard,device-cache}.test.ts (+), tests/device/catalogue.test.ts (+)
```

---

### Task 1: Menu schema and permission

**Files:**
- Create: `drizzle/0012_*.sql` (generated), `drizzle/0013_food_menu_rls.sql` (custom)
- Modify: `src/lib/permissions.ts`, `src/lib/permission-labels.ts`, `src/db/schema/{catalogue,food,selling,stock}.ts`
- Test: `tests/db/food-schema.test.ts`, `tests/lib/permissions.test.ts`

**Interfaces:**
- Produces:
  - `VariantKind` = `'standard' | 'bundle' | 'recipe' | 'combo'`; check `variants_kind` updated.
  - `variants` + `sellByAmount boolean not null default false`, `minAmountPesewas integer`, `valuePerPotPesewas integer`; checks `variants_by_amount`: `not sell_by_amount or (min_amount_pesewas >= 1 and kind in ('standard','recipe'))`, `variants_value_per_pot`: `value_per_pot_pesewas > 0`.
  - `comboSlots`: `id, tenantId, comboVariantId, name, minChoices integer, maxChoices integer, sortOrder integer, createdAt`; unique `(tenant_id, id)`; composite FK to variants (on delete cascade); check `0 <= min_choices and min_choices <= max_choices and max_choices >= 1`.
  - `comboChoices`: `id, tenantId, slotId, variantId, upgradePesewas integer not null default 0 (>= 0)`; unique `(slot_id, variant_id)`; composite FKs to slots (cascade) and variants.
  - `saleLines` + `byAmount boolean not null default false`, `choices jsonb not null default '[]'` typed `SaleLineChoice[] = Array<{ slotId: string; variantId: string; name: string; upgradePesewas: number }>`.
  - `stockMovements`: `MovementType` + `'used_in_production' | 'waste'`; `referenceType` + `'pot_record' | 'wastage'`; both checks updated.
  - `foodSettings` + `keepPotLeftovers boolean not null default false`, `potVarianceLimitBp integer not null default 1000` (check 0..10000).
  - `potRecords`: `id, tenantId, branchId, variantId, businessDate, cooked numeric(14,3) not null default 0, carriedIn numeric(14,3) not null default 0, leftover numeric(14,3), expectedPesewas integer, actualPesewas integer, variancePesewas integer, flagged boolean not null default false, closedBy uuid, closedAt`; unique `(tenant_id, branch_id, variant_id, business_date)` and `(tenant_id, id)`; checks `cooked >= 0`, `leftover >= 0 and leftover <= cooked`.
  - `wastageEntries`: `id, tenantId, branchId, variantId, businessDate, quantity numeric(14,3) (> 0), reason text` (check `in ('spoiled','dropped','staff_meal','leftover')`), `costPesewas integer not null (>= 0), potRecordId uuid, note text, userId uuid, createdAt`; composite FKs to branches, variants, pot records, users.
  - `PERMISSIONS` + `'record_kitchen_stock'` (label `'Record pots, leftovers, and wastage'`), in the cashier preset and `TILL_PERMISSIONS`.
- `0013_food_menu_rls.sql`: RLS policy on the four new tables; cache triggers on `combo_slots` and `combo_choices`; `REVOKE UPDATE, DELETE ON wastage_entries FROM pos_app;`; permission backfill as in `0011` for `record_kitchen_stock`.

- [ ] **Step 1: Write the failing tests:** `a sell-by-amount variant needs a minimum`, `a combo cannot be sold by amount`, `a slot needs max at least 1 and min not above max`, `a choice appears once per slot`, `a leftover cannot exceed the pots cooked`, `wastage entries are append-only for pos_app`, `changing a combo slot bumps the device cache version`; permissions: `a cashier PIN can record kitchen stock`.
- [ ] **Step 2: Run** `npx vitest run tests/db tests/lib/permissions.test.ts` → FAIL.
- [ ] **Step 3: Write the schema**, then `npx drizzle-kit generate --name food_menu` and `npx drizzle-kit generate --custom --name food_menu_rls`. Check that every foreign key comes after the unique constraint it references (the slot and pot-record FKs need `combo_slots_tenant_id`, `pot_records_tenant_id`).
- [ ] **Step 4: Run** `npx vitest run tests/db tests/lib` → PASS.
- [ ] **Step 5: Commit** `git add src/lib src/db drizzle tests/db tests/lib && git commit -m "feat(db): add combo slots, sell-by-amount fields, pot records, and wastage entries"`

---

### Task 2: Pure combo and pot rules

**Files:**
- Modify: `src/lib/food.ts`
- Test: `tests/lib/food.test.ts`

**Interfaces:**
- Produces:

```ts
export type ComboSlotDef = { id: string; minChoices: number; maxChoices: number; choices: Array<{ variantId: string; upgradePesewas: number }> };
export type ComboChoice = { slotId: string; variantId: string };
export function checkComboChoices(slots: ComboSlotDef[], chosen: ComboChoice[], soldOut: ReadonlySet<string>): 'ok' | 'invalid_choices' | 'sold_out';
export function comboUpgradeTotal(slots: ComboSlotDef[], chosen: ComboChoice[]): number; // pesewas; call after 'ok'
export function potVariance(i: { cookedQty: string; leftoverQty: string; valuePerPotPesewas: number | null; actualPesewas: number; limitBp: number }):
  { expectedPesewas: number | null; variancePesewas: number | null; flagged: boolean };
```

- [ ] **Step 1: Write the failing tests:**

```ts
const slots: ComboSlotDef[] = [{ id: 'drink', minChoices: 1, maxChoices: 1, choices: [{ variantId: 'coke', upgradePesewas: 0 }, { variantId: 'large', upgradePesewas: 500 }] }];
it('accepts a valid choice and adds upgrade prices', () => {
  expect(checkComboChoices(slots, [{ slotId: 'drink', variantId: 'large' }], new Set())).toBe('ok');
  expect(comboUpgradeTotal(slots, [{ slotId: 'drink', variantId: 'large' }])).toBe(500);
});
it('refuses too few, too many, repeated, or unknown choices', () => {
  for (const chosen of [[], [{ slotId: 'drink', variantId: 'coke' }, { slotId: 'drink', variantId: 'large' }], [{ slotId: 'drink', variantId: 'fanta' }], [{ slotId: 'food', variantId: 'coke' }]]) {
    expect(checkComboChoices(slots, chosen, new Set())).toBe('invalid_choices');
  }
});
it('refuses a sold-out choice', () => {
  expect(checkComboChoices(slots, [{ slotId: 'drink', variantId: 'coke' }], new Set(['coke']))).toBe('sold_out');
});
it('works out pot variance and flags gaps above the limit', () => {
  // 3 pots cooked, 0.5 left, GHS 600 per pot → expected 150000; actual 130000 → variance −20000 (13.3%) → flagged
  expect(potVariance({ cookedQty: '3.000', leftoverQty: '0.500', valuePerPotPesewas: 60000, actualPesewas: 130000, limitBp: 1000 }))
    .toEqual({ expectedPesewas: 150000, variancePesewas: -20000, flagged: true });
  expect(potVariance({ cookedQty: '3.000', leftoverQty: '0.500', valuePerPotPesewas: 60000, actualPesewas: 140000, limitBp: 1000 }).flagged).toBe(false); // 6.7%
  expect(potVariance({ cookedQty: '1.000', leftoverQty: '0.000', valuePerPotPesewas: null, actualPesewas: 5000, limitBp: 1000 }))
    .toEqual({ expectedPesewas: null, variancePesewas: null, flagged: false });
});
it('a gap of exactly the limit is not flagged', () => {
  expect(potVariance({ cookedQty: '1.000', leftoverQty: '0.000', valuePerPotPesewas: 10000, actualPesewas: 9000, limitBp: 1000 }).flagged).toBe(false);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/lib/food.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `src/lib/food.ts` (BigInt comparisons for the flag; `pesewasTimesQty` and `fromMilli` for the expected amount).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/lib/food.ts tests/lib/food.test.ts && git commit -m "feat(food): add combo choice and pot variance rules"`

---

### Task 3: Combo and sell-by-amount setup

**Files:**
- Create: `src/server/combos.ts`
- Modify: `src/server/products.ts` (`KINDS`, `trackingAllowed`), `src/server/variants.ts` (`VariantFields`, `updateVariant`, `addComponent`, `costOf`), `src/app/[slug]/app/products/form-data.ts`
- Test: `tests/server/combos.test.ts`, `tests/server/variants.test.ts`, `tests/server/products.test.ts`

**Interfaces:**
- Produces:

```ts
export type ComboSlotInput = { name: string; minChoices: number; maxChoices: number; choices: Array<{ variantId: string; upgradePesewas: number }> };
export async function getComboSlots(db: Db, ctx: Ctx, comboVariantId: string): Promise<Array<ComboSlotInput & { id: string; choiceNames: Record<string, string> }>>;
export async function saveComboSlots(db: Db, ctx: Ctx, comboVariantId: string, slots: ComboSlotInput[]): Promise<{ ok: true } | Fail<'invalid_input' | 'not_a_combo' | 'unknown_item' | 'nested_combo'>>;
// VariantFields gains: sellByAmount: boolean; minAmountPesewas: number | null; valuePerPotPesewas: number | null
```

`saveComboSlots` (`manage_products`) replaces all slots of the combo in one transaction; 1–10 slots, 1–30 choices each, names 1–40 chars. A choice must be an active `standard` or `recipe` variant of this shop (`unknown_item`), never a combo (`nested_combo`). `createProduct` accepts `kind: 'combo'` with tracking `'none'` and no fractions; `addComponent` allows a combo parent (fixed items). `costOf` of a combo = cost of its fixed items only (choices vary per sale). Changing `sellByAmount` on a variant that has sale lines → `in_use` (like the existing tracking rule).

- [ ] **Step 1: Write the failing tests:** `creates a combo product with fixed items`, `saves slots and choices and replaces them on save`, `refuses a combo as a choice`, `refuses another shop's variant as a choice`, `refuses min above max or no choices`, `saves sell-by-amount with a minimum and value per pot`, `refuses sell by amount on a bundle or combo`, `refuses switching sell by amount once the item has sales`.
- [ ] **Step 2: Run** `npx vitest run tests/server/combos.test.ts tests/server/variants.test.ts tests/server/products.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/server src/app/[slug]/app/products/form-data.ts tests/server && git commit -m "feat(food): set up combo slots and sell-by-amount items"`

---

### Task 4: Selling combos and by-amount lines

**Files:**
- Modify: `src/server/sales.ts`, `src/server/stock.ts`, `src/lib/device-contract.ts`
- Test: `tests/server/food-sales.test.ts`, `tests/server/deduct.test.ts`

**Interfaces:**
- Consumes: Task 2 rules, Task 3 tables, Plan 1b-1 `isSoldOut`.
- Produces:

```ts
// SaleInput / SaleRequest lines gain:
byAmount?: boolean;
choices?: Array<{ slotId: string; variantId: string }>;   // max 20
// SaleError gains:
'invalid_choices' | 'amount_required' | 'not_sold_by_amount' | 'below_minimum_amount'
// src/server/stock.ts
deductStockForLine(tx, s, line: { variantId: string; baseQty: string; serials: string[]; choices?: string[] }): Promise<DeductProblems>;
```

In the `completeSale` line loop:
- **Combo** (`kind === 'combo'`): load its slots and choices; `checkComboChoices(slots, line.choices ?? [], soldOutToday)` → `'invalid_choices'` refuses (from the outbox too: the device built a bad cart); `'sold_out'` follows Plan 1b-1's sold-out rule. `currentPrice = resolvePrice(…) + comboUpgradeTotal(…)`. The empty-bundle check counts slots too. Store `choices` with names and upgrade prices.
- **By amount:** a `sellByAmount` variant without `byAmount: true` → `amount_required`; `byAmount: true` on any other variant → `not_sold_by_amount`; quantity must be `'1.000'` (`invalid_quantity`); `unitPricePesewas < minAmountPesewas` → `below_minimum_amount` (outbox: review `below_minimum`). The price-changed check is skipped. Save `by_amount = true`.
- `finaliseSaleTx` skips lines with `by_amount`; for others it passes `choices.map((c) => c.variantId)`. `deductStockForLine` for a combo deducts its components (existing path), then each chosen variant × `baseQty` recursively (a recipe choice deducts its ingredients).

- [ ] **Step 1: Write the failing tests:**

```ts
it('a combo upgrade adds its price', async () => {
  const r = await completeSale(db, till, saleInput({ lines: [comboLine({ unitPricePesewas: 4500 + 500, choices: [{ slotId: drink, variantId: largeCoke }] })] }), t);
  expect(r.ok).toBe(true);
  expect(await lineOf(r)).toMatchObject({ unitPricePesewas: 5000, choices: [{ variantId: largeCoke, upgradePesewas: 500 }] });
});
it('a combo deducts its fixed items and the recipe ingredients of a chosen item', async () => {
  // fixed: 2 × chicken piece; chosen: 'Sobolo' recipe (0.3 L sobolo base) → chicken −2, sobolo base −0.300, sobolo itself untouched
});
it('refuses a combo with too many choices', async () => { /* → invalid_choices, online and outbox */ });
it('refuses a sold-out choice', async () => { /* → sold_out */ });
it('a by-amount line keeps the amount typed and deducts no stock', async () => {
  // GHS 10 rice (min GHS 5): ok, unit price 1000, by_amount true, no stock_movements for the pot recipe
});
it('refuses an amount below the minimum online and flags it from the outbox', async () => { /* 400 < 500 → below_minimum_amount; outbox → needs_review 'below_minimum' */ });
it('a sell-by-amount item must be sold by amount', async () => { /* byAmount missing → amount_required; quantity 2 → invalid_quantity */ });
```

- [ ] **Step 2: Run** `npx vitest run tests/server/food-sales.test.ts tests/server/deduct.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/server` → PASS.
- [ ] **Step 5: Commit** `git add src/server/sales.ts src/server/stock.ts src/lib/device-contract.ts tests/server && git commit -m "feat(food): sell combos with choices and items by amount"`

---

### Task 5: Pots and the closing count

**Files:**
- Create: `src/server/pots.ts`
- Modify: `src/server/stock.ts` (export `deductRecipe`)
- Test: `tests/server/pots.test.ts`

**Interfaces:**
- Consumes: Task 2 `potVariance`; `changeBalance`, `costOf` from Phase 1a.
- Produces:

```ts
export type PotRow = { id: string; variantId: string; name: string; businessDate: string; cooked: string; carriedIn: string; leftover: string | null;
  expectedPesewas: number | null; actualPesewas: number | null; variancePesewas: number | null; flagged: boolean; closed: boolean };
export async function recordPots(db: Db, ctx: Ctx, input: { branchId: string; variantId: string; pots: string }, now: Date): Promise<{ ok: true; cooked: string } | Fail<'invalid_input' | 'not_assigned' | 'not_sold_by_amount' | 'already_closed'>>;
export async function recordClosingLeftover(db: Db, ctx: Ctx, input: { branchId: string; variantId: string; leftover: string; businessDate?: string }, now: Date): Promise<{ ok: true; pot: PotRow } | Fail<'invalid_input' | 'not_assigned' | 'no_pots' | 'already_closed' | 'leftover_above_cooked' | 'too_old'>>;
export async function getPotDay(db: Db, ctx: Ctx, branchId: string, businessDate: string): Promise<PotRow[]>;
export async function potActualSales(tx: Tx, branchId: string, variantId: string, businessDate: string): Promise<number>;
export async function potReminders(tx: Tx, today: string): Promise<Array<{ branchId: string; variantId: string; name: string; businessDate: string }>>; // open records before today
// src/server/stock.ts
export async function deductRecipe(tx: Tx, s: { tenantId: string; branchId: string; userId: string }, variantId: string, qty: string,
  type: 'used_in_production' | 'waste', ref: { type: 'pot_record' | 'wastage'; id: string }): Promise<{ negative: boolean }>;
```

All writers need `record_kitchen_stock` and the user assigned to the branch. `recordPots` upserts today's record (`cooked += pots`), deducts each pot-recipe component × pots, audits `pots_recorded`. `recordClosingLeftover` closes today's or yesterday's record only (`too_old` otherwise), locks the row (`for update`), computes `potVariance`, saves it, audits `pot_closed` and (when flagged) `pot_variance` with `{ expected, actual, variance }`; then carries the leftover to the next business date or wastes it (wastage entry reason `'leftover'`, `'waste'` movements, cost from `costOf`). A `standard` sell-by-amount variant (no pot recipe) deducts nothing.

- [ ] **Step 1: Write the failing tests:**

```ts
it('records pots and deducts the pot recipe', async () => {
  // jollof pot recipe: 5 kg rice, 1 L oil; recordPots 2 → rice −10, oil −2; cooked '2.000'
});
it('compares expected with actual sales and flags a large gap', async () => {
  // 3 pots, GHS 600/pot; by-amount sales GHS 1,560; leftover 0.4 → expected 156000, actual 156000, not flagged
  // another day: leftover 0 → expected 180000, variance −24000 (−13%), flagged, audit 'pot_variance'
});
it('refuses a leftover above the pots cooked', async () => { /* → leftover_above_cooked */ });
it('closing twice is refused and wastes stock once', async () => { /* second close → already_closed; one wastage entry */ });
it('wastes the leftover by default', async () => { /* leftover 0.5 → rice −2.5, oil −0.5 as 'waste'; wastage entry 'leftover' with cost */ });
it('keeps leftovers for tomorrow when the shop says so', async () => { /* keepPotLeftovers → next day's record cooked 0.5, carriedIn 0.5; no waste */ });
it('pots without a value per pot are closed without a check', async () => { /* expected null, flagged false */ });
it('counts only completed by-amount sales of that branch and day', async () => { /* a pending sale, another branch, another day, a normal line → not counted */ });
it('lists earlier days still waiting for a leftover count', async () => { /* potReminders */ });
```

- [ ] **Step 2: Run** `npx vitest run tests/server/pots.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/server/pots.ts` and `deductRecipe`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/server/pots.ts src/server/stock.ts tests/server/pots.test.ts && git commit -m "feat(food): track pots cooked and closing leftovers with a variance check"`

---

### Task 6: Wastage and staff meals

**Files:**
- Create: `src/server/wastage.ts`
- Test: `tests/server/wastage.test.ts`

**Interfaces:**
- Produces:

```ts
export type WastageReason = 'spoiled' | 'dropped' | 'staff_meal';
export async function recordWastage(db: Db, ctx: Ctx, input: { branchId: string; variantId: string; quantity: string; reason: WastageReason; note?: string }, now: Date): Promise<{ ok: true; costPesewas: number } | Fail<'invalid_input' | 'not_assigned' | 'unknown_item' | 'use_pot_leftover' | 'not_wastable'>>;
```

`record_kitchen_stock`; quantity in base units, valid for the variant (`validSaleQuantity`); a `standard` variant goes down itself, a `recipe` or `bundle` deducts its components (`deductRecipe`), a `combo` → `not_wastable`, a sell-by-amount variant → `use_pot_leftover`. Business date = today's. Audit `wastage_recorded`.

- [ ] **Step 1: Write the failing tests:** `records a staff meal of a recipe and deducts its ingredients`, `records spoiled stock of a plain item with its cost`, `refuses a combo or a sell-by-amount item`, `refuses another branch`.
- [ ] **Step 2: Run** `npx vitest run tests/server/wastage.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/server/wastage.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/server/wastage.ts tests/server/wastage.test.ts && git commit -m "feat(food): record wastage and staff meals"`

---

### Task 7: Dashboard reminders and alerts

**Files:**
- Modify: `src/server/dashboard.ts`, `src/app/[slug]/app/dashboard/page.tsx`
- Test: `tests/server/dashboard.test.ts`

**Interfaces:**
- Produces: `Dashboard` gains `potReminders: Array<{ name: string; businessDate: string }>` and `potVariances: Array<{ name: string; businessDate: string; expectedPesewas: number; actualPesewas: number; variancePesewas: number }>` (flagged records of the last 7 days, newest first). The page shows a line such as `Jollof: sold GHS 1,560.00, expected GHS 1,800.00 (−13%)`.

- [ ] **Step 1: Write the failing test** `lists open pot counts and flagged pot variances`.
- [ ] **Step 2: Run** `npx vitest run tests/server/dashboard.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/server/dashboard.ts src/app/[slug]/app/dashboard tests/server/dashboard.test.ts && git commit -m "feat(food): show pot reminders and variance alerts on the dashboard"`

---

### Task 8: Combos and by-amount items on the device

**Files:**
- Modify: `src/server/device-cache.ts`, `src/lib/device-contract.ts`, `src/device/catalogue.ts`, `src/device/sale.ts`
- Test: `tests/server/device-cache.test.ts`, `tests/device/catalogue.test.ts`

**Interfaces:**
- Produces:

```ts
// DeviceCache
variants: Array<{ …; kind: VariantKind; sellByAmount: boolean; minAmountPesewas: number | null }>;
comboSlots: Array<ComboSlotDef & { comboVariantId: string; name: string; sortOrder: number; choiceNames: Record<string, string> }>;
// src/device/catalogue.ts
CartLine gains: amountPesewas?: number | null; choices?: ComboChoice[];
canAdd(cache, found & { amountPesewas?: number | null; choices?: ComboChoice[] }, today?): … | 'amount_required' | 'below_minimum_amount' | 'invalid_choices';
// priceCart: by-amount unit price = amountPesewas; combo unit price = resolved price + comboUpgradeTotal
// src/device/sale.ts: buildSaleRequest lines carry byAmount and choices
```

- [ ] **Step 1: Write the failing tests:** device-cache `includes combo slots and by-amount fields`; catalogue `prices a combo with its upgrade`, `hides and refuses a sold-out choice`, `prices a by-amount line at the amount typed`, `refuses an amount below the minimum`, `a combo needs its required choices`.
- [ ] **Step 2: Run** `npx vitest run tests/device tests/server/device-cache.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/server/device-cache.ts src/lib/device-contract.ts src/device tests && git commit -m "feat(device): sell combos and by-amount items offline"`

---

### Task 9: Till and back-office screens

**Files:**
- Modify: `src/app/[slug]/till/sell/sell-screen.tsx`, `src/app/[slug]/app/products/[productId]/variant-section.tsx`, `src/app/[slug]/app/layout.tsx`
- Create: `src/app/[slug]/app/products/[productId]/combo-slots.tsx`, `src/app/[slug]/app/kitchen-stock/{page.tsx,actions.ts}`

Till: tapping a by-amount item opens an amount pad with quick buttons (GHS 5, 10, 15, 20) and shows "Minimum GHS x.xx" when below; tapping a combo walks one step per slot (sold-out choices hidden, upgrades shown as "+GHS 5.00"), then adds the line. Back office: the variant form gets "Sell by amount", "Minimum amount", "Value per pot", and for a sell-by-amount recipe the components heading reads "Ingredients for one pot"; combo products get the slot editor. Kitchen stock page (`record_kitchen_stock`): today's pots per by-amount item with "Add pots" and "Record leftover" (quick choices 0, ¼, ½, ¾ and a free field), the variance after closing, and a wastage form (item, quantity, reason Spoiled / Dropped / Staff meal, note).

- [ ] **Step 1: Build the screens**, then check by hand on `npm start`, online and with the browser offline: a combo with a large-drink upgrade; a GHS 10 rice line; a below-minimum amount refused; record 2 pots, sell, close with a quarter pot, see the variance; record a staff meal.
- [ ] **Step 2: Commit** `git add src/app && git commit -m "feat(food): combo picker, amount pad, kitchen stock page, and combo setup"`

---

### Task 10: Verify and hand over

- [ ] **Step 1: Run** `npx vitest run`, `npx tsc --noEmit`, `npm run lint`, `npm run build` → all green.
- [ ] **Step 2: Check the acceptance tests by hand** (section 13): a combo deducts stock for the items chosen and an upgrade adds its price; a sell-by-amount sale below the minimum is refused; a pot variance above the limit is shown to the manager.
- [ ] **Step 3: Write** `phase-1b-2-handover.md` in the session notes folder; commit any fixes.
