import { todayIn } from '@/lib/dates';
import { DATASET_LABELS, DATASETS, isDated } from '@/server/data-export';
import { pageCtx } from '../page-ctx';

const input = 'rounded border border-gray-400 px-3 py-2';

/** Spec 4.29: download products, customers, sales, stock, ledgers, and an accounting summary as CSV. */
export default async function ExportPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await pageCtx(slug, 'export_data');
  const to = todayIn('Africa/Accra', new Date());
  const from = `${to.slice(0, 8)}01`;
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Export data</h1>
      <p className="text-sm text-gray-700">Each download is a CSV file that opens in Excel, Google Sheets, or accounting software. Amounts are in cedis. Every download is recorded in the audit log.</p>
      <ul className="flex flex-col gap-4">
        {DATASETS.map((d) => (
          <li key={d}>
            <form method="get" action={`/${slug}/app/export/download`} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="dataset" value={d} />
              <span className="w-56 font-medium">{DATASET_LABELS[d]}</span>
              {isDated(d) && (
                <>
                  <label className="flex flex-col text-sm">From<input type="date" name="from" defaultValue={from} required className={input} /></label>
                  <label className="flex flex-col text-sm">To<input type="date" name="to" defaultValue={to} required className={input} /></label>
                </>
              )}
              <button type="submit" className="rounded bg-blue-800 px-4 py-2 text-white">Download</button>
            </form>
          </li>
        ))}
      </ul>
    </main>
  );
}
