import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { todayIn } from '@/lib/dates';
import { formatCedis } from '@/lib/money';
import { listCategories } from '@/server/products';
import { commissionReport, listCommissionRules } from '@/server/rewards';
import { listStaff } from '@/server/staff';
import { pageCtx } from '../page-ctx';
import { markPaidAction, removeRuleAction, saveRuleAction } from './actions';

const select = 'rounded border border-gray-400 px-3 py-2';

/** Spec 6.41: commission rules (product, then category, then person, then shop default) and what each person earned. */
export default async function CommissionsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  const { slug } = await params;
  const q = await searchParams;
  const ctx = await pageCtx(slug, 'manage_commissions');
  const today = todayIn(ctx.timezone, new Date());
  const from = q.from ?? `${today.slice(0, 8)}01`;
  const to = q.to ?? today;
  const db = getDb();
  const [rules, report, staff, cats] = await Promise.all([listCommissionRules(db, ctx), commissionReport(db, ctx, { from, to }), listStaff(db, ctx), listCategories(db, ctx).catch(() => [])]);
  const nameOf = (id: string | null) => (id ? staff.find((s) => s.id === id)?.name ?? 'someone' : 'Everyone');
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Staff commission</h1>
      <section className="flex flex-col gap-2">
        <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col">From<input type="date" name="from" defaultValue={from} className={select} /></label>
          <label className="flex flex-col">To<input type="date" name="to" defaultValue={to} className={select} /></label>
          <button type="submit" className="rounded border px-3 py-2">Show</button>
        </form>
        {report.length === 0 ? <p className="text-sm text-gray-700">No commission in this period.</p> : (
          <table className="text-sm"><thead><tr className="text-left"><th>Person</th><th>Earned</th><th>Not paid</th><th /></tr></thead>
            <tbody>{report.map((r) => (
              <tr key={r.userId}><td>{r.name}</td><td>{formatCedis(r.totalPesewas)}</td><td>{formatCedis(r.unpaidPesewas)}</td>
                <td>{r.unpaidPesewas > 0 && <ActionForm action={markPaidAction.bind(null, slug, r.userId, from, to)} submitLabel="Mark paid"><span /></ActionForm>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Rules</h2>
        <ul className="text-sm">{rules.map((r) => (
          <li key={r.id} className="flex items-center gap-2">
            {nameOf(r.userId)} · {r.productId ? 'one product' : r.categoryId ? `category ${cats.find((c) => c.id === r.categoryId)?.name ?? ''}` : 'all items'} · {r.percentBp !== null ? `${r.percentBp / 100}% of the line after discounts` : `${formatCedis(r.fixedPesewas ?? 0)} per item`}
            <ActionForm action={removeRuleAction.bind(null, slug, r.id)} submitLabel="Remove"><span /></ActionForm>
          </li>
        ))}</ul>
        <ActionForm action={saveRuleAction.bind(null, slug)} submitLabel="Add rule">
          <label className="flex flex-col gap-1 text-sm">Person<select name="userId" className={select}><option value="">Everyone</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <Field label="Only this item (barcode or SKU, optional)" name="code" required={false} maxLength={60} />
          {cats.length > 0 && <label className="flex flex-col gap-1 text-sm">Or this category<select name="categoryId" className={select}><option value="">Any</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
          <div className="flex gap-2"><Field label="Percent" name="percent" inputMode="decimal" required={false} /><Field label="Or GHS per item" name="fixed" inputMode="decimal" required={false} /></div>
        </ActionForm>
      </section>
    </main>
  );
}
