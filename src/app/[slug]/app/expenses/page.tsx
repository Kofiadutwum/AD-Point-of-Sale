import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listApprovers } from '@/server/approvals';
import { listBranches } from '@/server/branches';
import { listExpenses } from '@/server/expenses';
import { pageCtx } from '../page-ctx';
import { reportInput, type ReportSearch } from '../reports/food/report-input';
import { recordExpenseAction } from './actions';

const select = 'rounded border border-gray-400 px-3 py-2';
const METHODS = { cash: 'Cash', momo_manual: 'MoMo', card_terminal: 'Card', bank_transfer: 'Bank transfer' } as const;

export default async function ExpensesPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<ReportSearch> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'record_expenses');
  const { from, to } = reportInput(await searchParams);
  const [list, approvers, branchList] = await Promise.all([listExpenses(getDb(), ctx, { from, to }), listApprovers(getDb(), ctx), listBranches(getDb(), ctx)]);
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Expenses</h1>
      <ActionForm action={recordExpenseAction.bind(null, slug, branchList.length === 1 ? branchList[0].id : '')} submitLabel="Record expense">
        <Field label="Category (rent, electricity, transport...)" name="category" maxLength={60} />
        <Field label="Amount (GHS)" name="amount" inputMode="decimal" />
        <select name="method" className={select} defaultValue="cash" aria-label="Paid by">
          {(Object.keys(METHODS) as Array<keyof typeof METHODS>).map((m) => <option key={m} value={m}>{METHODS[m]}</option>)}
        </select>
        <Field label="Reference (MoMo, card, or bank)" name="reference" required={false} maxLength={100} />
        {!ctx.registerId && branchList.length > 1 && (
          <select name="branchId" className={select} aria-label="Branch">{branchList.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        )}
        <Field label="Note" name="note" required={false} maxLength={200} />
        <fieldset className="flex flex-col gap-2 rounded border border-gray-300 p-3">
          <legend className="px-1 text-sm">Manager approval (when needed)</legend>
          <select name="approverId" className={select} defaultValue="">
            <option value="">No approval</option>
            {approvers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <Field label="Manager PIN" name="pin" type="password" inputMode="numeric" autoComplete="off" required={false} />
        </fieldset>
      </ActionForm>
      <section className="flex flex-col gap-2">
        <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col gap-1">From<input type="date" name="from" defaultValue={from} className="rounded border border-gray-400 px-2 py-1" /></label>
          <label className="flex flex-col gap-1">To<input type="date" name="to" defaultValue={to} className="rounded border border-gray-400 px-2 py-1" /></label>
          <button type="submit" className="rounded bg-blue-800 px-3 py-1 text-white">Show</button>
        </form>
        <h2 className="text-lg font-semibold">Total {formatCedis(list.totalPesewas)}</h2>
        {list.rows.length === 0 ? <p className="text-sm text-gray-700">No expenses in these dates.</p> : (
          <ul className="text-sm">{list.rows.map((e) => (
            <li key={e.id}>{e.at.toISOString().slice(0, 10)} · {e.category}: {formatCedis(e.amountPesewas)} by {METHODS[e.method]}{e.reference ? ` (${e.reference})` : ''} · {e.by}{e.note ? ` · ${e.note}` : ''}</li>
          ))}</ul>
        )}
      </section>
    </main>
  );
}
