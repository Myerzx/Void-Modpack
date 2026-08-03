import { Type, type Static } from '@sinclair/typebox';
import {
  ActorRefSchema,
  ContractSchemaVersion,
  IsoDateTimeSchema,
  SlugSchema,
  UuidSchema,
} from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

const MinecraftGroupSchema = Type.String({
  minLength: 2,
  maxLength: 64,
  pattern: '^[a-z0-9]+(?:[._-][a-z0-9]+)*$',
});

const PermissionSynchronizationSchema = Type.Object(
  {
    providerId: SlugSchema,
    outcome: Type.Union([Type.Literal('succeeded'), Type.Literal('failed')]),
    attemptedAt: IsoDateTimeSchema,
    receiptId: Type.String({ minLength: 1, maxLength: 128 }),
    errorCode: Type.Optional(
      Type.String({ minLength: 2, maxLength: 64, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }),
    ),
  },
  { additionalProperties: false },
);

export const MinecraftPermissionBindingSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    bindingId: UuidSchema,
    playerUuid: UuidSchema,
    serverInstanceId: UuidSchema,
    revision: Type.Integer({ minimum: 1 }),
    status: Type.Union([
      Type.Literal('pending'),
      Type.Literal('synchronized'),
      Type.Literal('failed'),
      Type.Literal('revoked'),
    ]),
    groups: Type.Array(MinecraftGroupSchema, { maxItems: 32 }),
    requestedBy: ActorRefSchema,
    reason: Type.String({ minLength: 1, maxLength: 1_000 }),
    requestedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    synchronization: Type.Optional(PermissionSynchronizationSchema),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/minecraft-permission-binding.schema.json',
    additionalProperties: false,
  },
);

export type MinecraftPermissionBinding = Static<typeof MinecraftPermissionBindingSchema>;

export function validateMinecraftPermissionBinding(
  value: unknown,
): ContractValidationResult<MinecraftPermissionBinding> {
  const result = validateContract(MinecraftPermissionBindingSchema, value);
  if (!result.success) return result;

  const binding = result.value;
  const issues: ContractValidationIssue[] = [];
  if (Date.parse(binding.updatedAt) < Date.parse(binding.requestedAt)) {
    issues.push(semanticIssue('/updatedAt', 'binding update cannot precede its request'));
  }

  if (new Set(binding.groups).size !== binding.groups.length) {
    issues.push(semanticIssue('/groups', 'Minecraft groups must be unique'));
  }
  for (let index = 1; index < binding.groups.length; index += 1) {
    const previous = binding.groups[index - 1];
    const current = binding.groups[index];
    if (previous !== undefined && current !== undefined && previous >= current) {
      issues.push(semanticIssue('/groups', 'Minecraft groups must be strictly sorted'));
      break;
    }
  }

  if (binding.status === 'revoked') {
    if (binding.groups.length !== 0) {
      issues.push(semanticIssue('/groups', 'revoked bindings cannot retain desired groups'));
    }
  } else if (!binding.groups.includes('player')) {
    issues.push(semanticIssue('/groups', 'active desired state must include the baseline player group'));
  }

  const synchronization = binding.synchronization;
  if (binding.status === 'pending' || binding.status === 'revoked') {
    if (synchronization !== undefined) {
      issues.push(semanticIssue('/synchronization', 'this binding state cannot include a sync receipt'));
    }
  } else if (synchronization === undefined) {
    issues.push(semanticIssue('/synchronization', 'completed synchronization requires a receipt'));
  } else {
    const expectedOutcome = binding.status === 'synchronized' ? 'succeeded' : 'failed';
    if (synchronization.outcome !== expectedOutcome) {
      issues.push(semanticIssue('/synchronization/outcome', 'receipt outcome must match binding state'));
    }
    if (Date.parse(synchronization.attemptedAt) < Date.parse(binding.requestedAt)) {
      issues.push(semanticIssue('/synchronization/attemptedAt', 'sync cannot precede the request'));
    }
    if (synchronization.outcome === 'failed' && synchronization.errorCode === undefined) {
      issues.push(semanticIssue('/synchronization/errorCode', 'failed sync requires a safe error code'));
    }
    if (synchronization.outcome === 'succeeded' && synchronization.errorCode !== undefined) {
      issues.push(semanticIssue('/synchronization/errorCode', 'successful sync cannot carry an error'));
    }
  }

  return appendSemanticIssues(result, issues);
}
