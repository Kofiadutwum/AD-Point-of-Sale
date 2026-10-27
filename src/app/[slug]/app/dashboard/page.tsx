import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { getDashboard } from '@/server/dashboard';
import { TENDER_LABELS } from '@/server/receipts';
import { pageCtx } from '../page-ctx';

export default async function DashboardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'view_dashboard', { allowReadOnly: true });
  const d = await getDashboard(getDb(), ctx, new Date());
  const tiles = [
    ['Sales today', formatCedis(d.totalPesewas)], ['Transactions', String(d.salesCount)], ['Average sale', formatCedis(d.averagePesewas)],
    ['Net sales', formatCedis(d.netPesewas)], ['Discounts', formatCedis(d.discountPesewas)], ['Tax', formatCedis(d.taxPesewas)],
  ];
  return (
    <main className="flex flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Dashboard · {d.businessDate}</h1>
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded border p-3"><p className="text-sm text-gray-600">{label}</p><p className="text-xl font-semibold">{value}</p></div>
        ))}
      </section>
      {d.needsReview > 0 && <p role="status" className="rounded bg-amber-100 p-3 text-sm">{d.needsReview} synced sale(s) need review. <a className="underline" href={`/${slug}/app/sales`}>See sales</a></p>}
      <section>
        <h2 className="mb-2 font-semibold">Payments</h2>
        <ul className="text-sm">{d.payments.length === 0 ? <li>No payments yet today.</li> : d.payments.map((p) => <li key={p.method}>{TENDER_LABELS[p.method]}: {formatCedis(p.amountPesewas)}</li>)}</ul>
      </section>
      {(d.potReminders.length > 0 || d.potVariances.length > 0) && (
        <section>
          <h2 className="mb-2 font-semibold">Pots</h2>
          <ul className="text-sm">
            {d.potReminders.map((r) => <li key={r.name + r.businessDate}>{r.name}: count the leftover for {r.businessDate}</li>)}
            {d.potVariances.map((v) => (
              <li key={v.name + v.businessDate} className="text-red-700">
                {v.name} ({v.businessDate}): sold {formatCedis(v.actualPesewas)}, expected {formatCedis(v.expectedPesewas)} ({v.variancePesewas > 0 ? '+' : ''}{Math.round((v.variancePesewas * 100) / v.expectedPesewas)}%)
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h2 className="mb-2 font-semibold">Negative stock</h2>
        <ul className="text-sm">{d.negativeStock.length === 0 ? <li>None.</li> : d.negativeStock.map((s) => <li key={s.variantId + s.branchName} className="text-red-700">{s.name} · {s.branchName}: {s.onHand}</li>)}</ul>
      </section>
      <section>
        <h2 className="mb-2 font-semibold">Low stock</h2>
        <ul className="text-sm">{d.lowStock.length === 0 ? <li>None.</li> : d.lowStock.map((s) => <li key={s.variantId + s.branchName}>{s.name} · {s.branchName}: {s.onHand} (reorder at {s.reorderLevel})</li>)}</ul>
      </section>
    </main>
  );
}
