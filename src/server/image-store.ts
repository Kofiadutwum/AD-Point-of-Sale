import 'server-only';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Where product photos live: local disk in development, a private Supabase Storage bucket in production. */
export type ImageStore = {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
};

// tenant/product/uuid.webp only, so a key can never climb out of the store
const KEY = /^[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f-]+\.webp$/;

function checkKey(key: string): string {
  if (!KEY.test(key)) throw new Error(`unsafe image key: ${key}`);
  return key;
}

export function diskImageStore(dir: string): ImageStore {
  const file = (key: string) => path.join(dir, ...checkKey(key).split('/'));
  return {
    async put(key, data) {
      const f = file(key);
      await mkdir(path.dirname(f), { recursive: true });
      await writeFile(f, data);
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(file(key)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    async remove(key) {
      await rm(file(key), { force: true });
    },
  };
}

/** Supabase Storage REST API with the service key (server only). */
export function supabaseImageStore(opts: { url: string; key: string; bucket: string; fetchFn?: typeof fetch }): ImageStore {
  const base = `${opts.url.replace(/\/+$/, '')}/storage/v1/object`;
  const fetchFn = opts.fetchFn ?? fetch;
  const auth = { apikey: opts.key, Authorization: `Bearer ${opts.key}` };
  const refuse = (res: Response, what: string) => new Error(`Supabase Storage ${what} failed: ${res.status}`);
  return {
    async put(key, data) {
      const res = await fetchFn(`${base}/${opts.bucket}/${checkKey(key)}`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'image/webp' }, body: new Blob([new Uint8Array(data)], { type: 'image/webp' }),
      });
      if (!res.ok) throw refuse(res, 'upload');
    },
    async get(key) {
      const res = await fetchFn(`${base}/authenticated/${opts.bucket}/${checkKey(key)}`, { method: 'GET', headers: auth });
      if (res.status === 400 || res.status === 404) return null; // Storage answers 400 for a missing object
      if (!res.ok) throw refuse(res, 'download');
      return new Uint8Array(await res.arrayBuffer());
    },
    async remove(key) {
      const res = await fetchFn(`${base}/${opts.bucket}`, {
        method: 'DELETE', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [checkKey(key)] }),
      });
      if (!res.ok) throw refuse(res, 'delete');
    },
  };
}

let store: ImageStore | undefined;

/** SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set → private bucket 'product-images'; otherwise .data/images on disk. */
export function getImageStore(): ImageStore {
  if (!store) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    store = url && key ? supabaseImageStore({ url, key, bucket: 'product-images' }) : diskImageStore(path.join(process.cwd(), '.data', 'images'));
  }
  return store;
}
