import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { provisionLocalAgentIdentity } from '../src/local-agent.js';

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    await rm(directories.pop()!, { recursive: true, force: true });
  }
});

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'voidfall-local-agent-'));
  directories.push(directory);
  return directory;
}

describe('local agent identity ownership', () => {
  it('provisions a different durable identity for every ServerInstance', async () => {
    const state = await stateDirectory();
    const firstServerId = randomUUID();
    const secondServerId = randomUUID();
    const first = await provisionLocalAgentIdentity(state, firstServerId);
    const second = await provisionLocalAgentIdentity(state, secondServerId);

    assert.notEqual(first.agentId, second.agentId);
    assert.equal(
      (await readFile(join(state, 'agents', firstServerId, 'agent-id.txt'), 'utf8')).trim(),
      first.agentId,
    );
    assert.equal(
      (await provisionLocalAgentIdentity(state, firstServerId)).agentId,
      first.agentId,
    );
  });

  it('migrates the legacy singleton key only to the instance the database assigned it to', async () => {
    const state = await stateDirectory();
    const legacyAgentId = randomUUID();
    const keyPair = generateKeyPairSync('ed25519');
    const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await writeFile(join(state, 'agent-key.pem'), privateKeyPem, 'utf8');
    await writeFile(join(state, 'agent-id.txt'), `${legacyAgentId}\n`, 'utf8');

    const serverInstanceId = randomUUID();
    const migrated = await provisionLocalAgentIdentity(state, serverInstanceId, legacyAgentId);
    assert.equal(migrated.agentId, legacyAgentId);
    assert.equal(migrated.privateKeyPem, privateKeyPem);

    await assert.rejects(
      provisionLocalAgentIdentity(state, randomUUID(), randomUUID()),
      /no local private key/u,
    );
  });
});
