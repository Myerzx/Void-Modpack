import {
  parseDatapackLoadOrderObservation,
  projectObservedDatapackLoadOrder,
  type DatapackLoadOrderObservation,
  type DatapackLoadOrderProjection,
} from './datapack-load-order.js';
import type { EcosystemAnalysis } from './types.js';

export const WORLD_METADATA_DATAPACK_LOAD_ORDER_EVIDENCE_SCHEMA_VERSION = 1 as const;

export interface DatapackLoadOrderConsistencyLease {
  readonly method: 'offline-exclusive-v1';
  readonly acquiredAt: string;
}

export interface OfflineExclusiveDatapackLoadOrderGuard {
  runWithExclusiveOfflineAccess<T>(
    operation: (lease: DatapackLoadOrderConsistencyLease) => Promise<T>,
  ): Promise<T>;
}

/**
 * Trusted construction port. Its implementation owns native world parsing;
 * callers cannot provide a path, source name, timestamp or arbitrary bytes.
 */
export interface TrustedWorldMetadataDatapackLoadOrderReader {
  readNormalizedEvidence(): Promise<unknown>;
}

export interface CapturedDatapackLoadOrder {
  readonly observation: DatapackLoadOrderObservation;
  readonly projection: DatapackLoadOrderProjection;
}

export type DatapackLoadOrderCaptureErrorCode =
  | 'invalid-world-metadata-evidence'
  | 'clock-before-exclusive-lease';

export class DatapackLoadOrderCaptureError extends Error {
  public readonly code: DatapackLoadOrderCaptureErrorCode;

  public constructor(code: DatapackLoadOrderCaptureErrorCode) {
    super(`ecosystem-analysis:${code}`);
    this.name = 'DatapackLoadOrderCaptureError';
    this.code = code;
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

/**
 * Captures one normalized observation while the durable offline window is
 * held, then derives a non-editing projection from the exact analysis.
 */
export class GuardedDatapackLoadOrderObserver {
  readonly #guard: OfflineExclusiveDatapackLoadOrderGuard;
  readonly #reader: TrustedWorldMetadataDatapackLoadOrderReader;
  readonly #clock: () => Date;

  public constructor(options: {
    readonly guard: OfflineExclusiveDatapackLoadOrderGuard;
    readonly reader: TrustedWorldMetadataDatapackLoadOrderReader;
    readonly clock?: () => Date;
  }) {
    this.#guard = options.guard;
    this.#reader = options.reader;
    this.#clock = options.clock ?? ((): Date => new Date());
  }

  public capture(analysis: EcosystemAnalysis): Promise<CapturedDatapackLoadOrder> {
    return this.#guard.runWithExclusiveOfflineAccess(async (lease) => {
      const evidence = await this.#reader.readNormalizedEvidence();
      if (
        !isRecord(evidence) ||
        !hasExactKeys(evidence, ['schemaVersion', 'evidenceSha256', 'order', 'datapacks']) ||
        evidence.schemaVersion !== WORLD_METADATA_DATAPACK_LOAD_ORDER_EVIDENCE_SCHEMA_VERSION
      ) {
        throw new DatapackLoadOrderCaptureError('invalid-world-metadata-evidence');
      }
      const observedAt = this.#clock();
      if (
        Number.isNaN(observedAt.valueOf()) ||
        observedAt.getTime() < Date.parse(lease.acquiredAt)
      ) {
        throw new DatapackLoadOrderCaptureError('clock-before-exclusive-lease');
      }
      let observation: DatapackLoadOrderObservation;
      try {
        observation = parseDatapackLoadOrderObservation({
          schemaVersion: 1,
          source: 'minecraft-world-metadata-v1',
          inventorySha256: analysis.inventorySha256,
          observedAt: observedAt.toISOString(),
          evidenceSha256: evidence.evidenceSha256,
          order: evidence.order,
          datapacks: evidence.datapacks,
        });
      } catch {
        throw new DatapackLoadOrderCaptureError('invalid-world-metadata-evidence');
      }
      return Object.freeze({
        observation,
        projection: projectObservedDatapackLoadOrder({ analysis, observation }),
      });
    });
  }
}
