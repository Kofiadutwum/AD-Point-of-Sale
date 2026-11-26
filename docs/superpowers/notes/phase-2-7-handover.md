# Phase 2-7 hand-over: storefront with WhatsApp ordering

Spec 4.12, 6.18, 6.19.

## What was built

- **Schema** (migrations 0044, 0045): tenants `storefront_published`, `storefront_taken_down`, `storefront` (jsonb shop section: about, WhatsApp, hours, theme colour, Facebook, Instagram, show prices, show stock, announcement and end date); `storefront_stats` (counts per day and key: view, product:<id>, whatsapp[:<id>], call[:<id>]; no personal data). RLS. Permission `manage_storefront` (owner, manager).
- `src/server/storefront.ts`: `getStorefront`, `cleanSettings`/`saveStorefront` (WhatsApp in 233 format, about ≤ 500, https links, colour), `setPublished` (needs a product marked "Show on storefront"), `setTakenDown` (platform admin, reason, owner emailed, audited), `publicStorefront` (search, category filter), `publicProduct`, `orderLink` (counts the click; pre-filled WhatsApp text with name, price, link; no link for prescription-only medicine), `publicImage`, `storefrontStatsSummary` (30 days). The public catalogue exposes name, description, category, price or "Call for price", In stock / Out of stock, and photos only. Hidden when missing, suspended, unpublished, taken down, or read-only (still shown in the grace period).
- **Public pages**: `/[slug]` (shop header, announcement, search, categories, product grid, Open Graph tags, "Report this page"), `/[slug]/p/[id]` (photos, price, availability, Order on WhatsApp / Call or "ask at the pharmacy"), `/[slug]/i/[imageId]` (photos, 10-minute cache), `/[slug]/go/whatsapp|call` (count, then redirect).
- **Owner**: `/app/storefront` (shop section form, publish/hide, link and QR code, 30-day counts); home link "Storefront". **Admin**: shop page "Storefront" takedown/restore.

## Tests

`tests/server/storefront.test.ts` (3). Dev check: storefront, product page, WhatsApp redirect, OG tags, 404s all served.

## Not done / notes

- Logo and cover image upload; receipts do not yet carry the storefront link or QR.
- Pages are rendered per request (so views can be counted), not cached for 10 minutes.
- Prices are the base price (the shelf price for tax-inclusive shops).
- "Report this page" is a mailto link to `REPORT_EMAIL`.
- Online orders (6.49) are a later phase.
