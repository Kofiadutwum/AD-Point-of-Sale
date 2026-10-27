import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type { DeviceCache, SaleRequest } from '@/lib/device-contract';

// The till's IndexedDB: cached catalogue, the sale outbox, the receipt counter, and local PIN locks (spec 6.10).

export type OutboxEntry = {
  saleId: string; seq: number; request: SaleRequest; totalPesewas: number; status: 'queued' | 'needs_review';
  attempts: number; nextAttemptAt: number; lastError: string | null; reported: boolean;
};
export type DeviceMeta = {
  lastSyncAt: number | null; counter: number; cacheVersion: number; deregistered: boolean;
  orderCounter: number; orderCounterDate: string | null; // offline food order numbers, per business date
};
type PinLock = { failures: number; lockedUntil: number | null };

interface Schema extends DBSchema {
  kv: { key: string; value: unknown };
  outbox: { key: string; value: OutboxEntry; indexes: { seq: number } };
  pinLocks: { key: string; value: PinLock & { staffId: string } };
}

export type DeviceStore = {
  getCache(): Promise<DeviceCache | null>; setCache(cache: DeviceCache): Promise<void>; wipeCache(): Promise<void>;
  getMeta(): Promise<DeviceMeta>; patchMeta(patch: Partial<DeviceMeta>): Promise<DeviceMeta>;
  takeReceiptCounter(): Promise<number>; raiseCounter(atLeast: number): Promise<void>;
  takeOrderNumber(businessDate: string): Promise<number>;
  addSale(entry: OutboxEntry): Promise<void>; listOutbox(): Promise<OutboxEntry[]>;
  putOutbox(entry: OutboxEntry): Promise<void>; deleteOutbox(saleId: string): Promise<void>;
  getPinLock(staffId: string): Promise<PinLock>; setPinLock(staffId: string, lock: PinLock): Promise<void>;
};

const EMPTY_META: DeviceMeta = { lastSyncAt: null, counter: 0, cacheVersion: 0, deregistered: false, orderCounter: 0, orderCounterDate: null };

export function openDeviceStore(slug: string): DeviceStore {
  let db: Promise<IDBPDatabase<Schema>> | undefined;
  const open = () => (db ??= openDB<Schema>(`pos-device-${slug}`, 1, {
    upgrade(d) {
      d.createObjectStore('kv');
      d.createObjectStore('outbox', { keyPath: 'saleId' }).createIndex('seq', 'seq');
      d.createObjectStore('pinLocks', { keyPath: 'staffId' });
    },
  }));
  /** Read-modify-write of meta inside one transaction, so two tabs never hand out the same counter. */
  const updateMeta = async (change: (m: DeviceMeta) => DeviceMeta): Promise<DeviceMeta> => {
    const tx = (await open()).transaction('kv', 'readwrite');
    const next = change({ ...EMPTY_META, ...((await tx.store.get('meta')) as DeviceMeta | undefined) });
    await tx.store.put(next, 'meta');
    await tx.done;
    return next;
  };
  return {
    getCache: async () => ((await (await open()).get('kv', 'cache')) as DeviceCache | undefined) ?? null,
    setCache: async (cache) => { await (await open()).put('kv', cache, 'cache'); },
    wipeCache: async () => {
      const tx = (await open()).transaction(['kv', 'pinLocks'], 'readwrite');
      await Promise.all([tx.objectStore('kv').delete('cache'), tx.objectStore('pinLocks').clear(), tx.done]);
    },
    getMeta: async () => ({ ...EMPTY_META, ...((await (await open()).get('kv', 'meta')) as DeviceMeta | undefined) }),
    patchMeta: (patch) => updateMeta((m) => ({ ...m, ...patch })),
    takeReceiptCounter: async () => (await updateMeta((m) => ({ ...m, counter: m.counter + 1 }))).counter,
    takeOrderNumber: async (businessDate) => (await updateMeta((m) => ({
      ...m, orderCounterDate: businessDate, orderCounter: m.orderCounterDate === businessDate ? m.orderCounter + 1 : 1,
    }))).orderCounter,
    raiseCounter: async (atLeast) => { await updateMeta((m) => ({ ...m, counter: Math.max(m.counter, atLeast) })); },
    addSale: async (entry) => { await (await open()).add('outbox', entry); },
    listOutbox: async () => (await open()).getAllFromIndex('outbox', 'seq'),
    putOutbox: async (entry) => { await (await open()).put('outbox', entry); },
    deleteOutbox: async (saleId) => { await (await open()).delete('outbox', saleId); },
    getPinLock: async (staffId) => {
      const lock = await (await open()).get('pinLocks', staffId);
      return { failures: lock?.failures ?? 0, lockedUntil: lock?.lockedUntil ?? null };
    },
    setPinLock: async (staffId, lock) => { await (await open()).put('pinLocks', { staffId, ...lock }); },
  };
}
