import { Type, type Static } from '@sinclair/typebox';
import {
  ActorRefSchema,
  ContractSchemaVersion,
  IsoDateTimeSchema,
  SlugSchema,
} from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

export const PlayerDataCategorySchema = Type.Union([
  Type.Literal('activity'),
  Type.Literal('chat'),
  Type.Literal('coordinates'),
]);

const PlayerDataRuleSchema = Type.Object(
  {
    category: PlayerDataCategorySchema,
    collection: Type.Union([Type.Literal('disabled'), Type.Literal('allowed')]),
    maximumRetentionSeconds: Type.Optional(
      Type.Integer({ minimum: 60, maximum: 31_536_000 }),
    ),
    viewPermission: Type.Literal('player.activity.sensitive'),
    export: Type.Union([Type.Literal('disabled'), Type.Literal('allowed')]),
  },
  { additionalProperties: false },
);

export const PlayerDataPolicySchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    policyId: SlugSchema,
    revision: Type.Integer({ minimum: 1 }),
    status: Type.Union([
      Type.Literal('draft'),
      Type.Literal('approved'),
      Type.Literal('retired'),
    ]),
    purposeCode: SlugSchema,
    purpose: Type.String({ minLength: 1, maxLength: 1_000 }),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    effectiveAt: Type.Optional(IsoDateTimeSchema),
    approvedBy: Type.Optional(ActorRefSchema),
    approvedAt: Type.Optional(IsoDateTimeSchema),
    rules: Type.Array(PlayerDataRuleSchema, { minItems: 3, maxItems: 3 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/player-data-policy.schema.json',
    additionalProperties: false,
  },
);

export type PlayerDataCategory = Static<typeof PlayerDataCategorySchema>;
export type PlayerDataPolicy = Static<typeof PlayerDataPolicySchema>;

const categoryOrder: readonly PlayerDataCategory[] = ['activity', 'chat', 'coordinates'];

export function validatePlayerDataPolicy(value: unknown): ContractValidationResult<PlayerDataPolicy> {
  const result = validateContract(PlayerDataPolicySchema, value);
  if (!result.success) return result;

  const policy = result.value;
  const issues: ContractValidationIssue[] = [];
  const createdAt = Date.parse(policy.createdAt);
  const updatedAt = Date.parse(policy.updatedAt);
  if (updatedAt < createdAt) {
    issues.push(semanticIssue('/updatedAt', 'policy update cannot precede creation'));
  }

  const actualCategories = policy.rules.map((rule) => rule.category);
  if (!actualCategories.every((category, index) => category === categoryOrder[index])) {
    issues.push(semanticIssue('/rules', 'rules must contain activity, chat and coordinates in order'));
  }
  for (const [index, rule] of policy.rules.entries()) {
    if (rule.collection === 'disabled') {
      if (rule.maximumRetentionSeconds !== undefined) {
        issues.push(
          semanticIssue(`/rules/${index}/maximumRetentionSeconds`, 'disabled collection has no retention'),
        );
      }
      if (rule.export !== 'disabled') {
        issues.push(semanticIssue(`/rules/${index}/export`, 'disabled collection cannot be exported'));
      }
    } else if (rule.maximumRetentionSeconds === undefined) {
      issues.push(
        semanticIssue(`/rules/${index}/maximumRetentionSeconds`, 'allowed collection requires retention'),
      );
    }
  }

  if (policy.status === 'approved') {
    if (policy.approvedBy === undefined || policy.approvedAt === undefined || policy.effectiveAt === undefined) {
      issues.push(semanticIssue('/', 'approved policy requires approver, approval time and effective time'));
    } else {
      const approvedAt = Date.parse(policy.approvedAt);
      if (approvedAt < createdAt || approvedAt > updatedAt) {
        issues.push(semanticIssue('/approvedAt', 'approval must fall within the policy lifetime'));
      }
      if (Date.parse(policy.effectiveAt) < approvedAt) {
        issues.push(semanticIssue('/effectiveAt', 'policy cannot become effective before approval'));
      }
    }
  } else if (
    policy.approvedBy !== undefined ||
    policy.approvedAt !== undefined ||
    policy.effectiveAt !== undefined
  ) {
    issues.push(semanticIssue('/', 'draft or retired policy cannot carry active approval fields'));
  }

  return appendSemanticIssues(result, issues);
}
