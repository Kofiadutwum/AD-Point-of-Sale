# Phase 1b-6 hand-over: split bills

## Migration
- `0021_ticket_split`: `ticket_lines.paid_quantity` (0 to the quantity) and `ticket_lines.seat` (1–50).

## How it works
- **By item or seat:** `payTicket(..., { part: [{ lineId, quantity }] })` makes one sale for those quantities (priced from the catalogue now, with the service charge on the part's own net). `dueTicketLines` in `sales.ts` decides what a payment covers and is checked again under the ticket lock, so two people cannot pay the same quantity. `paid_quantity` rises with each part; the ticket closes (and the table is freed) when nothing live is left unpaid. A payment with no part pays everything still unpaid.
- **Equal:** one sale paid with one tender per share; `equalShares(total, n)` gives leftover pesewas to the first share; the receipt page `?shares=n` prints a slip per share.
- A line with any paid quantity cannot be removed, voided, or moved (`already_paid`).

## Screens
- Ticket page: seat on each added item; "paid x of y" on lines; "Split the bill" with quantities per line and "Work out this part", seat buttons, and "Split equally between n" with a payment row per share.

## Checked
- 577 tests pass; type check and build green.

## Not done
- No separate fresh review agent was run for this plan, and no browser walk-through of the split screens yet.
- Next.js 16.4.2 is flagged with a known security vulnerability by `next build`; upgrading to the latest 16.4.x is recommended.
