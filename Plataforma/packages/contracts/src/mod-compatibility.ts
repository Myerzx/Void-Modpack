import { Type, type Static } from '@sinclair/typebox';
import {
  ContractSchemaVersion,
  FileNameSchema,
  IsoDateTimeSchema,
  SlugSchema,
} from './common.js';
import { InventoryRuntimeSchema } from './inventory-snapshot.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

export const ModCompatibilityContextKindSchema = Type.Union([
  Type.Literal('launcher_current'),
  Type.Literal('server_active'),
  Type.Literal('reference_client'),
  Type.Literal('historical'),
]);

export const ModCompatibilityContextSchema = Type.Object(
  {
    id: SlugSchema,
    kind: ModCompatibilityContextKindSchema,
    side: Type.Union([Type.Literal('client'), Type.Literal('server')]),
    runtime: InventoryRuntimeSchema,
    javaVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    evidenceReference: Type.String({ minLength: 1, maxLength: 2_048 }),
  },
  { additionalProperties: false },
);

export const ModCompatibilityOccurrenceSchema = Type.Object(
  {
    occurrenceId: SlugSchema,
    contextId: SlugSchema,
    artifactId: Type.String({
      minLength: 1,
      maxLength: 160,
      pattern: '^(?:sha256:[a-f0-9]{64}|fixture:[a-z0-9][a-z0-9-]{0,127})$',
    }),
    filename: FileNameSchema,
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    loader: Type.Union([
      Type.Literal('forge'),
      Type.Literal('neoforge'),
      Type.Literal('fabric'),
      Type.Literal('quilt'),
      Type.Literal('vanilla'),
    ]),
    container: Type.Union([
      Type.Object({ kind: Type.Literal('root') }, { additionalProperties: false }),
      Type.Object(
        {
          kind: Type.Literal('jarjar'),
          parentArtifactId: Type.String({
            minLength: 1,
            maxLength: 160,
            pattern: '^(?:sha256:[a-f0-9]{64}|fixture:[a-z0-9][a-z0-9-]{0,127})$',
          }),
        },
        { additionalProperties: false },
      ),
    ]),
    metadataPath: Type.String({ minLength: 1, maxLength: 2_048 }),
  },
  { additionalProperties: false },
);

export const ModCompatibilityDependencySchema = Type.Object(
  {
    occurrenceId: SlugSchema,
    targetId: SlugSchema,
    required: Type.Boolean(),
    side: Type.Union([
      Type.Literal('client'),
      Type.Literal('server'),
      Type.Literal('both'),
    ]),
    versionRange: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    evidenceReference: Type.String({ minLength: 1, maxLength: 2_048 }),
  },
  { additionalProperties: false },
);

export const ModCompatibilityComponentSchema = Type.Object(
  {
    id: SlugSchema,
    kind: Type.Union([Type.Literal('root-mod'), Type.Literal('embedded-library')]),
    occurrences: Type.Array(ModCompatibilityOccurrenceSchema, { minItems: 1, maxItems: 2_048 }),
    dependencies: Type.Array(ModCompatibilityDependencySchema, { maxItems: 8_192 }),
  },
  { additionalProperties: false },
);

export const ModCompatibilityAnalysisPlanSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    analysisId: SlugSchema,
    generatedAt: IsoDateTimeSchema,
    contexts: Type.Array(ModCompatibilityContextSchema, { minItems: 2, maxItems: 64 }),
    components: Type.Array(ModCompatibilityComponentSchema, { maxItems: 100_000 }),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/mod-compatibility-analysis-plan.schema.json',
    additionalProperties: false,
  },
);

export const ModCompatibilityFindingCodeSchema = Type.Union([
  Type.Literal('canonical-version-conflict'),
  Type.Literal('reference-version-divergence'),
  Type.Literal('historical-version-divergence'),
  Type.Literal('reference-only-component'),
  Type.Literal('loader-mismatch'),
  Type.Literal('missing-required-dependency'),
  Type.Literal('dependency-version-mismatch'),
  Type.Literal('dependency-version-unknown'),
]);

export const ModCompatibilityFindingSchema = Type.Object(
  {
    code: ModCompatibilityFindingCodeSchema,
    severity: Type.Union([
      Type.Literal('blocker'),
      Type.Literal('warning'),
      Type.Literal('information'),
    ]),
    componentIds: Type.Array(SlugSchema, { minItems: 1, maxItems: 16 }),
    contextIds: Type.Array(SlugSchema, { minItems: 1, maxItems: 16 }),
    reference: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
    evidenceReferences: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), {
      minItems: 1,
      maxItems: 32,
    }),
  },
  { additionalProperties: false },
);

export const ModCompatibilityContextEvaluationSchema = Type.Object(
  {
    contextId: SlugSchema,
    status: Type.Union([
      Type.Literal('compatible'),
      Type.Literal('incompatible'),
      Type.Literal('unknown'),
      Type.Literal('not-present'),
    ]),
    versions: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 2_048 }),
    loaders: Type.Array(
      Type.Union([
        Type.Literal('forge'),
        Type.Literal('neoforge'),
        Type.Literal('fabric'),
        Type.Literal('quilt'),
        Type.Literal('vanilla'),
      ]),
      { maxItems: 5 },
    ),
  },
  { additionalProperties: false },
);

export const ModCompatibilityComponentEvaluationSchema = Type.Object(
  {
    componentId: SlugSchema,
    kind: Type.Union([Type.Literal('root-mod'), Type.Literal('embedded-library')]),
    status: Type.Union([
      Type.Literal('compatible'),
      Type.Literal('incompatible'),
      Type.Literal('unknown'),
    ]),
    contexts: Type.Array(ModCompatibilityContextEvaluationSchema, { minItems: 2, maxItems: 64 }),
  },
  { additionalProperties: false },
);

export const ModCompatibilityReportSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    analysisId: SlugSchema,
    generatedAt: IsoDateTimeSchema,
    contexts: Type.Array(ModCompatibilityContextSchema, { minItems: 2, maxItems: 64 }),
    components: Type.Array(ModCompatibilityComponentEvaluationSchema, { maxItems: 100_000 }),
    findings: Type.Array(ModCompatibilityFindingSchema, { maxItems: 1_000_000 }),
    summary: Type.Object(
      {
        compatibleComponents: Type.Integer({ minimum: 0 }),
        incompatibleComponents: Type.Integer({ minimum: 0 }),
        unknownComponents: Type.Integer({ minimum: 0 }),
        blockerCount: Type.Integer({ minimum: 0 }),
        warningCount: Type.Integer({ minimum: 0 }),
        informationCount: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/mod-compatibility-report.schema.json',
    additionalProperties: false,
  },
);

export type ModCompatibilityContextKind = Static<typeof ModCompatibilityContextKindSchema>;
export type ModCompatibilityContext = Static<typeof ModCompatibilityContextSchema>;
export type ModCompatibilityOccurrence = Static<typeof ModCompatibilityOccurrenceSchema>;
export type ModCompatibilityDependency = Static<typeof ModCompatibilityDependencySchema>;
export type ModCompatibilityComponent = Static<typeof ModCompatibilityComponentSchema>;
export type ModCompatibilityAnalysisPlan = Static<typeof ModCompatibilityAnalysisPlanSchema>;
export type ModCompatibilityFindingCode = Static<typeof ModCompatibilityFindingCodeSchema>;
export type ModCompatibilityFinding = Static<typeof ModCompatibilityFindingSchema>;
export type ModCompatibilityContextEvaluation = Static<
  typeof ModCompatibilityContextEvaluationSchema
>;
export type ModCompatibilityComponentEvaluation = Static<
  typeof ModCompatibilityComponentEvaluationSchema
>;
export type ModCompatibilityReport = Static<typeof ModCompatibilityReportSchema>;

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function contextIssues(
  contexts: readonly ModCompatibilityContext[],
): ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];
  for (const duplicate of duplicateValues(contexts.map((context) => context.id))) {
    issues.push(semanticIssue('/contexts', `duplicate context id: ${duplicate}`));
  }
  const launcherContexts = contexts.filter((context) => context.kind === 'launcher_current');
  const serverContexts = contexts.filter((context) => context.kind === 'server_active');
  if (launcherContexts.length !== 1) {
    issues.push(semanticIssue('/contexts', 'exactly one launcher_current context is required'));
  }
  if (serverContexts.length !== 1) {
    issues.push(semanticIssue('/contexts', 'exactly one server_active context is required'));
  }
  for (const [index, context] of contexts.entries()) {
    if (
      (context.kind === 'launcher_current' || context.kind === 'reference_client') &&
      context.side !== 'client'
    ) {
      issues.push(semanticIssue(`/contexts/${index}/side`, `${context.kind} must be client`));
    }
    if (context.kind === 'server_active' && context.side !== 'server') {
      issues.push(semanticIssue(`/contexts/${index}/side`, 'server_active must be server'));
    }
  }
  return issues;
}

export function validateModCompatibilityAnalysisPlan(
  value: unknown,
): ContractValidationResult<ModCompatibilityAnalysisPlan> {
  const result = validateContract(ModCompatibilityAnalysisPlanSchema, value);
  if (!result.success) return result;

  const issues = contextIssues(result.value.contexts);
  const contextIds = new Set(result.value.contexts.map((context) => context.id));
  for (const duplicate of duplicateValues(result.value.components.map((component) => component.id))) {
    issues.push(semanticIssue('/components', `duplicate component id: ${duplicate}`));
  }
  for (const [componentIndex, component] of result.value.components.entries()) {
    const occurrenceIdValues = component.occurrences.map((occurrence) => occurrence.occurrenceId);
    const occurrenceIds = new Set(occurrenceIdValues);
    for (const duplicate of duplicateValues(occurrenceIdValues)) {
      issues.push(
        semanticIssue(
          `/components/${componentIndex}/occurrences`,
          `duplicate occurrence id: ${duplicate}`,
        ),
      );
    }
    for (const [occurrenceIndex, occurrence] of component.occurrences.entries()) {
      if (!contextIds.has(occurrence.contextId)) {
        issues.push(
          semanticIssue(
            `/components/${componentIndex}/occurrences/${occurrenceIndex}/contextId`,
            'occurrence context must exist',
          ),
        );
      }
      if (component.kind === 'root-mod' && occurrence.container.kind !== 'root') {
        issues.push(
          semanticIssue(
            `/components/${componentIndex}/occurrences/${occurrenceIndex}/container`,
            'root-mod occurrences must use the root container',
          ),
        );
      }
      if (component.kind === 'embedded-library' && occurrence.container.kind !== 'jarjar') {
        issues.push(
          semanticIssue(
            `/components/${componentIndex}/occurrences/${occurrenceIndex}/container`,
            'embedded-library occurrences must use the jarjar container',
          ),
        );
      }
    }
    for (const [dependencyIndex, dependency] of component.dependencies.entries()) {
      if (!occurrenceIds.has(dependency.occurrenceId)) {
        issues.push(
          semanticIssue(
            `/components/${componentIndex}/dependencies/${dependencyIndex}/occurrenceId`,
            'dependency occurrence must belong to its component',
          ),
        );
      }
    }
  }
  return appendSemanticIssues(result, issues);
}

export function validateModCompatibilityReport(
  value: unknown,
): ContractValidationResult<ModCompatibilityReport> {
  const result = validateContract(ModCompatibilityReportSchema, value);
  if (!result.success) return result;

  const issues = contextIssues(result.value.contexts);
  for (const duplicate of duplicateValues(result.value.components.map((item) => item.componentId))) {
    issues.push(semanticIssue('/components', `duplicate component id: ${duplicate}`));
  }
  const componentIds = new Set(result.value.components.map((item) => item.componentId));
  const contextIds = new Set(result.value.contexts.map((context) => context.id));
  for (const [componentIndex, component] of result.value.components.entries()) {
    const evaluatedContextIds = component.contexts.map((context) => context.contextId);
    if (
      duplicateValues(evaluatedContextIds).length > 0 ||
      evaluatedContextIds.length !== contextIds.size ||
      evaluatedContextIds.some((contextId) => !contextIds.has(contextId))
    ) {
      issues.push(
        semanticIssue(
          `/components/${componentIndex}/contexts`,
          'component must evaluate every report context exactly once',
        ),
      );
    }
  }
  for (const [findingIndex, finding] of result.value.findings.entries()) {
    if (!finding.componentIds.some((componentId) => componentIds.has(componentId))) {
      issues.push(
        semanticIssue(
          `/findings/${findingIndex}/componentIds`,
          'at least one finding component must exist in the report',
        ),
      );
    }
    if (finding.contextIds.some((contextId) => !contextIds.has(contextId))) {
      issues.push(
        semanticIssue(
          `/findings/${findingIndex}/contextIds`,
          'finding context must exist in the report',
        ),
      );
    }
  }
  const summary = result.value.summary;
  const compatibleComponents = result.value.components.filter(
    (component) => component.status === 'compatible',
  ).length;
  const incompatibleComponents = result.value.components.filter(
    (component) => component.status === 'incompatible',
  ).length;
  const unknownComponents = result.value.components.filter(
    (component) => component.status === 'unknown',
  ).length;
  if (
    summary.compatibleComponents !== compatibleComponents ||
    summary.incompatibleComponents !== incompatibleComponents ||
    summary.unknownComponents !== unknownComponents
  ) {
    issues.push(semanticIssue('/summary', 'component status totals must match the report'));
  }
  if (
    summary.blockerCount !==
      result.value.findings.filter((finding) => finding.severity === 'blocker').length ||
    summary.warningCount !==
      result.value.findings.filter((finding) => finding.severity === 'warning').length ||
    summary.informationCount !==
      result.value.findings.filter((finding) => finding.severity === 'information').length
  ) {
    issues.push(semanticIssue('/summary', 'finding totals must match the report'));
  }
  return appendSemanticIssues(result, issues);
}
