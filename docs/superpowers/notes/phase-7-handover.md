# Phase 7 hand-over: leftovers and hardening

The spec ends at Phase 6. The owner chose Phase 7 as: the later presets the spec mentions, closing the gaps listed in earlier hand-over notes, and the section 13 acceptance tests. GRA E-VAT is still waiting for GRA API access.

## What was built

- **Stock Clerk and Accountant role presets** (spec 2, "later phases"):
  - stock clerk: receive stock, purchasing, transfers, counts, adjustments, sold-out; it never handles money;
  - accountant: dashboard, reports, exports, expenses, debt payments, invoices;
  - both can be chosen on the Staff page; migration 0055 widens `users_role`.
- **Reserved stock cannot be sold** (section 13):
  - a sale that would dip into stock held for a layaway or online order is refused online with `reserved_stock`, even in shops that allow negative stock;
  - offline, the sale is kept and flagged `reserved_stock` for review;
  - collecting the order itself still works, because its reservation is released first.
- **API rate limit:** 600 requests per key per 15 minutes; over the limit, the API answers `429 rate_limited`. A new helper `overLimit` in `rate-limit.ts` (fixed window, reusing the `auth_attempts` table) does the counting.
- **Webhook IP pinning:** deliveries now use `node:https` and connect to the address that was checked, with TLS still verifying the host name. This closes the DNS-rebinding gap noted in Phase 6.
- **Coupons on Paystack till charges:** the coupon is checked and priced in when the charge starts. Its use is recorded only when Paystack confirms the money.
- **Points expiry job:** the cron job runs `expireAllPoints` in its 02:00 UTC runs for every shop with loyalty on and an expiry set. Repeat runs are harmless.
- **Online variants:** the order page lists each sellable variant at its base-unit price. The order form sends `variantId`; requests that send a product only still get its cheapest variant. The order page always shows prices, even when the storefront hides them.
- **Lint:** the two errors that predated this phase are fixed. The admin header uses `<Link>`. The till restores the signed-in cashier after mount; the async mount load has a one-line, explained suppression of a false positive. `eslint src tests` now reports 0 errors.

## Section 13 acceptance tests: where each is covered

| Criterion | Test file(s) |
|---|---|
| Cross-shop access by ID or URL refused; RLS returns no rows | `tests/db/rls.test.ts`, `tests/db/tenant.test.ts`, `context.test.ts`, `expectAccess` checks across suites |
| Scan, camera, and search checkout | `scan.test.ts`, `till.test.ts`, `tests/device/catalogue.test.ts` |
| Stock reduced exactly once, duplicate requests and webhooks | `sales.test.ts` (two identical requests), `billing.test.ts`, `integrations.test.ts` (Paystack charge applied twice) |
| Offline sale syncs once, keeps the paid price and the business day | `sales-http.test.ts`, `tests/device/sync.test.ts` |
| Unverified payment not paid; pending sale not counted | `integrations.test.ts` (pending charge makes no sale), `dashboard.test.ts` |
| Cart totals to the pesewa, inclusive and exclusive | `tests/lib/cart-totals.test.ts`, `tests/lib/tax.test.ts` |
| Daily and weekly SMS once per period | `sms.test.ts` |
| Permissions and approvals; no self-approval | `approvals.test.ts`, `returns.test.ts`, `inventory.test.ts` |
| Return quantities, condition and restocking | `returns.test.ts` |
| Credit limits; debt payment receipts | `credit.test.ts` |
| Shift cash and variance | `shifts.test.ts` |
| Images: WebP, ≤ 30 KB, no metadata | `images.test.ts`, `product-images.test.ts` |
| Storefront visibility; not-available states; WhatsApp links | `storefront.test.ts` |
| Subscription exactly once; failed renewal; renewal after expiry | `billing.test.ts`, `subscriptions.test.ts` |
| Wholesale price and quantity breaks | `price-lists.test.ts`, `tests/lib/pricing.test.ts` |
| Units (strip, carton) | `variants.test.ts`, `stock.test.ts` |
| Scale labels and check digits | `tests/lib/barcode.test.ts`, `scan.test.ts` |
| Expired batches, earliest expiry first; serials | `deduct.test.ts`, `returns.test.ts` |
| Recipes, add-on ingredients, production | `production.test.ts`, `add-on-sales.test.ts` |
| Weighted average cost | `stock.test.ts` |
| Prescription-only medicine and OTC-only shops | `prescriptions.test.ts` |
| Kitchen tickets once per item; voids need approval | `kitchen.test.ts`, `tickets.test.ts` |
| Split bills add up | `ticket-sales.test.ts` |
| Best promotion; coupon limits; **abandoned coupon not used** | `growth.test.ts`, **`acceptance.test.ts`** |
| Balances never below zero at the same moment | `customers.test.ts` (store credit), **`acceptance.test.ts` (loyalty points)** |
| Exchange charges or refunds only the difference | `exchanges.test.ts` |
| No-receipt returns | `returns.test.ts` |
| **Layaway stock cannot be sold to someone else** | **`acceptance.test.ts`**, `growth.test.ts` |
| Counts while selling | `inventory.test.ts` |
| Points and commission reversed on return | `growth.test.ts` |
| Cash rounding | `sales.test.ts`, `tests/lib/cash-rounding.test.ts` |
| Plan limits; no deletion on downgrade | `branches.test.ts`, `staff.test.ts`, `products.test.ts` |
| Marketing SMS consent and quiet hours | `sms.test.ts` |
| Support sessions audited | `support.test.ts` |
| CSV formula neutralising | `data-export.test.ts`, `tests/lib/csv.test.ts` |
| Order numbers and Ready board | `counter-orders.test.ts`, `ready-board.test.ts` |
| Combos and upgrades | `combos.test.ts` |
| Sell by amount and pot alerts | `pots.test.ts` |
| Sold-out switch | `sold-out.test.ts` |
| Pack fee | `food-sales.test.ts` |
| Delivery-app orders and channel reports | `channel-sales.test.ts`, `channels.test.ts` |
| Packing check | `phone-orders.test.ts`, `channel-sales.test.ts` |
| Kitchen printing through the print helper | `tests/print-helper/print-helper.test.ts` |
| Usable on phone, tablet and desktop | Not automated: needs a manual check on devices |

Gift-card balances spent at the same moment have no dedicated concurrent test. Redemption locks the card row (`for update`), the same pattern as store credit and points.

## Tests

- New file `tests/server/acceptance.test.ts` (6 tests): reserved stock, abandoned coupon, loyalty points spent at the same moment, the points expiry job, the new presets, and the rate-limit window.
- `integrations.test.ts` gained a test for coupons on Paystack charges.

## Still open

- GRA E-VAT, waiting for GRA API access and certification.
- Pharmacy Council and FDA record-keeping rules, still to be confirmed.
- No SMS warning before points expire.
- Online orders still come from the first branch only.
- Gift card and points tenders on the offline till.
- The phone, tablet and desktop usability check is manual.
