import { Type, type Static } from '@sinclair/typebox';
import { ContractSchemaVersion, IsoDateTimeSchema, Sha256Schema } from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

/**
 * Public contract for a bounded artifact inspection report.
 *
 * The report states what an artifact *declares*. It never carries a filesystem
 * path, an absolute location, raw bytes or an entry name outside the closed set
 * of reviewed descriptors, and it never asserts compatibility — that judgement
 * belongs to the compatibility engine.
 */

export const DeclaredLoaderSchema = Type.Union([
  Type.Literal('forge'),
  Type.Literal('neoforge'),
  Type.Literal('fabric'),
  Type.Literal('legacy-mcmod'),
  Type.Literal('unknown'),
]);

export const DeclaredSideSchema = Type.Union([
  Type.Literal('CLIENT'),
  Type.Literal('SERVER'),
  Type.Literal('BOTH'),
]);

/** Closed set of descriptors an inspection is allowed to name as evidence. */
export const InspectionEvidenceSchema = Type.Union([
  Type.Literal('META-INF/MANIFEST.MF'),
  Type.Literal('META-INF/mods.toml'),
  Type.Literal('META-INF/neoforge.mods.toml'),
  Type.Literal('fabric.mod.json'),
  Type.Literal('META-INF/jarjar/metadata.json'),
  Type.Literal('mcmod.info'),
]);

export const ModIdSchema = Type.String({
  minLength: 2,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9_-]{1,63}$',
});

export const DeclaredDependencySchema = Type.Object(
  {
    target: Type.String({ minLength: 1, maxLength: 64 }),
    mandatory: Type.Boolean(),
    versionRange: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    side: DeclaredSideSchema,
    evidence: InspectionEvidenceSchema,
  },
  { additionalProperties: false },
);

export const DeclaredModSchema = Type.Object(
  {
    modId: ModIdSchema,
    displayName: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    /** Declared verbatim; an unresolved placeholder is preserved, not evaluated. */
    version: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    loader: DeclaredLoaderSchema,
    dependencies: Type.Array(DeclaredDependencySchema, { maxItems: 128 }),
    evidence: InspectionEvidenceSchema,
  },
  { additionalProperties: false },
);

export const EmbeddedLibrarySchema = Type.Object(
  {
    identifier: Type.String({ minLength: 3, maxLength: 257, pattern: '^[^:]+:[^:]+$' }),
    version: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    evidence: InspectionEvidenceSchema,
  },
  { additionalProperties: false },
);

/**
 * One depth of inspection, and what a limit left unanswered.
 *
 * Identification and enumeration are separate work with separate costs, so a
 * report says which of them happened. Without this a mod that was simply too
 * large to enumerate is indistinguishable from one that declares nothing —
 * and a pack builder cannot act on the difference it cannot see.
 */
export const InspectionLayerSchema = Type.Object(
  {
    layer: Type.Union([
      Type.Literal('metadata'),
      Type.Literal('structural'),
      Type.Literal('deep'),
    ]),
    outcome: Type.Union([
      Type.Literal('completed'),
      Type.Literal('refused'),
      Type.Literal('not-attempted'),
    ]),
    /** The limit that stopped it, by name. A refusal always names its cause. */
    limit: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    unknown: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 16 }),
  },
  { additionalProperties: false },
);

export const ArtifactInspectionReportSchema = Type.Object(
  {
    /** Self-describing discriminator emitted by the inspection service. */
    format: Type.Literal('voidfall-artifact-inspection'),
    schemaVersion: ContractSchemaVersion,
    sha256: Sha256Schema,
    sizeBytes: Type.Integer({ minimum: 1, maximum: 1_073_741_824 }),
    inspectedAt: IsoDateTimeSchema,
    container: Type.Literal('zip'),
    /**
     * `null` when the structural layer did not run.
     *
     * Nullable rather than zero: an archive nobody enumerated and an archive
     * with no entries have to read differently, or a report about a mod that
     * was too large to walk becomes indistinguishable from an empty file.
     */
    entryCount: Type.Union([Type.Integer({ minimum: 0, maximum: 1_000_000 }), Type.Null()]),
    expandedBytes: Type.Integer({ minimum: 0, maximum: 1_073_741_824 }),
    layers: Type.Array(InspectionLayerSchema, { minItems: 3, maxItems: 3 }),
    loaders: Type.Array(DeclaredLoaderSchema, { minItems: 1, maxItems: 5, uniqueItems: true }),
    mods: Type.Array(DeclaredModSchema, { maxItems: 64 }),
    embeddedLibraries: Type.Array(EmbeddedLibrarySchema, { maxItems: 64 }),
    evidence: Type.Array(InspectionEvidenceSchema, { maxItems: 6, uniqueItems: true }),
    metadataIssues: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32 }),
    /** `null` when nobody enumerated the archive — not all-false. */
    features: Type.Union([
      Type.Object(
        {
          containsClasses: Type.Boolean(),
          containsData: Type.Boolean(),
          containsAssets: Type.Boolean(),
          containsMixins: Type.Boolean(),
          containsNestedJars: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/artifact-inspection-report.schema.json',
    additionalProperties: false,
  },
);

export type DeclaredLoaderContract = Static<typeof DeclaredLoaderSchema>;
export type DeclaredDependencyContract = Static<typeof DeclaredDependencySchema>;
export type DeclaredModContract = Static<typeof DeclaredModSchema>;
export type EmbeddedLibraryContract = Static<typeof EmbeddedLibrarySchema>;
export type ArtifactInspectionReportContract = Static<typeof ArtifactInspectionReportSchema>;

export function validateArtifactInspectionReport(
  value: unknown,
): ContractValidationResult<ArtifactInspectionReportContract> {
  const result = validateContract(ArtifactInspectionReportSchema, value);
  if (!result.success) return result;

  const issues: ContractValidationIssue[] = [];
  const report = result.value;

  if (report.expandedBytes > report.sizeBytes * 1_000) {
    issues.push(semanticIssue('/expandedBytes', 'expansion is implausible for the archive size'));
  }
  // A mod may only be attributed to a loader the report also declares.
  for (const [index, mod] of report.mods.entries()) {
    if (!report.loaders.includes(mod.loader)) {
      issues.push(semanticIssue(`/mods/${index}/loader`, 'mod loader is absent from the declared loaders'));
    }
    if (!report.evidence.includes(mod.evidence)) {
      issues.push(semanticIssue(`/mods/${index}/evidence`, 'mod evidence is absent from the report evidence'));
    }
  }
  for (const [index, library] of report.embeddedLibraries.entries()) {
    if (!report.evidence.includes(library.evidence)) {
      issues.push(
        semanticIssue(`/embeddedLibraries/${index}/evidence`, 'library evidence is absent from the report evidence'),
      );
    }
  }
  // `unknown` describes the absence of a descriptor, so it cannot be combined.
  if (report.loaders.includes('unknown') && report.loaders.length > 1) {
    issues.push(semanticIssue('/loaders', 'unknown cannot be combined with a declared loader'));
  }
  if (report.loaders.includes('unknown') && report.mods.length > 0) {
    issues.push(semanticIssue('/mods', 'an unknown loader cannot declare mods'));
  }

  return appendSemanticIssues(result, issues);
}
