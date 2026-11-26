# Phase 1b-9: Pharmacy Controls (prescriptions, OTC-only, expiry reports)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A prescription-only medicine is sold only with a prescription record and by (or with the approval of) someone who may dispense; a chemical seller can be limited to over-the-counter medicines; the shop sees near-expiry stock, expired stock value, and a log of prescription sales.

**Spec:** 4.17, 4.23, 6.36. Launch scope (decided 2026-10-26): basic rules, no reporting to regulators.

## Global constraints
- **Permission** `dispense_prescription` (owner and manager presets; usable by PIN on the till). Pharmacist preset waits for later phases; owners can tick it for any staff member.
- **Prescription record** per sale line of a `prescription_only` product: patient name, prescriber name, facility, prescription date (not in the future, not older than 1 year). Table `prescriptions` (sale, sale line, fields, `recorded_by`, `approved_by`). Health data: readable only with `dispense_prescription`; never on receipts, SMS, or the storefront. Photo of the prescription: later.
- **Who may sell:** the cashier holds `dispense_prescription`, or the sale carries `prescriptionApproval: { approverId, pin }` for another active user at the branch who holds it (checked with `verifyStaffPin`, so the till lockout applies; self-approval refused).
- **Offline:** the till refuses to finish a prescription sale offline unless the signed-in person holds the permission (a PIN is never stored in the outbox). An outbox sale missing a record or permission is kept and flagged for review (`prescription_missing`, `prescription_unapproved`).
- **OTC only:** `tenants.otc_only` (off). When on, a prescription-only line is refused (`otc_only`); in an outbox sale it is flagged.
- **Expiry reports:** `tenants.expiry_warning_days` (default 90, 1–365). Near-expiry = batches with stock expiring after today and within the warning days; expired = batches with stock expiring on or before today; values at the variant's current cost. By branch.
- **Audit:** `prescription_recorded` (no patient details in the audit log).

## Tasks
1. **Schema and permission:** migration (table, RLS, tenant settings, permission backfill for owners and managers); permission lists and labels; exact-list tests updated. Commit `feat(pharmacy): prescription schema and permission`.
2. **Sales:** `SaleInput.lines[].prescription`, `SaleInput.prescriptionApproval`; checks in `completeSaleTx`; records saved. Tests: `a prescription-only line needs a record`, `a cashier needs a pharmacist's PIN`, `OTC-only shops refuse prescription-only medicine`, `an offline sale missing a record is kept for review`. Commit `feat(pharmacy): prescription records on sales`.
3. **Tills:** device cache carries `prescriptionOnly` and the shop's `otcOnly`; both selling screens ask for the record (and a pharmacist and PIN when needed) for prescription-only items; offline rule above. Commit `feat(pharmacy): prescriptions at the till`.
4. **Reports and settings:** `pharmacyReport` (near-expiry, expired value, prescription log for `dispense_prescription`); page `/app/reports/pharmacy`; shop settings for warning days and OTC only. Tests: `near-expiry and expired stock with values`, `the prescription log needs the dispensing permission`. Commit `feat(pharmacy): expiry and prescription reports`.
5. **Verify and hand over:** full suite, build, browser check, hand-over, merge.
