import { expect, it } from 'vitest';
import { compressToTarget, sniffImageType } from '@/lib/images';

/** An encoder whose output size is bytesAt(side, quality); it records every call. */
function fake(bytesAt: (side: number, q: number) => number) {
  const calls: Array<[number, number]> = [];
  const encode = async (side: number, q: number) => {
    calls.push([side, q]);
    return { size: bytesAt(side, q), data: `${side}@${q}` };
  };
  return { calls, encode };
}

it('keeps the top-quality encode when it already fits', async () => {
  const f = fake(() => 15_000);
  expect(await compressToTarget(f.encode)).toMatchObject({ ok: true, maxSide: 800, quality: 0.85 });
  expect(f.calls).toHaveLength(1);
});

it('searches for the highest quality that fits and stops once it reaches 20 KB', async () => {
  const f = fake((_s, q) => Math.round(q * 40_000));
  expect(await compressToTarget(f.encode)).toMatchObject({ ok: true, maxSide: 800, quality: 0.625, result: { size: 25_000 } });
  expect(f.calls).toEqual([[800, 0.85], [800, 0.625]]);
});

it('keeps the best fit when no step reaches 20 KB', async () => {
  const f = fake((_s, q) => (q > 0.5 ? 40_000 : 10_000));
  expect(await compressToTarget(f.encode)).toMatchObject({ ok: true, maxSide: 800, result: { size: 10_000 } });
  expect(f.calls).toHaveLength(8); // top + 7 search steps
});

it('tries 640 when 800 cannot fit', async () => {
  const f = fake((s, q) => (s === 800 ? 50_000 : Math.round(q * 30_000)));
  expect(await compressToTarget(f.encode)).toMatchObject({ ok: true, maxSide: 640, quality: 0.85 });
  expect(f.calls).toHaveLength(9); // 1 + 7 at 800, then 1 at 640
});

it('fails when no size fits', async () => {
  const f = fake(() => 99_999);
  expect(await compressToTarget(f.encode)).toEqual({ ok: false });
  expect(f.calls).toHaveLength(24);
});

it('sniffs types by content, not name', () => {
  const bytes = (...parts: Array<number[] | string>) =>
    new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
  expect(sniffImageType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
  expect(sniffImageType(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
  expect(sniffImageType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('webp');
  expect(sniffImageType(bytes([0, 0, 0, 0x18], 'ftypheic'))).toBe('heic');
  expect(sniffImageType(bytes([0, 0, 0, 0x18], 'ftypmif1'))).toBe('heic');
  expect(sniffImageType(bytes('hello'))).toBeNull();
  expect(sniffImageType(new Uint8Array())).toBeNull();
});
