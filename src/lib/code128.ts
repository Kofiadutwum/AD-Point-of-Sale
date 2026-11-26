// Code 128 (set B) barcodes as SVG for printed shelf and product labels (spec 4.1). Every scanner reads them.

// Bar and space widths for symbol values 0-102, then Start A, B, C (103-105) and Stop (106).
export const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104;
const STOP = 106;

/** Symbol values with the check value, or null for text Code 128 set B cannot hold (printable ASCII only). */
export function code128Values(text: string): number[] | null {
  if (!text || text.length > 40 || !/^[\x20-\x7E]+$/.test(text)) return null;
  const data = [...text].map((c) => c.charCodeAt(0) - 32);
  const check = data.reduce((sum, v, i) => sum + v * (i + 1), START_B) % 103;
  return [START_B, ...data, check, STOP];
}

/** An SVG of the barcode with the text under it; `module` is the narrowest bar in px. */
export function code128Svg(text: string, opts: { module?: number; height?: number } = {}): string | null {
  const values = code128Values(text);
  if (!values) return null;
  const m = opts.module ?? 2;
  const h = opts.height ?? 50;
  const quiet = 10 * m;
  let x = quiet;
  const bars: string[] = [];
  for (const v of values) {
    [...PATTERNS[v]].forEach((w, i) => {
      const width = Number(w) * m;
      if (i % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${width}" height="${h}"/>`);
      x += width;
    });
  }
  const width = x + quiet;
  const label = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h + 14}" width="${width}" height="${h + 14}" role="img" aria-label="${label}"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${bars.join('')}</g><text x="${width / 2}" y="${h + 12}" font-family="monospace" font-size="12" text-anchor="middle">${label}</text></svg>`;
}
