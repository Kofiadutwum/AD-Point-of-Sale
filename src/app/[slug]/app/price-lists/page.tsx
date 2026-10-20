import { ActionForm, Check, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listBranches } from '@/server/branches';
import { listPriceLists } from '@/server/price-lists';
import { itemLabel } from '@/server/products';
import { pageCtx } from '../page-ctx';
import { createPriceListAction, priceCheckAction, removePriceAction, updatePriceListAction } from './actions';

const KIND_LABELS = { retail: 'Retail (default)', wholesale: 'Wholesale', customer_group: 'Customer group', branch: 'Branch' } as const;
const select = 'rounded border border-gray-400 px-3 py-2';

export default async function PriceListsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_products');
  const [lists, branchList] = await Promise.all([listPriceLists(getDb(), ctx), listBranches(getDb(), ctx)]);
  const hasRetail = lists.some((l) => l.kind === 'retail');
  return (
    <main className="flex flex-col gap-8">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Price lists</h1>
      <p className="max-w-xl text-sm text-gray-700">Add prices to a list from each product&apos;s page, under its units. A list that is off or outside its dates is skipped.</p>
      {lists.map((l) => (
        <section key={l.id} className="flex max-w-2xl flex-col gap-3 rounded border p-4">
          <h2 className="font-semibold">
            {l.name} · {KIND_LABELS[l.kind]}{l.branchName ? ` · ${l.branchName}` : ''}
            {(l.startsOn || l.endsOn) && ` · ${l.startsOn ?? '…'} to ${l.endsOn ?? '…'}`}{l.active ? '' : ' · off'}
          </h2>
          <ul className="flex flex-col gap-1 text-sm">
            {l.items.map((i) => (
              <li key={i.id} className="flex items-center gap-2">
                <span className="flex-1">{itemLabel(i.productName, i.variantName)} · {i.unitName} · from {i.minQuantity}: {formatCedis(i.pricePesewas)}</span>
                <ActionForm action={removePriceAction.bind(null, slug, i.id)} submitLabel="Remove"><span /></ActionForm>
              </li>
            ))}
            {l.items.length === 0 && <li className="text-gray-600">No prices yet.</li>}
          </ul>
          <details>
            <summary className="cursor-pointer text-sm text-blue-800">Edit list</summary>
            <ActionForm action={updatePriceListAction.bind(null, slug, l.id)} submitLabel="Save list">
              <Field label="Name" name="name" defaultValue={l.name} />
              {l.kind !== 'retail' && <Field label="Starts on" name="startsOn" type="date" defaultValue={l.startsOn ?? ''} required={false} />}
              {l.kind !== 'retail' && <Field label="Ends on" name="endsOn" type="date" defaultValue={l.endsOn ?? ''} required={false} />}
              <Check name="active" label="Active" defaultChecked={l.active} />
            </ActionForm>
          </details>
        </section>
      ))}
      <section className="max-w-md">
        <h2 className="mb-3 text-lg font-semibold">Create a list</h2>
        <ActionForm action={createPriceListAction.bind(null, slug)} submitLabel="Create list">
          <Field label="Name" name="name" />
          <label className="flex flex-col gap-1 text-sm">Kind
            <select name="kind" defaultValue={hasRetail ? 'wholesale' : 'retail'} className={select}>
              {!hasRetail && <option value="retail">{KIND_LABELS.retail}</option>}
              <option value="wholesale">{KIND_LABELS.wholesale}</option>
              <option value="customer_group">{KIND_LABELS.customer_group}</option>
              <option value="branch">{KIND_LABELS.branch}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">Branch (branch lists only)
            <select name="branchId" className={select}>{branchList.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </label>
          <Field label="Starts on (optional)" name="startsOn" type="date" required={false} />
          <Field label="Ends on (optional)" name="endsOn" type="date" required={false} />
        </ActionForm>
      </section>
      <section className="max-w-md">
        <h2 className="mb-3 text-lg font-semibold">Price check</h2>
        <ActionForm action={priceCheckAction.bind(null, slug)} submitLabel="Check price">
          <Field label="Barcode" name="code" />
          <Field label="Quantity" name="quantity" inputMode="decimal" defaultValue="1" />
          <label className="flex flex-col gap-1 text-sm">Branch
            <select name="branchId" className={select}>{branchList.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </label>
          <label className="flex flex-col gap-1 text-sm">List
            <select name="priceListId" className={select}>
              <option value="">Usual (branch, then Retail)</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        </ActionForm>
      </section>
    </main>
  );
}
