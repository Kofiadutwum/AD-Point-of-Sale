import type { DeviceCache } from '@/lib/device-contract';
import type { SyncDeps } from './sync';

// Spec 6.10: refresh the device cache every 15 minutes and after any catalogue change (the version poll catches those).
export const REFRESH_EVERY_MS = 15 * 60_000;

export async function refreshCache(deps: SyncDeps & { force?: boolean }): Promise<'updated' | 'unchanged' | 'deregistered' | 'offline'> {
  const { store, slug } = deps;
  const meta = await store.getMeta();
  try {
    const cache = await store.getCache();
    if (!deps.force && cache && meta.lastSyncAt !== null && deps.now() - meta.lastSyncAt < REFRESH_EVERY_MS) {
      const res = await deps.fetch(`/api/${slug}/device/cache/version`);
      if (res.status === 401) return wipe(deps);
      if (!res.ok) return 'offline';
      const { version } = await res.json() as { version: number };
      if (version === meta.cacheVersion) {
        await store.patchMeta({ lastSyncAt: deps.now() });
        return 'unchanged';
      }
    }
    const res = await deps.fetch(`/api/${slug}/device/cache`);
    if (res.status === 401) return wipe(deps);
    if (!res.ok) return 'offline';
    const fresh = await res.json() as DeviceCache;
    await store.setCache(fresh);
    await store.patchMeta({ lastSyncAt: deps.now(), cacheVersion: fresh.version, deregistered: false });
    const resolved = new Set(fresh.resolvedHeldSaleIds);
    for (const e of await store.listOutbox()) if (e.status === 'needs_review' && resolved.has(e.saleId)) await store.deleteOutbox(e.saleId);
  } catch {
    return 'offline';
  }
  try {
    // a reinstalled till continues after the server's last receipt number (spec 6.0)
    const res = await deps.fetch(`/api/${slug}/register/counter`);
    const body = res.ok ? await res.json() as { lastCounter?: unknown } : null;
    if (typeof body?.lastCounter === 'number') await store.raiseCounter(body.lastCounter);
  } catch {
    // tried again on the next refresh
  }
  return 'updated';
}

/** Spec 4.9: a removed device forgets PINs and catalogue; queued sales stay until it is registered again. */
async function wipe(deps: SyncDeps): Promise<'deregistered'> {
  await deps.store.wipeCache();
  await deps.store.patchMeta({ deregistered: true });
  return 'deregistered';
}
