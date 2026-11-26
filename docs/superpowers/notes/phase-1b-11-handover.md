# Phase 1b-11 hand-over: CSV import

Spec 6.45. Opening customer balances wait for credit sales (Phase 2); everything else in 6.45 is here.

## Migration
- `0033_import_permission`: `import_data` given to owners and managers (not usable by PIN on the till).

## How it works
- **Parser** `src/lib/csv-parse.ts`: RFC 4180 (quoted fields, doubled quotes, CRLF or LF, byte-order mark, blank lines dropped).
- **Templates** (`TEMPLATES` in `src/server/csv-import.ts`), headers must match exactly and in order:
  - products: `name,sku,barcode,price,cost,unit,allows_fractions,tracking,generic_name,prescription_only`
  - customers: `name,phone`
  - opening stock: `code,quantity,total_cost,batch_number,expiry_date`
- **Check** (`checkImport`): every row is validated; products and customers are really imported inside a transaction that is then rolled back, so shop-level problems (SKU or barcode already used, plan limit, phone already a customer) show with their line numbers. Returns the errors and a preview of the first 20 rows.
- **Import** (`runImport`): products and customers in one transaction; any failing row stops it unless "Skip rows with errors" is ticked. Opening stock is one stock receipt (`receiveStock`, kind `opening_stock`), which saves all its lines or none; serial items are refused (they are received one serial at a time). Audit `import`.
- `createProduct` now has a transaction core, `createProductTx`, used by the import.
- **Screen** `/app/import` (home link "Import from CSV"): what you are importing, the file, branch for opening stock, "Check file" and "Import", and the templates with notes.
- Limits: 5 MB and 10,000 rows (spec). Shortcut: Vercel functions accept at most 4.5 MB per request, so very large files need splitting there.

## Checked
- CSV parser test and 5 import tests; type check and build green.
- Browser: the import page renders. A file upload was not completed in the browser.

## Not done
- Opening customer balances (needs the credit ledger, Phase 2).
- A downloadable template file (the headers are shown on the page to copy).
