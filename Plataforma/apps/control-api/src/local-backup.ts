import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { ServerInstance } from '@voidfall/database';
import type { BackupConfiguration } from '@voidfall/server-agent';

const KEY_BYTES = 32;
const MAXIMUM_PROPERTIES_BYTES = 1_048_576;
const LOCAL_BACKUP_MAXIMUM_BYTES = 64 * 1_024 ** 3;
const LOCAL_BACKUP_MINIMUM_FREE_BYTES = 8 * 1_024 ** 3;

interface StoredBackupKeys {
  readonly schemaVersion: 1;
  readonly seal: { readonly keyId: 'local-seal-v1'; readonly secretBase64: string };
  readonly encryption: {
    readonly keyId: 'local-encryption-v1';
    readonly secretBase64: string;
  };
}

function decodeStoredSecret(value: unknown): Uint8Array {
  if (typeof value !== 'string') throw new Error('local-backup-key-invalid');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== KEY_BYTES || decoded.toString('base64') !== value) {
    throw new Error('local-backup-key-invalid');
  }
  return decoded;
}

function parseStoredKeys(value: unknown): {
  readonly sealKey: { readonly keyId: string; readonly secret: Uint8Array };
  readonly encryptionKey: { readonly keyId: string; readonly secret: Uint8Array };
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('local-backup-key-invalid');
  }
  const document = value as Record<string, unknown>;
  const seal = document['seal'];
  const encryption = document['encryption'];
  if (
    document['schemaVersion'] !== 1 ||
    Object.keys(document).sort().join(',') !== 'encryption,schemaVersion,seal' ||
    seal === null ||
    typeof seal !== 'object' ||
    Array.isArray(seal) ||
    encryption === null ||
    typeof encryption !== 'object' ||
    Array.isArray(encryption)
  ) {
    throw new Error('local-backup-key-invalid');
  }
  const sealDocument = seal as Record<string, unknown>;
  const encryptionDocument = encryption as Record<string, unknown>;
  if (
    Object.keys(sealDocument).sort().join(',') !== 'keyId,secretBase64' ||
    Object.keys(encryptionDocument).sort().join(',') !== 'keyId,secretBase64' ||
    sealDocument['keyId'] !== 'local-seal-v1' ||
    encryptionDocument['keyId'] !== 'local-encryption-v1'
  ) {
    throw new Error('local-backup-key-invalid');
  }
  return {
    sealKey: {
      keyId: 'local-seal-v1',
      secret: decodeStoredSecret(sealDocument['secretBase64']),
    },
    encryptionKey: {
      keyId: 'local-encryption-v1',
      secret: decodeStoredSecret(encryptionDocument['secretBase64']),
    },
  };
}

async function provisionKeys(keyPath: string) {
  const existing = await readFile(keyPath, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing !== undefined) {
    try {
      return parseStoredKeys(JSON.parse(existing) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('local-backup-key-invalid');
      throw error;
    }
  }

  const stored: StoredBackupKeys = {
    schemaVersion: 1,
    seal: { keyId: 'local-seal-v1', secretBase64: randomBytes(KEY_BYTES).toString('base64') },
    encryption: {
      keyId: 'local-encryption-v1',
      secretBase64: randomBytes(KEY_BYTES).toString('base64'),
    },
  };
  await writeFile(keyPath, `${JSON.stringify(stored, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return parseStoredKeys(stored);
}

function isContained(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent.length > 0 &&
    !isAbsolute(pathFromParent) &&
    pathFromParent !== '..' &&
    !pathFromParent.startsWith(`..${sep}`)
  );
}

/** Resolve Minecraft's active world without allowing `level-name` to escape the server root. */
export async function resolveLocalWorldDirectory(serverRoot: string): Promise<string | null> {
  const propertiesPath = join(serverRoot, 'server.properties');
  const propertiesStat = await lstat(propertiesPath).catch(() => null);
  if (propertiesStat === null || !propertiesStat.isFile() || propertiesStat.isSymbolicLink()) {
    return null;
  }
  if (propertiesStat.size > MAXIMUM_PROPERTIES_BYTES) {
    throw new Error('local-backup-properties-too-large');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(propertiesPath));
  const matches = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('level-name='))
    .map((line) => line.slice('level-name='.length));
  if (matches.length > 1) throw new Error('local-backup-world-ambiguous');
  const levelName = matches[0] ?? 'world';
  if (
    levelName.length === 0 ||
    levelName.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(levelName) ||
    isAbsolute(levelName)
  ) {
    throw new Error('local-backup-world-unsafe');
  }
  const normalizedRoot = resolve(serverRoot);
  const worldPath = resolve(normalizedRoot, levelName);
  if (!isContained(normalizedRoot, worldPath)) throw new Error('local-backup-world-unsafe');
  const worldStat = await lstat(worldPath).catch(() => null);
  if (worldStat === null) return null;
  if (!worldStat.isDirectory() || worldStat.isSymbolicLink()) {
    throw new Error('local-backup-world-unsafe');
  }
  return worldPath;
}

/**
 * Creates the private, per-instance backup configuration used by the desktop.
 *
 * The repository and both keys stay under the application's state directory;
 * only the world is read from the linked runtime. Restore remains disabled
 * until its verification can boot the isolated copy itself.
 */
export async function provisionLocalBackup(input: {
  readonly instance: ServerInstance;
  readonly stateDirectory: string;
}): Promise<BackupConfiguration | null> {
  if (input.instance.runDirectory === null) return null;
  const worldSourcePath = await resolveLocalWorldDirectory(input.instance.runDirectory);
  if (worldSourcePath === null) return null;

  const instanceRoot = join(input.stateDirectory, 'backups', input.instance.id);
  const repositoryRoot = join(instanceRoot, 'repository');
  const isolatedRestoreRoot = join(instanceRoot, 'isolated-restores');
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(isolatedRestoreRoot, { recursive: true });
  const keys = await provisionKeys(join(instanceRoot, 'keys.json'));

  return {
    repositoryRoot,
    isolatedRestoreRoot,
    worldSourcePath,
    sealKey: keys.sealKey,
    encryptionKey: keys.encryptionKey,
    restoreEnabled: false,
    limits: { minimumFreeBytesAfterCopy: LOCAL_BACKUP_MINIMUM_FREE_BYTES },
    quota: { maximumBackups: 7, maximumTotalBytes: LOCAL_BACKUP_MAXIMUM_BYTES },
    retentionPolicy: { policyId: 'local-default', keepLatest: 2, maximumAgeDays: 30 },
  };
}
