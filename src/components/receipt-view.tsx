import { code128Svg } from '@/lib/code128';
import { formatCedis } from '@/lib/money';
import { TENDER_LABELS, type ReceiptView } from '@/server/receipts';

const qty = (q: string) => q.replace(/\.?0+$/, '');

/** The receipt body (spec 4.10), sized by its container: 58 mm or 80 mm thermal paper, or a phone screen. */
export function ReceiptBody({ r }: { r: ReceiptView }) {
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: r.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(r.createdAt);
  return (
    <div className="font-mono text-xs leading-snug text-black">
      <p className="text-center text-sm font-bold">{r.shopName}</p>
      <p className="text-center">{r.branchName}{r.branchAddress ? `, ${r.branchAddress}` : ''}</p>
      {r.branchPhone && <p className="text-center">Tel {r.branchPhone}</p>}
      {r.taxNumber && <p className="text-center">TIN {r.taxNumber}</p>}
      <hr className="my-1 border-dashed border-black" />
      <p>Receipt {r.receiptNumber}</p>
      <p>{when}</p>
      <p>Cashier: {r.cashierName}</p>
      {r.customerName && <p>Customer: {r.customerName}</p>}
      {r.status === 'pending' && <p className="font-bold">NOT PAID IN FULL</p>}
      <hr className="my-1 border-dashed border-black" />
      {r.lines.map((l, i) => (
        <div key={i}>
          <p>{l.name}</p>
          <p className="flex justify-between"><span>{qty(l.quantity)} {l.unitName} × {formatCedis(l.unitPricePesewas)}</span><span>{formatCedis(l.totalPesewas)}</span></p>
          {l.discountPesewas > 0 && <p className="pl-2">Discount −{formatCedis(l.discountPesewas)}</p>}
          {l.serials.length > 0 && <p className="pl-2">S/N {l.serials.join(', ')}</p>}
          {l.addOns.length > 0 && <p className="pl-2">+ {l.addOns.join(', ')}</p>}
          {l.note && <p className="pl-2 italic">{l.note}</p>}
        </div>
      ))}
      <hr className="my-1 border-dashed border-black" />
      <p className="flex justify-between"><span>Subtotal</span><span>{formatCedis(r.subtotalPesewas)}</span></p>
      {r.discountPesewas > 0 && <p className="flex justify-between"><span>Discounts</span><span>−{formatCedis(r.discountPesewas)}</span></p>}
      {r.taxPesewas > 0 && <p className="flex justify-between"><span>{r.taxMode === 'inclusive' ? 'Tax included' : 'Tax'}</span><span>{formatCedis(r.taxPesewas)}</span></p>}
      {r.serviceChargePesewas > 0 && <p className="flex justify-between"><span>Service charge</span><span>{formatCedis(r.serviceChargePesewas)}</span></p>}
      <p className="flex justify-between text-sm font-bold"><span>TOTAL</span><span>{formatCedis(r.totalPesewas)}</span></p>
      {r.roundingPesewas !== 0 && <p className="flex justify-between"><span>Cash rounding</span><span>{formatCedis(r.roundingPesewas)}</span></p>}
      {r.taxMode === 'inclusive' && r.taxPesewas > 0 && <p>Prices include tax</p>}
      <hr className="my-1 border-dashed border-black" />
      {r.payments.map((p, i) => (
        <p key={i} className="flex justify-between"><span>{TENDER_LABELS[p.method]}{p.reference ? ` (${p.reference})` : ''}</span><span>{formatCedis(p.amountPesewas)}</span></p>
      ))}
      {r.changeDuePesewas > 0 && <p className="flex justify-between"><span>Change</span><span>{formatCedis(r.changeDuePesewas)}</span></p>}
      {r.giftCards?.map((g) => (
        <div key={g.code} className="my-1 flex flex-col items-center border border-dashed border-black p-1 text-center">
          <span className="font-semibold">Gift card {formatCedis(g.amountPesewas)}</span>
          <span className="font-mono">{g.code}</span>
          {g.expiresOn && <span>Valid until {g.expiresOn}</span>}
          {code128Svg(g.code.replaceAll('-', '')) && <div dangerouslySetInnerHTML={{ __html: code128Svg(g.code.replaceAll('-', ''), { module: 1.2, height: 36 })! }} />}
        </div>
      ))}
      {r.footer && <><hr className="my-1 border-dashed border-black" /><p className="text-center">{r.footer}</p></>}
      <p className="mt-1 text-center">Thank you</p>
    </div>
  );
}
