import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PrintButton } from '@/components/print-button';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { getSharedDoc } from '@/server/quotes';

export const metadata: Metadata = { title: 'Quote or invoice', robots: { index: false, follow: false } };

/** A quote or invoice a customer opens from a link (spec 4.22). No sign-in; print it to save as PDF. */
export default async function SharedDocPage({ params }: { params: Promise<{ slug: string; code: string }> }) {
  const { slug, code } = await params;
  const d = await getSharedDoc(getDb(), slug, code);
  if (!d) notFound();
  return (
    <main className="mx-auto my-6 flex max-w-2xl flex-col gap-4 rounded border bg-white p-6 text-sm">
      <header className="flex justify-between">
        <div><p className="text-xl font-semibold">{d.shopName}</p>{d.shopPhone && <p>{d.shopPhone}</p>}{d.taxNumber && <p>TIN {d.taxNumber}</p>}</div>
        <div className="text-right">
          <p className="text-xl font-semibold">{d.kind === 'quote' ? 'QUOTE' : 'INVOICE'} {d.number}</p>
          <p>Date {d.date}</p>
          {d.validUntil && <p>Valid until {d.validUntil}</p>}
          {d.dueDate && <p>Due {d.dueDate}</p>}
        </div>
      </header>
      {d.customer && (
        <section><p className="font-semibold">For</p><p>{d.customer.name}</p><p>{d.customer.phone}</p>{d.customer.address && <p>{d.customer.address}</p>}{d.customer.tin && <p>TIN {d.customer.tin}</p>}</section>
      )}
      <table>
        <thead><tr className="border-b text-left"><th>Item</th><th>Qty</th><th className="text-right">Price</th><th className="text-right">Discount</th><th className="text-right">Total</th></tr></thead>
        <tbody>{d.lines.map((l, i) => (
          <tr key={i}><td>{l.name}</td><td>{Number(l.quantity)} {l.unitName}</td><td className="text-right">{formatCedis(l.unitPricePesewas)}</td>
            <td className="text-right">{l.discountPesewas ? formatCedis(l.discountPesewas) : ''}</td><td className="text-right">{formatCedis(l.totalPesewas)}</td></tr>
        ))}</tbody>
      </table>
      <section className="ml-auto flex w-60 flex-col gap-1">
        <p className="flex justify-between"><span>Subtotal</span><span>{formatCedis(d.subtotalPesewas)}</span></p>
        {d.discountPesewas > 0 && <p className="flex justify-between"><span>Discounts</span><span>−{formatCedis(d.discountPesewas)}</span></p>}
        {d.taxPesewas > 0 && <p className="flex justify-between"><span>Tax</span><span>{formatCedis(d.taxPesewas)}</span></p>}
        <p className="flex justify-between text-base font-semibold"><span>Total</span><span>{formatCedis(d.totalPesewas)}</span></p>
        {d.owedPesewas !== null && <p className="flex justify-between font-semibold"><span>Still owed</span><span>{formatCedis(d.owedPesewas)}</span></p>}
      </section>
      {d.note && <p>{d.note}</p>}
      <PrintButton />
    </main>
  );
}
