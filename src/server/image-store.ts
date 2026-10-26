import 'server-only';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AwsClient } from 'aws4fetch';

/** Where product photos live: local disk in development, a private Cloudflare R2 bucket in production. */
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

/** Cloudflare R2 through its S3 API, signed with an R2 API token's keys (server only). */
export function r2ImageStore(opts: {
  accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; fetchFn?: typeof fetch;
}): ImageStore {
  const client = new AwsClient({ accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey, service: 's3', region: 'auto' });
  const fetchFn = opts.fetchFn ?? fetch;
  const url = (key: string) => `https://${opts.accountId}.r2.cloudflarestorage.com/${opts.bucket}/${checkKey(key)}`;
  const send = async (key: string, init: RequestInit) => fetchFn(await client.sign(url(key), init));
  const refuse = (res: Response, what: string) => new Error(`R2 ${what} failed: ${res.status}`);
  return {
    async put(key, data) {
      const res = await send(key, { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: new Uint8Array(data) });
      if (!res.ok) throw refuse(res, 'upload');
    },
    async get(key) {
      const res = await send(key, { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) throw refuse(res, 'download');
      return new Uint8Array(await res.arrayBuffer());
    },
    async remove(key) {
      const res = await send(key, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw refuse(res, 'delete');
    },
  };
}

let store: ImageStore | undefined;

/** R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY set → private R2 bucket (R2_BUCKET, default 'product-images'); otherwise .data/images on disk. */
export function getImageStore(): ImageStore {
  if (!store) {
    const { R2_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
    store = accountId && accessKeyId && secretAccessKey
      ? r2ImageStore({ accountId, accessKeyId, secretAccessKey, bucket: process.env.R2_BUCKET || 'product-images' })
      : diskImageStore(path.join(process.cwd(), '.data', 'images'));
  }
  return store;
}
