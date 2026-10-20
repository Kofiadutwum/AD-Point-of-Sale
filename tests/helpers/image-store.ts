import type { ImageStore } from '@/server/image-store';

/** An in-memory ImageStore for tests; keys() lists what is stored. */
export function memoryImageStore(): ImageStore & { keys(): string[] } {
  const files = new Map<string, Uint8Array>();
  return {
    async put(key, data) { files.set(key, data); },
    async get(key) { return files.get(key) ?? null; },
    async remove(key) { files.delete(key); },
    keys: () => [...files.keys()],
  };
}
