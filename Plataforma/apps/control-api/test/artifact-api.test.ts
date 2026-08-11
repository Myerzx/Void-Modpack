import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { hashPassword } from '@voidfall/authentication';
import {
  validateArtifactSubmission,
  validateArtifactSubmissionDetail,
  validateArtifactSubmissionPage,
  validateArtifactUploadAcceptance,
} from '@voidfall/contracts';
import { createRepositories, runMigrations, type Database } from '@voidfall/database';
import { createPGliteTestDatabase } from '@voidfall/database/testing';
import type { FastifyInstance } from 'fastify';

import { buildControlApi, type ArtifactQuarantineStore } from '../src/app.js';

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

/**
 * Stands in for the quarantine service. It consumes the stream exactly as the
 * real store does — verifying the declared digest and size — so a test proves
 * the route streams rather than buffers a decoded body.
 */
function quarantineStore(options: { readonly fail?: boolean } = {}): ArtifactQuarantineStore & {
  readonly seen: { streamed: number };
} {
  const seen = { streamed: 0 };
  return {
    seen,
    async quarantineStream(input) {
      if (options.fail === true) throw new Error('quarantine refused');
      const hash = createHash('sha256');
      let sizeBytes = 0;
      for await (const chunk of input.content) {
        seen.streamed += 1;
        sizeBytes += chunk.length;
        hash.update(chunk);
      }
      const sha256 = hash.digest('hex');
      if (sha256 !== input.expectedSha256 || sizeBytes !== input.declaredSizeBytes) {
        throw new Error('declared content did not match');
      }
      return { sha256, sizeBytes };
    },
  };
}

async function fixture(
  options: {
    readonly role?: 'owner' | 'read-only';
    readonly store?: ArtifactQuarantineStore;
  } = {},
) {
  const role = options.role ?? 'owner';
  const database = await createPGliteTestDatabase();
  await runMigrations(database);
  const repositories = createRepositories(database);
  const password = 'artifact-api-test-password';
  const user = await repositories.users.create({
    email: `${role}@voidfall.invalid`,
    displayName: `${role} fixture`,
    passwordHash: await hashPassword(password),
    roles: [role],
  });
  const server = await repositories.servers.create({
    id: randomUUID(),
    slug: 'voidfall-artifact-test',
    displayName: 'VoidFall Artifact Test',
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
    agentTransportVerifier: (request, expected) =>
      request.headers['x-test-certificate'] === expected,
    ...(options.store === undefined ? {} : { artifactQuarantineStore: options.store }),
  });
  resources.push({ app, database });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: `${role}@voidfall.invalid`, password },
  });
  assert.equal(login.statusCode, 200);
  const setCookie = login.headers['set-cookie'];
  assert.equal(typeof setCookie, 'string');

  return {
    app,
    database,
    repositories,
    server,
    user,
    cookie: (setCookie as string).split(';')[0] ?? '',
    csrfToken: login.json<{ csrfToken: string }>().csrfToken,
  };
}

const artifact = Buffer.from('PK voidfall artifact fixture', 'utf8');
const artifactSha256 = createHash('sha256').update(artifact).digest('hex');

function uploadHeaders(context: { cookie: string; csrfToken: string }, filename = 'probe-1.0.0.jar') {
  return {
    cookie: context.cookie,
    'x-csrf-token': context.csrfToken,
    'content-type': 'application/octet-stream',
    'content-length': String(artifact.length),
    'x-artifact-filename': filename,
    'x-artifact-sha256': artifactSha256,
  };
}

describe('artifact upload endpoint', () => {
  it('streams an upload into quarantine and enqueues the inspection', async () => {
    const store = quarantineStore();
    const context = await fixture({ store });

    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts`,
      headers: uploadHeaders(context),
      payload: artifact,
    });

    assert.equal(response.statusCode, 202);
    const acceptance = response.json();
    assert.equal(validateArtifactUploadAcceptance(acceptance).success, true);
    assert.equal(acceptance.sha256, artifactSha256);
    assert.equal(acceptance.state, 'quarantined');
    assert.equal(acceptance.replayed, false);
    assert.notEqual(acceptance.jobId, null);
    // The body reached the store as a stream rather than a decoded document.
    assert.ok(store.seen.streamed > 0);

    // The inspection is durable, not a promise held in memory.
    const job = await context.repositories.jobs.findById(acceptance.jobId as string);
    assert.equal(job?.type, 'artifact.inspect');
    assert.equal(job?.status, 'queued');

    // No response field carries a path or a quarantine location.
    const serialized = JSON.stringify(acceptance);
    for (const forbidden of ['path', 'root', 'directory', 'storageReference']) {
      assert.equal(serialized.includes(forbidden), false);
    }
  });

  it('refuses an upload when no quarantine store is configured', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts`,
      headers: uploadHeaders(context),
      payload: artifact,
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'ARTIFACT_QUARANTINE_UNAVAILABLE');
  });

  it('refuses an unsafe filename, a bad digest and an oversized declaration', async () => {
    const store = quarantineStore();
    const context = await fixture({ store });

    for (const filename of ['../escape.jar', 'nested/probe.jar', '..']) {
      const response = await context.app.inject({
        method: 'POST',
        url: `${BASE}/${context.server.id}/artifacts`,
        headers: { ...uploadHeaders(context), 'x-artifact-filename': filename },
        payload: artifact,
      });
      assert.equal(response.statusCode, 400, `expected ${filename} to be refused`);
    }

    const badDigest = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts`,
      headers: { ...uploadHeaders(context), 'x-artifact-sha256': 'not-a-digest' },
      payload: artifact,
    });
    assert.equal(badDigest.statusCode, 400);

    // The limit is refused from the declared length, before any byte is read.
    const streamedBefore = store.seen.streamed;
    const tooLarge = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts`,
      headers: { ...uploadHeaders(context), 'content-length': String(2 * 1024 * 1024 * 1024) },
      payload: artifact,
    });
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(store.seen.streamed, streamedBefore);
  });

  it('refuses bytes that do not match what the caller declared', async () => {
    const context = await fixture({ store: quarantineStore() });
    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts`,
      headers: {
        ...uploadHeaders(context),
        'x-artifact-sha256': 'b'.repeat(64),
      },
      payload: artifact,
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'ARTIFACT_QUARANTINE_REJECTED');
  });

  it('resolves an identical re-upload to the existing review', async () => {
    const context = await fixture({ store: quarantineStore() });
    const first = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts`,
      headers: uploadHeaders(context),
      payload: artifact,
    });
    const second = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts`,
      headers: uploadHeaders(context, 'probe-renamed.jar'),
      payload: artifact,
    });

    assert.equal(second.statusCode, 200);
    assert.equal(second.json().replayed, true);
    assert.equal(second.json().submissionId, first.json().submissionId);
    // A replay never opens a second inspection.
    assert.equal(second.json().jobId, null);
  });

  it('requires authentication, CSRF and the manage permission', async () => {
    const store = quarantineStore();
    const context = await fixture({ store });

    const anonymous = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: artifact,
    });
    assert.equal(anonymous.statusCode, 401);

    const noCsrf = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts`,
      headers: { ...uploadHeaders(context), 'x-csrf-token': 'not-the-token' },
      payload: artifact,
    });
    assert.equal(noCsrf.statusCode, 403);

    const readOnly = await fixture({ role: 'read-only', store });
    const denied = await readOnly.app.inject({
      method: 'POST',
      url: `${BASE}/${readOnly.server.id}/artifacts`,
      headers: uploadHeaders(readOnly),
      payload: artifact,
    });
    assert.equal(denied.statusCode, 403);
  });
});

describe('artifact review endpoints', () => {
  async function submitted(context: Awaited<ReturnType<typeof fixture>>) {
    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts`,
      headers: uploadHeaders(context),
      payload: artifact,
    });
    assert.equal(response.statusCode, 202);
    return response.json().submissionId as string;
  }

  it('lists submissions and filters them by state', async () => {
    const context = await fixture({ store: quarantineStore() });
    await submitted(context);

    const all = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/artifacts`,
      headers: { cookie: context.cookie },
    });
    assert.equal(all.statusCode, 200);
    assert.equal(validateArtifactSubmissionPage(all.json()).success, true);
    assert.equal(all.json().total, 1);

    const approved = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/artifacts?state=approved`,
      headers: { cookie: context.cookie },
    });
    assert.equal(approved.json().total, 0);
  });

  it('accepts a page bound as a query parameter and refuses one past the limit', async () => {
    const context = await fixture({ store: quarantineStore() });
    await submitted(context);

    // A query parameter arrives as a string; the API validates without
    // coercion, so a bound has to be parsed explicitly rather than assumed.
    const paged = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/artifacts?limit=1&offset=0`,
      headers: { cookie: context.cookie },
    });
    assert.equal(paged.statusCode, 200);
    assert.equal(paged.json().limit, 1);
    assert.equal(paged.json().submissions.length, 1);

    const beyondPage = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/artifacts?offset=50`,
      headers: { cookie: context.cookie },
    });
    assert.equal(beyondPage.json().submissions.length, 0);
    assert.equal(beyondPage.json().total, 1);

    for (const query of ['limit=0', 'limit=5000', 'limit=abc', 'offset=-1']) {
      const response = await context.app.inject({
        method: 'GET',
        url: `${BASE}/${context.server.id}/artifacts?${query}`,
        headers: { cookie: context.cookie },
      });
      assert.equal(response.statusCode, 400, `expected ${query} to be refused`);
    }
  });

  it('returns a detail whose reports are absent until they exist', async () => {
    const context = await fixture({ store: quarantineStore() });
    const submissionId = await submitted(context);

    const response = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${context.server.id}/artifacts/${submissionId}`,
      headers: { cookie: context.cookie },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(validateArtifactSubmissionDetail(response.json()).success, true);
    assert.equal(response.json().inspection, null);
    assert.equal(response.json().compatibility, null);
    assert.equal(response.json().submission.state, 'quarantined');
  });

  it('records a decision only against the analysis the reviewer read', async () => {
    const context = await fixture({ store: quarantineStore() });
    const submissionId = await submitted(context);
    const current = await context.repositories.artifactReview.findById(submissionId);
    assert.ok(current);

    // Move the submission to a state a person may decide from.
    const analyzing = await context.repositories.artifactReview.transition({
      submissionId,
      to: 'analyzing',
      expectedVersion: current.version,
      now: NOW,
    });
    const reviewable = await context.repositories.artifactReview.transition({
      submissionId,
      to: 'reviewable',
      expectedVersion: analyzing.version,
      now: NOW,
    });

    const stale = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts/${submissionId}/decision`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: {
        schemaVersion: 1,
        decision: 'approve',
        reasonCode: 'reviewed',
        analyzedSha256: artifactSha256,
        expectedVersion: reviewable.version - 1,
      },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'ARTIFACT_REVIEW_STALE');

    const otherBytes = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts/${submissionId}/decision`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: {
        schemaVersion: 1,
        decision: 'approve',
        reasonCode: 'reviewed',
        analyzedSha256: 'c'.repeat(64),
        expectedVersion: reviewable.version,
      },
    });
    assert.equal(otherBytes.statusCode, 409);

    const approved = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts/${submissionId}/decision`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: {
        schemaVersion: 1,
        decision: 'approve',
        reasonCode: 'reviewed-by-owner',
        analyzedSha256: artifactSha256,
        expectedVersion: reviewable.version,
      },
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(validateArtifactSubmission(approved.json()).success, true);
    assert.equal(approved.json().state, 'approved');
    assert.equal(approved.json().decision.reasonCode, 'reviewed-by-owner');
    assert.equal(approved.json().decision.analyzedSha256, artifactSha256);

    // Approval changes a review state only; nothing was installed or promoted.
    // Every attempt is audited, including the two that were refused.
    const audited = await context.database.query<{
      readonly action: string;
      readonly outcome: string;
    }>(
      `SELECT action, outcome FROM audit_events
       WHERE action LIKE 'artifact.%' ORDER BY action, outcome`,
    );
    assert.deepEqual(
      audited.rows.map((row) => `${row.action}:${row.outcome}`),
      [
        'artifact.approved:failed',
        'artifact.approved:failed',
        'artifact.approved:succeeded',
        'artifact.upload:succeeded',
      ],
    );
  });

  it('refuses a decision the state machine does not allow', async () => {
    const context = await fixture({ store: quarantineStore() });
    const submissionId = await submitted(context);
    const current = await context.repositories.artifactReview.findById(submissionId);
    assert.ok(current);

    // `quarantined` is not a state a person may approve from.
    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts/${submissionId}/decision`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload: {
        schemaVersion: 1,
        decision: 'approve',
        reasonCode: 'too-early',
        analyzedSha256: artifactSha256,
        expectedVersion: current.version,
      },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'ARTIFACT_DECISION_NOT_ALLOWED');
  });

  it('queues an approved server mod as a durable offline installation', async () => {
    const context = await fixture({ store: quarantineStore() });
    const submissionId = await submitted(context);
    await context.database.query(
      `UPDATE artifact_submissions
       SET state = 'approved', reviewed_side = 'server', inspected = TRUE, analyzed = TRUE,
           verdict = 'compatible', blocker_count = 0, proven_blocker_count = 0,
           decision = 'approved', decision_actor = $2::jsonb,
           decision_reason_code = 'operator-approved', decision_analyzed_sha256 = sha256,
           decided_at = $3, updated_at = $3, version = version + 1
       WHERE submission_id = $1`,
      [submissionId, JSON.stringify({ type: 'panel-user', id: context.user.id }), NOW],
    );

    const agentId = randomUUID();
    await context.repositories.agents.createProvisioningToken({
      serverInstanceId: context.server.id,
      tokenHash: 'd'.repeat(64),
      expiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: NOW,
    });
    await context.repositories.agents.register({
      agentId,
      serverInstanceId: context.server.id,
      tokenHash: 'd'.repeat(64),
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
      certificateFingerprint: 'e'.repeat(64),
      softwareVersion: '0.1.0-test',
      capabilities: ['artifact.install'],
      now: NOW,
    });
    await context.repositories.processStates.observe({
      serverInstanceId: context.server.id,
      eventId: randomUUID(),
      lifecycle: 'offline',
      observedBy: agentId,
      correlationId: randomUUID(),
      now: NOW,
    });
    const approved = await context.repositories.artifactReview.findById(submissionId);
    assert.ok(approved);

    const payload = {
      schemaVersion: 1,
      analyzedSha256: approved.sha256,
      expectedVersion: approved.version,
      idempotencyKey: 'artifact-install-api-0001',
      reasonCode: 'operator-install-approved',
    };
    const response = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts/${submissionId}/install`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload,
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().kind, 'artifact.install');
    assert.equal(response.json().artifactSubmissionId, submissionId);
    assert.equal(response.json().status, 'running');

    const job = await context.repositories.jobs.findById(response.json().jobId as string);
    assert.equal(job?.type, 'artifact.install');
    assert.deepEqual(job?.resource, { type: 'server-instance', id: context.server.id });
    assert.equal(JSON.stringify(job?.payload).includes(submissionId), false);

    const replay = await context.app.inject({
      method: 'POST',
      url: `${BASE}/${context.server.id}/artifacts/${submissionId}/install`,
      headers: { cookie: context.cookie, 'x-csrf-token': context.csrfToken },
      payload,
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().operationId, response.json().operationId);
  });

  it('keeps reading and deciding behind their own permissions', async () => {
    const context = await fixture({ store: quarantineStore() });
    const submissionId = await submitted(context);

    const readOnly = await fixture({ role: 'read-only', store: quarantineStore() });
    // A read-only role may look at the catalog but never decide.
    const listed = await readOnly.app.inject({
      method: 'GET',
      url: `${BASE}/${readOnly.server.id}/artifacts`,
      headers: { cookie: readOnly.cookie },
    });
    assert.equal(listed.statusCode, 200);

    const denied = await readOnly.app.inject({
      method: 'POST',
      url: `${BASE}/${readOnly.server.id}/artifacts/${submissionId}/decision`,
      headers: { cookie: readOnly.cookie, 'x-csrf-token': readOnly.csrfToken },
      payload: {
        schemaVersion: 1,
        decision: 'approve',
        reasonCode: 'reviewed',
        analyzedSha256: artifactSha256,
        expectedVersion: 1,
      },
    });
    assert.equal(denied.statusCode, 403);

    const missingServer = await context.app.inject({
      method: 'GET',
      url: `${BASE}/${randomUUID()}/artifacts`,
      headers: { cookie: context.cookie },
    });
    assert.equal(missingServer.statusCode, 404);
  });
});
