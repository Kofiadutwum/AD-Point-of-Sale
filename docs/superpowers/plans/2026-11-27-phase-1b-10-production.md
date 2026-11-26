# Phase 1b-10: Production (items made in advance)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A shop that makes items ahead (bread, meat pies, bottled drinks, chopped salads) records each batch made: the ingredients leave stock, the made item enters stock, and its average cost follows what the ingredients cost.

**Spec:** 6.27 (and 6.23 for the weighted average cost).

## Global constraints
- **Made items** are standard (stock-holding) variants with a production list in a new table `production_ingredients` (made variant, ingredient variant, quantity per one made base unit). Bundles, recipes, and combos keep their own `components`; nothing about selling changes. A made item cannot list itself, directly or through another made item's list (a recipe or bundle ingredient gives its own components, as `deductRecipe` already does).
- **Recording** (`record_production`, owner and manager presets, usable by PIN on the till): `production_runs` row (branch, variant, quantity, unit cost, user). Ingredients go down with movement `used_in_production` (reference `production`); the made item goes up with movement `produced` and the run's unit cost; the made variant's average cost is re-weighted as stock receiving does. Stock may go negative (like pots); the run reports it.
- **Shortcut:** batch- and serial-tracked made items are refused (`not_supported`) until batch production is needed.
- **Audit:** `production_recorded`, `production_list_saved`.

## Tasks
1. Schema and permission (tables, RLS, movement type `produced`, reference `production`, permission backfill) and exact-list tests. Commit `feat(production): schema and permission`.
2. Service `production.ts`: `saveProductionList`, `getProductionList`, `listMadeItems`, `recordProduction`. Tests: `ingredients go down and the made item goes up`, `the made item's cost follows its ingredients`, `a production list cannot contain itself`, `batch items are not supported yet`. Commit `feat(production): record production`.
3. Screen `/app/production` (list per item with SKU and quantity rows; record form; recent runs) and home link. Commit `feat(production): production screen`.
4. Verify, hand over, merge.
