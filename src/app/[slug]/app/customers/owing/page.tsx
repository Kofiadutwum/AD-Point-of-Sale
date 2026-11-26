import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listDebtors } from '@/server/customer-accounts';
import { pageCtx } from '../../page-ctx';

/** Spec 4.5: who owes money, oldest unpaid debt first. */
export default async function OwingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, null);
  const debtors = await listDebtors(getDb(), ctx);
  const total = debtors.reduce((s, d) => s + d.balancePesewas, 0);
  return (
    <main className="flex max-w-2xl flex-col gap-4">
      <a href={`/${slug}/app/customers`} className="text-sm text-blue-800 underline">← Customers</a>
      <h1 className="text-2xl font-semibold">Who owes</h1>
      <p>Total owed: <strong>{formatCedis(total)}</strong></p>
      {debtors.length === 0 ? <p className="text-sm text-gray-700">Nobody owes the shop money.</p> : (
        <table className="text-sm">
          <thead><tr className="text-left"><th>Customer</th><th>Owes</th><th>Limit</th><th>Owing since</th></tr></thead>
          <tbody>{debtors.map((d) => (
            <tr key={d.customerId}>
              <td><a className="text-blue-800 underline" href={`/${slug}/app/customers/${d.customerId}`}>{d.name}</a> · {d.phone}</td>
              <td>{formatCedis(d.balancePesewas)}</td><td>{formatCedis(d.creditLimitPesewas)}</td><td>{d.oldestUnpaidAt?.toISOString().slice(0, 10) ?? '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </main>
  );
}
