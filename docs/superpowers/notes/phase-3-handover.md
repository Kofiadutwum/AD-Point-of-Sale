# Phase 3 hand-over: billing automation

Spec 4.27, 5, 6.11, 6.20, 6.48.

## What was built

- **Schema** (migrations 0046, 0047): `subscription_checkouts` (pending Paystack payments: reference, plan, amount, kind checkout/renewal, status pending/applied/failed/mismatch, auto-renew consent wording and who agreed); `processed_events` (provider, event, reference; stops double processing and double notices); `signup_verifications` (hashed SMS and email codes, 30 minutes, 5 tries); subscriptions `authorization_code` (sealed with the MFA key), `card_label`, `billing_email`; notifications kind `billing` (platform SMS, not counted against the shop's allowance). Plans: Starter GHS 150, Standard GHS 300, Pro GHS 600 a month, billed yearly (12×).
- `src/server/paystack.ts`: live client (initialize with card and mobile money, verify, charge_authorization; amounts in pesewas) and `validSignature` (HMAC-SHA512 of the raw body, constant-time).
- `src/server/billing.ts`:
  - `startCheckout` saves a pending checkout with a unique `SUB-` reference and returns the Paystack page.
  - `applyReference` checks with Paystack on the server. It extends the plan once per reference (from the later of the end date and today) and records the payment. The card is kept only with consent and a reusable authorisation. A receipt goes out by email and SMS. Wrong amounts are marked as mismatches and audited.
  - `handleWebhook` checks the signature before parsing and processes inline; redelivery is harmless.
  - `cancelAutoRenew`.
  - `runBillingJob` (called from the existing cron route):
    - trial reminders 3 and 1 days before the end, and a notice after it ends;
    - renewal reminders 30, 7, and 1 days before;
    - one card charge on the end date (`REN-<subscription>-<end date>`);
    - a failed-renewal notice;
    - expiry and read-only notices.
- `src/server/signup.ts`: `startSignup` sends one code to the phone and one to the email, and rate-limits each address; `completeSignup` needs both codes, then creates the shop on a 14-day trial and sets the owner's password. `onboardShop` now accepts no admin (logged as anonymous) and can skip the activation email.
- **Screens**:
  - `/[slug]/app/billing`: plans with yearly prices, card-renewal consent showing the exact wording, Pay with Paystack, payments, turning renewal off. Read-only shops can reach it.
  - `/[slug]/app/billing/return`: Paystack's callback; checked on the server.
  - `POST /api/paystack/webhook`.
  - `/signup` and `/signup/verify/[id]`; the landing page button is now "Start a free trial".
  - The home banner links to Billing; home has a Billing link.

## Tests

`tests/server/billing.test.ts` (6); the plan seed tests were updated. In dev, self sign-up was run end to end: codes printed, shop created, owner signed in, trial banner shown.

## Setup before launch

- Set `PAYSTACK_SECRET_KEY`, and set the webhook URL `$APP_URL/api/paystack/webhook` in the Paystack dashboard.
- Confirm that card authorisations are reusable for GHS on the account.
- `MFA_SECRET_KEY` also seals card authorisations.
- The cron call must run every 15 minutes.

## Not done / notes

- Webhook work runs inline, not on a queue.
- Changing plan mid-year is just a new yearly payment from the later of the end date and today; there is no proration.
- The platform admin is not alerted on a mismatch beyond the audit entry.
- The billing page was not opened in the browser here (the build compiles it, and the service is tested).
