import { randomUUID } from 'node:crypto';
import {
  createAuditExport,
  verifyAuditChain,
  type AuditChainRecord,
  type AuditChainVerificationResult,
  type AuditExportArtifact,
  type AuditExportRequest,
} from '@voidfall/audit-chain';
import { canonicalJson, sha256Hex } from '@voidfall/authentication';
import {
  validateJob,
  type ActorRef,
  type AuditEvent,
  type Job,
  type JsonObject,
  type ResourceRef,
} from '@voidfall/contracts';
import type { PanelPermission, PanelRole } from '@voidfall/permissions';
import { AgentTransportRepository } from './agent-transport-repositories.js';
import { ArtifactReviewRepository } from './artifact-review-repositories.js';
import { BackupRepository } from './backup-repositories.js';
import { ScheduleRepository } from './schedule-repositories.js';
import { TelemetryRepository } from './telemetry-repositories.js';
import { WorkspaceReleaseRepository } from './workspace-release-repositories.js';
import { WorkspaceRepository } from './workspace-repositories.js';
import {
  SandboxRunRepository,
  WorkspaceStagingRepository,
} from './workspace-staging-repositories.js';
import { ConsoleRepository } from './console-repositories.js';
import {
  OperationRepository,
  OutboxRepository,
  ProcessStateRepository,
} from './operational-repositories.js';
import { ModCatalogRepository } from './mod-catalog-repositories.js';
import { PlayerIdentityRepository } from './player-identity-repositories.js';
import { PlayerRecordRepository } from './player-record-repositories.js';
import type { Database, SqlClient } from './database.js';
import { appendAuditRecord } from './audit-persistence.js';
import {
  ConfigurationRepository,
  OperationalLockRepository,
} from './configuration-repositories.js';

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

export interface PanelUser {
  readonly id: string;
  readonly emailNormalized: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly status: 'active' | 'disabled' | 'locked';
  readonly failedLoginAttempts: number;
  readonly lockedUntil?: string;
}

interface UserRow {
  readonly id: string;
  readonly email_normalized: string;
  readonly display_name: string;
  readonly password_hash: string;
  readonly status: PanelUser['status'];
  readonly failed_login_attempts: number;
  readonly locked_until: Date | string | null;
}

function mapUser(row: UserRow): PanelUser {
  return {
    id: row.id,
    emailNormalized: row.email_normalized,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    status: row.status,
    failedLoginAttempts: row.failed_login_attempts,
    ...(row.locked_until === null ? {} : { lockedUntil: asIso(row.locked_until) }),
  };
}

export class UserRepository {
  constructor(private readonly database: Database) {}

  async create(input: {
    readonly id?: string;
    readonly email: string;
    readonly displayName: string;
    readonly passwordHash: string;
    readonly roles: readonly PanelRole[];
  }): Promise<PanelUser> {
    const id = input.id ?? randomUUID();
    const email = input.email.trim().toLocaleLowerCase('en-US');
    return this.database.transaction(async (client) => {
      const inserted = await client.query<UserRow>(
        `INSERT INTO panel_users (id, email_normalized, display_name, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email_normalized, display_name, password_hash, status,
                   failed_login_attempts, locked_until`,
        [id, email, input.displayName, input.passwordHash],
      );
      for (const role of input.roles) {
        await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [id, role]);
      }
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('User insert returned no row.');
      return mapUser(row);
    });
  }

  async findByEmail(email: string): Promise<PanelUser | undefined> {
    const result = await this.database.query<UserRow>(
      `SELECT id, email_normalized, display_name, password_hash, status,
              failed_login_attempts, locked_until
       FROM panel_users WHERE email_normalized = $1`,
      [email.trim().toLocaleLowerCase('en-US')],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapUser(row);
  }

  async recordFailedLogin(userId: string, now: Date): Promise<void> {
    await this.database.query(
      `UPDATE panel_users
       SET failed_login_attempts = failed_login_attempts + 1,
           locked_until = CASE WHEN failed_login_attempts + 1 >= 5
             THEN $2::timestamptz + interval '15 minutes' ELSE locked_until END,
           status = CASE WHEN failed_login_attempts + 1 >= 5 THEN 'locked' ELSE status END,
           updated_at = $2
       WHERE id = $1`,
      [userId, now.toISOString()],
    );
  }

  async recordSuccessfulLogin(userId: string, now: Date): Promise<void> {
    await this.database.query(
      `UPDATE panel_users SET failed_login_attempts = 0, locked_until = NULL,
         status = 'active', last_login_at = $2, updated_at = $2 WHERE id = $1`,
      [userId, now.toISOString()],
    );
  }
}

export interface ActiveSession {
  readonly id: string;
  readonly userId: string;
  readonly csrfTokenHash: string;
  /** The token as issued, so a reloaded page can present it again. */
  readonly csrfToken: string | null;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
  readonly user: Pick<PanelUser, 'id' | 'emailNormalized' | 'displayName' | 'status'>;
}

interface SessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly csrf_token_hash: string;
  readonly csrf_token: string | null;
  readonly expires_at: Date | string;
  readonly idle_expires_at: Date | string;
  readonly email_normalized: string;
  readonly display_name: string;
  readonly user_status: PanelUser['status'];
}

export class SessionRepository {
  constructor(private readonly database: Database) {}

  async create(input: {
    readonly id?: string;
    readonly userId: string;
    readonly tokenHash: string;
    readonly csrfTokenHash: string;
    /** Stored as issued: see migration 0017 for why this one is not hashed. */
    readonly csrfToken: string;
    readonly now: Date;
    readonly expiresAt: Date;
    readonly idleExpiresAt: Date;
    readonly ipPrefix?: string;
    readonly userAgentHash?: string;
  }): Promise<string> {
    const id = input.id ?? randomUUID();
    await this.database.query(
      `INSERT INTO sessions (
         id, user_id, token_hash, csrf_token_hash, csrf_token, created_at, expires_at,
         idle_expires_at, last_seen_at, ip_prefix, user_agent_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$6,$9,$10)`,
      [
        id,
        input.userId,
        input.tokenHash,
        input.csrfTokenHash,
        input.csrfToken,
        input.now.toISOString(),
        input.expiresAt.toISOString(),
        input.idleExpiresAt.toISOString(),
        input.ipPrefix ?? null,
        input.userAgentHash ?? null,
      ],
    );
    return id;
  }

  async findActive(tokenHash: string, now: Date): Promise<ActiveSession | undefined> {
    const result = await this.database.query<SessionRow>(
      `SELECT s.id, s.user_id, s.csrf_token_hash, s.csrf_token, s.expires_at, s.idle_expires_at,
              u.email_normalized, u.display_name, u.status AS user_status
       FROM sessions s JOIN panel_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL
         AND s.expires_at > $2 AND s.idle_expires_at > $2 AND u.status = 'active'`,
      [tokenHash, now.toISOString()],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      userId: row.user_id,
      csrfTokenHash: row.csrf_token_hash,
      csrfToken: row.csrf_token,
      expiresAt: asIso(row.expires_at),
      idleExpiresAt: asIso(row.idle_expires_at),
      user: {
        id: row.user_id,
        emailNormalized: row.email_normalized,
        displayName: row.display_name,
        status: row.user_status,
      },
    };
  }

  async touch(sessionId: string, now: Date, idleExpiresAt: Date): Promise<void> {
    await this.database.query(
      `UPDATE sessions SET last_seen_at = $2, idle_expires_at = LEAST(expires_at, $3)
       WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, now.toISOString(), idleExpiresAt.toISOString()],
    );
  }

  async revoke(sessionId: string, now: Date): Promise<void> {
    await this.database.query(
      'UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL',
      [sessionId, now.toISOString()],
    );
  }
}

export class PermissionRepository {
  constructor(private readonly database: Database) {}

  async forUser(userId: string): Promise<readonly PanelPermission[]> {
    const result = await this.database.query<{ readonly permission_id: PanelPermission }>(
      `SELECT DISTINCT rp.permission_id
       FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id = $1 ORDER BY rp.permission_id`,
      [userId],
    );
    return result.rows.map((row) => row.permission_id);
  }
}

export interface ServerInstance {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly environment: 'local' | 'test' | 'staging' | 'production';
  readonly desiredState: string;
  readonly observedState: string;
  readonly minecraftVersion: string;
  readonly loader: string;
  readonly loaderVersion: string;
  readonly maxPlayers: number;
  readonly version: number;
}

interface ServerRow {
  readonly id: string;
  readonly slug: string;
  readonly display_name: string;
  readonly environment: ServerInstance['environment'];
  readonly desired_state: string;
  readonly observed_state: string;
  readonly minecraft_version: string;
  readonly loader: string;
  readonly loader_version: string;
  readonly max_players: number;
  readonly version: number;
}

function mapServer(row: ServerRow): ServerInstance {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    environment: row.environment,
    desiredState: row.desired_state,
    observedState: row.observed_state,
    minecraftVersion: row.minecraft_version,
    loader: row.loader,
    loaderVersion: row.loader_version,
    maxPlayers: row.max_players,
    version: row.version,
  };
}

export class ServerRepository {
  constructor(private readonly database: Database) {}

  async create(input: Omit<ServerInstance, 'desiredState' | 'observedState' | 'version'>): Promise<ServerInstance> {
    const result = await this.database.query<ServerRow>(
      `INSERT INTO server_instances (
         id, slug, display_name, environment, minecraft_version, loader, loader_version, max_players
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, slug, display_name, environment, desired_state, observed_state,
                 minecraft_version, loader, loader_version, max_players, version`,
      [
        input.id,
        input.slug,
        input.displayName,
        input.environment,
        input.minecraftVersion,
        input.loader,
        input.loaderVersion,
        input.maxPlayers,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Server insert returned no row.');
    return mapServer(row);
  }

  async list(): Promise<readonly ServerInstance[]> {
    const result = await this.database.query<ServerRow>(
      `SELECT id, slug, display_name, environment, desired_state, observed_state,
              minecraft_version, loader, loader_version, max_players, version
       FROM server_instances ORDER BY display_name, id`,
    );
    return result.rows.map(mapServer);
  }

  async findById(id: string): Promise<ServerInstance | undefined> {
    const result = await this.database.query<ServerRow>(
      `SELECT id, slug, display_name, environment, desired_state, observed_state,
              minecraft_version, loader, loader_version, max_players, version
       FROM server_instances WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapServer(row);
  }
}

interface AuditEventRow {
  readonly id: string;
  readonly occurred_at: Date | string;
  readonly correlation_id: string;
  readonly actor: ActorRef | string;
  readonly source: AuditEvent['source'];
  readonly action: string;
  readonly resource: ResourceRef | string;
  readonly outcome: AuditEvent['outcome'];
  readonly reason: string | null;
  readonly before_redacted: JsonObject | string | null;
  readonly after_redacted: JsonObject | string | null;
  readonly metadata_redacted: JsonObject | string | null;
  readonly previous_hash: string | null;
  readonly integrity_hash: string | null;
}

function mapAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    schemaVersion: 1,
    id: row.id,
    occurredAt: asIso(row.occurred_at),
    correlationId: row.correlation_id,
    actor: parseJson(row.actor),
    source: row.source,
    action: row.action,
    resource: parseJson(row.resource),
    outcome: row.outcome,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.before_redacted === null ? {} : { before: parseJson(row.before_redacted) }),
    ...(row.after_redacted === null ? {} : { after: parseJson(row.after_redacted) }),
    ...(row.metadata_redacted === null ? {} : { metadata: parseJson(row.metadata_redacted) }),
    ...(row.integrity_hash === null
      ? {}
      : { integrity: { previousHash: row.previous_hash, eventHash: row.integrity_hash } }),
  };
}

export class AuditRepository {
  constructor(private readonly database: Database) {}

  async append(event: AuditEvent, partitionId = 'administrative'): Promise<AuditChainRecord> {
    return this.database.transaction((client) => appendAuditRecord(client, event, partitionId));
  }

  async list(limit = 100): Promise<readonly AuditEvent[]> {
    const result = await this.database.query<AuditEventRow>(
      `SELECT id, occurred_at, correlation_id, actor, source, action, resource, outcome,
              reason, before_redacted, after_redacted, metadata_redacted, previous_hash, integrity_hash
       FROM audit_events ORDER BY occurred_at DESC, id DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows.map(mapAuditEvent);
  }

  /**
   * Bounded, filterable listing for the administrative screens.
   *
   * The limit is clamped in the repository as well as at the route, so no
   * caller — including a future internal one — can ask for an unbounded scan
   * of the audit chain.
   */
  async listPage(input: {
    readonly limit: number;
    readonly offset: number;
    readonly correlationId?: string;
    readonly action?: string;
    readonly outcome?: AuditEvent['outcome'];
  }): Promise<{ readonly events: readonly AuditEvent[]; readonly total: number }> {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
    const offset = Math.min(Math.max(Math.trunc(input.offset), 0), 1_000_000);
    const parameters: unknown[] = [];
    let clause = '';
    if (input.correlationId !== undefined) {
      parameters.push(input.correlationId);
      clause += ` AND correlation_id = $${parameters.length}`;
    }
    if (input.action !== undefined) {
      parameters.push(input.action);
      clause += ` AND action = $${parameters.length}`;
    }
    if (input.outcome !== undefined) {
      parameters.push(input.outcome);
      clause += ` AND outcome = $${parameters.length}`;
    }

    const total = await this.database.query<{ readonly count: string | number }>(
      `SELECT COUNT(*) AS count FROM audit_events WHERE TRUE${clause}`,
      parameters,
    );
    const rows = await this.database.query<AuditEventRow>(
      `SELECT id, occurred_at, correlation_id, actor, source, action, resource, outcome,
              reason, before_redacted, after_redacted, metadata_redacted, previous_hash, integrity_hash
       FROM audit_events WHERE TRUE${clause}
       ORDER BY occurred_at DESC, id DESC
       LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, limit, offset],
    );
    return {
      events: rows.rows.map(mapAuditEvent),
      total: Number(total.rows[0]?.count ?? 0),
    };
  }

  async listChain(
    partitionId: string,
    firstSequence: number,
    lastSequence: number,
  ): Promise<readonly AuditChainRecord[]> {
    if (
      !Number.isSafeInteger(firstSequence) ||
      !Number.isSafeInteger(lastSequence) ||
      firstSequence < 1 ||
      lastSequence < firstSequence ||
      lastSequence - firstSequence + 1 > 100_000
    ) {
      throw new Error('Invalid audit chain range.');
    }
    const result = await this.database.query<{
      readonly id: string;
      readonly occurred_at: Date | string;
      readonly correlation_id: string;
      readonly actor: ActorRef | string;
      readonly source: AuditEvent['source'];
      readonly action: string;
      readonly resource: ResourceRef | string;
      readonly outcome: AuditEvent['outcome'];
      readonly reason: string | null;
      readonly before_redacted: JsonObject | string | null;
      readonly after_redacted: JsonObject | string | null;
      readonly metadata_redacted: JsonObject | string | null;
      readonly previous_hash: string | null;
      readonly integrity_hash: string;
      readonly partition_id: string;
      readonly chain_sequence: number | string;
    }>(
      `SELECT id, occurred_at, correlation_id, actor, source, action, resource, outcome,
              reason, before_redacted, after_redacted, metadata_redacted, previous_hash,
              integrity_hash, partition_id, chain_sequence
       FROM audit_events
       WHERE partition_id = $1 AND chain_sequence BETWEEN $2 AND $3
       ORDER BY chain_sequence ASC`,
      [partitionId, firstSequence, lastSequence],
    );
    return result.rows.map((row) => ({
      partitionId: row.partition_id,
      sequence: Number(row.chain_sequence),
      event: {
        schemaVersion: 1,
        id: row.id,
        occurredAt: asIso(row.occurred_at),
        correlationId: row.correlation_id,
        actor: parseJson(row.actor),
        source: row.source,
        action: row.action,
        resource: parseJson(row.resource),
        outcome: row.outcome,
        ...(row.reason === null ? {} : { reason: row.reason }),
        ...(row.before_redacted === null ? {} : { before: parseJson(row.before_redacted) }),
        ...(row.after_redacted === null ? {} : { after: parseJson(row.after_redacted) }),
        ...(row.metadata_redacted === null ? {} : { metadata: parseJson(row.metadata_redacted) }),
        integrity: { previousHash: row.previous_hash, eventHash: row.integrity_hash },
      },
    }));
  }

  async verifyPartition(partitionId: string): Promise<AuditChainVerificationResult> {
    const lastSequence = await this.#lastSequence(partitionId);
    if (lastSequence === 0) return verifyAuditChain([]);
    if (lastSequence > 100_000) throw new Error('Audit partition exceeds verification limit.');
    return verifyAuditChain(await this.listChain(partitionId, 1, lastSequence));
  }

  async exportPartition(
    partitionId: string,
    request: AuditExportRequest,
  ): Promise<AuditExportArtifact> {
    const headSequence = await this.#lastSequence(partitionId);
    const firstSequence = request.firstSequence ?? 1;
    const lastSequence = request.lastSequence ?? headSequence;
    const records = await this.listChain(partitionId, firstSequence, lastSequence);
    return createAuditExport(records, request);
  }

  async #lastSequence(partitionId: string): Promise<number> {
    const result = await this.database.query<{ readonly last_sequence: number | string }>(
      'SELECT last_sequence FROM audit_chain_heads WHERE partition_id = $1',
      [partitionId],
    );
    return Number(result.rows[0]?.last_sequence ?? 0);
  }

}

export interface RegisteredAgent {
  readonly id: string;
  readonly serverInstanceId: string;
  readonly publicKeyPem: string;
  readonly certificateFingerprint: string;
  readonly status: string;
  readonly softwareVersion: string;
  readonly protocolVersion: number;
  readonly capabilities: readonly string[];
  readonly lastSeenAt?: string;
}

interface AgentRow {
  readonly id: string;
  readonly server_instance_id: string;
  readonly public_key_pem: string;
  readonly certificate_fingerprint: string;
  readonly status: string;
  readonly software_version: string;
  readonly protocol_version: number;
  readonly capabilities: readonly string[] | string;
  readonly last_seen_at: Date | string | null;
}

function mapAgent(row: AgentRow): RegisteredAgent {
  return {
    id: row.id,
    serverInstanceId: row.server_instance_id,
    publicKeyPem: row.public_key_pem,
    certificateFingerprint: row.certificate_fingerprint,
    status: row.status,
    softwareVersion: row.software_version,
    protocolVersion: row.protocol_version,
    capabilities: parseJson(row.capabilities),
    ...(row.last_seen_at === null ? {} : { lastSeenAt: asIso(row.last_seen_at) }),
  };
}

export class AgentRepository {
  constructor(private readonly database: Database) {}

  async createProvisioningToken(input: {
    readonly id?: string;
    readonly serverInstanceId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
    readonly createdAt?: Date;
  }): Promise<string> {
    const id = input.id ?? randomUUID();
    await this.database.query(
      `INSERT INTO agent_provision_tokens (id, server_instance_id, token_hash, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        id,
        input.serverInstanceId,
        input.tokenHash,
        input.expiresAt.toISOString(),
        (input.createdAt ?? new Date()).toISOString(),
      ],
    );
    return id;
  }

  async register(input: {
    readonly agentId: string;
    readonly serverInstanceId: string;
    readonly tokenHash: string;
    readonly publicKeyPem: string;
    readonly certificateFingerprint: string;
    readonly softwareVersion: string;
    readonly capabilities: readonly string[];
    readonly now: Date;
  }): Promise<RegisteredAgent | undefined> {
    return this.database.transaction(async (client) => {
      const token = await client.query<{ readonly id: string }>(
        `SELECT id FROM agent_provision_tokens
         WHERE token_hash = $1 AND server_instance_id = $2 AND used_at IS NULL AND expires_at > $3
         FOR UPDATE`,
        [input.tokenHash, input.serverInstanceId, input.now.toISOString()],
      );
      const tokenRow = token.rows[0];
      if (tokenRow === undefined) return undefined;
      const inserted = await client.query<AgentRow>(
        `INSERT INTO agents (
           id, server_instance_id, public_key_pem, certificate_fingerprint,
           software_version, capabilities
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         RETURNING id, server_instance_id, public_key_pem, certificate_fingerprint,
                   status, software_version, protocol_version, capabilities, last_seen_at`,
        [
          input.agentId,
          input.serverInstanceId,
          input.publicKeyPem,
          input.certificateFingerprint,
          input.softwareVersion,
          JSON.stringify(input.capabilities),
        ],
      );
      await client.query('UPDATE agent_provision_tokens SET used_at = $2 WHERE id = $1', [
        tokenRow.id,
        input.now.toISOString(),
      ]);
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('Agent insert returned no row.');
      return mapAgent(row);
    });
  }

  async findById(agentId: string): Promise<RegisteredAgent | undefined> {
    const result = await this.database.query<AgentRow>(
      `SELECT id, server_instance_id, public_key_pem, certificate_fingerprint,
              status, software_version, protocol_version, capabilities, last_seen_at
       FROM agents WHERE id = $1 AND status <> 'revoked'`,
      [agentId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapAgent(row);
  }

  async consumeNonce(agentId: string, nonceHash: string, expiresAt: Date, now: Date): Promise<boolean> {
    return this.database.transaction(async (client) => {
      await client.query('DELETE FROM agent_nonces WHERE expires_at <= $1', [now.toISOString()]);
      const result = await client.query(
        `INSERT INTO agent_nonces (agent_id, nonce_hash, expires_at)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING nonce_hash`,
        [agentId, nonceHash, expiresAt.toISOString()],
      );
      return result.rowCount === 1;
    });
  }

  /**
   * Publishes what the agent is ready to serve, and why the rest is missing.
   *
   * The agent never listens, so this is how a readiness question gets answered
   * at all: it is published rather than polled. `last_seen_at` moves with it
   * because an agent that just wrote this is, definitionally, here.
   *
   * Announcing is not authorizing. What lands here describes the host; whether
   * the control plane will lease any of it is decided elsewhere.
   */
  async publishReadiness(input: {
    readonly agentId: string;
    readonly status: 'online' | 'degraded';
    readonly capabilities: readonly string[];
    readonly readiness: readonly {
      readonly capability: string;
      readonly available: boolean;
      readonly reason: string | null;
    }[];
    readonly observedAt: Date;
  }): Promise<void> {
    await this.database.query(
      `UPDATE agents SET status = $2, capabilities = $3::jsonb, readiness = $4::jsonb,
         readiness_published_at = $5, last_seen_at = $5, updated_at = $5 WHERE id = $1`,
      [
        input.agentId,
        input.status,
        JSON.stringify([...input.capabilities]),
        JSON.stringify([...input.readiness]),
        input.observedAt.toISOString(),
      ],
    );
  }

  async recordHeartbeat(input: {
    readonly agentId: string;
    readonly status: 'online' | 'degraded';
    readonly softwareVersion: string;
    readonly protocolVersion: number;
    readonly capabilities: readonly string[];
    readonly observedAt: Date;
  }): Promise<void> {
    await this.database.query(
      `UPDATE agents SET status = $2, software_version = $3, protocol_version = $4,
         capabilities = $5::jsonb, last_seen_at = $6, updated_at = $6 WHERE id = $1`,
      [
        input.agentId,
        input.status,
        input.softwareVersion,
        input.protocolVersion,
        JSON.stringify(input.capabilities),
        input.observedAt.toISOString(),
      ],
    );
  }
}

interface JobRow {
  readonly id: string;
  readonly type: Job['type'];
  readonly resource_type: string;
  readonly resource_id: string;
  readonly status: Job['status'];
  readonly stage: string;
  readonly priority: number;
  readonly payload: Job['payload'] | string;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly requested_by: ActorRef | string;
  readonly available_at: Date | string;
  readonly lease_owner: string | null;
  readonly lease_acquired_at: Date | string | null;
  readonly lease_expires_at: Date | string | null;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly cancel_requested_at: Date | string | null;
  readonly started_at: Date | string | null;
  readonly finished_at: Date | string | null;
  readonly result: JsonObject | string | null;
  readonly error: NonNullable<Job['error']> | string | null;
  readonly correlation_id: string;
}

function mapJob(row: JobRow): Job {
  const job: Job = {
    schemaVersion: 1,
    id: row.id,
    type: row.type,
    resource: { type: row.resource_type, id: row.resource_id },
    status: row.status,
    stage: row.stage,
    priority: row.priority,
    payload: parseJson(row.payload),
    idempotencyKey: row.idempotency_key,
    requestedBy: parseJson(row.requested_by),
    correlationId: row.correlation_id,
    availableAt: asIso(row.available_at),
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    ...(row.lease_owner === null || row.lease_acquired_at === null || row.lease_expires_at === null
      ? {}
      : {
          lease: {
            ownerId: row.lease_owner,
            acquiredAt: asIso(row.lease_acquired_at),
            expiresAt: asIso(row.lease_expires_at),
          },
        }),
    ...(row.cancel_requested_at === null ? {} : { cancelRequestedAt: asIso(row.cancel_requested_at) }),
    ...(row.started_at === null ? {} : { startedAt: asIso(row.started_at) }),
    ...(row.finished_at === null ? {} : { finishedAt: asIso(row.finished_at) }),
    ...(row.result === null ? {} : { result: parseJson(row.result) }),
    ...(row.error === null ? {} : { error: parseJson(row.error) }),
  };
  const validation = validateJob(job);
  if (!validation.success) throw new Error('Database returned an invalid job contract.');
  return job;
}

export class JobRepository {
  constructor(private readonly database: Database) {}

  async enqueue(job: Job): Promise<Job> {
    const validation = validateJob(job);
    if (!validation.success || job.status !== 'queued' || job.lease !== undefined) {
      throw new Error('Only a valid, unleased queued job can be enqueued.');
    }
    const fingerprint = sha256Hex(
      canonicalJson({
        type: job.type,
        resource: job.resource,
        payload: job.payload,
        requestedBy: job.requestedBy,
      }),
    );
    const inserted = await this.database.query<JobRow>(
      `INSERT INTO jobs (
         id, type, resource_type, resource_id, status, stage, priority, payload,
         idempotency_key, request_fingerprint, requested_by, available_at,
         attempt, max_attempts, correlation_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12,$13,$14,$15)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        job.id,
        job.type,
        job.resource.type,
        job.resource.id,
        job.status,
        job.stage,
        job.priority,
        JSON.stringify(job.payload),
        job.idempotencyKey,
        fingerprint,
        JSON.stringify(job.requestedBy),
        job.availableAt,
        job.attempt,
        job.maxAttempts,
        job.correlationId,
      ],
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow !== undefined) return mapJob(insertedRow);
    const existing = await this.database.query<JobRow>(
      'SELECT * FROM jobs WHERE idempotency_key = $1',
      [job.idempotencyKey],
    );
    const existingRow = existing.rows[0];
    if (existingRow === undefined || existingRow.request_fingerprint !== fingerprint) {
      throw new Error('Idempotency key was reused for a different request.');
    }
    return mapJob(existingRow);
  }

  async lease(input: {
    readonly workerId: string;
    readonly acceptedTypes: readonly Job['type'][];
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<Job | undefined> {
    if (input.acceptedTypes.length === 0) return undefined;
    const expiresAt = new Date(input.now.getTime() + input.leaseMs);
    const result = await this.database.query<JobRow>(
      `WITH candidate AS (
         SELECT id FROM jobs
         WHERE status = 'queued' AND available_at <= $1
           AND type = ANY($2::text[]) AND attempt < max_attempts
         ORDER BY priority DESC, available_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE jobs SET status = 'running', stage = 'leased', lease_owner = $3,
         lease_acquired_at = $1, lease_expires_at = $4,
         attempt = attempt + 1, started_at = COALESCE(started_at, $1), updated_at = $1
       WHERE id = (SELECT id FROM candidate)
       RETURNING *`,
      [input.now.toISOString(), input.acceptedTypes, input.workerId, expiresAt.toISOString()],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapJob(row);
  }

  async renew(jobId: string, workerId: string, now: Date, leaseMs: number): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + leaseMs);
    const result = await this.database.query(
      `UPDATE jobs SET lease_expires_at = $4, updated_at = $3
       WHERE id = $1 AND lease_owner = $2 AND status = 'running' AND lease_expires_at > $3`,
      [jobId, workerId, now.toISOString(), expiresAt.toISOString()],
    );
    return result.rowCount === 1;
  }

  async complete(jobId: string, workerId: string, resultValue: JsonObject, now: Date): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE jobs SET status = 'succeeded', stage = 'completed', result = $4::jsonb,
         finished_at = $3, updated_at = $3, lease_owner = NULL,
         lease_acquired_at = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
      [jobId, workerId, now.toISOString(), JSON.stringify(resultValue)],
    );
    return result.rowCount === 1;
  }

  async fail(
    jobId: string,
    workerId: string,
    errorValue: NonNullable<Job['error']>,
    now: Date,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE jobs SET status = 'failed', stage = 'failed', error = $4::jsonb,
         finished_at = $3, updated_at = $3, lease_owner = NULL,
         lease_acquired_at = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
      [jobId, workerId, now.toISOString(), JSON.stringify(errorValue)],
    );
    return result.rowCount === 1;
  }

  async appendEvent(input: {
    readonly jobId: string;
    readonly stage: string;
    readonly level: 'debug' | 'info' | 'warn' | 'error' | 'critical';
    readonly message: string;
    readonly occurredAt: Date;
    readonly metadata?: JsonObject;
  }): Promise<number> {
    return this.database.transaction(async (client: SqlClient) => {
      const locked = await client.query('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [input.jobId]);
      if (locked.rowCount !== 1) throw new Error('Cannot append an event to an unknown job.');
      const next = await client.query<{ readonly sequence: number }>(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM job_events WHERE job_id = $1',
        [input.jobId],
      );
      const sequence = Number(next.rows[0]?.sequence ?? 1);
      await client.query(
        `INSERT INTO job_events (job_id, sequence, stage, level, message, occurred_at, metadata_redacted)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          input.jobId,
          sequence,
          input.stage,
          input.level,
          input.message,
          input.occurredAt.toISOString(),
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      return sequence;
    });
  }

  async findById(jobId: string): Promise<Job | undefined> {
    const result = await this.database.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [jobId]);
    const row = result.rows[0];
    return row === undefined ? undefined : mapJob(row);
  }
}

export interface Repositories {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly permissions: PermissionRepository;
  readonly servers: ServerRepository;
  readonly audit: AuditRepository;
  readonly agents: AgentRepository;
  readonly jobs: JobRepository;
  readonly configuration: ConfigurationRepository;
  readonly operationalLocks: OperationalLockRepository;
  readonly artifactReview: ArtifactReviewRepository;
  readonly operations: OperationRepository;
  readonly processStates: ProcessStateRepository;
  readonly outbox: OutboxRepository;
  readonly modCatalog: ModCatalogRepository;
  readonly agentTransport: AgentTransportRepository;
  readonly console: ConsoleRepository;
  readonly backups: BackupRepository;
  readonly telemetry: TelemetryRepository;
  readonly schedules: ScheduleRepository;
  readonly playerIdentities: PlayerIdentityRepository;
  readonly playerRecords: PlayerRecordRepository;
  readonly workspaces: WorkspaceRepository;
  readonly workspaceStaging: WorkspaceStagingRepository;
  readonly sandboxRuns: SandboxRunRepository;
  readonly releases: WorkspaceReleaseRepository;
}

export function createRepositories(database: Database): Repositories {
  return {
    users: new UserRepository(database),
    sessions: new SessionRepository(database),
    permissions: new PermissionRepository(database),
    servers: new ServerRepository(database),
    audit: new AuditRepository(database),
    agents: new AgentRepository(database),
    jobs: new JobRepository(database),
    configuration: new ConfigurationRepository(database),
    operationalLocks: new OperationalLockRepository(database),
    artifactReview: new ArtifactReviewRepository(database),
    operations: new OperationRepository(database),
    processStates: new ProcessStateRepository(database),
    outbox: new OutboxRepository(database),
    modCatalog: new ModCatalogRepository(database),
    agentTransport: new AgentTransportRepository(database),
    console: new ConsoleRepository(database),
    backups: new BackupRepository(database),
    telemetry: new TelemetryRepository(database),
    schedules: new ScheduleRepository(database),
    playerIdentities: new PlayerIdentityRepository(database),
    playerRecords: new PlayerRecordRepository(database),
    workspaces: new WorkspaceRepository(database),
    workspaceStaging: new WorkspaceStagingRepository(database),
    sandboxRuns: new SandboxRunRepository(database),
    releases: new WorkspaceReleaseRepository(database),
  };
}
