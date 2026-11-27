# Launch checklist

Work through this in order before the first paying shop goes live. The production server refuses to start while a required setting is missing; its log names the setting but never shows its value.

## 1. Database (Neon Postgres)

- [ ] Create a Neon project in a region close to Ghana (for example Frankfurt). Turn on point-in-time recovery (keep at least 7 days of history).
- [ ] Copy the **pooled** connection string into `DATABASE_URL`. The app turns off prepared statements for pooling.
- [ ] Run the migrations once from a trusted machine: `npm run db:migrate`. Migration 0000 creates the `pos_app` role that row-level security uses, so the connecting user needs permission to create roles (the Neon owner has it).
- [ ] Create the first platform admin: `npm run create-platform-admin`.
- [ ] Check `GET /api/health` returns `{"ok":true}`. It answers 503 if the database is down or a migration is missing.

## 2. Required settings (Vercel → Project → Settings → Environment Variables, Production)

| Setting | What |
|---|---|
| `DATABASE_URL` | Neon pooled connection string |
| `APP_URL` | The public `https://` address. Receipt links, Paystack returns and emails use it. |
| `MFA_SECRET_KEY` | 32 random bytes, base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Keep a copy in a password manager.** Without it, sealed secrets in backups (MFA, shop Paystack keys, webhook secrets, gift codes) cannot be opened. |
| `CRON_SECRET` | At least 32 random characters. Vercel Cron sends it automatically. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email (password resets, billing). Verify the sending domain in Resend. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Private Cloudflare R2 bucket for photos and transfer screenshots. The token needs Object Read & Write on that bucket only. |

Recommended (the server only warns when these are missing):

- `SMS_API_KEY` and `SMS_SENDER_ID` (Arkesel; register the sender ID first)
- `PAYSTACK_SECRET_KEY` (live key, for subscriptions)
- `REPORT_EMAIL`
- `ROOT_DOMAIN` (for shop subdomains)

## 3. Scheduled jobs

- [ ] `vercel.json` runs `/api/cron/notifications` every 15 minutes. This needs a Vercel Pro plan; Hobby allows only daily jobs. Without Pro, use an external scheduler that sends `Authorization: Bearer $CRON_SECRET`.
- [ ] The job sends SMS, renews subscriptions, lapses unpaid online orders, delivers webhooks, and (at 02:00 UTC) expires loyalty points. Its JSON answer shows what each part did.

## 4. Payments

- [ ] Platform Paystack account (subscriptions): set the webhook URL to `$APP_URL/api/paystack/webhook`. Use the live key.
- [ ] Each shop connects its own Paystack account under **Payments and integrations**, and sets its webhook to the address shown there.
- [ ] Do a live end-to-end run with a small amount: a subscription payment, a till Paystack charge, and an online order. Then refund them from the Paystack dashboard.

## 5. Domains (optional)

- [ ] Wildcard DNS `*.ROOT_DOMAIN` pointing at the app, added in Vercel as a wildcard domain.
- [ ] Custom shop domains: add each verified domain to the Vercel project (Vercel issues its certificate). On a self-hosted Caddy, use on-demand TLS with `ask https://<app>/api/domains/allowed`.

## 6. Backups and the restore drill

- [ ] Neon point-in-time recovery is on (step 1).
- [ ] Off-site copy, at least weekly: `npm run db:backup -- <folder>` writes `backup-<time>.json.gz`. Store it in encrypted storage that is not the database host. The file holds password hashes and sealed secrets; `/backups/` is git-ignored.
- [ ] Practise a restore **before launch**, and then every quarter:
  1. Create an empty Neon branch or database.
  2. Point `DATABASE_URL` at it.
  3. Run `npm run db:restore -- <file> --yes`. It migrates the empty database and restores in one transaction. It refuses any database that already holds shops.
  4. Sign in to a restored shop and check its last sales.
- [ ] Product photos live in R2, which is separate from the database backup. Turn on R2 object versioning or a bucket copy.

## 7. Monitoring

- [ ] An uptime monitor (for example UptimeRobot or Better Stack) on `GET /api/health`, alerting by SMS or email.
- [ ] Server errors are written to the log as one JSON line each (`"event":"request_error"`), without query strings or cookies. Set up a Vercel log drain or alert on that event.
- [ ] Watch for `"event":"env"` warnings after each deploy.

## 8. Security

- [ ] Security headers are sent on every page: HSTS, nosniff, frame denial, a referrer policy, a permissions policy (camera allowed for scanning), and a CSP for framing, forms and objects. A script CSP with nonces is not set yet.
- [ ] Turn on MFA for every platform admin and every shop owner.
- [ ] Rotate `CRON_SECRET` and the Paystack and R2 keys if anyone who had them leaves. Never rotate `MFA_SECRET_KEY` without re-sealing the data it protects.
- [ ] Check that `.env.local` and the backups are not in git: `git status` shows neither.

## 9. Devices and usability (manual)

- [ ] Run a sale on a phone (camera scanning), a tablet, a desktop with a USB scanner, and the receipt printer through the print helper.
- [ ] Take a till offline (airplane mode), make sales, reconnect, and check each sale synced once.
- [ ] Pair a customer display. Test the kitchen display and the Ready board.

## 10. Go live

- [ ] Run the tests, typecheck, lint and build on the release commit: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`.
- [ ] Deploy, then check `/api/health` and the env warnings, and complete one real sale.
