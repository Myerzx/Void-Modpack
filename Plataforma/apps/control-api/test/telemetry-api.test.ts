import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { FastifyInstance } from 'fastify';

import { buildControlApi } from '../src/app.js';

/**
 * Phase 10.4 metrics and alerts routes.
 *
 * The thing under test is that nothing is invented: a metric nobody measured
 * comes back saying so, and the store itself refuses to hold a tick rate no
 * approved provider produced.
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

async function fixture(options: { readonly gameProviderConnected?: boolean } = {}) {
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const password = 'telemetry-api-test-password';
  await repositories.users.create({
    email: 'owner@voidfall.invalid',
    displayName: 'owner fixture',
    passwordHash: await hashPassword(password),
    roles: ['owner'],
  });
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-telemetry-test',
    displayName: 'VoidFall Telemetry Test',
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
    ...(options.gameProviderConnected === undefined
      ? {}
      : { gameProviderConnected: options.gameProviderConnected }),
  });
  resources.push({ app, database });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'owner@voidfall.invalid', password },
  });
  assert.equal(login.statusCode, 200);

  return {
    app,
    database,
    repositories,
    server,
    cookie: (login.headers['set-cookie'] as string).split(';')[0] ?? '',
  };
}

type Context = Awaited<ReturnType<typeof fixture>>;

function get(context: Context, url: string) {
  return context.app.inject({ method: 'GET', url, headers: { cookie: context.cookie } });
}

describe('metrics are reported with their source and quality', () => {
  it('reports tick timing as unavailable when no approved provider is connected', async () => {
    const context = await fixture();
    const response = await get(context, `/api/v1/servers/${context.server.id}/metrics`);
    assert.equal(response.statusCode, 200);
    const body = response.json<{
      buckets: unknown[];
      unavailable: Array<{ name: string; source: string; reason: string }>;
    }>();

    // The number an operator most wants is the one this platform cannot see,
    // and it says so instead of leaving a gap the panel would draw as healthy.
    const tps = body.unavailable.find((entry) => entry.name === 'game.tps');
    assert.equal(tps?.reason, 'no-approved-provider');
    assert.equal(tps?.source, 'none');
    assert.equal(
      body.unavailable.some((entry) => entry.name === 'game.mspt'),
      true,
    );
  });

  it('serves stored buckets with the source and quality they were stored with', async () => {
    const context = await fixture();
    await context.repositories.telemetry.recordBuckets({
      serverInstanceId: context.server.id,
      now: NOW,
      buckets: [
        {
          name: 'host.memory.available.bytes',
          bucketStart: '2026-08-05T11:59:00.000Z',
          bucketSeconds: 60,
          minimum: 100,
          maximum: 300,
          average: 200,
          sampleCount: 3,
          source: 'host-agent',
          quality: 'measured',
        },
      ],
    });

    const response = await get(
      context,
      `/api/v1/servers/${context.server.id}/metrics?names=host.memory.available.bytes`,
    );
    const body = response.json<{
      buckets: Array<{ name: string; average: number; sampleCount: number; source: string; quality: string }>;
      unavailable: unknown[];
    }>();
    assert.equal(body.buckets.length, 1);
    assert.equal(body.buckets[0]?.source, 'host-agent');
    assert.equal(body.buckets[0]?.quality, 'measured');
    // How many samples built the average travels with it, so a bucket from
    // three readings is not read like one from sixty.
    assert.equal(body.buckets[0]?.sampleCount, 3);
    assert.deepEqual(body.unavailable, []);
  });

  it('says a measurable metric was simply not collected', async () => {
    const context = await fixture();
    const response = await get(
      context,
      `/api/v1/servers/${context.server.id}/metrics?names=host.load.1m`,
    );
    assert.deepEqual(response.json().unavailable, [
      { name: 'host.load.1m', source: 'none', reason: 'not-collected' },
    ]);
  });

  it('refuses an unknown metric name and an out-of-range window', async () => {
    const context = await fixture();
    assert.equal(
      (await get(context, `/api/v1/servers/${context.server.id}/metrics?names=host.made.up`))
        .statusCode,
      400,
    );
    assert.equal(
      (await get(context, `/api/v1/servers/${context.server.id}/metrics?windowMinutes=99999`))
        .statusCode,
      400,
    );
    assert.equal(
      (await get(context, `/api/v1/servers/${context.server.id}/metrics?windowMinutes=abc`))
        .statusCode,
      400,
    );
  });
});

describe('the store refuses a fabricated metric', () => {
  it('will not hold tick timing that no approved provider produced', async () => {
    const context = await fixture();
    // The host agent cannot see inside a running server. The database refuses
    // the row outright, so no collector bug and no future writer can put an
    // invented tick rate on a chart.
    await assert.rejects(
      context.database.query(
        `INSERT INTO server_metric_buckets (
           server_instance_id, metric_name, bucket_start, bucket_seconds,
           minimum, maximum, average, sample_count, source, quality, created_at
         ) VALUES ($1, 'game.tps', $2, 60, 19, 20, 19.5, 5, 'host-agent', 'measured', $2)`,
        [context.server.id, NOW.toISOString()],
      ),
    );
  });

  it('will not hold a bucket whose average lies outside its own range', async () => {
    const context = await fixture();
    await assert.rejects(
      context.database.query(
        `INSERT INTO server_metric_buckets (
           server_instance_id, metric_name, bucket_start, bucket_seconds,
           minimum, maximum, average, sample_count, source, quality, created_at
         ) VALUES ($1, 'host.load.1m', $2, 60, 1, 2, 99, 5, 'host-agent', 'measured', $2)`,
        [context.server.id, NOW.toISOString()],
      ),
    );
  });

  it('folds a window reported twice instead of double counting it', async () => {
    const context = await fixture();
    const bucket = {
      name: 'host.load.1m' as const,
      bucketStart: '2026-08-05T11:59:00.000Z',
      bucketSeconds: 60,
      minimum: 1,
      maximum: 3,
      average: 2,
      sampleCount: 2,
      source: 'host-agent' as const,
      quality: 'measured' as const,
    };
    await context.repositories.telemetry.recordBuckets({
      serverInstanceId: context.server.id,
      now: NOW,
      buckets: [bucket],
    });
    await context.repositories.telemetry.recordBuckets({
      serverInstanceId: context.server.id,
      now: NOW,
      buckets: [{ ...bucket, minimum: 0, maximum: 10, average: 5, sampleCount: 2, quality: 'stale' }],
    });

    const series = await context.repositories.telemetry.readSeries({
      serverInstanceId: context.server.id,
      names: ['host.load.1m'],
      since: new Date('2026-08-05T00:00:00.000Z'),
    });
    assert.equal(series.length, 1);
    assert.equal(series[0]?.sampleCount, 4);
    assert.equal(series[0]?.minimum, 0);
    assert.equal(series[0]?.maximum, 10);
    assert.equal(series[0]?.average, 3.5);
    // A merged bucket is only as good as its worse half.
    assert.equal(series[0]?.quality, 'stale');
  });
});

describe('alerts', () => {
  it('opens one alert per kind however often it is raised', async () => {
    const context = await fixture();
    const raise = () =>
      context.repositories.telemetry.openAlert({
        alertId: randomUUID(),
        serverInstanceId: context.server.id,
        kind: 'disk.low',
        severity: 'critical',
        metricName: 'host.disk.free.bytes',
        observedValue: 20,
        threshold: 50,
        source: 'host-agent',
        now: NOW,
      });
    const first = await raise();
    const second = await raise();
    // A collector running every thirty seconds must not bury the one alert an
    // operator needed to see under copies of itself.
    assert.equal(second.alertId, first.alertId);

    const response = await get(context, `/api/v1/servers/${context.server.id}/alerts?status=open`);
    assert.equal(response.json().alerts.length, 1);
    // The alert names the reading that raised it.
    assert.equal(response.json().alerts[0].metricName, 'host.disk.free.bytes');
    assert.equal(response.json().alerts[0].observedValue, 20);

    await context.repositories.telemetry.resolveAlert(first.alertId, NOW);
    const afterResolve = await get(
      context,
      `/api/v1/servers/${context.server.id}/alerts?status=open`,
    );
    assert.deepEqual(afterResolve.json().alerts, []);
    // Resolved, and re-raisable afterwards.
    assert.notEqual((await raise()).alertId, first.alertId);
  });
});
