import { notFound } from 'next/navigation';
import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { listShops } from '@/server/platform-admin';
import { recordPaymentAction, suspendAction } from './actions';

export default async function AdminShopPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [shop] = await listShops(getDb(), new Date(), id).catch(() => []);
  if (!shop) notFound();
  const suspended = shop.status === 'suspended';
  return (
    <main className="flex flex-col gap-8">
      <section>
        <h1 className="text-2xl font-semibold">{shop.name}</h1>
        <p className="text-sm text-gray-700">/{shop.slug} · {shop.shopType} · {shop.status}</p>
        <p className="text-sm">Plan {shop.planId}, {shop.subscriptionStatus} until {shop.endDate} ({shop.state})</p>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Record payment</h2>
        <ActionForm action={recordPaymentAction.bind(null, shop.tenantId)} submitLabel="Record payment">
          <label className="flex flex-col gap-1 text-sm">Method
            <select name="method" className="rounded border border-gray-400 px-3 py-2">
              <option value="momo">Mobile money</option>
              <option value="bank_transfer">Bank transfer</option>
              <option value="cash">Cash</option>
              <option value="card_terminal">Card terminal</option>
            </select>
          </label>
          <Field label="Reference (MoMo ID, slip, or transfer number)" name="reference" />
          <Field label="Amount (GHS)" name="amount" inputMode="decimal" />
          <Field label="Months" name="months" type="number" min={1} max={36} defaultValue={12} />
          <label className="flex flex-col gap-1 text-sm">Plan
            <select name="plan" defaultValue="standard" className="rounded border border-gray-400 px-3 py-2">
              <option value="standard">Standard</option>
            </select>
          </label>
        </ActionForm>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{suspended ? 'Unsuspend shop' : 'Suspend shop'}</h2>
        <ActionForm action={suspendAction.bind(null, shop.tenantId, !suspended)} submitLabel={suspended ? 'Unsuspend' : 'Suspend'}>
          <Field label="Reason" name="reason" />
        </ActionForm>
      </section>
    </main>
  );
}
