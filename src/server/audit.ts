import 'server-only';
import type { Tx } from '@/db/client';
import { type ActorType, auditLog } from '@/db/schema';

export type AuditEntry = {
  tenantId: string | null; actorType: ActorType; actorId: string | null; action: string;
  recordType?: string; recordId?: string; reason?: string; changes?: Record<string, unknown>;
};

export async function writeAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: entry.tenantId,
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    recordType: entry.recordType ?? null,
    recordId: entry.recordId ?? null,
    reason: entry.reason ?? null,
    changes: entry.changes ?? null,
  });
}
