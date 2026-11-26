# Phase 1b-6: Split Bills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A table bill can be split by item, by seat, or in equal parts; each part is paid and receipted separately, and the parts always add up exactly to the bill.

**Architecture:** By item or seat, each part is its own sale made from the ticket lines it covers (a shared line can be split by quantity). `ticket_lines.paid_quantity` records what is already paid; the ticket closes when every live line is fully paid. Equal parts are one sale paid by several people: the total is divided into shares (leftover pesewas to the first share) and each payer gets a share slip.

**Tech Stack:** Next.js 16, Drizzle, PGlite tests, Vitest, zod 4.

**Spec:** `docs/superpowers/specs/2026-10-20-multishop-pos-design.md` sections 4.24 (Split bills), 6.38.

## Global Constraints
All Global Constraints of Plans 1b-1 to 1b-5 apply. New here:
- `ticket_lines.paid_quantity numeric(14,3) not null default 0`, check `0 <= paid_quantity <= quantity`; `ticket_lines.seat integer` (1–50, nullable).
- A part names ticket lines and a quantity of each, at most the line's unpaid quantity (`quantity − paid_quantity`), in 3-decimal steps; a by-amount line is paid whole.
- Each part sale is priced from the catalogue at payment and carries the service charge on its own net (half up). The last part pays exactly what remains.
- A line with any paid quantity cannot be removed, voided, or moved (`already_paid`).
- `equalShares(totalPesewas, parts)`: parts 2–20; each share = floor(total / parts); the leftover pesewas go to the first share; shares always sum to the total.
- Equal parts: one sale with one tender per share (methods may differ); a share slip per payer shows "Share k of n" and its amount.

## Review Focus
1. **Two people pay the same shared dish at once:** the second is refused, nothing is paid twice. → Task 3 `paying the same line twice at once`.
2. **The last part after earlier parts:** pays only what remains, then the ticket closes and the table is free. → Task 3 `the last part closes the ticket`.
3. **Equal split of GHS 100 into 3:** 33.34, 33.33, 33.33. → Task 2 `equal shares keep every pesewa`.
4. **Voiding a dish someone already paid for** is refused. → Task 4 `a paid line cannot be voided, removed, or moved`.

---

### Task 1: Schema
**Files:** `src/db/schema/food.ts`, `drizzle/0021_*.sql` (generated). Test `tests/db/food-schema.test.ts`.
- [ ] Failing test `paid quantity stays between 0 and the quantity`; add the two columns and checks; generate; run → PASS; commit `feat(db): paid quantity and seat on ticket lines`.

### Task 2: Equal shares rule
**Files:** `src/lib/food.ts`. Test `tests/lib/food.test.ts`.
```ts
export function equalShares(totalPesewas: number, parts: number): number[];
```
- [ ] Failing test `equal shares keep every pesewa`: `equalShares(10_000, 3)` → `[3334, 3333, 3333]`; `equalShares(5, 3)` → `[3, 1, 1]`; sum always equals total; implement; commit `feat(food): equal bill shares`.

### Task 3: Pay part of a ticket
**Files:** `src/server/sales.ts`, `src/server/tickets.ts`. Test `tests/server/ticket-sales.test.ts`.
- `SaleInput['food'].ticketPart?: Array<{ lineId: string; quantity: string }>`. With it, the expected lines are those parts (unpaid quantity checked under the ticket lock); without it, every line's remaining unpaid quantity. After the sale, `paid_quantity` rises by the part; when every live line is fully paid the ticket becomes paid (its `sale_id` is this last sale) and the table free.
- `payTicket(db, ctx, { ticketId, tenders, part? }, now)`; `quoteTicket(db, ctx, ticketId, now, part?)` prices the remaining or the given part.
- [ ] Failing tests: `pays one person's items and keeps the ticket open`, `the last part closes the ticket`, `a shared dish is split by quantity`, `paying the same line twice at once` (one ok, one `order_changed`), `a part cannot exceed what is unpaid`; implement; run `tests/server` → PASS; commit `feat(food): pay part of a ticket`.

### Task 4: Seats and paid-line guards
**Files:** `src/server/tickets.ts`. Test `tests/server/tickets.test.ts`.
- `addTicketLine` accepts `seat?: number` (1–50); `TicketView` lines gain `seat` and `paidQuantity`.
- `removeTicketLine`, `voidSentLine`, `moveTicketLines` refuse a line with paid quantity (`already_paid`).
- [ ] Failing tests `adds a line for a seat`, `a paid line cannot be voided, removed, or moved`; implement; commit `feat(food): seats and paid-line guards`.

### Task 5: Split bill screens
**Files:** ticket page and actions; receipt page share slip.
- Ticket page "Split the bill": **By item / seat** — each line with its unpaid quantity and a quantity box (a "Seat n" button fills that seat's lines); a live quote of the part; pay the part. **Equal** — number of people (2–20) shows the shares from the remaining total; one payment form with a method and amount per share → `payTicket` with those tenders → receipt with share slips (`/app/receipts/[id]?shares=n`).
- Add-item form gains an optional seat.
- [ ] Build; `npx tsc --noEmit`, `npm run build` → green; commit `feat(food): split bill screens`.

### Task 6: Verify and hand over
- [ ] Full suite, review, fixes, browser walk-through (split one table by seat and another equally), `docs/superpowers/notes/phase-1b-6-handover.md`, merge.
