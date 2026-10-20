# Phase 1a · Plan 1 of 4: Platform Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running web app where the platform admin creates a shop (free trial or manually paid), the owner activates their account, adds branches, tills, and staff, registers a till device, staff switch in by PIN, and every shop's data is isolated by PostgreSQL Row-Level Security.

**Architecture:** One Next.js (App Router, TypeScript) app. Business logic lives in server-only service functions under `src/server/` that take a `Db` and a fixed `now: Date`, so tests control the clock. All shop data is read and written through `withTenant()`, which opens a transaction as the database role `pos_app` with `app.tenant_id` set, so RLS enforces isolation even if a query forgets a filter. Pre-sign-in lookups and platform-admin work go through `asPlatform()` (the owner role, which RLS does not apply to). Sessions are random tokens stored only as SHA-256 hashes, sent in httpOnly cookies; passwords and PINs use argon2id.

**Tech Stack:** Node 24 · Next.js via `create-next-app@latest` · Drizzle ORM + drizzle-kit · `postgres` (postgres.js) for Supabase in production · `@electric-sql/pglite` (in-process Postgres) for tests and local development · `@node-rs/argon2` · `zod` · `resend` · Vitest.

**Spec:** `docs/superpowers/specs/2026-10-20-multishop-pos-design.md` (spec v4; Word original at `C:\Users\kofia\OneDrive\Desktop\AD\Multi_Shop_POS_System_Pseudocode_and_Requirements_v4.docx`). Section numbers below refer to it.

## Phase 1a roadmap

Phase 1a is split into four plans. Each produces working, tested software. Each later plan is written after the previous one is merged, against the real interfaces.

| Plan | Delivers | Main spec sections |
| --- | --- | --- |
| **1. Foundation (this plan)** | Tenants, addresses, shop types, platform admin, manual onboarding and subscriptions, trial, sign-in, sessions, staff, branches, tills, devices, PIN switching, plan limits, audit log, RLS | 2, 3, 4.6, 4.14, 4.27, 5, 6.0–6.2, 6.20 (manual), 6.44, 6.48, 9 |
| 2. Catalogue | Products, variants, units, barcodes, scale barcodes, price lists, tax rules, tracking modes, bundles and recipes, image compression | 4.1, 4.11, 4.13, 4.15–4.18, 6.3, 6.4, 6.21, 6.22 |
| 3. Selling and stock | Cart totals, manual tenders, store credit, sale completion and finalising, receipts, stock deduction, stock receiving, negative-stock alerts, basic dashboard | 4.2, 4.3, 4.7, 4.10, 6.5, 6.6, 6.8, 6.9, 6.23, 6.28, 6.31 |
| 4. Offline PWA | Device catalogue cache, sale outbox, sync, owner MFA | 4.9, 6.10 |

## Not in this plan

- Changing a shop's slug with a redirect (spec 3) → Phase 1b.
- MFA for owners (6.1, 6.2) → Plan 4.
- Self-service password reset by email. Instead, the platform admin can issue a new activation link (Task 9), and owners reset staff access (Task 10).
- SMS invites and reminders (needs the SMS provider, Phase 2). Invites return a link to copy and send by WhatsApp; email is sent when an address exists.
- Paystack billing (Phase 3), storefront (Phase 2), platform support sessions (Phase 2), and manager notifications beyond audit entries shown on the home page.

## Global Constraints

- Money is whole pesewas in integers; never floating point (spec 6.0). GHS 12.50 = 1250.
- `tenant_id` always comes from the signed-in session, never from the URL or the request body (spec 3, 6.0).
- Every table with a `tenant_id` column has an RLS policy keyed on `app.tenant_id` (spec 3, 9). A test in Task 4 enforces this for all future tables.
- Shop data is accessed only through `withTenant()`; `asPlatform()` is used only in `src/server/auth.ts`, `sessions.ts`, `rate-limit.ts`, `platform-admin.ts`, `subscriptions.ts`, `onboarding.ts`, `devices.ts` (device lookup before sign-in), and tests.
- App code never reads the result of `tx.execute()` (PGlite and postgres.js return different shapes); use the Drizzle query builder.
- Time is stored in UTC. Shop timezone default `Africa/Accra`, currency `GHS` (6.2). Date-only values are `'YYYY-MM-DD'` strings.
- Every service that reads the clock takes `now: Date` as its last parameter.
- Services return `{ ok: true, ... } | { ok: false, error }` for expected failures, and throw only `AccessError` or programming errors.
- Slugs are 3–40 characters: lowercase letters, numbers, and single hyphens. Reserved words: `admin, api, app, login, help, pricing, terms, privacy, www, static`, plus `activate` (added because this plan uses it as a route) (spec 3).
- Shop types: `retail`, `pharmacy`, `food` (4.14). Role presets in Phase 1a: `owner`, `manager`, `cashier` (2).
- PINs are 4–6 digits; 5 wrong PINs lock it for 15 minutes and the manager is told (4.6, 6.1).
- Activation and invite links are single use and expire in 72 hours (6.2).
- Sign-in gives the same message whether the user exists or not (6.1).
- Free trial: 14 days. Grace period: 14 days; after it the POS is read-only (view and export only) (4.27, 5).
- Passwords and PINs are stored only as argon2id hashes; tokens only as SHA-256 hashes.
- Phone numbers are stored as `233` + 9 digits; emails trimmed and lowercase.
- Plan limits are checked on the server before a record is created; a downgrade never deletes data (4.27).
- Every file in `src/server/` and `src/db/` starts with `import 'server-only';`.

## Review Focus

Inputs the spec implies but that are easy to miss. Each has a test in the task named.

1. **Same email or phone in two shops.** Each shop's account is separate. Signing in at shop A with shop B's password must fail. → Task 7, `never authenticates a shop B account at shop A`.
2. **A shop A cookie used at a shop B URL** must be denied, not treated as signed in to B. → Task 7, `rejects a shop A session at a shop B URL`.
3. **Ghana phone formats** such as `024 123 4567`, `+233 24 123 4567`, and `0241234567` must all find the same staff member. → Task 3 (`normaliseGhanaPhone`), Task 7 (`signs in with phone in any Ghana format`).
4. **Mixed case and spaces in email** at sign-in (`"  AMA@shop-a.test "`) must match the stored address. → Task 7, `signs in with email ignoring case and spaces`.
5. **Double-submitting a manual payment** (same reference clicked twice, or two admins at once) must extend the subscription once. → Task 8, `applies a payment reference only once, even concurrently`.

## File Structure

```text
multishop-pos/
  drizzle.config.ts            drizzle-kit settings (schema barrel, ./drizzle out)
  vitest.config.ts             node env, path aliases, server-only stub
  .env.example                 DATABASE_URL, APP_URL, APP_NAME, RESEND_API_KEY, EMAIL_FROM
  drizzle/                     SQL migrations (0000 roles, 0001 tables, 0002 RLS + seed)
  scripts/migrate.ts           runs migrations against getDb()
  scripts/create-platform-admin.ts
  src/db/client.ts             Db/Tx types, getDb(), runMigrations()
  src/db/tenant.ts             withTenant(), asPlatform()
  src/db/schema/{platform,tenancy,people,audit,index}.ts
  src/lib/slug.ts              slug rules
  src/lib/contact.ts           phone and email normalising
  src/lib/permissions.ts       permissions, role presets, shop-type modules
  src/lib/dates.ts             date-only helpers in shop timezone
  src/lib/subscription.ts      subscription state rules
  src/lib/money.ts             parseCedis()
  src/lib/cookies.ts           cookie names and options
  src/server/crypto.ts         argon2id hashing, tokens
  src/server/audit.ts          writeAudit()
  src/server/rate-limit.ts     failed-attempt limiter
  src/server/sessions.ts       session create/validate/invalidate
  src/server/auth.ts           signIn(), signOut()
  src/server/context.ts        requireContext(), AccessError, Ctx
  src/server/email.ts          sendEmail()
  src/server/platform-admin.ts platform admin accounts and sessions
  src/server/subscriptions.ts  manual payments, suspension
  src/server/onboarding.ts     onboardShop(), activateAccount(), updateShopProfile()
  src/server/plan-limits.ts    checkPlanLimit()
  src/server/branches.ts       addBranch(), addRegister()
  src/server/staff.ts          addStaff(), resetStaffAccess(), deactivateStaff(), setStaffPermissions()
  src/server/devices.ts        device registration, till staff list, PIN switching
  src/server/home.ts           getHomeSummary()
  src/app/admin/...            platform admin pages
  src/app/activate/[token]/... activation and invite acceptance
  src/app/[slug]/login/...     shop sign-in
  src/app/[slug]/till/...      PIN pad on a registered device
  src/app/[slug]/app/...       signed-in shop pages (home, settings, staff, devices)
  tests/helpers/{test-db,fixtures,empty}.ts
  tests/{db,lib,server}/*.test.ts
```

---

### Task 1: Scaffold the project

**Files:**
- Create: the Next.js app inside `C:\Users\kofia\OneDrive\Desktop\Codes\multishop-pos` (the folder already holds `docs/`)
- Create: `vitest.config.ts`, `.env.example`, `tests/helpers/empty.ts`
- Modify: `package.json` (scripts), `.gitignore`

**Interfaces:**
- Produces: `npm run test`, `npm run build`, `npm run db:generate`, `npm run db:migrate`, `npm run create-platform-admin`; path alias `@/*` → `src/*`.

- [ ] **Step 1: Generate the app**

Run in `multishop-pos/`: `npx create-next-app@latest . --typescript --eslint --tailwind --app --src-dir --import-alias "@/*" --use-npm --yes`
Expected: "Success!", a git repository is initialised, and `docs/` is untouched.

- [ ] **Step 2: Install dependencies**

Run: `npm install drizzle-orm postgres @electric-sql/pglite @node-rs/argon2 zod resend server-only`
Run: `npm install -D drizzle-kit vitest vite-tsconfig-paths tsx`

- [ ] **Step 3: Configure Vitest in `vitest.config.ts`**

Node environment; `vite-tsconfig-paths` plugin; `include: ['tests/**/*.test.ts']`; `testTimeout: 20000` (PGlite start-up plus argon2); alias `server-only` → `tests/helpers/empty.ts` (which contains `export {};`), because the real package throws outside React Server Components.

- [ ] **Step 4: Add scripts and environment files**

`package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, `"db:generate": "drizzle-kit generate"`, `"db:migrate": "tsx scripts/migrate.ts"`, `"create-platform-admin": "tsx scripts/create-platform-admin.ts"`.

`.env.example`:

```text
# Postgres URL (Supabase pooler, transaction mode). Empty = local PGlite in .data/pglite
DATABASE_URL=
APP_URL=http://localhost:3000
APP_NAME=Multi-Shop POS
RESEND_API_KEY=
EMAIL_FROM=no-reply@example.com
```

Append `.data/` to `.gitignore`.

- [ ] **Step 5: Verify the toolchain**

Run: `npm run test -- --passWithNoTests` → exit code 0.
Run: `npm run build` → "Compiled successfully".

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app with Drizzle, PGlite, and Vitest"
```

---

### Task 2: Database client and tenant transactions

**Files:**
- Create: `src/db/client.ts`, `src/db/tenant.ts`, `src/db/schema/index.ts` (empty barrel `export {};` for now), `drizzle.config.ts`, `drizzle/0000_roles.sql`, `scripts/migrate.ts`, `tests/helpers/test-db.ts`
- Test: `tests/db/tenant.test.ts`

**Interfaces:**
- Produces:

```ts
// src/db/client.ts
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>; // common base of the PGlite and postgres.js drivers
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export function getDb(): Db;                       // singleton; DATABASE_URL → postgres.js ({ prepare: false }); else PGlite in .data/pglite
export function runMigrations(db: Db, driver: 'pglite' | 'postgres'): Promise<void>; // ./drizzle via drizzle-orm/pglite/migrator or drizzle-orm/postgres-js/migrator
// src/db/tenant.ts
export function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
export function asPlatform<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T>;
// tests/helpers/test-db.ts
export function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }>; // fresh in-memory PGlite + runMigrations
export function dbError(p: Promise<unknown>): Promise<string>; // awaits a rejection; returns error.message + ' | ' + error.cause?.message
```

- [ ] **Step 1: Write the failing test** in `tests/db/tenant.test.ts`

```ts
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

it('withTenant runs as pos_app with app.tenant_id set', async () => {
  const row = await withTenant(db, A, async (tx) =>
    (await tx.execute(sql`select current_user as u, current_setting('app.tenant_id') as t`)).rows[0]);
  expect(row).toEqual({ u: 'pos_app', t: A });
});

it('PGlite enforces RLS for pos_app', async () => {
  await asPlatform(db, async (tx) => {
    await tx.execute(sql`create table probe (tenant_id uuid not null)`);
    await tx.execute(sql`alter table probe enable row level security`);
    await tx.execute(sql`create policy p on probe using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`);
    await tx.execute(sql`grant select on probe to pos_app`);
    await tx.execute(sql`insert into probe values (${A}), (${B})`);
  });
  const row = await withTenant(db, A, async (tx) =>
    (await tx.execute(sql`select count(*)::int as n from probe`)).rows[0]);
  expect(row).toEqual({ n: 1 });
});

it('rejects a tenant id that is not a uuid', async () => {
  await expect(withTenant(db, 'abc', async () => 1)).rejects.toThrow('invalid tenant id');
});
```

(`beforeEach` calls `createTestDb()`; `afterEach` calls `close()`. Tests may read `execute().rows` because they always run on PGlite.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/tenant.test.ts`
Expected: FAIL, cannot resolve `@/db/tenant`.

- [ ] **Step 3: Write `drizzle/0000_roles.sql`**

Create it with `npx drizzle-kit generate --custom --name roles`, then fill it in:

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pos_app') THEN CREATE ROLE pos_app NOLOGIN; END IF;
END $$;
--> statement-breakpoint
GRANT pos_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO pos_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pos_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pos_app;
```

- [ ] **Step 4: Implement `getDb`, `runMigrations`, `withTenant`, `asPlatform`, `createTestDb`, `dbError`, `drizzle.config.ts`, and `scripts/migrate.ts`**

`withTenant`: validate `tenantId` with `z.string().uuid()` (throw `Error('invalid tenant id')`), then `db.transaction(async (tx) => { await tx.execute(sql\`set local role pos_app\`); await tx.execute(sql\`select set_config('app.tenant_id', ${tenantId}, true)\`); return fn(tx); })`. `asPlatform` is `db.transaction(fn)`. `drizzle.config.ts`: `dialect: 'postgresql'`, `schema: './src/db/schema/index.ts'`, `out: './drizzle'`, `dbCredentials.url = process.env.DATABASE_URL ?? ''`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/db/tenant.test.ts`
Expected: 3 passed.
**If `PGlite enforces RLS for pos_app` fails:** switch `createTestDb` to the `embedded-postgres` npm package (real Postgres binaries, no install) behind the same signature, then rerun.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(db): add client, tenant transactions, and pos_app role"
```

---

### Task 3: Pure helpers (slug, contact, permissions, dates, subscription state, crypto)

**Files:**
- Create: `src/lib/slug.ts`, `src/lib/contact.ts`, `src/lib/permissions.ts`, `src/lib/dates.ts`, `src/lib/subscription.ts`, `src/server/crypto.ts`
- Test: `tests/lib/slug.test.ts`, `tests/lib/contact.test.ts`, `tests/lib/permissions.test.ts`, `tests/lib/dates.test.ts`, `tests/server/crypto.test.ts`

**Interfaces:**
- Produces:

```ts
// src/lib/slug.ts
export const RESERVED_SLUGS = ['admin','api','app','login','help','pricing','terms','privacy','www','static','activate'] as const;
export type SlugProblem = 'too_short' | 'too_long' | 'invalid_chars' | 'reserved';
export function normaliseSlug(input: string): string;
export function validateSlug(slug: string): SlugProblem | 'ok';
// src/lib/contact.ts
export function normaliseGhanaPhone(input: string): string | null; // '233' + 9 digits
export function normaliseEmail(input: string): string | null;
// src/lib/permissions.ts
export const PERMISSIONS = ['manage_shop_settings','manage_staff','manage_devices','manage_products','receive_stock',
  'make_sale','give_discount','approve_actions','view_dashboard','view_reports','export_data'] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type RolePreset = 'owner' | 'manager' | 'cashier';
export const ROLE_PRESETS: Record<RolePreset, readonly Permission[]>;
export const READ_ONLY_PERMISSIONS: readonly Permission[]; // ['view_dashboard','view_reports','export_data']
export type ShopType = 'retail' | 'pharmacy' | 'food';
export const DEFAULT_MODULES: Record<ShopType, readonly string[]>;
// src/lib/dates.ts
export function todayIn(timeZone: string, now: Date): string;
export function addDays(date: string, days: number): string;
export function addMonths(date: string, months: number): string; // clamps to the last day of the month
export function maxDate(a: string, b: string): string;
// src/lib/subscription.ts
export type SubscriptionStatus = 'trial' | 'active' | 'cancelled';
export type SubscriptionState = 'trial' | 'active' | 'grace' | 'read_only';
export function subscriptionState(sub: { status: SubscriptionStatus; endDate: string; graceDays: number }, today: string): SubscriptionState;
// src/server/crypto.ts
export function hashSecret(secret: string): Promise<string>;   // argon2id: memoryCost 19456, timeCost 2, parallelism 1
export function verifySecret(hash: string, secret: string): Promise<boolean>;
export function newToken(): string;                             // 32 random bytes, base64url, no padding
export function tokenHash(token: string): string;               // sha256, hex
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/slug.test.ts
expect(normaliseSlug("  Ama's Shop!! ")).toBe('amas-shop');
expect(normaliseSlug('Kofi  &  Sons Provisions')).toBe('kofi-sons-provisions');
expect(validateSlug('ab')).toBe('too_short');
expect(validateSlug('a'.repeat(41))).toBe('too_long');
expect(validateSlug('shop--x')).toBe('invalid_chars');
expect(validateSlug('-shop')).toBe('invalid_chars');
expect(validateSlug('admin')).toBe('reserved');
expect(validateSlug('activate')).toBe('reserved');
expect(validateSlug('kofi-provisions')).toBe('ok');

// tests/lib/contact.test.ts — Review Focus 3
for (const input of ['024 123 4567', '+233 24 123 4567', '0241234567', '233241234567', '(024) 123-4567'])
  expect(normaliseGhanaPhone(input)).toBe('233241234567');
expect(normaliseGhanaPhone('12345')).toBeNull();
expect(normaliseGhanaPhone('02412345678')).toBeNull();
expect(normaliseEmail('  Ama@Shop.COM ')).toBe('ama@shop.com');
expect(normaliseEmail('ama')).toBeNull();
expect(normaliseEmail('ama@shop')).toBeNull();

// tests/lib/permissions.test.ts
expect([...ROLE_PRESETS.owner].sort()).toEqual([...PERMISSIONS].sort());
expect(ROLE_PRESETS.manager).not.toContain('manage_shop_settings');
expect(ROLE_PRESETS.manager).toHaveLength(PERMISSIONS.length - 1);
expect(ROLE_PRESETS.cashier).toEqual(['make_sale']);
expect(DEFAULT_MODULES).toEqual({
  retail: ['serials', 'price_lists', 'scale_barcodes'],
  pharmacy: ['batches', 'prescriptions', 'units'],
  food: ['addons', 'tickets', 'kitchen', 'recipes'],
});

// tests/lib/dates.test.ts
expect(todayIn('Africa/Accra', new Date('2026-10-20T23:30:00Z'))).toBe('2026-10-20');
expect(addDays('2026-10-20', 14)).toBe('2026-11-03');
expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
expect(addMonths('2026-10-20', 12)).toBe('2027-10-20');
expect(maxDate('2026-09-01', '2026-10-20')).toBe('2026-10-20');
const s = (status: SubscriptionStatus, endDate: string) => subscriptionState({ status, endDate, graceDays: 14 }, '2026-10-20');
expect(s('trial', '2026-10-20')).toBe('trial');
expect(s('trial', '2026-10-19')).toBe('read_only');   // trials get no grace (decided here)
expect(s('active', '2026-10-20')).toBe('active');
expect(s('active', '2026-10-19')).toBe('grace');
expect(s('active', '2026-10-06')).toBe('grace');      // 14 days past
expect(s('active', '2026-10-05')).toBe('read_only');  // 15 days past
expect(s('cancelled', '2026-12-31')).toBe('active');  // paid until end date

// tests/server/crypto.test.ts
const h = await hashSecret('1234');
expect(h).toMatch(/^\$argon2id\$/);
expect(await verifySecret(h, '1234')).toBe(true);
expect(await verifySecret(h, '1235')).toBe(false);
expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
expect(tokenHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib tests/server/crypto.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the helpers**

- `normaliseSlug`: remove `'` and `’`, lowercase, replace each run of characters outside `a-z0-9` with one `-`, then trim `-` from both ends.
- `validateSlug`: check in this order: length < 3, length > 40, `!/^[a-z0-9]+(-[a-z0-9]+)*$/`, then reserved.
- `normaliseGhanaPhone`: strip spaces, `-`, `(`, `)`, and a leading `+`. Then `0` + 9 digits becomes `233` + those 9 digits; `233` + 9 digits stays as it is; anything else returns `null`.
- `normaliseEmail`: trim and lowercase, then require `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
- Presets: owner = all permissions; manager = all except `manage_shop_settings`; cashier = `['make_sale']`.
- `todayIn`: `Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })`.
- `subscriptionState`: if `endDate >= today`, return `'trial'` for trial and `'active'` otherwise. If not: trial → `'read_only'`; else days past ≤ `graceDays` → `'grace'`, otherwise `'read_only'`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib tests/server/crypto.test.ts`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(lib): add slug, contact, permission, date, subscription, and crypto helpers"
```

---

### Task 4: Core schema, RLS policies, and test fixtures

**Files:**
- Create: `src/db/schema/platform.ts`, `src/db/schema/tenancy.ts`, `src/db/schema/people.ts`, `src/db/schema/audit.ts`
- Modify: `src/db/schema/index.ts` (re-export all four)
- Create: `drizzle/0001_*.sql` (generated), `drizzle/0002_rls.sql` (custom)
- Create: `tests/helpers/fixtures.ts`
- Test: `tests/db/rls.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `asPlatform`, `createTestDb`, `dbError` (Task 2); `hashSecret`, `ROLE_PRESETS`, `DEFAULT_MODULES` (Task 3).
- Produces: Drizzle tables `plans, platformAdmins, adminSessions, authAttempts, tenants, subscriptions, subscriptionPayments, branches, registers, users, userTokens, sessions, auditLog`, plus

```ts
// tests/helpers/fixtures.ts
export type SeedUser = { key: string; name?: string; email?: string; phone?: string; rolePreset?: RolePreset;
  password?: string; pin?: string; status?: 'pending_activation' | 'invited' | 'active' | 'inactive'; branchIds?: string[] };
export type SeededShop = { tenantId: string; slug: string; branchId: string; registerId: string; users: Record<string, { id: string }> };
export function seedShop(db: Db, opts?: { slug?: string; shopType?: ShopType; status?: 'active' | 'suspended';
  subscription?: { status: SubscriptionStatus; endDate: string; planId?: string }; users?: SeedUser[] }): Promise<SeededShop>;
```

Fixture defaults: slug `shop-<counter>`; subscription active, ending `2099-12-31`, plan `standard`; branch `Main`/`B1`; register `Till 1`/`T1`; users default to one `{ key: 'owner', email: 'owner@<slug>.test', password: 'correct-horse-1', rolePreset: 'owner' }`; each user's `name` defaults to its `key`, permissions = `ROLE_PRESETS[rolePreset]`, `branchIds` defaults to the branch, status defaults to `active`. It also inserts one `audit_log` row (`action: 'seeded'`). Everything is written via `asPlatform`.

**Columns** (all ids `uuid` default `gen_random_uuid()` unless noted; every `created_at` is `timestamptz not null default now()`; dates use Drizzle `date({ mode: 'string' })`):

| Table | Columns and constraints |
| --- | --- |
| `plans` | `id text pk`, `name text nn`, `price_pesewas integer nn default 0`, `limits jsonb nn` (`{branches, registers, staff, products, sms_per_month}`), `modules text[] nn default '{}'` |
| `platform_admins` | `id`, `email text nn unique`, `name text nn`, `password_hash text nn`, `created_at` |
| `admin_sessions` | `id text pk` (token hash), `admin_id → platform_admins nn`, `expires_at timestamptz nn`, `created_at` |
| `auth_attempts` | `key text pk`, `window_start timestamptz nn`, `count integer nn` |
| `tenants` | `id`, `slug text nn unique`, `name text nn`, `shop_type text nn check (retail, pharmacy, food)`, `modules text[] nn default '{}'`, `status text nn default 'active' check (active, suspended, closed)`, `timezone text nn default 'Africa/Accra'`, `currency text nn default 'GHS'`, `tax_mode text nn default 'inclusive' check (inclusive, exclusive)`, `business_day_cutoff text nn default '00:00'`, `address text`, `phone text`, `manager_phone text`, `created_at` |
| `subscriptions` | `id`, `tenant_id → tenants nn unique`, `plan_id → plans nn`, `status text nn check (trial, active, cancelled)`, `end_date date nn`, `grace_days integer nn default 14`, `auto_renew boolean nn default false`, `updated_at timestamptz nn default now()` |
| `subscription_payments` | `id`, `tenant_id → tenants nn`, `method text nn check (momo, bank_transfer, cash, card_terminal, paystack)`, `reference text nn unique`, `amount_pesewas integer nn check (> 0)`, `period_months integer nn check (1–36)`, `plan_id → plans nn`, `recorded_by → platform_admins`, `created_at` |
| `branches` | `id`, `tenant_id nn`, `name text nn`, `branch_code text nn`, `address text`, `phone text`, `created_at`, unique `(tenant_id, branch_code)` |
| `registers` | `id`, `tenant_id nn`, `branch_id → branches nn`, `name text nn`, `register_code text nn`, `receipt_counter bigint nn default 0` (mode number), `device_token_hash text unique`, `device_registered_at timestamptz`, `status text nn default 'active' check (active, retired)`, `created_at`, unique `(tenant_id, register_code)` |
| `users` | `id`, `tenant_id nn`, `name text nn`, `email text`, `phone text`, `role_preset text nn check (owner, manager, cashier)`, `permissions text[] nn`, `branch_ids uuid[] nn default '{}'`, `password_hash text`, `pin_hash text`, `failed_pin_count integer nn default 0`, `pin_locked_until timestamptz`, `status text nn check (pending_activation, invited, active, inactive)`, `created_at`, unique `(tenant_id, email)`, unique `(tenant_id, phone)`, check `email is not null or phone is not null` |
| `user_tokens` | `id`, `tenant_id nn`, `user_id → users nn`, `purpose text nn check (activation, invite)`, `token_hash text nn unique`, `expires_at timestamptz nn`, `used_at timestamptz`, `created_at` |
| `sessions` | `id text pk` (token hash), `tenant_id nn`, `user_id → users nn`, `register_id → registers`, `kind text nn check (password, pin)`, `expires_at timestamptz nn`, `created_at` |
| `audit_log` | `id bigint generated always as identity pk`, `tenant_id → tenants` (null = platform event), `actor_type text nn check (user, platform, anonymous, system)`, `actor_id uuid`, `action text nn`, `record_type text`, `record_id text`, `reason text`, `changes jsonb`, `created_at`, index `(tenant_id, created_at)` |

Every `tenant_id` column references `tenants(id)`.

- [ ] **Step 1: Write the failing test** in `tests/db/rls.test.ts`

```ts
// beforeEach: ({ db, close } = await createTestDb()); a = await seedShop(db, { slug: 'shop-a' }); b = await seedShop(db, { slug: 'shop-b' });
it('tenant A sees only its own rows', async () => {
  for (const t of [tenants, subscriptions, branches, registers, users, auditLog]) {
    const rows = await withTenant(db, a.tenantId, (tx) => tx.select().from(t));
    expect(rows, getTableName(t)).toHaveLength(1);
  }
});
it('returns no rows when no tenant is set', async () => {
  const rows = await db.transaction(async (tx) => { await tx.execute(sql`set local role pos_app`); return tx.select().from(users); });
  expect(rows).toEqual([]);
});
it('blocks writing a row for another tenant', async () => {
  expect(await dbError(withTenant(db, a.tenantId, (tx) =>
    tx.insert(branches).values({ tenantId: b.tenantId, name: 'X', branchCode: 'X1' })))).toMatch(/row-level security/);
});
it('audit_log is append-only for pos_app', async () => {
  expect(await dbError(withTenant(db, a.tenantId, (tx) => tx.update(auditLog).set({ action: 'changed' })))).toMatch(/permission denied/);
});
it('pos_app cannot read platform tables', async () => {
  for (const t of [platformAdmins, adminSessions, authAttempts])
    expect(await dbError(withTenant(db, a.tenantId, (tx) => tx.select().from(t)))).toMatch(/permission denied/);
});
it('every table with a tenant_id column has RLS enabled', async () => {
  const rows = (await asPlatform(db, (tx) => tx.execute(sql`
    select c.relname, c.relrowsecurity from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join information_schema.columns col on col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'tenant_id'
    where c.relkind = 'r'`))).rows as { relname: string; relrowsecurity: boolean }[];
  expect(rows.length).toBeGreaterThanOrEqual(8);
  expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
});
it('seeds the trial and standard plans', async () => {
  const p = await asPlatform(db, (tx) => tx.select().from(plans));
  expect(p.map((x) => x.id).sort()).toEqual(['standard', 'trial']);
  expect(p.find((x) => x.id === 'trial')!.limits).toEqual({ branches: 1, registers: 2, staff: 5, products: 500, sms_per_month: 50 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/rls.test.ts`
Expected: FAIL, schema exports missing.

- [ ] **Step 3: Write the four schema files and generate `0001`**

Use the column table above. Run: `npm run db:generate` → creates `drizzle/0001_*.sql`.

- [ ] **Step 4: Write `drizzle/0002_rls.sql`**

Run `npx drizzle-kit generate --custom --name rls`, then:

```sql
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Repeat these two statements for: subscriptions, subscription_payments, branches, registers, users, user_tokens, sessions, audit_log
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON branches
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_log FROM pos_app;
--> statement-breakpoint
REVOKE ALL ON platform_admins, admin_sessions, auth_attempts FROM pos_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON plans FROM pos_app;
--> statement-breakpoint
-- shortcut: plan prices and limits are placeholders until spec 10.2 is decided; set real values before launch
INSERT INTO plans (id, name, price_pesewas, limits, modules) VALUES
  ('trial', 'Free trial', 0, '{"branches":1,"registers":2,"staff":5,"products":500,"sms_per_month":50}', '{}'),
  ('standard', 'Standard', 0, '{"branches":3,"registers":6,"staff":20,"products":5000,"sms_per_month":500}', '{}');
```

RLS is enabled but not forced, so the owner role used by `asPlatform` keeps full access while `pos_app` is always filtered.

- [ ] **Step 5: Implement `seedShop`** in `tests/helpers/fixtures.ts`, with the defaults stated above.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/db`
Expected: all passed.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(db): add core schema with row-level security and plan seed"
```

---

### Task 5: Audit log and failed-attempt limiter

**Files:**
- Create: `src/server/audit.ts`, `src/server/rate-limit.ts`
- Test: `tests/server/audit-rate-limit.test.ts`

**Interfaces:**
- Consumes: `Tx`, `withTenant`, `asPlatform`, `auditLog`, `authAttempts`.
- Produces:

```ts
export type AuditEntry = { tenantId: string | null; actorType: 'user' | 'platform' | 'anonymous' | 'system'; actorId: string | null;
  action: string; recordType?: string; recordId?: string; reason?: string; changes?: Record<string, unknown> };
export function writeAudit(tx: Tx, entry: AuditEntry): Promise<void>;
export const MAX_ATTEMPTS = 10;
export const WINDOW_MINUTES = 15;
export function tooManyAttempts(tx: Tx, key: string, now: Date): Promise<boolean>;
export function countFailedAttempt(tx: Tx, key: string, now: Date): Promise<void>;
export function clearAttempts(tx: Tx, key: string): Promise<void>;
```

- [ ] **Step 1: Write the failing test**

```ts
it('audit entries are visible only to their tenant', async () => {
  await withTenant(db, a.tenantId, (tx) => writeAudit(tx, { tenantId: a.tenantId, actorType: 'user', actorId: a.users.owner.id, action: 'test_event' }));
  expect(await withTenant(db, a.tenantId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'test_event')))).toHaveLength(1);
  expect(await withTenant(db, b.tenantId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'test_event')))).toEqual([]);
});
it('limits to 10 failures per key per 15 minutes', async () => {
  const t0 = new Date('2026-10-20T10:00:00Z');
  await asPlatform(db, async (tx) => {
    for (let i = 0; i < 9; i++) await countFailedAttempt(tx, 'k', t0);
    expect(await tooManyAttempts(tx, 'k', t0)).toBe(false);
    await countFailedAttempt(tx, 'k', t0);
    expect(await tooManyAttempts(tx, 'k', t0)).toBe(true);
    expect(await tooManyAttempts(tx, 'k', new Date(t0.getTime() + 16 * 60_000))).toBe(false);
    await clearAttempts(tx, 'k');
    expect(await tooManyAttempts(tx, 'k', t0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.** Run: `npx vitest run tests/server/audit-rate-limit.test.ts` → FAIL, modules not found.

- [ ] **Step 3: Implement.** `countFailedAttempt` is a single upsert: when `window_start` is older than 15 minutes, reset to `count = 1, window_start = now`; otherwise `count = count + 1`. `tooManyAttempts` is true when the row's window is still open and `count >= MAX_ATTEMPTS`.

- [ ] **Step 4: Run the test to verify it passes.** Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): add audit log writer and failed-attempt limiter"
```

---

### Task 6: Sessions

**Files:**
- Create: `src/server/sessions.ts`
- Test: `tests/server/sessions.test.ts`

**Interfaces:**
- Consumes: `newToken`, `tokenHash` (Task 3); `sessions`, `users` tables; `asPlatform`.
- Produces:

```ts
export type SessionKind = 'password' | 'pin';
export type SessionUser = { sessionId: string; kind: SessionKind; tenantId: string; userId: string; registerId: string | null;
  name: string; rolePreset: RolePreset; permissions: Permission[]; expiresAt: Date };
export const PASSWORD_SESSION_DAYS = 30;  // extended to now + 30 days when under 15 days remain
export const PIN_SESSION_HOURS = 12;      // never extended
export function createSession(db: Db, input: { tenantId: string; userId: string; kind: SessionKind; registerId?: string | null }, now: Date): Promise<{ token: string; expiresAt: Date }>;
export function validateSession(db: Db, token: string, now: Date): Promise<SessionUser | null>; // null if missing, expired, or user not active
export function invalidateSession(db: Db, token: string): Promise<void>;
export function invalidateUserSessions(db: Db, tenantId: string, userId: string): Promise<void>;
```

- [ ] **Step 1: Write the failing test**

```ts
const t0 = new Date('2026-10-20T10:00:00Z'); const at = (ms: number) => new Date(t0.getTime() + ms);
const DAY = 86_400_000, HOUR = 3_600_000;
it('validates a fresh password session', async () => {
  const { token } = await createSession(db, { tenantId: a.tenantId, userId: a.users.owner.id, kind: 'password' }, t0);
  expect(await validateSession(db, token, at(DAY))).toMatchObject({ tenantId: a.tenantId, userId: a.users.owner.id, rolePreset: 'owner', kind: 'password', registerId: null });
});
it('extends a password session when under 15 days remain', async () => {
  const { token } = await createSession(db, { tenantId: a.tenantId, userId: a.users.owner.id, kind: 'password' }, t0);
  expect((await validateSession(db, token, at(20 * DAY)))!.expiresAt).toEqual(at(50 * DAY));
});
it('expires a password session after 30 days without use', async () => { /* create at t0 */ expect(await validateSession(db, token, at(31 * DAY))).toBeNull(); });
it('expires a PIN session after 12 hours', async () => {
  const { token } = await createSession(db, { tenantId: a.tenantId, userId: a.users.owner.id, kind: 'pin', registerId: a.registerId }, t0);
  expect(await validateSession(db, token, at(11 * HOUR))).toMatchObject({ kind: 'pin', registerId: a.registerId });
  expect(await validateSession(db, token, at(13 * HOUR))).toBeNull();
});
it('rejects sessions of users who are no longer active', async () => { /* set users.status = 'inactive' via asPlatform */ expect(await validateSession(db, token, at(HOUR))).toBeNull(); });
it('invalidates single and all sessions', async () => { /* invalidateSession → null; two sessions + invalidateUserSessions → both null */ });
it('stores only the token hash', async () => {
  const { token } = await createSession(db, { tenantId: a.tenantId, userId: a.users.owner.id, kind: 'password' }, t0);
  const [row] = await asPlatform(db, (tx) => tx.select().from(sessions));
  expect(row.id).toBe(tokenHash(token));
});
```

- [ ] **Step 2: Run the test to verify it fails.** Run: `npx vitest run tests/server/sessions.test.ts` → FAIL.
- [ ] **Step 3: Implement `src/server/sessions.ts`**, using `asPlatform` with explicit `tenant_id` filters.
- [ ] **Step 4: Run the test to verify it passes.** Expected: 7 passed.
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(auth): add hashed, expiring sessions"
```

---

### Task 7: Sign-in and request context

**Files:**
- Create: `src/server/auth.ts`, `src/server/context.ts`, `src/lib/cookies.ts`
- Create: `src/app/[slug]/login/page.tsx`, `src/app/[slug]/login/actions.ts`, `src/app/[slug]/app/layout.tsx`
- Modify: `tests/helpers/fixtures.ts` (add `ctxFor`)
- Test: `tests/server/auth.test.ts`, `tests/server/context.test.ts`

**Interfaces:**
- Consumes: sessions (Task 6), limiter and audit (Task 5), contact and subscription helpers (Task 3).
- Produces:

```ts
// src/server/auth.ts
export type SignInError = 'try_again_later' | 'access_denied' | 'account_disabled';
export function signIn(db: Db, input: { slug: string; identifier: string; password: string; ip: string }, now: Date):
  Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; error: SignInError }>;
export function signOut(db: Db, token: string): Promise<void>;
// src/server/context.ts
export type AccessCode = 'not_signed_in' | 'wrong_shop' | 'suspended' | 'read_only' | 'forbidden';
export class AccessError extends Error { readonly code: AccessCode; }
export type Ctx = { tenantId: string; slug: string; timezone: string; userId: string; name: string; rolePreset: RolePreset;
  permissions: Permission[]; registerId: string | null; subscription: SubscriptionState };
export function requireContext(db: Db, input: { slug: string; sessionToken: string | undefined; permission: Permission | null }, now: Date): Promise<Ctx>;
// src/lib/cookies.ts
export const SESSION_COOKIE = 'pos_session'; export const DEVICE_COOKIE = 'pos_device'; export const ADMIN_COOKIE = 'pos_admin';
// tests/helpers/fixtures.ts
export function ctxFor(db: Db, shop: SeededShop, userKey: string, now: Date, permission?: Permission | null): Promise<Ctx>;
export function expectAccess(p: Promise<unknown>, code: AccessCode): Promise<void>; // asserts rejection with AccessError of that code
```

**`signIn` order (spec 6.1):**
1. Rate key `signin:<slug>:<ip>:<normalised identifier>`; if `tooManyAttempts`, return `try_again_later`.
2. Find the shop by slug (`asPlatform`). If it is missing or not `active`, return `access_denied`.
3. The identifier is an email if it contains `@` (`normaliseEmail`), otherwise a phone number (`normaliseGhanaPhone`). Find the user in that tenant.
4. If the user is missing, has no `password_hash`, or the password fails: run `verifySecret` against a fixed dummy hash (when the user is missing) so timing matches, call `countFailedAttempt`, write audit `{ tenantId: shop.id, actorType: 'anonymous', actorId: null, action: 'failed_sign_in', changes: { identifier, ip } }`, and return `access_denied`.
5. If the user's status is not `active`, return `account_disabled`.
6. `clearAttempts`, create a `password` session, write audit `signed_in`.

**`requireContext` order:**
1. Session missing or invalid → `not_signed_in`.
2. The slug's shop does not exist, or the session's `tenantId` is not that shop's id → `wrong_shop`.
3. Shop `suspended` → `suspended`.
4. If `permission` is null, return the context.
5. Subscription state is `read_only` and `permission` is not in `READ_ONLY_PERMISSIONS` → `read_only`.
6. `permission` is not in the session's permissions → `forbidden`.

**UI copy** (exact strings):

| Error | Message |
| --- | --- |
| `access_denied` | "Wrong email, phone, or password." |
| `try_again_later` | "Too many attempts. Try again in 15 minutes." |
| `account_disabled` | "This account is disabled. Ask your shop owner." |
| `suspended` | "This shop is suspended. Contact support." |

- [ ] **Step 1: Write the failing tests**

```ts
// tests/server/auth.test.ts — shop-a owner: email 'ama@shop-a.test', phone '233241234567', password 'correct-horse-1'
//                            shop-b user:  email 'ama@shop-a.test', password 'other-pass-22'
const t0 = new Date('2026-10-20T10:00:00Z');
const go = (identifier: string, password = 'correct-horse-1', slug = 'shop-a') => signIn(db, { slug, identifier, password, ip: '1.1.1.1' }, t0);
it('signs in with email ignoring case and spaces', async () => { expect(await go('  AMA@shop-a.test ')).toMatchObject({ ok: true }); }); // Review Focus 4
it('signs in with phone in any Ghana format', async () => {                                                                        // Review Focus 3
  for (const p of ['024 123 4567', '+233 24 123 4567', '0241234567']) expect(await go(p)).toMatchObject({ ok: true });
});
it('gives the same error for unknown user and wrong password, and audits both', async () => {
  expect(await go('nobody@shop-a.test')).toEqual({ ok: false, error: 'access_denied' });
  expect(await go('ama@shop-a.test', 'wrong-password')).toEqual({ ok: false, error: 'access_denied' });
  const rows = await withTenant(db, a.tenantId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'failed_sign_in')));
  expect(rows).toHaveLength(2);
});
it('denies unknown and suspended shops with access_denied', async () => { /* go(..., 'no-such-shop'); then suspend shop-a */ });
it('reports disabled accounts', async () => { /* status inactive */ expect(await go('ama@shop-a.test')).toEqual({ ok: false, error: 'account_disabled' }); });
it('locks out after 10 failures from the same IP and identifier', async () => {
  for (let i = 0; i < 10; i++) await go('ama@shop-a.test', 'wrong-password');
  expect(await go('ama@shop-a.test')).toEqual({ ok: false, error: 'try_again_later' });
});
it('never authenticates a shop B account at shop A', async () => {                                                                   // Review Focus 1
  expect(await go('ama@shop-a.test', 'other-pass-22', 'shop-a')).toEqual({ ok: false, error: 'access_denied' });
  expect(await go('ama@shop-a.test', 'other-pass-22', 'shop-b')).toMatchObject({ ok: true });
});

// tests/server/context.test.ts — uses expectAccess from fixtures
it('rejects a missing session', async () => { await expectAccess(requireContext(db, { slug: 'shop-a', sessionToken: undefined, permission: null }, t0), 'not_signed_in'); });
it('rejects a shop A session at a shop B URL', async () => {                                                                          // Review Focus 2
  const { token } = await createSession(db, { tenantId: a.tenantId, userId: a.users.owner.id, kind: 'password' }, t0);
  await expectAccess(requireContext(db, { slug: 'shop-b', sessionToken: token, permission: null }, t0), 'wrong_shop');
});
it('blocks a cashier from staff management', async () => { /* seed cashier */ await expectAccess(ctxFor(db, a, 'cashier', t0, 'manage_staff'), 'forbidden'); });
it('allows only view and export when read-only', async () => {
  const r = await seedShop(db, { slug: 'shop-r', subscription: { status: 'active', endDate: '2026-09-01' } });
  await expectAccess(ctxFor(db, r, 'owner', t0, 'make_sale'), 'read_only');
  await expect(ctxFor(db, r, 'owner', t0, 'view_dashboard')).resolves.toMatchObject({ subscription: 'read_only' });
});
it('reports suspended shops', async () => { /* seedShop status suspended */ await expectAccess(ctxFor(db, s, 'owner', t0), 'suspended'); });
it('returns the context for an allowed action', async () => {
  expect(await ctxFor(db, a, 'owner', t0, 'manage_staff')).toMatchObject({ tenantId: a.tenantId, slug: 'shop-a', rolePreset: 'owner', subscription: 'active', timezone: 'Africa/Accra' });
});
```

- [ ] **Step 2: Run the tests to verify they fail.** Run: `npx vitest run tests/server/auth.test.ts tests/server/context.test.ts` → FAIL.
- [ ] **Step 3: Implement `auth.ts`, `context.ts`, `cookies.ts`, and `ctxFor`**, following the orders above.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: 13 passed.
- [ ] **Step 5: Build the sign-in page and shop layout**

- `login/page.tsx`: a form with "Email or phone" and "Password". The server action `signInAction(slug, formData)` reads the IP from the first `x-forwarded-for` entry and calls `signIn(getDb(), …, new Date())`.
  - On success it sets `SESSION_COOKIE` (httpOnly, `secure` in production, `sameSite: 'lax'`, `path: '/'`, expires = `expiresAt`) and redirects to `/<slug>/app`.
  - On failure it shows the UI copy above.
- `app/layout.tsx` calls `requireContext(…, permission: null)`. On `not_signed_in` or `wrong_shop` it redirects to `/<slug>/login`; on `suspended` it renders the suspended message.

Run: `npm run build` → compiles.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(auth): add shop sign-in and tenant-checked request context"
```

---

### Task 8: Platform admin, money input, and manual subscription payments

**Files:**
- Create: `src/server/platform-admin.ts`, `src/server/subscriptions.ts`, `src/server/email.ts`, `src/lib/money.ts`, `scripts/create-platform-admin.ts`
- Create: `src/app/admin/login/page.tsx` (+ `actions.ts`), `src/app/admin/layout.tsx`, `src/app/admin/shops/[id]/page.tsx` (+ `actions.ts`)
- Test: `tests/lib/money.test.ts`, `tests/server/subscriptions.test.ts`, `tests/server/platform-admin.test.ts`

**Interfaces:**
- Consumes: `asPlatform`, `writeAudit`, limiter, crypto, `todayIn`, `addMonths`, `maxDate`, `AccessError`.
- Produces:

```ts
// src/lib/money.ts
export function parseCedis(input: string): number | null; // "1,250.50" → 125050 pesewas; null if invalid
// src/server/email.ts
export function sendEmail(msg: { to: string; subject: string; text: string }): Promise<void>; // Resend; logs to console when RESEND_API_KEY is empty
// src/server/platform-admin.ts
export const ADMIN_SESSION_HOURS = 12;
export function createPlatformAdmin(db: Db, input: { email: string; name: string; password: string }): Promise<{ id: string }>;
export function platformSignIn(db: Db, input: { email: string; password: string; ip: string }, now: Date):
  Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; error: 'try_again_later' | 'access_denied' }>;
export function requirePlatformAdmin(db: Db, token: string | undefined, now: Date): Promise<{ adminId: string; name: string }>; // throws AccessError('not_signed_in')
// src/server/subscriptions.ts
export type ManualPayment = { method: 'momo' | 'bank_transfer' | 'cash' | 'card_terminal'; reference: string; amountPesewas: number; periodMonths: number; planId: string };
export type PaymentError = 'duplicate_reference' | 'invalid_payment';
export function applyManualPayment(tx: Tx, adminId: string, tenantId: string, payment: ManualPayment, now: Date):
  Promise<{ ok: true; endDate: string } | { ok: false; error: PaymentError }>;
export function recordManualPayment(db: Db, adminId: string, tenantId: string, payment: ManualPayment, now: Date):
  Promise<{ ok: true; endDate: string } | { ok: false; error: PaymentError }>;
export function setShopSuspended(db: Db, adminId: string, tenantId: string, suspended: boolean, reason: string): Promise<void>;
```

**`applyManualPayment` (spec 6.20, manual part):**
1. Validate with zod: reference trimmed and non-empty; `amountPesewas` an integer > 0; `periodMonths` an integer 1–36; `planId` exists. Otherwise return `invalid_payment`.
2. Insert the payment. A unique violation on `reference` returns `duplicate_reference` and leaves the subscription unchanged. Use `onConflictDoNothing().returning()` and treat an empty result as the duplicate.
3. Set `end_date = addMonths(maxDate(end_date, todayIn(tenant.timezone, now)), periodMonths)`, `status = 'active'`, `plan_id = payment.planId`.
4. Write audit `subscription_activated` with `{ reference, amountPesewas, endDate }`.

`recordManualPayment` wraps it in `asPlatform`. `setShopSuspended` sets the tenant status, invalidates all of the shop's sessions when suspending, and writes audit `shop_suspended` or `shop_unsuspended` with the reason.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/money.test.ts
expect(parseCedis('250')).toBe(25000);
expect(parseCedis('250.5')).toBe(25050);
expect(parseCedis('250.50')).toBe(25050);
expect(parseCedis('1,250.00')).toBe(125000);
for (const bad of ['250.505', '-1', 'abc', '', '1.2.3']) expect(parseCedis(bad)).toBeNull();

// tests/server/subscriptions.test.ts — now = 2026-10-20T10:00:00Z, adminId from createPlatformAdmin
const pay = (reference: string, months = 12): ManualPayment => ({ method: 'momo', reference, amountPesewas: 120000, periodMonths: months, planId: 'standard' });
it('extends from today when the subscription has ended', async () => {
  const s = await seedShop(db, { subscription: { status: 'active', endDate: '2026-09-01' } });
  expect(await recordManualPayment(db, adminId, s.tenantId, pay('MOMO-1'), t0)).toEqual({ ok: true, endDate: '2027-10-20' });
});
it('extends from the end date on early renewal', async () => {
  const s = await seedShop(db, { subscription: { status: 'active', endDate: '2026-12-31' } });
  expect(await recordManualPayment(db, adminId, s.tenantId, pay('MOMO-2'), t0)).toEqual({ ok: true, endDate: '2027-12-31' });
});
it('applies a payment reference only once, even concurrently', async () => {                                         // Review Focus 5
  const s = await seedShop(db, { subscription: { status: 'active', endDate: '2026-09-01' } });
  const results = await Promise.all([recordManualPayment(db, adminId, s.tenantId, pay('MOMO-3'), t0), recordManualPayment(db, adminId, s.tenantId, pay('MOMO-3'), t0)]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'duplicate_reference' }]);
  const [sub] = await asPlatform(db, (tx) => tx.select().from(subscriptions).where(eq(subscriptions.tenantId, s.tenantId)));
  expect(sub.endDate).toBe('2027-10-20');
});
it('rejects invalid payments', async () => {
  expect(await recordManualPayment(db, adminId, a.tenantId, { ...pay('X1'), amountPesewas: 0 }, t0)).toEqual({ ok: false, error: 'invalid_payment' });
  expect(await recordManualPayment(db, adminId, a.tenantId, { ...pay('X2'), periodMonths: 37 }, t0)).toEqual({ ok: false, error: 'invalid_payment' });
});
it('suspending a shop blocks sign-in and ends its sessions', async () => { /* setShopSuspended(true) → signIn access_denied; a token issued before → requireContext not_signed_in (sessions were deleted) */ });

// tests/server/platform-admin.test.ts
it('signs in a platform admin and validates the session', async () => { /* createPlatformAdmin → platformSignIn ok → requirePlatformAdmin returns name */ });
it('rejects a wrong password and expired sessions', async () => { /* access_denied; requirePlatformAdmin at +13h throws not_signed_in */ });
```

- [ ] **Step 2: Run the tests to verify they fail.** Run: `npx vitest run tests/lib/money.test.ts tests/server/subscriptions.test.ts tests/server/platform-admin.test.ts` → FAIL.
- [ ] **Step 3: Implement the modules.** `parseCedis`: trim, remove commas, require `/^\d+(\.\d{1,2})?$/`, then compute whole × 100 + the fraction padded to 2 digits. No floats. Platform admin rate key: `admin:<ip>:<email>`.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: all passed.
- [ ] **Step 5: Build the admin pages and script**

- `scripts/create-platform-admin.ts` usage: `npm run create-platform-admin -- <email> "<name>"`. It reads the password from env `PLATFORM_ADMIN_PASSWORD` (at least 12 characters) and runs migrations first.
- `admin/layout.tsx` guards every admin page except `/admin/login` with `requirePlatformAdmin`, redirecting to `/admin/login`.
- `admin/shops/[id]/page.tsx` shows the shop, its subscription state and end date, and two forms:
  - **Record payment:** method, reference, amount in GHS through `parseCedis`, months, plan.
  - **Suspend/unsuspend:** a required reason.

Run: `npm run build` → compiles.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(platform): add platform admin, manual payments, and shop suspension"
```

---

### Task 9: Shop onboarding, account activation, and shop profile

**Files:**
- Create: `src/server/onboarding.ts`
- Create: `src/app/admin/shops/page.tsx` (+ `actions.ts`), `src/app/activate/[token]/page.tsx` (+ `actions.ts`), `src/app/[slug]/app/settings/page.tsx` (+ `actions.ts`)
- Test: `tests/server/onboarding.test.ts`

**Interfaces:**
- Consumes: `applyManualPayment`, `ManualPayment` (Task 8); slug, contact, permission, and date helpers (Task 3); `sendEmail`; `Ctx`; `signIn` (in tests).
- Produces:

```ts
export type OnboardInput = { name: string; requestedSlug: string; shopType: ShopType;
  owner: { name: string; email?: string; phone?: string };
  start: { kind: 'trial' } | { kind: 'paid'; payment: ManualPayment } };
export type OnboardError =
  | { error: 'choose_another_slug'; reason: SlugProblem | 'taken' }
  | { error: 'owner_contact_required' } | { error: PaymentError };
export function onboardShop(db: Db, adminId: string, input: OnboardInput, now: Date):
  Promise<{ ok: true; tenantId: string; slug: string; activationUrl: string } | ({ ok: false } & OnboardError)>;
export function issueActivationLink(db: Db, adminId: string, tenantId: string, userId: string, now: Date): Promise<{ activationUrl: string }>;
export function activateAccount(db: Db, input: { token: string; password: string; pin?: string }, now: Date):
  Promise<{ ok: true; slug: string } | { ok: false; error: 'invalid_or_expired' | 'weak_password' | 'invalid_pin' }>;
export function updateShopProfile(db: Db, ctx: Ctx, input: { name: string; address: string; phone: string; managerPhone: string;
  taxMode: 'inclusive' | 'exclusive'; businessDayCutoff: string }): Promise<{ ok: true } | { ok: false; error: 'invalid_input' }>;
export const TOKEN_HOURS = 72;
export const MIN_PASSWORD_LENGTH = 10;
```

**`onboardShop` (spec 6.2, 6.48).** Everything happens in one `asPlatform` transaction, so any failure leaves nothing behind.
1. Slug = `normaliseSlug(requestedSlug)`. If validation fails or the slug exists, return `choose_another_slug`.
2. Normalise the owner's email and phone; if both are missing, return `owner_contact_required`.
3. Insert the tenant with `modules = DEFAULT_MODULES[shopType]`.
4. Insert the subscription:
   - **Trial:** plan `trial`, status `trial`, `end_date = addDays(today, 14)`.
   - **Paid:** plan from the payment, `end_date = today`, then `applyManualPayment`. If that fails, throw a rollback and return its error.
5. Insert branch `Main`/`B1` and register `Till 1`/`T1`.
6. Insert the owner: preset `owner`, permissions `ROLE_PRESETS.owner`, `branch_ids = [branch]`, status `pending_activation`.
7. Create an `activation` token valid for 72 hours, and write audit `shop_created`.
8. After commit, email `${APP_URL}/activate/${token}` when the owner has an email (subject `Activate your shop on ${APP_NAME}`). Always return `activationUrl` so the admin can send it by WhatsApp.

**`activateAccount`.**
- Valid token: hash matches, unused, `expires_at > now`, purpose `activation` or `invite`. Otherwise return `invalid_or_expired`.
- Password shorter than 10 characters → `weak_password`. A PIN that is present but not `/^\d{4,6}$/` → `invalid_pin`.
- On success, set the password and PIN hashes, status `active`, `used_at = now`, and return the shop's slug.

**`issueActivationLink`** marks the user's earlier unused tokens as used, then creates a new 72-hour token.

**`updateShopProfile`** requires `manage_shop_settings` (otherwise throws `AccessError('forbidden')`). Phones go through `normaliseGhanaPhone`; the cutoff must match `/^([01]\d|2[0-3]):[0-5]\d$/`. Invalid input returns `invalid_input`.

- [ ] **Step 1: Write the failing test** (mock email: `vi.mock('@/server/email', () => ({ sendEmail: vi.fn() }))`; `t0 = 2026-10-20T10:00:00Z`; `pay()` is the same helper as in Task 8's tests)

```ts
const base: OnboardInput = { name: 'Ama Pharmacy', requestedSlug: 'Ama Pharmacy', shopType: 'pharmacy', owner: { name: 'Ama', phone: '024 123 4567' }, start: { kind: 'trial' } };
it('creates a trial shop with branch, till, owner, and token', async () => {
  const r = await onboardShop(db, adminId, base, t0);
  expect(r).toMatchObject({ ok: true, slug: 'ama-pharmacy' });
  const t = (await asPlatform(db, (tx) => tx.select().from(tenants)))[0];
  expect(t.modules).toEqual(['batches', 'prescriptions', 'units']);
  expect(t.timezone).toBe('Africa/Accra');
  const [sub] = await asPlatform(db, (tx) => tx.select().from(subscriptions));
  expect(sub).toMatchObject({ planId: 'trial', status: 'trial', endDate: '2026-11-03' });
  // branch code 'B1', register code 'T1', owner phone '233241234567' status 'pending_activation', audit 'shop_created'
});
it('refuses reserved and taken slugs', async () => {
  expect(await onboardShop(db, adminId, { ...base, requestedSlug: 'Admin' }, t0)).toEqual({ ok: false, error: 'choose_another_slug', reason: 'reserved' });
  await onboardShop(db, adminId, base, t0);
  expect(await onboardShop(db, adminId, base, t0)).toEqual({ ok: false, error: 'choose_another_slug', reason: 'taken' });
});
it('requires an owner email or phone', async () => {
  expect(await onboardShop(db, adminId, { ...base, owner: { name: 'Ama' } }, t0)).toEqual({ ok: false, error: 'owner_contact_required' });
});
it('rolls back everything when the paid start fails', async () => {
  await onboardShop(db, adminId, { ...base, requestedSlug: 'first', start: { kind: 'paid', payment: pay('REF-1') } }, t0);
  expect(await onboardShop(db, adminId, { ...base, requestedSlug: 'second', start: { kind: 'paid', payment: pay('REF-1') } }, t0)).toEqual({ ok: false, error: 'duplicate_reference' });
  expect((await asPlatform(db, (tx) => tx.select().from(tenants))).map((x) => x.slug)).toEqual(['first']);
});
it('activates once, then the owner can sign in', async () => {
  const r = await onboardShop(db, adminId, base, t0) as { activationUrl: string };
  const token = r.activationUrl.split('/activate/')[1];
  expect(await activateAccount(db, { token, password: 'short' }, t0)).toEqual({ ok: false, error: 'weak_password' });
  expect(await activateAccount(db, { token, password: 'long-enough-1', pin: '12a4' }, t0)).toEqual({ ok: false, error: 'invalid_pin' });
  expect(await activateAccount(db, { token, password: 'long-enough-1', pin: '1234' }, t0)).toEqual({ ok: true, slug: 'ama-pharmacy' });
  expect(await activateAccount(db, { token, password: 'long-enough-1' }, t0)).toEqual({ ok: false, error: 'invalid_or_expired' });
  expect(await signIn(db, { slug: 'ama-pharmacy', identifier: '0241234567', password: 'long-enough-1', ip: '1.1.1.1' }, t0)).toMatchObject({ ok: true });
});
it('expires activation links after 72 hours', async () => { /* activate at t0 + 73h → invalid_or_expired */ });
it('a new activation link cancels the old one', async () => { /* issueActivationLink → old token invalid_or_expired, new token ok */ });
it('updates the shop profile with validation', async () => { /* owner ctx: cutoff '04:00' ok; '24:00' → invalid_input; cashier ctx → AccessError forbidden */ });
```

- [ ] **Step 2: Run the test to verify it fails.** Run: `npx vitest run tests/server/onboarding.test.ts` → FAIL.
- [ ] **Step 3: Implement `src/server/onboarding.ts`** as described.
- [ ] **Step 4: Run the test to verify it passes.** Expected: 8 passed.
- [ ] **Step 5: Build the pages**

- **`admin/shops/page.tsx`:** a list of shops (name, slug, type, status, subscription state, end date) and a create form (name, slug, type, owner name, email, phone, then trial or paid with the payment fields). On success it shows `activationUrl` with a "Copy link" button; each shop row has an "Issue new activation link" action.
- **`activate/[token]/page.tsx`:** password, confirm password, and an optional PIN. Mismatched passwords show "Passwords do not match." Success redirects to `/<slug>/login`. Error copy:

  | Error | Message |
  | --- | --- |
  | `invalid_or_expired` | "This link has expired or was already used. Ask for a new one." |
  | `weak_password` | "Use at least 10 characters." |
  | `invalid_pin` | "PIN must be 4 to 6 digits." |

- **`[slug]/app/settings/page.tsx`:** the profile form, guarded with `manage_shop_settings`.

Run: `npm run build` → compiles.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(onboarding): create shops, activate accounts, and edit shop profile"
```

---

### Task 10: Plan limits, branches, tills, and staff

**Files:**
- Create: `src/server/plan-limits.ts`, `src/server/branches.ts`, `src/server/staff.ts`
- Create: `src/app/[slug]/app/staff/page.tsx` (+ `actions.ts`); modify `src/app/[slug]/app/settings/page.tsx` (branches and tills section)
- Test: `tests/server/staff.test.ts`, `tests/server/branches.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `Ctx`, `AccessError`, `ROLE_PRESETS`, `PERMISSIONS`, contact helpers, `newToken`/`tokenHash`, `invalidateUserSessions`, `sendEmail`, `writeAudit`, `TOKEN_HOURS`.
- Produces:

```ts
// src/server/plan-limits.ts
export type LimitedResource = 'branches' | 'registers' | 'staff';
export function checkPlanLimit(tx: Tx, tenantId: string, resource: LimitedResource): Promise<'ok' | 'limit_reached'>;
// src/server/branches.ts  (requires manage_shop_settings)
export function addBranch(db: Db, ctx: Ctx, input: { name: string; branchCode: string; address?: string; phone?: string }):
  Promise<{ ok: true; branchId: string } | { ok: false; error: 'limit_reached' | 'duplicate_code' | 'invalid_input' }>;
export function addRegister(db: Db, ctx: Ctx, input: { branchId: string; name: string; registerCode: string }):
  Promise<{ ok: true; registerId: string } | { ok: false; error: 'limit_reached' | 'duplicate_code' | 'unknown_branch' | 'invalid_input' }>;
// src/server/staff.ts  (requires manage_staff)
export function addStaff(db: Db, ctx: Ctx, input: { name: string; email?: string; phone?: string; rolePreset: 'manager' | 'cashier'; branchIds: string[] }, now: Date):
  Promise<{ ok: true; userId: string; inviteUrl: string } | { ok: false; error: 'limit_reached' | 'contact_required' | 'duplicate_contact' | 'unknown_branch' }>;
export function resetStaffAccess(db: Db, ctx: Ctx, staffId: string, now: Date):
  Promise<{ ok: true; inviteUrl: string } | { ok: false; error: 'not_found' | 'cannot_change_owner' }>;
export function deactivateStaff(db: Db, ctx: Ctx, staffId: string, reason: string):
  Promise<{ ok: true } | { ok: false; error: 'not_found' | 'cannot_change_owner' | 'cannot_change_self' }>;
export function setStaffPermissions(db: Db, ctx: Ctx, staffId: string, permissions: string[]):
  Promise<{ ok: true } | { ok: false; error: 'not_found' | 'cannot_change_owner' | 'invalid_permission' }>;
```

**Rules:**
- Every function checks `ctx.permissions` for its required permission and throws `AccessError('forbidden')` if it is missing. All writes happen in one `withTenant` transaction that first locks the tenant row (`select … from tenants where id = $1 for update`), so two simultaneous adds cannot both pass the limit.
- Limits come from `plans.limits` of the shop's subscription plan:
  - `branches` counts all branches.
  - `registers` counts tills with status `active`.
  - `staff` counts users whose status is not `inactive` (the owner counts).
- Branch and till codes are uppercase and must match `/^[A-Z0-9]{1,6}$/`.
- Invites: status `invited`, permissions from the preset, a 72-hour `invite` token. Email is sent when an address exists, and `inviteUrl = ${APP_URL}/activate/${token}` is always returned.
- Owners cannot be added, reset, deactivated, or edited here, and nobody can deactivate themselves.
- `resetStaffAccess` clears the password, PIN, and failed count, sets status `invited`, ends sessions, cancels unused tokens, and issues a new invite.
- `deactivateStaff` sets status `inactive`, calls `invalidateUserSessions`, and writes audit `staff_deactivated` with the reason.
- `setStaffPermissions` rejects any value not in `PERMISSIONS`.

- [ ] **Step 1: Write the failing tests**

```ts
// trial shop: limits staff 5, branches 1, registers 2 (seedShop with subscription { status: 'trial', endDate: '2026-11-03', planId: 'trial' })
it('stops at the plan staff limit and frees a place on deactivation', async () => {
  const ctx = await ctxFor(db, shop, 'owner', t0, 'manage_staff');
  for (let i = 1; i <= 4; i++) expect(await addStaff(db, ctx, { name: `S${i}`, phone: `024000000${i}`, rolePreset: 'cashier', branchIds: [shop.branchId] }, t0)).toMatchObject({ ok: true });
  const fifth = { name: 'S5', phone: '0240000005', rolePreset: 'cashier' as const, branchIds: [shop.branchId] };
  expect(await addStaff(db, ctx, fifth, t0)).toEqual({ ok: false, error: 'limit_reached' });
  // deactivate S1 → addStaff(fifth) ok
});
it('rejects duplicate contacts within a shop but allows them across shops', async () => { /* same phone twice in shop → duplicate_contact; same phone in other shop → ok */ });
it('requires an email or phone and known branches', async () => { /* contact_required; unknown branch id → unknown_branch */ });
it('ends a deactivated member’s sessions immediately', async () => { /* session for staff → deactivateStaff → validateSession null */ });
it('protects the owner and the acting user', async () => { /* deactivate owner → cannot_change_owner; manager deactivating self → cannot_change_self */ });
it('lets a cashier do none of this', async () => { await expectAccess(ctxFor(db, shop, 'cashier', t0, 'manage_staff'), 'forbidden'); });
it('reset access issues a new invite and clears the PIN', async () => { /* inviteUrl differs; pin_hash null; status invited; old invite token invalid */ });
it('rejects unknown permissions', async () => { expect(await setStaffPermissions(db, ctx, cashierId, ['make_sale', 'fly'])).toEqual({ ok: false, error: 'invalid_permission' }); });
// tests/server/branches.test.ts
it('enforces branch and till limits on the trial plan', async () => {
  expect(await addBranch(db, ctx, { name: 'Kumasi', branchCode: 'B2' })).toEqual({ ok: false, error: 'limit_reached' });
  expect(await addRegister(db, ctx, { branchId: shop.branchId, name: 'Till 2', registerCode: 'T2' })).toMatchObject({ ok: true });
  expect(await addRegister(db, ctx, { branchId: shop.branchId, name: 'Till 3', registerCode: 'T3' })).toEqual({ ok: false, error: 'limit_reached' });
});
it('rejects duplicate and malformed codes', async () => { /* standard plan: 'B1' again → duplicate_code; 'b-2' → invalid_input */ });
```

- [ ] **Step 2: Run the tests to verify they fail.** Run: `npx vitest run tests/server/staff.test.ts tests/server/branches.test.ts` → FAIL.
- [ ] **Step 3: Implement** `plan-limits.ts`, `branches.ts`, and `staff.ts` following the rules above.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: all passed.
- [ ] **Step 5: Build the pages**

- **Staff page:** a table of staff (name, role, status, branches). Actions:
  - "Add staff" form; on success shows the invite link with a Copy button and the note "Send this link by WhatsApp or SMS."
  - "Reset access": shows the new invite link.
  - "Deactivate": asks for a reason.
  - Permission checkboxes.
- **Settings page:** lists branches and tills, with add forms. When a plan limit is hit, show "Your plan allows no more {branches|tills|staff}. Upgrade to add more."

Run: `npm run build` → compiles.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(shop): add plan limits, branches, tills, and staff management"
```

---

### Task 11: Device registration and PIN switching

**Files:**
- Create: `src/server/devices.ts`
- Create: `src/app/[slug]/app/devices/page.tsx` (+ `actions.ts`), `src/app/[slug]/till/page.tsx` (+ `actions.ts`)
- Test: `tests/server/devices.test.ts`

**Interfaces:**
- Consumes: `createSession`, `verifySecret`, `newToken`, `tokenHash`, `writeAudit`, `Ctx`, `DEVICE_COOKIE`, `SESSION_COOKIE`.
- Produces:

```ts
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MINUTES = 15;
export type PinError = 'device_not_registered' | 'not_assigned' | 'pin_locked' | 'wrong_pin';
export function registerDevice(db: Db, ctx: Ctx, registerId: string, now: Date): Promise<{ ok: true; deviceToken: string } | { ok: false; error: 'unknown_register' }>; // requires manage_devices
export function findDeviceRegister(db: Db, deviceToken: string | undefined):
  Promise<{ tenantId: string; slug: string; branchId: string; registerId: string; registerName: string } | null>;
export function listTillStaff(db: Db, deviceToken: string | undefined): Promise<Array<{ id: string; name: string }> | null>;
export function switchCashierWithPin(db: Db, input: { deviceToken: string | undefined; staffId: string; pin: string }, now: Date):
  Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; error: PinError }>;
```

**Rules (spec 6.1):**
- `registerDevice` stores `tokenHash(deviceToken)` on the till, replacing any previous device so the old one stops working, sets `device_registered_at`, and writes audit `device_registered`. The device cookie lasts 1 year.
- `listTillStaff` returns active users assigned to the till's branch who have `make_sale` and a PIN, ordered by name.
- `switchCashierWithPin` checks, in order:
  1. Device unknown → `device_not_registered`.
  2. Staff is not an active member of that tenant, not assigned to the branch, without `make_sale`, or without a PIN → `not_assigned`.
  3. `pin_locked_until > now` → `pin_locked`.
  4. Wrong PIN → atomically `update … set failed_pin_count = failed_pin_count + 1 … returning failed_pin_count`. When the count reaches 5, set `pin_locked_until = now + 15 min` and write audit `pin_locked` (`actorType: 'system'`, `recordType: 'user'`, `recordId: staffId`). Return `wrong_pin`.
  5. Correct PIN → reset the count and lock, create a `pin` session for this till, write audit `pin_sign_in`.

**UI copy** (exact strings):

| Error | Message |
| --- | --- |
| `device_not_registered` | "This device is not registered as a till. Ask a manager to register it." |
| `not_assigned` | "You are not set up to sell on this till." |
| `pin_locked` | "PIN locked for 15 minutes. Your manager has been told." |
| `wrong_pin` | "Wrong PIN." |

- [ ] **Step 1: Write the failing test**

```ts
// shop with cashier { key: 'kofi', phone: '0201234567', rolePreset: 'cashier', pin: '5678' }
it('refuses unregistered devices', async () => {
  expect(await switchCashierWithPin(db, { deviceToken: 'nope', staffId: kofi, pin: '5678' }, t0)).toEqual({ ok: false, error: 'device_not_registered' });
});
it('switches to a cashier with the right PIN', async () => {
  const { deviceToken } = await registerDevice(db, ownerCtx, shop.registerId, t0) as { deviceToken: string };
  expect(await listTillStaff(db, deviceToken)).toEqual([{ id: kofi, name: 'kofi' }]); // the owner has no PIN in this fixture
  const r = await switchCashierWithPin(db, { deviceToken, staffId: kofi, pin: '5678' }, t0);
  expect(await validateSession(db, (r as { token: string }).token, t0)).toMatchObject({ kind: 'pin', registerId: shop.registerId, rolePreset: 'cashier' });
});
it('locks the PIN after 5 wrong tries for 15 minutes', async () => {
  for (let i = 0; i < 5; i++) expect(await switchCashierWithPin(db, { deviceToken, staffId: kofi, pin: '0000' }, t0)).toEqual({ ok: false, error: 'wrong_pin' });
  expect(await switchCashierWithPin(db, { deviceToken, staffId: kofi, pin: '5678' }, new Date(t0.getTime() + 60_000))).toEqual({ ok: false, error: 'pin_locked' });
  expect(await switchCashierWithPin(db, { deviceToken, staffId: kofi, pin: '5678' }, new Date(t0.getTime() + 16 * 60_000))).toMatchObject({ ok: true });
  // audit has one 'pin_locked' row; users.failed_pin_count is 0 after success
});
it('refuses staff from another branch or shop', async () => { /* staff with branchIds [] → not_assigned; staffId from another shop → not_assigned */ });
it('re-registering a till cuts off the old device', async () => { /* second registerDevice → old token device_not_registered */ });
it('requires manage_devices to register', async () => { /* cashier ctx → AccessError forbidden */ });
```

(Seed the fixture user with `name: 'kofi'` so the list assertion holds.)

- [ ] **Step 2: Run the test to verify it fails.** Run: `npx vitest run tests/server/devices.test.ts` → FAIL.
- [ ] **Step 3: Implement `src/server/devices.ts`** following the rules above.
- [ ] **Step 4: Run the test to verify it passes.** Expected: 6 passed.
- [ ] **Step 5: Build the pages**

- **Devices page:** lists tills (name, code, registered on date). "Use this device as {till}" calls `registerDevice` and sets `DEVICE_COOKIE` (httpOnly, 1 year).
- **`/[slug]/till`:** no valid device → the `device_not_registered` message. Otherwise a grid of staff names, then a PIN pad of 4–6 digits. Success sets `SESSION_COOKIE` and redirects to `/<slug>/app`; errors show the UI copy.

Run: `npm run build` → compiles.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(devices): register till devices and switch cashiers by PIN"
```

---

### Task 12: Shop home page and end-to-end check

**Files:**
- Create: `src/server/home.ts`, `src/app/[slug]/app/page.tsx`, `.claude/launch.json`
- Test: `tests/server/home.test.ts`

**Interfaces:**
- Consumes: `Ctx`, `withTenant`, `subscriptions`, `auditLog`, `addDays`, `todayIn`.
- Produces:

```ts
export type HomeSummary = { shopName: string; userName: string; rolePreset: RolePreset; banner: string | null;
  securityEvents: Array<{ action: string; at: Date; detail: string }> };
export function getHomeSummary(db: Db, ctx: Ctx, now: Date): Promise<HomeSummary>;
```

**Banner copy** (dates are `YYYY-MM-DD` in the shop's timezone):

| State | Banner |
| --- | --- |
| `trial` | `Free trial: ${daysLeft} days left.` (`daysLeft` = end date − today) |
| `grace` | `Your subscription ended on ${endDate}. Renew within ${graceDaysLeft} days to keep selling.` (`graceDaysLeft` = end date + grace days − today) |
| `read_only` | `Your subscription has ended. You can view and export records. Renew to sell again.` |
| `active` | `null` |

`securityEvents` is empty unless `ctx.permissions` includes `view_dashboard`. Otherwise it holds the last 10 audit rows with action in `failed_sign_in`, `pin_locked`, `staff_deactivated`, `device_registered`, newest first. `detail` is the identifier for `failed_sign_in`, and the record id or reason for the others.

- [ ] **Step 1: Write the failing test**

```ts
it('shows trial days left', async () => { /* trial ending '2026-11-03', now 2026-10-20T10:00Z */ expect((await getHomeSummary(db, ctx, t0)).banner).toBe('Free trial: 14 days left.'); });
it('shows the grace banner', async () => { /* active ending '2026-10-15' */ expect(banner).toBe('Your subscription ended on 2026-10-15. Renew within 9 days to keep selling.'); });
it('shows the read-only banner', async () => { /* active ending '2026-09-01' */ expect(banner).toBe('Your subscription has ended. You can view and export records. Renew to sell again.'); });
it('shows security events to managers but not cashiers', async () => { /* one failed sign-in → owner sees [{ action: 'failed_sign_in', detail: 'ama@x.test' }]; cashier sees [] */ });
```

(Grace check: 2026-10-15 + 14 days = 2026-10-29, which is 9 days after 2026-10-20.)

- [ ] **Step 2: Run the test to verify it fails.** Run: `npx vitest run tests/server/home.test.ts` → FAIL.
- [ ] **Step 3: Implement `getHomeSummary`** and the home page. The page shows the shop name, the user and role, the banner, links to Settings, Staff, and Devices (only when the user has the matching permission), the security events list, and a "Sign out" button.
- [ ] **Step 4: Run the full suite.** Run: `npm run test` → all passed. Run: `npm run build` → compiles.
- [ ] **Step 5: End-to-end check in the browser preview**

`.claude/launch.json`: `{ "version": "0.0.1", "configurations": [{ "name": "pos-dev", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3000 }] }`.

1. Run `npm run db:migrate`, then `PLATFORM_ADMIN_PASSWORD=<12+ chars> npm run create-platform-admin -- admin@test.local "Admin"`.
2. Start the `pos-dev` preview. At `/admin/login`, sign in and create the trial shop "Ama Provisions" (slug `ama-provisions`, retail, owner phone `0241234567`). Copy the activation link.
3. Open the link and set a password and PIN `1234`. At `/ama-provisions/login`, sign in with `024 123 4567`. Expected: the home page shows "Free trial: 14 days left."
4. On Staff, add cashier "Kofi" with phone `0201234567`. Open the invite link in a private window and set a password and PIN `5678`.
5. On Devices, choose "Use this device as Till 1". Open `/ama-provisions/till`, pick Kofi, and enter `5678`. Expected: the home page for a cashier, with no Staff link and no security events.
6. Back on the till, enter a wrong PIN for Kofi 5 times. Expected: "PIN locked for 15 minutes. Your manager has been told." Signed in as the owner, the home page lists `pin_locked`.
7. Create a second shop `other-shop` in admin, then open `/other-shop/app` in the owner's browser. Expected: redirected to `/other-shop/login`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(shop): add home page with subscription banner and security events"
```

---

## Production setup (for reference; needs the owner's accounts)

1. Create a Supabase project. Set `DATABASE_URL` to the pooler URL in transaction mode.
2. Run `npm run db:migrate` once. This creates `pos_app`, the tables, the RLS policies, and the plan seed.
3. Run `create-platform-admin` against production.
4. On Vercel, set `DATABASE_URL`, `APP_URL`, `APP_NAME`, `RESEND_API_KEY`, and `EMAIL_FROM`.
