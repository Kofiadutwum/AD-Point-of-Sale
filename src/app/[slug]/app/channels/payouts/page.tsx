import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listOpenReceivables } from '@/server/channel-payouts';
import { listChannels } from '@/server/channels';
import { pageCtx } from '../../page-ctx';
import { payoutAction } from './actions';

/** Spec 6.57: what each delivery app still owes, and its payouts matched against those orders. */
export default async function PayoutsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_channels');
  const apps = (await listChannels(getDb(), ctx)).filter((c) => c.collectedBy === 'app');
  const owed = await Promise.all(apps.map((c) => listOpenReceivables(getDb(), ctx, c.id)));
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">App payouts</h1>
      {apps.length === 0 && <p className="text-sm text-gray-700">No delivery app collects money for you. Set one up under Sales channels.</p>}
      {apps.map((c, i) => (
        <section key={c.id} className="flex flex-col gap-3 rounded border p-3">
          <h2 className="text-lg font-semibold">{c.name}: {formatCedis(owed[i].reduce((s, r) => s + r.expectedPesewas, 0))} owed for {owed[i].length} orders</h2>
          {owed[i].length > 0 && (
            <table className="text-sm">
              <thead><tr className="text-left"><th>Date</th><th>Receipt</th><th>App order</th><th className="text-right">Owed</th></tr></thead>
              <tbody>
                {owed[i].map((r) => (
                  <tr key={r.saleId}><td>{r.businessDate}</td><td>{r.receiptNumber}</td><td>{r.externalOrderId}</td><td className="text-right">{formatCedis(r.expectedPesewas)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <ActionForm action={payoutAction.bind(null, slug, c.id)} submitLabel="Record payout">
            <Field label="Amount received (GHS)" name="amount" inputMode="decimal" />
            <Field label="Payout reference" name="reference" maxLength={100} />
            <Field label="Orders from" name="from" type="date" />
            <Field label="Orders to" name="to" type="date" />
          </ActionForm>
        </section>
      ))}
    </main>
  );
}
