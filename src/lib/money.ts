/** "1,250.50" → 125050 pesewas. Whole numbers only, never floats. Null when the text is not a plain amount or too large to count exactly. */
export function parseCedis(input: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/,/g, ''));
  if (!match) return null;
  const pesewas = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(pesewas) ? pesewas : null;
}

/** 125050 → "GHS 1,250.50" */
export function formatCedis(pesewas: number): string {
  const cedis = Math.trunc(pesewas / 100).toLocaleString('en-GH');
  return `GHS ${cedis}.${String(Math.abs(pesewas % 100)).padStart(2, '0')}`;
}
