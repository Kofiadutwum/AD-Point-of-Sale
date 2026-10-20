import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listRecentSales } from '@/server/sales';
import { pageCtx } from '../page-ctx';

export default async function SalesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'view_dashboard', { allowReadOnly: true });
  const list = await listRecentSales(getDb(), ctx, { limit: 50 });
  return (
    <main className="flex flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Recent sales</h1>
      <ul className="divide-y rounded border">
        {list.map((s) => (
          <li key={s.id}>
            <a href={`/${slug}/app/receipts/${s.id}?reprint=1`} className="flex justify-between gap-3 p-3 hover:bg-gray-50">
              <span>{s.receiptNumber} · {s.cashierName}{s.status === 'pending' ? ' · pending' : ''}{s.needsReview ? ' · needs review' : ''}</span>
              <span>{formatCedis(s.totalPesewas)}</span>
            </a>
          </li>
        ))}
        {list.length === 0 && <li className="p-3 text-sm text-gray-600">No sales yet.</li>}
      </ul>
    </main>
  );
}
