import { notFound } from 'next/navigation';
import { ActionForm, Check, Field } from '@/components/form';
import { PrintButton } from '@/components/print-button';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { customerAccount } from '@/server/customer-accounts';
import { pageCtx } from '../../page-ctx';
import { adjustAction, businessAction, paymentAction, termsAction } from './actions';

const select = 'rounded border border-gray-400 px-3 py-2';
const TYPES = { sale: 'Bought on credit', payment: 'Paid', return: 'Returned', adjustment: 'Adjusted' } as const;

export default async function CustomerAccountPage({ params }: { params: Promise<{ slug: string; customerId: string }> }) {
  const { slug, customerId } = await params;
  const ctx = await pageCtx(slug, null);
  const a = await customerAccount(getDb(), ctx, customerId);
  if (!a) notFound();
  const can = (p: string) => ctx.permissions.includes(p as never);
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <a href={`/${slug}/app/customers`} className="text-sm text-blue-800 underline">← Customers</a>
      <section className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{a.name}</h1>
        <p className="text-sm text-gray-700">{a.phone}</p>
        <p className="text-xl">Owes <strong>{formatCedis(a.balancePesewas)}</strong> <span className="text-sm text-gray-700">of a {formatCedis(a.creditLimitPesewas)} limit</span></p>
        <PrintButton />
      </section>
      {can('receive_debt_payment') && a.balancePesewas > 0 && (
        <section className="flex max-w-md flex-col gap-2">
          <h2 className="text-lg font-semibold">Take a payment</h2>
          <ActionForm action={paymentAction.bind(null, slug, a.customerId)} submitLabel="Record payment">
            <Field label="Amount (GHS)" name="amount" inputMode="decimal" />
            <select name="method" className={select} defaultValue="cash" aria-label="Paid by">
              <option value="cash">Cash</option><option value="momo_manual">MoMo</option><option value="card_terminal">Card</option><option value="bank_transfer">Bank transfer</option>
            </select>
            <Field label="Reference (MoMo, card, or bank)" name="reference" required={false} maxLength={100} />
          </ActionForm>
        </section>
      )}
      {can('approve_actions') && (
        <section className="flex max-w-md flex-col gap-4">
          <h2 className="text-lg font-semibold">Credit terms</h2>
          <ActionForm action={termsAction.bind(null, slug, a.customerId)} submitLabel="Save terms">
            <Field label="Credit limit (GHS, 0 = no credit)" name="limit" inputMode="decimal" defaultValue={(a.creditLimitPesewas / 100).toFixed(2)} />
            <Check name="consent" label="Agreed to SMS reminders about what they owe" defaultChecked={a.reminderConsent} />
          </ActionForm>
          <h2 className="text-lg font-semibold">Correct the balance</h2>
          <ActionForm action={adjustAction.bind(null, slug, a.customerId)} submitLabel="Adjust">
            <select name="direction" className={select} defaultValue="down" aria-label="Direction">
              <option value="down">Reduce what they owe</option><option value="up">Increase what they owe</option>
            </select>
            <Field label="Amount (GHS)" name="amount" inputMode="decimal" />
            <Field label="Reason" name="reason" maxLength={200} />
          </ActionForm>
        </section>
      )}
      {can('issue_invoices') && (
        <section className="flex max-w-md flex-col gap-2">
          <h2 className="text-lg font-semibold">Business details (for invoices)</h2>
          <ActionForm action={businessAction.bind(null, slug, a.customerId)} submitLabel="Save details">
            <Field label="Address" name="address" required={false} maxLength={200} defaultValue={a.address ?? ''} />
            <Field label="TIN" name="tin" required={false} maxLength={30} defaultValue={a.tin ?? ''} />
          </ActionForm>
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Account history</h2>
        {a.ledger.length === 0 ? <p className="text-sm text-gray-700">Nothing yet.</p> : (
          <table className="text-sm">
            <thead><tr className="text-left"><th>Date</th><th>What</th><th>Amount</th><th>Owes after</th><th>By</th></tr></thead>
            <tbody>{a.ledger.map((e) => (
              <tr key={e.id}>
                <td>{e.at.toISOString().slice(0, 10)}</td>
                <td>{TYPES[e.type]}{e.method ? ` (${e.method.replace('_manual', '').replace('_terminal', '').replace('_', ' ')}${e.reference ? ` ${e.reference}` : ''})` : ''}{e.reason ? ` · ${e.reason}` : ''}</td>
                <td>{e.amountPesewas > 0 ? '+' : '−'}{formatCedis(Math.abs(e.amountPesewas))}</td><td>{formatCedis(e.balanceAfterPesewas)}</td><td>{e.by}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </main>
  );
}
