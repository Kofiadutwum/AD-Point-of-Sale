'use client';

/** Opens the browser print dialog; thermal printers print through their normal driver (spec 4.10). */
export function PrintButton({ auto = false }: { auto?: boolean }) {
  return (
    <button type="button" ref={(el) => { if (el && auto) setTimeout(() => window.print(), 300); }} onClick={() => window.print()}
      className="rounded bg-blue-800 px-4 py-2 text-white">Print</button>
  );
}
