import 'server-only';
import sharp from 'sharp';
import { compressToTarget, sniffImageType } from '@/lib/images';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 40_000_000; // stops decompression bombs (spec 6.4)

export type ProcessError = 'too_large' | 'unsupported_type' | 'heic_not_supported' | 'could_not_read' | 'could_not_compress';
export type ProcessedImage = { webp: Uint8Array; width: number; height: number; bytes: number };

/**
 * The server never trusts the device (spec 4.13): every upload is checked by content, rotated, stripped of all
 * metadata, and re-encoded to WebP of at most 30 KB. sharp drops EXIF, GPS, XMP, and ICC data unless asked to keep them.
 */
export async function processUpload(file: Uint8Array): Promise<{ ok: true; image: ProcessedImage } | { ok: false; error: ProcessError }> {
  if (file.byteLength > MAX_UPLOAD_BYTES) return { ok: false, error: 'too_large' };
  const type = sniffImageType(file);
  if (type === 'heic') return { ok: false, error: 'heic_not_supported' };
  if (!type) return { ok: false, error: 'unsupported_type' };

  let rotated: ReturnType<typeof sharp>;
  try {
    rotated = sharp(file, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();
    await rotated.clone().metadata(); // reads the header: refuses oversized or broken images before any encode
  } catch {
    return { ok: false, error: 'could_not_read' };
  }

  try {
    const r = await compressToTarget(async (side, quality) => {
      const { data, info } = await rotated.clone()
        .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: Math.round(quality * 100) })
        .toBuffer({ resolveWithObject: true });
      return { size: data.byteLength, data: { data, width: info.width, height: info.height } };
    });
    if (!r.ok) return { ok: false, error: 'could_not_compress' };
    const { data, width, height } = r.result.data;
    return { ok: true, image: { webp: new Uint8Array(data), width, height, bytes: data.byteLength } };
  } catch {
    return { ok: false, error: 'could_not_read' }; // the header parsed but the pixel data is broken
  }
}
