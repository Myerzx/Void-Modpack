import {
  validateLauncherChannel,
  validateLauncherManagedState,
  validateReleaseManifest,
  type LauncherManagedState,
} from '@voidfall/contracts';
import {
  canonicalJsonBytes,
  sha256Bytes,
  type CanonicalJsonValue,
} from '@voidfall/modpack-release';
import {
  LauncherProtocolError,
  type PortableUpdateOperation,
  type PortableUpdatePlan,
  type PortableUpdatePlanInput,
} from './types.js';

function normalizedPath(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function compareOperation(left: PortableUpdateOperation, right: PortableUpdateOperation): number {
  return normalizedPath(left.path).localeCompare(normalizedPath(right.path), 'en-US');
}

function validatePlannedAt(value: string): void {
  if (
    Number.isNaN(Date.parse(value)) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    throw new LauncherProtocolError('invalid-state');
  }
}

export function createPortableUpdatePlan(input: PortableUpdatePlanInput): PortableUpdatePlan {
  const channel = validateLauncherChannel(input.channel);
  if (!channel.success) throw new LauncherProtocolError('invalid-channel');
  const manifest = validateReleaseManifest(input.manifest);
  if (!manifest.success) throw new LauncherProtocolError('invalid-manifest');
  if (!input.verifier.verifyChannel(channel.value) || !input.verifier.verifyManifest(manifest.value)) {
    throw new LauncherProtocolError('untrusted-signature');
  }
  const manifestSha256 = sha256Bytes(canonicalJsonBytes(manifest.value as CanonicalJsonValue));
  if (
    channel.value.releaseVersion !== manifest.value.release.version ||
    channel.value.buildId !== manifest.value.release.buildId ||
    channel.value.manifestSha256 !== manifestSha256
  ) {
    throw new LauncherProtocolError('document-mismatch');
  }
  validatePlannedAt(input.plannedAt);

  let currentState: LauncherManagedState | undefined;
  if (input.currentState !== undefined) {
    const state = validateLauncherManagedState(input.currentState);
    if (!state.success) throw new LauncherProtocolError('invalid-state');
    currentState = state.value;
    if (state.value.channel !== channel.value.channel) {
      throw new LauncherProtocolError('document-mismatch');
    }
    if (
      channel.value.revision < state.value.channelRevision ||
      (channel.value.revision === state.value.channelRevision &&
        (channel.value.releaseVersion !== state.value.releaseVersion ||
          channel.value.buildId !== state.value.buildId))
    ) {
      throw new LauncherProtocolError('channel-regression');
    }
  }

  const currentFiles = new Map(
    (currentState?.files ?? []).map((file) => [normalizedPath(file.path), file]),
  );
  const nextFiles = new Map(
    manifest.value.files.map((file) => [normalizedPath(file.path), file]),
  );
  const removedPaths = new Set(manifest.value.removedPaths.map(normalizedPath));
  const operations: PortableUpdateOperation[] = [];

  for (const file of manifest.value.files) {
    const current = currentFiles.get(normalizedPath(file.path));
    if (current === undefined) {
      operations.push({
        operation: 'download',
        path: file.path,
        artifactId: file.artifactId,
        size: file.size,
        sha256: file.sha256,
      });
    } else if (current.sha256 === file.sha256) {
      operations.push({ operation: 'keep', path: file.path, sha256: file.sha256 });
    } else {
      operations.push({
        operation: 'replace',
        path: file.path,
        previousSha256: current.sha256,
        artifactId: file.artifactId,
        size: file.size,
        sha256: file.sha256,
      });
    }
  }

  for (const current of currentFiles.values()) {
    const key = normalizedPath(current.path);
    if (nextFiles.has(key)) continue;
    if (!removedPaths.has(key)) throw new LauncherProtocolError('incomplete-removal-set');
    operations.push({
      operation: 'remove',
      path: current.path,
      previousSha256: current.sha256,
    });
  }
  operations.sort(compareOperation);

  const summary = { keep: 0, download: 0, replace: 0, remove: 0, downloadBytes: 0 };
  for (const operation of operations) {
    summary[operation.operation] += 1;
    if (operation.operation === 'download' || operation.operation === 'replace') {
      summary.downloadBytes += operation.size;
    }
  }
  const nextState: LauncherManagedState = {
    schemaVersion: 1,
    product: { id: 'voidfall', displayName: 'VoidFall' },
    channel: channel.value.channel,
    channelRevision: channel.value.revision,
    releaseVersion: manifest.value.release.version,
    buildId: manifest.value.release.buildId,
    installedAt: input.plannedAt,
    files: manifest.value.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
  };
  const stateValidation = validateLauncherManagedState(nextState);
  if (!stateValidation.success) throw new LauncherProtocolError('invalid-state');

  return Object.freeze({
    schemaVersion: 1,
    channel: channel.value.channel,
    channelRevision: channel.value.revision,
    ...(currentState === undefined
      ? {}
      : {
          from: {
            releaseVersion: currentState.releaseVersion,
            buildId: currentState.buildId,
          },
        }),
    to: Object.freeze({
      releaseVersion: manifest.value.release.version,
      buildId: manifest.value.release.buildId,
      manifestSha256,
    }),
    operations: Object.freeze(operations.map((operation) => Object.freeze(operation))),
    summary: Object.freeze(summary),
    nextState: stateValidation.value,
  });
}
