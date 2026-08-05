import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import {
  BackupOperationError,
  VOIDFALL_BACKUP_FORMAT,
  VOIDFALL_BACKUP_SCHEMA_VERSION,
  type BackupConsistencyMethod,
  type BackupScope,
  type BackupTotals,
} from './types.js';
import {
  parseCanonicalTimestamp,
  validateBackupId,
  validateIdentifier,
  validateLogicalName,
  validateServerRelease,
} from './validation.js';

export interface BackupManifestDirectoryEntry {
  readonly path: string;
  readonly type: 'directory';
}

export interface BackupManifestFileEntry {
  readonly path: string;
  readonly type: 'file';
  readonly sizeBytes: number;
  readonly sha256: string;
}

export type BackupManifestEntry =
  | BackupManifestDirectoryEntry
  | BackupManifestFileEntry;

export interface BackupManifest {
  readonly format: typeof VOIDFALL_BACKUP_FORMAT;
  readonly schemaVersion: typeof VOIDFALL_BACKUP_SCHEMA_VERSION;
  readonly backupId: string;
  readonly serverInstanceId: string;
  readonly serverRelease: string;
  readonly retentionPolicyId: string;
  readonly scope: BackupScope;
  readonly createdAt: string;
  readonly consistency: {
    readonly method: BackupConsistencyMethod;
    readonly acquiredAt: string;
  };
  readonly sources: readonly {
    readonly logicalName: string;
  }[];
  readonly entries: readonly BackupManifestEntry[];
  readonly totals: BackupTotals;
  /**
   * How the payload is stored. `null` means as-is.
   *
   * The entries always describe the **plaintext**: its digest and its size.
   * Verification therefore proves the backup still restores to the same bytes,
   * not merely that the ciphertext is intact — a much weaker claim, and the one
   * an encrypted-but-unverifiable backup would leave you with.
   */
  readonly encryption: {
    readonly algorithm: 'aes-256-gcm';
    readonly keyId: string;
  } | null;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SCOPES = new Set<BackupScope>(['world', 'configurations', 'complete']);

function invalidManifest(): never {
  throw new BackupOperationError('integrity-mismatch', 'verify');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalidManifest();
  }
}

function safeNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalidManifest();
  }
  return value;
}

export function compareManifestPaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function validateManifestPath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1_024 ||
    value.includes('\\') ||
    value.includes('\u0000') ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value
  ) {
    invalidManifest();
  }
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length < 1 ||
        segment.length > 255 ||
        segment === '.' ||
        segment === '..' ||
        segment.endsWith(' ') ||
        segment.endsWith('.'),
    )
  ) {
    invalidManifest();
  }
}

function validateManifestValue(value: unknown): BackupManifest {
  if (!isRecord(value)) invalidManifest();
  exactKeys(value, [
    'format',
    'schemaVersion',
    'backupId',
    'serverInstanceId',
    'serverRelease',
    'retentionPolicyId',
    'scope',
    'createdAt',
    'consistency',
    'sources',
    'entries',
    'totals',
    'encryption',
  ]);
  if (
    value['format'] !== VOIDFALL_BACKUP_FORMAT ||
    value['schemaVersion'] !== VOIDFALL_BACKUP_SCHEMA_VERSION
  ) {
    invalidManifest();
  }

  try {
    validateBackupId(value['backupId']);
    validateIdentifier(value['serverInstanceId']);
    validateServerRelease(value['serverRelease']);
    validateIdentifier(value['retentionPolicyId']);
    parseCanonicalTimestamp(value['createdAt']);
  } catch {
    invalidManifest();
  }
  if (typeof value['scope'] !== 'string' || !SCOPES.has(value['scope'] as BackupScope)) {
    invalidManifest();
  }

  const createdAtValue = value['createdAt'];
  if (typeof createdAtValue !== 'string') invalidManifest();
  const consistency = value['consistency'];
  if (!isRecord(consistency)) invalidManifest();
  exactKeys(consistency, ['method', 'acquiredAt']);
  if (consistency['method'] !== 'offline-exclusive-v1') invalidManifest();
  const acquiredAtValue = consistency['acquiredAt'];
  if (typeof acquiredAtValue !== 'string') invalidManifest();
  let acquiredAt: Date;
  let createdAt: Date;
  try {
    acquiredAt = parseCanonicalTimestamp(acquiredAtValue);
    createdAt = parseCanonicalTimestamp(createdAtValue);
  } catch {
    invalidManifest();
  }
  if (acquiredAt.getTime() > createdAt.getTime()) invalidManifest();

  if (!Array.isArray(value['sources']) || value['sources'].length < 1) invalidManifest();
  const sourceNames = new Set<string>();
  const sources = value['sources'].map((source) => {
    if (!isRecord(source)) invalidManifest();
    exactKeys(source, ['logicalName']);
    try {
      validateLogicalName(source['logicalName']);
    } catch {
      invalidManifest();
    }
    const logicalName = source['logicalName'];
    if (sourceNames.has(logicalName)) invalidManifest();
    sourceNames.add(logicalName);
    return Object.freeze({ logicalName });
  });
  if (
    sources.some(
      (source, index) =>
        index > 0 &&
        compareManifestPaths(sources[index - 1]?.logicalName ?? '', source.logicalName) >= 0,
    )
  ) {
    invalidManifest();
  }

  if (!Array.isArray(value['entries']) || value['entries'].length < sources.length) {
    invalidManifest();
  }
  const pathKeys = new Set<string>();
  const entries = value['entries'].map((entry): BackupManifestEntry => {
    if (!isRecord(entry) || (entry['type'] !== 'directory' && entry['type'] !== 'file')) {
      invalidManifest();
    }
    validateManifestPath(entry['path']);
    const path = entry['path'];
    const pathKey = path.toLocaleLowerCase('en-US');
    if (pathKeys.has(pathKey)) invalidManifest();
    pathKeys.add(pathKey);
    if (!sourceNames.has(path.split('/')[0] ?? '')) invalidManifest();

    if (entry['type'] === 'directory') {
      exactKeys(entry, ['path', 'type']);
      return Object.freeze({ path, type: 'directory' });
    }
    exactKeys(entry, ['path', 'type', 'sizeBytes', 'sha256']);
    const sizeBytes = safeNonNegativeInteger(entry['sizeBytes']);
    if (typeof entry['sha256'] !== 'string' || !SHA256_PATTERN.test(entry['sha256'])) {
      invalidManifest();
    }
    return Object.freeze({ path, type: 'file', sizeBytes, sha256: entry['sha256'] });
  });

  if (
    entries.some(
      (entry, index) =>
        index > 0 && compareManifestPaths(entries[index - 1]?.path ?? '', entry.path) >= 0,
    )
  ) {
    invalidManifest();
  }
  for (const source of sources) {
    if (!entries.some((entry) => entry.type === 'directory' && entry.path === source.logicalName)) {
      invalidManifest();
    }
  }

  const totalsValue = value['totals'];
  if (!isRecord(totalsValue)) invalidManifest();
  exactKeys(totalsValue, ['files', 'directories', 'bytes']);
  const totals = Object.freeze({
    files: safeNonNegativeInteger(totalsValue['files']),
    directories: safeNonNegativeInteger(totalsValue['directories']),
    bytes: safeNonNegativeInteger(totalsValue['bytes']),
  });
  const calculatedTotals = entries.reduce(
    (current, entry) => ({
      files: current.files + (entry.type === 'file' ? 1 : 0),
      directories: current.directories + (entry.type === 'directory' ? 1 : 0),
      bytes: current.bytes + (entry.type === 'file' ? entry.sizeBytes : 0),
    }),
    { files: 0, directories: 0, bytes: 0 },
  );
  if (
    totals.files !== calculatedTotals.files ||
    totals.directories !== calculatedTotals.directories ||
    totals.bytes !== calculatedTotals.bytes
  ) {
    invalidManifest();
  }

  // Present and explicitly `null` when the payload is stored as-is. Omitting
  // the key for unencrypted backups would make "not encrypted" and "written by
  // an older writer that did not know about encryption" the same manifest.
  const encryptionValue = value['encryption'];
  let encryption: BackupManifest['encryption'] = null;
  if (encryptionValue !== null) {
    if (!isRecord(encryptionValue)) invalidManifest();
    exactKeys(encryptionValue, ['algorithm', 'keyId']);
    if (
      encryptionValue['algorithm'] !== 'aes-256-gcm' ||
      typeof encryptionValue['keyId'] !== 'string' ||
      !/^[a-z][a-z0-9._-]{0,63}$/u.test(encryptionValue['keyId'])
    ) {
      invalidManifest();
    }
    encryption = Object.freeze({ algorithm: 'aes-256-gcm' as const, keyId: encryptionValue['keyId'] });
  }

  return Object.freeze({
    format: VOIDFALL_BACKUP_FORMAT,
    schemaVersion: VOIDFALL_BACKUP_SCHEMA_VERSION,
    backupId: value['backupId'],
    serverInstanceId: value['serverInstanceId'],
    serverRelease: value['serverRelease'],
    retentionPolicyId: value['retentionPolicyId'],
    scope: value['scope'] as BackupScope,
    createdAt: createdAtValue,
    consistency: Object.freeze({
      method: consistency['method'],
      acquiredAt: acquiredAtValue,
    }),
    sources: Object.freeze(sources),
    entries: Object.freeze(entries),
    totals,
    encryption,
  });
}

export function parseBackupManifest(serialized: string): BackupManifest {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > 8 * 1_024 ** 2) {
    invalidManifest();
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    invalidManifest();
  }
  return validateManifestValue(value);
}

export function serializeBackupManifest(manifest: BackupManifest): string {
  return JSON.stringify(validateManifestValue(manifest));
}

export function backupManifestSha256(manifest: BackupManifest): string {
  return createHash('sha256').update(serializeBackupManifest(manifest), 'utf8').digest('hex');
}
