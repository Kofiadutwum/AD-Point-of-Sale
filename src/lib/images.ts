// Runs on the device and on the server (spec 4.13, 6.4).

export const IMAGE_MAX_BYTES = 30 * 1024;
export const IMAGE_MIN_BYTES = 20 * 1024;
export const PRODUCT_IMAGE_SIZES = [800, 640, 480] as const;
export const COVER_IMAGE_SIZES = [1200, 960, 800] as const; // Phase 2 storefront cover
export const TOP_QUALITY = 0.85;
export const LOW_QUALITY = 0.4;
export const SEARCH_STEPS = 7;

export type Encoded<T> = { size: number; data: T };

/** Spec 6.4: the highest quality that fits in 30 KB, trying smaller sizes when the largest cannot fit. */
export async function compressToTarget<T>(
  encode: (maxSide: number, quality: number) => Promise<Encoded<T>>, sizes: readonly number[] = PRODUCT_IMAGE_SIZES,
): Promise<{ ok: true; maxSide: number; quality: number; result: Encoded<T> } | { ok: false }> {
  for (const maxSide of sizes) {
    const top = await encode(maxSide, TOP_QUALITY);
    if (top.size <= IMAGE_MAX_BYTES) return { ok: true, maxSide, quality: TOP_QUALITY, result: top };
    let best: { quality: number; result: Encoded<T> } | null = null;
    let low = LOW_QUALITY;
    let high = TOP_QUALITY;
    for (let step = 0; step < SEARCH_STEPS; step++) {
      const q = (low + high) / 2;
      const candidate = await encode(maxSide, q);
      if (candidate.size > IMAGE_MAX_BYTES) {
        high = q;
      } else {
        best = { quality: q, result: candidate };
        low = q;
        if (candidate.size >= IMAGE_MIN_BYTES) break;
      }
    }
    if (best) return { ok: true, maxSide, ...best };
  }
  return { ok: false };
}

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'];

/** The image type from its first bytes, never from the file name. */
export function sniffImageType(bytes: Uint8Array): 'jpeg' | 'png' | 'webp' | 'heic' | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && HEIC_BRANDS.includes(ascii(8, 12))) return 'heic';
  return null;
}
