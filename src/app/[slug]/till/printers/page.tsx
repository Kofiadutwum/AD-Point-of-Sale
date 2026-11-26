import { PrinterForm } from './printer-form';

/** This till's printers (spec 11). Kept in the browser, so it works offline and needs no sign-in. */
export default async function PrintersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-4">
      <a href={`/${slug}/till/sell`} className="text-sm text-blue-800 underline">← Selling screen</a>
      <h1 className="text-2xl font-semibold">Printers</h1>
      <p className="text-sm text-gray-700">Kitchen slips print through the ADsmartshop print helper running on this computer. See the helper&apos;s README to set it up.</p>
      <PrinterForm slug={slug} />
    </main>
  );
}
