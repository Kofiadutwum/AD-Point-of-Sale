import { Field } from '@/components/form';

/** Rows of items by barcode or SKU, with quantity and an optional discount for the line. */
export function ItemRows({ rows = 6, discounts = false }: { rows?: number; discounts?: boolean }) {
  return (
    <>
      <Field label="Customer phone (optional for quotes)" name="phone" type="tel" required={false} />
      {Array.from({ length: rows }, (_, k) => (
        <div key={k} className="flex flex-wrap items-end gap-2">
          <Field label={`Item ${k + 1}: barcode or SKU`} name={`code_${k}`} required={false} maxLength={60} />
          <Field label="Quantity" name={`qty_${k}`} inputMode="decimal" required={false} defaultValue="1" />
          {discounts && <Field label="Discount (GHS)" name={`disc_${k}`} inputMode="decimal" required={false} />}
        </div>
      ))}
    </>
  );
}
