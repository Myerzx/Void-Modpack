export type ArtifactCompatibilityErrorCode = 'invalid-plan' | 'invalid-report';

export type ArtifactCompatibilityStage = 'plan' | 'report';

/**
 * Public errors carry a stable code, the stage that refused, and the contract
 * issues that caused it. They never carry a path or a host detail.
 */
export class ArtifactCompatibilityError extends Error {
  public readonly code: ArtifactCompatibilityErrorCode;
  public readonly stage: ArtifactCompatibilityStage;
  public readonly issues: readonly string[];

  public constructor(
    code: ArtifactCompatibilityErrorCode,
    stage: ArtifactCompatibilityStage,
    issues: readonly string[] = [],
  ) {
    super(`${code}:${stage}`);
    this.name = 'ArtifactCompatibilityError';
    this.code = code;
    this.stage = stage;
    this.issues = Object.freeze([...issues]);
  }
}

/**
 * Dependency targets a loader provides itself. They are resolved from the
 * context, never from another artifact, so a runtime component is never
 * reported as a missing mod.
 */
export const BUILTIN_DEPENDENCY_TARGETS: ReadonlySet<string> = Object.freeze(
  new Set(['fabricloader', 'fml', 'forge', 'java', 'minecraft', 'neoforge', 'quilt_loader']),
);

/** Loader-provided targets whose version is the loader version of the context. */
export const LOADER_DEPENDENCY_TARGETS: ReadonlySet<string> = Object.freeze(
  new Set(['fabricloader', 'fml', 'forge', 'neoforge', 'quilt_loader']),
);
