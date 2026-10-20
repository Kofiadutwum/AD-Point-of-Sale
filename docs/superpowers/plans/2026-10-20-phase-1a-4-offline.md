# Phase 1a · Plan 4 of 4: Offline Till (PWA) and Owner MFA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A registered till keeps selling for cash and manually confirmed payments when the internet drops. It stores each sale in an on-device outbox and syncs it safely when the connection returns. Owners and managers can turn on TOTP two-step sign-in.

**Architecture:** The selling screen `/[slug]/till/sell` is a local-first client page. It reads only the device cache in IndexedDB and writes every sale to an IndexedDB outbox, then posts it to Plan 3's `POST /api/[slug]/sales`. The same screen works online and offline. The server serves the device cache from routes that authenticate with the `pos_device` cookie alone, so a till can load before anyone signs in. A `device_cache_versions` row, bumped by database triggers whenever cached data changes, tells tills when to refetch. A service worker (`public/sw.js`) serves the page shell, Next.js static chunks, and product photos from Cache Storage. MFA adds a sign-in challenge between the password step and the session, with a sealed TOTP secret and hashed recovery codes.

**Tech Stack:** Next.js 16 App Router · Drizzle + PGlite tests · `idb` 8 (IndexedDB) · `hash-wasm` 4 (argon2id in the browser) · `qrcode` 1.5 (SVG QR for MFA) · `fake-indexeddb` 6 (tests) · Vitest.

**Spec:** `docs/superpowers/specs/2026-10-20-multishop-pos-design.md`, sections 4.9, 6.0, 6.1, 6.2, 6.6, 6.8, 6.10. Shared sale contract with Plan 3: the brief, plus `plan-3-selling-contract.md` in the session notes folder (summarised under Global Constraints).

## Not in this plan

- Discounts and manager approvals on the device till. Every line is sent with `discountPesewas: 0`. Plan 3's online sell page `src/app/[slug]/app/sell/` handles discounts.
- Serial-tracked items on the device till. The till refuses them with "Sell serial items on the online sell page."
- Customers, store credit, and customer price lists on the device till. Store credit is not allowed offline (contract).
- Cached stock levels ("reduce cached stock for display only"): there is no stock data until Plan 3 merges.
- Telling the manager about PIN locks that happen offline. The lock is enforced on the device only.
- MFA for platform admins. Asking for the MFA code again before sensitive actions.
- Receipt sharing by link, WhatsApp, or PDF (Plan 3 receipts). The device till shows an on-screen receipt and uses `window.print()`.
- Push invalidation. Tills poll the cache version every 60 seconds instead.

## Global Constraints

- Offline, the device accepts cash and manually confirmed payments only (4.9): `cash`, `momo_manual`, `card_terminal`, `bank_transfer`. It never offers `store_credit`.
- Receipt number: `<branchCode>-<registerCode>-<6 digits>`, e.g. `ACC1-T2-000123`. Each register keeps its own counter, online or offline (6.0). It must match `^[A-Z0-9]{1,6}-[A-Z0-9]{1,6}-\d{6}$` (Plan 3).
- After a reinstall, the device restores its counter from `GET /api/[slug]/register/counter` → `{ registerCode, lastCounter }`, sending the `pos_device` cookie. Local counter = max(local, lastCounter).
- Device cache is refreshed every 15 minutes and after any catalogue change (6.10). It holds variants, units, barcodes, prices, tax rules, product images, shop settings, permissions, and the PIN hashes of staff assigned to this register's branch.
- Offline limit: the device must have synced in the last 72 hours (4.9). A shop can switch offline mode off (`tenants.offline_enabled`, default true).
- Offline receipts are marked exactly `Offline – pending sync`.
- Sync runs oldest first, when the connection returns and every minute while sales are queued (6.10). The sale ID is the idempotency key (6.0).
- Sale contract, `POST /api/[slug]/sales`. Request body: `{ saleId, receiptNumber, lines: [{ variantId, unitId, quantity, unitPricePesewas, discountPesewas, serials? }], tenders: [{ id, method, amountPesewas, reference? }], customerId?, cashierId?, deviceCreatedAt, fromOfflineOutbox? }`. Response: `{ ok: true, saleId, status, changeDuePesewas, alreadyExisted }` | `{ ok: false, error }`.
- How the device handles each status: 200 = done (including `alreadyExisted`); 400 and 409 = permanent, held for manager review; 401 and 403 = ask for a PIN and keep the sale queued; 5xx, network errors, and 404 (the route is missing until Plan 3 merges) = temporary, retry with backoff. Outbox sends use `fromOfflineOutbox: true`.
- `cashierId` is always the staff member who made the sale. An online send with a `cashierId` that is not the session user gets 409 `cashier_not_allowed`. So the device sends online (`fromOfflineOutbox: false`) only when the active cashier is the one who switched in on the server.
- Only registered devices sell offline. Deregistering a device wipes its cached PINs on the next connection (4.9).
- PIN: 4–6 digits. Five wrong PINs lock it for 15 minutes (6.1), offline too.
- MFA: RFC 6238 TOTP, HMAC-SHA1, 6 digits, 30-second step, ±1 step window, and a code's step can never be used twice. 10 single-use recovery codes. A sign-in challenge lasts 5 minutes and allows 5 tries. PIN sessions never carry more than `TILL_PERMISSIONS` and cannot manage MFA.
- Plan 1 rules still apply: shop data only through `withTenant()`; RLS on every new table with `tenant_id` (`tests/db/rls.test.ts`); money in integer pesewas; services take `now: Date` last; `assertPermission` in every service acting for a signed-in user; every file in `src/server/` and `src/db/` starts with `import 'server-only';`. Device-token services (no user) authenticate with `findDeviceRegister()`, like `listTillStaff()`. MFA services act on the caller's own account and check for a password session instead of a permission.
- Browser code (`src/device/**`, `src/lib/device-contract.ts`, `src/lib/cart-totals.ts`) must never import a `server-only` module. Type-only imports from `@/db/schema` are fine; `src/lib/pricing.ts` already does this.
- Migrations: this branch adds `0006_*` (generated) and `0007_offline_rls.sql` (custom). Plan 3 also adds `0006`. Whichever branch merges second deletes its own migration files and journal entries and regenerates them on top.

## Review Focus

1. **A sale sent twice** (the connection drops after the server saved it): the retry gets `alreadyExisted: true`, leaves the outbox, and creates no second sale. → Task 9, `removes a sale the server already has`.
2. **A cashier deactivated while their sale waits offline:** that sale is held for manager review and reported to the dashboard, and the sales behind it still send. → Task 9, `holds a refused sale for review and keeps syncing the rest`.
3. **A device deregistered while it has queued sales:** cached PINs and catalogue are wiped and the queued sales are kept. → Task 9, `wipes PINs but keeps the outbox when the device was removed`.
4. **A server PIN refusal must never fall back to the offline check:** a locked or wrong PIN from the server is final, and only a network failure uses the cached hash. → Task 8, `uses the cached hash only when the server cannot be reached`.
5. **Reinstalled device:** the receipt counter continues after the server's last counter, never below the local one. → Task 9, `restores the receipt counter to the larger of local and server`.

---

### Task 1: Shared cart totals (spec 6.6)

**Files:**
- Create: `src/lib/cart-totals.ts`
- Test: `tests/lib/cart-totals.test.ts`
- Copy both, byte for byte, to the notes folder `C:\Users\kofia\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\side-session-notes\local_cf49b0bc-95d0-4833-beee-1d65ef4dd0a0\` (Plan 3 adds the identical files).

**Interfaces:**
- Produces:
  ```ts
  export type CartLineInput = { unitPricePesewas: number; quantity: string; discountPesewas: number; labelPricePesewas?: number | null; taxRateBp: number };
  export type CartLineTotals = { grossPesewas: number; discountPesewas: number; netPesewas: number; taxPesewas: number; totalPesewas: number };
  export type CartTotals = { lines: CartLineTotals[]; subtotalPesewas: number; discountPesewas: number; taxPesewas: number; totalPesewas: number };
  export function calculateCartTotals(lines: CartLineInput[], opts: { taxMode: 'inclusive' | 'exclusive' }): CartTotals;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const line = (o: Partial<CartLineInput> = {}): CartLineInput => ({ unitPricePesewas: 500, quantity: '1.000', discountPesewas: 0, taxRateBp: 0, ...o });
it('rounds price × quantity half up once per line', () => {
  expect(calculateCartTotals([line({ unitPricePesewas: 1999, quantity: '0.250' })], { taxMode: 'exclusive' }).lines[0].grossPesewas).toBe(500);
});
it('uses the scale label price instead of price × quantity', () => {
  expect(calculateCartTotals([line({ quantity: '0.333', labelPricePesewas: 170 })], { taxMode: 'exclusive' }).totalPesewas).toBe(170);
});
it('adds tax on top in exclusive mode', () => {
  expect(calculateCartTotals([line({ unitPricePesewas: 2000, discountPesewas: 500, taxRateBp: 1500 })], { taxMode: 'exclusive' }))
    .toEqual({ lines: [{ grossPesewas: 2000, discountPesewas: 500, netPesewas: 1500, taxPesewas: 225, totalPesewas: 1725 }],
      subtotalPesewas: 2000, discountPesewas: 500, taxPesewas: 225, totalPesewas: 1725 });
});
it('takes tax out of the price in inclusive mode', () => {
  expect(calculateCartTotals([line({ unitPricePesewas: 1150, taxRateBp: 1500 })], { taxMode: 'inclusive' }).lines[0]).toMatchObject({ taxPesewas: 150, totalPesewas: 1150 });
  expect(calculateCartTotals([line({ unitPricePesewas: 1000, taxRateBp: 1500 })], { taxMode: 'inclusive' }).lines[0].taxPesewas).toBe(130);
});
it('sums lines and handles an empty cart', () => { /* two lines → sums; [] → all zeros */ });
it('refuses a discount above the line amount and non-integer money', () => {
  expect(() => calculateCartTotals([line({ discountPesewas: 501 })], { taxMode: 'exclusive' })).toThrow(RangeError);
  expect(() => calculateCartTotals([line({ unitPricePesewas: 1.5 })], { taxMode: 'exclusive' })).toThrow(RangeError);
});
```

- [ ] **Step 2:** `npx vitest run tests/lib/cart-totals.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement with `pesewasTimesQty` and `divHalfUp`. Inclusive: `tax = net − divHalfUp(net × 10000, 10000 + rate)`. Exclusive: `tax = divHalfUp(net × rate, 10000)`. No imports outside `src/lib`.
- [ ] **Step 4:** Run → PASS. Copy both files to the notes folder.
- [ ] **Step 5:** Commit `feat(lib): add cart totals shared by the server and the device till`.

### Task 2: Schema, RLS, and the cache version triggers

**Files:**
- Modify: `src/db/schema/tenancy.ts` (`tenants.offlineEnabled`), `src/db/schema/people.ts` (MFA columns), `src/db/schema/index.ts`
- Create: `src/db/schema/security.ts`, `src/db/schema/offline.ts`
- Generate: `drizzle/0006_*.sql` (`npx drizzle-kit generate`) and `drizzle/0007_offline_rls.sql` (`npx drizzle-kit generate --custom --name=offline_rls`)
- Test: `tests/db/offline-schema.test.ts`

**Interfaces:**
- Produces (Drizzle):
  - `tenants.offlineEnabled` boolean `offline_enabled` not null default true.
  - `users.mfaSecret` text (sealed), `users.mfaEnabledAt` timestamptz, `users.mfaLastStep` bigint (mode number).
  - `mfaRecoveryCodes` (`id`, `tenantId`, `userId` → users, `codeHash` text, `usedAt`, `createdAt`; unique `(user_id, code_hash)`).
  - `mfaChallenges` (`id` text pk = sha256 of token, `tenantId`, `userId`, `expiresAt`, `attempts` int default 0, `createdAt`).
  - `heldSales` (`id`, `tenantId`, `registerId` → registers, `saleId` uuid, `receiptNumber`, `cashierId` uuid null (no FK: device-sent), `totalPesewas` int, `error` text, `sale` jsonb, `deviceCreatedAt`, `reportedAt`, `resolvedAt`, `resolvedBy` → users, `resolution` text `'resolved' | 'synced'`, `note` text; unique `(tenant_id, sale_id)`).
  - `deviceCacheVersions` (`tenantId` uuid pk → tenants, `version` bigint not null default 0).

- [ ] **Step 1: Write the failing tests**

```ts
const version = (tenantId: string) => asPlatform(db, (tx) => tx.select().from(deviceCacheVersions).where(eq(deviceCacheVersions.tenantId, tenantId))).then((r) => r[0]?.version ?? 0);
it('bumps the shop version when catalogue rows change', async () => { /* productFor(ctx) → version(a) > before; version(b) unchanged */ });
it('bumps on PIN, staff status, and offline setting changes', async () => { /* update users.pinHash, users.status, tenants.offlineEnabled → each bumps */ });
it('ignores receipt counter, average cost, and failed PIN count changes', async () => {
  /* update registers.receiptCounter, variants.averageCost, users.failedPinCount → version unchanged */
});
it('pos_app sees only its own held sales and MFA rows', async () => { /* insert for a and b via asPlatform; withTenant(a) sees 1 of each */ });
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add the schema and generate `0006`. Write `0007_offline_rls.sql`: `ENABLE ROW LEVEL SECURITY` and the same `tenant_isolation` policy as `0005_catalogue_rls.sql` on `mfa_recovery_codes`, `mfa_challenges`, `held_sales`, and `device_cache_versions`. Then the trigger function and its triggers (every statement separated by `--> statement-breakpoint`):

```sql
CREATE FUNCTION bump_device_cache_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t uuid;
BEGIN
  -- TG_ARGV[0] names the tenant column: 'id' on tenants, 'tenant_id' elsewhere
  t := (to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END) ->> TG_ARGV[0])::uuid;
  INSERT INTO device_cache_versions AS v (tenant_id, version) VALUES (t, 1)
    ON CONFLICT (tenant_id) DO UPDATE SET version = v.version + 1;
  RETURN NULL;
END $$;
```

  - `AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id')` on `products`, `variant_units`, `barcodes`, `tax_rules`, `price_lists`, `price_list_items`, and `product_images`.
  - `tenants`: `AFTER UPDATE`, argument `'id'`.
  - Tables with volatile columns get two triggers: `AFTER INSERT OR DELETE`, plus `AFTER UPDATE ... WHEN (<allow-list of OLD columns> IS DISTINCT FROM <same NEW columns>)`.
    - `variants`: `WHEN ((to_jsonb(OLD) - 'average_cost') IS DISTINCT FROM (to_jsonb(NEW) - 'average_cost'))`.
    - `users`: `(name, permissions, branch_ids, pin_hash, status, pin_locked_until)`.
    - `registers`: `(name, register_code, branch_id, device_token_hash, status)`.
    - `branches`: `(name, branch_code)`.
  - `held_sales`: `AFTER UPDATE WHEN (OLD.resolved_at IS DISTINCT FROM NEW.resolved_at)`.
- [ ] **Step 4:** `npx vitest run tests/db` → PASS (the generic RLS tests pick up the new tables).
- [ ] **Step 5:** Commit `feat(db): add offline, held sale, MFA tables and device cache version triggers`.

### Task 3: TOTP and sealed secrets

**Files:**
- Create: `src/server/totp.ts`, `src/server/secret-box.ts`
- Modify: `.env.example` (`MFA_SECRET_KEY=`, base64 of 32 random bytes, required in production)
- Test: `tests/server/totp.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // totp.ts
  export function newTotpSecret(): string;                       // 20 random bytes, base32 (32 chars)
  export function totpStep(now: Date): number;                   // floor(unix seconds / 30)
  export function totpAt(secret: string, step: number, digits?: number): string; // digits default 6
  export function matchTotp(secret: string, code: string, now: Date, lastStep: number | null): number | null; // matched step in [step-1, step+1] and > lastStep
  export function otpauthUri(secret: string, label: { issuer: string; account: string }): string;
  // secret-box.ts
  export function sealSecret(plain: string): string;             // 'v1.' + base64url(iv 12 | tag 16 | ciphertext), AES-256-GCM
  export function openSecret(sealed: string): string | null;     // null when tampered or malformed
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const RFC = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of ASCII "12345678901234567890"
it('matches the RFC 6238 SHA-1 vectors', () => {
  expect([59, 1111111109, 1111111111, 1234567890, 2000000000].map((s) => totpAt(RFC, Math.floor(s / 30), 8)))
    .toEqual(['94287082', '07081804', '14050471', '89005924', '69279037']);
});
it('accepts one step either side and never the same step twice', () => {
  const now = new Date(1234567890_000); const step = totpStep(now);
  expect(matchTotp(RFC, totpAt(RFC, step - 1), now, null)).toBe(step - 1);
  expect(matchTotp(RFC, totpAt(RFC, step - 2), now, null)).toBeNull();
  expect(matchTotp(RFC, totpAt(RFC, step), now, step)).toBeNull();
});
it('seals and opens a secret, and refuses a tampered one', () => { /* round trip; flip one char → null */ });
it('requires MFA_SECRET_KEY in production', () => {
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('MFA_SECRET_KEY', '');
  expect(() => sealSecret('x')).toThrow(/MFA_SECRET_KEY/);
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `node:crypto` (`createHmac('sha1')`, `createCipheriv('aes-256-gcm')`) and a 20-line RFC 4648 base32. Key: `Buffer.from(process.env.MFA_SECRET_KEY, 'base64')`, which must be 32 bytes. Outside production a missing key falls back to `sha256('multishop-pos-dev-mfa-key')` (comment `shortcut: dev-only key, set MFA_SECRET_KEY before launch`).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(auth): add TOTP codes and sealed secret storage`.

### Task 4: MFA enrolment and the sign-in challenge

**Files:**
- Create: `src/server/mfa.ts`
- Modify: `src/server/context.ts` (`Ctx.sessionId`, `Ctx.sessionKind`), `src/server/auth.ts` (`signIn` returns a challenge when MFA is on), `src/server/platform-admin.ts` (`resetOwnerMfa`), `src/server/home.ts` (`SECURITY_ACTIONS` += `mfa_enabled`, `mfa_disabled`, `mfa_reset`)
- Test: `tests/server/mfa.test.ts`

**Interfaces:**
- Consumes: Task 3 functions; `createSession`, `tooManyAttempts`, `countFailedAttempt`, `clearAttempts`, `writeAudit`, `tokenHash`, `newToken`.
- Produces:
  ```ts
  // context.ts: Ctx gains   sessionId: string; sessionKind: 'password' | 'pin';
  // auth.ts
  export type SignInResult =
    | { ok: true; mfaRequired: false; token: string; expiresAt: Date }
    | { ok: true; mfaRequired: true; challengeToken: string; expiresAt: Date }
    | { ok: false; error: SignInError };
  // mfa.ts
  export const RECOVERY_CODE_COUNT = 10; export const MFA_CHALLENGE_MINUTES = 5; export const MFA_MAX_ATTEMPTS = 5;
  export type MfaError = 'password_session_required' | 'already_enabled' | 'not_enabled' | 'not_started' | 'wrong_code';
  export async function getMfaStatus(db: Db, ctx: Ctx): Promise<{ enabled: boolean; pending: { secret: string; otpauthUri: string } | null; recoveryCodesLeft: number }>;
  export async function startMfaEnrolment(db: Db, ctx: Ctx): Promise<{ ok: true } | { ok: false; error: MfaError }>;
  export async function confirmMfaEnrolment(db: Db, ctx: Ctx, code: string, now: Date): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; error: MfaError }>;
  export async function regenerateRecoveryCodes(db: Db, ctx: Ctx, code: string, now: Date): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; error: MfaError }>;
  export async function disableMfa(db: Db, ctx: Ctx, code: string, now: Date): Promise<{ ok: true } | { ok: false; error: MfaError }>;
  export async function createMfaChallenge(tx: Tx, tenantId: string, userId: string, now: Date): Promise<{ challengeToken: string; expiresAt: Date }>;
  export async function verifyMfaSignIn(db: Db, input: { slug: string; challengeToken: string; code: string; ip: string }, now: Date):
    Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; error: 'expired' | 'wrong_code' | 'try_again_later' }>;
  // platform-admin.ts
  export async function resetOwnerMfa(db: Db, adminToken: string | undefined, tenantId: string, now: Date): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests** (seed owner with a password and PIN `4321`; `code = (secret, at) => totpAt(secret, totpStep(at))`)

```ts
it('enrols with a correct code, issues 10 recovery codes, and ends other sessions', async () => { /* other session token → validateSession null; current ctx session still valid */ });
it('refuses enrolment from a PIN session', async () => { /* ctx from a pin session → { ok: false, error: 'password_session_required' } */ });
it('keeps MFA off after a wrong confirmation code', async () => {});
it('asks for a code at sign-in and creates no session until it is given', async () => {
  const r = await signIn(db, { slug, identifier, password, ip }, t0);
  expect(r).toMatchObject({ ok: true, mfaRequired: true });
  /* sessions table has no row for owner; verifyMfaSignIn with the code → ok, session valid with kind 'password' */
});
it('refuses the same TOTP code twice', async () => {});
it('accepts each recovery code once, in any case and with or without the dash', async () => {});
it('ends the challenge after 5 wrong codes and after 5 minutes', async () => { /* → 'expired' */ });
it('refuses a challenge used at another shop address', async () => { /* slug 'shop-b' → 'expired' */ });
it('never lets a PIN bypass MFA', async () => {
  /* owner with MFA switches in by PIN → session permissions equal TILL_PERMISSIONS; getMfaStatus/disableMfa → password_session_required */
});
it('disables MFA with a valid code, and the platform admin can reset it', async () => {});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
  - `signIn` checks `user.mfaEnabledAt` after `clearAttempts`. With MFA it calls `createMfaChallenge` in the same `asPlatform` transaction and writes no `signed_in` audit yet.
  - `verifyMfaSignIn` runs in one `asPlatform` transaction:
    1. Lock the challenge row. Expired, or the shop slug is not the challenge's tenant → delete it and return `expired`.
    2. Rate key `mfa:<userId>`.
    3. Six digits → `matchTotp` with `mfaLastStep`, then save the matched step. Otherwise the input is a recovery code: uppercase it, strip spaces and `-`, compare the sha256 with an unused row, and mark it used.
    4. Wrong code: `attempts + 1`, `countFailedAttempt`, audit `mfa_failed`. At `MFA_MAX_ATTEMPTS`, delete the challenge.
    5. Success: delete the challenge, `clearAttempts`, audit `signed_in` with `{ mfa: true }`. Create the session after the commit.
  - Recovery codes are 10 base32 characters shown as `XXXXX-XXXXX`.
  - Enable: deletes every session of the user except `ctx.sessionId`.
  - Audits: `mfa_enabled`, `mfa_disabled`, `mfa_recovery_codes_regenerated`, `mfa_reset` (actor `platform`).
- [ ] **Step 4:** `npx vitest run tests/server` → PASS (auth, home, onboarding, and subscription tests still pass because they use `toMatchObject({ ok: true })`).
- [ ] **Step 5:** Commit `feat(auth): add TOTP two-step sign-in with recovery codes`.

### Task 5: MFA pages

**Files:**
- Modify: `src/lib/cookies.ts` (`MFA_COOKIE = 'pos_mfa'`), `src/app/[slug]/login/actions.ts`, `src/app/[slug]/app/page.tsx` (link "Two-step sign-in" for password sessions), `src/app/admin/(signed-in)/shops/[id]/page.tsx` and `actions.ts` (button "Reset owner two-step sign-in")
- Create: `src/app/[slug]/login/mfa/page.tsx`, `src/app/[slug]/login/mfa/actions.ts`, `src/app/[slug]/app/security/page.tsx`, `src/app/[slug]/app/security/actions.ts`
- Dependency: `qrcode@1.5.4`, `@types/qrcode@1.5.6` (dev)

**Interfaces:**
- Consumes: Task 4.

- [ ] **Step 1:** Change the login action. On `mfaRequired`, set `MFA_COOKIE` (httpOnly, expires at `expiresAt`) and redirect to `/${slug}/login/mfa`. The MFA page has one field, "Code from your authenticator app, or a recovery code". It calls `verifyMfaSignIn`, sets the session cookie, deletes `MFA_COOKIE`, and redirects to `/${slug}/app`. Errors: `expired` → "Sign in again.", `wrong_code` → "Wrong code.", `try_again_later` → "Too many attempts. Try again in 15 minutes."
- [ ] **Step 2:** Build the security page with `pageCtx(slug, null)`. A PIN session is redirected to `/${slug}/app`.
  - Off: a "Set up two-step sign-in" button that calls `startMfaEnrolment`.
  - Pending: a QR from `QRCode.toString(uri, { type: 'svg' })`, the secret in groups of 4, and a confirm form. On success it shows "Two-step sign-in is on. Save these recovery codes now; each works once." with the codes in a `CopyBox`.
  - On: the count of recovery codes left, plus "New recovery codes" and "Turn off" forms that each need a code.
- [ ] **Step 3:** `npm run build` → compiles. In the browser on port 3004, check: enrol, sign out, sign in, the code page appears, and the code signs in.
- [ ] **Step 4:** Commit `feat(auth): add two-step sign-in pages and admin reset`.

### Task 6: Device cache, held sales, deregistration, and the offline setting (server)

**Files:**
- Create: `src/lib/device-contract.ts`, `src/server/device-cache.ts`, `src/server/held-sales.ts`
- Modify: `src/server/devices.ts` (`deregisterDevice`), `src/server/shop-settings.ts` (`getOfflineEnabled`, `setOfflineEnabled`)
- Test: `tests/server/device-cache.test.ts`, `tests/server/held-sales.test.ts`

**Interfaces:**
- Produces (`src/lib/device-contract.ts`, no runtime imports):
  ```ts
  export type TenderMethod = 'cash' | 'momo_manual' | 'card_terminal' | 'bank_transfer' | 'store_credit';
  export type SaleRequest = { saleId: string; receiptNumber: string;
    lines: Array<{ variantId: string; unitId: string; quantity: string; unitPricePesewas: number; discountPesewas: number; serials?: string[] }>;
    tenders: Array<{ id: string; method: TenderMethod; amountPesewas: number; reference?: string }>;
    customerId?: string; cashierId?: string; deviceCreatedAt: string; fromOfflineOutbox?: boolean };
  export type SaleResponse = { ok: true; saleId: string; status: 'completed' | 'pending'; changeDuePesewas: number; alreadyExisted: boolean } | { ok: false; error: string };
  export type CachedStaff = { id: string; name: string; permissions: Permission[]; pinHash: string | null; pinLockedUntil: string | null };
  export type DeviceCache = {
    version: number; generatedAt: string;
    shop: { name: string; timezone: string; taxMode: 'inclusive' | 'exclusive'; taxEnabled: boolean; scaleLayout: ScaleLayout | null; offlineEnabled: boolean; canSell: boolean };
    register: { id: string; name: string; registerCode: string; branchId: string; branchCode: string; branchName: string };
    staff: CachedStaff[];
    taxRules: Array<{ id: string; isDefault: boolean; rateBp: number }>;   // rateBp = effectiveRateBp(rule)
    priceRules: PriceRule[];
    products: Array<{ id: string; name: string; genericName: string | null; taxRuleId: string | null; tracking: Tracking; status: CatalogueStatus; imageId: string | null }>;
    variants: Array<{ id: string; productId: string; name: string; sku: string | null; allowsFractions: boolean; basePricePesewas: number; scaleItemCode: number | null; sellable: boolean; status: CatalogueStatus }>;
    units: Array<{ id: string; variantId: string; name: string; factor: string; pricePesewas: number | null; sellable: boolean; isBase: boolean }>;
    barcodes: Array<{ code: string; variantId: string; unitId: string }>;
    resolvedHeldSaleIds: string[];
  };
  export type HeldSaleReport = { saleId: string; receiptNumber: string; cashierId: string | null; totalPesewas: number; error: string; sale: SaleRequest; deviceCreatedAt: string; status: 'held' | 'synced' };
  ```
- Produces (server):
  ```ts
  type DeviceInput = { deviceToken: string | undefined; slug: string };
  export async function getDeviceCache(db: Db, input: DeviceInput, now: Date): Promise<DeviceCache | null>;   // null: not a registered device of this shop
  export async function getDeviceCacheVersion(db: Db, input: DeviceInput): Promise<number | null>;
  export async function readDeviceImage(db: Db, store: ImageStore, input: DeviceInput & { imageId: string }): Promise<Uint8Array | null>;
  export async function reportHeldSale(db: Db, input: DeviceInput & { report: unknown }, now: Date): Promise<{ ok: true } | { ok: false; error: 'device_not_registered' | 'invalid_input' }>;
  export type HeldSaleView = { id: string; registerName: string; receiptNumber: string; cashierName: string | null; totalPesewas: number; error: string; deviceCreatedAt: Date; reportedAt: Date };
  export async function listHeldSales(db: Db, ctx: Ctx): Promise<HeldSaleView[]>;                                 // view_dashboard; unresolved only
  export async function resolveHeldSale(db: Db, ctx: Ctx, heldSaleId: string, note: string, now: Date): Promise<{ ok: true } | { ok: false; error: 'not_found' }>; // approve_actions
  export async function deregisterDevice(db: Db, ctx: Ctx, registerId: string): Promise<{ ok: true } | { ok: false; error: 'unknown_register' }>; // manage_devices
  export async function getOfflineEnabled(db: Db, ctx: Ctx): Promise<boolean>;
  export async function setOfflineEnabled(db: Db, ctx: Ctx, enabled: boolean): Promise<{ ok: true }>;           // manage_shop_settings
  ```

- [ ] **Step 1: Write the failing tests** (shop with owner, cashier `kofi` PIN `5678` on Main, cashier `esi` on no branch, inactive `yaw`; one product with a barcode and a photo row)

```ts
it('gives a registered device its catalogue, settings, and branch staff with PIN hashes', async () => {
  const c = await getDeviceCache(db, { deviceToken, slug: 'shop-a' }, t0);
  expect(c!.register).toMatchObject({ registerCode: 'T1', branchCode: 'B1' });
  expect(c!.staff.map((s) => s.name)).toEqual(['kofi']);
  expect(c!.staff[0].pinHash).toMatch(/^\$argon2id\$/);
  expect(c!.staff[0].permissions).toEqual(['make_sale']);
  expect(c!.barcodes).toHaveLength(1);
});
it('limits an owner to till permissions in the cache', async () => {});
it('sends no PIN hashes when the shop switched offline off', async () => {});
it('refuses unknown tokens, another shop slug, and removed devices', async () => { /* → null; deregisterDevice also deletes PIN sessions with that registerId */ });
it('reports canSell false when the subscription is read-only', async () => {});
it('records a held sale once, lists it for managers, and resolves it', async () => {
  /* reportHeldSale twice with the same saleId → 1 row; listHeldSales(owner) → 1; resolveHeldSale → listHeldSales empty;
     getDeviceCache().resolvedHeldSaleIds contains saleId; cashier ctx → expectAccess(listHeldSales, 'forbidden') */
});
it('marks a held sale synced when the device later sends it', async () => { /* report status 'synced' → resolution 'synced', gone from list */ });
it('refuses malformed held sale reports', async () => { /* bad uuid, negative total → invalid_input */ });
it('serves a photo only to a device of the same shop', async () => {});
it('switches offline mode only with manage_shop_settings', async () => {});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
  - `getDeviceCache`: `findDeviceRegister`, then check `device.slug === input.slug`, then one `withTenant` transaction.
  - Staff filter: the same as `listTillStaff`. Permissions are intersected with `TILL_PERMISSIONS`. `pinHash` is null when offline is off.
  - `canSell = subscriptionState(...) !== 'read_only'`. `imageId` = the `sortOrder 0` photo.
  - `resolvedHeldSaleIds`: this register's resolved rows, newest 200.
  - `reportHeldSale`: validates with zod. The sale is capped at 200 lines and the error at 100 characters. It upserts on `(tenant_id, sale_id)` and never reopens a resolved row.
  - `deregisterDevice` sets `deviceTokenHash` and `deviceRegisteredAt` to null, deletes sessions with that `registerId`, and audits `device_deregistered` (add it to `SECURITY_ACTIONS`).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(offline): serve the device cache and record held sales`.

### Task 7: Device routes and manager screens

**Files:**
- Create: `src/app/api/[slug]/device/cache/route.ts`, `.../device/cache/version/route.ts`, `.../device/images/[imageId]/route.ts`, `.../device/pin/route.ts`, `.../device/held-sales/route.ts`
- Modify: `src/app/[slug]/app/devices/page.tsx` + `actions.ts` ("Remove device"), `src/app/[slug]/app/settings/page.tsx` + `actions.ts` ("Allow selling offline" checkbox), `src/app/[slug]/app/page.tsx` ("Sales waiting for review" section and a "Selling screen" link to `/${slug}/till/sell`)

**Interfaces:**
- Consumes: Task 6; `switchCashierWithPin`.
- Produces HTTP (all read the `pos_device` cookie, all send `Cache-Control: no-store` except images):
  - `GET /api/[slug]/device/cache` → 200 `DeviceCache` | 401 `{ error: 'device_not_registered' }`
  - `GET /api/[slug]/device/cache/version` → 200 `{ version: number }` | 401
  - `GET /api/[slug]/device/images/[imageId]` → 200 `image/webp` (`private, max-age=31536000, immutable`) | 404
  - `POST /api/[slug]/device/pin` `{ staffId, pin }` → 200 `{ ok: true, staffId }` (sets `SESSION_COOKIE`) | 200 `{ ok: false, error: PinError }` | 400 bad JSON
  - `POST /api/[slug]/device/held-sales` `HeldSaleReport` → 200 `{ ok: true }` | 401 | 400

- [ ] **Step 1:** Write the routes as thin wrappers around Task 6. The pin route also refuses a device whose `slug` differs from the URL (`device_not_registered`).
- [ ] **Step 2:** Manager screens.
  - Devices page: a "Remove device" form per till with a device. Message: "Device removed. Its saved PINs are wiped when it next connects."
  - Settings: an offline checkbox, saved by its own form.
  - Home: held sales (receipt, till, cashier, amount, error, time) with a note field and a "Mark resolved" button for `approve_actions`.
- [ ] **Step 3:** `npm run build` → compiles. In the browser: register the device, `fetch('/api/shop/device/cache')` in the console returns the cache, remove the device, and the same fetch returns 401.
- [ ] **Step 4:** Commit `feat(offline): add device routes, device removal, offline switch, and review list`.

### Task 8: Device storage and till logic (browser)

**Files:**
- Create: `src/device/store.ts`, `src/device/catalogue.ts`, `src/device/sale.ts`, `src/device/pin.ts`
- Dependencies: `idb@8.0.4`, `hash-wasm@4.12.0`, `fake-indexeddb@6.2.6` (dev)
- Test: `tests/device/store.test.ts`, `tests/device/catalogue.test.ts`, `tests/device/sale.test.ts`, `tests/device/pin.test.ts` (each starts with `import 'fake-indexeddb/auto';` where it uses the store)

**Interfaces:**
- Consumes: `DeviceCache`, `SaleRequest`, `CachedStaff` (Task 6); `calculateCartTotals` (Task 1); `choosePriceList`, `resolvePrice`; `readScaleLabel`, `normaliseBarcode`; `chooseTaxRule`; `validSaleQuantity`, `fromMilli`, `ratioToQty`.
- Produces:
  ```ts
  // store.ts — IndexedDB 'pos-device-<slug>' with stores kv, outbox (keyPath saleId, index seq), pinLocks (keyPath staffId)
  export type OutboxEntry = { saleId: string; seq: number; request: SaleRequest; totalPesewas: number; status: 'queued' | 'needs_review';
    attempts: number; nextAttemptAt: number; lastError: string | null; reported: boolean };
  export type DeviceMeta = { lastSyncAt: number | null; counter: number; cacheVersion: number; deregistered: boolean };
  export type DeviceStore = {
    getCache(): Promise<DeviceCache | null>; setCache(cache: DeviceCache): Promise<void>; wipeCache(): Promise<void>; // cache + pinLocks
    getMeta(): Promise<DeviceMeta>; patchMeta(patch: Partial<DeviceMeta>): Promise<DeviceMeta>;
    takeReceiptCounter(): Promise<number>;                       // counter + 1, saved in the same transaction
    raiseCounter(atLeast: number): Promise<void>;
    addSale(entry: OutboxEntry): Promise<void>;
    listOutbox(): Promise<OutboxEntry[]>;                         // ascending seq
    putOutbox(entry: OutboxEntry): Promise<void>; deleteOutbox(saleId: string): Promise<void>;
    getPinLock(staffId: string): Promise<{ failures: number; lockedUntil: number | null }>;
    setPinLock(staffId: string, lock: { failures: number; lockedUntil: number | null }): Promise<void>;
  };
  export function openDeviceStore(slug: string): DeviceStore;
  // catalogue.ts
  export type Found = { variantId: string; unitId: string; quantity: string; labelPricePesewas: number | null };
  export function findByCode(cache: DeviceCache, code: string): Found | null;      // same rules as server parseScannedCode
  export type SearchHit = { variantId: string; unitId: string; label: string; unitName: string; pricePesewas: number; imageId: string | null };
  export function searchCatalogue(cache: DeviceCache, text: string, today: string): SearchHit[];  // name, generic name, or SKU; active and sellable only; max 20
  export type CartLine = { lineId: string; variantId: string; unitId: string; quantity: string; labelPricePesewas: number | null };
  export type PricedLine = CartLine & { label: string; unitName: string; unitPricePesewas: number; taxRateBp: number };
  export function canAdd(cache: DeviceCache, found: Found): 'unavailable' | 'serial_item' | 'invalid_quantity' | null;
  export function priceCart(cache: DeviceCache, lines: CartLine[], today: string): { lines: PricedLine[]; totals: CartTotals };
  // sale.ts
  export const OFFLINE_LIMIT_MS = 72 * 3_600_000;
  export type TenderInput = { method: 'cash' | 'momo_manual' | 'card_terminal' | 'bank_transfer'; amountPesewas: number; reference: string };
  export function offlineBlock(cache: DeviceCache | null, meta: DeviceMeta, now: number): string | null;
  export function checkTenders(tenders: TenderInput[], totalPesewas: number): { ok: true; changeDuePesewas: number } | { ok: false; error: string };
  export function formatReceiptNumber(branchCode: string, registerCode: string, counter: number): string;
  export function buildSaleRequest(i: { saleId: string; receiptNumber: string; cashierId: string; lines: PricedLine[];
    tenders: TenderInput[]; tenderIds: string[]; now: Date; fromOfflineOutbox: boolean }): SaleRequest;
  // pin.ts
  export const PIN_MAX_FAILURES = 5; export const PIN_LOCK_MS = 15 * 60_000;  // same values as src/server/devices.ts
  export type ActiveCashier = { staffId: string; name: string; serverSession: boolean };
  export async function verifyPinOffline(store: DeviceStore, cache: DeviceCache, staffId: string, pin: string, now: number):
    Promise<{ ok: true; cashier: ActiveCashier } | { ok: false; error: 'not_assigned' | 'pin_locked' | 'wrong_pin' | 'offline_off' }>;
  export async function switchCashier(deps: { store: DeviceStore; fetch: typeof fetch; slug: string; now: () => number }, staffId: string, pin: string):
    Promise<{ ok: true; cashier: ActiveCashier } | { ok: false; error: string }>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// store
it('hands out receipt counters in order and never lowers them', async () => { /* take → 1, 2; raiseCounter(50); take → 51; raiseCounter(10); take → 52 */ });
it('lists the outbox oldest first', async () => {});
it('wipes the cache and PIN locks but keeps the outbox and counter', async () => {});
// catalogue (cache fixture built in the test: one piece item 'Milo 400g' barcode 6001234567890 price 2500, one kg item scale code 123, an archived item, a serial item)
it('finds a barcode, a 12-digit UPC, and a weight scale label', () => { /* '212345001250X' with valid check digit → quantity '1.250' */ });
it('rejects a scale label with a wrong check digit', () => {});
it('prices with the branch price list and the product tax rule', () => {});
it('refuses archived, serial, and fractional-in-whole-unit items', () => {});
// sale
it('blocks offline selling when switched off, read-only, never synced, or last synced over 72 hours ago', () => {
  expect(offlineBlock(cache, { ...meta, lastSyncAt: now - OFFLINE_LIMIT_MS }, now)).toBeNull();
  expect(offlineBlock(cache, { ...meta, lastSyncAt: now - OFFLINE_LIMIT_MS - 1 }, now)).toBe('Connect to the internet to continue');
});
it('only cash gives change, and manual payments need a reference', () => {
  expect(checkTenders([{ method: 'cash', amountPesewas: 2000, reference: '' }], 1725)).toEqual({ ok: true, changeDuePesewas: 275 });
  expect(checkTenders([{ method: 'momo_manual', amountPesewas: 2000, reference: 'MP123' }], 1725).ok).toBe(false);
  expect(checkTenders([{ method: 'momo_manual', amountPesewas: 1725, reference: ' ' }], 1725).ok).toBe(false);
});
it('formats receipt numbers', () => { expect(formatReceiptNumber('ACC1', 'T2', 123)).toBe('ACC1-T2-000123'); });
// pin (hash made with @node-rs/argon2 via hashSecret, so the browser library is checked against real server hashes)
it('verifies a cached argon2id PIN hash', async () => {});
it('locks a PIN on the device after 5 wrong tries for 15 minutes, and honours a server lock', async () => {});
it('uses the cached hash only when the server cannot be reached', async () => {
  /* fetch returns { ok:false, error:'pin_locked' } → error, no offline check;
     fetch rejects (TypeError) → offline check passes with the right PIN, serverSession false;
     fetch returns { ok:true } → serverSession true */
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. `verifyPinOffline` uses `argon2Verify({ password: pin, hash })` from `hash-wasm`. `switchCashier` posts to `/api/${slug}/device/pin` and falls back to `verifyPinOffline` only when `fetch` rejects. Messages: `not_assigned` → "You are not set up to sell on this till.", `pin_locked` → "PIN locked for 15 minutes.", `wrong_pin` → "Wrong PIN.", `offline_off` → "Connect to the internet to continue".
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(offline): add the device store, offline catalogue, and offline PIN check`.

### Task 9: Outbox sync and cache refresh

**Files:**
- Create: `src/device/sync.ts`, `src/device/refresh.ts`
- Test: `tests/device/sync.test.ts`, `tests/device/refresh.test.ts` (a fake `fetch` implements the Plan 3 contract and the device routes; no invented server code)

**Interfaces:**
- Consumes: Task 8 store; contract types.
- Produces:
  ```ts
  // sync.ts
  export type Outcome = 'ok' | 'review' | 'auth' | 'retry';
  export function classifySaleResponse(status: number, body: unknown): { outcome: Outcome; error: string | null };
  export function backoffMs(attempts: number): number;          // min(15 min, 5 s × 2^(attempts − 1))
  export type SyncDeps = { store: DeviceStore; fetch: typeof fetch; slug: string; now: () => number };
  export type SyncResult = { sent: number; held: number; waiting: number; needsPin: boolean; reachable: boolean };
  export async function syncOutbox(deps: SyncDeps): Promise<SyncResult>;   // one run at a time per store
  export async function sendSaleNow(deps: SyncDeps, saleId: string):
    Promise<{ result: 'sent'; response: Extract<SaleResponse, { ok: true }> } | { result: 'queued'; needsPin: boolean } | { result: 'rejected'; error: string }>;
  export async function retryHeld(store: DeviceStore, saleId: string): Promise<void>;
  // refresh.ts
  export const REFRESH_EVERY_MS = 15 * 60_000;
  export async function refreshCache(deps: SyncDeps & { force?: boolean }): Promise<'updated' | 'unchanged' | 'deregistered' | 'offline'>;
  ```

`syncOutbox` algorithm (one run per store at a time; a second call while one runs returns the same promise):

```text
for entry in listOutbox() where status == 'queued' and nextAttemptAt <= now, by seq:
    POST /api/<slug>/sales  body = { ...entry.request, fromOfflineOutbox: true }
    outcome ok     → deleteOutbox; if entry was reported earlier → POST held-sales status 'synced'
    outcome review → status 'needs_review', lastError = error; report it (POST held-sales 'held'; reported = true on 200);
                     error 'duplicate_receipt_number' → also GET counter and raiseCounter
    outcome auth   → needsPin = true; stop
    outcome retry  → attempts + 1, nextAttemptAt = now + backoffMs(attempts); reachable = false if fetch rejected; stop
then report any needs_review entry with reported == false
```

`sendSaleNow` is the first, online attempt. It posts `fromOfflineOutbox: false`.
- ok → delete the entry.
- review → delete the entry and return `rejected` (the cashier is still there to fix the cart).
- auth → keep the entry with `fromOfflineOutbox: true`, `needsPin`.
- retry → keep the entry with `fromOfflineOutbox: true`, attempts 1.

`refreshCache` steps:
1. Within 15 minutes of `lastSyncAt` and not `force`: GET the version.
   - Same version → `lastSyncAt = now`, return `unchanged`.
   - 401 → wipe.
   - Different version → full fetch.
2. Full fetch: GET the cache.
   - 401: `wipeCache()`, `deregistered = true`, return `deregistered`.
   - 200: `setCache`, `lastSyncAt = now`, `cacheVersion`, `deregistered = false`. Delete `needs_review` entries whose `saleId` is in `resolvedHeldSaleIds`. Then GET `/api/<slug>/register/counter` and `raiseCounter(lastCounter)`, ignoring failures. Return `updated`.
3. A rejected `fetch` returns `offline`.

- [ ] **Step 1: Write the failing tests**

```ts
it('sends queued sales oldest first and empties the outbox', async () => {});
it('removes a sale the server already has', async () => { /* server answers alreadyExisted: true → outbox empty, sent 1 */ });
it('holds a refused sale for review and keeps syncing the rest', async () => {
  /* sale 1 → 409 cashier_not_allowed, sale 2 → 200: entry 1 needs_review + held-sales POST seen, entry 2 gone */
});
it('keeps everything and backs off when the server is unreachable, down, or missing the route', async () => {
  /* fetch rejects → reachable false; 503 and 404 → attempts 1, nextAttemptAt = now + 5000, second sale untouched */
});
it('stops and asks for a PIN on 401 or 403', async () => {});
it('sends each sale once when two syncs run at the same time', async () => {});
it('first online attempt: rejected sales leave the outbox, unreachable ones stay as outbox sales', async () => {});
it('restores the receipt counter to the larger of local and server', async () => {});
it('wipes PINs but keeps the outbox when the device was removed', async () => {});
it('checks only the version within 15 minutes and refetches when it changed', async () => {});
it('drops held sales a manager resolved', async () => {});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement as above.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(offline): sync the sale outbox and refresh the device cache`.

### Task 10: Installable app shell (service worker and manifest)

**Files:**
- Create: `public/sw.js`, `public/icons/icon-192.png`, `public/icons/icon-512.png` (blue square with "POS", made once with `sharp`), `src/app/[slug]/till/manifest.webmanifest/route.ts`

**Interfaces:**
- Produces: the service worker, registered by the sell screen (Task 11) with `navigator.serviceWorker.register('/sw.js', { scope: '/<slug>/till/' })`. The manifest has `start_url: '/<slug>/till/sell'`, `scope: '/<slug>/till/'`, `display: 'standalone'`, `name: 'Till – <slug>'`, `theme_color: '#1e40af'`, and both icons.

`sw.js` routing (GET, same origin only):

```text
install  → skipWaiting();  activate → delete caches other than pos-shell-v1, pos-static-v1, pos-images; clients.claim()
/_next/static/*                    → cache first (pos-static-v1), store 200 responses
/api/*/device/images/*             → cache first (pos-images)
/api/*                             → network only (no respondWith)
navigate to */till/sell            → network first; store 200 responses in pos-shell-v1; on failure serve the cached page,
                                     else a plain 503 page "Offline. Open the till once while online first."
```

- [ ] **Step 1:** Write the files. The manifest route returns `application/manifest+json`.
- [ ] **Step 2:** Verified in the browser in Task 12. There is no Vitest test, because the worker is plain JS outside the TypeScript build.
- [ ] **Step 3:** Commit `feat(offline): add the till service worker and web app manifest`.

### Task 11: The selling screen

**Files:**
- Create: `src/app/[slug]/till/sell/page.tsx` (server: `generateMetadata` with the manifest link; renders `<SellScreen slug={slug} />`; reads no cookies), `src/app/[slug]/till/sell/sell-screen.tsx`, `src/app/[slug]/till/sell/use-device.ts`, `src/app/[slug]/till/sell/receipt.tsx`

**Interfaces:**
- Consumes: Tasks 8–10.
- Produces: `useDevice(slug)` → `{ cache, meta, outbox, reachable, needsPin, cashier, switchCashier, signOutCashier, completeSale, retryHeld }`.
  - Timers: `refreshCache` on mount and every 60 s (forced every 15 min); `syncOutbox` after each refresh, after each sale, on `online`, and every 60 s while the outbox is not empty. Both run inside `navigator.locks.request('pos-sync-<slug>')` when available.
  - After an `updated` refresh, `caches.open('pos-images')` adds each main photo URL that is not cached yet.
  - The active cashier is kept in `sessionStorage`.

`completeSale(lines, tenders)`:
1. Require a cashier with `make_sale` and `cache.shop.canSell`.
2. When `reachable` is false, apply `offlineBlock`.
3. Check `checkTenders`.
4. `counter = takeReceiptCounter()`, `saleId = crypto.randomUUID()`, one UUID per tender.
5. `fromOfflineOutbox = !(reachable && cashier.serverSession)`.
6. `addSale` with status `queued`.
7. Online path: call `sendSaleNow`. `sent` → paid receipt with the server's change. `queued` → offline receipt. `rejected` → show the error and keep the cart. Offline path → offline receipt.

Screen states:
- No cache and unreachable → "Connect to the internet to set up this till."
- `deregistered` → "This device was removed from the till. Its saved PINs were wiped. Ask a manager to register it again." plus the count of waiting sales.
- No cashier → staff buttons and a PIN field.
- Selling:
  - Status bar: register, cashier, Online or Offline, "N waiting", "N need review", last sync time, "Switch cashier".
  - Scan/search box (Enter = `findByCode`, typing = `searchCatalogue`).
  - Cart lines with quantity, unit, price, and total; remove.
  - Totals (subtotal, tax, total).
  - Payment rows (method, amount, reference); Complete sale.
- Receipt: shop, register, receipt number, time, cashier, lines, subtotal, tax, total, payments, change. It shows `Offline – pending sync` when the sale is still in the outbox. Print and New sale buttons.
- Review list: receipt, amount, error, "Try again" (`retryHeld`).
- `needsPin` → "Enter your PIN to send waiting sales."

- [ ] **Step 1:** Write the components with Tailwind like the existing pages (mobile-first, `max-w-3xl`).
- [ ] **Step 2:** `npx tsc --noEmit` and `npm run build` → no errors.
- [ ] **Step 3:** Commit `feat(offline): add the local-first selling screen`.

### Task 12: Verify, hand over

- [ ] **Step 1:** `npx vitest run` → all pass. `npm run build` → success.
- [ ] **Step 2:** Browser check on port 3004 (`multishop-pos-offline-dev`).
  1. Seed a shop: run the admin onboarding flow, or use a script with `seedShop` against `.data/pglite`.
  2. Register this device and add a product with a barcode.
  3. Open `/<slug>/till/sell` and switch in by PIN online. Reload once so the service worker controls the page.
  4. Stop the dev server (`preview_stop`), so the network is unreachable. Reload: the page loads from the service worker.
  5. Switch in by PIN with the cached hash, scan the product, pay cash, complete the sale. The receipt shows `Offline – pending sync` and the status bar shows "1 waiting".
  6. Start the server again. Sync runs, and the sale stays queued with a backoff because `/api/<slug>/sales` returns 404 until Plan 3 merges.
- [ ] **Step 3:** Write `plan-4-offline-decisions.md` in the notes folder (routes, contract use, migration-merge rule, what Plan 3's online page must not duplicate).
- [ ] **Step 4:** Final review on the most capable model; fix Critical and Important findings; commit.
