import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { diskImageStore, supabaseImageStore } from '@/server/image-store';

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

it('Supabase store calls the Storage API with the service key', async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  let status = 200;
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body });
    return new Response(status === 200 ? new Uint8Array([9]) : 'nope', { status });
  }) as typeof fetch;
  const store = supabaseImageStore({ url: 'https://p.supabase.co/', key: 'service-key', bucket: 'product-images', fetchFn });

  await store.put(KEY, bytes);
  expect(calls[0]).toMatchObject({
    url: `https://p.supabase.co/storage/v1/object/product-images/${KEY}`, method: 'POST',
    headers: { apikey: 'service-key', Authorization: 'Bearer service-key', 'Content-Type': 'image/webp' },
  });
  expect(await store.get(KEY)).toEqual(new Uint8Array([9]));
  expect(calls[1]).toMatchObject({ url: `https://p.supabase.co/storage/v1/object/authenticated/product-images/${KEY}`, method: 'GET' });
  await store.remove(KEY);
  expect(calls[2]).toMatchObject({ url: 'https://p.supabase.co/storage/v1/object/product-images', method: 'DELETE' });
  expect(JSON.parse(calls[2].body as string)).toEqual({ prefixes: [KEY] });

  status = 404;
  expect(await store.get(KEY)).toBeNull();
  status = 500;
  await expect(store.put(KEY, bytes)).rejects.toThrow(/500/);
});
