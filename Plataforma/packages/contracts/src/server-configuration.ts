import { Type, type Static } from '@sinclair/typebox';
import {
  ActorRefSchema,
  ContractSchemaVersion,
  IsoDateTimeSchema,
  Sha256Schema,
  UuidSchema,
} from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

/**
 * Public configuration contracts for Phase 7.3.
 *
 * The boundary intentionally carries identifiers and reviewed typed values only.
 * Filesystem roots, absolute paths, relative paths, codecs, schema documents and
 * revision bytes never cross it, in either direction.
 */

/** Identifier of a resource registered in the closed trusted registry. */
export const ConfigurationResourceIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9._-]{0,63}$',
});

export const ConfigurationSchemaIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9._-]{0,63}$',
});

export const ConfigurationRevisionIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9._-]{0,63}$',
});

export const ConfigurationDefinitionVersionSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[a-z0-9][a-z0-9.+_-]{0,127}$',
});

export const ConfigurationFieldNameSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[A-Za-z][A-Za-z0-9._-]{0,63}$',
});

export const ConfigurationReasonCodeSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9._-]{0,63}$',
});

export const ConfigurationIdempotencyKeySchema = Type.String({
  minLength: 16,
  maxLength: 128,
  pattern: '^[A-Za-z0-9._:-]+$',
});

/** Optimistic concurrency token owned by the persisted application state. */
export const ConfigurationStateVersionSchema = Type.Integer({
  minimum: 1,
  maximum: 9_007_199_254_740_991,
});

/** Only reviewed codecs may be named at the boundary. */
export const ConfigurationCodecIdSchema = Type.Union([
  Type.Literal('minecraft-server-properties-v1'),
  Type.Literal('openloader-advanced-options-v1'),
]);

export const ConfigurationApplyModeSchema = Type.Literal('offline-only');

export const ConfigurationOperationSchema = Type.Union([
  Type.Literal('update'),
  Type.Literal('rollback'),
]);

/**
 * Scalar value union. Objects, arrays and null are excluded so no extensible
 * payload can reach a codec through the public contract.
 */
export const ConfigurationValueSchema = Type.Union([
  Type.Boolean(),
  Type.Integer({ minimum: -9_007_199_254_740_991, maximum: 9_007_199_254_740_991 }),
  Type.String({ maxLength: 1_024 }),
]);

export const ConfigurationFieldDescriptorSchema = Type.Union([
  Type.Object(
    {
      name: ConfigurationFieldNameSchema,
      type: Type.Literal('boolean'),
      restartRequired: Type.Boolean(),
      readable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      name: ConfigurationFieldNameSchema,
      type: Type.Literal('integer'),
      minimum: Type.Integer({ minimum: -9_007_199_254_740_991, maximum: 9_007_199_254_740_991 }),
      maximum: Type.Integer({ minimum: -9_007_199_254_740_991, maximum: 9_007_199_254_740_991 }),
      restartRequired: Type.Boolean(),
      readable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      name: ConfigurationFieldNameSchema,
      type: Type.Literal('enum'),
      values: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        minItems: 1,
        maxItems: 64,
        uniqueItems: true,
      }),
      restartRequired: Type.Boolean(),
      readable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      name: ConfigurationFieldNameSchema,
      type: Type.Literal('string'),
      maximumLength: Type.Integer({ minimum: 1, maximum: 1_024 }),
      restartRequired: Type.Boolean(),
      readable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);

export const ConfigurationSchemaDescriptorSchema = Type.Object(
  {
    schemaId: ConfigurationSchemaIdSchema,
    resourceId: ConfigurationResourceIdSchema,
    definitionVersion: ConfigurationDefinitionVersionSchema,
    definitionSha256: Sha256Schema,
    codecId: ConfigurationCodecIdSchema,
    applyMode: ConfigurationApplyModeSchema,
    maximumBytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
    restartRequired: Type.Boolean(),
    registered: Type.Boolean(),
    fields: Type.Array(ConfigurationFieldDescriptorSchema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);

export const ConfigurationSchemaCatalogSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    serverInstanceId: UuidSchema,
    generatedAt: IsoDateTimeSchema,
    schemas: Type.Array(ConfigurationSchemaDescriptorSchema, { maxItems: 64 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/configuration-schema-catalog.schema.json',
    additionalProperties: false,
  },
);

/**
 * A field value is either published or redacted. A redacted entry never carries
 * a `value` property, so a serialization mistake cannot leak one.
 */
export const ConfigurationFieldValueSchema = Type.Union([
  Type.Object(
    {
      name: ConfigurationFieldNameSchema,
      redacted: Type.Literal(false),
      value: ConfigurationValueSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      name: ConfigurationFieldNameSchema,
      redacted: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
]);

export const ConfigurationApplicationStatusSchema = Type.Union([
  Type.Literal('registered'),
  Type.Literal('prepared'),
  Type.Literal('applied'),
  Type.Literal('failed'),
]);

export const ConfigurationResourceStateSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    serverInstanceId: UuidSchema,
    resourceId: ConfigurationResourceIdSchema,
    schemaId: ConfigurationSchemaIdSchema,
    definitionVersion: ConfigurationDefinitionVersionSchema,
    definitionSha256: Sha256Schema,
    status: ConfigurationApplicationStatusSchema,
    currentSha256: Sha256Schema,
    stateVersion: ConfigurationStateVersionSchema,
    updatedAt: IsoDateTimeSchema,
    pendingRevisionId: Type.Union([ConfigurationRevisionIdSchema, Type.Null()]),
    lastAppliedRevisionId: Type.Union([ConfigurationRevisionIdSchema, Type.Null()]),
    lastFailedRevisionId: Type.Union([ConfigurationRevisionIdSchema, Type.Null()]),
    restartRequired: Type.Boolean(),
    /** False when no authorized typed reader is connected; values stay empty. */
    valuesAvailable: Type.Boolean(),
    values: Type.Array(ConfigurationFieldValueSchema, { maxItems: 64 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/configuration-resource-state.schema.json',
    additionalProperties: false,
  },
);

export const ConfigurationRevisionSummarySchema = Type.Object(
  {
    revisionId: ConfigurationRevisionIdSchema,
    operation: ConfigurationOperationSchema,
    status: Type.Union([
      Type.Literal('prepared'),
      Type.Literal('applied'),
      Type.Literal('failed'),
    ]),
    sourceRevisionId: Type.Union([ConfigurationRevisionIdSchema, Type.Null()]),
    expectedCurrentSha256: Sha256Schema,
    previousSha256: Type.Union([Sha256Schema, Type.Null()]),
    currentSha256: Type.Union([Sha256Schema, Type.Null()]),
    requestedFields: Type.Array(ConfigurationFieldNameSchema, { maxItems: 64 }),
    changedFields: Type.Union([
      Type.Array(ConfigurationFieldNameSchema, { maxItems: 64 }),
      Type.Null(),
    ]),
    restartRequired: Type.Union([Type.Boolean(), Type.Null()]),
    actor: ActorRefSchema,
    reasonCode: ConfigurationReasonCodeSchema,
    correlationId: UuidSchema,
    /** Sanitized failure code; stages, paths and messages stay server-side. */
    failureCode: Type.Union([
      Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9-]{0,63}$' }),
      Type.Null(),
    ]),
    rollbackEligible: Type.Boolean(),
    createdAt: IsoDateTimeSchema,
    completedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const ConfigurationRevisionPageSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    serverInstanceId: UuidSchema,
    resourceId: ConfigurationResourceIdSchema,
    revisions: Type.Array(ConfigurationRevisionSummarySchema, { maxItems: 100 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/configuration-revision-page.schema.json',
    additionalProperties: false,
  },
);

/**
 * Changes travel as an explicit list of reviewed field names. A map would need
 * `additionalProperties`, which the boundary refuses on purpose.
 */
export const ConfigurationChangeEntrySchema = Type.Object(
  {
    name: ConfigurationFieldNameSchema,
    value: ConfigurationValueSchema,
  },
  { additionalProperties: false },
);

export const ConfigurationChangeSetSchema = Type.Array(ConfigurationChangeEntrySchema, {
  minItems: 1,
  maxItems: 64,
});

export const ConfigurationValidationRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    changes: ConfigurationChangeSetSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/configuration-validation-request.schema.json',
    additionalProperties: false,
  },
);

export const ConfigurationValueIssueSchema = Type.Object(
  {
    field: ConfigurationFieldNameSchema,
    code: Type.Union([
      Type.Literal('unknown-field'),
      Type.Literal('duplicate-field'),
      Type.Literal('missing-required-field'),
      Type.Literal('invalid-type'),
      Type.Literal('out-of-range'),
      Type.Literal('too-long'),
      Type.Literal('pattern-mismatch'),
    ]),
  },
  { additionalProperties: false },
);

export const ConfigurationValidationResultSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    resourceId: ConfigurationResourceIdSchema,
    /** Always false: validation never mutates and never produces a revision. */
    applied: Type.Literal(false),
    valid: Type.Boolean(),
    issues: Type.Array(ConfigurationValueIssueSchema, { maxItems: 64 }),
    restartRequired: Type.Boolean(),
    /** Null when no authorized typed reader could supply the current values. */
    changedFields: Type.Union([
      Type.Array(ConfigurationFieldNameSchema, { maxItems: 64 }),
      Type.Null(),
    ]),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/configuration-validation-result.schema.json',
    additionalProperties: false,
  },
);

export const ConfigurationApplyRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    expectedCurrentSha256: Sha256Schema,
    expectedStateVersion: ConfigurationStateVersionSchema,
    idempotencyKey: ConfigurationIdempotencyKeySchema,
    reasonCode: ConfigurationReasonCodeSchema,
    changes: ConfigurationChangeSetSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/configuration-apply-request.schema.json',
    additionalProperties: false,
  },
);

export const ConfigurationRollbackRequestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    targetRevisionId: ConfigurationRevisionIdSchema,
    expectedCurrentSha256: Sha256Schema,
    expectedStateVersion: ConfigurationStateVersionSchema,
    idempotencyKey: ConfigurationIdempotencyKeySchema,
    reasonCode: ConfigurationReasonCodeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/configuration-rollback-request.schema.json',
    additionalProperties: false,
  },
);

export const ConfigurationOperationAcceptanceSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    jobId: UuidSchema,
    revisionId: ConfigurationRevisionIdSchema,
    resourceId: ConfigurationResourceIdSchema,
    operation: ConfigurationOperationSchema,
    status: Type.Union([
      Type.Literal('queued'),
      Type.Literal('running'),
      Type.Literal('succeeded'),
      Type.Literal('failed'),
    ]),
    idempotencyKey: ConfigurationIdempotencyKeySchema,
    /** True when an identical request was replayed and no new work was created. */
    replayed: Type.Boolean(),
    correlationId: UuidSchema,
    acceptedAt: IsoDateTimeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/configuration-operation-acceptance.schema.json',
    additionalProperties: false,
  },
);

/**
 * Typed command handed to the Server Agent capability. It names a registered
 * resource and reviewed fields; the agent resolves root, path, schema and codec
 * from its own trusted local configuration.
 */
export const ConfigurationOperationCommandSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    operation: ConfigurationOperationSchema,
    serverInstanceId: UuidSchema,
    resourceId: ConfigurationResourceIdSchema,
    revisionId: ConfigurationRevisionIdSchema,
    sourceRevisionId: Type.Union([ConfigurationRevisionIdSchema, Type.Null()]),
    expectedCurrentSha256: Sha256Schema,
    expectedStateVersion: ConfigurationStateVersionSchema,
    reasonCode: ConfigurationReasonCodeSchema,
    correlationId: UuidSchema,
    actor: ActorRefSchema,
    changes: Type.Array(ConfigurationChangeEntrySchema, { maxItems: 64 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/configuration-operation-command.schema.json',
    additionalProperties: false,
  },
);

/** Sanitized result the agent reports back for a completed typed operation. */
export const ConfigurationOperationResultSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    revisionId: ConfigurationRevisionIdSchema,
    resourceId: ConfigurationResourceIdSchema,
    operation: ConfigurationOperationSchema,
    outcome: Type.Union([Type.Literal('applied'), Type.Literal('failed')]),
    previousSha256: Type.Union([Sha256Schema, Type.Null()]),
    currentSha256: Type.Union([Sha256Schema, Type.Null()]),
    changedFields: Type.Array(ConfigurationFieldNameSchema, { maxItems: 64 }),
    restartRequired: Type.Boolean(),
    failureCode: Type.Union([
      Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9-]{0,63}$' }),
      Type.Null(),
    ]),
    completedAt: IsoDateTimeSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/configuration-operation-result.schema.json',
    additionalProperties: false,
  },
);

export type ConfigurationValue = Static<typeof ConfigurationValueSchema>;
export type ConfigurationFieldDescriptor = Static<typeof ConfigurationFieldDescriptorSchema>;
export type ConfigurationSchemaDescriptor = Static<typeof ConfigurationSchemaDescriptorSchema>;
export type ConfigurationSchemaCatalog = Static<typeof ConfigurationSchemaCatalogSchema>;
export type ConfigurationFieldValue = Static<typeof ConfigurationFieldValueSchema>;
export type ConfigurationResourceState = Static<typeof ConfigurationResourceStateSchema>;
export type ConfigurationRevisionSummary = Static<typeof ConfigurationRevisionSummarySchema>;
export type ConfigurationRevisionPage = Static<typeof ConfigurationRevisionPageSchema>;
export type ConfigurationChangeEntry = Static<typeof ConfigurationChangeEntrySchema>;
export type ConfigurationValidationRequest = Static<typeof ConfigurationValidationRequestSchema>;
export type ConfigurationValueIssue = Static<typeof ConfigurationValueIssueSchema>;
export type ConfigurationValidationResult = Static<typeof ConfigurationValidationResultSchema>;
export type ConfigurationApplyRequest = Static<typeof ConfigurationApplyRequestSchema>;
export type ConfigurationRollbackRequest = Static<typeof ConfigurationRollbackRequestSchema>;
export type ConfigurationOperationAcceptance = Static<
  typeof ConfigurationOperationAcceptanceSchema
>;
export type ConfigurationOperationCommand = Static<typeof ConfigurationOperationCommandSchema>;
export type ConfigurationOperationResult = Static<typeof ConfigurationOperationResultSchema>;

function duplicateNames(entries: readonly { readonly name: string }[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) duplicates.add(entry.name);
    seen.add(entry.name);
  }
  return [...duplicates].sort();
}

function changeSetIssues(
  changes: readonly ConfigurationChangeEntry[],
  pointer: string,
): readonly ContractValidationIssue[] {
  return duplicateNames(changes).map((name) =>
    semanticIssue(pointer, `field ${name} appears more than once`),
  );
}

export function validateConfigurationSchemaCatalog(
  value: unknown,
): ContractValidationResult<ConfigurationSchemaCatalog> {
  const result = validateContract(ConfigurationSchemaCatalogSchema, value);
  if (!result.success) return result;

  const issues: ContractValidationIssue[] = [];
  for (const [index, descriptor] of result.value.schemas.entries()) {
    for (const name of duplicateNames(descriptor.fields)) {
      issues.push(
        semanticIssue(`/schemas/${index}/fields`, `field ${name} appears more than once`),
      );
    }
    if (
      descriptor.restartRequired !== descriptor.fields.some((field) => field.restartRequired)
    ) {
      issues.push(
        semanticIssue(
          `/schemas/${index}/restartRequired`,
          'restartRequired must summarize the declared fields',
        ),
      );
    }
    for (const [fieldIndex, field] of descriptor.fields.entries()) {
      if (field.type === 'integer' && field.minimum > field.maximum) {
        issues.push(
          semanticIssue(
            `/schemas/${index}/fields/${fieldIndex}/minimum`,
            'minimum cannot exceed maximum',
          ),
        );
      }
    }
  }
  if (duplicateNames(result.value.schemas.map((schema) => ({ name: schema.resourceId }))).length > 0) {
    issues.push(semanticIssue('/schemas', 'resourceId must be unique in a catalog'));
  }

  return appendSemanticIssues(result, issues);
}

export function validateConfigurationResourceState(
  value: unknown,
): ContractValidationResult<ConfigurationResourceState> {
  const result = validateContract(ConfigurationResourceStateSchema, value);
  if (!result.success) return result;

  const issues: ContractValidationIssue[] = [];
  const state = result.value;

  if ((state.status === 'prepared') !== (state.pendingRevisionId !== null)) {
    issues.push(
      semanticIssue('/pendingRevisionId', 'a pending revision exists exactly while prepared'),
    );
  }
  if (!state.valuesAvailable && state.values.length > 0) {
    issues.push(semanticIssue('/values', 'values must be empty when no reader is available'));
  }
  for (const name of duplicateNames(state.values)) {
    issues.push(semanticIssue('/values', `field ${name} appears more than once`));
  }

  return appendSemanticIssues(result, issues);
}

export function validateConfigurationRevisionPage(
  value: unknown,
): ContractValidationResult<ConfigurationRevisionPage> {
  const result = validateContract(ConfigurationRevisionPageSchema, value);
  if (!result.success) return result;

  const issues: ContractValidationIssue[] = [];
  for (const [index, revision] of result.value.revisions.entries()) {
    if ((revision.operation === 'rollback') !== (revision.sourceRevisionId !== null)) {
      issues.push(
        semanticIssue(
          `/revisions/${index}/sourceRevisionId`,
          'a source revision exists exactly for a rollback',
        ),
      );
    }
    if (revision.status === 'applied' && revision.currentSha256 === null) {
      issues.push(
        semanticIssue(`/revisions/${index}/currentSha256`, 'an applied revision has a current hash'),
      );
    }
    if (revision.status === 'failed' && revision.failureCode === null) {
      issues.push(
        semanticIssue(`/revisions/${index}/failureCode`, 'a failed revision has a failure code'),
      );
    }
    if (revision.status !== 'failed' && revision.failureCode !== null) {
      issues.push(
        semanticIssue(
          `/revisions/${index}/failureCode`,
          'only a failed revision carries a failure code',
        ),
      );
    }
    if (revision.rollbackEligible && revision.status !== 'applied') {
      issues.push(
        semanticIssue(
          `/revisions/${index}/rollbackEligible`,
          'only an applied revision is eligible for rollback',
        ),
      );
    }
    if (
      revision.completedAt !== null &&
      Date.parse(revision.completedAt) < Date.parse(revision.createdAt)
    ) {
      issues.push(
        semanticIssue(`/revisions/${index}/completedAt`, 'completedAt cannot precede createdAt'),
      );
    }
  }
  if (duplicateNames(result.value.revisions.map((revision) => ({ name: revision.revisionId }))).length > 0) {
    issues.push(semanticIssue('/revisions', 'revisionId must be unique in a page'));
  }

  return appendSemanticIssues(result, issues);
}

export function validateConfigurationValidationRequest(
  value: unknown,
): ContractValidationResult<ConfigurationValidationRequest> {
  const result = validateContract(ConfigurationValidationRequestSchema, value);
  if (!result.success) return result;
  return appendSemanticIssues(result, changeSetIssues(result.value.changes, '/changes'));
}

export function validateConfigurationValidationResult(
  value: unknown,
): ContractValidationResult<ConfigurationValidationResult> {
  const result = validateContract(ConfigurationValidationResultSchema, value);
  if (!result.success) return result;

  const issues: ContractValidationIssue[] = [];
  if (result.value.valid !== (result.value.issues.length === 0)) {
    issues.push(semanticIssue('/valid', 'valid must agree with the reported issues'));
  }
  if (!result.value.valid && result.value.changedFields !== null) {
    issues.push(
      semanticIssue('/changedFields', 'an invalid request cannot report a change set'),
    );
  }
  return appendSemanticIssues(result, issues);
}

export function validateConfigurationApplyRequest(
  value: unknown,
): ContractValidationResult<ConfigurationApplyRequest> {
  const result = validateContract(ConfigurationApplyRequestSchema, value);
  if (!result.success) return result;
  return appendSemanticIssues(result, changeSetIssues(result.value.changes, '/changes'));
}

export function validateConfigurationRollbackRequest(
  value: unknown,
): ContractValidationResult<ConfigurationRollbackRequest> {
  return validateContract(ConfigurationRollbackRequestSchema, value);
}

export function validateConfigurationOperationAcceptance(
  value: unknown,
): ContractValidationResult<ConfigurationOperationAcceptance> {
  return validateContract(ConfigurationOperationAcceptanceSchema, value);
}

export function validateConfigurationOperationCommand(
  value: unknown,
): ContractValidationResult<ConfigurationOperationCommand> {
  const result = validateContract(ConfigurationOperationCommandSchema, value);
  if (!result.success) return result;

  const issues: ContractValidationIssue[] = [...changeSetIssues(result.value.changes, '/changes')];
  const command = result.value;

  if (command.operation === 'update') {
    if (command.sourceRevisionId !== null) {
      issues.push(semanticIssue('/sourceRevisionId', 'an update has no source revision'));
    }
    if (command.changes.length === 0) {
      issues.push(semanticIssue('/changes', 'an update requires at least one change'));
    }
  } else {
    if (command.sourceRevisionId === null) {
      issues.push(semanticIssue('/sourceRevisionId', 'a rollback requires a source revision'));
    }
    if (command.changes.length > 0) {
      issues.push(semanticIssue('/changes', 'a rollback cannot carry field changes'));
    }
    if (command.sourceRevisionId === command.revisionId) {
      issues.push(
        semanticIssue('/sourceRevisionId', 'a rollback cannot target the revision it creates'),
      );
    }
  }

  return appendSemanticIssues(result, issues);
}

export function validateConfigurationOperationResult(
  value: unknown,
): ContractValidationResult<ConfigurationOperationResult> {
  const result = validateContract(ConfigurationOperationResultSchema, value);
  if (!result.success) return result;

  const issues: ContractValidationIssue[] = [];
  const operationResult = result.value;

  if (operationResult.outcome === 'applied') {
    if (operationResult.failureCode !== null) {
      issues.push(semanticIssue('/failureCode', 'an applied operation has no failure code'));
    }
    if (operationResult.currentSha256 === null || operationResult.previousSha256 === null) {
      issues.push(semanticIssue('/currentSha256', 'an applied operation reports both hashes'));
    }
  } else {
    if (operationResult.failureCode === null) {
      issues.push(semanticIssue('/failureCode', 'a failed operation reports a failure code'));
    }
    if (operationResult.changedFields.length > 0) {
      issues.push(semanticIssue('/changedFields', 'a failed operation changed no field'));
    }
  }

  return appendSemanticIssues(result, issues);
}
