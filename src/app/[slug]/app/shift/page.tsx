import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listApprovers } from '@/server/approvals';
import { currentShift } from '@/server/shifts';
import { pageCtx } from '../page-ctx';
import { cashMovementAction, closeShiftAction, openShiftAction } from './actions';

const select = 'rounded border border-gray-400 px-3 py-2';

export default async function ShiftPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'make_sale');
  const [shift, approvers] = await Promise.all([currentShift(getDb(), ctx), listApprovers(getDb(), ctx)]);
  const row = (label: string, v: number, sign = '') => <p className="flex justify-between"><span>{label}</span><span>{sign}{formatCedis(v)}</span></p>;
  return (
    <main className="flex max-w-md flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Shift</h1>
      {!ctx.registerId ? <p className="text-sm text-gray-700">Shifts are kept at a till: sign in with your PIN on a registered till.</p> : !shift ? (
        <ActionForm action={openShiftAction.bind(null, slug)} submitLabel="Open shift">
          <Field label="Cash in the drawer to start (GHS)" name="float" inputMode="decimal" required={false} defaultValue="0" />
        </ActionForm>
      ) : (
        <>
          <section className="flex flex-col gap-1 text-sm">
            <p className="text-gray-700">Opened by {shift.openedBy} at {shift.openedAt.toISOString().slice(11, 16)} · {shift.sales} sales</p>
            {row('Opening cash', shift.openingCashPesewas)}
            {row('Cash taken', shift.cashTakenPesewas, '+')}
            {row('Change given', shift.changeGivenPesewas, '−')}
            {row('Paid in', shift.paidInPesewas, '+')}
            {row('Paid out', shift.paidOutPesewas, '−')}
            {row('Cash refunds', shift.cashRefundsPesewas, '−')}
            <p className="flex justify-between text-lg font-semibold"><span>Should be in the drawer</span><span>{formatCedis(shift.expectedCashPesewas)}</span></p>
          </section>
          {ctx.permissions.includes('manage_cash') && (
            <section className="flex flex-col gap-2">
              <h2 className="text-lg font-semibold">Cash in or out</h2>
              <ActionForm action={cashMovementAction.bind(null, slug)} submitLabel="Record">
                <select name="type" className={select} defaultValue="paid_out" aria-label="In or out">
                  <option value="paid_out">Paid out of the drawer</option><option value="paid_in">Paid into the drawer</option>
                </select>
                <Field label="Amount (GHS)" name="amount" inputMode="decimal" />
                <Field label="Reason" name="reason" maxLength={200} />
              </ActionForm>
            </section>
          )}
          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Close shift</h2>
            <ActionForm action={closeShiftAction.bind(null, slug)} submitLabel="Close shift">
              <Field label="Cash counted in the drawer (GHS)" name="counted" inputMode="decimal" />
              <Field label="Reason for any difference" name="reason" required={false} maxLength={200} />
              <fieldset className="flex flex-col gap-2 rounded border border-gray-300 p-3">
                <legend className="px-1 text-sm">Manager approval (for a difference, when needed)</legend>
                <select name="approverId" className={select} defaultValue="">
                  <option value="">No approval</option>
                  {approvers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <Field label="Manager PIN" name="pin" type="password" inputMode="numeric" autoComplete="off" required={false} />
              </fieldset>
            </ActionForm>
          </section>
        </>
      )}
    </main>
  );
}
