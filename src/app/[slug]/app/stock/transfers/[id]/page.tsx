import { notFound } from 'next/navigation';
import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { getTransfer } from '@/server/inventory';
import { pageCtx } from '../../../page-ctx';
import { receiveTransferAction } from '../../actions';

/** Spec 6.25: the receiving branch confirms each line; short or extra stock needs a reason. */
export default async function TransferPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await pageCtx(slug, 'receive_stock');
  const t = await getTransfer(getDb(), ctx, id);
  if (!t) notFound();
  return (
    <main className="flex max-w-2xl flex-col gap-4">
      <a href={`/${slug}/app/stock`} className="text-sm text-blue-800 underline">← Stock</a>
      <h1 className="text-2xl font-semibold">Transfer {t.number}</h1>
      <p className="text-sm text-gray-700">{t.status === 'sent' ? `In transit since ${t.sentAt.toISOString().slice(0, 16).replace('T', ' ')}` : 'Received'}{t.note ? ` · ${t.note}` : ''}</p>
      {t.status === 'sent' ? (
        <ActionForm action={receiveTransferAction.bind(null, slug, t.id, t.lines.map((l) => l.id))} submitLabel="Confirm received">
          {t.lines.map((l) => (
            <div key={l.id} className="flex flex-wrap items-end gap-2">
              <span className="w-56 text-sm">{l.name}{l.batchNumber ? ` (batch ${l.batchNumber})` : ''}: sent {Number(l.quantity)}</span>
              <Field label="Arrived" name={`got_${l.id}`} inputMode="decimal" defaultValue={String(Number(l.quantity))} />
              <Field label="Reason if different" name={`why_${l.id}`} required={false} maxLength={200} />
            </div>
          ))}
        </ActionForm>
      ) : (
        <ul className="text-sm">{t.lines.map((l) => <li key={l.id}>{l.name}: sent {Number(l.quantity)}, arrived {Number(l.receivedQuantity ?? 0)}{l.differenceReason ? ` (${l.differenceReason})` : ''}</li>)}</ul>
      )}
    </main>
  );
}
