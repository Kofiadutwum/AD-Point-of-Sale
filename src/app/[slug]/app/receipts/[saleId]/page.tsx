import { notFound } from 'next/navigation';
import { CopyBox } from '@/components/form';
import { PrintButton } from '@/components/print-button';
import { ReceiptBody } from '@/components/receipt-view';
import { getDb } from '@/db/client';
import { receiptShareText, whatsappShareUrl } from '@/lib/receipt';
import { getReceipt } from '@/server/receipts';
import { pageCtx } from '../../page-ctx';

/** Print view for 58 mm or 80 mm thermal paper, plus share buttons (spec 4.10). `?reprint=1` logs a reprint. */
export default async function ReceiptPage({ params, searchParams }: {
  params: Promise<{ slug: string; saleId: string }>; searchParams: Promise<{ w?: string; reprint?: string }>;
}) {
  const { slug, saleId } = await params;
  const sp = await searchParams;
  const ctx = await pageCtx(slug, null);
  const r = await getReceipt(getDb(), ctx, saleId, { reprint: sp.reprint === '1' });
  if (!r) notFound();
  const width = sp.w === '58' ? 58 : 80;
  const link = `${process.env.APP_URL ?? 'http://localhost:3000'}/${slug}/r/${r.shareCode}`;
  const share = whatsappShareUrl(receiptShareText({ shopName: r.shopName, receiptNumber: r.receiptNumber, totalPesewas: r.totalPesewas, url: link }), r.customerPhone);
  const widthLink = (w: number) => `?${new URLSearchParams({ w: String(w), ...(sp.reprint === '1' ? { reprint: '1' } : {}) })}`;
  return (
    <main className="flex flex-col gap-4">
      <style>{`@page { size: ${width}mm auto; margin: 0 } @media print { body * { visibility: hidden } #receipt, #receipt * { visibility: visible } #receipt { position: absolute; left: 0; top: 0 } }`}</style>
      <nav className="flex flex-wrap items-center gap-3 print:hidden">
        <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
        <a href={`/${slug}/app/sell`} className="text-sm text-blue-800 underline">New sale</a>
        <PrintButton />
        <a href={widthLink(80)} className={`rounded border px-3 py-2 text-sm ${width === 80 ? 'bg-gray-100' : ''}`}>80 mm</a>
        <a href={widthLink(58)} className={`rounded border px-3 py-2 text-sm ${width === 58 ? 'bg-gray-100' : ''}`}>58 mm</a>
        <a href={share} target="_blank" rel="noreferrer" className="rounded bg-green-700 px-4 py-2 text-white">Share on WhatsApp</a>
      </nav>
      <div className="print:hidden"><CopyBox text={link} /></div>
      <div id="receipt" className="bg-white p-2" style={{ width: `${width}mm` }}>
        <ReceiptBody r={r} />
      </div>
    </main>
  );
}
