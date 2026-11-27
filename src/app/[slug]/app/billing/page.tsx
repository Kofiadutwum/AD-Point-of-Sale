import { ActionForm, Check, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { billingOverview, consentWording } from '@/server/billing';
import { pageCtx } from '../page-ctx';
import { cancelRenewalAction, payAction } from './actions';

const STATE: Record<string, string> = { trial: 'Free trial', active: 'Active', grace: 'Expired: renew within the grace period', read_only: 'Read-only: renew to sell again' };

/** Spec 5, 6.20: plans, yearly price, pay by card or mobile money through Paystack, card renewal with consent, and cancellation. */
export default async function BillingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_shop_settings', { allowReadOnly: true });
  const b = await billingOverview(getDb(), ctx, new Date());
  const current = b.plans.find((p) => p.id === b.planId) ?? b.plans[1] ?? b.plans[0];
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Billing</h1>
      <section className="flex flex-col gap-1">
        <p className="text-lg">{b.planName} · {STATE[b.state] ?? b.state}</p>
        <p className="text-sm text-gray-700">{b.status === 'trial' ? 'Trial ends' : 'Paid until'} {b.endDate}.{b.autoRenew && b.cardLabel ? ` Renews by card (${b.cardLabel}) on ${b.endDate}.` : ''}</p>
        {b.lastFailure && <p className="text-sm text-red-700">The last payment did not go through ({b.lastFailure}). Try again below.</p>}
        {b.autoRenew && <ActionForm action={cancelRenewalAction.bind(null, slug)} submitLabel="Turn card renewal off"><span /></ActionForm>}
      </section>
      <ActionForm action={payAction.bind(null, slug)} submitLabel="Pay with Paystack">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm">Plan (billed yearly)</legend>
          {b.plans.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-sm">
              <input type="radio" name="planId" value={p.id} defaultChecked={p.id === current?.id} required />
              <span><strong>{p.name}</strong> · {formatCedis(p.annualPesewas)} a year · {p.branches} branch{p.branches === 1 ? '' : 'es'}, {p.registers} tills, {p.staff} staff (owner included), {p.products.toLocaleString('en-GH')} products</span>
            </label>
          ))}
        </fieldset>
        {!b.ownerEmail && <Field label="Email for the receipt" name="email" type="email" />}
        {current && <Check name="autoRenew" label={`Renew by card every year. ${consentWording(current.name, current.annualPesewas)}`} />}
        <p className="text-xs text-gray-600">Card is the main option; mobile money is offered on the Paystack page. Mobile money payments are not renewed automatically. Your plan is extended once Paystack confirms the payment.</p>
      </ActionForm>
      {b.payments.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold">Payments</h2>
          <ul className="text-sm">{b.payments.map((p) => <li key={p.reference}>{p.at.toISOString().slice(0, 10)} · {formatCedis(p.amountPesewas)} · {p.method} · {p.reference}</li>)}</ul>
        </section>
      )}
    </main>
  );
}
