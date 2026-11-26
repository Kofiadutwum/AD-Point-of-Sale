import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listMadeItems, listProductionRuns, productionBranches } from '@/server/production';
import { pageCtx } from '../page-ctx';
import { recordAction, saveListAction } from './actions';

const select = 'rounded border border-gray-400 px-3 py-2';

export default async function ProductionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'record_production');
  const [made, branchList, runs] = await Promise.all([listMadeItems(getDb(), ctx), productionBranches(getDb(), ctx), listProductionRuns(getDb(), ctx)]);
  return (
    <main className="flex max-w-2xl flex-col gap-8">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <section className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">Production</h1>
        <p className="text-sm text-gray-700">Record what you made in advance. The ingredients leave stock and the made items join it, costed from the ingredients.</p>
        {made.length === 0 ? <p className="text-sm text-gray-700">No item has a production list yet. Set one below.</p> : (
          <ActionForm action={recordAction.bind(null, slug)} submitLabel="Record production">
            <label className="flex flex-col gap-1 text-sm">Item made
              <select name="variantId" className={select}>{made.map((m) => <option key={m.variantId} value={m.variantId}>{m.name}</option>)}</select>
            </label>
            {branchList.length > 1 ? (
              <label className="flex flex-col gap-1 text-sm">Branch
                <select name="branchId" className={select}>{branchList.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
              </label>
            ) : <input type="hidden" name="branchId" value={branchList[0]?.id ?? ''} />}
            <Field label="How many were made" name="quantity" inputMode="decimal" />
          </ActionForm>
        )}
      </section>

      {ctx.permissions.includes('manage_products') && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">What an item is made from</h2>
          <p className="text-sm text-gray-700">For one of the item, in each ingredient&apos;s base unit (for example 0.5 kg of flour). Saving replaces the list.</p>
          <ActionForm action={saveListAction.bind(null, slug)} submitLabel="Save production list">
            <Field label="Made item: barcode or SKU" name="made" maxLength={60} />
            {[0, 1, 2, 3, 4, 5].map((k) => (
              <div key={k} className="flex flex-wrap items-end gap-2">
                <Field label={`Ingredient ${k + 1}: barcode or SKU`} name={`code_${k}`} required={false} maxLength={60} />
                <Field label="Quantity" name={`qty_${k}`} inputMode="decimal" required={false} />
              </div>
            ))}
          </ActionForm>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Recently made</h2>
        {runs.length === 0 ? <p className="text-sm text-gray-700">Nothing recorded yet.</p> : (
          <ul className="text-sm">{runs.map((r) => (
            <li key={r.id}>{r.at.toISOString().slice(0, 16).replace('T', ' ')}: {Number(r.quantity)} × {r.name} at {formatCedis(Math.round(Number(r.unitCost)))} each, by {r.by}</li>
          ))}</ul>
        )}
      </section>
    </main>
  );
}
