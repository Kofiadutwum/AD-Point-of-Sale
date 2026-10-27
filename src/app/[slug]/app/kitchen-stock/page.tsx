import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { kitchenBranches } from '@/server/kitchen';
import { getTodayPots } from '@/server/pots';
import { listWastableItems } from '@/server/wastage';
import { pageCtx } from '../page-ctx';
import { addPotsAction, closePotAction, wastageAction } from './actions';

const LEFTOVERS = [['0', 'None'], ['0.25', '¼ pot'], ['0.5', '½ pot'], ['0.75', '¾ pot']] as const;

/** Spec 6.54, 4.24: pots cooked of each sell-by-amount item, the closing count with its check, and wastage or staff meals. */
export default async function KitchenStockPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ branch?: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'record_kitchen_stock');
  const branchList = await kitchenBranches(getDb(), ctx, 'record_kitchen_stock');
  const wanted = (await searchParams).branch;
  const branch = branchList.find((b) => b.id === wanted) ?? branchList[0];
  if (!branch) return <main><p>You are not set up at any branch. Ask a manager.</p></main>;
  const [today, wastable] = await Promise.all([getTodayPots(getDb(), ctx, branch.id, new Date()), listWastableItems(getDb(), ctx)]);
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Kitchen stock · {branch.name} · {today.businessDate}</h1>
      {branchList.length > 1 && (
        <nav aria-label="Branches" className="flex gap-2 text-sm">
          {branchList.map((b) => <a key={b.id} href={`?branch=${b.id}`} aria-current={b.id === branch.id ? 'page' : undefined} className="rounded border px-3 py-1">{b.name}</a>)}
        </nav>
      )}
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Pots</h2>
        {today.items.length === 0 && <p className="text-sm text-gray-700">No sell-by-amount items yet. Turn on &ldquo;Sell by amount&rdquo; on an item to count its pots.</p>}
        {today.items.map(({ variantId, name, pot }) => (
          <div key={variantId} className="flex flex-col gap-2 rounded border p-3">
            <p className="font-medium">
              {name}: {pot ? `${Number(pot.cooked)} ${Number(pot.cooked) === 1 ? 'pot' : 'pots'} cooked` : 'no pots yet'}{pot && Number(pot.carriedIn) > 0 ? ` (${Number(pot.carriedIn)} from yesterday)` : ''}
            </p>
            {pot?.closed ? (
              <p className={`text-sm ${pot.flagged ? 'text-red-700' : ''}`}>
                Left {Number(pot.leftover)} pot. Sold {formatCedis(pot.actualPesewas ?? 0)}
                {pot.expectedPesewas !== null && `, expected ${formatCedis(pot.expectedPesewas)} (${(pot.variancePesewas ?? 0) > 0 ? '+' : ''}${Math.round(((pot.variancePesewas ?? 0) * 100) / Math.max(pot.expectedPesewas, 1))}%)`}
                {pot.flagged && '. Above the limit: your manager sees it on the dashboard.'}
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <ActionForm action={addPotsAction.bind(null, slug, branch.id, variantId)} submitLabel="Add pots">
                  <Field label="Pots cooked" name="pots" inputMode="decimal" defaultValue="1" />
                </ActionForm>
                {pot && (
                  <ActionForm action={closePotAction.bind(null, slug, branch.id, variantId)} submitLabel="Record leftover">
                    <fieldset className="flex flex-wrap gap-2 text-sm">
                      <legend className="mb-1">Left at closing</legend>
                      {LEFTOVERS.map(([v, label]) => (
                        <label key={v} className="flex items-center gap-1"><input type="radio" name="leftover" value={v} defaultChecked={v === '0'} /> {label}</label>
                      ))}
                    </fieldset>
                    <Field label="Or type the pots left" name="leftoverOther" inputMode="decimal" required={false} />
                  </ActionForm>
                )}
              </div>
            )}
          </div>
        ))}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Wastage and staff meals</h2>
        <ActionForm action={wastageAction.bind(null, slug, branch.id)} submitLabel="Record">
          <label className="flex flex-col gap-1 text-sm">Item
            <select name="variantId" required className="rounded border border-gray-400 px-3 py-2">
              <option value="">Pick an item</option>
              {wastable.map((i) => <option key={i.variantId} value={i.variantId}>{i.label}</option>)}
            </select>
          </label>
          <Field label="Quantity" name="quantity" inputMode="decimal" defaultValue="1" />
          <label className="flex flex-col gap-1 text-sm">Reason
            <select name="reason" className="rounded border border-gray-400 px-3 py-2">
              <option value="spoiled">Spoiled</option><option value="dropped">Dropped</option><option value="staff_meal">Staff meal</option>
            </select>
          </label>
          <Field label="Note" name="note" required={false} maxLength={200} />
        </ActionForm>
      </section>
    </main>
  );
}
