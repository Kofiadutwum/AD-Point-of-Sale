import { ActionForm, Check } from '@/components/form';
import { getDb } from '@/db/client';
import { listBranches } from '@/server/branches';
import { TEMPLATES } from '@/server/csv-import';
import { pageCtx } from '../page-ctx';
import { importAction } from './actions';

const select = 'rounded border border-gray-400 px-3 py-2';
const LABELS = { products: 'Products', customers: 'Customers', opening_stock: 'Opening stock' } as const;
const NOTES = {
  products: 'price and cost in cedis (12.50); allows_fractions and prescription_only: yes or no; tracking: none, batch, or serial.',
  customers: 'phone: a Ghana number (024 400 0001 or 233244000001).',
  opening_stock: 'code: the barcode or SKU; quantity in that unit; total_cost in cedis for the whole line; batch items need batch_number and expiry_date (YYYY-MM-DD).',
} as const;

export default async function ImportPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'import_data');
  const branchList = await listBranches(getDb(), ctx);
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Import from CSV</h1>
      <p className="text-sm text-gray-700">Move from another system or a spreadsheet. Check the file first: every row is checked and nothing is saved until you import.</p>
      <ActionForm action={importAction.bind(null, slug)} submitLabel="Import">
        <label className="flex flex-col gap-1 text-sm">What you are importing
          <select name="kind" className={select} defaultValue="products">
            {(Object.keys(LABELS) as Array<keyof typeof LABELS>).map((k) => <option key={k} value={k}>{LABELS[k]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">CSV file
          <input type="file" name="file" accept=".csv,text/csv" required className="text-sm" />
        </label>
        {branchList.length > 1 ? (
          <label className="flex flex-col gap-1 text-sm">Branch (for opening stock)
            <select name="branchId" className={select}>{branchList.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </label>
        ) : <input type="hidden" name="branchId" value={branchList[0]?.id ?? ''} />}
        <Check name="skip" label="Skip rows with errors (the rest are imported)" />
        <button type="submit" name="step" value="check" className="rounded border border-blue-800 px-4 py-2 text-blue-800">Check file</button>
      </ActionForm>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Templates</h2>
        <p className="text-sm text-gray-700">The first line of the file must be exactly the headers below, in this order.</p>
        {(Object.keys(LABELS) as Array<keyof typeof LABELS>).map((k) => (
          <div key={k} className="flex flex-col gap-1 text-sm">
            <p className="font-semibold">{LABELS[k]}</p>
            <code className="break-all rounded bg-gray-100 px-2 py-1">{TEMPLATES[k].join(',')}</code>
            <p className="text-gray-700">{NOTES[k]}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
