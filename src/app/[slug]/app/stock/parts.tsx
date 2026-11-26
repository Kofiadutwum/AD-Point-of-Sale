import { Field } from '@/components/form';
import { ROWS } from './form-lines';

export const select = 'rounded border border-gray-400 px-3 py-2';

/** Item rows by barcode or SKU, quantity in that barcode's unit (SKU = base unit), batch for batch items, and optionally a cost. */
export function StockRows({ rows = ROWS.length, cost = false }: { rows?: number; cost?: boolean }) {
  return (
    <>
      {ROWS.slice(0, rows).map((k) => (
        <div key={k} className="flex flex-wrap items-end gap-2">
          <Field label={`Item ${k + 1}: barcode or SKU`} name={`code_${k}`} required={false} maxLength={60} />
          <Field label="Quantity" name={`qty_${k}`} inputMode="decimal" required={false} defaultValue="1" />
          <Field label="Batch (batch items)" name={`batch_${k}`} required={false} maxLength={40} />
          {cost && <Field label="Cost per unit (GHS)" name={`cost_${k}`} inputMode="decimal" required={false} />}
        </div>
      ))}
    </>
  );
}

export function BranchSelect({ name, label, branches }: { name: string; label: string; branches: Array<{ id: string; name: string }> }) {
  return (
    <label className="flex flex-col gap-1 text-sm">{label}
      <select name={name} className={select}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
    </label>
  );
}

/** Manager approval, only needed above the shop's limit for people who cannot approve themselves. */
export function ApproverFields({ approvers }: { approvers: Array<{ id: string; name: string }> }) {
  return (
    <fieldset className="flex flex-col gap-2 rounded border border-gray-300 p-3">
      <legend className="px-1 text-sm">Manager approval (if asked)</legend>
      <select name="approverId" className={select} defaultValue="" aria-label="Approver"><option value="">No approval</option>{approvers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
      <Field label="Manager PIN" name="pin" type="password" inputMode="numeric" autoComplete="off" required={false} />
    </fieldset>
  );
}
