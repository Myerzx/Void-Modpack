import { Type, type Static } from '@sinclair/typebox';
import {
  ActorRefSchema,
  ContractSchemaVersion,
  IsoDateTimeSchema,
  JsonObjectSchema,
  ResourceRefSchema,
  Sha256Schema,
  UuidSchema,
  type JsonValue,
} from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

export const AuditEventSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    id: UuidSchema,
    occurredAt: IsoDateTimeSchema,
    correlationId: UuidSchema,
    actor: ActorRefSchema,
    source: Type.Union([
      Type.Literal('panel'),
      Type.Literal('api'),
      Type.Literal('agent'),
      Type.Literal('worker'),
      Type.Literal('forge-bridge'),
      Type.Literal('system'),
    ]),
    action: Type.String({
      minLength: 3,
      maxLength: 128,
      pattern: '^[a-z0-9]+(?:[.-][a-z0-9]+)*$',
    }),
    resource: ResourceRefSchema,
    outcome: Type.Union([
      Type.Literal('succeeded'),
      Type.Literal('denied'),
      Type.Literal('failed'),
      Type.Literal('cancelled'),
    ]),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    before: Type.Optional(JsonObjectSchema),
    after: Type.Optional(JsonObjectSchema),
    metadata: Type.Optional(JsonObjectSchema),
    integrity: Type.Optional(
      Type.Object(
        {
          previousHash: Type.Union([Sha256Schema, Type.Null()]),
          eventHash: Sha256Schema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/audit-event.schema.json',
    additionalProperties: false,
  },
);

export type AuditEvent = Static<typeof AuditEventSchema>;

const forbiddenAuditKeys = new Set([
  'password',
  'passwordhash',
  'rconpassword',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'authorization',
  'cookie',
  'setcookie',
]);

function normalizeKey(key: string): string {
  return key.replaceAll(/[-_\s]/g, '').toLocaleLowerCase('en-US');
}

function findForbiddenKey(value: JsonValue, path: string): string | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenKey(item, `${path}/${index}`);
      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  for (const [key, item] of Object.entries(value)) {
    const keyPath = `${path}/${key}`;
    if (forbiddenAuditKeys.has(normalizeKey(key))) {
      return keyPath;
    }

    const found = findForbiddenKey(item, keyPath);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

export function validateAuditEvent(value: unknown): ContractValidationResult<AuditEvent> {
  const result = validateContract(AuditEventSchema, value);

  if (!result.success) {
    return result;
  }

  const issues: ContractValidationIssue[] = [];
  const event = result.value;

  for (const [field, content] of [
    ['before', event.before],
    ['after', event.after],
    ['metadata', event.metadata],
  ] as const) {
    if (content === undefined) {
      continue;
    }

    const forbiddenPath = findForbiddenKey(content, `/${field}`);
    if (forbiddenPath !== undefined) {
      issues.push(semanticIssue(forbiddenPath, 'secret-bearing keys are forbidden in audit data'));
    }
  }

  return appendSemanticIssues(result, issues);
}
