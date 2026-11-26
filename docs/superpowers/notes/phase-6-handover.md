# Phase 6 hand-over: larger retailers, online orders, and integrations

Spec 3 (addresses), 4.3, 4.12, 4.29, 6.11, 6.49; spec line 2281.

**Decision (owner, this phase):** integrated Paystack payments use **each shop's own Paystack account**. The shop pastes its secret key, which is stored sealed with AES-256-GCM through `secret-box`. Money settles straight to the shop, and the platform never holds sales money. There is no KYC work for the platform.

## What was built

- **Schema** (migrations 0052 to 0054, with RLS). New file `src/db/schema/integrations.ts`:
  - `shop_charges`, `online_orders`, `phone_verifications`, `api_keys`, `webhook_endpoints`, `webhook_deliveries`, `shop_domains`;
  - tenant columns `paystack_secret_sealed`, `paystack_key_hint`, `online_orders_enabled`, `online_order_expiry_minutes`, `delivery_fee_pesewas`, `transfer_instructions`;
  - a server-only tender `paystack`;
  - permissions `online_orders` (owner and manager, and allowed on a till PIN) and `manage_integrations` (owner only).
- **Shop Paystack** (`src/server/shop-paystack.ts`; `paystack.ts` now has `paystackWith(key)`):
  - The till's "Charge with Paystack (card or MoMo)" prices the cart on the server and folds in the running promotions. It then opens a Paystack checkout and shows a QR code for the customer's phone. The till polls every 3 s.
  - The sale is made only after Paystack's verify endpoint confirms the exact amount in GHS. The sale and the charge being marked paid happen in one transaction, so the sale completes exactly once.
  - If the money arrives but the sale is refused (no open shift, for example), the charge stays pending and is retried on the next check or webhook.
  - A wrong amount is flagged `mismatch` and audited.
  - Per-shop webhook: `POST /api/[slug]/paystack/webhook`, with an HMAC-SHA512 signature checked against that shop's own key.
- **Online orders** (`src/server/online-orders.ts`, spec 6.49):
  - The shop turns them on under Storefront (lapse time, delivery fee paid on delivery, transfer details). The storefront then shows "Order online".
  - `/[slug]/order`: the visitor confirms their phone by a 6-digit SMS code (at most 3 an hour, 5 tries each). An httpOnly cookie keeps the token, so later orders skip the code.
  - `?src=whatsapp|instagram|facebook` tags the order source.
  - Prices come from the public catalogue: the cheapest active variant in its base unit, through `priceCart`. Prescription-only items, gift cards and unpublished products are refused. Stock is checked as available = on hand − reserved, and the order's stock is reserved.
  - Rate limits: 5 orders an hour per phone and 10 per IP.
  - Payment: Paystack on the shop's account (confirmed on return or by webhook), or a transfer with a screenshot. The screenshot is compressed and stored privately; staff view it at `/app/online-orders/[id]/proof`.
  - Staff (`/app/online-orders`): confirm the transfer with its reference, mark ready or out for delivery, hand over (a sale at the till; the reservation is released first), or cancel (stock goes back; the refund is made outside the system).
  - SMS goes to the shop for each new order and each uploaded proof, and to the customer at each step. All are kind `order`, so they count toward the shop's allowance.
  - The cron job lapses unpaid orders and releases their stock.
  - The visitor's order page shows the order only to the phone that placed it.
- **Accounting export:** a new `journal` dataset gives a balanced general journal (Date, Journal No, Account, Debit, Credit, Description) per day, importable into QuickBooks, Xero or Sage:
  - sales: payment accounts (cash less change), sales, tax payable, and cash rounding;
  - refunds and expenses: separate entries.
  - The daily accounting summary now includes the newer tenders.
- **API** (`src/server/api-keys.ts`, `GET /api/v1/{products,stock,sales,orders}`):
  - Read-only scopes. A key looks like `ads_<prefix>_<secret>`; only a sha256 hash is stored, and the key is shown once.
  - Sales are limited to a 31-day range. Responses never include costs, staff or customers.
- **Outgoing webhooks** (`src/server/webhooks.ts`):
  - Events: `sale.completed` and `stock.low` (fired once, when a sale takes an item from above its reorder level to at or below it), emitted from `finaliseSaleTx`; `order.created`.
  - Deliveries are queued in the same transaction and sent by the cron job.
  - Signing: `x-webhook-signature` = HMAC-SHA256 of `timestamp.body`.
  - URLs must be public https, not bare IPs or localhost. The host is resolved before each send and refused if any address is private. Redirects are not followed.
  - Failed deliveries back off exponentially for up to 8 attempts.
- **Several registers per branch:** this already worked (plan limits: starter 2, standard 6, pro 15). The dashboard now shows takings by till when a shop has more than one. Payments by method now include server-only tenders such as Paystack and deposits.
- **Subdomains and custom domains** (`src/server/domains.ts`, `src/proxy.ts`):
  - `slug.ROOT_DOMAIN` works with wildcard DNS.
  - A custom domain goes live after a TXT record `_adsmartshop.<host>` holds its token; a shop may have up to 3.
  - The proxy rewrites `/x` to `/<slug>/x`. Existing `/<slug>/…` links keep working.
  - It resolves hosts through `/api/domains/resolve`, protected by the `CRON_SECRET` header and cached for 60 s.
  - `/api/domains/allowed?domain=` is the on-demand TLS "ask" endpoint for Caddy.
- **Screens:** `/app/integrations` (Paystack key, API keys, webhooks, domains), `/app/online-orders` and `[id]`, the Online orders section under Storefront, public `/[slug]/order`, `/[slug]/order/[id]` and `/[slug]/paid`, and links on the home page.
- **Env:** new `ROOT_DOMAIN`. `CRON_SECRET` is now also used by the proxy's domain lookup.

## Tests

- `tests/server/integrations.test.ts` (9 tests): key sealing and access; the till charge (pending, completed exactly once, mismatch); per-shop webhook signatures; both online order flows (transfer, and Paystack with lapse); webhook URL rules, signing and blocking private addresses; API key scopes and revocation; journal balance; domain verification.
- `tests/proxy.test.ts` gained a host-rewrite test.

## Not done / notes

- Till Paystack charges do not take coupons, combos or sell-by-amount items (`priceCart` refuses the last two). The offline till cannot use Paystack.
- Online orders are filled from the shop's first branch, and each product sells as its cheapest variant in its base unit. There is no choosing of variants online.
- Refunds for cancelled paid online orders are made in the Paystack dashboard or by transfer back; the order records the amount due.
- Webhook DNS check: the address is checked before the request, but `fetch` resolves again (a small DNS-rebinding window). Pin the resolved IP with a custom agent if that matters.
- The API has no per-key rate limit. Keys have 256 bits, so they cannot be guessed. Add a limit before opening the API widely.
- Certificates for custom domains need the hosting setup: Caddy on-demand TLS pointing at `/api/domains/allowed`, or the host's domain API. This is not automated here.
- The order page shows the payment deadline in UTC (Ghana time).
