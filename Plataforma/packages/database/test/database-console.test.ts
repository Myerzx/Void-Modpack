import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { hashPassword } from '@voidfall/authentication';
import {
  OPENLOADER_ADVANCED_OPTIONS_V1,
  hashConfigurationSchema,
} from '@voidfall/configuration-schemas';
import type {
  ActorRef,
  AuditEvent,
  CompatibilityIssue,
  Job,
  ModCatalogEntry,
} from '@voidfall/contracts';
import { PANEL_PERMISSIONS, permissionsForRoles } from '@voidfall/permissions';
import {
  AgentTransportError,
  ArtifactReviewError,
  ConfigurationPersistenceError,
  ModCatalogPersistenceError,
  OperationalPersistenceError,
  createRepositories,
  runMigrations,
} from '../src/index.js';
import { createPGliteTestDatabase } from '../src/testing.js';

/**
 * Split out of the former single `database.test.ts`.
 *
 * That file created sixteen WASM Postgres instances in one process, which
 * intermittently tripped a V8 JIT page assertion on the Windows runner. The
 * Node test runner gives each *file* its own process, so splitting by concern
 * bounds how much WASM churn any one process sees. The tests themselves are
 * unchanged.
 */

describe('console persistence', () => {
  async function consoleFixture() {
    const database = await createPGliteTestDatabase();
    await runMigrations(database);
    const repositories = createRepositories(database);
    const serverInstanceId = randomUUID();
    await repositories.servers.create({
      id: serverInstanceId,
      slug: 'console-test',
      displayName: 'Console Test',
      environment: 'test',
      minecraftVersion: '1.20.1',
      loader: 'forge',
      loaderVersion: '47.4.4',
      maxPlayers: 20,
    });
    return { database, repositories, serverInstanceId };
  }

  const line = (text: string, offsetMs = 0) => ({
    stream: 'stdout' as const,
    text,
    occurredAt: new Date(new Date('2026-08-05T12:00:00Z').getTime() + offsetMs),
  });

  it('reads forward by cursor without skipping or repeating a line', async () => {
    const { database, repositories, serverInstanceId } = await consoleFixture();
    try {
      await repositories.console.append({
        serverInstanceId,
        lines: [line('primeira', 0), line('segunda', 1_000), line('terceira', 2_000)],
        retainLines: 100,
        now: new Date('2026-08-05T12:00:03Z'),
      });

      const first = await repositories.console.read({
        serverInstanceId,
        limit: 2,
        now: new Date('2026-08-05T12:00:04Z'),
      });
      assert.deepEqual(
        first.lines.map((entry) => entry.text),
        ['primeira', 'segunda'],
      );
      assert.equal(first.hasMore, true);
      assert.equal(first.nextCursor, 3);

      const second = await repositories.console.read({
        serverInstanceId,
        fromSequence: first.nextCursor ?? 1,
        limit: 2,
        now: new Date('2026-08-05T12:00:05Z'),
      });
      assert.deepEqual(
        second.lines.map((entry) => entry.text),
        ['terceira'],
      );
      assert.equal(second.hasMore, false);

      // Reading again from the same cursor yields nothing new.
      const third = await repositories.console.read({
        serverInstanceId,
        fromSequence: second.nextCursor ?? 1,
        now: new Date('2026-08-05T12:00:06Z'),
      });
      assert.deepEqual(third.lines, []);
    } finally {
      await database.close();
    }
  });

  it('redacts a secret, an address and a path on the way in', async () => {
    const { database, repositories, serverInstanceId } = await consoleFixture();
    try {
      await repositories.console.append({
        serverInstanceId,
        lines: [
          line('rcon.password=hunter2'),
          line('Player joined from 203.0.113.7:51234', 1_000),
          line('Loading C:\\Servidor\\workspace\\world', 2_000),
        ],
        retainLines: 100,
        now: new Date('2026-08-05T12:00:03Z'),
      });

      const page = await repositories.console.read({
        serverInstanceId,
        now: new Date('2026-08-05T12:00:04Z'),
      });
      const texts = page.lines.map((entry) => entry.text).join('\n');
      // The stored text never held the secret in the clear.
      assert.equal(texts.includes('hunter2'), false);
      assert.equal(texts.includes('203.0.113.7'), false);
      assert.equal(texts.includes('C:\\Servidor'), false);
      assert.ok(page.lines.every((entry) => entry.redacted));
    } finally {
      await database.close();
    }
  });

  it('keeps the console bounded and tells a reader it fell behind', async () => {
    const { database, repositories, serverInstanceId } = await consoleFixture();
    try {
      for (let batch = 0; batch < 3; batch += 1) {
        await repositories.console.append({
          serverInstanceId,
          lines: [line(`linha-${String(batch)}-a`), line(`linha-${String(batch)}-b`, 100)],
          retainLines: 3,
          now: new Date('2026-08-05T12:00:03Z'),
        });
      }

      // Retention held the bound.
      assert.equal(await repositories.console.retainedCount(serverInstanceId), 3);

      // A reader whose cursor fell behind can see where history now starts.
      const page = await repositories.console.read({
        serverInstanceId,
        fromSequence: 1,
        now: new Date('2026-08-05T12:00:04Z'),
      });
      assert.equal(page.oldestRetainedSequence, 4);
      assert.equal(page.lines[0]?.sequence, 4);
    } finally {
      await database.close();
    }
  });

  it('never reuses a sequence, even after retention deleted everything', async () => {
    const { database, repositories, serverInstanceId } = await consoleFixture();
    try {
      await repositories.console.append({
        serverInstanceId,
        lines: [line('antiga')],
        retainLines: 1,
        now: new Date('2026-08-05T12:00:01Z'),
      });
      await repositories.console.trimOlderThan({
        serverInstanceId,
        olderThan: new Date('2026-08-05T13:00:00Z'),
      });
      assert.equal(await repositories.console.retainedCount(serverInstanceId), 0);

      const appended = await repositories.console.append({
        serverInstanceId,
        lines: [line('nova', 5_000)],
        retainLines: 10,
        now: new Date('2026-08-05T12:00:06Z'),
      });
      // The next sequence continues past the deleted line rather than reusing 1.
      assert.equal(appended.lastSequence, 2);
    } finally {
      await database.close();
    }
  });

  it('truncates an overlong line and marks it', async () => {
    const { database, repositories, serverInstanceId } = await consoleFixture();
    try {
      await repositories.console.append({
        serverInstanceId,
        lines: [line('x'.repeat(5_000))],
        retainLines: 10,
        now: new Date('2026-08-05T12:00:01Z'),
      });
      const page = await repositories.console.read({
        serverInstanceId,
        now: new Date('2026-08-05T12:00:02Z'),
      });
      assert.equal(page.lines[0]?.truncated, true);
      assert.ok((page.lines[0]?.text.length ?? 0) <= 2_048);
    } finally {
      await database.close();
    }
  });
});
