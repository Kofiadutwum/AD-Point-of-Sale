'use client';
import { useState } from 'react';
import { compressToTarget, type ImageTarget, PHOTO_TARGET, TOP_QUALITY } from '@/lib/images';

type Upload = (formData: FormData) => Promise<{ error: string | null; message?: string | null }>;

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * Spec 6.4 on the device, to save the shop's mobile data: rotate, resize, and search for the highest WebP quality under 30 KB.
 * A browser that cannot encode WebP sends one 800 px JPEG instead; the server re-compresses every upload anyway.
 */
async function prepare(file: File, target: ImageTarget): Promise<Blob | 'not_a_photo' | 'too_detailed'> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return 'not_a_photo';
  }
  const draw = (maxSide: number) => {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height)); // never enlarge
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  };
  const probe = await toBlob(draw(16), 'image/webp', TOP_QUALITY);
  if (probe?.type !== 'image/webp') return (await toBlob(draw(target.sizes[0]), 'image/jpeg', TOP_QUALITY)) ?? 'not_a_photo';
  const r = await compressToTarget(async (side, quality) => {
    const blob = await toBlob(draw(side), 'image/webp', quality);
    if (!blob) throw new Error('could not encode the photo');
    return { size: blob.size, data: blob };
  }, target);
  return r.ok ? r.result.data : 'too_detailed';
}

/** Compresses on the phone before sending (keeps uploads far under the host's 4.5 MB request limit and saves mobile data). */
export function PhotoUpload({ upload, target = PHOTO_TARGET, label = 'Add a photo' }: { upload: Upload; target?: ImageTarget; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setMessage('Compressing photo…');
    try {
      const prepared = await prepare(file, target);
      if (prepared === 'not_a_photo') return setError('Choose a photo');
      if (prepared === 'too_detailed') return setError('Photo too detailed. Try a closer or plainer photo.');
      setMessage('Uploading…');
      const fd = new FormData();
      fd.append('photo', prepared, prepared.type === 'image/webp' ? 'photo.webp' : 'photo.jpg');
      const r = await upload(fd);
      setError(r.error);
      setMessage(r.error ? null : r.message ?? null);
    } finally {
      setBusy(false);
      input.value = '';
    }
  }

  return (
    <div className="flex flex-col gap-1 text-sm">
      <label className="flex flex-col gap-1">{label}
        <input type="file" accept="image/*" onChange={onChange} disabled={busy} />
      </label>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      {!error && message && <p role="status" className="text-green-800">{message}</p>}
    </div>
  );
}
