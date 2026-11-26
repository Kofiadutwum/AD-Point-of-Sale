import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { pharmacyReport } from '@/server/pharmacy-reports';
import { pageCtx } from '../../page-ctx';
import { reportInput, type ReportSearch } from '../food/report-input';

export default async function PharmacyReportPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<ReportSearch> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'view_reports', { allowReadOnly: true });
  const { from, to } = reportInput(await searchParams);
  const r = await pharmacyReport(getDb(), ctx, { from, to }, new Date());
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Pharmacy report</h1>
      <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">From<input type="date" name="from" defaultValue={from} className="rounded border border-gray-400 px-2 py-1" /></label>
        <label className="flex flex-col gap-1">To<input type="date" name="to" defaultValue={to} className="rounded border border-gray-400 px-2 py-1" /></label>
        <button type="submit" className="rounded bg-blue-800 px-3 py-1 text-white">Show</button>
      </form>
      {!r.ok ? <p role="alert" className="text-sm text-red-700">{r.error === 'range_too_long' ? 'Choose at most 92 days.' : 'Check the dates.'}</p> : (
        <>
          {([['Expiring within ' + r.report.warningDays + ' days', r.report.nearExpiry, r.report.nearExpiryValuePesewas],
            ['Expired (cannot be sold)', r.report.expired, r.report.expiredValuePesewas]] as const).map(([title, rows, value]) => (
            <section key={title} className="flex flex-col gap-2">
              <h2 className="text-lg font-semibold">{title}: {formatCedis(value)} at cost</h2>
              {rows.length === 0 ? <p className="text-sm text-gray-700">None.</p> : (
                <table className="text-sm">
                  <thead><tr className="text-left"><th>Item</th><th>Batch</th><th>Expires</th><th>On hand</th><th>Value</th><th>Branch</th></tr></thead>
                  <tbody>{rows.map((b) => (
                    <tr key={b.batchId}><td>{b.name}</td><td>{b.batchNumber}</td><td>{b.expiryDate}</td><td>{Number(b.onHand)}</td><td>{formatCedis(b.valuePesewas)}</td><td>{b.branchName}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </section>
          ))}
          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Prescription-only sales</h2>
            {r.report.prescriptions === null ? <p className="text-sm text-gray-700">Only people who may dispense can see prescription records.</p>
              : r.report.prescriptions.length === 0 ? <p className="text-sm text-gray-700">None in these dates.</p> : (
                <table className="text-sm">
                  <thead><tr className="text-left"><th>Date</th><th>Receipt</th><th>Medicine</th><th>Qty</th><th>Patient</th><th>Prescriber</th><th>Facility</th><th>Sold by</th></tr></thead>
                  <tbody>{r.report.prescriptions.map((p) => (
                    <tr key={`${p.saleId}-${p.medicine}`}>
                      <td>{p.businessDate}</td><td>{p.receiptNumber}</td><td>{p.medicine}</td><td>{Number(p.quantity)}</td><td>{p.patientName}</td>
                      <td>{p.prescriberName} ({p.prescriptionDate})</td><td>{p.facility}</td><td>{p.soldBy}{p.approvedBy ? `, approved by ${p.approvedBy}` : ''}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
          </section>
        </>
      )}
    </main>
  );
}
