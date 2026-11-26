# Phase 4 hand-over: advanced inventory

Spec 4.19, 6.23–6.26.

## What was built

- **Schema** (migrations 0048, 0049), all with RLS:
  - new file `src/db/schema/purchasing.ts`: `suppliers`, `supplier_items` (pack unit, pack factor, last cost, main supplier), `purchase_orders` and `purchase_order_lines` (PO-0001; draft/sent/partly_received/received/closed; suggested flag), `supplier_bills`, `supplier_payments`, `supplier_returns` (credit and credit used), `stock_transfers` and `stock_transfer_lines` (TR-0001; sent/received; batch travels with the stock), `stock_counts` and `stock_count_lines` (snapshot, counted, counted-at, difference; per batch for batch items), `stock_adjustments`;
  - stock receipts now record `supplier_id` and `purchase_order_id`;
  - new movement types `transfer_out`, `transfer_in`, `supplier_return`, `count_adjustment`, `adjustment`;
  - tenants `count_approval_limit_pesewas`, `adjustment_approval_limit_pesewas`, `reorder_cover_days`;
  - permissions `manage_purchasing`, `transfer_stock`, `stock_count`, `adjust_stock` (owner, manager);
  - approval actions `stock_count`, `stock_adjustment`.
- `src/server/stock.ts`: `receiveStock` now wraps `receiveStockTx`, so receiving a purchase order shares one transaction. The return shape is unchanged.
- `src/server/stock-moves.ts`: `resolveLine` (any unit to base units), `takeStock` (optionally refuses to go below zero; handles batches), `putStock`, `valueOf`.
- `src/server/purchasing.ts`:
  - suppliers and supplier items;
  - create, send (WhatsApp or email text, then mark sent), receive all or part, and close purchase orders. Receiving updates stock, average cost, and last cost; an unpaid delivery becomes a bill due after the supplier's terms;
  - `suggestPurchaseOrders`: target = max(reorder level, 28-day daily sales × (lead time + cover days)), minus on hand and on order, rounded up to whole packs; one draft per main supplier, replacing earlier unsent suggestions;
  - bills and payments (cash, MoMo, bank, cheque, or supplier credit, oldest first);
  - `returnToSupplier` (stock down, credit at average cost unless given).
- `src/server/inventory.ts`:
  - transfers: send, then receive; differences need a reason; stock is in transit between the two steps;
  - counts: start (snapshot), record (set or add), finish. Expected = snapshot + movements between the start and when the item was counted, so selling can continue. A manager approves above the value limit unless the person can approve. Uncounted items are left alone;
  - `adjustStock` (damage, loss, theft, own use, found, expiry disposal; approval above the limit);
  - `inventoryValuation` (by branch and category, plus in transit);
  - `lowStock`;
  - `labelItems`.
- `src/lib/code128.ts`: Code 128 set B SVG encoder for labels.
- **Screens**: `/app/stock` (low stock, value, transfers, counts, adjustments); `/app/stock/transfers/[id]`; `/app/stock/counts/[id]`; `/app/stock/labels` (printable barcode labels with copies); `/app/purchasing` (orders, suggestions, bills, suppliers, linking items, supplier returns); `/app/purchasing/[poId]` (send, receive, close). Settings has a "Stock controls" section. Home links: Stock, Suppliers and orders.

## Tests

`tests/server/inventory.test.ts` (6).

## Not done / notes

- Serial-tracked items cannot be transferred, counted, adjusted, or returned to a supplier yet (`serial_tracked`). They are still received and sold as before.
- Suggestions run on demand (button); there is no daily job.
- Low-stock alerts are the in-app list plus the existing weekly stock SMS.
- Labels print through the browser; there is no label-printer protocol.
- Differences in a transfer are recorded on it and audited; there is no separate alert to both managers.
