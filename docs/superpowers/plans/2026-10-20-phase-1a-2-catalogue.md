# Phase 1a · Plan 2 of 4: Catalogue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner or manager can build the shop's catalogue: products with variants, units and unit conversion, several barcodes per item, scale labels, tax rules, price lists with quantity breaks, tracking modes, bundles and recipes, and up to 5 photos per product stored as 20–30 KB WebP with metadata removed. Plan 3 (selling) can then look up a scanned code and resolve the price and tax of any line.

**Architecture:** Same shape as Plan 1. Pure rules (quantities, barcodes, scale labels, tax rates, price resolution, image size search) live in `src/lib/` with no server imports, so Plan 4 can run them on the device against the cached catalogue. Server services in `src/server/` take `db` and `ctx`, check permissions with `assertPermission`, and do all reads and writes inside `withTenant()`. Every link between catalogue rows is a composite `(tenant_id, id)` foreign key, so the database refuses a row that points at another shop's data even when a service forgets to check. Photos are compressed on the device with a canvas, then always re-compressed on the server with `sharp` and stored through a small `ImageStore` (local disk in development, a private Supabase Storage bucket in production).

**Tech Stack:** As Plan 1 (Next.js 16.4, Drizzle 0.45, PGlite for tests, postgres.js for Supabase, zod 4, Vitest 5) plus `sharp` (spec 11; already in `node_modules` as a Next.js optional dependency, now pinned).

**Spec:** `docs/superpowers/specs/2026-10-20-multishop-pos-design.md` (v4). Sections 4.1, 4.11, 4.13, 4.14, 4.15–4.18, 4.27, pseudocode 6.3, 6.4, 6.21, 6.22, records in section 7, acceptance tests in section 13. The roadmap is in `docs/superpowers/plans/2026-10-20-phase-1a-1-foundation.md`.

## Not in this plan

- **Stock:** opening stock (6.3), stock balances, stock movements, batch records, serial records, and weighted-average updates (6.23). These go to Plan 3, where opening stock is a stock receipt with reason `opening_stock`. This plan stores the tracking mode, the `average_cost` column, and the reorder level only.
- Suppliers on products → Plan 3 (receiving) and Phase 4.
- Linking a customer's price list, and a cashier switching the cart's list with permission → Plan 3 (customers arrive there).
- Add-on groups, combos, sell by amount, production recipes on standard items, and production (6.27) → Phase 1b.
- Gift card, coupon, and loyalty codes in the scan field → Phase 5. Barcode label printing → Phase 4. CSV import → Phase 1b. Camera scanning → Plan 3.
- Shop logo and cover images (they reuse `compressToTarget` with `COVER_IMAGE_SIZES`) and storefront refresh after a product change → Phase 2.
- Offline catalogue and photo cache → Plan 4.
- Plan-based module restrictions (spec 10.2 has not decided which plan includes which module).
- GRA E-VAT invoicing (spec 4.11, still open in 10.2).

## Global Constraints

Plan 1's Global Constraints still apply. The ones this plan leans on most, restated:

- Money is whole pesewas in integers; never floating point (spec 6.0). GHS 12.50 = 1250.
- `tenant_id` comes from the session (`ctx.tenantId`), never from the URL or request body (spec 3, 6.0).
- Every new table has a `tenant_id` column and an RLS policy keyed on `app.tenant_id`; `tests/db/rls.test.ts` fails otherwise.
- Shop data is read and written only through `withTenant()`. App code never reads the result of `tx.execute()`.
- Services return `{ ok: true, ... } | { ok: false, error }` for expected failures and throw only `AccessError` or programming errors. Every service that changes shop data calls `assertPermission(ctx, …)` first.
- Every file in `src/server/` and `src/db/` starts with `import 'server-only';`. Files in `src/lib/` never import server code.

New for this plan:

- **Quantities** are Postgres `numeric(14,3)` and travel through TypeScript as canonical strings with exactly 3 decimal places (`'1.250'`). Arithmetic on them uses `src/lib/decimal.ts` (BigInt), never `Number` (spec 6.0).
- **Stock is in base units.** `base_qty = quantity × unit.factor` (spec 6.0, 4.15). Every variant has exactly one base unit row with factor `1.000`; other units have factor > 1 and are sold in whole numbers only. Fractions are allowed only in the base unit, and only when the variant allows fractions.
- **Unit cost** is `average_cost numeric(14,4)`, pesewas per base unit. It is the one money column that is not a whole number, because one tablet out of a GHS 45.00 box of 1000 costs 4.5 pesewas. Prices, totals, and payments stay whole pesewas. Cost input is whole pesewas per base unit (spec 6.3).
- **Composite foreign keys:** every reference between catalogue rows (and from a price list to a branch) is `(tenant_id, x_id) → x(tenant_id, id)`.
- **Barcodes** are unique within a shop, and each points to one variant and one unit (spec 4.16). Stored and looked up in one normal form: trimmed, 1–64 printable ASCII characters, no spaces, and a 12-digit UPC-A code gets a leading `0` (EAN-13 form).
- **SKUs** are trimmed, uppercased, 1–40 printable ASCII characters with no spaces, and unique within a shop (spec 6.3).
- **Scale labels** are EAN-13 codes starting with `2`; the layout is set per shop; the check digit is verified. A weight label's value is grams, so the quantity is `value / 1000` in a `kg` base unit. A price label's value is pesewas, so the quantity is `round_3dp(value / base_price)` and the label price is the value (spec 4.16, 6.22).
- **Tax** rates are basis points (`1500` = 15%), entered by each shop. No rate is seeded or hard-coded (spec 4.11). A rule has a main rate, up to 5 levies, and a "VAT on levies" switch (the levies stack).
- **Price resolution** (spec 6.21): first live list among cart list → customer list → branch list → Retail list; in it, the item for this unit with the highest `min_quantity ≤ quantity`; else the unit's own price; else `base_price × unit.factor`.
- **Images** (spec 4.13, 6.4): WebP; hard maximum 30 KB = `30 * 1024` bytes; target floor 20 KB = `20 * 1024` bytes; longest side tried at 800, then 640, then 480 px, never enlarged; quality 0.85 first, then a search between 0.40 and 0.85 of at most 7 steps; JPEG, PNG, or WebP by content only; at most 10 MB = `10 * 1024 * 1024` bytes in and 40 million pixels; all metadata removed after applying camera rotation; at most 5 per product; `sort_order` 0 is the main photo.
- "Show on storefront" is off by default (spec 4.1).
- The `products` plan limit counts products whose status is `active`. It is checked before creating and before restoring a product (spec 4.27, 6.48).
- Every service that changes catalogue data writes exactly one audit row, in the same transaction. Action names are listed in each task.
- Modules (spec 4.14) only change what the catalogue pages show. Services never refuse a field because a module is off.

## Review Focus

Inputs the spec implies but does not spell out. Each has a test in the task named.

1. **Another shop's ids.** A form posting shop B's category, tax rule, unit, price list, component, or photo id while signed in to shop A must be refused, and the database must refuse it even if a service forgets. → Task 2 `composite keys stop links to another shop's rows`; Task 4 `refuses another shop's category or tax rule`; Task 5 `refuses components from another shop and fractions of whole items`; Task 7 `refuses another shop's unit or list`; Task 9 `never serves another shop's photo`.
2. **UPC-A and EAN-13 forms of one code.** Many scanners send `036000291452` for a can whose box says `0036000291452`. Both must find the same item, and saving both must count as a duplicate. → Task 1 `normalises barcodes`; Task 4 `rejects duplicate SKUs and barcodes within a shop, but not across shops`; Task 6 `finds a UPC-A code saved as EAN-13, and the other way round`.
3. **A shop barcode that looks like the shop's own scale labels** (13 digits starting with the layout prefix) would always be read as a scale label and never found. Saving such a barcode, or switching on a layout that clashes with saved barcodes, must be refused. → Task 3 `refuses a scale layout that clashes with saved barcodes`; Task 4 `refuses barcodes that look like the shop's scale labels`.
4. **An ended or not-yet-started price list** (a Christmas branch list, a weekend wholesale list) must stop setting prices on its end date and fall back to the next list in the chain, not to the bare unit price. → Task 7 `skips lists that are inactive, not started, or ended`.
5. **Archive and restore around the plan limit.** Archiving frees a place, so restoring an archived product while at the limit must be refused, or the limit can be dodged. → Task 4 `stops at the plan product limit, and restoring counts too`.

## File Structure

```text
src/lib/decimal.ts            quantity strings, base-unit maths, cost roll-up (BigInt)
src/lib/money.ts              + pesewasTimesQty()
src/lib/barcode.ts            normaliseBarcode, EAN-13 check digit, scale layouts and labels
src/lib/tax.ts                effectiveRateBp, parsePercent, chooseTaxRule
src/lib/pricing.ts            choosePriceList, resolvePrice (spec 6.21)
src/lib/images.ts             size limits, compressToTarget (spec 6.4), sniffImageType
src/lib/permissions.ts        + MODULES, Module
src/lib/permission-labels.ts  + MODULE_LABELS
src/db/schema/catalogue.ts    tax_rules, categories, products, variants, variant_units, barcodes, components,
                              price_lists, price_list_items, product_images
src/db/schema/tenancy.ts      + tenants.tax_enabled, tenants.scale_barcode, branches unique (tenant_id, id)
drizzle/0004_*.sql            generated tables; drizzle/0005_catalogue_rls.sql custom RLS
src/server/plan-limits.ts     + 'products'
src/server/tax-rules.ts       listTaxRules, saveTaxRule
src/server/shop-settings.ts   getSellingSettings, saveSellingSettings (tax switch, scale layout, modules)
src/server/products.ts        createProduct, updateProduct, setProductStatus, getProduct, searchCatalogue, categories
src/server/variants.ts        variants, units, barcodes, components, costOf
src/server/scan.ts            parseScannedCode (spec 6.22)
src/server/price-lists.ts     price lists, items, loadPriceRules, quotePrice
src/server/images.ts          processUpload (sharp)
src/server/image-store.ts     ImageStore: disk and Supabase Storage
src/server/product-images.ts  upload, remove, make main, read
src/components/photo-upload.tsx       device-side compression (canvas) and upload
src/app/[slug]/app/products/...       list, new, detail pages and actions
src/app/[slug]/app/price-lists/...    price lists page and actions
src/app/[slug]/app/images/[imageId]/route.ts   serves a product photo to signed-in staff
src/app/[slug]/app/settings/...       + selling settings and tax rules sections
tests/lib/{decimal,barcode,tax,pricing,images}.test.ts, tests/lib/money.test.ts (+), tests/lib/permissions.test.ts (+)
tests/db/catalogue-schema.test.ts
tests/server/{tax-rules,shop-settings,products,variants,scan,price-lists,images,image-store,product-images}.test.ts
tests/helpers/fixtures.ts     + WEIGHT_LAYOUT, PRICE_LAYOUT, productFor()
tests/helpers/image-store.ts  memoryImageStore()
```

---

### Task 1: Pure catalogue helpers

**Files:**
- Create: `src/lib/decimal.ts`, `src/lib/barcode.ts`, `src/lib/tax.ts`
- Modify: `src/lib/money.ts`, `src/lib/permissions.ts`, `src/lib/permission-labels.ts`, `tests/helpers/fixtures.ts` (two layout constants)
- Test: `tests/lib/decimal.test.ts`, `tests/lib/barcode.test.ts`, `tests/lib/tax.test.ts`, `tests/lib/money.test.ts`, `tests/lib/permissions.test.ts`

**Interfaces:**
- Produces:

```ts
// src/lib/decimal.ts — quantities are canonical 3-dp strings; costs are 4-dp strings
export function parseQuantity(input: string): string | null;   // '1.25' → '1.250'; ≥ 0; ≤ 3 dp; ≤ 11 integer digits
export function toMilli(q: string): bigint;                      // '1.250' → 1250n
export function fromMilli(m: bigint): string;                    // 1250n → '1.250'
export function isWhole(q: string): boolean;
export function validSaleQuantity(q: string | null, allowsFractions: boolean): boolean; // > 0 and (fractions allowed or whole)
export function multiplyQty(a: string, b: string): string;       // a × b, half up to 3 dp (base_qty = qty × factor)
export function ratioToQty(n: bigint, d: bigint): string;        // n / d, half up to 3 dp; d > 0
export function rollUpCost(parts: Array<{ quantity: string; cost: string }>): string; // Σ qty × cost, half up to 4 dp
// src/lib/money.ts
export function pesewasTimesQty(pesewas: number, qty: string): number; // whole pesewas, half up
// src/lib/barcode.ts
export type ScaleLayout = { prefix: string; itemStart: number; itemLength: number; valueStart: number; valueLength: number; carries: 'weight' | 'price' };
export function normaliseBarcode(input: string): string | null;
export function ean13CheckDigit(first12: string): string;
export function ean13Valid(code: string): boolean;
export function validScaleLayout(layout: ScaleLayout): boolean;
export function matchesScaleLayout(code: string, layout: ScaleLayout | null): boolean; // 13 digits starting with prefix
export function readScaleLabel(code: string, layout: ScaleLayout | null): { itemCode: number; value: number } | 'bad_check_digit' | null;
// src/lib/tax.ts
export type Levy = { name: string; rateBp: number };
export type TaxRates = { rateBp: number; levies: Levy[]; vatOnLevies: boolean };
export function effectiveRateBp(rates: TaxRates): number;
export function parsePercent(input: string): number | null;      // '2.5' → 250; 0–100, ≤ 2 dp
export function chooseTaxRule<R extends { id: string; isDefault: boolean }>(taxEnabled: boolean, productTaxRuleId: string | null, rules: R[]): R | null;
// src/lib/permissions.ts
export const MODULES = ['batches', 'serials', 'price_lists', 'scale_barcodes', 'units', 'recipes', 'prescriptions', 'addons', 'tickets', 'kitchen'] as const;
export type Module = (typeof MODULES)[number];
// tests/helpers/fixtures.ts
export const WEIGHT_LAYOUT: ScaleLayout = { prefix: '21', itemStart: 2, itemLength: 5, valueStart: 7, valueLength: 5, carries: 'weight' };
export const PRICE_LAYOUT: ScaleLayout = { prefix: '22', itemStart: 2, itemLength: 5, valueStart: 7, valueLength: 5, carries: 'price' };
```

**Rules:**
- `normaliseBarcode`: trim; must match `/^[\x21-\x7E]{1,64}$/`; a code of exactly 12 digits gets a leading `0`.
- `validScaleLayout`: `prefix` matches `/^2\d?$/`; `itemStart ≥ prefix.length`; both lengths 1–6; item and value ranges do not overlap; each range ends at or before index 12 (index 12 is the check digit). Positions are 0-based.
- `readScaleLabel`: `null` when there is no layout, or the code is not 13 digits starting with the prefix. `'bad_check_digit'` when it matches but the check digit is wrong. Otherwise the item and value digits as integers.
- `effectiveRateBp`: `L = Σ levies`. Without VAT on levies: `L + rateBp`. With it: `L + round(rateBp × (10000 + L) / 10000)`.
- `chooseTaxRule`: `null` when tax is off; else the product's rule; else the shop's default rule; else `null`.
- `MODULE_LABELS: Record<Module, string>`: batches "Batch and expiry tracking", serials "Serial and IMEI numbers", price_lists "Price lists", scale_barcodes "Scale labels", units "Pharmacy units (pack, strip, tablet)", recipes "Recipes", prescriptions "Prescriptions", addons "Add-ons", tickets "Open tickets", kitchen "Kitchen printing".

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/decimal.test.ts
it('parses quantities to 3 decimal places', () => {
  expect(parseQuantity('1.25')).toBe('1.250');
  expect(parseQuantity(' 2 ')).toBe('2.000');
  for (const bad of ['0.0005', '-1', '1e3', '1,5', '', '100000000000']) expect(parseQuantity(bad), bad).toBeNull();
});
it('converts units to base units exactly', () => {
  expect(multiplyQty('1.000', '24.000')).toBe('24.000');   // 1 carton = 24 pieces
  expect(multiplyQty('1.000', '10.000')).toBe('10.000');   // 1 strip = 10 tablets
  expect(multiplyQty('0.333', '1.500')).toBe('0.500');     // 0.4995 rounds half up
});
it('divides into a quantity, rounding half up', () => {
  expect(ratioToQty(2n, 3n)).toBe('0.667');
  expect(ratioToQty(1n, 2000n)).toBe('0.001');
});
it('checks sale quantities', () => {
  expect(validSaleQuantity('1.250', true)).toBe(true);
  expect(validSaleQuantity('1.250', false)).toBe(false);
  expect(validSaleQuantity('0.000', true)).toBe(false);
  expect(validSaleQuantity(null, true)).toBe(false);
});
it('rolls up component costs to 4 places', () => {
  expect(rollUpCost([{ quantity: '0.250', cost: '1200.0000' }, { quantity: '0.050', cost: '3000.0000' }, { quantity: '1.000', cost: '1500.0000' }])).toBe('1950.0000');
  expect(rollUpCost([{ quantity: '3.000', cost: '416.6667' }])).toBe('1250.0001');
});
// tests/lib/money.test.ts (add)
it('prices a quantity in whole pesewas, rounding half up', () => {
  expect(pesewasTimesQty(500, '24.000')).toBe(12000);
  expect(pesewasTimesQty(1999, '0.250')).toBe(500);        // 499.75
  expect(pesewasTimesQty(1, '0.500')).toBe(1);
});
// tests/lib/barcode.test.ts
it('normalises barcodes', () => {
  expect(normaliseBarcode(' 6001234567890\r\n')).toBe('6001234567890');
  expect(normaliseBarcode('036000291452')).toBe('0036000291452');
  expect(normaliseBarcode('0036000291452')).toBe('0036000291452');
  for (const bad of ['', 'ABC 123', 'x'.repeat(65)]) expect(normaliseBarcode(bad), bad).toBeNull();
});
it('checks EAN-13 check digits', () => {
  expect(ean13CheckDigit('400638133393')).toBe('1');
  expect(ean13Valid('4006381333931')).toBe(true);
  expect(ean13Valid('4006381333932')).toBe(false);
});
it('reads weight and price labels', () => {
  expect(readScaleLabel('2100123012503', WEIGHT_LAYOUT)).toEqual({ itemCode: 123, value: 1250 });
  expect(readScaleLabel('2200456007501', PRICE_LAYOUT)).toEqual({ itemCode: 456, value: 750 });
});
it('rejects a label with a wrong check digit and ignores other codes', () => {
  expect(readScaleLabel('2100123012504', WEIGHT_LAYOUT)).toBe('bad_check_digit');
  expect(readScaleLabel('6001234567890', WEIGHT_LAYOUT)).toBeNull();
  expect(readScaleLabel('2100123012503', null)).toBeNull();
  expect(matchesScaleLayout('2100000000000', WEIGHT_LAYOUT)).toBe(true);
});
it('validates layouts', () => {
  expect(validScaleLayout(WEIGHT_LAYOUT)).toBe(true);
  expect(validScaleLayout({ ...WEIGHT_LAYOUT, prefix: '3' })).toBe(false);
  expect(validScaleLayout({ ...WEIGHT_LAYOUT, valueStart: 5 })).toBe(false);    // overlaps item
  expect(validScaleLayout({ ...WEIGHT_LAYOUT, valueLength: 6 })).toBe(false);   // reaches the check digit
  expect(validScaleLayout({ ...WEIGHT_LAYOUT, itemStart: 1 })).toBe(false);     // overlaps prefix
});
// tests/lib/tax.test.ts — example rates only; real rates are entered by each shop
const levies = [{ name: 'NHIL', rateBp: 250 }, { name: 'GETFund', rateBp: 250 }, { name: 'COVID-19', rateBp: 100 }];
it('works out the effective rate in basis points', () => {
  expect(effectiveRateBp({ rateBp: 1500, levies: [], vatOnLevies: false })).toBe(1500);
  expect(effectiveRateBp({ rateBp: 1500, levies, vatOnLevies: false })).toBe(2100);
  expect(effectiveRateBp({ rateBp: 1500, levies, vatOnLevies: true })).toBe(2190);
});
it('parses percentages to basis points', () => {
  expect(parsePercent('15')).toBe(1500);
  expect(parsePercent('2.5')).toBe(250);
  for (const bad of ['12.345', '101', '-1', 'abc', '']) expect(parsePercent(bad), bad).toBeNull();
});
it('uses the product rule, then the shop default, and nothing when tax is off', () => {
  const rules = [{ id: 'vat', isDefault: true }, { id: 'exempt', isDefault: false }];
  expect(chooseTaxRule(true, 'exempt', rules)?.id).toBe('exempt');
  expect(chooseTaxRule(true, null, rules)?.id).toBe('vat');
  expect(chooseTaxRule(false, 'exempt', rules)).toBeNull();
});
// tests/lib/permissions.test.ts (add)
it('every default module is a known module', () => {
  for (const list of Object.values(DEFAULT_MODULES)) for (const m of list) expect(MODULES).toContain(m);
});
```

- [ ] **Step 2: Run the tests to verify they fail.** Run: `npx vitest run tests/lib` → FAIL, missing exports.
- [ ] **Step 3: Implement** the files above following the rules. `decimal.ts` works on `bigint` milli-units; half-up division of non-negative values is `(2n * n + d) / (2n * d)`.
- [ ] **Step 4: Run the tests to verify they pass.** Run: `npx vitest run tests/lib` → all passed.
- [ ] **Step 5: Commit**

```bash
git add src/lib tests/lib tests/helpers/fixtures.ts
git commit -m "feat(lib): add quantity, barcode, scale label, and tax helpers"
```

---

### Task 2: Catalogue schema and row-level security

**Files:**
- Create: `src/db/schema/catalogue.ts`; `drizzle/0004_*.sql` (generated); `drizzle/0005_catalogue_rls.sql` (custom)
- Modify: `src/db/schema/index.ts` (re-export), `src/db/schema/tenancy.ts`
- Test: `tests/db/catalogue-schema.test.ts`

**Interfaces:**
- Consumes: `id`, `createdAt` (columns.ts); `tenants`, `branches`; `ScaleLayout`, `Levy` (Task 1).
- Produces: Drizzle tables `taxRules, categories, products, variants, variantUnits, barcodes, components, priceLists, priceListItems, productImages`; columns `tenants.taxEnabled`, `tenants.scaleBarcode`; and

```ts
export type Tracking = 'none' | 'batch' | 'serial';
export type VariantKind = 'standard' | 'bundle' | 'recipe';
export type CatalogueStatus = 'active' | 'archived';
export type PriceListKind = 'retail' | 'wholesale' | 'customer_group' | 'branch';
```

**Columns.** Every table also has `id` (uuid pk), `tenant_id uuid nn → tenants(id)`, and `created_at`. Quantities are `numeric(14,3)`, `average_cost` is `numeric(14,4)`, dates are `date({ mode: 'string' })`. "uq (tenant_id, id)" means a unique constraint other tables point composite foreign keys at. Name every constraint explicitly; names stay under 63 characters.

| Table | Columns and constraints |
| --- | --- |
| `tax_rules` | `name text nn`, `rate_bp integer nn check 0–10000`, `levies jsonb nn default '[]'` (`Levy[]`), `vat_on_levies boolean nn default false`, `is_default boolean nn default false`, `active boolean nn default true`; uq (tenant_id, id); unique index (tenant_id, lower(name)); unique index (tenant_id) where is_default; check `not (is_default and not active)` |
| `categories` | `name text nn`; uq (tenant_id, id); unique index (tenant_id, lower(name)) |
| `products` | `name text nn`, `description text`, `category_id uuid`, `brand text`, `tax_rule_id uuid` (null = shop default), `tracking text nn default 'none'` check (none, batch, serial), `status text nn default 'active'` check (active, archived), `show_on_storefront boolean nn default false`, `featured boolean nn default false`, `generic_name text`, `strength text`, `dosage_form text`, `registration_number text`, `prescription_only boolean nn default false`; uq (tenant_id, id); FK (tenant_id, category_id) → categories; FK (tenant_id, tax_rule_id) → tax_rules |
| `variants` | `product_id uuid nn`, `kind text nn default 'standard'` check (standard, bundle, recipe), `name text nn default ''` (option label such as "Red, Large"; empty for a single variant), `sku text`, `allows_fractions boolean nn default false`, `base_price_pesewas integer nn check ≥ 0`, `average_cost numeric(14,4) nn default '0' check ≥ 0`, `reorder_level numeric(14,3) check ≥ 0`, `scale_item_code integer check > 0`, `sellable boolean nn default true`, `status text nn default 'active'` check (active, archived); uq (tenant_id, id); unique (tenant_id, sku); unique (tenant_id, scale_item_code); FK (tenant_id, product_id) → products |
| `variant_units` | `variant_id uuid nn`, `name text nn`, `factor numeric(14,3) nn`, `price_pesewas integer check ≥ 0`, `sellable boolean nn default true`, `purchasable boolean nn default true`, `is_base boolean nn default false`; uq (tenant_id, variant_id, id); unique index (variant_id) where is_base; unique index (variant_id, lower(name)); check `(is_base and factor = 1 and price_pesewas is null) or (not is_base and factor > 1)`; FK (tenant_id, variant_id) → variants |
| `barcodes` | `variant_id uuid nn`, `unit_id uuid nn`, `code text nn`; unique (tenant_id, code); FK (tenant_id, variant_id, unit_id) → variant_units (tenant_id, variant_id, id) on delete cascade |
| `components` | `parent_variant_id uuid nn`, `component_variant_id uuid nn`, `quantity numeric(14,3) nn check > 0` (component base units); unique (parent_variant_id, component_variant_id); check parent ≠ component; FK (tenant_id, parent_variant_id) → variants; FK (tenant_id, component_variant_id) → variants |
| `price_lists` | `name text nn`, `kind text nn` check (retail, wholesale, customer_group, branch), `branch_id uuid`, `starts_on date`, `ends_on date`, `active boolean nn default true`; uq (tenant_id, id); unique index (tenant_id) where kind = 'retail'; unique index (tenant_id, branch_id) where kind = 'branch'; check `(kind = 'branch') = (branch_id is not null)`; check `kind <> 'retail' or (starts_on is null and ends_on is null)`; check `ends_on >= starts_on`; FK (tenant_id, branch_id) → branches (tenant_id, id) |
| `price_list_items` | `price_list_id uuid nn`, `variant_id uuid nn`, `unit_id uuid nn`, `min_quantity numeric(14,3) nn default '1' check > 0` (in the unit sold), `price_pesewas integer nn check ≥ 0`; unique (price_list_id, unit_id, min_quantity); FK (tenant_id, price_list_id) → price_lists on delete cascade; FK (tenant_id, variant_id, unit_id) → variant_units on delete cascade |
| `product_images` | `product_id uuid nn`, `storage_key text nn unique`, `bytes integer nn check 1–30720`, `width integer nn`, `height integer nn`, `sort_order integer nn check 0–4`; FK (tenant_id, product_id) → products |
| `tenants` (add) | `tax_enabled boolean nn default false`, `scale_barcode jsonb` (`ScaleLayout`, null = no scale labels) |
| `branches` (add) | uq (tenant_id, id) |

- [ ] **Step 1: Write the failing test** in `tests/db/catalogue-schema.test.ts`

The file defines `seedCatalogueRows(db, shop)`, which inserts through `asPlatform` (owner role, so RLS does not apply but foreign keys still do): one tax rule, one category, one product, two variants (a `bundle` parent and a `standard` part) with a base unit each, one barcode, one component, one Retail price list with one item, and one product image. It returns `{ productId, bundleVariantId, partVariantId, partUnitId }`.

```ts
// beforeEach: fresh db; a = seedShop(db, { slug: 'shop-a' }); b = seedShop(db, { slug: 'shop-b' }); ra = seedCatalogueRows(db, a); rb = seedCatalogueRows(db, b)
it("each shop sees only its own catalogue rows", async () => {
  const expected = new Map([[taxRules, 1], [categories, 1], [products, 1], [variants, 2], [variantUnits, 2], [barcodes, 1],
    [components, 1], [priceLists, 1], [priceListItems, 1], [productImages, 1]]);
  for (const [t, n] of expected) expect(await withTenant(db, a.tenantId, (tx) => tx.select().from(t)), getTableName(t)).toHaveLength(n);
});
it("composite keys stop links to another shop's rows", async () => {
  expect(await dbError(asPlatform(db, (tx) => tx.insert(variants)
    .values({ tenantId: a.tenantId, productId: rb.productId, basePricePesewas: 100 })))).toMatch(/foreign key/);
  expect(await dbError(asPlatform(db, (tx) => tx.insert(barcodes)
    .values({ tenantId: a.tenantId, variantId: ra.partVariantId, unitId: rb.partUnitId, code: 'X1' })))).toMatch(/foreign key/);
  expect(await dbError(asPlatform(db, (tx) => tx.insert(priceLists)
    .values({ tenantId: a.tenantId, name: 'B branch', kind: 'branch', branchId: b.branchId })))).toMatch(/foreign key/);
});
it('a barcode is unique within a shop but may repeat across shops', async () => {
  // insert the code seeded in shop B into shop A → ok; insert it again in shop A → /duplicate key/
});
it('keeps one base unit per variant, one Retail list per shop, and base units at factor 1', async () => {
  // second is_base unit for ra.partVariantId → /duplicate key/; second retail list → /duplicate key/;
  // non-base unit with factor '1' → /check constraint/
});
```

- [ ] **Step 2: Run the test to verify it fails.** Run: `npx vitest run tests/db/catalogue-schema.test.ts` → FAIL, missing exports.
- [ ] **Step 3: Write the schema and generate `0004`.** Use the table above. Composite keys use Drizzle's `foreignKey({ name, columns: [t.tenantId, t.x], foreignColumns: [x.tenantId, x.id] })`. Run: `npm run db:generate` → creates `drizzle/0004_*.sql`.
- [ ] **Step 4: Write `drizzle/0005_catalogue_rls.sql`.** Run `npx drizzle-kit generate --custom --name catalogue_rls`. For each of the 10 new tables, add the same two statements as `drizzle/0002_rls.sql` uses for `branches`:

```sql
ALTER TABLE tax_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tax_rules USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

`0000_roles.sql` already grants `pos_app` access to new tables through default privileges.

- [ ] **Step 5: Run the database tests.** Run: `npx vitest run tests/db` → all passed (including `every table in the public schema has RLS enabled`).
- [ ] **Step 6: Commit**

```bash
git add src/db drizzle tests/db
git commit -m "feat(db): add catalogue tables with tenant-scoped keys and row-level security"
```

---

### Task 3: Tax rules and selling settings

**Files:**
- Create: `src/server/tax-rules.ts`, `src/server/shop-settings.ts`
- Modify: `src/app/[slug]/app/settings/page.tsx` and `actions.ts` (two new sections)
- Test: `tests/server/tax-rules.test.ts`, `tests/server/shop-settings.test.ts`

**Interfaces:**
- Consumes: `taxRules`, `tenants`, `barcodes`, `products` (Task 2); `TaxRates`, `parsePercent`, `validScaleLayout`, `matchesScaleLayout`, `MODULES`, `MODULE_LABELS` (Task 1); `withTenant`, `assertPermission`, `writeAudit`.
- Produces:

```ts
// src/server/tax-rules.ts
export type TaxRule = typeof taxRules.$inferSelect;
export type TaxRuleInput = TaxRates & { name: string; isDefault: boolean; active: boolean };
export function listTaxRules(db: Db, ctx: Ctx): Promise<TaxRule[]>;            // any signed-in member; ordered by name
export function saveTaxRule(db: Db, ctx: Ctx, input: TaxRuleInput & { id?: string }):
  Promise<{ ok: true; taxRuleId: string } | { ok: false; error: 'invalid_input' | 'not_found' | 'duplicate_name' | 'in_use' }>;
// src/server/shop-settings.ts
export type SellingSettings = { taxEnabled: boolean; scaleLayout: ScaleLayout | null; modules: Module[] };
export function getSellingSettings(db: Db, ctx: Ctx): Promise<SellingSettings>; // any signed-in member
export function saveSellingSettings(db: Db, ctx: Ctx, input: SellingSettings):
  Promise<{ ok: true } | { ok: false; error: 'invalid_input' } | { ok: false; error: 'barcodes_clash'; codes: string[] }>;
```

**Rules:**
- Both save functions require `manage_shop_settings`.
- Tax rule: name 1–60 characters; `rateBp` and each levy `rateBp` are integers 0–10000; at most 5 levies, each with a name of 1–40 characters. A name already used in the shop (case-insensitive) → `duplicate_name`. An inactive rule cannot be the default → `invalid_input`.
- Saving a rule with `isDefault: true` clears the flag on the others in the same transaction.
- Switching off a rule that any product uses → `in_use`.
- Audit: `tax_rule_saved` (record `tax_rule`), `selling_settings_saved`.
- Selling settings: modules must be in `MODULES` (duplicates removed); a layout must pass `validScaleLayout`. When a layout is set, look for saved barcodes it would capture (`matchesScaleLayout`). If there are any, return `barcodes_clash` with up to 5 of them and save nothing.

**UI copy** (settings page):

| Case | Message |
| --- | --- |
| `barcodes_clash` | `These barcodes would be read as scale labels: ${codes.join(', ')}. Change them or use another prefix.` |
| `duplicate_name` | "A tax rule with that name already exists." |
| `in_use` | "Products use this rule. Move them to another rule first." |
| `invalid_input` | "Check the details." |

- [ ] **Step 1: Write the failing tests**

```ts
// tests/server/tax-rules.test.ts — shop with owner and manager (manager lacks manage_shop_settings)
const vat = { name: 'VAT', rateBp: 1500, levies: [{ name: 'NHIL', rateBp: 250 }], vatOnLevies: false, isDefault: true, active: true };
it('saves a rule with levies and keeps a single default', async () => {
  const first = await saveTaxRule(db, owner, vat) as { taxRuleId: string };
  await saveTaxRule(db, owner, { ...vat, name: 'Exempt', rateBp: 0, levies: [] });
  const rules = await listTaxRules(db, owner);
  expect(rules.filter((r) => r.isDefault).map((r) => r.name)).toEqual(['Exempt']);
  expect(rules.find((r) => r.id === first.taxRuleId)).toMatchObject({ rateBp: 1500, levies: [{ name: 'NHIL', rateBp: 250 }] });
});
it('rejects bad rates, too many levies, and duplicate names', async () => {
  expect(await saveTaxRule(db, owner, { ...vat, rateBp: 10001 })).toEqual({ ok: false, error: 'invalid_input' });
  expect(await saveTaxRule(db, owner, { ...vat, levies: Array(6).fill({ name: 'L', rateBp: 1 }) })).toEqual({ ok: false, error: 'invalid_input' });
  expect(await saveTaxRule(db, owner, { ...vat, isDefault: true, active: false })).toEqual({ ok: false, error: 'invalid_input' });
  await saveTaxRule(db, owner, vat);
  expect(await saveTaxRule(db, owner, { ...vat, name: 'vat' })).toEqual({ ok: false, error: 'duplicate_name' });
});
it('will not switch off a rule that products use', async () => {
  // insert a product with taxRuleId = rule via asPlatform; save the rule with active false → { ok: false, error: 'in_use' }
});
it('needs manage_shop_settings', async () => { await expectAccess(saveTaxRule(db, manager, vat), 'forbidden'); });
// tests/server/shop-settings.test.ts
it('saves the tax switch, scale layout, and modules', async () => {
  expect(await saveSellingSettings(db, owner, { taxEnabled: true, scaleLayout: WEIGHT_LAYOUT, modules: ['batches', 'scale_barcodes', 'batches'] })).toEqual({ ok: true });
  expect(await getSellingSettings(db, owner)).toEqual({ taxEnabled: true, scaleLayout: WEIGHT_LAYOUT, modules: ['batches', 'scale_barcodes'] });
});
it('rejects unknown modules and malformed layouts', async () => {
  expect(await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: null, modules: ['fly' as Module] })).toEqual({ ok: false, error: 'invalid_input' });
  expect(await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: { ...WEIGHT_LAYOUT, prefix: '9' }, modules: [] })).toEqual({ ok: false, error: 'invalid_input' });
});
it('refuses a scale layout that clashes with saved barcodes', async () => {
  // insert a product, variant, base unit, and barcode '2100123012503' via asPlatform
  expect(await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: WEIGHT_LAYOUT, modules: [] }))
    .toEqual({ ok: false, error: 'barcodes_clash', codes: ['2100123012503'] });
  expect((await getSellingSettings(db, owner)).scaleLayout).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail.** Run: `npx vitest run tests/server/tax-rules.test.ts tests/server/shop-settings.test.ts` → FAIL.
- [ ] **Step 3: Implement** both services following the rules.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: all passed.
- [ ] **Step 5: Build the settings sections**

- **Selling:** a "Charge tax" checkbox (unticked means no tax on any sale). Scale labels: Off / Weight / Price, then prefix, item code digits (start, length) and value digits (start, length), shown 1-based to people and stored 0-based. Module checkboxes with `MODULE_LABELS`.
- **Tax rules:** a table of rules with the effective rate (`effectiveRateBp / 100` %). An add/edit form with name, rate %, up to 3 levy name/rate pairs (the service allows 5), "VAT is charged on the levies too", "Default for products", and "Active". Percentages go through `parsePercent`.

Run: `npm run build` → compiles.

- [ ] **Step 6: Commit**

```bash
git add src/server/tax-rules.ts src/server/shop-settings.ts "src/app/[slug]/app/settings" tests/server
git commit -m "feat(settings): add tax rules, tax switch, scale label layout, and module switches"
```

---

### Task 4: Products

**Files:**
- Create: `src/server/products.ts`; `src/app/[slug]/app/products/page.tsx`, `new/page.tsx`, `[productId]/page.tsx`, and an `actions.ts` beside each page that has forms
- Modify: `src/server/plan-limits.ts`, `src/app/[slug]/app/page.tsx` (Products link for `manage_products`), `tests/helpers/fixtures.ts` (`productFor`)
- Test: `tests/server/products.test.ts`

**Interfaces:**
- Consumes: Task 2 tables; `normaliseBarcode`, `matchesScaleLayout`, `parseQuantity` (Task 1); `saveSellingSettings`, `WEIGHT_LAYOUT`, `PRICE_LAYOUT` (Tasks 1 and 3, in tests); `lockTenant`, `checkPlanLimit`.
- Produces:

```ts
// src/server/plan-limits.ts
export type LimitedResource = 'branches' | 'registers' | 'staff' | 'products'; // products counts status 'active'
// src/server/products.ts
export type PharmacyFields = { genericName?: string; strength?: string; dosageForm?: string; registrationNumber?: string; prescriptionOnly?: boolean };
export type ProductFields = { name: string; description?: string; categoryId?: string | null; brand?: string; taxRuleId?: string | null;
  tracking: Tracking; showOnStorefront?: boolean; featured?: boolean; pharmacy?: PharmacyFields };
export type NewVariantInput = { name?: string; sku?: string; barcodes?: string[]; basePricePesewas: number; costPesewas: number;
  reorderLevel?: string; scaleItemCode?: number };
export type NewProductInput = ProductFields & { kind: VariantKind; baseUnit: string; allowsFractions: boolean; variants: NewVariantInput[] };
export type CatalogueError = 'invalid_input' | 'duplicate_sku' | 'duplicate_barcode' | 'looks_like_scale_label' | 'duplicate_scale_code' | 'scale_not_set_up';
export type ProductError = CatalogueError | 'limit_reached' | 'unknown_category' | 'unknown_tax_rule';
export type Fail<E> = { ok: false; error: E; detail?: string }; // detail = the offending SKU, barcode, or scale code
export function createProduct(db: Db, ctx: Ctx, input: NewProductInput):
  Promise<{ ok: true; productId: string; variants: Array<{ variantId: string; baseUnitId: string }> } | Fail<ProductError>>;
export function updateProduct(db: Db, ctx: Ctx, productId: string, input: ProductFields): Promise<{ ok: true } | Fail<ProductError | 'not_found'>>;
export function setProductStatus(db: Db, ctx: Ctx, productId: string, status: CatalogueStatus): Promise<{ ok: true } | Fail<'not_found' | 'limit_reached'>>;
export type ProductDetail = typeof products.$inferSelect & {
  categoryName: string | null;
  variants: Array<typeof variants.$inferSelect & {
    units: Array<typeof variantUnits.$inferSelect & { barcodes: Array<{ id: string; code: string }> }>;
    components: Array<{ id: string; variantId: string; name: string; quantity: string; baseUnit: string }>;
  }>;
  images: Array<{ id: string; sortOrder: number; bytes: number; width: number; height: number }>; // by sort_order
};
export function getProduct(db: Db, ctx: Ctx, productId: string): Promise<ProductDetail | null>;   // manage_products
export type CatalogueHit = { productId: string; variantId: string; productName: string; variantName: string; sku: string | null;
  basePricePesewas: number; baseUnit: string; status: CatalogueStatus; mainImageId: string | null };
export function searchCatalogue(db: Db, ctx: Ctx, opts: { query?: string; status?: CatalogueStatus; categoryId?: string; limit?: number; offset?: number }):
  Promise<CatalogueHit[]>;                                                                          // any signed-in member
export function listCategories(db: Db, ctx: Ctx): Promise<Array<{ id: string; name: string }>>;  // any signed-in member
export function addCategory(db: Db, ctx: Ctx, name: string): Promise<{ ok: true; categoryId: string } | Fail<'invalid_input' | 'duplicate_name'>>;
// tests/helpers/fixtures.ts
export function productFor(db: Db, ctx: Ctx, overrides?: Partial<NewProductInput>): Promise<{ productId: string; variantId: string; baseUnitId: string }>;
// defaults: name `Item ${n}`, kind 'standard', tracking 'none', baseUnit 'piece', allowsFractions false,
// variants [{ basePricePesewas: 500, costPesewas: 400 }]; throws when createProduct fails
```

**Rules (spec 6.3):**
- Writes require `manage_products`. Each write runs in one `withTenant` transaction that starts with `lockTenant`, so two simultaneous saves cannot both pass the limit or a uniqueness check.
- Lengths after trimming: name 1–120; description ≤ 2000; brand, base unit, variant name, category, and pharmacy text fields ≤ 60. Prices and costs are integers 0–2,000,000,000. 1–50 variants; ≤ 10 barcodes per variant.
- SKUs and barcodes follow the Global Constraints. A duplicate within the request or the shop returns `duplicate_sku` / `duplicate_barcode` with `detail`. A barcode the shop's layout would capture returns `looks_like_scale_label`.
- `tracking: 'serial'` needs `allowsFractions: false`. `kind` bundle or recipe needs `tracking: 'none'` and no scale code.
- A scale code needs a saved layout (`scale_not_set_up`). It must be below `10 ** layout.itemLength`, the variant kind must be `standard` with tracking other than `serial`, and `allowsFractions` must be on (both label kinds give fractional quantities). A weight layout also needs base unit `kg`; a price layout needs `basePricePesewas > 0`. A code already used returns `duplicate_scale_code`.
- `categoryId` / `taxRuleId` must be visible to the shop; otherwise `unknown_category` / `unknown_tax_rule`. A tax rule must also be active.
- `createProduct` inserts the product, each variant (kind, fractions, and base unit copied to every variant; `average_cost = costPesewas`), one base unit row per variant (`is_base`, factor `1`), and the barcodes on the base unit. `limit_reached` comes from `checkPlanLimit(tx, tenantId, 'products')`.
- `updateProduct` applies the same tracking rules against the product's saved variants. Kind cannot change.
- `setProductStatus('active')` on an archived product checks the plan limit first.
- `getProduct` orders variants by creation, units base first and then by creation, and photos by `sort_order`. It returns `null` for a product the shop cannot see.
- `searchCatalogue`: default status `active`, limit 50 (max 200), ordered by product name and then variant creation. A row matches when any of these hold:
  - product name, generic name, brand, variant name, SKU, or category name contains the query (case-insensitive, with `%`, `_`, and `\` escaped);
  - the query, after `normaliseBarcode`, equals one of the variant's barcodes.
- Audit actions: `product_created`, `product_updated` (changes = names of changed fields), `product_archived`, `product_restored`, `category_added`.

**UI copy:**

| Error | Message |
| --- | --- |
| `limit_reached` | "Your plan allows no more products. Upgrade to add more." |
| `duplicate_sku` | `SKU ${detail} is already used in this shop.` |
| `duplicate_barcode` | `Barcode ${detail} is already used in this shop.` |
| `looks_like_scale_label` | `Barcode ${detail} looks like one of your scale labels. Use a different code.` |
| `duplicate_scale_code` | `Scale item code ${detail} is already used.` |
| `scale_not_set_up` | "Set up scale labels in Settings first." |
| `unknown_category` / `unknown_tax_rule` | "Choose a category." / "Choose a tax rule." |
| `invalid_input` | "Check the details." |

- [ ] **Step 1: Write the failing tests** in `tests/server/products.test.ts`

```ts
// shop with owner and cashier kofi; owner = await ctxFor(db, shop, 'owner', t0)
it('creates a product with its default variant, base unit, and barcode', async () => {
  const r = await createProduct(db, owner, { name: 'Milo 400g', kind: 'standard', tracking: 'none', baseUnit: 'piece', allowsFractions: false,
    variants: [{ sku: 'milo-400', barcodes: ['6001234567890'], basePricePesewas: 4500, costPesewas: 3800 }] }) as { productId: string };
  expect(await getProduct(db, owner, r.productId)).toMatchObject({ name: 'Milo 400g', status: 'active', showOnStorefront: false,
    variants: [{ sku: 'MILO-400', basePricePesewas: 4500, averageCost: '3800.0000',
      units: [{ name: 'piece', factor: '1.000', isBase: true, barcodes: [{ code: '6001234567890' }] }] }] });
  // exactly one audit row with action 'product_created'
});
it('rejects duplicate SKUs and barcodes within a shop, but not across shops', async () => {
  await productFor(db, owner, { variants: [{ sku: 'A1', barcodes: ['036000291452'], basePricePesewas: 1, costPesewas: 1 }] });
  expect(await createProduct(db, owner, input({ sku: 'a1' }))).toEqual({ ok: false, error: 'duplicate_sku', detail: 'A1' });
  expect(await createProduct(db, owner, input({ barcodes: ['0036000291452'] }))).toEqual({ ok: false, error: 'duplicate_barcode', detail: '0036000291452' });
  expect(await createProduct(db, otherShopOwner, input({ sku: 'A1', barcodes: ['036000291452'] }))).toMatchObject({ ok: true });
});
it('rejects two variants sharing a barcode in one request', async () => { /* → duplicate_barcode */ });
it("refuses barcodes that look like the shop's scale labels", async () => {
  await saveSellingSettings(db, owner, { taxEnabled: false, scaleLayout: WEIGHT_LAYOUT, modules: [] });
  expect(await createProduct(db, owner, input({ barcodes: ['2100123012503'] }))).toEqual({ ok: false, error: 'looks_like_scale_label', detail: '2100123012503' });
});
it('validates tracking, kind, price, and scale rules', async () => {
  // serial + allowsFractions → invalid_input; bundle + tracking batch → invalid_input; basePricePesewas -1 or 1.5 → invalid_input
  // scaleItemCode 123 with no layout → scale_not_set_up
  // weight layout: base unit 'piece' or allowsFractions false → invalid_input; base 'kg' + fractions → ok; code 100000 → invalid_input
  // price layout: basePricePesewas 0 → invalid_input; allowsFractions false → invalid_input
});
it('stops at the plan product limit, and restoring counts too', async () => {
  // trial plan (products: 500): insert 499 active products via asPlatform in one insert; create #500 → ok; next → limit_reached
  // archive one → create → ok; restore the archived one → { ok: false, error: 'limit_reached' }
});
it("refuses another shop's category or tax rule", async () => { /* ids from other shop → unknown_category, unknown_tax_rule */ });
it('searches by name, generic name, SKU, barcode, and category, treating % and _ literally', async () => {
  // products 'Paracetamol 500mg' (generic 'acetaminophen'), '50% Off Soap', 'Milk' (category 'Dairy', barcode '036000291452')
  // 'acetamin' → Paracetamol; '50%' → only the soap; '_' → none; 'dairy' → Milk; '0036000291452' → Milk
});
it('archives and restores', async () => { /* archived product missing from default search, present with status 'archived' */ });
it('cashiers and read-only shops cannot change products', async () => {
  await expectAccess(createProduct(db, await ctxFor(db, shop, 'kofi', t0), input({})), 'forbidden');
  // shop with subscription { status: 'active', endDate: '2026-09-01' } → owner createProduct → 'read_only'
});
```

(`input(v)` in the test file builds a one-variant `NewProductInput` with variant fields `v`.)

- [ ] **Step 2: Run the test to verify it fails.** Run: `npx vitest run tests/server/products.test.ts` → FAIL.
- [ ] **Step 3: Implement** `plan-limits.ts` ('products'), `products.ts`, and `productFor` following the rules.
- [ ] **Step 4: Run the tests to verify they pass.** Run: `npx vitest run tests/server` → all passed.
- [ ] **Step 5: Build the pages** (all need `manage_products`)

- **Products:** search box and Active/Archived filter (GET `?q=&status=`, 50 per page with Next/Previous), rows of name, variant, SKU, price (`formatCedis`), and a thumbnail when `mainImageId` is set (`/${slug}/app/images/${id}`). Also an "Add category" form and an "Add product" link.
- **New product:** name, category, brand, tax rule ("Shop default" plus active rules), kind (Recipe only when the `recipes` module is on), tracking (Batch only with `batches`, Serial only with `serials`), base unit with a datalist (piece, kg, g, litre, metre, yard, pack, plus tablet, strip, bottle when `units` is on), "Sold in fractions (e.g. 1.250 kg)", price and cost in cedis via `parseCedis`, SKU, and barcodes (one per line; a USB scanner types into the field). Scale item code shows only when a layout is saved. Pharmacy fields show for pharmacy shops or when `prescriptions` is on. "Show on storefront" is unticked. On success, redirect to the product page.
- **Product page:** an edit form for the product fields and an Archive or Restore button. Tasks 5 and 9 add sections here.

Run: `npm run build` → compiles.

- [ ] **Step 6: Commit**

```bash
git add src tests
git commit -m "feat(catalogue): add products with variants, search, categories, and the product limit"
```

---

### Task 5: Variants, units, barcodes, bundles, and recipes

**Files:**
- Create: `src/server/variants.ts`
- Modify: `src/app/[slug]/app/products/[productId]/page.tsx` and `actions.ts`
- Test: `tests/server/variants.test.ts`

**Interfaces:**
- Consumes: `CatalogueError`, `Fail`, `NewVariantInput`, `productFor`, `getProduct` (Task 4); `rollUpCost`, `parseQuantity`, `validSaleQuantity` (Task 1).
- Produces:

```ts
export type VariantFields = { name: string; sku: string | null; basePricePesewas: number; costPesewas: number; reorderLevel: string | null;
  scaleItemCode: number | null; sellable: boolean; allowsFractions: boolean };
export type UnitFields = { name: string; factor: string; pricePesewas: number | null; sellable: boolean; purchasable: boolean };
export function addVariant(db: Db, ctx: Ctx, productId: string, input: NewVariantInput):
  Promise<{ ok: true; variantId: string; baseUnitId: string } | Fail<CatalogueError | 'not_found'>>;
export function updateVariant(db: Db, ctx: Ctx, variantId: string, input: VariantFields): Promise<{ ok: true } | Fail<CatalogueError | 'not_found'>>;
export function setVariantStatus(db: Db, ctx: Ctx, variantId: string, status: CatalogueStatus): Promise<{ ok: true } | Fail<'not_found' | 'last_variant'>>;
export function addUnit(db: Db, ctx: Ctx, variantId: string, input: UnitFields): Promise<{ ok: true; unitId: string } | Fail<'invalid_input' | 'duplicate_name' | 'not_found'>>;
export function updateUnit(db: Db, ctx: Ctx, unitId: string, input: UnitFields): Promise<{ ok: true } | Fail<'invalid_input' | 'duplicate_name' | 'not_found'>>;
export function removeUnit(db: Db, ctx: Ctx, unitId: string): Promise<{ ok: true } | Fail<'not_found' | 'base_unit'>>;
export function addBarcode(db: Db, ctx: Ctx, unitId: string, code: string):
  Promise<{ ok: true; barcodeId: string } | Fail<'invalid_input' | 'duplicate_barcode' | 'looks_like_scale_label' | 'not_found'>>;
export function removeBarcode(db: Db, ctx: Ctx, barcodeId: string): Promise<{ ok: true } | Fail<'not_found'>>;
export function addComponent(db: Db, ctx: Ctx, parentVariantId: string, input: { code: string; quantity: string }): // code = SKU or barcode
  Promise<{ ok: true; componentId: string } | Fail<'not_found' | 'not_a_bundle' | 'unknown_component' | 'contains_itself' | 'invalid_quantity' | 'duplicate_component'>>;
export function removeComponent(db: Db, ctx: Ctx, componentId: string): Promise<{ ok: true } | Fail<'not_found'>>;
export function findVariantByCode(tx: Tx, code: string): Promise<{ productId: string; variantId: string } | null>; // SKU (uppercased) or normalised barcode; RLS-scoped tx
export function costOf(tx: Tx, variantId: string): Promise<string>; // 4-dp pesewas per base unit; RLS-scoped tx
export function variantCost(db: Db, ctx: Ctx, variantId: string): Promise<string | null>; // manage_products; costOf inside withTenant; null when not visible
```

**Rules:**
- All writes need `manage_products`, run under `lockTenant`, and use the Task 4 rules for SKUs, barcodes, prices, and scale codes. A product id, variant id, or unit id the shop cannot see is `not_found`.
- `addVariant` copies kind, `allows_fractions`, and the base unit name from the product's first variant.
- `setVariantStatus('archived')` on the last active variant → `last_variant`. Archive the product instead.
- Units (spec 4.15): name 1–20 characters, unique per variant (case-insensitive). Non-base factor is `parseQuantity(factor) > 1` and ≤ `99999.000`. The base unit keeps factor `1.000` and price `null`, though its name, `sellable`, and `purchasable` can change; anything else on it → `invalid_input`. `removeUnit` refuses the base unit; for other units the database cascade also removes their barcodes and price list items.
- Components (spec 4.18): the parent must be kind `bundle` or `recipe` (`not_a_bundle`). `findVariantByCode` finds the component in this shop; otherwise `unknown_component`. Quantity must pass `validSaleQuantity(q, component.allowsFractions)`, or `invalid_quantity`. The same component twice → `duplicate_component`.
- Cycle check: load every component edge of the shop. If the parent is reachable from the new component (including the component being the parent), refuse with `contains_itself`.
- `costOf`: a standard variant's cost is its `average_cost`. A bundle or recipe's cost is `rollUpCost` over its components, recursing through nested bundles.
- Audit actions, one per call: `variant_added`, `variant_updated` (changes `{ field: [old, new] }` for price and cost), `variant_archived`, `variant_restored`, `unit_added`, `unit_updated`, `unit_removed`, `barcode_added`, `barcode_removed`, `component_added`, `component_removed`.

- [ ] **Step 1: Write the failing tests** in `tests/server/variants.test.ts`

```ts
it('sells by strip and pack: units carry factors and their own prices', async () => {
  const p = await productFor(db, owner, { baseUnit: 'tablet', variants: [{ basePricePesewas: 150, costPesewas: 100 }] });
  await addUnit(db, owner, p.variantId, { name: 'strip', factor: '10', pricePesewas: 1200, sellable: true, purchasable: false });
  await addUnit(db, owner, p.variantId, { name: 'pack', factor: '30', pricePesewas: null, sellable: true, purchasable: true });
  const d = await getProduct(db, owner, p.productId);
  expect(d!.variants[0].units.map((u) => [u.name, u.factor, u.pricePesewas])).toEqual([['tablet', '1.000', null], ['strip', '10.000', 1200], ['pack', '30.000', null]]);
});
it('rejects unit factors of 1 or less and duplicate names', async () => {
  // factor '1' → invalid_input; '0.5' → invalid_input; 'Strip' after 'strip' → duplicate_name; changing the base unit factor → invalid_input
});
it('removing a unit removes its barcodes and price list items; the base unit stays', async () => {
  // carton unit + barcode + Retail list item on carton (insert list and item via asPlatform) → removeUnit → both gone; removeUnit(base) → base_unit
});
it('adds a carton barcode that points at the carton unit', async () => { /* addBarcode(cartonId, '6009876543210') → getProduct shows it under carton */ });
it('blocks bundles that contain themselves, directly or through another bundle', async () => {
  // A and B bundles with SKUs 'A' and 'B'; addComponent(A, { code: 'A' }) → contains_itself
  // addComponent(B, { code: 'A', quantity: '1' }) ok; addComponent(A, { code: 'B', quantity: '1' }) → contains_itself
});
it('refuses components from another shop and fractions of whole items', async () => {
  // SKU only in shop B → unknown_component; piece item quantity '0.5' → invalid_quantity; standard parent → not_a_bundle
});
it('works out recipe and bundle cost from component costs', async () => {
  // rice (kg, fractions, cost 1200), oil (litre, fractions, cost 3000), chicken (piece, cost 1500)
  // jollof recipe: 0.250 rice + 0.050 oil + 1 chicken → costOf = '1950.0000'
  // pack bundle: 2 × jollof + 1 × Milo (cost 3800) → costOf = '7700.0000'
});
it('refuses to archive the last active variant', async () => { /* → last_variant */ });
it('records price changes in the audit log', async () => {
  // updateVariant 4500 → 5000 → audit 'variant_updated' with changes { basePricePesewas: [4500, 5000] }
});
```

- [ ] **Step 2: Run the test to verify it fails.** Run: `npx vitest run tests/server/variants.test.ts` → FAIL.
- [ ] **Step 3: Implement `src/server/variants.ts`** following the rules. Reuse the SKU, barcode, and scale-code checks from `products.ts` (export them from there rather than copying).
- [ ] **Step 4: Run the tests to verify they pass.** Expected: all passed.
- [ ] **Step 5: Extend the product page.** Under each variant:
  - an edit form for the variant fields, with Archive/Restore;
  - a units table with add, edit, and remove;
  - barcodes per unit, with add (scanner-friendly field) and remove;
  - for bundles and recipes, the components with quantity and base unit, an "Add part by SKU or barcode" form, and the cost from `variantCost` shown as cedis.

  Add an "Add variant" form at the bottom. Error copy reuses Task 4's table, plus:
  - `last_variant`: "Archive the product instead."
  - `base_unit`: "The base unit cannot be removed."
  - `contains_itself`: "A bundle cannot contain itself."
  - `unknown_component`: "No item has that SKU or barcode."
  - `invalid_quantity`: "Enter a quantity above zero; whole numbers for items sold whole."
  - `not_a_bundle`: "Only bundles and recipes have parts."
  - `duplicate_component`: "That item is already a part."
  - `duplicate_name`: "This item already has a unit with that name."

Run: `npm run build` → compiles.

- [ ] **Step 6: Commit**

```bash
git add src tests
git commit -m "feat(catalogue): add variants, units, barcodes, bundles, and recipes"
```

---

### Task 6: Read a scanned code

**Files:**
- Create: `src/server/scan.ts`
- Test: `tests/server/scan.test.ts`

**Interfaces:**
- Consumes: `normaliseBarcode`, `readScaleLabel`, `ratioToQty`, `fromMilli`, `WEIGHT_LAYOUT`, `PRICE_LAYOUT` (Task 1); `saveSellingSettings` (Task 3); `productFor`, `setProductStatus` (Task 4); `addUnit`, `addBarcode` (Task 5); `tenants.scaleBarcode`, `variants`, `variantUnits`, `barcodes`, `products`.
- Produces (used by Plan 3's `add_item_to_cart`):

```ts
export type ScanResult =
  | { found: true; productId: string; variantId: string; unitId: string; quantity: string; labelPricePesewas: number | null; available: boolean }
  | { found: false };
export function parseScannedCode(db: Db, ctx: Ctx, code: string): Promise<ScanResult>; // any signed-in member
```

**Rules (spec 6.22):**
1. `normaliseBarcode(code)`; null → not found.
2. If `readScaleLabel` returns `'bad_check_digit'` → not found. Do not fall back to the barcode table.
3. If it returns a label, find the variant whose `scale_item_code` is the item code, then return its base unit.
   - Weight label: `quantity = fromMilli(BigInt(value))` (grams → kg) and `labelPricePesewas: null`.
   - Price label: `quantity = ratioToQty(BigInt(value), BigInt(basePrice))` and `labelPricePesewas = value`.
   - No such variant, or a base price of 0 on a price label → not found.
4. Otherwise look the code up in `barcodes` → its variant and unit, quantity `'1.000'`.
5. `available` is false when the product or the variant is archived. Plan 3 shows "Product unavailable".

- [ ] **Step 1: Write the failing test**

```ts
it('finds a barcode with quantity 1 in its unit', async () => { /* carton barcode → { unitId: cartonId, quantity: '1.000', labelPricePesewas: null, available: true } */ });
it('finds a UPC-A code saved as EAN-13, and the other way round', async () => {
  // saved '036000291452' → parseScannedCode('0036000291452') and ('036000291452') both find it
});
it('reads a weight label as kilograms', async () => {
  // WEIGHT_LAYOUT; variant baseUnit 'kg', allowsFractions, scaleItemCode 123
  expect(await parseScannedCode(db, owner, '2100123012503')).toMatchObject({ found: true, unitId: baseUnitId, quantity: '1.250', labelPricePesewas: null });
});
it('reads a price label as a price and a quantity', async () => {
  // PRICE_LAYOUT; variant baseUnit 'kg', allowsFractions, scaleItemCode 456, basePricePesewas 900 (per kg)
  expect(await parseScannedCode(db, owner, '2200456007501')).toMatchObject({ found: true, quantity: '0.833', labelPricePesewas: 750 });
});
it('rejects a scale label with a wrong check digit', async () => { expect(await parseScannedCode(db, owner, '2100123012504')).toEqual({ found: false }); });
it("does not find another shop's barcode", async () => { /* code saved only in shop B → { found: false } in shop A */ });
it('marks archived items unavailable', async () => { /* archive product → { found: true, available: false } */ });
```

- [ ] **Step 2: Run the test to verify it fails.** Run: `npx vitest run tests/server/scan.test.ts` → FAIL.
- [ ] **Step 3: Implement `parseScannedCode`** following the rules.
- [ ] **Step 4: Run the test to verify it passes.** Expected: 7 passed.
- [ ] **Step 5: Commit**

```bash
git add src/server/scan.ts tests/server/scan.test.ts
git commit -m "feat(catalogue): read barcodes and scale labels"
```

---

### Task 7: Price lists and price resolution

**Files:**
- Create: `src/lib/pricing.ts`, `src/server/price-lists.ts`, `src/app/[slug]/app/price-lists/page.tsx` and `actions.ts`
- Modify: `src/app/[slug]/app/page.tsx` (Price lists link for `manage_products`), `src/app/[slug]/app/products/[productId]/page.tsx` and `actions.ts` (list prices per unit)
- Test: `tests/lib/pricing.test.ts`, `tests/server/price-lists.test.ts`

**Interfaces:**
- Consumes: `toMilli`, `validSaleQuantity`, `parseQuantity` (Task 1); `pesewasTimesQty`; `todayIn`; `productFor`, `getProduct` (Task 4); `addUnit` (Task 5); `parseScannedCode` (Task 6); `priceLists`, `priceListItems`, `variantUnits`, `variants`.
- Produces:

```ts
// src/lib/pricing.ts
export type PriceRule = { id: string; kind: PriceListKind; branchId: string | null; startsOn: string | null; endsOn: string | null; active: boolean;
  items: Array<{ unitId: string; minQuantity: string; pricePesewas: number }> };
export function choosePriceList(lists: PriceRule[], pick: { cartListId: string | null; customerListId: string | null; branchId: string; today: string }): PriceRule | null;
export function resolvePrice(list: PriceRule | null,
  sell: { unitId: string; quantity: string; unitPricePesewas: number | null; unitFactor: string; basePricePesewas: number }): number;
// src/server/price-lists.ts
export type PriceListInput = { name: string; kind: PriceListKind; branchId: string | null; startsOn: string | null; endsOn: string | null };
export function createPriceList(db: Db, ctx: Ctx, input: PriceListInput):
  Promise<{ ok: true; priceListId: string } | Fail<'invalid_input' | 'unknown_branch' | 'retail_exists' | 'branch_has_list'>>;
export function updatePriceList(db: Db, ctx: Ctx, priceListId: string, input: { name: string; startsOn: string | null; endsOn: string | null; active: boolean }):
  Promise<{ ok: true } | Fail<'invalid_input' | 'not_found'>>;
export function setPriceListItem(db: Db, ctx: Ctx, input: { priceListId: string; unitId: string; minQuantity: string; pricePesewas: number }):
  Promise<{ ok: true; itemId: string } | Fail<'invalid_input' | 'not_found'>>;      // upsert on (list, unit, min quantity)
export function removePriceListItem(db: Db, ctx: Ctx, itemId: string): Promise<{ ok: true } | Fail<'not_found'>>;
export type PriceListView = Omit<PriceRule, 'items'> & { name: string; branchName: string | null;
  items: Array<PriceRule['items'][number] & { id: string; productName: string; variantName: string; unitName: string }> };
export function listPriceLists(db: Db, ctx: Ctx): Promise<PriceListView[]>;      // manage_products
export function loadPriceRules(tx: Tx): Promise<PriceRule[]>;                     // RLS-scoped; Plan 3 uses it
export function quotePrice(db: Db, ctx: Ctx, input: { unitId: string; quantity: string; branchId: string; priceListId: string | null }, now: Date):
  Promise<{ ok: true; unitPricePesewas: number; priceListId: string | null } | Fail<'not_found' | 'invalid_quantity'>>; // any signed-in member
```

**Rules (spec 4.15, 6.21):**
- A list is live on `today` when it is `active`, `starts_on` is null or ≤ today, and `ends_on` is null or ≥ today (both ends inclusive).
- `choosePriceList` returns the first live list in this order: the cart's list, the customer's list, the branch-kind list for `pick.branchId`, then the Retail list. A branch-kind list never applies at another branch, even when chosen for the cart.
- `resolvePrice`:
  1. Among the list's items for `sell.unitId` with `minQuantity ≤ quantity`, take the one with the highest `minQuantity`.
  2. If there is none, use `unitPricePesewas`.
  3. If that is null, use `pesewasTimesQty(basePricePesewas, unitFactor)`.
- `createPriceList` and the other writes need `manage_products`. A `branch` list needs a branch the shop can see (`unknown_branch`), and other kinds must not have one. Retail lists have no dates. A second Retail list → `retail_exists`; a second list for one branch → `branch_has_list`. Name 1–60 characters; `endsOn ≥ startsOn`.
- `setPriceListItem`: list and unit must be visible (`not_found`); `minQuantity` must pass `validSaleQuantity(q, unit.isBase && variant.allowsFractions)`; price is an integer ≥ 0.
- `quotePrice` uses the shop's timezone through `todayIn(ctx.timezone, now)`. The quantity must pass the same fractions rule (`invalid_quantity`).
- Audit actions: `price_list_created`, `price_list_updated`, `price_list_item_saved` (changes `{ pricePesewas: [old, new] }`), `price_list_item_removed`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/pricing.test.ts — helpers list(overrides) and sell(overrides); defaults: unit 'u', quantity '1.000', unitPricePesewas null, unitFactor '1.000', basePricePesewas 500
const retail = list({ id: 'retail', kind: 'retail', items: [{ unitId: 'u', minQuantity: '1.000', pricePesewas: 500 }, { unitId: 'u', minQuantity: '12.000', pricePesewas: 450 }] });
it('applies the quantity break at and above its minimum', () => {
  expect(resolvePrice(retail, sell({ quantity: '11.000' }))).toBe(500);
  expect(resolvePrice(retail, sell({ quantity: '12.000' }))).toBe(450);
  expect(resolvePrice(retail, sell({ quantity: '30.000' }))).toBe(450);
});
it('falls back to the unit price, then base price × factor', () => {
  expect(resolvePrice(null, sell({ unitId: 'carton', unitPricePesewas: 10000, unitFactor: '24.000' }))).toBe(10000);
  expect(resolvePrice(retail, sell({ unitId: 'carton', unitFactor: '24.000' }))).toBe(12000);
});
it('chooses the cart list, then the customer list, then the branch list, then Retail', () => { /* four live lists; remove them one at a time */ });
it('skips lists that are inactive, not started, or ended', () => {
  const xmas = list({ id: 'xmas', kind: 'branch', branchId: 'b1', startsOn: '2026-12-01', endsOn: '2026-12-31' });
  const pick = (today: string) => choosePriceList([retail, xmas], { cartListId: null, customerListId: null, branchId: 'b1', today })?.id;
  expect(pick('2026-11-30')).toBe('retail');
  expect(pick('2026-12-01')).toBe('xmas');
  expect(pick('2026-12-31')).toBe('xmas');
  expect(pick('2027-01-01')).toBe('retail');
  // active: false → 'retail'
});
it("ignores another branch's list", () => { /* branchId 'b2' → retail, even as cartListId */ });
// tests/server/price-lists.test.ts
it('gives a wholesale customer the wholesale price, and the Retail break at 12', async () => {
  // Milo piece base 500; Retail list item min 12 @ 450; Wholesale list item min 1 @ 420
  // quotePrice({ quantity: '12', priceListId: null }) → 450; ({ quantity: '2', priceListId: wholesale }) → 420; ({ quantity: '2', priceListId: null }) → 500
});
it('allows one Retail list per shop and one list per branch', async () => { /* retail_exists, branch_has_list, unknown_branch for another shop's branch */ });
it('upserts a break and removes it', async () => { /* same (list, unit, '12') twice → one row with the new price; remove → gone; audit has price_list_item_saved */ });
it("refuses another shop's unit or list", async () => { /* → not_found */ });
it('rejects fractional quantities for whole units', async () => { /* minQuantity '1.5' on a piece unit → invalid_input; quotePrice quantity '0.5' → invalid_quantity */ });
it('needs manage_products to change lists', async () => { /* cashier → forbidden */ });
```

- [ ] **Step 2: Run the tests to verify they fail.** Run: `npx vitest run tests/lib/pricing.test.ts tests/server/price-lists.test.ts` → FAIL.
- [ ] **Step 3: Implement** `pricing.ts` and `price-lists.ts` following the rules.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: all passed.
- [ ] **Step 5: Build the Price lists page** (needs `manage_products`)

- Each list shows its kind, branch, dates, and active state, with an edit form.
- Its items show product, variant, unit, "from {minQuantity}", and price, with remove.
- A "Create list" form; Retail is offered only when the shop has none.
- A "Price check" form (barcode, quantity, branch, list) finds the unit with `parseScannedCode` (Task 6) and shows the `quotePrice` result.
- On the product page (Task 5), each unit row gets an "Add list price" form (list, minimum quantity default 1, price in cedis) that calls `setPriceListItem`.

Error copy:
- `retail_exists`: "This shop already has a Retail list."
- `branch_has_list`: "That branch already has a price list."
- `unknown_branch`: "Choose a branch."
- `invalid_quantity`: "Enter a quantity above zero; whole numbers for items sold whole."
- `invalid_input`: "Check the details."

Run: `npm run build` → compiles.

- [ ] **Step 6: Commit**

```bash
git add src tests
git commit -m "feat(pricing): add price lists, quantity breaks, and price resolution"
```

---

### Task 8: Image compression

**Files:**
- Create: `src/lib/images.ts`, `src/server/images.ts`
- Modify: `package.json` (`npm install sharp`)
- Test: `tests/lib/images.test.ts`, `tests/server/images.test.ts`

**Interfaces:**
- Produces:

```ts
// src/lib/images.ts — runs on the device and on the server
export const IMAGE_MAX_BYTES = 30 * 1024;
export const IMAGE_MIN_BYTES = 20 * 1024;
export const PRODUCT_IMAGE_SIZES = [800, 640, 480] as const;
export const COVER_IMAGE_SIZES = [1200, 960, 800] as const;   // Phase 2 storefront cover
export const TOP_QUALITY = 0.85;
export const LOW_QUALITY = 0.4;
export const SEARCH_STEPS = 7;
export type Encoded<T> = { size: number; data: T };
export function compressToTarget<T>(encode: (maxSide: number, quality: number) => Promise<Encoded<T>>, sizes?: readonly number[]):
  Promise<{ ok: true; maxSide: number; quality: number; result: Encoded<T> } | { ok: false }>;
export function sniffImageType(bytes: Uint8Array): 'jpeg' | 'png' | 'webp' | 'heic' | null;
// src/server/images.ts
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 40_000_000;
export type ProcessError = 'too_large' | 'unsupported_type' | 'heic_not_supported' | 'could_not_read' | 'could_not_compress';
export type ProcessedImage = { webp: Uint8Array; width: number; height: number; bytes: number };
export function processUpload(file: Uint8Array): Promise<{ ok: true; image: ProcessedImage } | { ok: false; error: ProcessError }>;
```

**Rules (spec 4.13, 6.4):**
- `compressToTarget` is the 6.4 loop. Run it once per size in `sizes`:
  1. Encode at `TOP_QUALITY`. If the result is ≤ `IMAGE_MAX_BYTES`, return it.
  2. Otherwise binary-search `q = (low + high) / 2` between `LOW_QUALITY` and `TOP_QUALITY`, for at most `SEARCH_STEPS` encodes. Too big → `high = q`. Fits → keep it as best and set `low = q`; stop as soon as a fit is ≥ `IMAGE_MIN_BYTES`.
  3. If any encode fitted, return the best; otherwise try the next size. Return `{ ok: false }` after the last size.
- `sniffImageType` reads magic bytes only:
  - JPEG: `FF D8 FF`.
  - PNG: `89 50 4E 47 0D 0A 1A 0A`.
  - WebP: `RIFF` at 0 and `WEBP` at 8.
  - HEIC: `ftyp` at 4, followed by `heic`, `heix`, `hevc`, `heim`, `heis`, `mif1`, or `msf1`.
- `processUpload` checks in this order:
  1. Size > `MAX_UPLOAD_BYTES` → `too_large`.
  2. Sniffed type `heic` → `heic_not_supported`; null → `unsupported_type`.
  3. Decode with `sharp(file, { limitInputPixels: MAX_INPUT_PIXELS })` and `.rotate()` (applies camera orientation). A decode error or too many pixels → `could_not_read`.
  4. Each encode is `.resize({ width: s, height: s, fit: 'inside', withoutEnlargement: true }).webp({ quality: Math.round(q * 100) })`. Never call `withMetadata` or `keepMetadata`, so sharp drops EXIF, GPS, XMP, and ICC data.
  5. `compressToTarget` fails → `could_not_compress`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/images.test.ts — fake(bytesAt) returns { calls, encode } where encode records [side, q] and returns { size: bytesAt(side, q), data: `${side}@${q}` }
it('keeps the top-quality encode when it already fits', async () => {
  const f = fake(() => 15_000);
  expect(await compressToTarget(f.encode)).toMatchObject({ ok: true, maxSide: 800, quality: 0.85 });
  expect(f.calls).toHaveLength(1);
});
it('searches for the highest quality that fits and stops once it reaches 20 KB', async () => {
  const f = fake((_s, q) => Math.round(q * 40_000));
  expect(await compressToTarget(f.encode)).toMatchObject({ ok: true, maxSide: 800, quality: 0.625, result: { size: 25_000 } });
  expect(f.calls).toEqual([[800, 0.85], [800, 0.625]]);
});
it('tries 640 when 800 cannot fit', async () => {
  const f = fake((s, q) => (s === 800 ? 50_000 : Math.round(q * 30_000)));
  expect(await compressToTarget(f.encode)).toMatchObject({ ok: true, maxSide: 640, quality: 0.85 });
  expect(f.calls).toHaveLength(9); // 1 + 7 at 800, then 1 at 640
});
it('fails when no size fits', async () => {
  const f = fake(() => 99_999);
  expect(await compressToTarget(f.encode)).toEqual({ ok: false });
  expect(f.calls).toHaveLength(24);
});
it('sniffs types by content, not name', () => {
  // JPEG, PNG, WebP, and HEIC ('....ftypheic') headers → their types; 'hello' → null
});
// tests/server/images.test.ts — photo(w, h) returns sharp({ create: { width: w, height: h, channels: 3, noise: { type: 'gaussian', mean: 128, sigma } } }).blur(…)
// so it compresses like a photo; tune sigma and blur in the fixture, never the assertions
it('re-encodes a large JPEG to WebP of at most 30 KB and 800 px', async () => {
  const r = await processUpload(await photo(3000, 2000).jpeg().toBuffer()) as { ok: true; image: ProcessedImage };
  const meta = await sharp(r.image.webp).metadata();
  expect(meta.format).toBe('webp');
  expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(800);
  expect(r.image.bytes).toBeLessThanOrEqual(30 * 1024);
});
it('strips EXIF and GPS metadata', async () => {
  const input = await photo(1200, 900).withExif({ IFD0: { Copyright: 'Ama' }, IFD3: { GPSLatitudeRef: 'N' } }).jpeg().toBuffer();
  expect((await sharp(input).metadata()).exif).toBeDefined();
  const r = await processUpload(input) as { ok: true; image: ProcessedImage };
  const meta = await sharp(r.image.webp).metadata();
  expect(meta.exif).toBeUndefined();
  expect(meta.xmp).toBeUndefined();
});
it('applies camera rotation before stripping', async () => {
  const input = await photo(400, 200).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const r = await processUpload(input) as { ok: true; image: ProcessedImage };
  expect([r.image.width, r.image.height]).toEqual([200, 400]);
});
it('rejects HEIC, other types, oversize files, and image bombs', async () => {
  // HEIC header bytes → heic_not_supported; 'hello' → unsupported_type; 10 MB + 1 byte → too_large
  // 8000 × 6000 solid PNG (48 million pixels) → could_not_read
});
it('fails with could_not_compress for an image too detailed to fit', async () => { /* unblurred noise, 2000 × 2000, sigma high enough that 480 px at quality 0.40 is still over 30 KB */ });
```

- [ ] **Step 2: Run the tests to verify they fail.** Run: `npx vitest run tests/lib/images.test.ts tests/server/images.test.ts` → FAIL.
- [ ] **Step 3: Install and implement.** Run: `npm install sharp`. Then implement both files. On the server, decode once and `clone()` the pipeline for each encode.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: all passed.
- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/lib/images.ts src/server/images.ts tests
git commit -m "feat(images): compress product photos to 20-30 KB WebP without metadata"
```

---

### Task 9: Product photos: storage, upload, and serving

**Files:**
- Create: `src/server/image-store.ts`, `src/server/product-images.ts`, `src/components/photo-upload.tsx`, `src/app/[slug]/app/images/[imageId]/route.ts`, `tests/helpers/image-store.ts`
- Modify: `next.config.ts`, `.env.example`, `src/app/[slug]/app/products/[productId]/page.tsx` and `actions.ts`
- Test: `tests/server/image-store.test.ts`, `tests/server/product-images.test.ts`

**Interfaces:**
- Consumes: `processUpload`, `ProcessError` (Task 8); `compressToTarget`, `PRODUCT_IMAGE_SIZES`, `TOP_QUALITY` (Task 8, on the device); `Fail`, `productFor` (Task 4); `productImages`, `products`.
- Produces:

```ts
// src/server/image-store.ts
export type ImageStore = { put(key: string, data: Uint8Array): Promise<void>; get(key: string): Promise<Uint8Array | null>; remove(key: string): Promise<void> };
export function diskImageStore(dir: string): ImageStore;
export function supabaseImageStore(opts: { url: string; key: string; bucket: string; fetchFn?: typeof fetch }): ImageStore;
export function getImageStore(): ImageStore; // SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set → Supabase bucket 'product-images'; else disk '.data/images'
// src/server/product-images.ts
export const MAX_IMAGES_PER_PRODUCT = 5;
export function uploadProductImage(db: Db, store: ImageStore, ctx: Ctx, productId: string, file: Uint8Array):
  Promise<{ ok: true; imageId: string } | Fail<'not_found' | 'image_limit_reached' | ProcessError>>;
export function removeProductImage(db: Db, store: ImageStore, ctx: Ctx, imageId: string): Promise<{ ok: true } | Fail<'not_found'>>;
export function makeMainImage(db: Db, ctx: Ctx, imageId: string): Promise<{ ok: true } | Fail<'not_found'>>;
export function readProductImage(db: Db, store: ImageStore, ctx: Ctx, imageId: string): Promise<Uint8Array | null>; // any signed-in member
// tests/helpers/image-store.ts
export function memoryImageStore(): ImageStore & { keys(): string[] };
```

**Rules (spec 6.4):**
- Upload, remove, and make-main need `manage_products`.
- `uploadProductImage` runs in this order:
  1. Product not visible → `not_found`. Already 5 photos → `image_limit_reached`. Both checks happen before any work.
  2. `processUpload`; return its error unchanged.
  3. `key = ${ctx.tenantId}/${productId}/${randomUUID()}.webp` and `store.put`.
  4. Open a transaction: lock the product row (`for update`), recount, and insert with `sort_order` = current count. If the recount reaches 5, return `image_limit_reached` and `store.remove(key)` after the transaction.
  5. Audit `product_image_added`.
- `removeProductImage` deletes the row, renumbers the rest `0..n-1` in their order, audits `product_image_removed`, and calls `store.remove` after commit. A failed remove leaves only an orphan file.
- `makeMainImage` moves the photo to 0 and shifts the others up, keeping their order. Audit `product_image_main`.
- `diskImageStore` refuses keys that are not `/^[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f-]+\.webp$/` and creates folders as needed.
- `supabaseImageStore` (Storage REST API) sends `apikey: key` and `Authorization: Bearer ${key}` on every call:
  - put: `POST ${url}/storage/v1/object/${bucket}/${key}` with `Content-Type: image/webp`;
  - get: `GET ${url}/storage/v1/object/authenticated/${bucket}/${key}`; 400 or 404 → null;
  - remove: `DELETE ${url}/storage/v1/object/${bucket}` with JSON `{ "prefixes": [key] }`.
  Any other non-2xx status throws.
- The route `GET /[slug]/app/images/[imageId]` resolves the context with `requireContext(…, permission: null)`. An `AccessError` or a missing image → 404. Otherwise it returns the bytes with `Content-Type: image/webp` and `Cache-Control: private, max-age=31536000, immutable` (keys never change).
- `next.config.ts`: `experimental: { serverActions: { bodySizeLimit: '10mb' } }`. Comment it: `// shortcut: Vercel functions accept at most 4.5 MB per request; the device sends ~30 KB (or an 800 px JPEG fallback), so only non-browser uploads hit that cap.`
- `.env.example`: add `SUPABASE_URL=` and `SUPABASE_SERVICE_ROLE_KEY=` with the comment `# Empty = photos are stored in .data/images`.

**Device side** (`photo-upload.tsx`, a client component on the product page):
1. Decode with `createImageBitmap(file, { imageOrientation: 'from-image' })`. If it fails, show "Choose a photo".
2. Run `compressToTarget` with a canvas encoder that draws the bitmap scaled to fit `maxSide` and calls `canvas.toBlob(cb, 'image/webp', q)`.
3. If the browser returns a blob whose type is not `image/webp` (it cannot encode WebP), send one 800 px JPEG at `TOP_QUALITY` instead; the server re-compresses it.
4. If compression fails, show "Photo too detailed. Try a closer or plainer photo."
5. Post the blob as `photo` in `FormData` to `uploadPhotoAction(slug, productId, formData)`, and show progress, the result, and errors.

**UI copy:**

| Error | Message |
| --- | --- |
| `image_limit_reached` | "A product can have up to 5 photos." |
| `too_large` | "Photo is too large. Choose one under 10 MB." |
| `unsupported_type` | "Choose a JPEG, PNG, or WebP photo." |
| `heic_not_supported` | "iPhone HEIC photos are not supported. Choose the photo again from Photos, or set Settings › Camera › Formats to Most Compatible." |
| `could_not_read` | "This file could not be read as a photo." |
| `could_not_compress` | "Photo too detailed. Try a closer or plainer photo." |

- [ ] **Step 1: Write the failing tests**

```ts
// tests/server/image-store.test.ts
it('disk store puts, gets, and removes, and refuses unsafe keys', async () => {
  // mkdtemp dir; put → get equals bytes; remove → get null; put('../x.webp') rejects
});
it('Supabase store calls the Storage API with the service key', async () => {
  // fetchFn records requests: put → POST https://p.supabase.co/storage/v1/object/product-images/<key>, headers apikey + Bearer + image/webp
  // get on 404 → null; remove → DELETE …/object/product-images with body {"prefixes":["<key>"]}; a 500 on put → rejects
});
// tests/server/product-images.test.ts — memoryImageStore; JPEG fixture made with sharp
it('stores a compressed WebP under the shop and product; the first photo is main', async () => {
  // key matches `${tenantId}/${productId}/<uuid>.webp`; row bytes ≤ 30720; sortOrder 0; audit 'product_image_added'
});
it('allows 5 photos and refuses the sixth without storing it', async () => { /* 6th → image_limit_reached; store.keys() length 5 */ });
it('makes a photo main and keeps the order of the others', async () => { /* [p0,p1,p2] → make p2 main → [p2,p0,p1] */ });
it('removes a photo and its stored file', async () => { /* [p0,p1,p2] remove p0 → [p1,p2] with sort 0,1; key gone from store */ });
it("never serves another shop's photo", async () => { /* readProductImage with shop B ctx and shop A image id → null */ });
it('needs manage_products to upload', async () => { /* cashier → forbidden */ });
```

- [ ] **Step 2: Run the tests to verify they fail.** Run: `npx vitest run tests/server/image-store.test.ts tests/server/product-images.test.ts` → FAIL.
- [ ] **Step 3: Implement** the store, the service, `memoryImageStore`, the route, and the config changes.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: all passed.
- [ ] **Step 5: Add the photos section** to the product page: thumbnails in order through the image route, "Main" on the first, "Make main" and "Remove" on the others, and `PhotoUpload` while there are fewer than 5. The products list thumbnail (Task 4) now shows real photos.

Run: `npm run build` → compiles.

- [ ] **Step 6: Commit**

```bash
git add next.config.ts .env.example src tests
git commit -m "feat(images): store, upload, and serve product photos"
```

---

### Task 10: End-to-end check

**Files:** none new.

- [ ] **Step 1: Run the full suite and the build.** Run: `npm run test` → all passed (Plan 1's 110 tests plus this plan's). Run: `npm run build` → compiles.
- [ ] **Step 2: Check in the browser preview** (`pos-dev` from `.claude/launch.json`; run `npm run db:migrate` first). As the owner of a retail shop:
  1. On Settings, tick "Charge tax", add tax rule "VAT" at 15% as the default, set scale labels to Weight with prefix `21`, item digits 3–7, and value digits 8–12, and tick Batch and expiry tracking.
  2. On Products, add "Milo 400g" (base unit piece, price 45.00, cost 38.00, SKU `milo-400`, barcode `036000291452`). Then add a `carton` unit with factor 24 and price 1,000.00, and give the carton barcode `6009876543210`.
  3. Add "Beef" (base unit kg, sold in fractions, price 90.00, scale item code 123). Try to add barcode `2100000000000` to Milo. Expected: "Barcode 2100000000000 looks like one of your scale labels. Use a different code."
  4. On Price lists, create the Retail list. On Milo's product page, add a Retail list price for the piece unit from 12 at 42.00. Back on Price lists, price check barcode `036000291452` × 12. Expected: GHS 42.00. Price check × 11. Expected: GHS 45.00.
  5. On Milo, upload a photo larger than 1 MB taken with a phone. Expected: the thumbnail appears. In `read_network_requests`, the server action request is under 35 KB, and the image route returns `image/webp` under 30 KB.
  6. Create a bundle "Breakfast pack" with SKU `BPACK` and add Milo by SKU `MILO-400` × 2. Expected: cost GHS 76.00. Add `BPACK` to itself. Expected: "A bundle cannot contain itself."
  7. Sign in as a cashier. Expected: no Products or Price lists links. Opening `/<slug>/app/products` redirects home.
- [ ] **Step 3: Commit any fixes** with a message naming what the check found.

---

## What later plans rely on

- **Plan 3 (selling and stock):**
  - Lookups and pricing: `parseScannedCode`, `searchCatalogue`, `loadPriceRules` + `choosePriceList` + `resolvePrice`, `chooseTaxRule` + `effectiveRateBp`, `listTaxRules`, `getSellingSettings`.
  - Maths: `validSaleQuantity`, `multiplyQty` (base quantity), `pesewasTimesQty` (line gross), `costOf` (line cost).
  - Plan 3 also owns these:
    - stock tables;
    - opening stock;
    - weighted average updates to `variants.average_cost`;
    - refusing a bundle or recipe with no parts at the till;
    - blocking changes to tracking mode, `allows_fractions`, or unit factors once stock or sales exist.
- **Plan 4 (offline):** everything in `src/lib/` runs on the device unchanged. The device needs a catalogue snapshot: variants, units, barcodes, price rules, tax rules, and selling settings.

## Production setup additions (needs the owner's Supabase account)

1. In Supabase Storage, create a **private** bucket `product-images`.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Vercel.
3. Run `npm run db:migrate` to apply `0004` and `0005`.
4. Upload one product photo and confirm the file appears in the bucket and on the product page. `supabaseImageStore` follows the Storage REST API as documented, but it has only been tested against a fake `fetch`.
