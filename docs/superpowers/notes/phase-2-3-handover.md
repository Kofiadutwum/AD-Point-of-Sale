# Phase 2-3 hand-over: quotes and business invoices

Spec 4.22, 6.35.

## What was built

- **Schema** (migrations 0038, 0039): `customers.address`, `customers.tin`; tables `quotes` (Q-0001 numbering, priced lines as jsonb, totals, `valid_until`, status open/converted/cancelled, `share_code`, `converted_sale_id`) and `invoices` (INV-0001, `sale_id`, `customer_id`, optional `quote_id`, `due_date`, `share_code`). RLS on both. Permission `issue_invoices` (owner, manager, allowed on a till PIN). Approval action `honour_expired_quote`.
- **Service** `src/server/quotes.ts`: `createQuote` (server prices, discount permission checked), `listQuotes`, `getQuote`, `cancelQuote`, `convertQuoteToSale` (sells at quoted prices through `completeSaleTx` with `quotedPrices`; an expired quote needs a manager approval token), `createInvoice` (credit-tender sale on the customer's account plus an invoice row; from a quote or typed lines), `listInvoices` (paid/due/overdue, payments settle the oldest invoice first), `getSharedDoc` (public view by share code), `saveBusinessDetails`.
- **Screens**: `/app/quotes` (make a quote by barcode or SKU, list), `/app/quotes/[id]` (lines, share link, WhatsApp link, print, sell at a till, invoice, cancel; manager PIN for expired quotes), `/app/invoices` (issue, list with what is still owed), public `/[slug]/d/[code]` (printable quote or invoice, not indexed), business details form on the customer account page. Home links: Quotes (make_sale), Invoices (issue_invoices).

## Tests

`tests/server/quotes.test.ts` (5). Full suite 649 passing.

## Not done / notes

- Selling or invoicing needs a register (till PIN session); the web pages say so when the user is not at a till.
- Quotes skip combos and items sold by amount.
- PDF is the browser's print-to-PDF of the share page; no server-side PDF.
