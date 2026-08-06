import { createPrivateKey } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

/**
 * The agent's startup configuration.
 *
 * Everything here comes from the environment, never from the control plane. An
 * agent that took its repository root, its keys or its source directories over
 * the wire would be a remote-controlled file mover, which is the shape this
 * whole protocol exists to avoid.
 *
 * Configuration is validated **once, at startup, before anything is served**.
 * A capability whose configuration is wrong must not come up degraded and fail
 * on the day it is used; it must refuse to be announced at all, with a reason
 * an operator can read.
 *
 * Absence is not an error. A deployment that has not configured backups is a
 * deployment without the backup capability, not a broken one — so a missing
 * variable disables a capability and a *malformed* one refuses startup. The
 * difference matters: the first is a choice, the second is a mistake, and
 * treating a typo as a choice is how a capability silently disappears.
 */

export const AGENT_ENVIRONMENT_KEYS = Object.freeze([
  'VOIDFALL_AGENT_ID',
  'VOIDFALL_SERVER_INSTANCE_ID',
  'VOIDFALL_CONTROL_API_URL',
  'VOIDFALL_AGENT_PRIVATE_KEY_PEM',
  'VOIDFALL_DATABASE_URL',
  'VOIDFALL_SERVER_RELEASE',
  'VOIDFALL_AUTHORIZED_ROOT_CONFIG',
  'VOIDFALL_AUTHORIZED_REVISION_ROOT',
  'VOIDFALL_BACKUP_REPOSITORY_ROOT',
  'VOIDFALL_BACKUP_RESTORE_ROOT',
  'VOIDFALL_BACKUP_WORLD_SOURCE',
  'VOIDFALL_BACKUP_SEAL_KEY',
  'VOIDFALL_BACKUP_SEAL_KEY_ID',
  'VOIDFALL_BACKUP_ENCRYPTION_KEY',
  'VOIDFALL_BACKUP_ENCRYPTION_KEY_ID',
  'VOIDFALL_METRICS_DISK_PATH',
  'VOIDFALL_SCHEDULER_ENABLED',
] as const);

export type AgentEnvironmentKey = (typeof AGENT_ENVIRONMENT_KEYS)[number];

export type AgentConfigurationIssueCode =
  | 'missing'
  | 'not-a-uuid'
  | 'not-an-absolute-path'
  | 'not-an-https-url'
  | 'not-a-base64-key'
  | 'key-too-short'
  | 'not-an-ed25519-private-key'
  | 'not-an-identifier'
  | 'incomplete-group';

export interface AgentConfigurationIssue {
  readonly key: AgentEnvironmentKey;
  readonly code: AgentConfigurationIssueCode;
}

export class AgentConfigurationError extends Error {
  public readonly issues: readonly AgentConfigurationIssue[];

  public constructor(issues: readonly AgentConfigurationIssue[]) {
    // The message names the keys and their fault codes, never their values: a
    // startup log is a place a private key must not appear.
    super(
      `agent-configuration:${issues.map((issue) => `${issue.key}=${issue.code}`).join(',')}`,
    );
    this.name = 'AgentConfigurationError';
    this.issues = Object.freeze([...issues]);
  }
}

export interface AuthorizedFilesConfiguration {
  readonly rootId: 'server-config';
  readonly rootPath: string;
  readonly revisionRoot: string;
}

export interface BackupConfiguration {
  readonly repositoryRoot: string;
  readonly isolatedRestoreRoot: string;
  readonly worldSourcePath: string;
  readonly sealKey: { readonly keyId: string; readonly secret: Uint8Array };
  readonly encryptionKey: { readonly keyId: string; readonly secret: Uint8Array } | null;
}

export interface AgentRuntimeConfiguration {
  readonly agentId: string;
  readonly serverInstanceId: string;
  readonly controlApiUrl: string;
  readonly privateKeyPem: string;
  readonly databaseUrl: string;
  readonly serverRelease: string;
  /** Absent means the deployment did not authorize any file root. */
  readonly authorizedFiles: AuthorizedFilesConfiguration | null;
  /** Absent means the deployment did not configure backups. */
  readonly backups: BackupConfiguration | null;
  /** Which filesystem the disk metric reports on. Absent disables that reading. */
  readonly metricsDiskPath: string | null;
  readonly schedulerEnabled: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/u;
const MINIMUM_KEY_BYTES = 32;

export type Environment = Readonly<Record<string, string | undefined>>;

function read(environment: Environment, key: AgentEnvironmentKey): string | undefined {
  const value = environment[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Decodes a key from base64.
 *
 * Keys arrive as base64 in the environment and never as a path into the
 * repository, so there is no file a careless commit could add.
 */
function decodeKey(
  value: string,
  key: AgentEnvironmentKey,
  issues: AgentConfigurationIssue[],
): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    issues.push({ key, code: 'not-a-base64-key' });
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64');
  // Round-tripped: base64 silently accepts input it cannot represent, and a
  // key that decodes to something other than what was written is not the key
  // the operator thinks they configured.
  if (decoded.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) {
    issues.push({ key, code: 'not-a-base64-key' });
    return undefined;
  }
  if (decoded.byteLength < MINIMUM_KEY_BYTES) {
    issues.push({ key, code: 'key-too-short' });
    return undefined;
  }
  return new Uint8Array(decoded);
}

/**
 * Requires an absolute path, and refuses an embedded NUL.
 *
 * Only those two. A space is not a fault - a Windows program-files path is
 * ordinary - and nothing here is interpolated into a shell, so narrowing what
 * a path may contain would refuse valid deployments for no benefit. A NUL is
 * different: it truncates the path at the syscall boundary, so the file opened
 * would not be the file configured.
 */
function requireAbsolute(
  value: string,
  key: AgentEnvironmentKey,
  issues: AgentConfigurationIssue[],
): string | undefined {
  if (!isAbsolute(value) || value.includes('\u0000')) {
    issues.push({ key, code: 'not-an-absolute-path' });
    return undefined;
  }
  return resolve(value);
}

/**
 * Whether the PEM is a key this agent can actually sign with.
 *
 * The algorithm is checked as well as the parse. Every envelope is Ed25519, so
 * an operator who pasted an RSA key has a key that loads and then signs nothing
 * — a fault worth naming at startup rather than discovering as a rejected
 * envelope with no explanation on this side of the wire.
 */
function isEd25519PrivateKeyPem(value: string): boolean {
  try {
    return createPrivateKey(value).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

/**
 * Reads and validates the whole configuration.
 *
 * Every issue is collected before throwing rather than failing on the first:
 * an operator fixing a deployment should see everything that is wrong in one
 * pass, not discover the next fault on the next restart.
 */
export function loadAgentConfiguration(environment: Environment): AgentRuntimeConfiguration {
  const issues: AgentConfigurationIssue[] = [];

  const requireValue = (key: AgentEnvironmentKey): string | undefined => {
    const value = read(environment, key);
    if (value === undefined) issues.push({ key, code: 'missing' });
    return value;
  };

  const agentId = requireValue('VOIDFALL_AGENT_ID');
  if (agentId !== undefined && !UUID.test(agentId)) {
    issues.push({ key: 'VOIDFALL_AGENT_ID', code: 'not-a-uuid' });
  }
  const serverInstanceId = requireValue('VOIDFALL_SERVER_INSTANCE_ID');
  if (serverInstanceId !== undefined && !UUID.test(serverInstanceId)) {
    issues.push({ key: 'VOIDFALL_SERVER_INSTANCE_ID', code: 'not-a-uuid' });
  }

  const controlApiUrl = requireValue('VOIDFALL_CONTROL_API_URL');
  if (controlApiUrl !== undefined) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(controlApiUrl);
    } catch {
      parsed = undefined;
    }
    // Plain HTTP is refused outright rather than warned about. The agent signs
    // envelopes, but the transport still carries them, and an operator who
    // typo'd the scheme should not get a working-looking agent.
    const loopback =
      parsed !== undefined && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
    if (parsed === undefined || (parsed.protocol !== 'https:' && !loopback)) {
      issues.push({ key: 'VOIDFALL_CONTROL_API_URL', code: 'not-an-https-url' });
    }
  }

  // Parsed here rather than at the first signature. An unusable key is a
  // malformed variable, and finding out at startup beats finding out when the
  // first claim is refused for a reason that names none of this.
  const privateKeyPem = requireValue('VOIDFALL_AGENT_PRIVATE_KEY_PEM');
  if (privateKeyPem !== undefined && !isEd25519PrivateKeyPem(privateKeyPem)) {
    issues.push({ key: 'VOIDFALL_AGENT_PRIVATE_KEY_PEM', code: 'not-an-ed25519-private-key' });
  }
  const databaseUrl = requireValue('VOIDFALL_DATABASE_URL');
  const serverRelease = requireValue('VOIDFALL_SERVER_RELEASE');

  // --- Authorized files: all or nothing. ------------------------------------
  const rootPathRaw = read(environment, 'VOIDFALL_AUTHORIZED_ROOT_CONFIG');
  const revisionRootRaw = read(environment, 'VOIDFALL_AUTHORIZED_REVISION_ROOT');
  let authorizedFiles: AuthorizedFilesConfiguration | null = null;
  if (rootPathRaw !== undefined || revisionRootRaw !== undefined) {
    // Half-configured is a mistake, not a choice. Coming up with file access
    // silently disabled because one variable was forgotten is worse than
    // refusing to start.
    if (rootPathRaw === undefined) {
      issues.push({ key: 'VOIDFALL_AUTHORIZED_ROOT_CONFIG', code: 'incomplete-group' });
    }
    if (revisionRootRaw === undefined) {
      issues.push({ key: 'VOIDFALL_AUTHORIZED_REVISION_ROOT', code: 'incomplete-group' });
    }
    const rootPath =
      rootPathRaw === undefined
        ? undefined
        : requireAbsolute(rootPathRaw, 'VOIDFALL_AUTHORIZED_ROOT_CONFIG', issues);
    const revisionRoot =
      revisionRootRaw === undefined
        ? undefined
        : requireAbsolute(revisionRootRaw, 'VOIDFALL_AUTHORIZED_REVISION_ROOT', issues);
    if (rootPath !== undefined && revisionRoot !== undefined) {
      authorizedFiles = { rootId: 'server-config', rootPath, revisionRoot };
    }
  }

  // --- Backups: all or nothing, except the cipher. ---------------------------
  const backupKeys = [
    'VOIDFALL_BACKUP_REPOSITORY_ROOT',
    'VOIDFALL_BACKUP_RESTORE_ROOT',
    'VOIDFALL_BACKUP_WORLD_SOURCE',
    'VOIDFALL_BACKUP_SEAL_KEY',
    'VOIDFALL_BACKUP_SEAL_KEY_ID',
  ] as const;
  const backupValues = backupKeys.map((key) => read(environment, key));
  let backups: BackupConfiguration | null = null;
  if (backupValues.some((value) => value !== undefined)) {
    for (const [index, key] of backupKeys.entries()) {
      if (backupValues[index] === undefined) issues.push({ key, code: 'incomplete-group' });
    }
    const [repositoryRaw, restoreRaw, worldRaw, sealSecretRaw, sealKeyIdRaw] = backupValues;
    const repositoryRoot =
      repositoryRaw === undefined
        ? undefined
        : requireAbsolute(repositoryRaw, 'VOIDFALL_BACKUP_REPOSITORY_ROOT', issues);
    const isolatedRestoreRoot =
      restoreRaw === undefined
        ? undefined
        : requireAbsolute(restoreRaw, 'VOIDFALL_BACKUP_RESTORE_ROOT', issues);
    const worldSourcePath =
      worldRaw === undefined
        ? undefined
        : requireAbsolute(worldRaw, 'VOIDFALL_BACKUP_WORLD_SOURCE', issues);
    const sealSecret =
      sealSecretRaw === undefined
        ? undefined
        : decodeKey(sealSecretRaw, 'VOIDFALL_BACKUP_SEAL_KEY', issues);
    if (sealKeyIdRaw !== undefined && !IDENTIFIER.test(sealKeyIdRaw)) {
      issues.push({ key: 'VOIDFALL_BACKUP_SEAL_KEY_ID', code: 'not-an-identifier' });
    }

    // The cipher is genuinely optional: an operator may hold the repository on
    // already-encrypted storage. Its two variables still travel together.
    const cipherSecretRaw = read(environment, 'VOIDFALL_BACKUP_ENCRYPTION_KEY');
    const cipherKeyIdRaw = read(environment, 'VOIDFALL_BACKUP_ENCRYPTION_KEY_ID');
    let encryptionKey: BackupConfiguration['encryptionKey'] = null;
    if (cipherSecretRaw !== undefined || cipherKeyIdRaw !== undefined) {
      if (cipherSecretRaw === undefined) {
        issues.push({ key: 'VOIDFALL_BACKUP_ENCRYPTION_KEY', code: 'incomplete-group' });
      }
      if (cipherKeyIdRaw === undefined) {
        issues.push({ key: 'VOIDFALL_BACKUP_ENCRYPTION_KEY_ID', code: 'incomplete-group' });
      }
      if (cipherKeyIdRaw !== undefined && !IDENTIFIER.test(cipherKeyIdRaw)) {
        issues.push({ key: 'VOIDFALL_BACKUP_ENCRYPTION_KEY_ID', code: 'not-an-identifier' });
      }
      const cipherSecret =
        cipherSecretRaw === undefined
          ? undefined
          : decodeKey(cipherSecretRaw, 'VOIDFALL_BACKUP_ENCRYPTION_KEY', issues);
      // AES-256 needs exactly 32 bytes; the service refuses anything else.
      if (cipherSecret !== undefined && cipherSecret.byteLength !== 32) {
        issues.push({ key: 'VOIDFALL_BACKUP_ENCRYPTION_KEY', code: 'key-too-short' });
      } else if (cipherSecret !== undefined && cipherKeyIdRaw !== undefined) {
        encryptionKey = { keyId: cipherKeyIdRaw, secret: cipherSecret };
      }
    }

    if (
      repositoryRoot !== undefined &&
      isolatedRestoreRoot !== undefined &&
      worldSourcePath !== undefined &&
      sealSecret !== undefined &&
      sealKeyIdRaw !== undefined &&
      IDENTIFIER.test(sealKeyIdRaw)
    ) {
      backups = {
        repositoryRoot,
        isolatedRestoreRoot,
        worldSourcePath,
        sealKey: { keyId: sealKeyIdRaw, secret: sealSecret },
        encryptionKey,
      };
    }
  }

  const diskRaw = read(environment, 'VOIDFALL_METRICS_DISK_PATH');
  const metricsDiskPath =
    diskRaw === undefined ? null : (requireAbsolute(diskRaw, 'VOIDFALL_METRICS_DISK_PATH', issues) ?? null);

  if (issues.length > 0) throw new AgentConfigurationError(issues);

  return Object.freeze({
    agentId: agentId as string,
    serverInstanceId: serverInstanceId as string,
    controlApiUrl: controlApiUrl as string,
    privateKeyPem: privateKeyPem as string,
    databaseUrl: databaseUrl as string,
    serverRelease: serverRelease as string,
    authorizedFiles,
    backups,
    metricsDiskPath,
    schedulerEnabled: read(environment, 'VOIDFALL_SCHEDULER_ENABLED') === 'true',
  });
}
