# Phase 1b-4: Add-Ons and Item Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Food items carry add-on groups ("Protein: choose 1", "Extras: any", "Pepper level") with prices and optional ingredient deductions, and each sale line can carry a note ("no onions"), at the counter, quick serve, phone orders, the kitchen screen, and the receipt.

**Architecture:** Add-on groups are shop-level and linked to items, so "Pepper level" is set up once. A sale line sends `addOns: [{ groupId, optionId }]` and `note`; the server checks the choices against the item's groups, adds the option prices to the unit price, stores the add-ons as sold, and deducts option ingredients with the line. The till gets the groups in the device cache and checks them offline the same way.

**Tech Stack:** Next.js 16, Drizzle, PGlite tests, Vitest, zod 4.

**Spec:** `docs/superpowers/specs/2026-10-20-multishop-pos-design.md` sections 4.24 (Add-ons, Notes), 6.5 (add-on picker, cart merge), 6.28 (add-on ingredients), 6.37 (`add_food_item`).

## Not in this plan (Plan 1b-5)
Open tickets, tables, kitchen stations, send to kitchen, void sent item, move and merge lines, service charge, tips, split bill, kitchen printing.

## Global Constraints

All Global Constraints of Plans 1b-1 to 1b-3 apply. New here:
- **Groups:** name 1–40; `minChoices` 0–20, `maxChoices` 1–20, `min <= max`; 1–30 options. A group is "required" when `minChoices >= 1`.
- **Options:** name 1–40; `pricePesewas` 0–2,000,000,000; optional ingredient `variantId` (a standard or recipe item of this shop, never a combo) with `ingredientQuantity` > 0 in its base unit. Options are never deleted; one left out of a save becomes `active = false`.
- **Links:** an item (variant) has 0–10 groups, in order. Combos and sell-by-amount items cannot have add-on groups (`not_allowed`).
- **Choosing:** per group, the number chosen is between min and max; an option is chosen at most once; only active options of the item's linked groups.
- **Price:** line unit price = resolved price + combo upgrades + sum of chosen option prices.
- **Notes:** 0–140 characters after trimming; shown on the kitchen screen, packing list, and receipt; never in CSV exports.
- **Cart merge (6.5):** lines merge only when variant, unit, add-ons (as a set), and note are all the same.
- **Stock (6.28):** each chosen option with an ingredient deducts `ingredientQuantity × line base quantity` (movement `sale`, same `saleLineId`).
- **Offline:** an add-on choice the server no longer knows (option inactive, group unlinked) is `invalid_add_ons` online and review `add_ons_changed` from the outbox; a wrong count is always refused (the device built a bad cart).
- New audit actions: `add_on_group_saved`, `item_add_ons_saved`. Setup uses the existing `manage_products`.

## Review Focus

1. **The owner edits "Protein" while a till is offline:** the paid offline sale with the old option syncs and is held for review, not lost. → Task 4 `an outbox sale with a removed add-on is kept for review`.
2. **A required group skipped on the till** must not reach the kitchen. → Task 2 `a required group needs its choice`; Task 6 `refuses a cart line missing a required add-on`.
3. **Two jollofs, one with extra chicken and one without,** stay two lines; two identical ones merge. → Task 6 `merges only identical add-ons and notes`.
4. **Two plates with extra chicken** deduct two portions of chicken. → Task 4 `add-on ingredients are deducted per plate`.
5. **A phone order with add-ons** is collected with the same add-ons and note, or refused. → Task 5 `collecting checks add-ons and notes`.

## File Structure

```text
src/db/schema/food.ts              + addOnGroups, addOnOptions, variantAddOnGroups; PendingLine + addOns?, note?
src/db/schema/selling.ts           + SaleLineAddOn; saleLines.addOns, saleLines.note
drizzle/0016_food_add_ons.sql (generated), drizzle/0017_food_add_ons_rls.sql (custom)
src/lib/food.ts                    + AddOnChoice, AddOnGroupDef, checkAddOns, addOnTotal, sameAddOns
src/server/add-ons.ts              listAddOnGroups, saveAddOnGroup, getItemAddOnGroups, setItemAddOnGroups
src/server/{sales,stock,phone-orders,kitchen,receipts,device-cache}.ts
src/lib/device-contract.ts, src/device/{catalogue,sale}.ts
src/app/[slug]/app/add-ons/{page.tsx,actions.ts}; product page links; till picker and note; kitchen page
tests/lib/food.test.ts, tests/server/{add-ons,add-on-sales,phone-orders,kitchen,receipts,device-cache}.test.ts, tests/device/catalogue.test.ts
```

---

### Task 1: Add-on schema

**Files:** Create `drizzle/0016_food_add_ons.sql` (generated), `drizzle/0017_food_add_ons_rls.sql` (custom). Modify `src/db/schema/{food,selling}.ts`. Test `tests/db/food-schema.test.ts`.

**Interfaces — Produces:**
- `addOnGroups`: `id, tenantId, name text not null, minChoices integer not null default 0, maxChoices integer not null default 1, createdAt`; unique `(tenant_id, id)`, unique index `(tenant_id, lower(name))`; checks `min_choices between 0 and 20`, `max_choices between 1 and 20`, `min_choices <= max_choices`.
- `addOnOptions`: `id, tenantId, groupId uuid not null (composite FK), name text not null, pricePesewas integer not null default 0 (>= 0), ingredientVariantId uuid (composite FK to variants), ingredientQuantity numeric(14,3), sortOrder integer not null, active boolean not null default true`; unique `(tenant_id, id)`; checks `(ingredient_variant_id is null) = (ingredient_quantity is null)` and `ingredient_quantity > 0`.
- `variantAddOnGroups`: `tenantId, variantId, groupId, sortOrder`; primary key `(tenant_id, variant_id, group_id)`; composite FKs.
- `export type SaleLineAddOn = { groupId: string; optionId: string; name: string; pricePesewas: number }`; `saleLines.addOns jsonb not null default '[]'`, `saleLines.note text` (check `length(note) <= 140`).
- `PendingLine` + `addOns?: Array<{ groupId: string; optionId: string }>; note?: string`.
- `0017`: `tenant_isolation` on the three tables; `bump_device_cache_version` triggers on all three.

- [ ] **Step 1: Write the failing tests:** `an option's ingredient needs a quantity`, `a group's min cannot exceed its max`, `group names are unique per shop in any case`, `a sale line note is at most 140 characters`.
- [ ] **Step 2: Run** `npx vitest run tests/db` → FAIL.
- [ ] **Step 3: Write the schema**, then `npx drizzle-kit generate --name food_add_ons` and `npx drizzle-kit generate --custom --name food_add_ons_rls`. Check FKs follow the unique constraints they reference.
- [ ] **Step 4: Run** `npx vitest run tests/db` → PASS.
- [ ] **Step 5: Commit** `feat(db): add add-on groups, options, item links, and sale line notes`

---

### Task 2: Add-on rules

**Files:** Modify `src/lib/food.ts`. Test `tests/lib/food.test.ts`.

**Interfaces — Produces:**
```ts
export type AddOnChoice = { groupId: string; optionId: string };
export type AddOnGroupDef = { id: string; minChoices: number; maxChoices: number; options: Array<{ id: string; pricePesewas: number; active: boolean }> };
export function checkAddOns(groups: AddOnGroupDef[], chosen: AddOnChoice[]): 'ok' | 'invalid_add_ons' | 'stale_add_ons';
export function addOnTotal(groups: AddOnGroupDef[], chosen: AddOnChoice[]): number;
export function sameAddOns(a: AddOnChoice[] = [], b: AddOnChoice[] = []): boolean;   // as sets
```
`stale_add_ons`: a chosen group not in `groups`, or an option unknown or inactive. `invalid_add_ons`: a count outside min–max, or an option chosen twice. Stale is checked first.

- [ ] **Step 1: Write the failing tests:**
```ts
const protein = { id: 'g1', minChoices: 1, maxChoices: 1, options: [{ id: 'chk', pricePesewas: 1000, active: true }, { id: 'fish', pricePesewas: 1200, active: true }] };
const extras = { id: 'g2', minChoices: 0, maxChoices: 3, options: [{ id: 'egg', pricePesewas: 300, active: true }, { id: 'old', pricePesewas: 100, active: false }] };
it('a required group needs its choice', () => {
  expect(checkAddOns([protein], [])).toBe('invalid_add_ons');
  expect(checkAddOns([protein], [{ groupId: 'g1', optionId: 'chk' }, { groupId: 'g1', optionId: 'fish' }])).toBe('invalid_add_ons');
  expect(checkAddOns([protein, extras], [{ groupId: 'g1', optionId: 'fish' }])).toBe('ok');
});
it('an inactive or unknown option is stale', () => {
  expect(checkAddOns([protein, extras], [{ groupId: 'g1', optionId: 'chk' }, { groupId: 'g2', optionId: 'old' }])).toBe('stale_add_ons');
  expect(checkAddOns([protein], [{ groupId: 'g1', optionId: 'chk' }, { groupId: 'g9', optionId: 'x' }])).toBe('stale_add_ons');
});
it('adds the chosen option prices', () => {
  expect(addOnTotal([protein, extras], [{ groupId: 'g1', optionId: 'fish' }, { groupId: 'g2', optionId: 'egg' }])).toBe(1500);
});
it('compares add-ons as sets', () => {
  expect(sameAddOns([{ groupId: 'g2', optionId: 'egg' }, { groupId: 'g1', optionId: 'chk' }], [{ groupId: 'g1', optionId: 'chk' }, { groupId: 'g2', optionId: 'egg' }])).toBe(true);
  expect(sameAddOns([], [{ groupId: 'g2', optionId: 'egg' }])).toBe(false);
});
```
- [ ] **Step 2: Run** `npx vitest run tests/lib/food.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(food): add-on choice and price rules`

---

### Task 3: Add-on setup

**Files:** Create `src/server/add-ons.ts`. Test `tests/server/add-ons.test.ts`.

**Interfaces — Produces:**
```ts
export type AddOnOptionInput = { id?: string; name: string; pricePesewas: number; ingredientVariantId: string | null; ingredientQuantity: string | null };
export type AddOnGroup = { id: string; name: string; minChoices: number; maxChoices: number; options: Array<Required<AddOnOptionInput> & { active: boolean }> };
export async function listAddOnGroups(db: Db, ctx: Ctx): Promise<AddOnGroup[]>;                       // manage_products or make_sale; options in sortOrder
export async function saveAddOnGroup(db: Db, ctx: Ctx, input: { id?: string; name: string; minChoices: number; maxChoices: number; options: AddOnOptionInput[] }):
  Promise<{ ok: true; groupId: string } | Fail<'invalid_input' | 'duplicate_name' | 'unknown_item' | 'not_found' | 'module_off'>>;
export async function getItemAddOnGroups(db: Db, ctx: Ctx, variantId: string): Promise<string[]>;    // group ids in order
export async function setItemAddOnGroups(db: Db, ctx: Ctx, variantId: string, groupIds: string[]): Promise<{ ok: true } | Fail<'invalid_input' | 'unknown_item' | 'not_allowed' | 'module_off'>>;
```
`manage_products`; `foodEnabled` else `module_off`. Saving keeps option ids sent with `id` (updated in place), adds new ones, and sets omitted ones `active = false`; `sortOrder` = input order. An ingredient that is a combo or another shop's item → `unknown_item`. `setItemAddOnGroups` replaces the links (max 10, no duplicates); a combo or sell-by-amount item → `not_allowed`. Audits `add_on_group_saved`, `item_add_ons_saved`.

- [ ] **Step 1: Write the failing tests:** `saves a Protein group with priced options and an ingredient`, `an option left out becomes inactive and keeps its id`, `refuses a combo as an ingredient`, `links groups to an item in order and refuses combos`, `a cashier cannot change add-ons`.
- [ ] **Step 2: Run** `npx vitest run tests/server/add-ons.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(food): set up add-on groups and link them to items`

---

### Task 4: Add-ons and notes on a sale

**Files:** Modify `src/server/sales.ts`, `src/server/stock.ts`, `src/lib/device-contract.ts`. Test `tests/server/add-on-sales.test.ts`.

**Interfaces:**
- Consumes: Task 2 rules; Task 1 tables.
- Produces: `SaleInput` / `SaleRequest` lines + `addOns?: AddOnChoice[]` (max 30) and `note?: string` (max 140 after trim; empty → null). `SaleError` + `'invalid_add_ons'`. `deductStockForLine` line param + `extras?: Array<{ variantId: string; quantity: string }>` (per base unit, deducted × `baseQty` after the item itself, for any kind).
- An exported `loadAddOnGroups(tx: Tx, variantId: string)` in `sales.ts` returning the linked groups in order with all options (active or not), their names, and ingredients; Task 5 reuses it.

Rules: a by-amount line or a combo with add-ons → `invalid_add_ons`; `checkAddOns` → `invalid_add_ons` refuses always; `stale_add_ons` → `lenient('invalid_add_ons', 'add_ons_changed')`, and the stale choices are stored by name as sent with price 0 (like `choicesAsSent`). `currentPrice += addOnTotal(...)`. Saved `addOns: SaleLineAddOn[]` and `note`. `finaliseSaleTx` passes each stored add-on's option ingredient as `extras`.

- [ ] **Step 1: Write the failing tests:**
  - `jollof with fish and egg costs base + add-ons and is stored as sold` (GHS 30 + 12 + 3 = 4500; line `addOns` names `['Fish', 'Egg']`, note `'no onions'`).
  - `a missing required add-on is refused` → `invalid_add_ons`.
  - `an outbox sale with a removed add-on is kept for review` (option made inactive after the cart was built; `fromOfflineOutbox` → ok and `reviewReasons` contains `add_ons_changed`; online → `invalid_add_ons`).
  - `add-on ingredients are deducted per plate` (2 × jollof with Extra chicken, ingredient chicken × 1 → chicken stock −2.000).
  - `a note over 140 characters is refused` → `invalid_input`.
- [ ] **Step 2: Run** `npx vitest run tests/server/add-on-sales.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/server` → PASS.
- [ ] **Step 5: Commit** `feat(food): sell items with add-ons and notes`

---

### Task 5: Add-ons and notes in phone orders, the kitchen, and the receipt

**Files:** Modify `src/server/{phone-orders,sales,kitchen,receipts}.ts`. Test `tests/server/{phone-orders,kitchen,receipts}.test.ts`.

**Interfaces — Produces:** `PendingLine.addOns`/`note` saved by `createPhoneOrder` (checked with `checkAddOns`; stale or invalid → `invalid_choices`); `checkCollectedLines` also compares `sameAddOns` and the trimmed note. `KitchenOrderView['lines'][n]` + `addOns: string[]` (option names) and `note: string | null`, from the sale line once paid and from `pendingLines` while unpaid. Receipt line view + `addOns: string[]`, `note: string | null`.

- [ ] **Step 1: Write the failing tests:** phone-orders `collecting checks add-ons and notes` (different option → `order_changed`; same → ok); kitchen `shows add-ons and the note on each line`; receipts `prints add-ons under the item`.
- [ ] **Step 2: Run** `npx vitest run tests/server/phone-orders.test.ts tests/server/kitchen.test.ts tests/server/receipts.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/server` → PASS.
- [ ] **Step 5: Commit** `feat(food): add-ons and notes on phone orders, kitchen screen, and receipts`

---

### Task 6: Add-ons on the device

**Files:** Modify `src/server/device-cache.ts`, `src/lib/device-contract.ts`, `src/device/{catalogue,sale}.ts`. Test `tests/server/device-cache.test.ts`, `tests/device/catalogue.test.ts`.

**Interfaces — Produces:**
- `DeviceCache.addOnGroups: Array<AddOnGroupDef & { name: string; optionNames: Record<string, string> }>` (active and inactive options; the till shows active only) and `DeviceCache.itemAddOnGroups: Array<{ variantId: string; groupIds: string[] }>`.
- `CartLine` + `addOns?: AddOnChoice[]; note?: string`. `export function addOnGroupsOf(cache: DeviceCache, variantId: string): DeviceCache['addOnGroups']` (in link order).
- `canAdd` returns `'invalid_add_ons'` for a bad or stale choice; `priceCart` adds `addOnTotal`; `buildSaleRequest` passes `addOns` and the trimmed `note`.
- `export function mergeLine(lines: CartLine[], found: Omit<CartLine, 'lineId'>): CartLine[]` in `catalogue.ts`: the merge rule now in the till's `add`, extended to add-ons (`sameAddOns`) and note; the till calls it.

- [ ] **Step 1: Write the failing tests:** device-cache `includes add-on groups and item links`; catalogue `prices add-ons into the line`, `refuses a cart line missing a required add-on`, `merges only identical add-ons and notes`.
- [ ] **Step 2: Run** `npx vitest run tests/device tests/server/device-cache.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(device): add-on groups, prices, and notes offline`

---

### Task 7: Screens

**Files:** Create `src/app/[slug]/app/add-ons/{page.tsx,actions.ts}`. Modify the product page (`src/app/[slug]/app/products/[productId]/page.tsx`, variant section), `src/app/[slug]/app/page.tsx` (link "Add-ons", `manage_products`), `src/app/[slug]/till/sell/sell-screen.tsx`, `src/app/[slug]/app/kitchen/page.tsx`.

- Add-ons page: list of groups; a form per group (name, min, max, option rows: name, price GHS, ingredient item, quantity; "Add option"); "Add group".
- Product page: for a food item that is not a combo or by-amount, a checklist of groups in order ("Add-on groups").
- Till: an item with groups opens an add-on picker (one step per group like the combo picker; required groups cannot be skipped; prices shown; inactive options hidden) and a "Note" field (140). The cart line shows add-ons and the note; the receipt and kitchen slip print them.
- Kitchen page: add-ons under each line and the note in bold.

- [ ] **Step 1: Build the screens.**
- [ ] **Step 2: Run** `npx tsc --noEmit` and `npm run build` → green.
- [ ] **Step 3: Commit** `feat(food): add-on setup, till picker, and notes on screens`

---

### Task 8: Verify and hand over

- [ ] **Step 1: Run** `npx vitest run`, `npx tsc --noEmit`, `npm run build` → all green.
- [ ] **Step 2: Fresh review** of the branch diff; fix Critical and Important findings test-first.
- [ ] **Step 3: Write** `docs/superpowers/notes/phase-1b-4-handover.md`; commit.
