import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AgentConfigurationError,
  loadAgentConfiguration,
  type Environment,
} from '../src/runtime-config.js';

/**
 * Startup configuration validation.
 *
 * The distinction under test throughout: a **missing** optional group disables
 * a capability, a **malformed** one refuses startup. The first is a choice an
 * operator made; the second is a mistake, and treating a typo as a choice is
 * how a capability silently disappears from a deployment.
 */

const AGENT_ID = '018f6b8c-76a3-7d10-9f2e-1d9e52a63702';
const SERVER_ID = '018f6b8c-76a3-7d10-9f2e-1d9e52a63703';
const KEY = Buffer.alloc(32, 7).toString('base64');

function minimal(overrides: Environment = {}): Environment {
  return {
    VOIDFALL_AGENT_ID: AGENT_ID,
    VOIDFALL_SERVER_INSTANCE_ID: SERVER_ID,
    VOIDFALL_CONTROL_API_URL: 'https://control.voidfall.invalid',
    VOIDFALL_AGENT_PRIVATE_KEY_PEM: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    VOIDFALL_DATABASE_URL: 'postgres://voidfall@localhost/voidfall',
    VOIDFALL_SERVER_RELEASE: '1.20.1-forge-47.4.4',
    ...overrides,
  };
}

function issuesOf(environment: Environment): readonly string[] {
  try {
    loadAgentConfiguration(environment);
    return [];
  } catch (error) {
    if (!(error instanceof AgentConfigurationError)) throw error;
    return error.issues.map((issue) => `${issue.key}=${issue.code}`);
  }
}

describe('startup configuration', () => {
  it('accepts the minimum and leaves optional capabilities unconfigured', () => {
    const configuration = loadAgentConfiguration(minimal());
    assert.equal(configuration.agentId, AGENT_ID);
    // Nothing optional was configured, so nothing optional exists. That is a
    // deployment without backups, not a broken one.
    assert.equal(configuration.authorizedFiles, null);
    assert.equal(configuration.backups, null);
    assert.equal(configuration.metricsDiskPath, null);
    assert.equal(configuration.schedulerEnabled, false);
  });

  it('reports every fault in one pass rather than one per restart', () => {
    const issues = issuesOf({
      VOIDFALL_AGENT_ID: 'not-a-uuid',
      VOIDFALL_CONTROL_API_URL: 'http://insecure.voidfall.invalid',
    });
    // Missing keys and malformed keys together, so an operator fixes the whole
    // deployment once instead of discovering the next fault on the next boot.
    assert.ok(issues.includes('VOIDFALL_AGENT_ID=not-a-uuid'));
    assert.ok(issues.includes('VOIDFALL_SERVER_INSTANCE_ID=missing'));
    assert.ok(issues.includes('VOIDFALL_CONTROL_API_URL=not-an-https-url'));
    assert.ok(issues.includes('VOIDFALL_DATABASE_URL=missing'));
    assert.ok(issues.length >= 4);
  });

  it('allows loopback over plain HTTP but refuses it anywhere else', () => {
    assert.deepEqual(
      issuesOf(minimal({ VOIDFALL_CONTROL_API_URL: 'http://127.0.0.1:8080' })),
      [],
    );
    assert.ok(
      issuesOf(minimal({ VOIDFALL_CONTROL_API_URL: 'http://control.example.com' })).includes(
        'VOIDFALL_CONTROL_API_URL=not-an-https-url',
      ),
    );
  });

  it('never puts a value in the error message', () => {
    let message = '';
    try {
      loadAgentConfiguration(
        minimal({ VOIDFALL_BACKUP_SEAL_KEY: 'super-secret-key-material-here' }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    // The key is malformed, so this throws — and the message says which
    // variable and why, never what was in it.
    assert.ok(message.includes('VOIDFALL_BACKUP_SEAL_KEY'));
    assert.equal(message.includes('super-secret'), false);
  });

  it('refuses a half-configured file root instead of coming up without it', () => {
    // Forgetting one of a pair is a typo, and coming up with file access
    // silently disabled is worse than refusing to start.
    //
    // A leading-slash path is absolute on both POSIX and Win32, so this test
    // asserts the same single issue everywhere. A drive-letter path would be
    // absolute only on Windows and would add a second, platform-dependent
    // issue on Linux — which is exactly how a test starts describing the
    // runner instead of the code.
    const issues = issuesOf(minimal({ VOIDFALL_AUTHORIZED_ROOT_CONFIG: '/srv/voidfall/config' }));
    assert.deepEqual(issues, ['VOIDFALL_AUTHORIZED_REVISION_ROOT=incomplete-group']);
  });

  it('refuses a half-configured backup group and a relative path', () => {
    const issues = issuesOf(
      minimal({
        VOIDFALL_BACKUP_REPOSITORY_ROOT: 'relative/path',
        VOIDFALL_BACKUP_SEAL_KEY: KEY,
        VOIDFALL_BACKUP_SEAL_KEY_ID: 'primary',
      }),
    );
    assert.ok(issues.includes('VOIDFALL_BACKUP_RESTORE_ROOT=incomplete-group'));
    assert.ok(issues.includes('VOIDFALL_BACKUP_WORLD_SOURCE=incomplete-group'));
    assert.ok(issues.includes('VOIDFALL_BACKUP_REPOSITORY_ROOT=not-an-absolute-path'));
  });

  it('refuses a key that is not base64 or is too short', () => {
    const backup = (seal: string) =>
      issuesOf(
        minimal({
          VOIDFALL_BACKUP_REPOSITORY_ROOT: '/tmp/repo',
          VOIDFALL_BACKUP_RESTORE_ROOT: '/tmp/restore',
          VOIDFALL_BACKUP_WORLD_SOURCE: '/tmp/world',
          VOIDFALL_BACKUP_SEAL_KEY: seal,
          VOIDFALL_BACKUP_SEAL_KEY_ID: 'primary',
        }),
      );
    assert.ok(backup('not base64!!').includes('VOIDFALL_BACKUP_SEAL_KEY=not-a-base64-key'));
    assert.ok(
      backup(Buffer.alloc(8, 1).toString('base64')).includes('VOIDFALL_BACKUP_SEAL_KEY=key-too-short'),
    );
  });

  it('accepts a full backup group and treats the cipher as genuinely optional', () => {
    const base = {
      VOIDFALL_BACKUP_REPOSITORY_ROOT: '/tmp/repo',
      VOIDFALL_BACKUP_RESTORE_ROOT: '/tmp/restore',
      VOIDFALL_BACKUP_WORLD_SOURCE: '/tmp/world',
      VOIDFALL_BACKUP_SEAL_KEY: KEY,
      VOIDFALL_BACKUP_SEAL_KEY_ID: 'primary-seal',
    };
    const withoutCipher = loadAgentConfiguration(minimal(base));
    assert.equal(withoutCipher.backups?.sealKey.keyId, 'primary-seal');
    // An operator may hold the repository on already-encrypted storage.
    assert.equal(withoutCipher.backups?.encryptionKey, null);

    const withCipher = loadAgentConfiguration(
      minimal({
        ...base,
        VOIDFALL_BACKUP_ENCRYPTION_KEY: KEY,
        VOIDFALL_BACKUP_ENCRYPTION_KEY_ID: 'primary-cipher',
      }),
    );
    assert.equal(withCipher.backups?.encryptionKey?.keyId, 'primary-cipher');

    // Half a cipher is still a mistake.
    assert.ok(
      issuesOf(minimal({ ...base, VOIDFALL_BACKUP_ENCRYPTION_KEY: KEY })).includes(
        'VOIDFALL_BACKUP_ENCRYPTION_KEY_ID=incomplete-group',
      ),
    );
  });

  it('treats blank and whitespace-only values as absent, not as configured', () => {
    // A variable set to empty by a broken template is not a configuration.
    const issues = issuesOf(minimal({ VOIDFALL_DATABASE_URL: '   ' }));
    assert.deepEqual(issues, ['VOIDFALL_DATABASE_URL=missing']);
  });
});
