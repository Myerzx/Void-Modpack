import { createHash } from 'node:crypto';

import {
  ConfigurationSchemaOperationError,
  type ConfigurationSchemaHistoryEntry,
  type ConfigurationSchemaRegistryOptions,
  type ConfigurationSchemaRevisionReceipt,
  type GenericConfigurationSchema,
  type RegisterConfigurationSchemaPlan,
} from './types.js';
import { freezeConfigurationSchema } from './validation.js';

const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAXIMUM_SCHEMAS = 10_000;
const MAXIMUM_REVISIONS = 10_000;

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareOrdinal);
  const wanted = [...expected].sort(compareOrdinal);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function canonicalJson(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map((child) => visit(child));
    if (!isRecord(item)) return item;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(item).sort(compareOrdinal)) {
      const child = item[key];
      if (child !== undefined) result[key] = visit(child);
    }
    return result;
  };
  return `${JSON.stringify(visit(value))}\n`;
}

export function hashConfigurationSchema(schema: GenericConfigurationSchema): string {
  const frozen = freezeConfigurationSchema(schema);
  return createHash('sha256').update(canonicalJson(frozen), 'utf8').digest('hex');
}

function cloneSchema(schema: GenericConfigurationSchema): GenericConfigurationSchema {
  return freezeConfigurationSchema(JSON.parse(canonicalJson(schema)) as GenericConfigurationSchema);
}

function freezeEntry(entry: ConfigurationSchemaHistoryEntry): ConfigurationSchemaHistoryEntry {
  return Object.freeze({ revision: Object.freeze({ ...entry.revision }), schema: cloneSchema(entry.schema) });
}

export class ConfigurationSchemaRegistry {
  readonly #maximumSchemas: number;
  readonly #maximumRevisionsPerSchema: number;
  readonly #historyBySchema = new Map<string, ConfigurationSchemaHistoryEntry[]>();
  readonly #revisionIds = new Set<string>();

  public constructor(options: ConfigurationSchemaRegistryOptions) {
    if (
      !isRecord(options) ||
      !exactKeys(options, ['maximumSchemas', 'maximumRevisionsPerSchema']) ||
      !Number.isSafeInteger(options.maximumSchemas) ||
      options.maximumSchemas < 1 ||
      options.maximumSchemas > MAXIMUM_SCHEMAS ||
      !Number.isSafeInteger(options.maximumRevisionsPerSchema) ||
      options.maximumRevisionsPerSchema < 1 ||
      options.maximumRevisionsPerSchema > MAXIMUM_REVISIONS
    ) {
      throw new ConfigurationSchemaOperationError('invalid-options');
    }
    this.#maximumSchemas = options.maximumSchemas;
    this.#maximumRevisionsPerSchema = options.maximumRevisionsPerSchema;
  }

  public register(input: RegisterConfigurationSchemaPlan): ConfigurationSchemaRevisionReceipt {
    if (
      !isRecord(input) ||
      !exactKeys(input, [
        'revisionId',
        'actorId',
        'reasonCode',
        'createdAt',
        'expectedSchemaSha256',
        'schema',
      ]) ||
      typeof input.revisionId !== 'string' ||
      !IDENTIFIER.test(input.revisionId) ||
      typeof input.actorId !== 'string' ||
      !UUID.test(input.actorId) ||
      typeof input.reasonCode !== 'string' ||
      !IDENTIFIER.test(input.reasonCode) ||
      !canonicalTimestamp(input.createdAt) ||
      (input.expectedSchemaSha256 !== null &&
        (typeof input.expectedSchemaSha256 !== 'string' || !SHA256.test(input.expectedSchemaSha256)))
    ) {
      throw new ConfigurationSchemaOperationError('invalid-plan');
    }
    if (this.#revisionIds.has(input.revisionId)) {
      throw new ConfigurationSchemaOperationError('revision-conflict');
    }
    const schema = cloneSchema(input.schema);
    const history = this.#historyBySchema.get(schema.schemaId) ?? [];
    if (history.length === 0) {
      if (input.expectedSchemaSha256 !== null) {
        throw new ConfigurationSchemaOperationError('schema-conflict');
      }
      if (this.#historyBySchema.size >= this.#maximumSchemas) {
        throw new ConfigurationSchemaOperationError('schema-limit-exceeded');
      }
    } else if (input.expectedSchemaSha256 === null) {
      throw new ConfigurationSchemaOperationError('schema-conflict');
    }
    if (history.length >= this.#maximumRevisionsPerSchema) {
      throw new ConfigurationSchemaOperationError('history-limit-exceeded');
    }
    const previous = history.at(-1);
    const previousSha256 = previous?.revision.currentSchemaSha256 ?? null;
    if (previousSha256 !== input.expectedSchemaSha256) {
      throw new ConfigurationSchemaOperationError('concurrent-modification');
    }
    const currentSchemaSha256 = hashConfigurationSchema(schema);
    if (currentSchemaSha256 === previousSha256) {
      throw new ConfigurationSchemaOperationError('no-change');
    }
    const entry = freezeEntry({
      revision: {
        revisionId: input.revisionId,
        schemaId: schema.schemaId,
        schemaVersion: schema.schemaVersion,
        actorId: input.actorId,
        reasonCode: input.reasonCode,
        createdAt: input.createdAt,
        previousSchemaSha256: previousSha256,
        currentSchemaSha256,
      },
      schema,
    });
    this.#historyBySchema.set(schema.schemaId, [...history, entry]);
    this.#revisionIds.add(input.revisionId);
    return entry;
  }

  public current(schemaId: string): ConfigurationSchemaRevisionReceipt {
    if (!IDENTIFIER.test(schemaId)) throw new ConfigurationSchemaOperationError('schema-not-found');
    const entry = this.#historyBySchema.get(schemaId)?.at(-1);
    if (entry === undefined) throw new ConfigurationSchemaOperationError('schema-not-found');
    return entry;
  }

  public history(schemaId: string): readonly ConfigurationSchemaHistoryEntry[] {
    if (!IDENTIFIER.test(schemaId)) throw new ConfigurationSchemaOperationError('schema-not-found');
    const history = this.#historyBySchema.get(schemaId);
    if (history === undefined) throw new ConfigurationSchemaOperationError('schema-not-found');
    return Object.freeze([...history]);
  }
}
