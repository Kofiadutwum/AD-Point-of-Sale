import { ActionForm } from '@/components/form';
import { getDb } from '@/db/client';
import type { KitchenStation } from '@/db/schema';
import { KITCHEN_STATIONS } from '@/lib/food';
import { listStationLines } from '@/server/kitchen-display';
import { kitchenBranches } from '@/server/kitchen';
import { pageCtx } from '../../page-ctx';
import { lineReadyAction } from '../actions';
import { AutoRefresh } from '../auto-refresh';

const NAMES = { kitchen: 'Kitchen', bar: 'Bar', grill: 'Grill' } as const;
// waiting time colours: green under 10 minutes, amber under 20, red after
const colour = (minutes: number) => (minutes < 10 ? 'border-green-600' : minutes < 20 ? 'border-amber-500' : 'border-red-600');

/** Spec 6.37: one station's table orders, oldest first, coloured by waiting time; staff tap Ready per item. */
export default async function StationPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ station?: string; branch?: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'run_kitchen');
  const search = await searchParams;
  const station: KitchenStation = KITCHEN_STATIONS.find((s) => s === search.station) ?? 'kitchen';
  const branchList = await kitchenBranches(getDb(), ctx);
  const branch = branchList.find((b) => b.id === search.branch) ?? branchList[0];
  if (!branch) return <main><p>You are not set up at any branch. Ask a manager.</p></main>;
  const now = new Date();
  const tickets = await listStationLines(getDb(), ctx, branch.id, station);
  return (
    <main className="flex flex-col gap-4">
      <AutoRefresh ms={10_000} />
      <a href={`/${slug}/app/kitchen`} className="text-sm text-blue-800 underline">← Counter orders</a>
      <h1 className="text-2xl font-semibold">{NAMES[station]} · {branch.name}</h1>
      <nav aria-label="Stations" className="flex gap-2 text-sm">
        {KITCHEN_STATIONS.map((s) => (
          <a key={s} href={`?station=${s}&branch=${branch.id}`} aria-current={s === station ? 'page' : undefined} className={`rounded border px-3 py-1 ${s === station ? 'bg-gray-900 text-white' : ''}`}>{NAMES[s]}</a>
        ))}
      </nav>
      {tickets.length === 0 && <p className="text-sm text-gray-600">Nothing waiting.</p>}
      <ul className="grid gap-3 md:grid-cols-2">
        {tickets.map((tk) => {
          const waited = Math.max(0, Math.round((now.getTime() - tk.oldestSentAt.getTime()) / 60_000));
          return (
            <li key={tk.ticketId} className={`rounded border-4 p-3 ${colour(waited)}`}>
              <p className="flex items-baseline justify-between"><span className="text-xl font-bold">{tk.label}</span><span className="text-sm">{tk.waiterName} · {waited} min</span></p>
              <ul className="mt-2 flex flex-col gap-2">
                {tk.lines.map((l) => (
                  <li key={l.lineId} className="flex items-start justify-between gap-2">
                    <span>
                      {Number(l.quantity)} × {l.name}
                      {l.addOns.length > 0 && <span className="block pl-3 text-xs">+ {l.addOns.join(', ')}</span>}
                      {l.note && <span className="block pl-3 text-xs font-bold">{l.note}</span>}
                    </span>
                    <ActionForm action={lineReadyAction.bind(null, slug, l.lineId)} submitLabel="Ready">{null}</ActionForm>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
