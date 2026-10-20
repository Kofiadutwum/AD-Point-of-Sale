import type { HeldSaleReport, SaleResponse } from '@/lib/device-contract';
import type { DeviceStore, OutboxEntry } from './store';

// Spec 6.10: send queued sales oldest first. Retries are safe because the sale ID is the idempotency key.

export type Outcome = 'ok' | 'review' | 'auth' | 'retry';
export type SyncDeps = { store: DeviceStore; fetch: typeof fetch; slug: string; now: () => number };
export type SyncResult = { sent: number; held: number; waiting: number; needsPin: boolean; reachable: boolean };

/** The shared contract with Plan 3: 200 done; 400/409 permanent; 401/403 sign in again; anything else (5xx, 404 before Plan 3 ships) retry. */
export function classifySaleResponse(status: number, body: unknown): { outcome: Outcome; error: string | null } {
  const error = (body as { error?: unknown } | null)?.error;
  const text = typeof error === 'string' ? error : null;
  if (status === 200 && (body as SaleResponse | null)?.ok === true) return { outcome: 'ok', error: null };
  if (status === 400 || status === 409) return { outcome: 'review', error: text ?? `http_${status}` };
  if (status === 401 || status === 403) return { outcome: 'auth', error: text };
  return { outcome: 'retry', error: text ?? `http_${status}` };
}

export function backoffMs(attempts: number): number {
  return Math.min(15 * 60_000, 5_000 * 2 ** (attempts - 1));
}

type Sent = { outcome: Outcome; error: string | null; body: unknown; reachable: boolean };

async function post(deps: SyncDeps, entry: OutboxEntry, fromOfflineOutbox: boolean): Promise<Sent> {
  try {
    const res = await deps.fetch(`/api/${deps.slug}/sales`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...entry.request, fromOfflineOutbox }),
    });
    const body = await res.json().catch(() => null);
    return { ...classifySaleResponse(res.status, body), body, reachable: true };
  } catch {
    return { outcome: 'retry', error: 'offline', body: null, reachable: false };
  }
}

async function report(deps: SyncDeps, entry: OutboxEntry, status: HeldSaleReport['status']): Promise<boolean> {
  const body: HeldSaleReport = {
    saleId: entry.saleId, receiptNumber: entry.request.receiptNumber, cashierId: entry.request.cashierId ?? null, totalPesewas: entry.totalPesewas,
    error: entry.lastError ?? 'unknown', sale: entry.request, deviceCreatedAt: entry.request.deviceCreatedAt, status,
  };
  try {
    const res = await deps.fetch(`/api/${deps.slug}/device/held-sales`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.ok;
  } catch {
    return false;
  }
}

async function restoreCounter(deps: SyncDeps): Promise<void> {
  try {
    const res = await deps.fetch(`/api/${deps.slug}/register/counter`);
    const body = res.ok ? await res.json() as { lastCounter?: unknown } : null;
    if (typeof body?.lastCounter === 'number') await deps.store.raiseCounter(body.lastCounter);
  } catch {
    // the next refresh tries again
  }
}

async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const result: SyncResult = { sent: 0, held: 0, waiting: 0, needsPin: false, reachable: true };
  for (const entry of await deps.store.listOutbox()) {
    if (entry.status !== 'queued' || entry.nextAttemptAt > deps.now()) continue;
    const r = await post(deps, entry, true);
    if (r.outcome === 'ok') {
      await deps.store.deleteOutbox(entry.saleId);
      if (entry.reported) await report(deps, entry, 'synced');
      result.sent++;
    } else if (r.outcome === 'review') {
      const held: OutboxEntry = { ...entry, status: 'needs_review', lastError: r.error };
      await deps.store.putOutbox({ ...held, reported: await report(deps, held, 'held') });
      if (r.error === 'duplicate_receipt_number') await restoreCounter(deps);
      result.held++;
    } else if (r.outcome === 'auth') {
      result.needsPin = true;
      break;
    } else {
      const attempts = entry.attempts + 1;
      await deps.store.putOutbox({ ...entry, attempts, nextAttemptAt: deps.now() + backoffMs(attempts), lastError: r.error });
      result.reachable = r.reachable;
      break; // oldest first: the rest wait behind this one
    }
  }
  for (const entry of await deps.store.listOutbox()) {
    if (entry.status === 'needs_review' && !entry.reported && await report(deps, entry, 'held')) await deps.store.putOutbox({ ...entry, reported: true });
  }
  result.waiting = (await deps.store.listOutbox()).filter((e) => e.status === 'queued').length;
  return result;
}

const running = new WeakMap<DeviceStore, Promise<SyncResult>>();

/** One run per store at a time; a second call while one runs gets the same result. */
export function syncOutbox(deps: SyncDeps): Promise<SyncResult> {
  let run = running.get(deps.store);
  if (!run) {
    run = runSync(deps).finally(() => running.delete(deps.store));
    running.set(deps.store, run);
  }
  return run;
}

/** The first, online attempt while the customer is still at the till. A refusal comes back so the cashier can fix the cart. */
export async function sendSaleNow(deps: SyncDeps, saleId: string): Promise<
  { result: 'sent'; response: Extract<SaleResponse, { ok: true }> } | { result: 'queued'; needsPin: boolean } | { result: 'rejected'; error: string }
> {
  const entry = (await deps.store.listOutbox()).find((e) => e.saleId === saleId);
  if (!entry) throw new Error(`no outbox sale ${saleId}`);
  const r = await post(deps, entry, false);
  if (r.outcome === 'ok') {
    await deps.store.deleteOutbox(saleId);
    return { result: 'sent', response: r.body as Extract<SaleResponse, { ok: true }> };
  }
  if (r.outcome === 'review') {
    await deps.store.deleteOutbox(saleId);
    return { result: 'rejected', error: r.error ?? 'refused' };
  }
  // from here on it is an outbox sale: the server may accept the price the customer paid (spec 6.10)
  const request = { ...entry.request, fromOfflineOutbox: true };
  if (r.outcome === 'auth') {
    await deps.store.putOutbox({ ...entry, request });
    return { result: 'queued', needsPin: true };
  }
  await deps.store.putOutbox({ ...entry, request, attempts: 1, nextAttemptAt: deps.now() + backoffMs(1), lastError: r.error });
  return { result: 'queued', needsPin: false };
}

export async function retryHeld(store: DeviceStore, saleId: string): Promise<void> {
  const entry = (await store.listOutbox()).find((e) => e.saleId === saleId);
  if (entry) await store.putOutbox({ ...entry, status: 'queued', attempts: 0, nextAttemptAt: 0 });
}
