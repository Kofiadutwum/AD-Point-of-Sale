# Limitations and recommendations

State of `main` after Phase 8 and the final check (2026-11-27): typecheck clean, lint 0 errors and 0 warnings, all tests passing, production build clean, `npm audit` (runtime dependencies) 0 vulnerabilities.

## 1. Upload limits

| What | Limit | Where it is enforced |
|---|---|---|
| Any image upload, raw | 10 MB and 40 million pixels (stops "image bombs"). HEIC files sent raw are refused. | `src/server/images.ts` |
| Request body on Vercel | **4.5 MB per request** (set by the host, not the app) | Vercel |
| Product photo, stored | WebP, at most **30 KB** and 800 px (640 or 480 px if needed). EXIF, GPS and other metadata are removed. | `src/lib/images.ts`, `src/server/images.ts` |
| Photos per product | **5** | `src/server/product-images.ts` |
| Online-order transfer screenshot, stored | WebP, at most **200 KB** and 1600 px, so small reference numbers stay readable (changed in this check) | `PROOF_TARGET` |
| CSV import | **5 MB** and **2,000 rows** per file (split bigger files); product names up to 80 characters | `src/server/csv-import.ts` |
| Server action body | 10 MB (but Vercel's 4.5 MB applies first) | `next.config.ts` |

Both photo uploaders shrink the picture **on the phone** before sending, so a normal upload is a few hundred KB at most, well under the 4.5 MB host limit. On an iPhone, Safari turns a HEIC photo into WebP during that step, so iPhone photos work. Only a raw HEIC sent without the uploader is refused.

**Fixed in this check:** the online-order screenshot used to be sent raw (a large phone photo would fail on Vercel with "413 too large"), and was then squeezed to 30 KB, which could blur the reference number. It is now compressed on the phone to at most 200 KB and kept readable.

## 2. Plan allowances (seeded; change them in the `plans` table)

| Plan | Price | Branches | Tills | Staff | Products | SMS a month |
|---|---|---|---|---|---|---|
| Free trial (14 days) | free | 1 | 2 | 5 | 500 | 50 |
| Starter | GHS 150 a month, billed yearly | 1 | 2 | 10 | 2,000 | 200 |
| Standard | GHS 300 a month, billed yearly | 3 | 6 | 20 | 5,000 | 500 |
| Pro | GHS 600 a month, billed yearly | 5 | 15 | 50 | 20,000 | 1,500 |

## 3. Other limits built into the app

- **Offline selling:** a till can sell offline for up to **72 hours** after its last sync. After that it must reconnect.
- **Sign-in:** password sessions last 30 days and renew while in use. Till PIN sessions last **12 hours**. Sign-in attempts are limited to 10 per 15 minutes; PINs lock after 5 wrong tries; MFA allows 5 tries.
- **Lists:** the storefront shows at most **200 products** per page (customers can search and filter by category to find the rest). The online order page lists up to **300** items. The staff online-orders list shows 200 orders, and the dashboard shows 50 low-stock items.
- **Reports and exports:** CSV exports cover up to 366 days at a time; food and pharmacy reports up to 92 days; API sales queries up to 31 days.
- **Sizes of one record:** a sale up to 1,000 serials per line; a transfer or purchase order up to 100 lines; a layaway up to 50 lines; an online order up to 30 items (99 of each).
- **Online orders:** 3 SMS codes an hour per phone; 5 orders an hour per phone and 10 per IP address; unpaid orders lapse after the shop's set time (10 minutes to 7 days).
- **API and webhooks:** 600 API requests per key every 15 minutes; up to 10 keys per shop; up to 5 webhook addresses; a failed delivery is retried up to 8 times.
- **Custom domains:** 3 per shop.
- **Marketing SMS:** up to 300 characters; never between 9 pm and 7 am.

## 4. Functional limitations (what it does not do yet)

**Tax and regulation**
- **GRA E-VAT is not built.** It needs GRA API access and certification. VAT-registered shops keep using their own GRA process.
- Pharmacy Council and FDA record-keeping rules are still to be confirmed. The prescription fields exist and can be made required.

**Payments**
- Integrated Paystack uses each shop's own Paystack account. Refunds of Paystack payments are made in the Paystack dashboard, not in the app.
- Till Paystack charges do not take combo meals or sell-by-amount items, and are not available on the offline till.
- Mobile money at the counter is recorded manually with a reference. There is no automatic MoMo request-to-pay.

**Online orders**
- Orders are filled from the shop's **first branch only**.
- A delivery fee is shown and paid on delivery, not in the online payment.

**Offline till**
- It cannot take loyalty points, gift cards or Paystack (these need the server).
- It does not push its cart to the customer display.

**Loyalty**
- Points expire on schedule, but customers get no SMS warning before they expire.

**Reports**
- Gift-card sales count as sales; the money held on gift cards is shown separately.

**Images**
- Photos are stored in R2, separate from the database backup.

**Security**
- There is no script-level content security policy yet (it needs per-page nonces).
- No error-tracking service is connected; errors go to the host's logs as JSON lines.

**Scale**
- The backup tool holds the whole database in memory. It is fine for the first shops; move to `pg_dump` beyond a few hundred MB.
- No load testing has been done.

**Not tested automatically**
- Real phones, tablets, scanners and printers.
- Live Paystack and Arkesel accounts (tests use stand-ins).

## 5. Recommendations

**Before launch (in order)**
1. Work through `docs/launch-checklist.md`:
   - Neon with point-in-time recovery; all required settings; migrations; the first platform admin;
   - Paystack webhooks (platform and each shop); register the Arkesel sender ID; verify the Resend domain; R2 with versioning.
2. Keep `MFA_SECRET_KEY` in a password manager. Without it, the sealed parts of every backup are lost.
3. Do a **restore drill**: back up, restore into an empty Neon branch, sign in, and check the sales.
4. **Run a live pilot with 2 or 3 friendly shops** (one each of retail, pharmacy and food) for 2 to 4 weeks before selling widely. It tests real phones, scanners, printers, offline days, MoMo habits and the SMS costs, which tests cannot cover.
5. Add an uptime monitor on `/api/health` and an alert on `"event":"request_error"` log lines.
6. Do small live end-to-end payments (subscription, till Paystack, online order), then refund them.

**Soon after launch**
- Choose Vercel Pro (the 15-minute cron job needs it) or an outside scheduler.
- Connect an error-tracking service (for example Sentry) to the JSON logs.
- Paginate the storefront beyond 200 products, for big shops.
- Let shops choose the online-order branch.
- Add an SMS warning before points expire.
- Get a lawyer's review of the terms, privacy notice and data retention (Ghana's Data Protection Act requires registering with the Data Protection Commission).

**Later**
- GRA E-VAT, once GRA access is granted.
- Automatic MoMo confirmation (request-to-pay).
- A nonce-based script CSP.
- Load testing before onboarding many shops at once.
- Streaming backups (`pg_dump`) as the data grows.

**Working practice**
- The repository lives in OneDrive, and OneDrive locked `.next` during builds twice. Move the project out of OneDrive, or exclude `.next` and `node_modules` from syncing.
