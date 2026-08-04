import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import {
  runConfigurationWorkerOnce,
  type ConfigurationOperationExecutor,
} from '@voidfall/build-worker';
import {
  OPENLOADER_ADVANCED_OPTIONS_V1 as OPENLOADER_SCHEMA_V1,
  hashConfigurationSchema,
} from '@voidfall/configuration-schemas';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import { ConfigurationOperationCapability } from '@voidfall/server-agent';
import {
  FilesystemConfigurationService,
  createReviewedConfigurationResource,
  type ConfigurationConsistencyLease,
  type OfflineExclusiveConfigurationGuard,
} from '@voidfall/server-configuration';
import type { FastifyInstance } from 'fastify';

import {
  buildConfigurationScreen,
  changeEntriesFor,
  computeSafeDiff,
  screenStateForError,
  type ConfigurationResourceStateView,
  type ConfigurationRevisionView,
  type ConfigurationSchemaView,
} from '../../panel-web/lib/configuration-view.js';
import { buildControlApi, type ConfigurationValueReader } from '../src/app.js';

/**
 * Phase 7 completion proof.
 *
 * One reviewed configuration travels the whole path:
 *   panel view model -> Control API -> durable job -> Server Agent capability
 *   -> PersistentConfigurationService -> temporary filesystem -> audit chain.
 *
 * The filesystem is always an OS temporary directory created per test. The
 * private Minecraft runtime is never read, written or started.
 */

const NOW = new Date('2026-08-04T12:00:00.000Z');
const RESOURCE_ID = 'openloader-advanced-options';

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()?.();
});

class OfflineGuard implements OfflineExclusiveConfigurationGuard {
  async runWithExclusiveOfflineAccess<T>(
    _resourceId: string,
    operation: (lease: ConfigurationConsistencyLease) => Promise<T>,
  ): Promise<T> {
    return operation({ method: 'offline-exclusive-v1', acquiredAt: NOW });
  }
}

function digest(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

function openLoaderDocument(dataPacks: boolean, resourcePacks: boolean): string {
  return `${JSON.stringify(
    {
      resourcePacks: { enabled: resourcePacks, additionalFolders: [] },
      dataPacks: { enabled: dataPacks, additionalFolders: [] },
    },
    null,
    2,
  )}\n`;
}

async function stack(options: { readonly role?: 'owner' | 'read-only' } = {}) {
  const role = options.role ?? 'owner';
  const root = await mkdtemp(join(tmpdir(), 'voidfall-configuration-e2e-'));
  const configurationRoot = join(root, 'instance');
  const revisionRepositoryRoot = join(root, 'revision-repository');
  const openLoaderDirectory = join(configurationRoot, 'config', 'openloader');
  const filePath = join(openLoaderDirectory, 'advanced_options.json');
  const original = openLoaderDocument(true, true);
  await mkdir(openLoaderDirectory, { recursive: true });
  await mkdir(revisionRepositoryRoot);
  await writeFile(filePath, original, 'utf8');

  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const password = 'configuration-e2e-password';
  const user = await repositories.users.create({
    email: `${role}@voidfall.invalid`,
    displayName: `${role} e2e`,
    passwordHash: await hashPassword(password),
    roles: [role],
  });
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-e2e',
    displayName: 'VoidFall E2E',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });
  await repositories.configuration.registerSchema({
    revisionId: 'openloader-schema-1',
    schema: OPENLOADER_SCHEMA_V1,
    expectedSchemaSha256: null,
    actorId: user.id,
    reasonCode: 'phase-7-3-e2e',
    createdAt: NOW.toISOString(),
  });
  await repositories.configuration.registerResource({
    serverInstanceId: server.id,
    resourceId: RESOURCE_ID,
    expectedSchemaSha256: hashConfigurationSchema(OPENLOADER_SCHEMA_V1),
    initialCurrentSha256: digest(original),
    createdAt: NOW.toISOString(),
  });

  // The API reads current values through the same reviewed resource the agent
  // mutates; it still never learns the path.
  const readerService = new FilesystemConfigurationService({
    repositoryRoot: revisionRepositoryRoot,
    resources: [createReviewedConfigurationResource(configurationRoot, RESOURCE_ID)],
    guard: new OfflineGuard(),
    clock: () => NOW,
  });
  const configurationReader: ConfigurationValueReader = {
    async readConfiguration(_serverInstanceId, resourceId) {
      const read = await readerService.readConfiguration(resourceId);
      return { currentSha256: read.currentSha256, values: read.values };
    },
  };

  const capability = new ConfigurationOperationCapability({
    serverInstanceId: server.id,
    runtime: { configurationRoot, revisionRepositoryRoot, authorizedResourceIds: [RESOURCE_ID] },
    guard: new OfflineGuard(),
    configurationRepository: repositories.configuration,
    operationalLocks: repositories.operationalLocks,
    clock: () => NOW,
  });
  const executor: ConfigurationOperationExecutor = {
    execute: (command) => capability.execute(command),
  };

  const app: FastifyInstance = await buildControlApi({
    database,
    cookieSecure: false,
    clock: () => NOW,
    configurationReader,
  });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: `${role}@voidfall.invalid`, password },
  });
  assert.equal(login.statusCode, 200);
  const cookie = ((login.headers['set-cookie'] as string) ?? '').split(';')[0] ?? '';
  const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
  const authHeaders = { cookie, 'x-csrf-token': csrfToken };
  const base = `/api/v1/servers/${server.id}/configuration/resources/${RESOURCE_ID}`;

  teardown.push(async () => {
    await app.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  });

  /** Drains the queue exactly as the deployed worker would. */
  async function drainQueue() {
    const outcomes = [];
    for (;;) {
      const result = await runConfigurationWorkerOnce({
        database,
        workerId: randomUUID(),
        executor,
        now: NOW,
      });
      if (!result.processed) break;
      outcomes.push(result);
    }
    return outcomes;
  }

  /** Loads the panel screen through the real endpoints. */
  async function panelScreen() {
    const [catalog, resource, revisions, session] = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/api/v1/servers/${server.id}/configuration/schemas`,
        headers: { cookie },
      }),
      app.inject({ method: 'GET', url: base, headers: { cookie } }),
      app.inject({ method: 'GET', url: `${base}/revisions`, headers: { cookie } }),
      app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie } }),
    ]);
    if (catalog.statusCode !== 200) {
      return { screen: screenStateForError(catalog.statusCode), raw: { catalog } };
    }
    const permissions = session.json<{ permissions: string[] }>().permissions;
    const schemas = catalog.json<{ schemas: ConfigurationSchemaView[] }>().schemas;
    const revisionPage =
      revisions.statusCode === 200
        ? revisions.json<{ revisions: ConfigurationRevisionView[] }>().revisions
        : [];
    return {
      screen: buildConfigurationScreen({
        schema: schemas.find((entry) => entry.resourceId === RESOURCE_ID),
        state:
          resource.statusCode === 200
            ? resource.json<ConfigurationResourceStateView>()
            : undefined,
        revisions: revisionPage,
        permissions,
      }),
      raw: { catalog, resource, revisions },
    };
  }

  return {
    app,
    database,
    repositories,
    server,
    user,
    root,
    filePath,
    original,
    base,
    cookie,
    authHeaders,
    drainQueue,
    panelScreen,
    readCurrent: () => readFile(filePath, 'utf8'),
  };
}

describe('Phase 7 end-to-end configuration flow', () => {
  it('carries one change from the panel view model to the filesystem and the audit chain', async () => {
    const context = await stack();

    // 1. The panel loads the real screen and computes a safe diff.
    const loaded = await context.panelScreen();
    assert.equal(loaded.screen.kind, 'ready');
    if (loaded.screen.kind !== 'ready') return;
    assert.equal(loaded.screen.state.valuesAvailable, true);
    const diff = computeSafeDiff(loaded.screen.schema, loaded.screen.state, {
      'dataPacks.enabled': false,
      'resourcePacks.enabled': true,
    });
    assert.deepEqual(changeEntriesFor(diff), [{ name: 'dataPacks.enabled', value: false }]);

    // 2. Validation reports the effect without touching anything.
    const validation = await context.app.inject({
      method: 'POST',
      url: `${context.base}/validate`,
      headers: context.authHeaders,
      payload: { schemaVersion: 1, changes: changeEntriesFor(diff) },
    });
    assert.equal(validation.statusCode, 200);
    assert.equal(validation.json().applied, false);
    assert.equal(validation.json().valid, true);
    assert.deepEqual(validation.json().changedFields, ['dataPacks.enabled']);
    assert.equal(await context.readCurrent(), context.original);

    // 3. Apply enqueues a typed command; nothing has changed on disk yet.
    const apply = await context.app.inject({
      method: 'POST',
      url: `${context.base}/apply`,
      headers: context.authHeaders,
      payload: {
        schemaVersion: 1,
        expectedCurrentSha256: loaded.screen.state.currentSha256,
        expectedStateVersion: loaded.screen.state.stateVersion,
        idempotencyKey: 'configuration-e2e-apply-1',
        reasonCode: 'operator-request',
        changes: changeEntriesFor(diff),
      },
    });
    assert.equal(apply.statusCode, 202);
    assert.equal(await context.readCurrent(), context.original);

    // 4. The worker leases the job and the agent capability performs it.
    const drained = await context.drainQueue();
    assert.equal(drained.length, 1);
    assert.equal(drained[0]?.outcome, 'applied');

    // 5. The temporary filesystem now holds the reviewed document.
    const updated = await context.readCurrent();
    assert.equal(updated, openLoaderDocument(false, true));

    // 6. Persistence and audit agree, without storing any value.
    const state = await context.repositories.configuration.state(context.server.id, RESOURCE_ID);
    assert.equal(state?.status, 'applied');
    assert.equal(state?.currentSha256, digest(updated));
    const revision = await context.repositories.configuration.revision(apply.json().revisionId);
    assert.equal(revision?.status, 'applied');
    assert.deepEqual(revision?.changedFields, ['dataPacks.enabled']);

    const chain = await context.repositories.audit.listChain('configuration', 1, 100);
    assert.equal(chain.length > 0, true);
    const auditJson = JSON.stringify(chain);
    assert.equal(auditJson.includes('dataPacks.enabled'), true);
    assert.equal(/"value"\s*:/u.test(auditJson), false);
    assert.equal(auditJson.includes(context.root), false);
    assert.equal(auditJson.includes('advanced_options.json'), false);
    assert.equal(
      (await context.repositories.audit.verifyPartition('configuration')).valid,
      true,
    );

    // 7. The panel reloads and sees the new state and revision.
    const reloaded = await context.panelScreen();
    assert.equal(reloaded.screen.kind, 'ready');
    if (reloaded.screen.kind !== 'ready') return;
    assert.equal(reloaded.screen.state.currentSha256, digest(updated));
    assert.equal(reloaded.screen.state.status, 'applied');
    assert.deepEqual(
      reloaded.screen.state.values.find((value) => value.name === 'dataPacks.enabled'),
      { name: 'dataPacks.enabled', redacted: false, value: false },
    );
    assert.equal(reloaded.screen.revisions.length, 1);
    // No response along the way exposed the temporary root.
    assert.equal(JSON.stringify(reloaded.raw).includes(context.root), false);
  });

  it('replays an idempotent apply without producing a second revision', async () => {
    const context = await stack();
    const loaded = await context.panelScreen();
    assert.equal(loaded.screen.kind, 'ready');
    if (loaded.screen.kind !== 'ready') return;
    const payload = {
      schemaVersion: 1,
      expectedCurrentSha256: loaded.screen.state.currentSha256,
      expectedStateVersion: loaded.screen.state.stateVersion,
      idempotencyKey: 'configuration-e2e-replay-1',
      reasonCode: 'operator-request',
      changes: [{ name: 'dataPacks.enabled', value: false }],
    };

    const first = await context.app.inject({
      method: 'POST',
      url: `${context.base}/apply`,
      headers: context.authHeaders,
      payload,
    });
    const replay = await context.app.inject({
      method: 'POST',
      url: `${context.base}/apply`,
      headers: context.authHeaders,
      payload,
    });

    assert.equal(first.statusCode, 202);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().replayed, true);
    assert.equal(first.json().jobId, replay.json().jobId);

    const drained = await context.drainQueue();
    assert.equal(drained.length, 1);
    const revisions = await context.repositories.configuration.listRevisions(
      context.server.id,
      RESOURCE_ID,
    );
    assert.equal(revisions.length, 1);
    assert.equal(await context.readCurrent(), openLoaderDocument(false, true));
  });

  it('rejects a stale hash after a concurrent apply instead of overwriting it', async () => {
    const context = await stack();
    const loaded = await context.panelScreen();
    assert.equal(loaded.screen.kind, 'ready');
    if (loaded.screen.kind !== 'ready') return;
    const staleSha = loaded.screen.state.currentSha256;
    const staleVersion = loaded.screen.state.stateVersion;

    await context.app.inject({
      method: 'POST',
      url: `${context.base}/apply`,
      headers: context.authHeaders,
      payload: {
        schemaVersion: 1,
        expectedCurrentSha256: staleSha,
        expectedStateVersion: staleVersion,
        idempotencyKey: 'configuration-e2e-first-writer',
        reasonCode: 'operator-request',
        changes: [{ name: 'dataPacks.enabled', value: false }],
      },
    });
    await context.drainQueue();
    const afterFirst = await context.readCurrent();

    // A second operator still holding the old read must be refused.
    const stale = await context.app.inject({
      method: 'POST',
      url: `${context.base}/apply`,
      headers: context.authHeaders,
      payload: {
        schemaVersion: 1,
        expectedCurrentSha256: staleSha,
        expectedStateVersion: staleVersion,
        idempotencyKey: 'configuration-e2e-second-writer',
        reasonCode: 'operator-request',
        changes: [{ name: 'resourcePacks.enabled', value: false }],
      },
    });

    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'CONFIGURATION_STATE_STALE');
    assert.equal(await context.readCurrent(), afterFirst);
    assert.equal(
      (await context.repositories.configuration.listRevisions(context.server.id, RESOURCE_ID))
        .length,
      1,
    );

    // The panel surfaces the conflict as its own state.
    assert.equal(screenStateForError(409, stale.json().error.code).kind, 'conflict');
  });

  it('records a sanitized failure and leaves the document untouched', async () => {
    const context = await stack();
    const loaded = await context.panelScreen();
    assert.equal(loaded.screen.kind, 'ready');
    if (loaded.screen.kind !== 'ready') return;

    // The document changes behind the API after the state was read, so the
    // agent's own preflight must refuse the operation.
    await context.app.inject({
      method: 'POST',
      url: `${context.base}/apply`,
      headers: context.authHeaders,
      payload: {
        schemaVersion: 1,
        expectedCurrentSha256: loaded.screen.state.currentSha256,
        expectedStateVersion: loaded.screen.state.stateVersion,
        idempotencyKey: 'configuration-e2e-failure-1',
        reasonCode: 'operator-request',
        changes: [{ name: 'dataPacks.enabled', value: false }],
      },
    });
    const tampered = openLoaderDocument(true, false);
    await writeFile(context.filePath, tampered, 'utf8');

    const drained = await context.drainQueue();
    assert.equal(drained[0]?.outcome, 'failed');
    assert.equal(await context.readCurrent(), tampered);

    const revision = await context.repositories.configuration.revision(
      drained[0]?.revisionId ?? '',
    );
    assert.equal(revision?.status, 'failed');
    assert.equal(revision?.failureCode, 'concurrent-modification');

    const job = await context.repositories.jobs.findById(drained[0]?.jobId ?? '');
    assert.equal(job?.status, 'failed');
    assert.equal(JSON.stringify(job).includes(context.root), false);

    // The shared lock was released even though the operation failed.
    const lock = await context.repositories.operationalLocks.current(
      context.server.id,
      'minecraft-exclusive',
    );
    assert.equal(lock, undefined);
  });

  it('rolls back to an eligible revision through the whole path', async () => {
    const context = await stack();
    const loaded = await context.panelScreen();
    assert.equal(loaded.screen.kind, 'ready');
    if (loaded.screen.kind !== 'ready') return;

    await context.app.inject({
      method: 'POST',
      url: `${context.base}/apply`,
      headers: context.authHeaders,
      payload: {
        schemaVersion: 1,
        expectedCurrentSha256: loaded.screen.state.currentSha256,
        expectedStateVersion: loaded.screen.state.stateVersion,
        idempotencyKey: 'configuration-e2e-rollback-apply',
        reasonCode: 'operator-request',
        changes: [{ name: 'dataPacks.enabled', value: false }],
      },
    });
    await context.drainQueue();
    assert.equal(await context.readCurrent(), openLoaderDocument(false, true));

    const afterApply = await context.panelScreen();
    assert.equal(afterApply.screen.kind, 'ready');
    if (afterApply.screen.kind !== 'ready') return;
    const candidate = afterApply.screen.revisions[0];
    assert.ok(candidate);

    const rollback = await context.app.inject({
      method: 'POST',
      url: `${context.base}/rollback`,
      headers: context.authHeaders,
      payload: {
        schemaVersion: 1,
        targetRevisionId: candidate.revisionId,
        expectedCurrentSha256: afterApply.screen.state.currentSha256,
        expectedStateVersion: afterApply.screen.state.stateVersion,
        idempotencyKey: 'configuration-e2e-rollback-1',
        reasonCode: 'operator-request',
      },
    });
    assert.equal(rollback.statusCode, 202);

    const drained = await context.drainQueue();
    assert.equal(drained[0]?.outcome, 'applied');
    // Rollback restores the exact previous bytes and records a new revision.
    assert.equal(await context.readCurrent(), context.original);
    const revisions = await context.repositories.configuration.listRevisions(
      context.server.id,
      RESOURCE_ID,
    );
    assert.equal(revisions.length, 2);
    assert.equal(revisions.some((entry) => entry.operation === 'rollback'), true);
    assert.equal(
      (await context.repositories.audit.verifyPartition('configuration')).valid,
      true,
    );
  });

  it('never lets an unregistered format or a public path reach the filesystem', async () => {
    const context = await stack();

    // An unreviewed resource is refused before any job exists.
    for (const resourceId of ['server-basic', 'openloader-packs', 'rcon']) {
      const response = await context.app.inject({
        method: 'POST',
        url: `/api/v1/servers/${context.server.id}/configuration/resources/${resourceId}/apply`,
        headers: context.authHeaders,
        payload: {
          schemaVersion: 1,
          expectedCurrentSha256: digest(context.original),
          expectedStateVersion: 1,
          idempotencyKey: `configuration-e2e-unknown-${resourceId}`,
          reasonCode: 'operator-request',
          changes: [{ name: 'dataPacks.enabled', value: false }],
        },
      });
      assert.equal(response.statusCode, 404);
    }

    // A path-shaped identifier never resolves to a filesystem location.
    const traversal = await context.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${context.server.id}/configuration/resources/${encodeURIComponent('../../server.properties')}/apply`,
      headers: context.authHeaders,
      payload: {
        schemaVersion: 1,
        expectedCurrentSha256: digest(context.original),
        expectedStateVersion: 1,
        idempotencyKey: 'configuration-e2e-traversal',
        reasonCode: 'operator-request',
        changes: [{ name: 'dataPacks.enabled', value: false }],
      },
    });
    assert.equal(traversal.statusCode === 400 || traversal.statusCode === 404, true);

    assert.equal((await context.drainQueue()).length, 0);
    assert.equal(await context.readCurrent(), context.original);
    assert.equal(
      (await context.repositories.configuration.listRevisions(context.server.id, RESOURCE_ID))
        .length,
      0,
    );
  });

  it('denies the whole flow to a session without configuration permissions', async () => {
    const context = await stack({ role: 'read-only' });

    const loaded = await context.panelScreen();
    assert.equal(loaded.screen.kind, 'denied');

    const apply = await context.app.inject({
      method: 'POST',
      url: `${context.base}/apply`,
      headers: context.authHeaders,
      payload: {
        schemaVersion: 1,
        expectedCurrentSha256: digest(context.original),
        expectedStateVersion: 1,
        idempotencyKey: 'configuration-e2e-denied-1',
        reasonCode: 'operator-request',
        changes: [{ name: 'dataPacks.enabled', value: false }],
      },
    });
    assert.equal(apply.statusCode, 403);

    assert.equal((await context.drainQueue()).length, 0);
    assert.equal(await context.readCurrent(), context.original);
    const events = await context.repositories.audit.list();
    assert.equal(events.some((event) => event.action === 'authorization.denied'), true);
  });
});
