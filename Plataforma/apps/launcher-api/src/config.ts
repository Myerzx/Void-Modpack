import { createPublicKey, type KeyObject } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

export interface LauncherApiConfig {
  readonly host: string;
  readonly port: number;
  readonly repositoryRoot: string;
  readonly publicKeys: ReadonlyMap<string, KeyObject>;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required.`);
  return value;
}

export function readLauncherApiConfig(
  environment: NodeJS.ProcessEnv = process.env,
): LauncherApiConfig {
  const repositoryRoot = required(environment, 'VOIDFALL_RELEASE_REPOSITORY_ROOT');
  if (!isAbsolute(repositoryRoot)) {
    throw new Error('VOIDFALL_RELEASE_REPOSITORY_ROOT must be absolute.');
  }
  const rawKeys = JSON.parse(required(environment, 'VOIDFALL_RELEASE_PUBLIC_KEYS_JSON')) as unknown;
  if (rawKeys === null || typeof rawKeys !== 'object' || Array.isArray(rawKeys)) {
    throw new Error('VOIDFALL_RELEASE_PUBLIC_KEYS_JSON must be an object.');
  }
  const publicKeys = new Map<string, KeyObject>();
  for (const [keyId, pem] of Object.entries(rawKeys)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(keyId) || typeof pem !== 'string') {
      throw new Error('Release public key configuration is invalid.');
    }
    const key = createPublicKey(pem);
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
      throw new Error('Release keys must be Ed25519 public keys.');
    }
    publicKeys.set(keyId, key);
  }
  if (publicKeys.size < 1) throw new Error('At least one release public key is required.');

  const port = Number(environment['VOIDFALL_LAUNCHER_PORT'] ?? '3211');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('VOIDFALL_LAUNCHER_PORT is invalid.');
  }
  return Object.freeze({
    host: environment['VOIDFALL_LAUNCHER_HOST'] ?? '127.0.0.1',
    port,
    repositoryRoot: resolve(repositoryRoot),
    publicKeys,
  });
}
