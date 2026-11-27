# Phase 8 hand-over: launch readiness

The spec ends at Phase 6. The owner chose Phase 8 as launch readiness. Production Postgres already worked through `DATABASE_URL` (postgres.js, Neon pooled connections), so this phase adds what running it safely needs.

## What was built

- **Start-up settings check** (`src/server/env.ts`, `src/instrumentation.ts`):
  - At start, `register()` checks `DATABASE_URL`, an https `APP_URL`, a 32-byte `MFA_SECRET_KEY`, a `CRON_SECRET` of at least 32 characters, `RESEND_API_KEY`, and the four R2 settings.
  - In production a missing one stops the server, with one JSON log line per problem. In development these are warnings.
  - Missing SMS, Paystack (or a test key in production) and report email only produce warnings.
  - Values are never logged.
- **Error logging:** `onRequestError` writes one JSON line per server error (`"event":"request_error"`): the digest, message, the first 8 stack lines, the method, the path without its query string, and the route. It never logs cookies or bodies.
- **Health check:** `GET /api/health` answers 200 with `{ok, database, migrations: {applied, expected}}` when the database is up and every migration in the build is applied; otherwise 503. It shows no shop data.
- **Security headers** (`next.config.ts`, on every response):
  - HSTS (2 years), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`;
  - `Permissions-Policy` (camera for scanning only);
  - a CSP covering `frame-ancestors`, `base-uri`, `object-src` and `form-action` (`self` plus `checkout.paystack.com`).
  - No `script-src` yet: Next's inline scripts would need per-page nonces.
- **Backup and restore** (`src/server/backup.ts`, `npm run db:backup` / `npm run db:restore -- <file> --yes`):
  - Backup: every public table as JSON in one read-only, repeatable-read snapshot, gzipped to `backups/` (git-ignored).
  - Restore: into an empty database migrated to the same version, in one transaction. Tables are restored in foreign-key order. Identity columns (`audit_log.id`) are restored with `overriding system value` and their sequences reset.
  - Restore refuses a database that already holds shops, or a file that is not a backup. It fails, saving nothing, if any table ends up short of its backup count.
- **Deploy config:** `vercel.json` runs the cron job every 15 minutes (Vercel sends `CRON_SECRET` by itself; this needs a Pro plan). The cron route allows 300 s.
- **`docs/launch-checklist.md`:** database, settings, jobs, payments, domains, backups and the restore drill, monitoring, security, device checks, and go-live.

## Verified

- `tests/server/backup.test.ts` (5 tests):
  - a seeded shop with stock, a sale and a sealed Paystack key is backed up, written out as JSON, and restored into a fresh database. **Every table matches row for row** (except `device_cache_versions`, which triggers rewrite);
  - the restored shop then makes a new sale, and its new audit rows get fresh ids;
  - restore refusals; health; the settings check in production and development; the error log line contains no query string or cookie.
- On the dev server:
  - `/api/health` first answered 503 (the local database was 4 migrations behind: 52 of 56). After `npm run db:migrate` it answered 200 with 56 of 56.
  - All six security headers were present.
  - The development settings warnings appeared as JSON lines.

## Notes

- The backup holds everything in memory, which is fine for the first shops. Move to `pg_dump` or per-table streaming once the database passes a few hundred MB.
- Product photos are in R2 and are not in the database backup. Turn on R2 versioning (see the checklist).
- Not done here: a nonce-based script CSP, an error-tracking service (the JSON log lines are ready for a log drain), and load testing.
