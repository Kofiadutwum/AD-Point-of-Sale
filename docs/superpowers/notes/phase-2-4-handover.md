# Phase 2-4 hand-over: report and data exports

Spec 4.7 (export reports), 4.29 (export), 6.46.

## What was built

- `src/server/data-export.ts`: `exportData(db, ctx, dataset, { from, to })` returns CSV and a file name. Datasets: products, customers, stock (on hand and value by branch), sales (one row per item sold), payments, ledger (customer account entries), expenses, accounting (per day: sales, discounts, tax, each payment method, refunds, expenses). Dated datasets need a range of at most 366 days. Amounts are in cedis. Cells that could run as formulas are neutralised by `toCsv`. Needs `export_data`; works during read-only expiry. Every export writes a `data_exported` audit entry. Prescriptions are never exported.
- `/[slug]/app/export` page (one download form per dataset) and `/[slug]/app/export/download` route (sign-in required, `no-store`). Home link "Export data".
- The food report already had its own CSV download (1b).

## Tests

`tests/server/data-export.test.ts` (2).

## Not done / notes

- Downloads are built on request, not in the background with a 24-hour link as 6.46 suggests; fine at current shop sizes.
- Ledger, expenses, and refunds are dated in UTC (Ghana time); revisit if shops outside GMT join.
- Account closure (6.46) is not built.
