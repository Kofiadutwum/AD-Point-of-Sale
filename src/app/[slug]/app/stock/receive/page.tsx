import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { listBranches } from '@/server/branches';
import { pageCtx } from '../../page-ctx';
import { receiveAction } from './actions';

/** Spec 6.23: one item per entry; batch items need a batch and expiry, serial items one serial per unit. */
export default async function ReceiveStockPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'receive_stock');
  const branchList = await listBranches(getDb(), ctx);
  return (
    <main className="flex max-w-md flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Receive stock</h1>
      <ActionForm action={receiveAction.bind(null, slug)} submitLabel="Receive">
        <label className="flex flex-col gap-1 text-sm">Branch
          <select name="branchId" className="rounded border border-gray-400 px-3 py-2">
            {branchList.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.branchCode})</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">Kind
          <select name="kind" className="rounded border border-gray-400 px-3 py-2">
            <option value="received">Stock received</option>
            <option value="opening_stock">Opening stock</option>
          </select>
        </label>
        <Field label="Supplier (optional)" name="supplier" required={false} />
        <Field label="Barcode or SKU" name="code" autoFocus />
        <Field label="Quantity (in the unit of that barcode; SKU = base unit)" name="quantity" inputMode="decimal" />
        <Field label="Total cost (GHS)" name="cost" inputMode="decimal" required={false} />
        <Field label="Batch number (batch items)" name="batch" required={false} />
        <Field label="Expiry date (batch items)" name="expiry" type="date" required={false} />
        <label className="flex flex-col gap-1 text-sm">Serial numbers (serial items, one per line)
          <textarea name="serials" rows={3} className="rounded border border-gray-400 px-3 py-2" />
        </label>
      </ActionForm>
    </main>
  );
}
