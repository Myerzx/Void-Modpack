import { chainAuditEvent, type AuditChainRecord } from '@voidfall/audit-chain';
import { validateAuditEvent, type AuditEvent } from '@voidfall/contracts';

import type { SqlClient } from './database.js';

export async function appendAuditRecord(
  client: SqlClient,
  event: AuditEvent,
  partitionId = 'administrative',
): Promise<AuditChainRecord> {
  const validation = validateAuditEvent(event);
  if (!validation.success || event.integrity !== undefined) {
    throw new Error('Invalid audit event.');
  }
  await client.query(
    `INSERT INTO audit_chain_heads (partition_id, last_sequence, last_hash, updated_at)
     VALUES ($1, 0, NULL, $2)
     ON CONFLICT (partition_id) DO NOTHING`,
    [partitionId, event.occurredAt],
  );
  const headResult = await client.query<{
    readonly last_sequence: number | string;
    readonly last_hash: string | null;
  }>(
    `SELECT last_sequence, last_hash
     FROM audit_chain_heads WHERE partition_id = $1 FOR UPDATE`,
    [partitionId],
  );
  const head = headResult.rows[0];
  if (head === undefined) throw new Error('Audit chain head was not created.');
  const sequence = Number(head.last_sequence) + 1;
  const record = chainAuditEvent({
    partitionId,
    sequence,
    previousHash: head.last_hash,
    event: validation.value,
  });
  const chainedEvent = record.event;
  await client.query(
    `INSERT INTO audit_events (
       id, occurred_at, correlation_id, actor, source, action, resource, outcome,
       reason, before_redacted, after_redacted, metadata_redacted, previous_hash, integrity_hash,
       partition_id, chain_sequence
     ) VALUES (
       $1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,
       $13,$14,$15,$16
     )`,
    [
      chainedEvent.id,
      chainedEvent.occurredAt,
      chainedEvent.correlationId,
      JSON.stringify(chainedEvent.actor),
      chainedEvent.source,
      chainedEvent.action,
      JSON.stringify(chainedEvent.resource),
      chainedEvent.outcome,
      chainedEvent.reason ?? null,
      chainedEvent.before === undefined ? null : JSON.stringify(chainedEvent.before),
      chainedEvent.after === undefined ? null : JSON.stringify(chainedEvent.after),
      chainedEvent.metadata === undefined ? null : JSON.stringify(chainedEvent.metadata),
      chainedEvent.integrity?.previousHash ?? null,
      chainedEvent.integrity?.eventHash ?? null,
      record.partitionId,
      record.sequence,
    ],
  );
  const updated = await client.query(
    `UPDATE audit_chain_heads
     SET last_sequence = $2, last_hash = $3, updated_at = $4
     WHERE partition_id = $1 AND last_sequence = $5`,
    [
      record.partitionId,
      record.sequence,
      chainedEvent.integrity?.eventHash ?? null,
      chainedEvent.occurredAt,
      Number(head.last_sequence),
    ],
  );
  if (updated.rowCount !== 1) throw new Error('Audit chain head update conflict.');
  return record;
}
