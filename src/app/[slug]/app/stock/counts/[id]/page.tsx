import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/form';
import { getDb } from '@/db/client';
import { listApprovers } from '@/server/approvals';
import { getCount } from '@/server/inventory';
import { pageCtx } from '../../../page-ctx';
import { cancelCountAction, finishCountAction, saveCountAction } from '../../actions';
import { ApproverFields } from '../../parts';

/** Spec 6.26: type what is on the shelf (base units); save as you go, then finish. Items left blank stay unchanged. */
export default async function CountPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await pageCtx(slug, 'stock_count');
  const [c, approvers] = await Promise.all([getCount(getDb(), ctx, id), listApprovers(getDb(), ctx)]);
  if (!c) notFound();
  const open = c.status === 'open';
  return (
    <main className="flex max-w-2xl flex-col gap-4">
      <a href={`/${slug}/app/stock`} className="text-sm text-blue-800 underline">← Stock</a>
      <h1 className="text-2xl font-semibold">Count at {c.branchName}</h1>
      <p className="text-sm text-gray-700">Started {c.startedAt.toISOString().slice(0, 16).replace('T', ' ')} · {c.status}</p>
      {open ? (
        <>
          <ActionForm action={saveCountAction.bind(null, slug, c.id)} submitLabel="Save counts">
            {c.lines.map((l) => (
              <label key={l.id} className="flex items-center justify-between gap-2 text-sm">
                <span>{l.name}{l.batchNumber ? ` (batch ${l.batchNumber})` : ''}</span>
                <input name={`n_${l.id}`} inputMode="decimal" defaultValue={l.counted !== null ? String(Number(l.counted)) : ''} className="w-24 rounded border border-gray-400 px-2 py-1" aria-label={`Counted ${l.name}`} />
              </label>
            ))}
          </ActionForm>
          <ActionForm action={finishCountAction.bind(null, slug, c.id)} submitLabel="Finish count and adjust stock">
            <ApproverFields approvers={approvers} />
          </ActionForm>
          <ActionForm action={cancelCountAction.bind(null, slug, c.id)} submitLabel="Cancel count"><span /></ActionForm>
        </>
      ) : (
        <table className="text-sm"><thead><tr className="text-left"><th>Item</th><th>Counted</th><th>Difference</th></tr></thead>
          <tbody>{c.lines.map((l) => <tr key={l.id}><td>{l.name}{l.batchNumber ? ` (${l.batchNumber})` : ''}</td><td>{l.counted !== null ? Number(l.counted) : 'not counted'}</td><td>{l.difference !== null ? Number(l.difference) : ''}</td></tr>)}</tbody>
        </table>
      )}
    </main>
  );
}
