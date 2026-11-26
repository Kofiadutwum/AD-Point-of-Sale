# Phase 1b-9 hand-over: pharmacy controls

## Migrations
- `0029_prescriptions`: table `prescriptions`; `tenants.otc_only` (off) and `tenants.expiry_warning_days` (90, 1–365).
- `0030_prescriptions_rls`: tenant isolation; `dispense_prescription` given to owners and managers.
- Local dev: stop the dev server, then `npm run db:migrate`.

## How it works
- **Permission** `dispense_prescription` (owner and manager presets, usable by PIN on the till).
- **Sales (`completeSaleTx`):** a line whose product is `prescription_only` needs `lines[].prescription` (patient, prescriber, facility, date within the last year), else `prescription_required`. The seller must hold `dispense_prescription`, or the sale carries `prescriptionApprovalToken` from `requestApproval` with action `dispense_prescription` and context = the sale id; the approver must hold `dispense_prescription` (other approvals still need `approve_actions`). The PIN is checked in its own transaction, so a refused sale never undoes the wrong-PIN lockout. OTC-only shops refuse with `otc_only`. Offline outbox sales are kept and flagged (`prescription_missing`, `prescription_unapproved`, `otc_only`). Records are saved per line with `recorded_by` and `approved_by`; audit `prescription_recorded` holds no patient details.
- **Tills:** the device cache carries `products[].prescriptionOnly`; both selling screens show a prescription form for prescription-only items, plus a pharmacist and PIN when the cashier cannot dispense. The offline till gets approval online through `POST /api/[slug]/approvals`; offline it refuses unless the signed-in person may dispense (no PIN is ever stored in the outbox).
- **Reports (`pharmacy-reports.ts`, `/app/reports/pharmacy`):** near-expiry (after today, within the warning days) and expired batches with stock, valued at average cost; the prescription-only sales log shows only to people who may dispense.
- **Settings:** "Pharmacy" section (OTC only, warning days).

## Checked
- Type check and build green; prescription, report, settings, device, and sale suites pass.
- Browser: the pharmacy report and its home link render on the demo shop.

## Not done
- Prescription photo (private storage) and a Pharmacist role preset.
- The selling screens' prescription forms were not walked through in the browser (the demo shop is a food shop with no medicines).
- The local dev database failed to open again after the dev server was stopped; it was moved to `.data/pglite-broken-2026-11-26b` and reseeded. Stopping the dev server abruptly seems to damage PGlite files; delete the old folders when no longer needed.
