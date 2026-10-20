import { ActionForm, Check, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { listCategories } from '@/server/products';
import { getSellingSettings } from '@/server/shop-settings';
import { listTaxRules } from '@/server/tax-rules';
import { pageCtx } from '../../page-ctx';
import { ProductFieldsInputs } from '../product-fields';
import { createProductAction } from './actions';

const UNITS = ['piece', 'kg', 'g', 'litre', 'metre', 'yard', 'pack'];
const PHARMACY_UNITS = ['tablet', 'strip', 'bottle'];

export default async function NewProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_products');
  const [cats, rules, selling] = await Promise.all([listCategories(getDb(), ctx), listTaxRules(getDb(), ctx), getSellingSettings(getDb(), ctx)]);
  const units = selling.modules.includes('units') ? [...UNITS, ...PHARMACY_UNITS] : UNITS;
  return (
    <main className="flex max-w-md flex-col gap-6">
      <a href={`/${slug}/app/products`} className="text-sm text-blue-800 underline">← Products</a>
      <h1 className="text-2xl font-semibold">Add product</h1>
      <ActionForm action={createProductAction.bind(null, slug)} submitLabel="Add product">
        <ProductFieldsInputs categories={cats} taxRules={rules} modules={selling.modules} />
        <label className="flex flex-col gap-1 text-sm">Kind
          <select name="kind" defaultValue="standard" className="rounded border border-gray-400 px-3 py-2">
            <option value="standard">Standard item</option>
            <option value="bundle">Bundle (sells its parts)</option>
            {selling.modules.includes('recipes') && <option value="recipe">Recipe (uses ingredients)</option>}
          </select>
        </label>
        <Field label="Base unit (smallest unit sold)" name="baseUnit" defaultValue="piece" list="unit-names" />
        <datalist id="unit-names">{units.map((u) => <option key={u} value={u} />)}</datalist>
        <Check name="allowsFractions" label="Sold in fractions (e.g. 1.250 kg)" />
        <Field label="Selling price (GHS)" name="price" inputMode="decimal" />
        <Field label="Cost price per base unit (GHS)" name="cost" inputMode="decimal" defaultValue="0" />
        <Field label="SKU" name="sku" required={false} />
        <label className="flex flex-col gap-1 text-sm">Barcodes (one per line; scan into this box)
          <textarea name="barcodes" rows={2} className="rounded border border-gray-400 px-3 py-2" />
        </label>
        <Field label="Reorder level" name="reorderLevel" inputMode="decimal" required={false} />
        {selling.scaleLayout && <Field label="Scale item code" name="scaleItemCode" inputMode="numeric" required={false} />}
      </ActionForm>
    </main>
  );
}
