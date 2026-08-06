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

export const ModerationActionSchema = Type.Union([
  Type.Literal('warning'),
  Type.Literal('mute'),
  Type.Literal('kick'),
  Type.Literal('temporary-ban'),
  Type.Literal('permanent-ban'),
]);

const ModerationTransitionSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('applied'),
      Type.Literal('failed'),
      Type.Literal('revoked'),
      Type.Literal('expired'),
    ]),
    occurredAt: IsoDateTimeSchema,
    executorId: Type.Optional(SlugSchema),
    receiptId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    errorCode: Type.Optional(
      Type.String({ minLength: 2, maxLength: 64, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }),
    ),
  },
  { additionalProperties: false },
);

/**
 * What the incident looked like at the time, kept for the record.
 *
 * None of it is a key. A case is about a person, and the account, the name and
 * the claim they held when it happened are context an operator needs when
 * reading the case months later — not the thing that identifies whom it is
 * about. Keying on any of them would lose the punishment at the next name
 * change, which is precisely what a punishment must survive.
 */
const ModerationIncidentContextSchema = Type.Object(
  {
    claimId: UuidSchema,
    minecraftUuid: UuidSchema,
    minecraftName: Type.String({ minLength: 3, maxLength: 16, pattern: '^[A-Za-z0-9_]+$' }),
  },
  { additionalProperties: false },
);

export const ModerationCaseSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    caseId: UuidSchema,
    /**
     * Whom the case is about. Mandatory and stable: a punishment survives a
     * name change, a rebind and the revocation of the claim it was recorded
     * against.
     */
    subjectIdentityId: UuidSchema,
    incidentContext: ModerationIncidentContextSchema,
    serverInstanceId: UuidSchema,
    revision: Type.Integer({ minimum: 1 }),
    action: ModerationActionSchema,
    status: Type.Union([
      Type.Literal('requested'),
      Type.Literal('applied'),
      Type.Literal('failed'),
      Type.Literal('revoked'),
      Type.Literal('expired'),
    ]),
    reasonCode: SlugSchema,
    reason: Type.String({ minLength: 1, maxLength: 1_000 }),
    requestedBy: ActorRefSchema,
    requestedAt: IsoDateTimeSchema,
    expiresAt: Type.Optional(IsoDateTimeSchema),
    updatedAt: IsoDateTimeSchema,
    transition: Type.Optional(ModerationTransitionSchema),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/moderation-case.schema.json',
    additionalProperties: false,
  },
);

export type ModerationIncidentContext = Static<typeof ModerationIncidentContextSchema>;
export type ModerationAction = Static<typeof ModerationActionSchema>;
export type ModerationCase = Static<typeof ModerationCaseSchema>;

export function validateModerationCase(value: unknown): ContractValidationResult<ModerationCase> {
  const result = validateContract(ModerationCaseSchema, value);
  if (!result.success) return result;

  const moderationCase = result.value;
  const issues: ContractValidationIssue[] = [];
  const requestedAt = Date.parse(moderationCase.requestedAt);
  const updatedAt = Date.parse(moderationCase.updatedAt);
  if (updatedAt < requestedAt) {
    issues.push(semanticIssue('/updatedAt', 'case update cannot precede request'));
  }

  const requiresExpiry = moderationCase.action === 'mute' || moderationCase.action === 'temporary-ban';
  if (requiresExpiry && moderationCase.expiresAt === undefined) {
    issues.push(semanticIssue('/expiresAt', 'temporary moderation action requires expiry'));
  }
  if (!requiresExpiry && moderationCase.expiresAt !== undefined) {
    issues.push(semanticIssue('/expiresAt', 'instant or permanent action cannot include expiry'));
  }
  if (moderationCase.expiresAt !== undefined && Date.parse(moderationCase.expiresAt) <= requestedAt) {
    issues.push(semanticIssue('/expiresAt', 'moderation expiry must follow request'));
  }

  const transition = moderationCase.transition;
  if (moderationCase.status === 'requested') {
    if (transition !== undefined) {
      issues.push(semanticIssue('/transition', 'requested case cannot include a transition receipt'));
    }
  } else if (transition === undefined) {
    issues.push(semanticIssue('/transition', 'non-requested case requires transition evidence'));
  } else {
    if (transition.kind !== moderationCase.status) {
      issues.push(semanticIssue('/transition/kind', 'transition kind must match case status'));
    }
    if (Date.parse(transition.occurredAt) < requestedAt || Date.parse(transition.occurredAt) > updatedAt) {
      issues.push(semanticIssue('/transition/occurredAt', 'transition must fall within the case lifetime'));
    }
    if (transition.kind === 'applied' || transition.kind === 'failed') {
      if (transition.executorId === undefined || transition.receiptId === undefined) {
        issues.push(semanticIssue('/transition', 'executor transition requires executor and receipt IDs'));
      }
    }
    if (transition.kind === 'failed' && transition.errorCode === undefined) {
      issues.push(semanticIssue('/transition/errorCode', 'failed transition requires a safe error code'));
    }
    if (transition.kind !== 'failed' && transition.errorCode !== undefined) {
      issues.push(semanticIssue('/transition/errorCode', 'only failed transitions can include an error'));
    }
  }

  return appendSemanticIssues(result, issues);
}
