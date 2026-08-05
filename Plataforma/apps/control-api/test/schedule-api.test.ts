import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import {
  SchedulePersistenceError,
  createRepositories,
  runMigrations,
  type Database,
} from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { FastifyInstance } from 'fastify';

import { buildControlApi } from '../src/app.js';

/**
 * Phase 10.5 schedule routes and run lifecycle.
 *
 * Nothing is executed here: no backup runs, no server restarts. What is under
 * test is that one occurrence produces one run, that a dead scheduler's claim
 * can be taken over and only after it lapses, and that a run which restarted
 * cannot report success without having verified the server came back.
 */

const resources: Array<{ app: FastifyInstance; database: Database }> = [];
const NOW = new Date('2026-08-05T12:00:00.000Z');

afterEach(async () => {
  while (resources.length > 0) {
    const resource = resources.pop();
    if (resource !== undefined) {
      await resource.app.close();
      await resource.database.close();
    }
  }
});

async function fixture(options: { readonly role?: 'owner' | 'read-only' } = {}) {
  const role = options.role ?? 'owner';
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const password = 'schedule-api-test-password';
  await repositories.users.create({
    email: `${role}@voidfall.invalid`,
    displayName: `${role} fixture`,
    passwordHash: await hashPassword(password),
    roles: [role],
  });
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-schedule-test',
    displayName: 'VoidFall Schedule Test',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });

  const app = await buildControlApi({
    database,
    cookieSecure: false,
    clock: () => NOW,
    agentTransportVerifier: () => true,
  });
  resources.push({ app, database });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: `${role}@voidfall.invalid`, password },
  });
  assert.equal(login.statusCode, 200);

  return {
    app,
    database,
    repositories,
    server,
    cookie: (login.headers['set-cookie'] as string).split(';')[0] ?? '',
    csrfToken: login.json<{ csrfToken: string }>().csrfToken,
  };
}

type Context = Awaited<ReturnType<typeof fixture>>;

function post(context: Context, url: string, payload: unknown) {
  return context.app.inject({
    method: 'POST',
    url,
    headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
    payload: payload as Record<string, unknown>,
  });
}

const scheduleBody = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  name: 'Nightly maintenance',
  enabled: true,
  trigger: { timezone: 'America/Sao_Paulo', hour: 4, minute: 0, weekdays: [] },
  steps: [
    { kind: 'warn-players', leadSeconds: 300 },
    { kind: 'maintenance-check', maximumPlayersOnline: 0 },
    { kind: 'backup', scope: 'world' },
    { kind: 'restart', timeoutSeconds: 300 },
  ],
  reasonCode: 'scheduled-maintenance',
  ...overrides,
});

describe('creating a schedule', () => {
  it('stores the plan and the instant it will actually fire', async () => {
    const context = await fixture();
    const response = await post(
      context,
      `/api/v1/servers/${context.server.id}/schedules`,
      scheduleBody(),
    );
    assert.equal(response.statusCode, 201);
    // 04:00 in São Paulo is 07:00Z. An operator has to see when the window
    // actually falls before agreeing to it.
    assert.equal(response.json().nextRunAt, '2026-08-06T07:00:00.000Z');
    assert.equal(response.json().trigger.timezone, 'America/Sao_Paulo');
  });

  it('refuses a step outside the catalogue', async () => {
    const context = await fixture();
    const response = await post(
      context,
      `/api/v1/servers/${context.server.id}/schedules`,
      scheduleBody({ steps: [{ kind: 'run-command', command: 'rm -rf /' }] }),
    );
    // A scheduler that accepted a command string would be a way to run
    // arbitrary work on a timer.
    assert.equal(response.statusCode, 400);
  });

  it('refuses an unsupported timezone and a backup after its restart', async () => {
    const context = await fixture();
    assert.equal(
      (
        await post(
          context,
          `/api/v1/servers/${context.server.id}/schedules`,
          scheduleBody({
            trigger: { timezone: 'Mars/Olympus', hour: 4, minute: 0, weekdays: [] },
          }),
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          context,
          `/api/v1/servers/${context.server.id}/schedules`,
          scheduleBody({
            steps: [
              { kind: 'restart', timeoutSeconds: 300 },
              { kind: 'backup', scope: 'world' },
            ],
          }),
        )
      ).statusCode,
      400,
    );
  });

  it('refuses a duplicate name and a manage attempt from a viewer', async () => {
    const context = await fixture();
    assert.equal(
      (await post(context, `/api/v1/servers/${context.server.id}/schedules`, scheduleBody()))
        .statusCode,
      201,
    );
    assert.equal(
      (await post(context, `/api/v1/servers/${context.server.id}/schedules`, scheduleBody()))
        .statusCode,
      409,
    );

    const viewer = await fixture({ role: 'read-only' });
    assert.equal(
      (await post(viewer, `/api/v1/servers/${viewer.server.id}/schedules`, scheduleBody()))
        .statusCode,
      403,
    );
  });

  it('clears the next run when a schedule is switched off', async () => {
    const context = await fixture();
    const created = await post(
      context,
      `/api/v1/servers/${context.server.id}/schedules`,
      scheduleBody(),
    );
    const scheduleId = created.json().scheduleId as string;

    const disabled = await post(
      context,
      `/api/v1/servers/${context.server.id}/schedules/${scheduleId}/enabled`,
      { schemaVersion: 1, enabled: false },
    );
    // A schedule switched off but still holding a due time is one a scheduler
    // would pick up anyway.
    assert.equal(disabled.json().enabled, false);
    assert.equal(disabled.json().nextRunAt, null);

    const reenabled = await post(
      context,
      `/api/v1/servers/${context.server.id}/schedules/${scheduleId}/enabled`,
      { schemaVersion: 1, enabled: true },
    );
    // Recomputed from now, so a schedule switched back on is not due for a
    // window that passed while it was off.
    assert.equal(reenabled.json().nextRunAt, '2026-08-06T07:00:00.000Z');
  });
});

describe('one occurrence produces one run', () => {
  async function schedule(context: Context) {
    const created = await post(
      context,
      `/api/v1/servers/${context.server.id}/schedules`,
      scheduleBody(),
    );
    return created.json().scheduleId as string;
  }

  it('refuses a second claim on the same occurrence', async () => {
    const context = await fixture();
    const scheduleId = await schedule(context);
    const scheduledFor = new Date('2026-08-06T07:00:00.000Z');

    const first = await context.repositories.schedules.claimOccurrence({
      runId: randomUUID(),
      scheduleId,
      serverInstanceId: context.server.id,
      scheduledFor,
      claimedBy: randomUUID(),
      leaseSeconds: 600,
      now: NOW,
    });
    assert.equal(first.status, 'claimed');

    // Two schedulers waking at once, or one waking twice. The database decides.
    await assert.rejects(
      context.repositories.schedules.claimOccurrence({
        runId: randomUUID(),
        scheduleId,
        serverInstanceId: context.server.id,
        scheduledFor,
        claimedBy: randomUUID(),
        leaseSeconds: 600,
        now: NOW,
      }),
      (error: unknown) =>
        error instanceof SchedulePersistenceError && error.code === 'occurrence-claimed',
    );
  });

  it('lets a lapsed claim be taken over, and only once it has lapsed', async () => {
    const context = await fixture();
    const scheduleId = await schedule(context);
    const scheduledFor = new Date('2026-08-06T07:00:00.000Z');
    const first = await context.repositories.schedules.claimOccurrence({
      runId: randomUUID(),
      scheduleId,
      serverInstanceId: context.server.id,
      scheduledFor,
      claimedBy: randomUUID(),
      leaseSeconds: 600,
      now: NOW,
    });

    // Still held.
    await assert.rejects(
      context.repositories.schedules.claimOccurrence({
        runId: randomUUID(),
        scheduleId,
        serverInstanceId: context.server.id,
        scheduledFor,
        claimedBy: randomUUID(),
        leaseSeconds: 600,
        now: new Date(NOW.getTime() + 300_000),
      }),
      (error: unknown) => error instanceof SchedulePersistenceError,
    );

    // The scheduler died; the lease lapsed. Recovery is the lease expiring, not
    // anything the dead process had to do on its way down.
    const later = new Date(NOW.getTime() + 700_000);
    const taken = await context.repositories.schedules.claimOccurrence({
      runId: randomUUID(),
      scheduleId,
      serverInstanceId: context.server.id,
      scheduledFor,
      claimedBy: randomUUID(),
      leaseSeconds: 600,
      now: later,
    });
    // Same occurrence, same run row — not a second run for the same window.
    assert.equal(taken.runId, first.runId);
    assert.equal(taken.status, 'claimed');

    const abandoned = await context.repositories.schedules.listAbandoned(
      new Date(later.getTime() + 700_000),
    );
    assert.equal(abandoned.length, 1);
  });

  it('will not record a restart as successful without verifying the server came back', async () => {
    const context = await fixture();
    const scheduleId = await schedule(context);
    const run = await context.repositories.schedules.claimOccurrence({
      runId: randomUUID(),
      scheduleId,
      serverInstanceId: context.server.id,
      scheduledFor: new Date('2026-08-06T07:00:00.000Z'),
      claimedBy: randomUUID(),
      leaseSeconds: 600,
      now: NOW,
    });

    // Restarted, never came back. "Succeeded" here would mean only that the
    // command was sent.
    await assert.rejects(
      context.repositories.schedules.settle({
        runId: run.runId,
        status: 'succeeded',
        postRestartVerified: false,
        nextRunAt: '2026-08-07T07:00:00.000Z',
        now: NOW,
      }),
    );

    const settled = await context.repositories.schedules.settle({
      runId: run.runId,
      status: 'succeeded',
      postRestartVerified: true,
      nextRunAt: '2026-08-07T07:00:00.000Z',
      now: NOW,
    });
    assert.equal(settled.status, 'succeeded');

    // Settling advanced the schedule in the same transaction, so nothing can
    // observe a finished run against a schedule still pointing at its window.
    const after = await context.repositories.schedules.findById(scheduleId);
    assert.equal(after?.nextRunAt, '2026-08-07T07:00:00.000Z');
    assert.equal(after?.lastRunAt, NOW.toISOString());
  });

  it('treats a skipped run as settled rather than failed', async () => {
    const context = await fixture();
    const scheduleId = await schedule(context);
    const run = await context.repositories.schedules.claimOccurrence({
      runId: randomUUID(),
      scheduleId,
      serverInstanceId: context.server.id,
      scheduledFor: new Date('2026-08-06T07:00:00.000Z'),
      claimedBy: randomUUID(),
      leaseSeconds: 600,
      now: NOW,
    });
    const skipped = await context.repositories.schedules.settle({
      runId: run.runId,
      status: 'skipped',
      postRestartVerified: null,
      nextRunAt: '2026-08-07T07:00:00.000Z',
      now: NOW,
    });
    // The maintenance check said now was not the time. That is a fact worth
    // recording, not an error.
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.failureCode, null);

    const runs = await context.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${context.server.id}/schedules/${scheduleId}/runs`,
      headers: { cookie: context.cookie },
    });
    assert.equal(runs.json().runs.length, 1);
    assert.equal(runs.json().runs[0].status, 'skipped');
  });
});
