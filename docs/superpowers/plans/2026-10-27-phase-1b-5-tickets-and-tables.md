# Phase 1b-5: Open Tickets, Tables, Kitchen Stations, and Service Charge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Table service for sit-down restaurants: a waiter opens a ticket for a table or a name, adds items over time, sends new items to the kitchen by station, the kitchen marks them ready, sent items are voided only with a manager's PIN, lines move between tickets, and the bill is paid at the end with an optional service charge.

**Architecture:** Tickets and their lines live on the server (online only). A ticket line holds what a sale line needs (item, unit, quantity, combo choices, add-ons, note) plus its station and kitchen status; prices are taken when the ticket is paid. Paying builds a normal sale through `completeSale` with `food.ticketId`, so tax, stock, add-ons, and receipts behave as for any sale.

**Tech Stack:** Next.js 16, Drizzle, PGlite tests, Vitest, zod 4.

**Spec:** `docs/superpowers/specs/2026-10-20-multishop-pos-design.md` sections 4.24 (Table, Open tickets, Tables, Kitchen, Service charge), 6.6 (service charge), 6.37 (tickets and kitchen).

## Not in this plan
- Split bills (6.38): Plan 1b-6.
- Offline tickets held on one device, and kitchen printing through the print helper.
- Tips; a tax rule for the service charge (it is untaxed until the GRA E-VAT phase).
- The general approvals service (6.7) for refunds and discounts: the Controls plan. Here only the void check asks for a manager PIN.

## Global Constraints
All Global Constraints of Plans 1b-1 to 1b-4 apply. New here:
- **Stations:** `'kitchen' | 'bar' | 'grill'`, set per product (`products.kitchen_station`, default `'kitchen'`).
- **Tables:** name 1–20, unique per branch in any case; status `'free' | 'ordering' | 'waiting_for_food' | 'bill_printed'`; never deleted, only made inactive (an inactive table with an open ticket keeps it).
- **Tickets:** label 1–40 (a table's ticket uses the table name); `diningOption` `eat_in | takeaway | delivery`; status `'open' | 'paid' | 'merged' | 'cancelled'`; at most one open ticket per table. The branch must offer the `table` service mode.
- **Ticket lines:** kitchen status `'new' | 'sent' | 'ready' | 'void'`. Only `new` lines can be changed or removed freely. A `sent` or `ready` line is voided with a reason (1–200) and a manager's PIN (the approver holds `void_sent_items`, is not the requester, and the PIN check uses the same lockout as the till, 6.1); "already prepared" records its ingredients as waste (`wastage_entries`, reason `spoiled`, note `voided after sending`).
- **Table status:** opening a ticket → `ordering`; send to kitchen → `waiting_for_food`; print bill → `bill_printed`; paid, cancelled, or moved away → `free`.
- **Service charge:** `tenants.service_charge_bp` 0–2500 (0 = off). `serviceChargePesewas = round_half_up((subtotal − discount) × bp / 10000)`, untaxed, added to the sale total and shown as its own receipt line. Only table-mode sales from a ticket get it.
- **Paying:** lines of the sale = the ticket's non-void lines in order, then only pack lines (as for phone orders); prices checked as for any sale; one sale per ticket; the ticket becomes `paid` with `sale_id`; online only.
- **Permissions:** `take_orders` (open tickets, add, send, move, print bill; cashier and manager presets, `TILL_PERMISSIONS`); `void_sent_items` (owner and manager; never in `TILL_PERMISSIONS` for the requester side, but it is checked on the approver). Setup of tables and service charge: `manage_shop_settings`.
- **Audit actions:** `ticket_opened`, `ticket_sent`, `ticket_line_voided`, `ticket_lines_moved`, `ticket_merged`, `bill_printed`, `table_saved`, `service_charge_saved`.

## Review Focus
1. **Two waiters open a ticket for Table 5 at the same moment:** only one open ticket exists; the other is told the table is taken. → Task 3 `one open ticket per table, even at once`.
2. **A waiter voids a sent dish with their own PIN as "manager":** refused. → Task 4 `void needs another person's manager PIN`.
3. **A ticket's lines change between "print bill" and payment** (a late drink): the sale charges what is on the ticket at payment, and the price is today's. → Task 5 `pays exactly the ticket's lines`.
4. **Moving every line to another ticket** merges the tickets and frees the first table. → Task 4 `moving all lines merges and frees the table`.
5. **A service charge on a discounted bill** is worked out on the discounted amount, half up. → Task 2 `service charge is half up on the net`; Task 5 `adds the service charge to the bill`.

## File Structure
```text
src/db/schema/food.ts            + diningTables, tickets, ticketLines; KitchenStation, TableStatus, TicketStatus
src/db/schema/catalogue.ts       products.kitchenStation
src/db/schema/tenancy.ts         tenants.serviceChargeBp
src/db/schema/selling.ts         sales.ticketId, sales.serviceChargePesewas
src/lib/permissions.ts, src/lib/permission-labels.ts   + take_orders, void_sent_items
drizzle/0018_food_tickets.sql (generated), drizzle/0019_food_tickets_rls.sql (custom)
src/lib/food.ts                  + serviceChargePesewas, KITCHEN_STATIONS
src/server/tables.ts             listTables, saveTable, saveServiceCharge
src/server/tickets.ts            openTicket, getTicket, listOpenTickets, addTicketLine, removeTicketLine, sendToKitchen, voidSentLine, moveTicketLines, printBill, cancelTicket, payTicket
src/server/kitchen-display.ts    listStationLines, markLineReady
src/server/sales.ts, src/server/receipts.ts   ticket payment, service charge
src/app/[slug]/app/tables/…, src/app/[slug]/app/tickets/[ticketId]/…, src/app/[slug]/app/kitchen/stations/…, food settings and product page fields
tests/lib/food.test.ts, tests/db/food-schema.test.ts, tests/server/{tables,tickets,ticket-sales,kitchen-display}.test.ts
```

---

### Task 1: Ticket schema and permissions
**Files:** schema files above, both migrations, `src/lib/permissions.ts`, `src/lib/permission-labels.ts`. Test `tests/db/food-schema.test.ts`, `tests/lib/permissions.test.ts`.

**Interfaces — Produces:**
- `diningTables`: `id, tenantId, branchId, name, status text default 'free', active boolean default true, sortOrder, createdAt`; unique `(tenant_id, id)`; unique index `(tenant_id, branch_id, lower(name))`; status check.
- `tickets`: `id, tenantId, branchId, tableId uuid null, label text, waiterId uuid, diningOption text, status text default 'open', saleId uuid null, openedAt, closedAt`; unique `(tenant_id, id)`; partial unique index `tickets_open_table` on `(tenant_id, table_id) where status = 'open' and table_id is not null`; check `status <> 'paid' or sale_id is not null`; composite FKs to branches, tables, users, sales.
- `ticketLines`: `id, tenantId, ticketId, lineNo integer, variantId, unitId, quantity numeric(14,3), byAmount boolean default false, amountPesewas integer null, choices jsonb default '[]', addOns jsonb default '[]', note text (≤140), station text, kitchenStatus text default 'new', sentAt, readyAt, voidReason text, voidedBy uuid, approvedBy uuid`; unique `(ticket_id, line_no)`; checks on station and status; `kitchen_status <> 'void' or void_reason is not null`.
- `products.kitchenStation text not null default 'kitchen'` (check); `tenants.serviceChargeBp integer not null default 0` (0–2500); `sales.ticketId uuid` (composite FK, unique per tenant), `sales.serviceChargePesewas integer not null default 0` (>= 0).
- Permissions `'take_orders'` (label `'Open table tickets and send orders'`; cashier preset, `TILL_PERMISSIONS`), `'void_sent_items'` (label `'Approve voiding items already sent to the kitchen'`; owner and manager presets).
- `0019`: tenant isolation on the three tables; cache trigger on `products` already exists; backfill `take_orders` for sellers in kitchen-module shops and `void_sent_items` for owners and managers.

- [ ] **Step 1: Write the failing tests:** `one open ticket per table`, `a paid ticket needs its sale`, `a voided line needs a reason`, `table names are unique per branch in any case`; permissions `a cashier PIN can take orders but not approve voids`.
- [ ] **Step 2: Run** `npx vitest run tests/db tests/lib/permissions.test.ts` → FAIL.
- [ ] **Step 3: Write the schema**; `npx drizzle-kit generate --name food_tickets`; `npx drizzle-kit generate --custom --name food_tickets_rls`; check FK order.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(db): add tables, tickets, ticket lines, stations, and service charge`

---

### Task 2: Service charge rule
**Files:** `src/lib/food.ts`. Test `tests/lib/food.test.ts`.
```ts
export const KITCHEN_STATIONS = ['kitchen', 'bar', 'grill'] as const;
export type KitchenStation = (typeof KITCHEN_STATIONS)[number];
export function serviceChargePesewas(netPesewas: number, bp: number): number; // half up; 0 when bp is 0
```
- [ ] **Step 1: Failing test** `service charge is half up on the net`: `serviceChargePesewas(10_000, 1000)` → 1000; `(333, 1500)` → 50; `(5_000, 0)` → 0.
- [ ] **Steps 2–5:** run → FAIL; implement with `divHalfUp`; run → PASS; commit `feat(food): service charge rule`.

---

### Task 3: Tables, service charge setup, and opening tickets
**Files:** create `src/server/tables.ts`; create `src/server/tickets.ts` (opening and reading). Tests `tests/server/{tables,tickets}.test.ts`.

**Interfaces — Produces:**
```ts
// tables.ts (manage_shop_settings, except listTables: take_orders or manage_shop_settings)
export type DiningTable = { id: string; name: string; status: TableStatus; active: boolean; openTicketId: string | null };
export async function listTables(db: Db, ctx: Ctx, branchId: string): Promise<DiningTable[]>;
export async function saveTable(db: Db, ctx: Ctx, input: { id?: string; branchId: string; name: string; active: boolean }): Promise<{ ok: true; tableId: string } | Fail<'invalid_input' | 'duplicate_name' | 'not_assigned' | 'not_found'>>;
export async function saveServiceCharge(db: Db, ctx: Ctx, bp: number): Promise<{ ok: true } | Fail<'invalid_input'>>;
// tickets.ts (take_orders; branch from ctx.registerId, else the only branch the user works at)
export type TicketView = { id: string; label: string; tableId: string | null; status: TicketStatus; diningOption: DiningOption; waiterName: string; openedAt: Date;
  lines: Array<{ id: string; lineNo: number; name: string; quantity: string; addOns: string[]; note: string | null; station: KitchenStation; kitchenStatus: 'new' | 'sent' | 'ready' | 'void' }> };
export async function openTicket(db: Db, ctx: Ctx, input: { tableId?: string; label?: string; diningOption: DiningOption }, now: Date): Promise<{ ok: true; ticketId: string } | Fail<'invalid_input' | 'no_branch' | 'table_taken' | 'unknown_table' | 'mode_not_allowed'>>;
export async function getTicket(db: Db, ctx: Ctx, ticketId: string): Promise<TicketView | null>;
export async function listOpenTickets(db: Db, ctx: Ctx, branchId: string): Promise<Array<Omit<TicketView, 'lines'> & { lineCount: number }>>;
```
A table ticket's label is the table name. The unique index decides a race (`table_taken`).

- [ ] **Step 1: Failing tests:** tables `adds tables and refuses a duplicate name`, `saves a 10% service charge and refuses over 25%`; tickets `opens a ticket for a table and marks it ordering`, `one open ticket per table, even at once` (two `openTicket` in `Promise.all` → one ok, one `table_taken`), `opens a named ticket without a table`, `refuses when the branch has no table service`.
- [ ] **Steps 2–5:** run → FAIL; implement; run → PASS; commit `feat(food): tables, service charge setting, and open tickets`.

---

### Task 4: Ticket lines, kitchen sending, voids, and moves
**Files:** `src/server/tickets.ts`. Test `tests/server/tickets.test.ts`.

**Interfaces — Produces:**
```ts
export async function addTicketLine(db: Db, ctx: Ctx, ticketId: string, line: { variantId: string; unitId: string; quantity: string; byAmount?: boolean; amountPesewas?: number; choices?: ComboChoice[]; addOns?: AddOnChoice[]; note?: string }, now: Date):
  Promise<{ ok: true; lineId: string } | Fail<'not_found' | 'not_open' | 'invalid_input' | 'unknown_item' | 'not_sellable' | 'invalid_quantity' | 'invalid_choices' | 'invalid_add_ons' | 'sold_out'>>;
export async function removeTicketLine(db: Db, ctx: Ctx, lineId: string): Promise<{ ok: true } | Fail<'not_found' | 'already_sent'>>;
export async function sendToKitchen(db: Db, ctx: Ctx, ticketId: string, now: Date): Promise<{ ok: true; sent: Record<KitchenStation, number> } | Fail<'not_found' | 'not_open' | 'nothing_new'>>;
export async function voidSentLine(db: Db, ctx: Ctx, input: { lineId: string; reason: string; prepared: boolean; approverId: string; approverPin: string }, now: Date):
  Promise<{ ok: true } | Fail<'not_found' | 'not_sent' | 'invalid_input' | 'self_approval' | 'not_authorised' | 'wrong_pin' | 'pin_locked'>>;
export async function moveTicketLines(db: Db, ctx: Ctx, input: { fromTicketId: string; toTicketId: string; lineIds: string[] }, now: Date): Promise<{ ok: true; merged: boolean } | Fail<'not_found' | 'not_open' | 'invalid_input'>>;
export async function printBill(db: Db, ctx: Ctx, ticketId: string, now: Date): Promise<{ ok: true } | Fail<'not_found' | 'not_open'>>;
export async function cancelTicket(db: Db, ctx: Ctx, ticketId: string, reason: string, now: Date): Promise<{ ok: true } | Fail<'not_found' | 'not_open' | 'has_sent_lines' | 'invalid_input'>>;
```
- `addTicketLine` uses the same item checks as `createPhoneOrder` (extract them from `phone-orders.ts` into an exported `checkOrderLine(tx, line, branchId, day)` in `sales.ts` and reuse it in both); the station is the product's; lineNo = max + 1; a pack item is refused (`invalid_input`), packs are added at payment.
- `voidSentLine` verifies the approver's PIN with the till lockout (move the PIN check from `switchCashierWithPin` into an exported `verifyStaffPin(tx, staffId, pin, now)` in `devices.ts` and use it in both).
- Moving all of a ticket's lines makes it `merged`; renumber moved lines after the target's last line.

- [ ] **Step 1: Failing tests:** `adds items with add-ons and a note at their station`, `removes a new line but not a sent one`, `sends only new lines and marks the table waiting for food`, `void needs another person's manager PIN` (own PIN → `self_approval`; cashier approver → `not_authorised`; wrong PIN → `wrong_pin`; manager → ok, line `void`), `a prepared void records the ingredients as waste`, `moves lines to another ticket`, `moving all lines merges and frees the table`, `cancels a ticket with nothing sent; refuses once items went to the kitchen`.
- [ ] **Steps 2–5:** run → FAIL; implement; run `npx vitest run tests/server` → PASS; commit `feat(food): ticket lines, sending to the kitchen, voids, and moves`.

---

### Task 5: Paying a ticket with the service charge
**Files:** `src/server/sales.ts`, `src/server/tickets.ts`, `src/server/receipts.ts`, `src/lib/device-contract.ts`. Test `tests/server/ticket-sales.test.ts`.

**Interfaces — Produces:**
- `SaleInput['food'].serviceMode` gains `'table'` (server only; the device never sends it) and `food.ticketId?: string`; `SaleError` + `'ticket_not_open'`.
- `export async function payTicket(db: Db, ctx: Ctx, input: { ticketId: string; tenders: SaleInput['tenders'] }, now: Date): Promise<SaleResult>` in `tickets.ts`: builds the sale from the ticket (today's prices from the catalogue, pack lines for takeaway or delivery), takes the register's next receipt number (`registers.receiptCounter + 1`; on `duplicate_receipt_number` retry once with the next), and calls `completeSale`.
- In `completeSale`, with `food.ticketId`: the ticket must be `open` at the register's branch (`ticket_not_open`); the sale lines must equal its non-void lines in order, then only pack lines (`order_changed`); the branch must offer `table`; `serviceChargePesewas` from the shop setting is added to `totalPesewas` (and to what the tenders must cover); no kitchen order or order number is made; the ticket becomes `paid` with `sale_id` and `closed_at`, and its table `free`.
- Receipt view + `serviceChargePesewas`.

- [ ] **Step 1: Failing tests:** `pays exactly the ticket's lines` (a line added after the bill was printed is charged; a price changed since the order is charged at today's price), `adds the service charge to the bill` (10% on GHS 90 → GHS 9; total 9900), `a paid ticket cannot be paid again` (`ticket_not_open`), `voided lines are not charged`, `the table is free after payment`, `the receipt shows the service charge`.
- [ ] **Steps 2–5:** run → FAIL; implement; run `npx vitest run tests/server` → PASS; commit `feat(food): pay a ticket with the service charge`.

---

### Task 6: Kitchen display by station
**Files:** create `src/server/kitchen-display.ts`. Test `tests/server/kitchen-display.test.ts`.
```ts
export type StationTicket = { ticketId: string; label: string; waiterName: string; oldestSentAt: Date; lines: Array<{ lineId: string; name: string; quantity: string; addOns: string[]; note: string | null; sentAt: Date }> };
export async function listStationLines(db: Db, ctx: Ctx, branchId: string, station: KitchenStation): Promise<StationTicket[]>; // run_kitchen; sent lines of open tickets, grouped by ticket, oldest first
export async function markLineReady(db: Db, ctx: Ctx, lineId: string, now: Date): Promise<{ ok: true } | Fail<'not_found' | 'not_sent'>>;
```
- [ ] **Step 1: Failing tests:** `shows only the station's sent lines, oldest ticket first`, `marking ready moves a line off the display`, `another branch's lines are not shown`.
- [ ] **Steps 2–5:** run → FAIL; implement; run → PASS; commit `feat(food): kitchen display by station`.

---

### Task 7: Screens
**Files:** create `src/app/[slug]/app/tables/{page.tsx,actions.ts}`, `src/app/[slug]/app/tickets/[ticketId]/{page.tsx,actions.ts}`, `src/app/[slug]/app/kitchen/stations/page.tsx`; modify food settings (service charge, tables list), the product page (station select), home links.
- Tables page (take_orders): tables of the branch with status colour and the open ticket; "Open" a free table; "New named ticket".
- Ticket page: lines with station, status, add-ons, note; an add form (item select, quantity, add-on selects per group, note); "Send to kitchen"; remove for new lines; void for sent lines (reason, "Already prepared", manager, PIN); move selected lines to another open ticket; "Print bill" (bill with service charge; `window.print()`); "Pay" (cash, MoMo, card, bank with reference) → `payTicket` → receipt.
- Station display: `?station=kitchen|bar|grill`, auto-refresh 10 s, tickets oldest first coloured by waiting time (green under 10 min, amber under 20, red after), "Ready" per line.
- [ ] **Step 1: Build the screens.** **Step 2:** `npx tsc --noEmit` and `npm run build` → green. **Step 3: Commit** `feat(food): tables, tickets, and station display screens`.

---

### Task 8: Verify and hand over
- [ ] `npx vitest run`, `npx tsc --noEmit`, `npm run build` → green; fresh review, fix Critical and Important test-first; browser walk-through (open Table 1, add with add-ons, send, ready on the station display, void with manager PIN, print bill, pay with service charge); write `docs/superpowers/notes/phase-1b-5-handover.md`; commit.
