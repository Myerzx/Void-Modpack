import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import type { ArtifactCompatibilityPlan } from '@voidfall/contracts';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { FastifyInstance } from 'fastify';

// The worker and the panel view model are imported from source. `npm run check`
// typechecks before it builds the apps, so depending on a sibling app's emitted
// declarations would fail on a clean checkout.
import {
  runArtifactWorkerOnce,
  type CompatibilityPlanFactory,
  type QuarantinedArtifactReader,
} from '../../build-worker/src/artifact-worker.js';
import {
  buildArtifactListView,
  buildDependencyGraphView,
  buildIncompatibilityDrawerView,
  buildInstallActionView,
  type ArtifactSubmissionDetail,
  type ArtifactSubmissionPage,
} from '../../panel-web/lib/artifact-view.js';
import { buildControlApi, type ArtifactQuarantineStore } from '../src/app.js';

/**
 * Phase 8 completion criteria, proved end to end:
 *
 *  1. a test JAR enters quarantine, is inspected without being executed and
 *     produces a persisted report;
 *  2. a minimum incompatibility reaches the panel view model and is audited;
 *  3. no analyzed artifact reaches a Minecraft runtime.
 *
 * The archive is built in code, so no private JAR is opened anywhere here.
 */

const resources: Array<{ app: FastifyInstance; database: Database }> = [];
const NOW = new Date('2026-08-05T12:00:00.000Z');
const BASE = '/api/v1/servers';

afterEach(async () => {
  while (resources.length > 0) {
    const resource = resources.pop();
    if (resource !== undefined) {
      await resource.app.close();
      await resource.database.close();
    }
  }
});

function buildZip(entries: readonly { readonly name: string; readonly content: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.from(entry.content, 'utf8');
    const nameBytes = Buffer.from(entry.name, 'utf8');

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, raw);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + raw.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}

/** A mod that declares a Minecraft version the target server does not run. */
const INCOMPATIBLE_MOD = [
  'modLoader = "javafml"',
  'loaderVersion = "[47,)"',
  'license = "MIT"',
  '',
  '[[mods]]',
  'modId = "voidfall_probe"',
  'version = "1.0.0"',
  'displayName = "VoidFall Probe"',
  '',
  '[[dependencies.voidfall_probe]]',
  'modId = "minecraft"',
  'mandatory = true',
  'versionRange = "[1.19.2]"',
  'side = "BOTH"',
  '',
  '[[dependencies.voidfall_probe]]',
  'modId = "jei"',
  'mandatory = false',
  'versionRange = "[15,)"',
  'side = "BOTH"',
  '',
].join('\n');

const archive = buildZip([{ name: 'META-INF/mods.toml', content: INCOMPATIBLE_MOD }]);
const archiveSha256 = createHash('sha256').update(archive).digest('hex');

/**
 * Stands in for the quarantine service. It keeps the bytes in memory under
 * their digest, which is all the worker is ever given: the reader receives a
 * hash, never a path.
 */
function quarantine(): ArtifactQuarantineStore & QuarantinedArtifactReader {
  const stored = new Map<string, Uint8Array>();
  return {
    async quarantineStream(input) {
      const chunks: Uint8Array[] = [];
      const hash = createHash('sha256');
      let sizeBytes = 0;
      for await (const chunk of input.content) {
        chunks.push(chunk);
        sizeBytes += chunk.length;
        hash.update(chunk);
      }
      const sha256 = hash.digest('hex');
      if (sha256 !== input.expectedSha256 || sizeBytes !== input.declaredSizeBytes) {
        throw new Error('declared content did not match');
      }
      stored.set(sha256, Buffer.concat(chunks));
      return { sha256, sizeBytes };
    },
    async read(sha256) {
      const content = stored.get(sha256);
      if (content === undefined) throw new Error('unknown artifact');
      return content;
    },
  };
}

/** Describes the active server as the only compatibility target. */
function planFactory(): CompatibilityPlanFactory {
  return {
    build: async ({ submissionId, filename, inspection }) =>
      ({
        schemaVersion: 1,
        analysisId: 'phase-8-e2e',
        generatedAt: NOW.toISOString(),
        contexts: [
          {
            contextId: 'server-active',
            kind: 'server_active',
            side: 'server',
            runtime: {
              minecraftVersion: '1.20.1',
              loader: 'forge',
              loaderVersion: '1.20.1-47.4.4',
            },
            javaVersion: '17',
          },
        ],
        candidates: [
          {
            artifactId: `submission-${submissionId.slice(0, 8)}`,
            filename,
            inspection,
            reviewedSide: 'both',
            targetContextIds: ['server-active'],
            distributionReviewed: true,
          },
        ],
        installed: [],
        explicitConflicts: [],
      }) satisfies ArtifactCompatibilityPlan,
  };
}

async function fixture() {
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const password = 'artifact-e2e-test-password';
  const user = await repositories.users.create({
    email: 'owner@voidfall.invalid',
    displayName: 'Owner fixture',
    passwordHash: await hashPassword(password),
    roles: ['owner'],
  });
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-artifact-e2e',
    displayName: 'VoidFall Artifact E2E',
    environment: 'test',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    loaderVersion: '1.20.1-47.4.4',
    maxPlayers: 20,
  });

  const store = quarantine();
  const app = await buildControlApi({
    database,
    cookieSecure: false,
    clock: () => NOW,
    agentTransportVerifier: () => true,
    artifactQuarantineStore: store,
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
    user,
    store,
    cookie: (login.headers['set-cookie'] as string).split(';')[0] ?? '',
    csrfToken: login.json<{ csrfToken: string }>().csrfToken,
  };
}

describe('Phase 8 end-to-end artifact review', () => {
  it('quarantines, inspects and analyzes a test JAR and surfaces it in the panel', async () => {
    const context = await fixture();

    // 1. The artifact enters quarantine through the authenticated endpoint.
    const upload = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts`,
      headers: {
        cookie: context.cookie,
        'x-csrf-token': context.csrfToken,
        'content-type': 'application/octet-stream',
        'content-length': String(archive.length),
        'x-artifact-filename': 'voidfall-probe-1.0.0.jar',
        'x-artifact-sha256': archiveSha256,
      },
      payload: archive,
    });
    assert.equal(upload.statusCode, 202);
    const submissionId = upload.json().submissionId as string;
    assert.equal(upload.json().state, 'quarantined');

    // 2. The durable jobs inspect and then analyze it.
    const workerId = randomUUID();
    const inspected = await runArtifactWorkerOnce({
      database: context.database,
      workerId,
      reader: context.store,
      planFactory: planFactory(),
      now: NOW,
    });
    assert.equal(inspected.processed && inspected.outcome, 'inspected');

    const analyzed = await runArtifactWorkerOnce({
      database: context.database,
      workerId,
      reader: context.store,
      planFactory: planFactory(),
      now: NOW,
    });
    assert.equal(analyzed.processed && analyzed.outcome, 'analyzed');

    // 3. Both reports are persisted, not merely computed.
    const storedInspection = await context.repositories.artifactReview.findInspectionReport(
      submissionId,
    );
    const storedCompatibility =
      await context.repositories.artifactReview.findCompatibilityReport(submissionId);
    assert.notEqual(storedInspection, undefined);
    assert.notEqual(storedCompatibility, undefined);
    assert.equal(storedInspection?.sha256, archiveSha256);

    // 4. The declared incompatibility blocked the artifact.
    const detailResponse = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/artifacts/${submissionId}`,
      headers: { cookie: context.cookie },
    });
    assert.equal(detailResponse.statusCode, 200);
    const detail = detailResponse.json() as ArtifactSubmissionDetail;
    assert.equal(detail.submission.state, 'blocked');

    // 5. It reaches the panel view model with severity, reason and evidence.
    const drawer = buildIncompatibilityDrawerView(detail, 'blocker');
    assert.equal(drawer.available, true);
    assert.ok(drawer.counts.blocker > 0);
    const blocker = drawer.rows.find((row) => row.code === 'minecraft-version-mismatch');
    assert.ok(blocker, 'the declared Minecraft mismatch must reach the panel');
    assert.equal(blocker.severityLabel, 'Bloqueio');
    assert.equal(blocker.determinacyLabel, 'Comprovado');
    assert.deepEqual(blocker.evidence, ['META-INF/mods.toml']);
    assert.equal(blocker.recommendedAction, 'match-minecraft-version');

    // The dependency graph is derived on demand from the same stored report.
    const graph = buildDependencyGraphView(detail);
    assert.equal(graph.available, true);
    assert.ok(graph.edges.some((edge) => edge.to === 'jei' && !edge.mandatory));

    const listResponse = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/artifacts`,
      headers: { cookie: context.cookie },
    });
    const list = buildArtifactListView({ page: listResponse.json() as ArtifactSubmissionPage });
    assert.equal(list.items[0]?.stateLabel, 'Bloqueado');
    assert.equal(list.items[0]?.sideLabel, 'Não revisado');

    // 6. The whole path is audited.
    const audited = await context.database.query<{ readonly action: string }>(
      "SELECT action FROM audit_events WHERE action LIKE 'artifact.%' ORDER BY action",
    );
    assert.deepEqual(
      audited.rows.map((row) => row.action),
      ['artifact.upload'],
    );

    // 7. Nothing installed the artifact, and the panel offers no way to.
    assert.equal(buildInstallActionView().present, false);
    const jobTypes = await context.database.query<{ readonly type: string }>(
      'SELECT DISTINCT type FROM jobs ORDER BY type',
    );
    assert.deepEqual(
      jobTypes.rows.map((row) => row.type),
      ['artifact.analyze', 'artifact.inspect'],
    );
  });

  it('refuses to approve a proven incompatibility and records the rejection', async () => {
    const context = await fixture();
    const upload = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts`,
      headers: {
        cookie: context.cookie,
        'x-csrf-token': context.csrfToken,
        'content-type': 'application/octet-stream',
        'content-length': String(archive.length),
        'x-artifact-filename': 'voidfall-probe-1.0.0.jar',
        'x-artifact-sha256': archiveSha256,
      },
      payload: archive,
    });
    const submissionId = upload.json().submissionId as string;

    const workerId = randomUUID();
    await runArtifactWorkerOnce({
      database: context.database,
      workerId,
      reader: context.store,
      planFactory: planFactory(),
      now: NOW,
    });
    await runArtifactWorkerOnce({
      database: context.database,
      workerId,
      reader: context.store,
      planFactory: planFactory(),
      now: NOW,
    });

    const blocked = await context.repositories.artifactReview.findById(submissionId);
    assert.ok(blocked);
    assert.equal(blocked.state, 'blocked');

    // A blocked artifact is never silently admitted.
    const approve = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts/${submissionId}/decision`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: {
        schemaVersion: 1,
        decision: 'approve',
        reasonCode: 'looks-fine',
        analyzedSha256: archiveSha256,
        expectedVersion: blocked.version,
      },
    });
    assert.equal(approve.statusCode, 422);
    assert.equal(approve.json().error.code, 'ARTIFACT_DECISION_NOT_ALLOWED');

    // Rejecting it explicitly records actor, reason and the analyzed hash.
    const reject = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts/${submissionId}/decision`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: {
        schemaVersion: 1,
        decision: 'reject',
        reasonCode: 'incompatible-minecraft-version',
        analyzedSha256: archiveSha256,
        expectedVersion: blocked.version,
        reviewedSide: 'server',
      },
    });
    assert.equal(reject.statusCode, 200);
    assert.equal(reject.json().state, 'rejected');
    assert.equal(reject.json().decision.reasonCode, 'incompatible-minecraft-version');
    assert.equal(reject.json().decision.analyzedSha256, archiveSha256);
    assert.equal(reject.json().reviewedSide, 'server');

    const logged = await context.database.query<{
      readonly reason_code: string;
      readonly analyzed_sha256: string;
    }>('SELECT reason_code, analyzed_sha256 FROM artifact_review_decisions WHERE submission_id = $1', [
      submissionId,
    ]);
    assert.equal(logged.rows.length, 1);
    assert.equal(logged.rows[0]?.analyzed_sha256, archiveSha256);
  });
});
