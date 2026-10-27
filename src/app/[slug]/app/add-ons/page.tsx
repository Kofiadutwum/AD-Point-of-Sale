import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { type AddOnGroup, listAddOnGroups, listIngredientItems } from '@/server/add-ons';
import { pageCtx } from '../page-ctx';
import { saveAddOnGroupAction } from './actions';

const BLANK_ROWS = 3;
const cedis = (pesewas: number) => formatCedis(pesewas).replace(/^GHS\s*/, '');

/** Spec 4.24: add-on groups such as Protein (choose 1), Extras (any), and Pepper level, each option with a price and an optional ingredient. */
export default async function AddOnsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_products');
  const [groups, items] = await Promise.all([listAddOnGroups(getDb(), ctx), listIngredientItems(getDb(), ctx)]);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Add-ons</h1>
      <p className="text-sm text-gray-700">Set up a group once, then tick it on each item that offers it. Leave an option&rsquo;s name empty to stop offering it.</p>
      {groups.map((g) => (
        <section key={g.id} className="rounded border p-3">
          <h2 className="font-semibold">{g.name}</h2>
          <GroupForm slug={slug} group={g} items={items} />
        </section>
      ))}
      <section className="rounded border p-3">
        <h2 className="font-semibold">Add a group</h2>
        <GroupForm slug={slug} group={null} items={items} />
      </section>
    </main>
  );
}

function GroupForm({ slug, group: g, items }: { slug: string; group: AddOnGroup | null; items: Array<{ variantId: string; label: string }> }) {
  const rows = [...(g?.options.filter((o) => o.active) ?? []), ...Array.from({ length: BLANK_ROWS }, () => null)].slice(0, 30); // the form saves at most 30 options
  return (
    <ActionForm action={saveAddOnGroupAction.bind(null, slug, g?.id ?? null)} submitLabel={g ? 'Save' : 'Add group'}>
      <Field label="Group name (e.g. Protein)" name="name" maxLength={40} defaultValue={g?.name} />
      <div className="flex gap-3">
        <Field label="Choose at least" name="min" type="number" min={0} max={20} defaultValue={String(g?.minChoices ?? 0)} />
        <Field label="Choose at most" name="max" type="number" min={1} max={20} defaultValue={String(g?.maxChoices ?? 1)} />
      </div>
      <table className="text-sm">
        <thead><tr className="text-left"><th>Option</th><th>Price (GHS)</th><th>Uses ingredient</th><th>Quantity</th></tr></thead>
        <tbody>
          {rows.map((o, i) => (
            <tr key={o?.id ?? `new-${i}`}>
              <td>
                {o && <input type="hidden" name={`id-${i}`} value={o.id} />}
                <input name={`name-${i}`} defaultValue={o?.name} maxLength={40} aria-label={`Option ${i + 1} name`} className="w-36 rounded border px-2 py-1" />
              </td>
              <td><input name={`price-${i}`} inputMode="decimal" defaultValue={o ? cedis(o.pricePesewas) : ''} aria-label={`Option ${i + 1} price`} className="w-20 rounded border px-2 py-1" /></td>
              <td>
                <select name={`ingredient-${i}`} defaultValue={o?.ingredientVariantId ?? ''} aria-label={`Option ${i + 1} ingredient`} className="w-40 rounded border px-2 py-1">
                  <option value="">None</option>
                  {/* an ingredient since archived stays selected, so saving the group never drops it silently */}
                  {o?.ingredientVariantId && !items.some((it) => it.variantId === o.ingredientVariantId) && <option value={o.ingredientVariantId}>(item no longer active)</option>}
                  {items.map((it) => <option key={it.variantId} value={it.variantId}>{it.label}</option>)}
                </select>
              </td>
              <td><input name={`quantity-${i}`} inputMode="decimal" defaultValue={o?.ingredientQuantity ? String(Number(o.ingredientQuantity)) : ''} aria-label={`Option ${i + 1} quantity`} className="w-16 rounded border px-2 py-1" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </ActionForm>
  );
}
