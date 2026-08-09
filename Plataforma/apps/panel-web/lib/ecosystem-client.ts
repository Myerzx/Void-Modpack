import { panelRequest } from './workspace-client';

export type AnalysisStatus = 'complete' | 'partial' | 'unavailable';
export type KnowledgeStatus = 'detected' | 'interpreted' | 'inferred' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low' | 'unknown';

export interface EcosystemModSummary {
  readonly modId: string;
  readonly displayName: string | null;
  readonly version: string | null;
  readonly loader: string;
  readonly side: string;
  readonly editLevel: string;
  readonly analysisStatus: AnalysisStatus;
  readonly configurationCount: number;
  readonly systemCount: number;
  readonly datapackCount: number;
  readonly dependencyCount: number;
  readonly integrationCount: number;
  readonly problemCount: number;
}

export interface EcosystemConfiguration {
  readonly configurationId: string;
  readonly modId: string;
  readonly systemId: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string;
  readonly type: string;
  readonly currentValue: boolean | number | string | readonly (boolean | number | string)[];
  readonly defaultValue: boolean | number | string | readonly (boolean | number | string)[] | null;
  readonly constraints: readonly {
    readonly kind: 'range' | 'allowed-values';
    readonly minimum?: number | null;
    readonly maximum?: number | null;
    readonly values?: readonly string[];
    readonly source: 'declared' | 'observed';
  }[];
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
  readonly side: string;
  readonly restartRequired: boolean | null;
  readonly editable: boolean;
  readonly status: KnowledgeStatus;
  readonly confidence: Confidence;
  readonly evidenceIds: readonly string[];
}

export interface EcosystemSystem {
  readonly systemId: string;
  readonly modId: string;
  readonly slug: string;
  readonly title: string;
  readonly status: KnowledgeStatus;
  readonly confidence: Confidence;
  readonly configurationIds: readonly string[];
  readonly datapackResourceIds: readonly string[];
  readonly relationshipIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface EcosystemDatapack {
  readonly datapackId: string;
  readonly name: string;
  readonly loader: string;
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

export interface EcosystemDatapackConflict {
  readonly conflictId: string;
  readonly coordinate: string;
  readonly kind: 'duplicate-identical' | 'divergent-content';
  readonly resourceIds: readonly string[];
  readonly datapackIds: readonly string[];
  readonly resolution: 'unknown-load-order';
  readonly status: KnowledgeStatus;
  readonly confidence: Confidence;
  readonly evidenceIds: readonly string[];
}

export interface EcosystemDatapackResource {
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
  readonly semanticFields: readonly {
    readonly configurationId: string;
    readonly path: string;
    readonly label: string;
    readonly type: 'boolean' | 'number' | 'string';
    readonly currentValue: boolean | number | string;
    readonly defaultValue: boolean | number | string | null;
    readonly editable: boolean;
  }[];
  readonly conflictIds: readonly string[];
  readonly parseIssue: string | null;
  readonly status: KnowledgeStatus;
  readonly confidence: Confidence;
  readonly evidenceIds: readonly string[];
}

export interface EcosystemRelationship {
  readonly relationshipId: string;
  readonly from: { readonly type: string; readonly id: string };
  readonly to: { readonly type: string; readonly id: string };
  readonly type: string;
  readonly systemId: string | null;
  readonly reason: string;
  readonly status: KnowledgeStatus;
  readonly confidence: Confidence;
  readonly evidenceIds: readonly string[];
}

export interface EcosystemEvidence {
  readonly evidenceId: string;
  readonly source: string;
  readonly sourcePath: string;
  readonly sha256: string | null;
  readonly detail: string;
  readonly status: KnowledgeStatus;
  readonly confidence: Confidence;
}

export interface EcosystemModDetail {
  readonly dataQuality: 'stored';
  readonly analysisId: string;
  readonly mod: {
    readonly modId: string;
    readonly displayName: string | null;
    readonly version: string | null;
    readonly loader: string;
    readonly side: string;
    readonly editLevel: string;
    readonly analysisStatus: AnalysisStatus;
    readonly archivePath: string;
    readonly archiveSha256: string;
    readonly configurationIds: readonly string[];
    readonly systemIds: readonly string[];
    readonly datapackIds: readonly string[];
    readonly relationshipIds: readonly string[];
    readonly issueIds: readonly string[];
    readonly evidenceIds: readonly string[];
  };
  readonly configurations: readonly EcosystemConfiguration[];
  readonly systems: readonly EcosystemSystem[];
  readonly datapacks: readonly EcosystemDatapack[];
  readonly datapackResourceSummary: readonly {
    readonly namespace: string;
    readonly resourceType: string;
    readonly effect: string;
    readonly count: number;
    readonly reviewedCount: number;
    readonly semanticFieldCount: number;
    readonly conflictCount: number;
  }[];
  readonly datapackConflicts: readonly EcosystemDatapackConflict[];
  readonly relationships: readonly EcosystemRelationship[];
  readonly evidence: readonly EcosystemEvidence[];
  readonly issues: readonly {
    readonly issueId: string;
    readonly severity: string;
    readonly code: string;
    readonly detail: string;
    readonly subjectId: string;
    readonly evidenceIds: readonly string[];
  }[];
}

export async function listEcosystemMods(workspaceId: string): Promise<{
  readonly dataQuality: string;
  readonly analysisId?: string;
  readonly generatedAt?: string;
  readonly mods: readonly EcosystemModSummary[];
}> {
  return panelRequest(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/ecosystem/mods`);
}

export interface EcosystemDatapackSummary extends EcosystemDatapack {
  readonly resourceCount: number;
  readonly overrideCount: number;
  readonly extensionCount: number;
  readonly unknownCount: number;
  readonly reviewedResourceCount: number;
  readonly semanticFieldCount: number;
  readonly conflictCount: number;
  readonly resourceTypes: readonly (readonly [string, number])[];
}

export async function listEcosystemDatapacks(workspaceId: string): Promise<{
  readonly dataQuality: string;
  readonly analysisId?: string;
  readonly generatedAt?: string;
  readonly datapacks: readonly EcosystemDatapackSummary[];
}> {
  return panelRequest(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/ecosystem/datapacks`);
}

export async function readEcosystemMod(workspaceId: string, modId: string): Promise<EcosystemModDetail> {
  return panelRequest(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/ecosystem/mods/${encodeURIComponent(modId)}`,
  );
}

export async function listEcosystemDatapackResources(input: {
  readonly workspaceId: string;
  readonly modId: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly query?: string;
  readonly resourceType?: string;
  readonly effect?: string;
  readonly reviewed?: boolean;
  readonly conflicts?: boolean;
}): Promise<{
  readonly dataQuality: 'stored';
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly resources: readonly EcosystemDatapackResource[];
  readonly conflicts: readonly EcosystemDatapackConflict[];
}> {
  const parameters = new URLSearchParams();
  if (input.offset !== undefined) parameters.set('offset', String(input.offset));
  if (input.limit !== undefined) parameters.set('limit', String(input.limit));
  if (input.query !== undefined && input.query.trim().length > 0) parameters.set('q', input.query.trim());
  if (input.resourceType !== undefined && input.resourceType.length > 0) parameters.set('resourceType', input.resourceType);
  if (input.effect !== undefined && input.effect.length > 0) parameters.set('effect', input.effect);
  if (input.reviewed !== undefined) parameters.set('reviewed', String(input.reviewed));
  if (input.conflicts !== undefined) parameters.set('conflicts', String(input.conflicts));
  const query = parameters.size === 0 ? '' : `?${parameters.toString()}`;
  return panelRequest(
    `/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}/ecosystem/mods/${encodeURIComponent(input.modId)}/datapack-resources${query}`,
  );
}

export async function runEcosystemAnalysis(workspaceId: string, csrfToken: string): Promise<{
  readonly cacheStatus: 'cached' | 'generated';
  readonly analysisId: string;
  readonly summary: Readonly<Record<string, number>>;
}> {
  return panelRequest(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/analysis`, {
    method: 'POST',
    csrfToken,
  });
}
