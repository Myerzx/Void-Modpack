import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

import type {
  AnalyzedDatapack,
  AnalyzedDatapackConflict,
  AnalyzedDatapackResource,
  EcosystemAnalysis,
} from './types.js';

export const DATAPACK_LOAD_ORDER_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const DATAPACK_LOAD_ORDER_PROJECTION_SCHEMA_VERSION = 1 as const;
export const MAXIMUM_OBSERVED_DATAPACKS = 4_096;

export type DatapackLoadOrderObservationSource =
  | 'minecraft-world-metadata-v1'
  | 'minecraft-runtime-report-v1';

export interface ObservedDatapackIdentity {
  /** Workspace-relative datapack root already normalized by a trusted adapter. */
  readonly rootPath: string;
  readonly sha256: string;
}

export interface DatapackLoadOrderObservation {
  readonly schemaVersion: typeof DATAPACK_LOAD_ORDER_OBSERVATION_SCHEMA_VERSION;
  readonly observationId: string;
  readonly source: DatapackLoadOrderObservationSource;
  readonly inventorySha256: string;
  readonly observedAt: string;
  readonly evidenceSha256: string;
  /** Minecraft priority normalized explicitly: the last item has the highest priority. */
  readonly order: 'lowest-priority-first';
  readonly datapacks: readonly ObservedDatapackIdentity[];
}

export type DatapackLoadOrderResolutionReason =
  | 'observed-winner'
  | 'inventory-mismatch'
  | 'analysis-participant-missing'
  | 'participant-not-observed'
  | 'participant-hash-mismatch'
  | 'participant-resource-ambiguous';

export interface ObservedDatapackConflictResolution {
  readonly conflictId: string;
  readonly status: 'resolved' | 'unresolved';
  readonly reason: DatapackLoadOrderResolutionReason;
  readonly participantDatapackIdsByPriority: readonly string[];
  readonly winningDatapackId: string | null;
  readonly winningResourceId: string | null;
}

export interface DatapackLoadOrderProjection {
  readonly schemaVersion: typeof DATAPACK_LOAD_ORDER_PROJECTION_SCHEMA_VERSION;
  readonly analysisId: string;
  readonly inventorySha256: string;
  readonly observationId: string;
  readonly observationSource: DatapackLoadOrderObservationSource;
  readonly observedAt: string;
  readonly evidenceSha256: string;
  /** This first slice proves precedence only; it never unlocks a write path. */
  readonly authorizesSemanticEditing: false;
  readonly resolutions: readonly ObservedDatapackConflictResolution[];
}

export class DatapackLoadOrderObservationError extends Error {
  public readonly code = 'invalid-datapack-load-order-observation' as const;

  public constructor() {
    super('ecosystem-analysis:invalid-datapack-load-order-observation');
    this.name = 'DatapackLoadOrderObservationError';
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const orderedExpected = [...expected].sort();
  return actual.length === orderedExpected.length &&
    actual.every((key, index) => key === orderedExpected[index]);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isSafeWorkspaceRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.startsWith('/') ||
    value.endsWith('/')
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

/**
 * Validates one already-sanitized observation without reading world metadata,
 * invoking Minecraft or accepting an absolute host path.
 */
export function parseDatapackLoadOrderObservation(input: unknown): DatapackLoadOrderObservation {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'schemaVersion',
      'source',
      'inventorySha256',
      'observedAt',
      'evidenceSha256',
      'order',
      'datapacks',
    ]) ||
    input.schemaVersion !== DATAPACK_LOAD_ORDER_OBSERVATION_SCHEMA_VERSION ||
    (input.source !== 'minecraft-world-metadata-v1' &&
      input.source !== 'minecraft-runtime-report-v1') ||
    !isSha256(input.inventorySha256) ||
    !isCanonicalTimestamp(input.observedAt) ||
    !isSha256(input.evidenceSha256) ||
    input.order !== 'lowest-priority-first' ||
    !Array.isArray(input.datapacks) ||
    input.datapacks.length === 0 ||
    input.datapacks.length > MAXIMUM_OBSERVED_DATAPACKS
  ) {
    throw new DatapackLoadOrderObservationError();
  }

  const datapacks: ObservedDatapackIdentity[] = [];
  const caseFoldedPaths = new Set<string>();
  for (const entry of input.datapacks) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['rootPath', 'sha256']) ||
      !isSafeWorkspaceRelativePath(entry.rootPath) ||
      !isSha256(entry.sha256)
    ) {
      throw new DatapackLoadOrderObservationError();
    }
    const foldedPath = entry.rootPath.toLocaleLowerCase('en-US');
    if (caseFoldedPaths.has(foldedPath)) throw new DatapackLoadOrderObservationError();
    caseFoldedPaths.add(foldedPath);
    datapacks.push({ rootPath: entry.rootPath, sha256: entry.sha256 });
  }

  const identity = JSON.stringify({
    schemaVersion: input.schemaVersion,
    source: input.source,
    inventorySha256: input.inventorySha256,
    observedAt: input.observedAt,
    evidenceSha256: input.evidenceSha256,
    order: input.order,
    datapacks,
  });
  return freezeDeep({
    schemaVersion: DATAPACK_LOAD_ORDER_OBSERVATION_SCHEMA_VERSION,
    observationId: sha256(identity),
    source: input.source,
    inventorySha256: input.inventorySha256,
    observedAt: input.observedAt,
    evidenceSha256: input.evidenceSha256,
    order: input.order,
    datapacks,
  });
}

function unresolved(
  conflict: AnalyzedDatapackConflict,
  reason: Exclude<DatapackLoadOrderResolutionReason, 'observed-winner'>,
): ObservedDatapackConflictResolution {
  return {
    conflictId: conflict.conflictId,
    status: 'unresolved',
    reason,
    participantDatapackIdsByPriority: Object.freeze([]),
    winningDatapackId: null,
    winningResourceId: null,
  };
}

function resolveConflict(input: {
  readonly conflict: AnalyzedDatapackConflict;
  readonly datapacksById: ReadonlyMap<string, AnalyzedDatapack>;
  readonly resourcesById: ReadonlyMap<string, AnalyzedDatapackResource>;
  readonly observationByRootPath: ReadonlyMap<string, { readonly index: number; readonly sha256: string }>;
}): ObservedDatapackConflictResolution {
  const participants: { readonly datapack: AnalyzedDatapack; readonly index: number }[] = [];
  for (const datapackId of input.conflict.datapackIds) {
    const datapack = input.datapacksById.get(datapackId);
    if (datapack === undefined) return unresolved(input.conflict, 'analysis-participant-missing');
    const observed = input.observationByRootPath.get(datapack.rootPath);
    if (observed === undefined) return unresolved(input.conflict, 'participant-not-observed');
    if (observed.sha256 !== datapack.sha256) {
      return unresolved(input.conflict, 'participant-hash-mismatch');
    }
    participants.push({ datapack, index: observed.index });
  }

  participants.sort((left, right) => left.index - right.index ||
    left.datapack.datapackId.localeCompare(right.datapack.datapackId, 'en-US'));
  const winner = participants.at(-1)?.datapack;
  if (winner === undefined) return unresolved(input.conflict, 'analysis-participant-missing');
  const winningResources = input.conflict.resourceIds
    .map((resourceId) => input.resourcesById.get(resourceId))
    .filter((resource): resource is AnalyzedDatapackResource =>
      resource !== undefined && resource.datapackId === winner.datapackId);
  if (winningResources.length !== 1) {
    return unresolved(input.conflict, 'participant-resource-ambiguous');
  }

  return {
    conflictId: input.conflict.conflictId,
    status: 'resolved',
    reason: 'observed-winner',
    participantDatapackIdsByPriority: Object.freeze(
      participants.map((participant) => participant.datapack.datapackId),
    ),
    winningDatapackId: winner.datapackId,
    winningResourceId: winningResources[0]?.resourceId ?? null,
  };
}

/**
 * Projects an observed order over an immutable analysis. This does not mutate
 * or replace the persisted conflict resolution and cannot authorize editing.
 */
export function projectObservedDatapackLoadOrder(input: {
  readonly analysis: EcosystemAnalysis;
  readonly observation: DatapackLoadOrderObservation;
}): DatapackLoadOrderProjection {
  const inventoryMatches = input.analysis.inventorySha256 === input.observation.inventorySha256;
  const datapacksById = new Map(input.analysis.datapacks.map((datapack) => [datapack.datapackId, datapack]));
  const resourcesById = new Map(
    input.analysis.datapackResources.map((resource) => [resource.resourceId, resource]),
  );
  const observationByRootPath = new Map(
    input.observation.datapacks.map((datapack, index) => [datapack.rootPath, { index, sha256: datapack.sha256 }]),
  );
  const resolutions = [...input.analysis.datapackConflicts]
    .sort((left, right) => left.conflictId.localeCompare(right.conflictId, 'en-US'))
    .map((conflict) => inventoryMatches
      ? resolveConflict({ conflict, datapacksById, resourcesById, observationByRootPath })
      : unresolved(conflict, 'inventory-mismatch'));

  return freezeDeep({
    schemaVersion: DATAPACK_LOAD_ORDER_PROJECTION_SCHEMA_VERSION,
    analysisId: input.analysis.analysisId,
    inventorySha256: input.analysis.inventorySha256,
    observationId: input.observation.observationId,
    observationSource: input.observation.source,
    observedAt: input.observation.observedAt,
    evidenceSha256: input.observation.evidenceSha256,
    authorizesSemanticEditing: false,
    resolutions,
  });
}
