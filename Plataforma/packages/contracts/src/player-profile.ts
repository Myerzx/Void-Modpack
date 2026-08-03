import { Type, type Static } from '@sinclair/typebox';
import {
  ContractSchemaVersion,
  IsoDateTimeSchema,
  UuidSchema,
} from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

export const MinecraftAliasSchema = Type.Object(
  {
    name: Type.String({ minLength: 3, maxLength: 16, pattern: '^[A-Za-z0-9_]+$' }),
    normalizedName: Type.String({ minLength: 3, maxLength: 16, pattern: '^[a-z0-9_]+$' }),
    source: Type.Union([
      Type.Literal('forge-bridge'),
      Type.Literal('reviewed-import'),
      Type.Literal('manual-review'),
    ]),
    serverInstanceId: UuidSchema,
    firstObservedAt: IsoDateTimeSchema,
    lastObservedAt: IsoDateTimeSchema,
    observationCount: Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
  },
  { additionalProperties: false },
);

export const PlayerProfileSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    playerUuid: UuidSchema,
    revision: Type.Integer({ minimum: 1 }),
    status: Type.Union([
      Type.Literal('active'),
      Type.Literal('retired'),
      Type.Literal('erasure-pending'),
    ]),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    aliases: Type.Array(MinecraftAliasSchema, { maxItems: 64 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/player-profile.schema.json',
    additionalProperties: false,
  },
);

export type MinecraftAlias = Static<typeof MinecraftAliasSchema>;
export type PlayerProfile = Static<typeof PlayerProfileSchema>;

function normalizeAlias(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

export function validatePlayerProfile(value: unknown): ContractValidationResult<PlayerProfile> {
  const result = validateContract(PlayerProfileSchema, value);
  if (!result.success) return result;

  const issues: ContractValidationIssue[] = [];
  const profile = result.value;
  const createdAt = Date.parse(profile.createdAt);
  const updatedAt = Date.parse(profile.updatedAt);
  if (updatedAt < createdAt) {
    issues.push(semanticIssue('/updatedAt', 'profile update cannot precede creation'));
  }

  const normalizedNames = profile.aliases.map((alias, index) => {
    const expected = normalizeAlias(alias.name);
    if (alias.normalizedName !== expected) {
      issues.push(
        semanticIssue(`/aliases/${index}/normalizedName`, 'normalized name must match the alias'),
      );
    }
    if (Date.parse(alias.lastObservedAt) < Date.parse(alias.firstObservedAt)) {
      issues.push(
        semanticIssue(`/aliases/${index}/lastObservedAt`, 'last observation cannot precede first'),
      );
    }
    if (Date.parse(alias.lastObservedAt) > updatedAt) {
      issues.push(
        semanticIssue(`/aliases/${index}/lastObservedAt`, 'alias observation cannot follow update'),
      );
    }
    return alias.normalizedName;
  });

  if (new Set(normalizedNames).size !== normalizedNames.length) {
    issues.push(semanticIssue('/aliases', 'aliases must be unique after case normalization'));
  }
  for (let index = 1; index < normalizedNames.length; index += 1) {
    const previous = normalizedNames[index - 1];
    const current = normalizedNames[index];
    if (previous !== undefined && current !== undefined && previous >= current) {
      issues.push(semanticIssue('/aliases', 'aliases must be strictly sorted by normalized name'));
      break;
    }
  }

  return appendSemanticIssues(result, issues);
}
