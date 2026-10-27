import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { type KitchenOrderView, kitchenBranches, listKitchenOrders } from '@/server/kitchen';
import { pageCtx } from '../page-ctx';
import { handOverAction, packAction, readyAction } from './actions';
import { AutoRefresh } from './auto-refresh';

const DINING = { eat_in: 'Eat in', takeaway: 'Takeaway', delivery: 'Delivery' } as const;

/** Spec 6.51, 6.58: orders being prepared and ready, with the packing check for takeaway and delivery. */
export default async function KitchenPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ branch?: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'run_kitchen');
  const branchList = await kitchenBranches(getDb(), ctx);
  const wanted = (await searchParams).branch;
  const branch = branchList.find((b) => b.id === wanted) ?? branchList[0];
  if (!branch) return <main><p>You are not set up at any branch. Ask a manager.</p></main>;
  const now = new Date();
  const r = await listKitchenOrders(getDb(), ctx, branch.id, now);
  const orders = r.ok ? r.orders : [];
  return (
    <main className="flex flex-col gap-4">
      <AutoRefresh ms={10_000} />
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Kitchen · {branch.name}</h1>
      {branchList.length > 1 && (
        <nav aria-label="Branches" className="flex gap-2 text-sm">
          {branchList.map((b) => <a key={b.id} href={`?branch=${b.id}`} aria-current={b.id === branch.id ? 'page' : undefined} className="rounded border px-3 py-1">{b.name}</a>)}
        </nav>
      )}
      <div className="grid gap-6 md:grid-cols-2">
        {(['preparing', 'ready'] as const).map((status) => (
          <section key={status} aria-labelledby={`col-${status}`}>
            <h2 id={`col-${status}`} className="mb-2 text-xl font-semibold">{status === 'preparing' ? 'Preparing' : 'Ready'}</h2>
            {orders.filter((o) => o.status === status).length === 0 && <p className="text-sm text-gray-600">No orders.</p>}
            <ul className="flex flex-col gap-3">
              {orders.filter((o) => o.status === status).map((o) => <OrderCard key={o.id} slug={slug} order={o} now={now} />)}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}

function OrderCard({ slug, order: o, now }: { slug: string; order: KitchenOrderView; now: Date }) {
  const waiting = Math.max(0, Math.round((now.getTime() - o.sentAt.getTime()) / 60_000));
  return (
    <li className="rounded border p-3">
      <p className="flex items-baseline justify-between"><span className="text-3xl font-bold">{o.orderNumber}</span><span className="text-sm">{DINING[o.diningOption]} · {waiting} min</span></p>
      <ul className="my-2 text-sm">
        {o.lines.map((l) => (
          <li key={l.lineNo} className="flex items-center justify-between gap-2">
            <span>{Number(l.quantity)} × {l.name}{o.needsPacking && l.packed ? ' ✓' : ''}</span>
            {o.needsPacking && (
              <ActionForm action={packAction.bind(null, slug, o.id, l.lineNo, !l.packed)} submitLabel={l.packed ? 'Unpack' : 'Packed'}>{null}</ActionForm>
            )}
          </li>
        ))}
      </ul>
      {o.status === 'preparing' && <ActionForm action={readyAction.bind(null, slug, o.id)} submitLabel="Ready">{null}</ActionForm>}
      {o.needsPacking
        ? <ActionForm action={handOverAction.bind(null, slug, o.id)} submitLabel="Hand over"><Field label="Handed to (customer, or rider and app)" name="handedTo" maxLength={80} /></ActionForm>
        : <ActionForm action={handOverAction.bind(null, slug, o.id)} submitLabel="Collected">{null}</ActionForm>}
    </li>
  );
}
