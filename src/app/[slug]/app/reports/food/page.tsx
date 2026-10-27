import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { foodReport } from '@/server/food-reports';
import { kitchenBranches } from '@/server/kitchen';
import { pageCtx } from '../../page-ctx';
import { type ReportSearch, reportInput } from './report-input';

const minutes = (s: number | null) => (s === null ? '—' : `${Math.round(s / 60)} min`);

/** Spec 6.59: orders by hour, best and slowest items, channels after commission, wastage, pots, and kitchen times. */
export default async function FoodReportPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<ReportSearch> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'view_reports', { allowReadOnly: true });
  const input = reportInput(await searchParams);
  const [r, branchList] = await Promise.all([
    foodReport(getDb(), ctx, input, new Date()),
    ctx.permissions.includes('run_kitchen') ? kitchenBranches(getDb(), ctx) : Promise.resolve([]),
  ]);
  const query = new URLSearchParams({ from: input.from, to: input.to, ...(input.branchId ? { branch: input.branchId } : {}), ...(input.serviceMode ? { mode: input.serviceMode } : {}) });
  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Food report</h1>
      <form className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">From<input type="date" name="from" defaultValue={input.from} className="rounded border border-gray-400 px-2 py-1" /></label>
        <label className="flex flex-col gap-1">To<input type="date" name="to" defaultValue={input.to} className="rounded border border-gray-400 px-2 py-1" /></label>
        {branchList.length > 1 && (
          <label className="flex flex-col gap-1">Branch
            <select name="branch" defaultValue={input.branchId ?? ''} className="rounded border border-gray-400 px-2 py-1">
              <option value="">All</option>{branchList.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1">Service
          <select name="mode" defaultValue={input.serviceMode ?? ''} className="rounded border border-gray-400 px-2 py-1">
            <option value="">All</option><option value="counter">Counter</option><option value="quick">Quick serve</option>
          </select>
        </label>
        <button className="rounded bg-blue-800 px-4 py-2 text-white">Show</button>
        {ctx.permissions.includes('export_data') && r.ok && <a href={`/${slug}/app/reports/food/export?${query}`} className="text-blue-800 underline">Download CSV</a>}
      </form>
      {!r.ok ? <p role="alert" className="text-red-700">{r.error === 'range_too_long' ? 'Pick at most 92 days.' : 'Check the dates.'}</p> : (
        <>
          <section>
            <h2 className="text-lg font-semibold">Orders by hour</h2>
            <table className="text-sm"><thead><tr className="text-left"><th>Hour</th><th>Orders</th><th className="text-right">Value</th></tr></thead>
              <tbody>{r.report.byHour.filter((h) => h.orders > 0).map((h) => <tr key={h.hour}><td>{String(h.hour).padStart(2, '0')}:00</td><td>{h.orders}</td><td className="text-right">{formatCedis(h.valuePesewas)}</td></tr>)}</tbody>
            </table>
          </section>
          <div className="grid gap-6 md:grid-cols-2">
            {([['Best sellers', r.report.best], ['Slowest items', r.report.slowest]] as const).map(([title, list]) => (
              <section key={title}>
                <h2 className="text-lg font-semibold">{title}</h2>
                <table className="w-full text-sm"><tbody>{list.map((i) => <tr key={i.variantId}><td>{i.name}</td><td>{Number(i.quantity)}</td><td className="text-right">{formatCedis(i.valuePesewas)}</td></tr>)}</tbody></table>
              </section>
            ))}
          </div>
          <section>
            <h2 className="text-lg font-semibold">Channels</h2>
            <table className="text-sm"><thead><tr className="text-left"><th>Channel</th><th>Orders</th><th className="text-right">Sales</th><th className="text-right">Commission</th><th className="text-right">After commission</th></tr></thead>
              <tbody>{r.report.channels.map((c) => <tr key={c.channelId ?? 'walk-in'}><td>{c.name}</td><td>{c.orders}</td><td className="text-right">{formatCedis(c.salesPesewas)}</td><td className="text-right">{formatCedis(c.commissionPesewas)}</td><td className="text-right">{formatCedis(c.afterCommissionPesewas)}</td></tr>)}</tbody>
            </table>
          </section>
          <section>
            <h2 className="text-lg font-semibold">Wastage</h2>
            {r.report.wastage.length === 0 ? <p className="text-sm">None recorded.</p> : (
              <ul className="text-sm">{r.report.wastage.map((w) => <li key={w.reason}>{w.reason.replace('_', ' ')}: {w.entries} entries, {formatCedis(w.costPesewas)}</li>)}</ul>
            )}
          </section>
          <section>
            <h2 className="text-lg font-semibold">Pots</h2>
            {r.report.pots.length === 0 ? <p className="text-sm">No pots recorded.</p> : (
              <ul className="text-sm">{r.report.pots.map((p) => (
                <li key={`${p.businessDate}-${p.name}`} className={p.flagged ? 'text-red-700' : ''}>
                  {p.businessDate} {p.name}: sold {formatCedis(p.actualPesewas ?? 0)}{p.expectedPesewas !== null ? ` of ${formatCedis(p.expectedPesewas)} expected` : ' (not counted)'}
                </li>
              ))}</ul>
            )}
          </section>
          <p className="text-sm">Average kitchen time {minutes(r.report.avgKitchenSeconds)} · average counter wait {minutes(r.report.avgCounterWaitSeconds)}</p>
        </>
      )}
    </main>
  );
}
