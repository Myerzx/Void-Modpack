import type { InferredFieldType } from '@voidfall/configuration-inference';

export const ECOSYSTEM_ANALYSIS_SCHEMA_VERSION = 2 as const;
export const ECOSYSTEM_ANALYZER_VERSION = '1.3.0' as const;

export type KnowledgeStatus = 'detected' | 'interpreted' | 'inferred' | 'unknown';
export type AnalysisConfidence = 'high' | 'medium' | 'low' | 'unknown';
export type AnalysisSide = 'client' | 'server' | 'both' | 'unknown';

export type EvidenceSource =
  | 'artifact-metadata'
  | 'archive-entry'
  | 'class-bytecode'
  | 'workspace-file'
  | 'forge-comment'
  | 'path-convention'
  | 'datapack-resource'
  | 'reviewed-schema'
  | 'analysis-rule';

export interface AnalysisEvidence {
  readonly evidenceId: string;
  readonly source: EvidenceSource;
  /** Workspace-relative file or archive entry. Never an absolute host path. */
  readonly sourcePath: string;
  readonly sha256: string | null;
  readonly detail: string;
  readonly status: KnowledgeStatus;
  readonly confidence: AnalysisConfidence;
}

export interface AnalyzedMod {
  readonly modId: string;
  readonly displayName: string | null;
  readonly version: string | null;
  readonly loader: string;
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly side: AnalysisSide;
  readonly editLevel: string;
  readonly configurationIds: readonly string[];
  readonly systemIds: readonly string[];
  readonly datapackIds: readonly string[];
  readonly relationshipIds: readonly string[];
  readonly issueIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly analysisStatus: 'complete' | 'partial' | 'unavailable';
}

export interface AnalyzedSystem {
  readonly systemId: string;
  readonly modId: string;
  readonly slug: string;
  readonly title: string;
  readonly status: KnowledgeStatus;
  readonly confidence: AnalysisConfidence;
  readonly configurationIds: readonly string[];
  readonly datapackResourceIds: readonly string[];
  readonly relationshipIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export type AnalyzedConfigurationType = InferredFieldType | 'enum';

export interface AnalyzedConfigurationConstraint {
  readonly kind: 'range' | 'allowed-values';
  readonly minimum?: number | null;
  readonly maximum?: number | null;
  readonly values?: readonly string[];
  readonly source: 'declared' | 'observed';
}

export interface AnalyzedConfiguration {
  readonly configurationId: string;
  readonly modId: string;
  readonly systemId: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string;
  readonly type: AnalyzedConfigurationType;
  readonly currentValue: boolean | number | string | readonly (boolean | number | string)[];
  /** Null means no source proved a default. It never means the current value is the default. */
  readonly defaultValue: boolean | number | string | readonly (boolean | number | string)[] | null;
  readonly constraints: readonly AnalyzedConfigurationConstraint[];
  readonly allowedValues: readonly string[];
  readonly source: {
    readonly kind: 'config-file' | 'datapack-resource';
    readonly file: string;
    readonly path: string;
    readonly line: number;
    readonly format: string;
    readonly parser: string;
    readonly datapackResourceId: string | null;
  };
  readonly side: AnalysisSide;
  readonly restartRequired: boolean | null;
  readonly editable: boolean;
  readonly status: KnowledgeStatus;
  readonly confidence: AnalysisConfidence;
  readonly evidenceIds: readonly string[];
}

export type DatapackLoader = 'openloader' | 'minecraft' | 'kubejs';

export interface AnalyzedDatapack {
  readonly datapackId: string;
  readonly name: string;
  readonly loader: DatapackLoader;
  readonly rootPath: string;
  readonly sha256: string;
  readonly description: string | null;
  readonly resourceIds: readonly string[];
  readonly namespaces: readonly string[];
  readonly ownerModId: string | null;
  readonly relatedModIds: readonly string[];
  readonly issueIds: readonly string[];
  readonly conflictIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface AnalyzedDatapackSemanticField {
  readonly configurationId: string;
  readonly path: string;
  readonly label: string;
  readonly type: 'boolean' | 'number' | 'string';
  readonly currentValue: boolean | number | string;
  readonly defaultValue: boolean | number | string | null;
  readonly editable: boolean;
}

export interface AnalyzedDatapackResource {
  readonly resourceId: string;
  readonly datapackId: string;
  readonly namespace: string;
  readonly resourceType: string;
  readonly resourcePath: string;
  readonly sourceFile: string;
  readonly sha256: string;
  readonly ownerModId: string | null;
  readonly systemId: string | null;
  readonly effect: 'overrides' | 'extends' | 'unknown';
  readonly reviewedSchema: {
    readonly schemaId: string;
    readonly schemaVersion: string;
    readonly schemaSha256: string;
    readonly parserId: string;
    readonly title: string;
  } | null;
  readonly semanticFields: readonly AnalyzedDatapackSemanticField[];
  readonly conflictIds: readonly string[];
  readonly parseIssue: string | null;
  readonly status: KnowledgeStatus;
  readonly confidence: AnalysisConfidence;
  readonly evidenceIds: readonly string[];
}

export interface AnalyzedDatapackConflict {
  readonly conflictId: string;
  readonly coordinate: string;
  readonly kind: 'duplicate-identical' | 'divergent-content';
  readonly resourceIds: readonly string[];
  readonly datapackIds: readonly string[];
  readonly resolution: 'unknown-load-order';
  readonly status: KnowledgeStatus;
  readonly confidence: AnalysisConfidence;
  readonly evidenceIds: readonly string[];
}

export type EcosystemRelationshipType =
  | 'OWNS'
  | 'DEFINED_IN'
  | 'USES'
  | 'PROVEN_BY'
  | 'REQUIRES'
  | 'OPTIONAL_DEPENDENCY'
  | 'LOADS_AFTER'
  | 'CONFIGURES'
  | 'INTEGRATES_WITH'
  | 'COMPATIBILITY'
  | 'READS_REGISTRY_FROM'
  | 'EXTENDS'
  | 'OVERRIDES'
  | 'DATAPACK_EXTENDS'
  | 'MODIFIES_GAMEPLAY_OF'
  | 'CONFLICTS_WITH'
  | 'PARTICIPATES_IN';

export type EcosystemEntityType =
  | 'Server'
  | 'Mod'
  | 'ModVersion'
  | 'System'
  | 'Configuration'
  | 'ConfigFile'
  | 'Datapack'
  | 'DatapackResource'
  | 'Registry'
  | 'Resource'
  | 'Conflict'
  | 'Evidence';

export interface EcosystemRelationship {
  readonly relationshipId: string;
  readonly from: { readonly type: EcosystemEntityType; readonly id: string };
  readonly to: { readonly type: EcosystemEntityType; readonly id: string };
  readonly type: EcosystemRelationshipType;
  readonly systemId: string | null;
  readonly reason: string;
  readonly status: KnowledgeStatus;
  readonly confidence: AnalysisConfidence;
  readonly evidenceIds: readonly string[];
}

export interface EcosystemGraphEntity {
  readonly id: string;
  readonly type: EcosystemEntityType;
  readonly label: string;
  readonly modId: string | null;
  readonly evidenceIds: readonly string[];
}

export interface EcosystemAnalysisIssue {
  readonly issueId: string;
  readonly severity: 'information' | 'warning' | 'blocker';
  readonly code: string;
  readonly detail: string;
  readonly subjectId: string;
  readonly evidenceIds: readonly string[];
}

export interface EcosystemAnalysis {
  readonly schemaVersion: typeof ECOSYSTEM_ANALYSIS_SCHEMA_VERSION;
  readonly analyzerVersion: typeof ECOSYSTEM_ANALYZER_VERSION;
  readonly analysisId: string;
  readonly inventorySha256: string;
  readonly generatedAt: string;
  readonly mods: readonly AnalyzedMod[];
  readonly systems: readonly AnalyzedSystem[];
  readonly configurations: readonly AnalyzedConfiguration[];
  readonly datapacks: readonly AnalyzedDatapack[];
  readonly datapackResources: readonly AnalyzedDatapackResource[];
  readonly datapackConflicts: readonly AnalyzedDatapackConflict[];
  readonly relationships: readonly EcosystemRelationship[];
  readonly evidence: readonly AnalysisEvidence[];
  readonly issues: readonly EcosystemAnalysisIssue[];
  readonly graph: {
    readonly entities: readonly EcosystemGraphEntity[];
    readonly relationshipIds: readonly string[];
  };
  readonly summary: {
    readonly mods: number;
    readonly systems: number;
    readonly configurations: number;
    readonly datapacks: number;
    readonly datapackResources: number;
    readonly datapackConflicts: number;
    readonly relationships: number;
    readonly issues: number;
  };
}

export type EcosystemAnalysisErrorCode =
  | 'invalid-root'
  | 'configuration-unreadable'
  | 'artifact-unreadable';

export class EcosystemAnalysisError extends Error {
  public readonly code: EcosystemAnalysisErrorCode;

  public constructor(code: EcosystemAnalysisErrorCode) {
    super(`ecosystem-analysis:${code}`);
    this.name = 'EcosystemAnalysisError';
    this.code = code;
  }
}
