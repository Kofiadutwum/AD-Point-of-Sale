// SMS length rules: plain text fits 160 characters in one part, 153 per part when split; anything else (emoji, accented letters) 70 and 67.

// shortcut: treats every non-ASCII character as needing Unicode, though a few (£, é) fit the GSM alphabet; costs at most an extra part.
const unicode = (text: string) => /[^\x20-\x7E\n\r]/.test(text);

export function smsParts(text: string): number {
  const [single, multi] = unicode(text) ? [70, 67] : [160, 153];
  const n = [...text].length;
  return n <= single ? 1 : Math.ceil(n / multi);
}
