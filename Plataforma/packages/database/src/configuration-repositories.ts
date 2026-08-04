import {
  VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY,
  freezeConfigurationSchema,
  hashConfigurationSchema,
  type GenericConfigurationSchema,
} from '@voidfall/configuration-schemas';
import type { ActorRef, AuditEvent } from '@voidfall/contracts';

import { appendAuditRecord } from './audit-persistence.js';
import type { Database, SqlClient } from './database.js';

const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/u;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ACTOR_TYPES = new Set<ActorRef['type']>([
  'panel-user',
  'minecraft-player',
  'agent',
  'worker',
  'system',
]);

export type ConfigurationPersistenceErrorCode =
  | 'invalid-input'
  | 'schema-not-reviewed'
  | 'schema-not-found'
  | 'schema-conflict'
  | 'resource-not-found'
  | 'resource-conflict'
  | 'revision-conflict'
  | 'concurrent-modification'
  | 'invalid-transition'
  | 'lock-unavailable';

export class ConfigurationPersistenceError extends Error {
  public readonly code: ConfigurationPersistenceErrorCode;

  public constructor(code: ConfigurationPersistenceErrorCode) {
    super(`configuration-persistence:${code}`);
    this.name = 'ConfigurationPersistenceError';
    this.code = code;
  }
}

export interface PersistedConfigurationSchemaRevision {
  readonly revisionId: string;
  readonly schema: GenericConfigurationSchema;
  readonly previousSchemaSha256: string | null;
  readonly schemaSha256: string;
  readonly actorId: string;
  readonly reasonCode: string;
  readonly createdAt: string;
  readonly headVersion: number;
}

export interface PersistedConfigurationResource {
  readonly serverInstanceId: string;
  readonly resourceId: string;
  readonly schemaId: string;
  readonly schemaSha256: string;
  readonly relativeFilePath: string;
  readonly maximumBytes: number;
  readonly applyMode: 'offline-only';
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ConfigurationApplicationStatus =
  | 'registered'
  | 'prepared'
  | 'applied'
  | 'failed';

export interface ConfigurationApplicationState {
  readonly serverInstanceId: string;
  readonly resourceId: string;
  readonly status: ConfigurationApplicationStatus;
  readonly currentSha256: string;
  readonly pendingRevisionId: string | null;
  readonly lastAppliedRevisionId: string | null;
  readonly lastFailedRevisionId: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

export type PersistedConfigurationOperation = 'update' | 'rollback';
export type PersistedConfigurationRevisionStatus = 'prepared' | 'applied' | 'failed';

export interface PersistedConfigurationRevision {
  readonly revisionId: string;
  readonly serverInstanceId: string;
  readonly resourceId: string;
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly schemaSha256: string;
  readonly operation: PersistedConfigurationOperation;
  readonly sourceRevisionId: string | null;
  readonly status: PersistedConfigurationRevisionStatus;
  readonly expectedCurrentSha256: string;
  readonly previousSha256: string | null;
  readonly currentSha256: string | null;
  readonly manifestSha256: string | null;
  readonly requestedFields: readonly string[];
  readonly changedFields: readonly string[] | null;
  readonly restartRequired: boolean | null;
  readonly actor: ActorRef;
  readonly reasonCode: string;
  readonly correlationId: string;
  readonly failureCode: string | null;
  readonly failureStage: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface PreparedConfigurationOperation {
  readonly revision: PersistedConfigurationRevision;
  readonly state: ConfigurationApplicationState;
  readonly resource: PersistedConfigurationResource;
}

export interface CompletedConfigurationOperation extends PreparedConfigurationOperation {
  readonly auditSequence: number;
}

export interface OperationalLockLease {
  readonly serverInstanceId: string;
  readonly lockName: string;
  readonly ownerId: string;
  readonly operation: string;
  readonly acquiredAt: string;
  readonly leaseExpiresAt: string;
  readonly version: number;
}

interface SchemaHeadRow {
  readonly schema_id: string;
  readonly resource_id: string;
  readonly current_revision_id: string;
  readonly current_schema_version: string;
  readonly current_schema_sha256: string;
  readonly version: number | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface SchemaRevisionRow {
  readonly revision_id: string;
  readonly previous_schema_sha256: string | null;
  readonly schema_sha256: string;
  readonly definition: GenericConfigurationSchema | string;
  readonly actor_id: string;
  readonly reason_code: string;
  readonly created_at: Date | string;
}

interface ResourceRow {
  readonly server_instance_id: string;
  readonly resource_id: string;
  readonly schema_id: string;
  readonly schema_sha256: string;
  readonly relative_file_path: string;
  readonly maximum_bytes: number;
  readonly apply_mode: 'offline-only';
  readonly version: number | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface StateRow {
  readonly server_instance_id: string;
  readonly resource_id: string;
  readonly status: ConfigurationApplicationStatus;
  readonly current_sha256: string;
  readonly pending_revision_id: string | null;
  readonly last_applied_revision_id: string | null;
  readonly last_failed_revision_id: string | null;
  readonly version: number | string;
  readonly updated_at: Date | string;
}

interface RevisionRow {
  readonly revision_id: string;
  readonly server_instance_id: string;
  readonly resource_id: string;
  readonly schema_id: string;
  readonly schema_version: string;
  readonly schema_sha256: string;
  readonly operation: PersistedConfigurationOperation;
  readonly source_revision_id: string | null;
  readonly status: PersistedConfigurationRevisionStatus;
  readonly expected_current_sha256: string;
  readonly previous_sha256: string | null;
  readonly current_sha256: string | null;
  readonly manifest_sha256: string | null;
  readonly requested_fields: readonly string[] | string;
  readonly changed_fields: readonly string[] | string | null;
  readonly restart_required: boolean | null;
  readonly actor: ActorRef | string;
  readonly reason_code: string;
  readonly correlation_id: string;
  readonly failure_code: string | null;
  readonly failure_stage: string | null;
  readonly version: number | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly completed_at: Date | string | null;
}

interface LockRow {
  readonly server_instance_id: string;
  readonly lock_name: string;
  readonly owner_id: string;
  readonly operation: string;
  readonly acquired_at: Date | string;
  readonly lease_expires_at: Date | string;
  readonly version: number | string;
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new ConfigurationPersistenceError('invalid-input');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ConfigurationPersistenceError('invalid-input');
  }
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new ConfigurationPersistenceError('invalid-input');
  }
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ConfigurationPersistenceError('invalid-input');
  }
  return value;
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new ConfigurationPersistenceError('invalid-input');
  }
  return value;
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ConfigurationPersistenceError('invalid-input');
  }
  return value as number;
}

function actorRef(value: unknown): ActorRef {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'id,type'
  ) {
    throw new ConfigurationPersistenceError('invalid-input');
  }
  const actor = value as Record<string, unknown>;
  if (
    !ACTOR_TYPES.has(actor.type as ActorRef['type']) ||
    typeof actor.id !== 'string' ||
    actor.id.length < 1 ||
    actor.id.length > 128
  ) {
    throw new ConfigurationPersistenceError('invalid-input');
  }
  return Object.freeze({ type: actor.type as ActorRef['type'], id: actor.id });
}

function stringList(value: unknown, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 256) {
    throw new ConfigurationPersistenceError('invalid-input');
  }
  const result = value
    .map((item) => {
      if (typeof item !== 'string' || !FIELD_NAME.test(item)) {
        throw new ConfigurationPersistenceError('invalid-input');
      }
      return item;
    })
    .sort();
  if (new Set(result).size !== result.length) {
    throw new ConfigurationPersistenceError('invalid-input');
  }
  return Object.freeze(result);
}

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function mapResource(row: ResourceRow): PersistedConfigurationResource {
  return Object.freeze({
    serverInstanceId: row.server_instance_id,
    resourceId: row.resource_id,
    schemaId: row.schema_id,
    schemaSha256: row.schema_sha256,
    relativeFilePath: row.relative_file_path,
    maximumBytes: row.maximum_bytes,
    applyMode: row.apply_mode,
    version: Number(row.version),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  });
}

function mapState(row: StateRow): ConfigurationApplicationState {
  return Object.freeze({
    serverInstanceId: row.server_instance_id,
    resourceId: row.resource_id,
    status: row.status,
    currentSha256: row.current_sha256,
    pendingRevisionId: row.pending_revision_id,
    lastAppliedRevisionId: row.last_applied_revision_id,
    lastFailedRevisionId: row.last_failed_revision_id,
    version: Number(row.version),
    updatedAt: asIso(row.updated_at),
  });
}

function mapRevision(row: RevisionRow): PersistedConfigurationRevision {
  return Object.freeze({
    revisionId: row.revision_id,
    serverInstanceId: row.server_instance_id,
    resourceId: row.resource_id,
    schemaId: row.schema_id,
    schemaVersion: row.schema_version,
    schemaSha256: row.schema_sha256,
    operation: row.operation,
    sourceRevisionId: row.source_revision_id,
    status: row.status,
    expectedCurrentSha256: row.expected_current_sha256,
    previousSha256: row.previous_sha256,
    currentSha256: row.current_sha256,
    manifestSha256: row.manifest_sha256,
    requestedFields: Object.freeze([...parseJson<readonly string[]>(row.requested_fields)]),
    changedFields:
      row.changed_fields === null
        ? null
        : Object.freeze([...parseJson<readonly string[]>(row.changed_fields)]),
    restartRequired: row.restart_required,
    actor: Object.freeze({ ...parseJson<ActorRef>(row.actor) }),
    reasonCode: row.reason_code,
    correlationId: row.correlation_id,
    failureCode: row.failure_code,
    failureStage: row.failure_stage,
    version: Number(row.version),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    completedAt: row.completed_at === null ? null : asIso(row.completed_at),
  });
}

function mapLock(row: LockRow): OperationalLockLease {
  return Object.freeze({
    serverInstanceId: row.server_instance_id,
    lockName: row.lock_name,
    ownerId: row.owner_id,
    operation: row.operation,
    acquiredAt: asIso(row.acquired_at),
    leaseExpiresAt: asIso(row.lease_expires_at),
    version: Number(row.version),
  });
}

const RESOURCE_COLUMNS = `server_instance_id, resource_id, schema_id, schema_sha256,
  relative_file_path, maximum_bytes, apply_mode, version, created_at, updated_at`;
const STATE_COLUMNS = `server_instance_id, resource_id, status, current_sha256,
  pending_revision_id, last_applied_revision_id, last_failed_revision_id, version, updated_at`;
const REVISION_COLUMNS = `revision_id, server_instance_id, resource_id, schema_id,
  schema_version, schema_sha256, operation, source_revision_id, status,
  expected_current_sha256, previous_sha256, current_sha256, manifest_sha256,
  requested_fields, changed_fields, restart_required, actor, reason_code, correlation_id,
  failure_code, failure_stage, version, created_at, updated_at, completed_at`;

export class ConfigurationRepository {
  public constructor(private readonly database: Database) {}

  public async registerSchema(input: {
    readonly revisionId: string;
    readonly actorId: string;
    readonly reasonCode: string;
    readonly createdAt: string;
    readonly expectedSchemaSha256: string | null;
    readonly schema: GenericConfigurationSchema;
  }): Promise<PersistedConfigurationSchemaRevision> {
    const revisionId = identifier(input.revisionId);
    const actorId = uuid(input.actorId);
    const reasonCode = identifier(input.reasonCode);
    const createdAt = canonicalTimestamp(input.createdAt);
    const expected = input.expectedSchemaSha256 === null ? null : sha256(input.expectedSchemaSha256);
    const schema = freezeConfigurationSchema(input.schema);
    const schemaSha256 = hashConfigurationSchema(schema);
    let reviewed;
    try {
      reviewed = VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY.require(schema.resourceId);
    } catch {
      throw new ConfigurationPersistenceError('schema-not-reviewed');
    }
    if (
      reviewed.schema.schemaId !== schema.schemaId ||
      reviewed.schemaSha256 !== schemaSha256
    ) {
      throw new ConfigurationPersistenceError('schema-not-reviewed');
    }

    try {
      return await this.database.transaction(async (client) => {
        const existingRevision = await client.query(
          'SELECT revision_id FROM configuration_schema_revisions WHERE revision_id = $1',
          [revisionId],
        );
        if (existingRevision.rowCount > 0) {
          throw new ConfigurationPersistenceError('revision-conflict');
        }
        const headResult = await client.query<SchemaHeadRow>(
          `SELECT schema_id, resource_id, current_revision_id, current_schema_version,
                  current_schema_sha256, version, created_at, updated_at
           FROM configuration_schemas WHERE schema_id = $1 FOR UPDATE`,
          [schema.schemaId],
        );
        const head = headResult.rows[0];
        if (head === undefined) {
          if (expected !== null) throw new ConfigurationPersistenceError('schema-conflict');
          await client.query(
            `INSERT INTO configuration_schemas (
               schema_id, resource_id, current_revision_id, current_schema_version,
               current_schema_sha256, version, created_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,1,$6,$6)`,
            [
              schema.schemaId,
              schema.resourceId,
              revisionId,
              schema.schemaVersion,
              schemaSha256,
              createdAt,
            ],
          );
        } else {
          if (head.resource_id !== schema.resourceId) {
            throw new ConfigurationPersistenceError('schema-conflict');
          }
          if (expected === null || head.current_schema_sha256 !== expected) {
            throw new ConfigurationPersistenceError('concurrent-modification');
          }
          if (head.current_schema_sha256 === schemaSha256) {
            throw new ConfigurationPersistenceError('schema-conflict');
          }
          const updated = await client.query(
            `UPDATE configuration_schemas
             SET current_revision_id = $2, current_schema_version = $3,
                 current_schema_sha256 = $4, version = version + 1, updated_at = $5
             WHERE schema_id = $1 AND version = $6`,
            [
              schema.schemaId,
              revisionId,
              schema.schemaVersion,
              schemaSha256,
              createdAt,
              Number(head.version),
            ],
          );
          if (updated.rowCount !== 1) {
            throw new ConfigurationPersistenceError('concurrent-modification');
          }
        }
        await client.query(
          `INSERT INTO configuration_schema_revisions (
             revision_id, schema_id, schema_version, previous_schema_sha256,
             schema_sha256, definition, actor_id, reason_code, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
          [
            revisionId,
            schema.schemaId,
            schema.schemaVersion,
            expected,
            schemaSha256,
            JSON.stringify(schema),
            actorId,
            reasonCode,
            createdAt,
          ],
        );
        const finalHead = await client.query<SchemaHeadRow>(
          `SELECT schema_id, resource_id, current_revision_id, current_schema_version,
                  current_schema_sha256, version, created_at, updated_at
           FROM configuration_schemas WHERE schema_id = $1`,
          [schema.schemaId],
        );
        const version = Number(finalHead.rows[0]?.version ?? 1);
        return Object.freeze({
          revisionId,
          schema,
          previousSchemaSha256: expected,
          schemaSha256,
          actorId,
          reasonCode,
          createdAt,
          headVersion: version,
        });
      });
    } catch (error) {
      if (error instanceof ConfigurationPersistenceError) throw error;
      throw new ConfigurationPersistenceError('concurrent-modification');
    }
  }

  public async currentSchema(
    schemaIdInput: string,
  ): Promise<PersistedConfigurationSchemaRevision | undefined> {
    const schemaId = identifier(schemaIdInput);
    const result = await this.database.query<SchemaHeadRow & SchemaRevisionRow>(
      `SELECT h.schema_id, h.resource_id, h.current_revision_id, h.current_schema_version,
              h.current_schema_sha256, h.version, h.created_at, h.updated_at,
              r.revision_id, r.previous_schema_sha256, r.schema_sha256, r.definition,
              r.actor_id, r.reason_code, r.created_at AS revision_created_at
       FROM configuration_schemas h
       JOIN configuration_schema_revisions r ON r.revision_id = h.current_revision_id
       WHERE h.schema_id = $1`,
      [schemaId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const definition = freezeConfigurationSchema(parseJson(row.definition));
    return Object.freeze({
      revisionId: row.revision_id,
      schema: definition,
      previousSchemaSha256: row.previous_schema_sha256,
      schemaSha256: row.schema_sha256,
      actorId: row.actor_id,
      reasonCode: row.reason_code,
      createdAt: asIso((row as unknown as { revision_created_at: Date | string }).revision_created_at),
      headVersion: Number(row.version),
    });
  }

  public async registerResource(input: {
    readonly serverInstanceId: string;
    readonly resourceId: string;
    readonly expectedSchemaSha256: string;
    readonly initialCurrentSha256: string;
    readonly createdAt: string;
  }): Promise<{ readonly resource: PersistedConfigurationResource; readonly state: ConfigurationApplicationState }> {
    const serverInstanceId = uuid(input.serverInstanceId);
    const resourceId = identifier(input.resourceId);
    const expectedSchemaSha256 = sha256(input.expectedSchemaSha256);
    const initialCurrentSha256 = sha256(input.initialCurrentSha256);
    const createdAt = canonicalTimestamp(input.createdAt);
    let reviewed;
    try {
      reviewed = VOIDFALL_TRUSTED_CONFIGURATION_REGISTRY.require(resourceId);
    } catch {
      throw new ConfigurationPersistenceError('schema-not-reviewed');
    }
    if (reviewed.schemaSha256 !== expectedSchemaSha256) {
      throw new ConfigurationPersistenceError('concurrent-modification');
    }
    try {
      return await this.database.transaction(async (client) => {
        const schemaResult = await client.query<SchemaHeadRow>(
          `SELECT schema_id, resource_id, current_revision_id, current_schema_version,
                  current_schema_sha256, version, created_at, updated_at
           FROM configuration_schemas WHERE schema_id = $1`,
          [reviewed.schema.schemaId],
        );
        const schema = schemaResult.rows[0];
        if (schema === undefined) throw new ConfigurationPersistenceError('schema-not-found');
        if (
          schema.resource_id !== resourceId ||
          schema.current_schema_sha256 !== expectedSchemaSha256
        ) {
          throw new ConfigurationPersistenceError('concurrent-modification');
        }
        const existing = await client.query(
          `SELECT resource_id FROM configuration_resources
           WHERE server_instance_id = $1 AND resource_id = $2`,
          [serverInstanceId, resourceId],
        );
        if (existing.rowCount > 0) {
          throw new ConfigurationPersistenceError('resource-conflict');
        }
        const resourceResult = await client.query<ResourceRow>(
          `INSERT INTO configuration_resources (
             server_instance_id, resource_id, schema_id, schema_sha256, relative_file_path,
             maximum_bytes, apply_mode, version, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$8)
           RETURNING ${RESOURCE_COLUMNS}`,
          [
            serverInstanceId,
            resourceId,
            reviewed.schema.schemaId,
            reviewed.schemaSha256,
            reviewed.schema.filePath,
            reviewed.maximumBytes,
            reviewed.applyMode,
            createdAt,
          ],
        );
        const stateResult = await client.query<StateRow>(
          `INSERT INTO configuration_application_states (
             server_instance_id, resource_id, status, current_sha256, version, updated_at
           ) VALUES ($1,$2,'registered',$3,1,$4)
           RETURNING ${STATE_COLUMNS}`,
          [serverInstanceId, resourceId, initialCurrentSha256, createdAt],
        );
        const resource = resourceResult.rows[0];
        const state = stateResult.rows[0];
        if (resource === undefined || state === undefined) {
          throw new ConfigurationPersistenceError('resource-conflict');
        }
        return Object.freeze({ resource: mapResource(resource), state: mapState(state) });
      });
    } catch (error) {
      if (error instanceof ConfigurationPersistenceError) throw error;
      throw new ConfigurationPersistenceError('resource-conflict');
    }
  }

  public async resource(
    serverInstanceIdInput: string,
    resourceIdInput: string,
  ): Promise<PersistedConfigurationResource | undefined> {
    const serverInstanceId = uuid(serverInstanceIdInput);
    const resourceId = identifier(resourceIdInput);
    const result = await this.database.query<ResourceRow>(
      `SELECT ${RESOURCE_COLUMNS} FROM configuration_resources
       WHERE server_instance_id = $1 AND resource_id = $2`,
      [serverInstanceId, resourceId],
    );
    return result.rows[0] === undefined ? undefined : mapResource(result.rows[0]);
  }

  public async state(
    serverInstanceIdInput: string,
    resourceIdInput: string,
  ): Promise<ConfigurationApplicationState | undefined> {
    const serverInstanceId = uuid(serverInstanceIdInput);
    const resourceId = identifier(resourceIdInput);
    const result = await this.database.query<StateRow>(
      `SELECT ${STATE_COLUMNS} FROM configuration_application_states
       WHERE server_instance_id = $1 AND resource_id = $2`,
      [serverInstanceId, resourceId],
    );
    return result.rows[0] === undefined ? undefined : mapState(result.rows[0]);
  }

  public async prepare(input: {
    readonly revisionId: string;
    readonly serverInstanceId: string;
    readonly resourceId: string;
    readonly operation: PersistedConfigurationOperation;
    readonly sourceRevisionId: string | null;
    readonly expectedCurrentSha256: string;
    readonly expectedStateVersion: number;
    readonly requestedFields: readonly string[];
    readonly actor: ActorRef;
    readonly reasonCode: string;
    readonly correlationId: string;
    readonly createdAt: string;
  }): Promise<PreparedConfigurationOperation> {
    const revisionId = identifier(input.revisionId);
    const serverInstanceId = uuid(input.serverInstanceId);
    const resourceId = identifier(input.resourceId);
    const expectedCurrentSha256 = sha256(input.expectedCurrentSha256);
    const expectedStateVersion = positiveVersion(input.expectedStateVersion);
    const actor = actorRef(input.actor);
    const reasonCode = identifier(input.reasonCode);
    const correlationId = uuid(input.correlationId);
    const createdAt = canonicalTimestamp(input.createdAt);
    if (input.operation !== 'update' && input.operation !== 'rollback') {
      throw new ConfigurationPersistenceError('invalid-input');
    }
    const requestedFields = stringList(input.requestedFields, input.operation === 'rollback');
    const sourceRevisionId =
      input.sourceRevisionId === null ? null : identifier(input.sourceRevisionId);
    if (
      (input.operation === 'update' && sourceRevisionId !== null) ||
      (input.operation === 'rollback' && sourceRevisionId === null)
    ) {
      throw new ConfigurationPersistenceError('invalid-input');
    }

    return this.database.transaction(async (client) => {
      const duplicate = await client.query(
        'SELECT revision_id FROM configuration_revisions WHERE revision_id = $1',
        [revisionId],
      );
      if (duplicate.rowCount > 0) throw new ConfigurationPersistenceError('revision-conflict');
      const resourceResult = await client.query<ResourceRow & { readonly definition: GenericConfigurationSchema | string }>(
        `SELECT r.server_instance_id, r.resource_id, r.schema_id, r.schema_sha256,
                r.relative_file_path, r.maximum_bytes, r.apply_mode, r.version,
                r.created_at, r.updated_at, sr.definition
         FROM configuration_resources r
         JOIN configuration_schema_revisions sr
           ON sr.schema_id = r.schema_id AND sr.schema_sha256 = r.schema_sha256
         WHERE r.server_instance_id = $1 AND r.resource_id = $2`,
        [serverInstanceId, resourceId],
      );
      const resourceRow = resourceResult.rows[0];
      if (resourceRow === undefined) throw new ConfigurationPersistenceError('resource-not-found');
      const definition = freezeConfigurationSchema(parseJson(resourceRow.definition));
      if (requestedFields.some((field) => !Object.hasOwn(definition.fields, field))) {
        throw new ConfigurationPersistenceError('invalid-input');
      }
      const stateResult = await client.query<StateRow>(
        `SELECT ${STATE_COLUMNS} FROM configuration_application_states
         WHERE server_instance_id = $1 AND resource_id = $2 FOR UPDATE`,
        [serverInstanceId, resourceId],
      );
      const state = stateResult.rows[0];
      if (state === undefined) throw new ConfigurationPersistenceError('resource-not-found');
      if (
        Number(state.version) !== expectedStateVersion ||
        state.current_sha256 !== expectedCurrentSha256 ||
        state.status === 'prepared'
      ) {
        throw new ConfigurationPersistenceError('concurrent-modification');
      }
      if (sourceRevisionId !== null) {
        const source = await client.query<RevisionRow>(
          `SELECT ${REVISION_COLUMNS} FROM configuration_revisions
           WHERE revision_id = $1 AND server_instance_id = $2 AND resource_id = $3
             AND status = 'applied'`,
          [sourceRevisionId, serverInstanceId, resourceId],
        );
        if (source.rowCount !== 1) {
          throw new ConfigurationPersistenceError('invalid-transition');
        }
      }
      const revisionResult = await client.query<RevisionRow>(
        `INSERT INTO configuration_revisions (
           revision_id, server_instance_id, resource_id, schema_id, schema_version,
           schema_sha256, operation, source_revision_id, status, expected_current_sha256,
           requested_fields, actor, reason_code, correlation_id, version, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'prepared',$9,$10::jsonb,$11::jsonb,$12,$13,1,$14,$14)
         RETURNING ${REVISION_COLUMNS}`,
        [
          revisionId,
          serverInstanceId,
          resourceId,
          definition.schemaId,
          definition.schemaVersion,
          resourceRow.schema_sha256,
          input.operation,
          sourceRevisionId,
          expectedCurrentSha256,
          JSON.stringify(requestedFields),
          JSON.stringify(actor),
          reasonCode,
          correlationId,
          createdAt,
        ],
      );
      const nextStateResult = await client.query<StateRow>(
        `UPDATE configuration_application_states
         SET status = 'prepared', pending_revision_id = $3, version = version + 1,
             updated_at = $4
         WHERE server_instance_id = $1 AND resource_id = $2 AND version = $5
         RETURNING ${STATE_COLUMNS}`,
        [serverInstanceId, resourceId, revisionId, createdAt, expectedStateVersion],
      );
      const revision = revisionResult.rows[0];
      const nextState = nextStateResult.rows[0];
      if (revision === undefined || nextState === undefined) {
        throw new ConfigurationPersistenceError('concurrent-modification');
      }
      return Object.freeze({
        revision: mapRevision(revision),
        state: mapState(nextState),
        resource: mapResource(resourceRow),
      });
    });
  }

  public async markApplied(input: {
    readonly revisionId: string;
    readonly expectedRevisionVersion: number;
    readonly expectedStateVersion: number;
    readonly previousSha256: string;
    readonly currentSha256: string;
    readonly manifestSha256: string;
    readonly changedFields: readonly string[];
    readonly restartRequired: boolean;
    readonly completedAt: string;
    readonly auditEventId: string;
  }): Promise<CompletedConfigurationOperation> {
    const revisionId = identifier(input.revisionId);
    const expectedRevisionVersion = positiveVersion(input.expectedRevisionVersion);
    const expectedStateVersion = positiveVersion(input.expectedStateVersion);
    const previousSha256 = sha256(input.previousSha256);
    const currentSha256 = sha256(input.currentSha256);
    const manifestSha256 = sha256(input.manifestSha256);
    const changedFields = stringList(input.changedFields, false);
    if (typeof input.restartRequired !== 'boolean') {
      throw new ConfigurationPersistenceError('invalid-input');
    }
    const completedAt = canonicalTimestamp(input.completedAt);
    const auditEventId = uuid(input.auditEventId);
    return this.database.transaction(async (client) => {
      const prepared = await this.#lockedPrepared(client, revisionId);
      if (
        prepared.revision.version !== expectedRevisionVersion ||
        prepared.state.version !== expectedStateVersion ||
        prepared.revision.expectedCurrentSha256 !== previousSha256 ||
        (prepared.revision.operation === 'update' &&
          changedFields.some((field) => !prepared.revision.requestedFields.includes(field)))
      ) {
        throw new ConfigurationPersistenceError('concurrent-modification');
      }
      const revisionResult = await client.query<RevisionRow>(
        `UPDATE configuration_revisions
         SET status = 'applied', previous_sha256 = $2, current_sha256 = $3,
             manifest_sha256 = $4, changed_fields = $5::jsonb, restart_required = $6,
             version = version + 1, updated_at = $7, completed_at = $7
         WHERE revision_id = $1 AND version = $8 AND status = 'prepared'
         RETURNING ${REVISION_COLUMNS}`,
        [
          revisionId,
          previousSha256,
          currentSha256,
          manifestSha256,
          JSON.stringify(changedFields),
          input.restartRequired,
          completedAt,
          expectedRevisionVersion,
        ],
      );
      const stateResult = await client.query<StateRow>(
        `UPDATE configuration_application_states
         SET status = 'applied', current_sha256 = $3, pending_revision_id = NULL,
             last_applied_revision_id = $4, version = version + 1, updated_at = $5
         WHERE server_instance_id = $1 AND resource_id = $2 AND version = $6
           AND pending_revision_id = $4
         RETURNING ${STATE_COLUMNS}`,
        [
          prepared.revision.serverInstanceId,
          prepared.revision.resourceId,
          currentSha256,
          revisionId,
          completedAt,
          expectedStateVersion,
        ],
      );
      const revision = revisionResult.rows[0];
      const state = stateResult.rows[0];
      if (revision === undefined || state === undefined) {
        throw new ConfigurationPersistenceError('concurrent-modification');
      }
      const audit = await appendAuditRecord(
        client,
        this.#auditEvent({
          eventId: auditEventId,
          revision: mapRevision(revision),
          state: mapState(state),
          occurredAt: completedAt,
          outcome: 'succeeded',
        }),
        'configuration',
      );
      return Object.freeze({
        revision: mapRevision(revision),
        state: mapState(state),
        resource: prepared.resource,
        auditSequence: audit.sequence,
      });
    });
  }

  public async markFailed(input: {
    readonly revisionId: string;
    readonly expectedRevisionVersion: number;
    readonly expectedStateVersion: number;
    readonly failureCode: string;
    readonly failureStage: string;
    readonly completedAt: string;
    readonly auditEventId: string;
  }): Promise<CompletedConfigurationOperation> {
    const revisionId = identifier(input.revisionId);
    const expectedRevisionVersion = positiveVersion(input.expectedRevisionVersion);
    const expectedStateVersion = positiveVersion(input.expectedStateVersion);
    const failureCode = identifier(input.failureCode);
    const failureStage = identifier(input.failureStage);
    const completedAt = canonicalTimestamp(input.completedAt);
    const auditEventId = uuid(input.auditEventId);
    return this.database.transaction(async (client) => {
      const prepared = await this.#lockedPrepared(client, revisionId);
      if (
        prepared.revision.version !== expectedRevisionVersion ||
        prepared.state.version !== expectedStateVersion
      ) {
        throw new ConfigurationPersistenceError('concurrent-modification');
      }
      const revisionResult = await client.query<RevisionRow>(
        `UPDATE configuration_revisions
         SET status = 'failed', failure_code = $2, failure_stage = $3,
             version = version + 1, updated_at = $4, completed_at = $4
         WHERE revision_id = $1 AND version = $5 AND status = 'prepared'
         RETURNING ${REVISION_COLUMNS}`,
        [revisionId, failureCode, failureStage, completedAt, expectedRevisionVersion],
      );
      const stateResult = await client.query<StateRow>(
        `UPDATE configuration_application_states
         SET status = 'failed', pending_revision_id = NULL, last_failed_revision_id = $3,
             version = version + 1, updated_at = $4
         WHERE server_instance_id = $1 AND resource_id = $2 AND version = $5
           AND pending_revision_id = $3
         RETURNING ${STATE_COLUMNS}`,
        [
          prepared.revision.serverInstanceId,
          prepared.revision.resourceId,
          revisionId,
          completedAt,
          expectedStateVersion,
        ],
      );
      const revision = revisionResult.rows[0];
      const state = stateResult.rows[0];
      if (revision === undefined || state === undefined) {
        throw new ConfigurationPersistenceError('concurrent-modification');
      }
      const audit = await appendAuditRecord(
        client,
        this.#auditEvent({
          eventId: auditEventId,
          revision: mapRevision(revision),
          state: mapState(state),
          occurredAt: completedAt,
          outcome: 'failed',
        }),
        'configuration',
      );
      return Object.freeze({
        revision: mapRevision(revision),
        state: mapState(state),
        resource: prepared.resource,
        auditSequence: audit.sequence,
      });
    });
  }

  public async revision(revisionIdInput: string): Promise<PersistedConfigurationRevision | undefined> {
    const revisionId = identifier(revisionIdInput);
    const result = await this.database.query<RevisionRow>(
      `SELECT ${REVISION_COLUMNS} FROM configuration_revisions WHERE revision_id = $1`,
      [revisionId],
    );
    return result.rows[0] === undefined ? undefined : mapRevision(result.rows[0]);
  }

  /**
   * Lists the most recent revisions of one resource, newest first. The bound is
   * mandatory so a caller can never request an unbounded scan.
   */
  public async listRevisions(
    serverInstanceIdInput: string,
    resourceIdInput: string,
    limit = 50,
  ): Promise<readonly PersistedConfigurationRevision[]> {
    const serverInstanceId = uuid(serverInstanceIdInput);
    const resourceId = identifier(resourceIdInput);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ConfigurationPersistenceError('invalid-input');
    }
    const result = await this.database.query<RevisionRow>(
      `SELECT ${REVISION_COLUMNS} FROM configuration_revisions
       WHERE server_instance_id = $1 AND resource_id = $2
       ORDER BY created_at DESC, revision_id DESC
       LIMIT $3`,
      [serverInstanceId, resourceId, limit],
    );
    return Object.freeze(result.rows.map(mapRevision));
  }

  async #lockedPrepared(client: SqlClient, revisionId: string): Promise<PreparedConfigurationOperation> {
    const revisionResult = await client.query<RevisionRow>(
      `SELECT ${REVISION_COLUMNS} FROM configuration_revisions
       WHERE revision_id = $1 FOR UPDATE`,
      [revisionId],
    );
    const revisionRow = revisionResult.rows[0];
    if (revisionRow === undefined) throw new ConfigurationPersistenceError('revision-conflict');
    const revision = mapRevision(revisionRow);
    if (revision.status !== 'prepared') {
      throw new ConfigurationPersistenceError('invalid-transition');
    }
    const stateResult = await client.query<StateRow>(
      `SELECT ${STATE_COLUMNS} FROM configuration_application_states
       WHERE server_instance_id = $1 AND resource_id = $2 FOR UPDATE`,
      [revision.serverInstanceId, revision.resourceId],
    );
    const resourceResult = await client.query<ResourceRow>(
      `SELECT ${RESOURCE_COLUMNS} FROM configuration_resources
       WHERE server_instance_id = $1 AND resource_id = $2`,
      [revision.serverInstanceId, revision.resourceId],
    );
    const stateRow = stateResult.rows[0];
    const resourceRow = resourceResult.rows[0];
    if (
      stateRow === undefined ||
      resourceRow === undefined ||
      stateRow.status !== 'prepared' ||
      stateRow.pending_revision_id !== revisionId
    ) {
      throw new ConfigurationPersistenceError('invalid-transition');
    }
    return Object.freeze({
      revision,
      state: mapState(stateRow),
      resource: mapResource(resourceRow),
    });
  }

  #auditEvent(input: {
    readonly eventId: string;
    readonly revision: PersistedConfigurationRevision;
    readonly state: ConfigurationApplicationState;
    readonly occurredAt: string;
    readonly outcome: 'succeeded' | 'failed';
  }): AuditEvent {
    const action = `configuration.${input.revision.operation}.${
      input.outcome === 'succeeded' ? 'applied' : 'failed'
    }`;
    return {
      schemaVersion: 1,
      id: input.eventId,
      occurredAt: input.occurredAt,
      correlationId: input.revision.correlationId,
      actor: input.revision.actor,
      source: 'system',
      action,
      resource: {
        type: 'configuration',
        id: `${input.revision.serverInstanceId}:${input.revision.resourceId}`,
      },
      outcome: input.outcome,
      reason: input.revision.reasonCode,
      metadata: {
        revisionId: input.revision.revisionId,
        schemaId: input.revision.schemaId,
        schemaVersion: input.revision.schemaVersion,
        operation: input.revision.operation,
        status: input.revision.status,
        stateVersion: input.state.version,
        requestedFields: [...input.revision.requestedFields],
        ...(input.revision.changedFields === null
          ? {}
          : { changedFields: [...input.revision.changedFields] }),
        ...(input.revision.restartRequired === null
          ? {}
          : { restartRequired: input.revision.restartRequired }),
        ...(input.revision.failureCode === null
          ? {}
          : {
              failureCode: input.revision.failureCode,
              failureStage: input.revision.failureStage,
            }),
      },
    };
  }
}

export class OperationalLockRepository {
  public constructor(private readonly database: Database) {}

  public async acquire(input: {
    readonly serverInstanceId: string;
    readonly lockName: string;
    readonly ownerId: string;
    readonly operation: string;
    readonly acquiredAt: string;
    readonly leaseExpiresAt: string;
  }): Promise<OperationalLockLease> {
    const serverInstanceId = uuid(input.serverInstanceId);
    const lockName = identifier(input.lockName);
    const ownerId = uuid(input.ownerId);
    if (
      typeof input.operation !== 'string' ||
      input.operation.length < 2 ||
      input.operation.length > 128 ||
      !/^[a-z][a-z0-9.-]+$/u.test(input.operation)
    ) {
      throw new ConfigurationPersistenceError('invalid-input');
    }
    const acquiredAt = canonicalTimestamp(input.acquiredAt);
    const leaseExpiresAt = canonicalTimestamp(input.leaseExpiresAt);
    if (new Date(leaseExpiresAt).getTime() <= new Date(acquiredAt).getTime()) {
      throw new ConfigurationPersistenceError('invalid-input');
    }
    const result = await this.database.query<LockRow>(
      `INSERT INTO operational_locks (
         server_instance_id, lock_name, owner_id, operation, acquired_at,
         lease_expires_at, version
       ) VALUES ($1,$2,$3,$4,$5,$6,1)
       ON CONFLICT (server_instance_id, lock_name) DO UPDATE
       SET owner_id = EXCLUDED.owner_id, operation = EXCLUDED.operation,
           acquired_at = EXCLUDED.acquired_at, lease_expires_at = EXCLUDED.lease_expires_at,
           version = operational_locks.version + 1
       WHERE operational_locks.lease_expires_at <= EXCLUDED.acquired_at
          OR operational_locks.owner_id = EXCLUDED.owner_id
       RETURNING server_instance_id, lock_name, owner_id, operation, acquired_at,
                 lease_expires_at, version`,
      [serverInstanceId, lockName, ownerId, input.operation, acquiredAt, leaseExpiresAt],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ConfigurationPersistenceError('lock-unavailable');
    return mapLock(row);
  }

  public async release(input: {
    readonly serverInstanceId: string;
    readonly lockName: string;
    readonly ownerId: string;
  }): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM operational_locks
       WHERE server_instance_id = $1 AND lock_name = $2 AND owner_id = $3`,
      [uuid(input.serverInstanceId), identifier(input.lockName), uuid(input.ownerId)],
    );
    return result.rowCount === 1;
  }

  public async current(
    serverInstanceIdInput: string,
    lockNameInput: string,
  ): Promise<OperationalLockLease | undefined> {
    const result = await this.database.query<LockRow>(
      `SELECT server_instance_id, lock_name, owner_id, operation, acquired_at,
              lease_expires_at, version
       FROM operational_locks WHERE server_instance_id = $1 AND lock_name = $2`,
      [uuid(serverInstanceIdInput), identifier(lockNameInput)],
    );
    return result.rows[0] === undefined ? undefined : mapLock(result.rows[0]);
  }
}
