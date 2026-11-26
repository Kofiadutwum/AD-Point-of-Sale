# Phase 1b-10 hand-over: production (items made in advance)

## Migrations
- `0031_production`: tables `production_ingredients` and `production_runs`; movement type `produced`; movement reference `production`.
- `0032_production_rls`: tenant isolation; `record_production` given to owners and managers.
- Local dev: stop the dev server, then `npm run db:migrate`.

## How it works
- **Production lists** (`saveProductionList`, `manage_products`): what one base unit of a made item uses, in each ingredient's base unit. Kept apart from bundle and recipe `components`, so selling is unchanged. A made item cannot use itself, directly or through another made item's list. Only plain stock items (no batch or serial tracking) can be made ahead for now (`not_supported`).
- **Recording** (`recordProduction`, `record_production`, usable by PIN on the till): the run's unit cost is the sum of each ingredient's quantity × its current cost (`costOf`, so a recipe or bundle ingredient is costed from its parts). Ingredients go down through `deductRecipe` (`used_in_production`, reference `production`); the made item goes up with a `produced` movement at that unit cost; its average cost is re-weighted shop-wide as receiving does. Stock may go negative; the result says so. Audit `production_recorded`, `production_list_saved`.
- **Screen** `/app/production` (home link "Production"): record a run (item, branch when more than one, quantity); set a production list by barcode or SKU; recently made.

## Checked
- 4 production tests; type check and build green; stock, pot, and deduction suites pass.
- Browser: the production page renders on the demo shop (the seed has only one SKU, so a list was not set there).

## Not done
- Batch- and serial-tracked made items; editing a list by picking items rather than typing codes; production on the till's selling screen.
