import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { diskImageStore, r2ImageStore } from '@/server/image-store';

const KEY = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.webp';
const bytes = new Uint8Array([1, 2, 3]);

it('disk store puts, gets, and removes, and refuses unsafe keys', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'images-'));
  try {
    const store = diskImageStore(dir);
    await store.put(KEY, bytes);
    expect(await store.get(KEY)).toEqual(bytes);
    await store.remove(KEY);
    expect(await store.get(KEY)).toBeNull();
    await expect(store.put('../x.webp', bytes)).rejects.toThrow(/unsafe image key/);
    await expect(store.get('a/../../b.webp')).rejects.toThrow(/unsafe image key/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('R2 store sends signed S3 requests to the account bucket', async () => {
  const calls: Array<{ url: string; method: string; auth: string | null; type: string | null; body: Uint8Array }> = [];
  let status = 200;
  const fetchFn = (async (req: Request) => {
    calls.push({ url: req.url, method: req.method, auth: req.headers.get('authorization'), type: req.headers.get('content-type'), body: new Uint8Array(await req.arrayBuffer()) });
    return new Response(status === 200 ? new Uint8Array([9]) : 'nope', { status });
  }) as unknown as typeof fetch;
  const store = r2ImageStore({ accountId: 'acc123', accessKeyId: 'AKID', secretAccessKey: 'secret', bucket: 'product-images', fetchFn });
  const url = `https://acc123.r2.cloudflarestorage.com/product-images/${KEY}`;

  await store.put(KEY, bytes);
  expect(calls[0]).toMatchObject({ url, method: 'PUT', type: 'image/webp', body: bytes });
  expect(calls[0].auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.+, Signature=[0-9a-f]{64}$/);
  expect(await store.get(KEY)).toEqual(new Uint8Array([9]));
  expect(calls[1]).toMatchObject({ url, method: 'GET' });
  await store.remove(KEY);
  expect(calls[2]).toMatchObject({ url, method: 'DELETE' });

  status = 404;
  expect(await store.get(KEY)).toBeNull();
  await store.remove(KEY); // already gone is fine
  status = 500;
  await expect(store.put(KEY, bytes)).rejects.toThrow(/500/);
  await expect(store.get('../x.webp')).rejects.toThrow(/unsafe image key/);
});
