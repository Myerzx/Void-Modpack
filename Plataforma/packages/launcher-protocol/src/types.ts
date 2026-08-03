import type {
  LauncherChannel,
  LauncherManagedState,
  ReleaseManifest,
} from '@voidfall/contracts';

export type PortableUpdateOperation =
  | {
      readonly operation: 'keep';
      readonly path: string;
      readonly sha256: string;
    }
  | {
      readonly operation: 'download';
      readonly path: string;
      readonly artifactId: string;
      readonly size: number;
      readonly sha256: string;
    }
  | {
      readonly operation: 'replace';
      readonly path: string;
      readonly previousSha256: string;
      readonly artifactId: string;
      readonly size: number;
      readonly sha256: string;
    }
  | {
      readonly operation: 'remove';
      readonly path: string;
      readonly previousSha256: string;
    };

export interface PortableUpdatePlan {
  readonly schemaVersion: 1;
  readonly channel: string;
  readonly channelRevision: number;
  readonly from?: {
    readonly releaseVersion: string;
    readonly buildId: string;
  };
  readonly to: {
    readonly releaseVersion: string;
    readonly buildId: string;
    readonly manifestSha256: string;
  };
  readonly operations: readonly PortableUpdateOperation[];
  readonly summary: {
    readonly keep: number;
    readonly download: number;
    readonly replace: number;
    readonly remove: number;
    readonly downloadBytes: number;
  };
  readonly nextState: LauncherManagedState;
}

export interface PortableUpdatePlanInput {
  readonly channel: LauncherChannel;
  readonly manifest: ReleaseManifest;
  readonly currentState?: LauncherManagedState;
  readonly plannedAt: string;
  readonly verifier: PortableReleaseVerifier;
}

export interface PortableReleaseVerifier {
  verifyChannel(channel: LauncherChannel): boolean;
  verifyManifest(manifest: ReleaseManifest): boolean;
}

export type LauncherProtocolErrorCode =
  | 'invalid-channel'
  | 'invalid-manifest'
  | 'invalid-state'
  | 'untrusted-signature'
  | 'document-mismatch'
  | 'channel-regression'
  | 'incomplete-removal-set';

export class LauncherProtocolError extends Error {
  public readonly code: LauncherProtocolErrorCode;

  public constructor(code: LauncherProtocolErrorCode) {
    super(`launcher-protocol:${code}`);
    this.name = 'LauncherProtocolError';
    this.code = code;
  }
}
