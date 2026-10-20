import { Check, Field } from '@/components/form';
import type { Module } from '@/lib/permissions';
import type { TaxRule } from '@/server/tax-rules';

const select = 'rounded border border-gray-400 px-3 py-2';

type Defaults = {
  name?: string; description?: string | null; categoryId?: string | null; brand?: string | null; taxRuleId?: string | null;
  tracking?: string; showOnStorefront?: boolean; featured?: boolean; genericName?: string | null; strength?: string | null;
  dosageForm?: string | null; registrationNumber?: string | null; prescriptionOnly?: boolean;
};

/** Product-level inputs shared by the new-product and edit forms. Module-specific fields show only when the module is on. */
export function ProductFieldsInputs({ product = {}, categories, taxRules, modules }: {
  product?: Defaults; categories: Array<{ id: string; name: string }>; taxRules: TaxRule[]; modules: Module[];
}) {
  const tracking = product.tracking ?? 'none';
  return (
    <>
      <Field label="Name" name="name" defaultValue={product.name} />
      <label className="flex flex-col gap-1 text-sm">Category
        <select name="categoryId" defaultValue={product.categoryId ?? ''} className={select}>
          <option value="">None</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <Field label="Brand" name="brand" defaultValue={product.brand ?? ''} required={false} />
      <label className="flex flex-col gap-1 text-sm">Tax
        <select name="taxRuleId" defaultValue={product.taxRuleId ?? ''} className={select}>
          <option value="">Shop default</option>
          {taxRules.filter((r) => r.active || r.id === product.taxRuleId).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">Tracking
        <select name="tracking" defaultValue={tracking} className={select}>
          <option value="none">None</option>
          {(modules.includes('batches') || tracking === 'batch') && <option value="batch">Batch and expiry</option>}
          {(modules.includes('serials') || tracking === 'serial') && <option value="serial">Serial or IMEI number</option>}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">Description
        <textarea name="description" defaultValue={product.description ?? ''} rows={2} className="rounded border border-gray-400 px-3 py-2" />
      </label>
      {modules.includes('prescriptions') && (
        <fieldset className="flex flex-col gap-2 rounded border p-3">
          <legend className="text-sm font-medium">Pharmacy</legend>
          <Field label="Generic name" name="genericName" defaultValue={product.genericName ?? ''} required={false} />
          <Field label="Strength (e.g. 500 mg)" name="strength" defaultValue={product.strength ?? ''} required={false} />
          <Field label="Dosage form (e.g. tablet)" name="dosageForm" defaultValue={product.dosageForm ?? ''} required={false} />
          <Field label="Registration number" name="registrationNumber" defaultValue={product.registrationNumber ?? ''} required={false} />
          <Check name="prescriptionOnly" label="Prescription only" defaultChecked={product.prescriptionOnly ?? false} />
        </fieldset>
      )}
      <Check name="showOnStorefront" label="Show on storefront" defaultChecked={product.showOnStorefront ?? false} />
      <Check name="featured" label="Featured on storefront" defaultChecked={product.featured ?? false} />
    </>
  );
}
