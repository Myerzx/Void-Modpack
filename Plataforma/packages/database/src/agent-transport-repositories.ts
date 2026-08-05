import {
  capabilityServesJobType,
  jobTypesForCapability,
  validateAgentCredential,
  type ActorRef,
  type AgentCapability,
  type AgentCredential,
  type AgentWorkFailureCode,
  type Job,
} from '@voidfall/contracts';

import type { Database } from './database.js';

/**
 * Durable storage for the Phase 9.2 agent transport.
 *
 * Three properties matter here:
 *
 *  - **An identity can be withdrawn.** Rotation supersedes a credential rather
 *    than editing it, so a superseded fingerprint can never authenticate again
 *    and the history stays auditable.
 *  - **A capability must be granted, not merely announced.** An agent that
 *    announces `configuration.apply` is authorized for nothing until somebody
 *    grants it, and a grant can be withdrawn without touching the identity.
 *  - **A crashed agent does not strand work.** A job whose lease expired
 *    returns to the queue instead of sitting in `running` forever.
 */

export type AgentTransportErrorCode =
  | 'agent-not-found'
  | 'credential-not-found'
  | 'credential-revoked'
  | 'capability-not-granted'
  | 'lease-not-found'
  | 'lease-expired'
  | 'lease-job-mismatch'
  | 'invalid-record';

export class AgentTransportError extends Error {
  public readonly code: AgentTransportErrorCode;

  public constructor(code: AgentTransportErrorCode) {
    super(`agent-transport:${code}`);
    this.name = 'AgentTransportError';
    this.code = code;
  }
}

interface CredentialRow {
  readonly credential_id: string;
  readonly agent_id: string;
  readonly public_key_pem: string;
  readonly certificate_fingerprint: string;
  readonly status: AgentCredential['status'];
  readonly reason_code: string;
  readonly created_at: Date | string;
  readonly superseded_at: Date | string | null;
}

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapCredential(row: CredentialRow): AgentCredential {
  const credential: AgentCredential = {
    schemaVersion: 1,
    credentialId: row.credential_id,
    agentId: row.agent_id,
    certificateFingerprint: row.certificate_fingerprint,
    status: row.status,
    createdAt: isoString(row.created_at),
    supersededAt: row.superseded_at === null ? null : isoString(row.superseded_at),
    reasonCode: row.reason_code,
  };
  const validated = validateAgentCredential(credential);
  if (!validated.success) throw new AgentTransportError('invalid-record');
  return validated.value;
}

const CREDENTIAL_COLUMNS = `credential_id, agent_id, public_key_pem, certificate_fingerprint,
  status, reason_code, created_at, superseded_at`;

/** One unit of work handed to an agent, with the lease that covers it. */
export interface ClaimedWork {
  readonly leaseId: string;
  readonly jobId: string;
  readonly jobType: string;
  readonly capability: AgentCapability;
  readonly correlationId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly expectedVersion: number;
  readonly attempt: number;
  readonly leasedAt: string;
  readonly expiresAt: string;
}

export interface ResolvedAgentIdentity {
  readonly agentId: string;
  readonly serverInstanceId: string;
  readonly publicKeyPem: string;
  readonly credential: AgentCredential;
  readonly capabilities: readonly AgentCapability[];
}

export class AgentTransportRepository {
  constructor(private readonly database: Database) {}

  /**
   * Resolves the identity a presented transport fingerprint belongs to.
   *
   * Only an active credential resolves. A rotated or revoked fingerprint is
   * refused with the reason, so a withdrawn identity fails closed everywhere
   * rather than only on the route that happened to check.
   */
  async resolveByFingerprint(fingerprint: string): Promise<ResolvedAgentIdentity> {
    const result = await this.database.query<
      CredentialRow & { readonly server_instance_id: string; readonly agent_status: string }
    >(
      `SELECT c.credential_id, c.agent_id, c.public_key_pem, c.certificate_fingerprint,
              c.status, c.reason_code, c.created_at, c.superseded_at,
              a.server_instance_id, a.status AS agent_status
       FROM agent_credentials c JOIN agents a ON a.id = c.agent_id
       WHERE c.certificate_fingerprint = $1`,
      [fingerprint],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AgentTransportError('credential-not-found');
    if (row.status !== 'active' || row.agent_status === 'revoked') {
      throw new AgentTransportError('credential-revoked');
    }

    return {
      agentId: row.agent_id,
      serverInstanceId: row.server_instance_id,
      publicKeyPem: row.public_key_pem,
      credential: mapCredential(row),
      capabilities: await this.grantedCapabilities(row.agent_id),
    };
  }

  /** The capabilities currently granted — never the ones merely announced. */
  async grantedCapabilities(agentId: string): Promise<readonly AgentCapability[]> {
    const result = await this.database.query<{ readonly capability: AgentCapability }>(
      `SELECT capability FROM agent_capability_grants
       WHERE agent_id = $1 AND revoked_at IS NULL ORDER BY capability`,
      [agentId],
    );
    return result.rows.map((row) => row.capability);
  }

  /**
   * Replaces an agent's credential with a new one in a single transaction, so
   * there is never a moment with two active credentials or none.
   */
  async rotateCredential(input: {
    readonly agentId: string;
    readonly credentialId: string;
    readonly publicKeyPem: string;
    readonly certificateFingerprint: string;
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<AgentCredential> {
    return this.database.transaction(async (client) => {
      const agent = await client.query<{ readonly status: string }>(
        'SELECT status FROM agents WHERE id = $1 FOR UPDATE',
        [input.agentId],
      );
      const agentRow = agent.rows[0];
      if (agentRow === undefined) throw new AgentTransportError('agent-not-found');
      if (agentRow.status === 'revoked') throw new AgentTransportError('credential-revoked');

      await client.query(
        `UPDATE agent_credentials SET status = 'rotated', superseded_at = $2
         WHERE agent_id = $1 AND status = 'active'`,
        [input.agentId, input.now],
      );
      const inserted = await client.query<CredentialRow>(
        `INSERT INTO agent_credentials (
           credential_id, agent_id, public_key_pem, certificate_fingerprint, status,
           reason_code, created_at
         ) VALUES ($1,$2,$3,$4,'active',$5,$6)
         RETURNING ${CREDENTIAL_COLUMNS}`,
        [
          input.credentialId,
          input.agentId,
          input.publicKeyPem,
          input.certificateFingerprint,
          input.reasonCode,
          input.now,
        ],
      );
      // The agent row keeps mirroring the current identity so existing
      // registration checks stay consistent with the credential history.
      await client.query(
        `UPDATE agents SET public_key_pem = $2, certificate_fingerprint = $3,
           credential_rotated_at = $4, updated_at = $4 WHERE id = $1`,
        [input.agentId, input.publicKeyPem, input.certificateFingerprint, input.now],
      );

      const row = inserted.rows[0];
      if (row === undefined) throw new AgentTransportError('credential-not-found');
      return mapCredential(row);
    });
  }

  /**
   * Withdraws an identity outright. Every credential is superseded and the
   * agent is marked revoked, so nothing it holds authenticates any more.
   */
  async revokeAgent(input: {
    readonly agentId: string;
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const agent = await client.query('SELECT id FROM agents WHERE id = $1 FOR UPDATE', [
        input.agentId,
      ]);
      if (agent.rowCount === 0) throw new AgentTransportError('agent-not-found');

      await client.query(
        `UPDATE agent_credentials SET status = 'revoked', superseded_at = $2, reason_code = $3
         WHERE agent_id = $1 AND status = 'active'`,
        [input.agentId, input.now, input.reasonCode],
      );
      await client.query(
        `UPDATE agent_capability_grants SET revoked_at = $2
         WHERE agent_id = $1 AND revoked_at IS NULL`,
        [input.agentId, input.now],
      );
      await client.query("UPDATE agents SET status = 'revoked', updated_at = $2 WHERE id = $1", [
        input.agentId,
        input.now,
      ]);
    });
  }

  async grantCapability(input: {
    readonly agentId: string;
    readonly capability: AgentCapability;
    readonly grantedBy: ActorRef;
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO agent_capability_grants (
         agent_id, capability, granted_at, granted_by, reason_code
       ) VALUES ($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT (agent_id, capability) DO UPDATE
         SET granted_at = EXCLUDED.granted_at, granted_by = EXCLUDED.granted_by,
             reason_code = EXCLUDED.reason_code, revoked_at = NULL`,
      [
        input.agentId,
        input.capability,
        input.now,
        JSON.stringify(input.grantedBy),
        input.reasonCode,
      ],
    );
  }

  async revokeCapability(input: {
    readonly agentId: string;
    readonly capability: AgentCapability;
    readonly now: Date;
  }): Promise<void> {
    await this.database.query(
      `UPDATE agent_capability_grants SET revoked_at = $3
       WHERE agent_id = $1 AND capability = $2 AND revoked_at IS NULL`,
      [input.agentId, input.capability, input.now],
    );
  }

  /**
   * Leases work to an agent and records the lease in one transaction.
   *
   * Both halves have to commit together. Leasing the job separately from
   * recording who holds it would leave a window where a crash strands a job in
   * `running` with no lease row — and the reclaim below would never find it,
   * because it looks for expired leases.
   *
   * The capability is checked against the grant *and* against the job types it
   * may serve, so a granted capability still cannot be used to claim unrelated
   * work.
   */
  async claimWork(input: {
    readonly agentId: string;
    readonly capabilities: readonly AgentCapability[];
    readonly bootId: string;
    readonly maximumLeases: number;
    readonly leaseMs: number;
    readonly now: Date;
    readonly newLeaseId: () => string;
  }): Promise<readonly ClaimedWork[]> {
    const claimable = await this.claimableJobTypes(input.agentId, input.capabilities);
    if (claimable.length === 0) throw new AgentTransportError('capability-not-granted');

    const jobTypeToCapability = new Map<string, AgentCapability>();
    for (const entry of claimable) {
      for (const jobType of entry.jobTypes) jobTypeToCapability.set(jobType, entry.capability);
    }
    const acceptedTypes = [...jobTypeToCapability.keys()];
    const expiresAt = new Date(input.now.getTime() + input.leaseMs);

    return this.database.transaction(async (client) => {
      const leased = await client.query<{
        readonly id: string;
        readonly type: string;
        readonly correlation_id: string;
        readonly resource_type: string;
        readonly resource_id: string;
        readonly payload: { readonly parameters?: Record<string, unknown> } | string;
        readonly attempt: number;
      }>(
        `WITH candidate AS (
           SELECT id FROM jobs
           WHERE status = 'queued' AND available_at <= $1
             AND type = ANY($2::text[]) AND attempt < max_attempts
           ORDER BY priority DESC, available_at ASC, created_at ASC
           FOR UPDATE SKIP LOCKED LIMIT $3
         )
         UPDATE jobs SET status = 'running', stage = 'leased', lease_owner = $4,
           lease_acquired_at = $1, lease_expires_at = $5,
           attempt = attempt + 1, started_at = COALESCE(started_at, $1), updated_at = $1
         WHERE id IN (SELECT id FROM candidate)
         RETURNING id, type, correlation_id, resource_type, resource_id, payload, attempt`,
        [
          input.now,
          acceptedTypes,
          Math.max(1, Math.min(input.maximumLeases, 8)),
          input.agentId,
          expiresAt,
        ],
      );

      const claimed: ClaimedWork[] = [];
      for (const row of leased.rows) {
        const capability = jobTypeToCapability.get(row.type);
        if (capability === undefined) throw new AgentTransportError('capability-not-granted');
        const leaseId = input.newLeaseId();
        await client.query(
          `INSERT INTO agent_work_leases (
             lease_id, job_id, agent_id, capability, boot_id, attempt, leased_at, expires_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            leaseId,
            row.id,
            input.agentId,
            capability,
            input.bootId,
            row.attempt,
            input.now,
            expiresAt,
          ],
        );
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        const parameters = (payload as { readonly parameters?: Record<string, unknown> }).parameters ?? {};
        claimed.push({
          leaseId,
          jobId: row.id,
          jobType: row.type,
          capability,
          correlationId: row.correlation_id,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          expectedVersion:
            typeof parameters['expectedVersion'] === 'number' ? parameters['expectedVersion'] : 0,
          attempt: row.attempt,
          leasedAt: input.now.toISOString(),
          expiresAt: expiresAt.toISOString(),
        });
      }
      return claimed;
    });
  }

  /**
   * Closes a lease the agent still holds.
   *
   * The job the result names is checked *inside* the transaction, before
   * anything is written. Settling first and validating afterwards would let a
   * result naming the wrong job consume the lease and strand the real work.
   */
  async settleLease(input: {
    readonly leaseId: string;
    readonly agentId: string;
    readonly expectedJobId: string;
    readonly outcome: 'succeeded' | 'failed';
    readonly failureCode?: AgentWorkFailureCode;
    readonly now: Date;
  }): Promise<{ readonly jobId: string }> {
    return this.database.transaction(async (client) => {
      const current = await client.query<{
        readonly job_id: string;
        readonly expires_at: Date | string;
        readonly settled_at: Date | string | null;
      }>(
        `SELECT job_id, expires_at, settled_at FROM agent_work_leases
         WHERE lease_id = $1 AND agent_id = $2 FOR UPDATE`,
        [input.leaseId, input.agentId],
      );
      const row = current.rows[0];
      if (row === undefined || row.settled_at !== null) {
        throw new AgentTransportError('lease-not-found');
      }
      if (row.job_id !== input.expectedJobId) {
        throw new AgentTransportError('lease-job-mismatch');
      }
      if (Date.parse(isoString(row.expires_at)) <= input.now.getTime()) {
        throw new AgentTransportError('lease-expired');
      }

      await client.query(
        `UPDATE agent_work_leases SET settled_at = $2, outcome = $3, failure_code = $4
         WHERE lease_id = $1`,
        [input.leaseId, input.now, input.outcome, input.failureCode ?? null],
      );
      return { jobId: row.job_id };
    });
  }

  /**
   * Returns work stranded by an agent that never came back.
   *
   * The job queue only ever leases rows that are `queued`, so before this a job
   * left `running` by a crashed agent stayed there forever. An expired lease is
   * marked failed and its job is returned to the queue when attempts remain, or
   * failed outright when they do not — never silently retried past its budget.
   */
  async reclaimExpiredLeases(input: {
    readonly now: Date;
  }): Promise<readonly { readonly jobId: string; readonly requeued: boolean }[]> {
    return this.database.transaction(async (client) => {
      const expired = await client.query<{
        readonly lease_id: string;
        readonly job_id: string;
      }>(
        `SELECT lease_id, job_id FROM agent_work_leases
         WHERE settled_at IS NULL AND expires_at <= $1
         ORDER BY expires_at
         FOR UPDATE SKIP LOCKED`,
        [input.now],
      );

      const reclaimed: { jobId: string; requeued: boolean }[] = [];
      for (const lease of expired.rows) {
        await client.query(
          `UPDATE agent_work_leases
           SET settled_at = $2, outcome = 'failed', failure_code = 'lease-expired'
           WHERE lease_id = $1`,
          [lease.lease_id, input.now],
        );
        const requeued = await client.query<{ readonly id: string }>(
          `UPDATE jobs
           SET status = 'queued', stage = 'queued', lease_owner = NULL,
               lease_acquired_at = NULL, lease_expires_at = NULL, available_at = $2,
               updated_at = $2
           WHERE id = $1 AND status = 'running' AND attempt < max_attempts
           RETURNING id`,
          [lease.job_id, input.now],
        );
        if (requeued.rowCount === 0) {
          // Out of attempts: the job fails rather than being retried past its
          // budget, and the failure says what actually happened.
          await client.query(
            `UPDATE jobs SET status = 'failed', stage = 'failed', lease_owner = NULL,
               lease_acquired_at = NULL, lease_expires_at = NULL,
               error = $2::jsonb, finished_at = $3, updated_at = $3
             WHERE id = $1 AND status = 'running'`,
            [
              lease.job_id,
              JSON.stringify({
                code: 'AGENT_LEASE_EXPIRED',
                message: 'The agent lease expired and no attempt remained.',
                retryable: false,
              }),
              input.now,
            ],
          );
        }
        reclaimed.push({ jobId: lease.job_id, requeued: requeued.rowCount > 0 });
      }
      return reclaimed;
    });
  }

  /** Job types an agent may claim, from its grants alone. */
  async claimableJobTypes(
    agentId: string,
    requested: readonly AgentCapability[],
  ): Promise<{ readonly capability: AgentCapability; readonly jobTypes: readonly string[] }[]> {
    const granted = new Set(await this.grantedCapabilities(agentId));
    return requested
      .filter((capability) => granted.has(capability))
      .map((capability) => ({ capability, jobTypes: jobTypesForCapability(capability) }))
      .filter((entry) => entry.jobTypes.length > 0);
  }

  /** Whether a granted capability may serve the job type it was handed. */
  capabilityCanServe(capability: AgentCapability, job: Pick<Job, 'type'>): boolean {
    return capabilityServesJobType(capability, job.type);
  }

  async findCredentials(agentId: string): Promise<readonly AgentCredential[]> {
    const result = await this.database.query<CredentialRow>(
      `SELECT ${CREDENTIAL_COLUMNS} FROM agent_credentials
       WHERE agent_id = $1 ORDER BY created_at DESC, credential_id`,
      [agentId],
    );
    return result.rows.map(mapCredential);
  }
}
