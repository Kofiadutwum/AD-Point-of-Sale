import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { AccessError } from '@/server/context';
import { supportView } from '@/server/support';
import { adminCtx, adminToken } from '../../../../admin-ctx';

/** Spec 6.47: read-only view of a shop inside a support session; opening it writes to the shop's audit log. */
export default async function SupportViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await adminCtx();
  const v = await supportView(getDb(), await adminToken(), id, new Date()).catch((e) => {
    if (e instanceof AccessError) return null;
    throw e;
  });
  if (!v) notFound();
  return (
    <main className="flex flex-col gap-6">
      <a href={`/admin/shops/${id}`} className="text-sm text-blue-800 underline">← Shop</a>
      <section>
        <h1 className="text-2xl font-semibold">{v.shop.name} (support view)</h1>
        <p className="text-sm text-gray-700">/{v.shop.slug} · {v.shop.shopType} · {v.shop.status} · {v.emergency ? 'emergency access' : 'granted by the owner'} until {v.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
        <p className="text-sm text-gray-700">The owner sees each time you open this page.</p>
      </section>
      <ul className="text-sm">
        <li>Products: {v.counts.products}</li><li>Customers: {v.counts.customers}</li><li>Staff: {v.counts.staff}</li>
        <li>Sales today: {v.counts.salesToday} ({formatCedis(v.counts.salesTodayPesewas)})</li><li>Sales needing review: {v.counts.needReview}</li>
      </ul>
      <section>
        <h2 className="text-lg font-semibold">Latest sales</h2>
        <table className="text-sm">
          <thead><tr className="text-left"><th>Receipt</th><th>Date</th><th>Total</th><th>Status</th></tr></thead>
          <tbody>{v.recentSales.map((s) => (
            <tr key={s.receiptNumber}><td>{s.receiptNumber}</td><td>{s.businessDate}</td><td>{formatCedis(s.totalPesewas)}</td><td>{s.status}{s.needsReview ? ', needs review' : ''}</td></tr>
          ))}</tbody>
        </table>
      </section>
    </main>
  );
}
