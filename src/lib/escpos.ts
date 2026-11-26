/** A line on a thermal slip. `big` prints double width and height (half as many characters fit). */
export type SlipLine = { text: string; bold?: boolean; big?: boolean; center?: boolean };

const ESC = 0x1b;
const GS = 0x1d;

/** Thermal printers' default code page is ASCII-safe only: accents are dropped and symbols written out. */
export function toAscii(s: string): string {
  return s.replace(/₵/g, 'GHS ').replace(/[–—]/g, '-').replace(/×/g, 'x').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?');
}

/** Breaks text into lines of at most `width` characters, at spaces where it can. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > width) {
    const cut = rest.lastIndexOf(' ', width);
    const at = cut > 0 ? cut : width;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  out.push(rest);
  return out;
}

/**
 * ESC/POS bytes for the lines: initialise, styled text, feed, then a partial cut (and the cash drawer when asked).
 * `width` is characters per line at normal size: 32 for 58 mm paper, 48 for 80 mm.
 */
export function escpos(lines: SlipLine[], opts: { width?: number; cut?: boolean; drawer?: boolean } = {}): Uint8Array {
  const width = opts.width ?? 32;
  const out: number[] = [ESC, 0x40];
  for (const l of lines) {
    out.push(ESC, 0x61, l.center ? 1 : 0, ESC, 0x45, l.bold ? 1 : 0, GS, 0x21, l.big ? 0x11 : 0);
    for (const part of wrap(toAscii(l.text), l.big ? Math.floor(width / 2) : width)) {
      for (const ch of part) out.push(ch.charCodeAt(0));
      out.push(0x0a);
    }
  }
  out.push(ESC, 0x61, 0, ESC, 0x45, 0, GS, 0x21, 0, ESC, 0x64, 4);
  if (opts.cut !== false) out.push(GS, 0x56, 66, 0);
  if (opts.drawer) out.push(ESC, 0x70, 0, 25, 250);
  return new Uint8Array(out);
}
