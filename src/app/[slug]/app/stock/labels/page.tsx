import { PrintButton } from '@/components/print-button';
import { getDb } from '@/db/client';
import { code128Svg } from '@/lib/code128';
import { formatCedis } from '@/lib/money';
import { labelItems } from '@/server/inventory';
import { pageCtx } from '../../page-ctx';

/** Printable barcode labels: one code per line, with how many copies ("6001234567 x10"). */
export default async function LabelsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ codes?: string }> }) {
  const { slug } = await params;
  const { codes = '' } = await searchParams;
  const ctx = await pageCtx(slug, 'manage_products');
  const wanted = codes.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 50).map((l) => {
    const m = l.match(/^(.*?)\s*[xX×]\s*(\d{1,3})$/);
    return { code: (m ? m[1] : l).trim(), copies: m ? Math.min(Number(m[2]), 200) : 1 };
  });
  const items = wanted.length ? await labelItems(getDb(), ctx, wanted.map((w) => w.code)) : [];
  const labels = wanted.flatMap((w) => {
    const it = items.find((i) => i.code === w.code);
    return it ? Array.from({ length: w.copies }, () => it) : [];
  });
  const missing = wanted.filter((w) => !items.some((i) => i.code === w.code)).map((w) => w.code);
  return (
    <main className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 print:hidden">
        <a href={`/${slug}/app/stock`} className="text-sm text-blue-800 underline">← Stock</a>
        <h1 className="text-2xl font-semibold">Barcode labels</h1>
        <form method="get" className="flex max-w-md flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm">Barcodes or SKUs, one per line; add “x10” for copies
            <textarea name="codes" rows={6} defaultValue={codes} className="rounded border border-gray-400 px-3 py-2" />
          </label>
          <button type="submit" className="self-start rounded bg-blue-800 px-4 py-2 text-white">Make labels</button>
        </form>
        {missing.length > 0 && <p className="text-sm text-red-700">Not found: {missing.join(', ')}</p>}
        {labels.length > 0 && <PrintButton />}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {labels.map((l, i) => {
          const svg = l.printCode ? code128Svg(l.printCode, { module: 1.5, height: 40 }) : null;
          return (
            <div key={i} className="flex flex-col items-center gap-1 border border-dashed border-gray-400 p-2 text-center text-xs" style={{ breakInside: 'avoid' }}>
              <span className="font-semibold">{l.name}</span>
              <span>{formatCedis(l.pricePesewas)} / {l.unitName}</span>
              {svg ? <div className="max-w-full" dangerouslySetInnerHTML={{ __html: svg }} /> : <span className="text-red-700">No barcode or SKU</span>}
            </div>
          );
        })}
      </div>
    </main>
  );
}
