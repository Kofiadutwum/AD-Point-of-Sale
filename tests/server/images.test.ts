import sharp from 'sharp';
import { expect, it } from 'vitest';
import { type ProcessedImage, processUpload } from '@/server/images';

/** A photo-like image: smooth blurred noise, which compresses about as well as a real product photo. */
const photo = (width: number, height: number, sigma = 30, blur = 6) =>
  sharp({ create: { width, height, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma } } }).blur(blur);

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

it('re-encodes a large JPEG to WebP of at most 30 KB and 800 px', async () => {
  const r = await processUpload(await photo(3000, 2000).jpeg().toBuffer());
  expect(r.ok).toBe(true);
  const { image } = r as { ok: true; image: ProcessedImage };
  const meta = await sharp(image.webp).metadata();
  expect(meta.format).toBe('webp');
  expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(800);
  expect(image.bytes).toBe(image.webp.byteLength);
  expect(image.bytes).toBeLessThanOrEqual(30 * 1024);
  expect([image.width, image.height]).toEqual([meta.width, meta.height]);
});

it('strips EXIF and GPS metadata', async () => {
  const input = await photo(1200, 900).withExif({ IFD0: { Copyright: 'Ama' }, IFD3: { GPSLatitudeRef: 'N' } }).jpeg().toBuffer();
  expect((await sharp(input).metadata()).exif).toBeDefined();
  const r = await processUpload(input) as { ok: true; image: ProcessedImage };
  const meta = await sharp(r.image.webp).metadata();
  expect(meta.exif).toBeUndefined();
  expect(meta.xmp).toBeUndefined();
});

it('applies camera rotation before stripping', async () => {
  const input = await photo(400, 200).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const r = await processUpload(input) as { ok: true; image: ProcessedImage };
  expect([r.image.width, r.image.height]).toEqual([200, 400]);
});

it('rejects HEIC, other types, oversize files, and image bombs', async () => {
  expect(await processUpload(new Uint8Array([0, 0, 0, 0x18, ...ascii('ftypheic'), 0, 0, 0, 0]))).toEqual({ ok: false, error: 'heic_not_supported' });
  expect(await processUpload(new Uint8Array(ascii('hello')))).toEqual({ ok: false, error: 'unsupported_type' });
  expect(await processUpload(new Uint8Array(10 * 1024 * 1024 + 1))).toEqual({ ok: false, error: 'too_large' });
  const bomb = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: '#ffffff' } }).png().toBuffer(); // 48 million pixels
  expect(await processUpload(bomb)).toEqual({ ok: false, error: 'could_not_read' });
  expect(await processUpload(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).toEqual({ ok: false, error: 'could_not_read' });
});

it('fails with could_not_compress for an image too detailed to fit', async () => {
  // unblurred strong noise stays over 30 KB even at 480 px and quality 0.40
  expect(await processUpload(await photo(2000, 2000, 120, 0.3).png().toBuffer())).toEqual({ ok: false, error: 'could_not_compress' });
});
