import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canPublishInStable,
  validateAgentEnvelope,
  validateAgentHeartbeatPayload,
  validateAuditChainExportManifest,
  validateAuditEvent,
  validateCatalogReconciliationReport,
  validateForgeBuildRequest,
  validateInventorySnapshot,
  validateJob,
  validateLauncherChannel,
  validateLauncherManagedState,
  validateMinecraftPermissionBinding,
  validateModCatalogEntry,
  validateModCompatibilityAnalysisPlan,
  validateModCompatibilityReport,
  validateModerationCase,
  validatePlayerDataPolicy,
  validatePlayerProfile,
  validateReleaseManifest,
} from '../src/index.js';

const uuid = '018f6b8c-76a3-7d10-9f2e-1d9e52a63701';
const otherUuid = '018f6b8c-76a3-7d10-9f2e-1d9e52a63702';
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const signature = 'A'.repeat(86);

function validJob(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: uuid,
    type: 'modpack.build',
    resource: { type: 'server-instance', id: 'voidfall-primary' },
    status: 'queued',
    stage: 'awaiting-lease',
    priority: 50,
    payload: { schemaVersion: 1, parameters: { requestedVersion: '0.1.0' } },
    idempotencyKey: 'build:voidfall:0.1.0',
    requestedBy: { type: 'panel-user', id: otherUuid },
    correlationId: otherUuid,
    availableAt: '2026-08-03T12:00:00Z',
    attempt: 0,
    maxAttempts: 3,
  };
}

function validCatalogEntry(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'example-mod',
    logicalName: 'Example Mod',
    filename: 'example-mod-1.0.0.jar',
    path: 'mods/example-mod-1.0.0.jar',
    kind: 'mod',
    side: 'both',
    requirement: 'required',
    version: '1.0.0',
    sizeBytes: 1_024,
    sha256: hashA,
    runtime: {
      minecraftVersion: '1.20.1',
      loader: 'forge',
      loaderVersion: '1.20.1-47.4.4',
    },
    source: {
      provider: 'modrinth',
      projectId: 'example-project',
      fileId: 'example-file',
      sourceUrl: 'https://modrinth.com/mod/example',
    },
    distribution: {
      decision: 'allowed',
      licenseExpression: 'MIT',
      evidenceReference: 'https://modrinth.com/mod/example/license',
      reviewedBy: otherUuid,
      reviewedAt: '2026-08-03T12:00:00Z',
    },
    reviewState: 'reviewed',
    dependencies: [],
  };
}

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    product: { id: 'voidfall', displayName: 'VoidFall' },
    release: {
      version: '0.1.0',
      buildId: 'build-20260803-120000',
      publishedAt: '2026-08-03T12:00:00Z',
      message: 'Primeiro contrato verificável.',
    },
    runtime: {
      minecraft: '1.20.1',
      loader: 'forge',
      loaderVersion: '1.20.1-47.4.4',
      javaMajor: 17,
    },
    serverProfile: { id: 'voidfall-primary', displayName: 'VoidFall' },
    files: [
      {
        path: 'config/example.toml',
        artifactId: `sha256:${hashA}`,
        size: 128,
        sha256: hashA,
        kind: 'config',
        side: 'both',
        required: true,
      },
      {
        path: 'mods/example.jar',
        artifactId: `sha256:${hashB}`,
        size: 1_024,
        sha256: hashB,
        kind: 'mod',
        side: 'both',
        required: true,
      },
    ],
    removedPaths: ['mods/old-example.jar'],
    signature: { algorithm: 'Ed25519', keyId: 'release-2026-01', value: signature },
  };
}

function validInventorySnapshot(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    inventoryId: 'launcher-20260803',
    observedAt: '2026-08-03T12:00:00Z',
    source: {
      sourceId: 'voidfall-launcher',
      scope: 'client',
      type: 'launcher-export',
    },
    runtime: {
      minecraftVersion: '1.20.1',
      loader: 'forge',
      loaderVersion: '1.20.1-47.4.4',
    },
    entries: [
      {
        path: 'mods/example.jar',
        filename: 'example.jar',
        kind: 'mod',
        state: 'active',
        sizeBytes: 1_024,
        sha256: hashA,
      },
    ],
  };
}

function validCompatibilityPlan(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    analysisId: 'compatibility-20260804',
    generatedAt: '2026-08-04T12:00:00Z',
    contexts: [
      {
        id: 'launcher-current',
        kind: 'launcher_current',
        side: 'client',
        runtime: { minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.0' },
        javaVersion: '17',
        evidenceReference: 'fixture:launcher',
      },
      {
        id: 'server-active',
        kind: 'server_active',
        side: 'server',
        runtime: { minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.4' },
        javaVersion: '17',
        evidenceReference: 'fixture:server',
      },
    ],
    components: [
      {
        id: 'example-mod',
        kind: 'root-mod',
        occurrences: [
          {
            occurrenceId: 'example-launcher',
            contextId: 'launcher-current',
            artifactId: 'fixture:example-launcher',
            filename: 'example-1.0.0.jar',
            version: '1.0.0',
            loader: 'forge',
            container: { kind: 'root' },
            metadataPath: 'META-INF/mods.toml',
          },
        ],
        dependencies: [
          {
            occurrenceId: 'example-launcher',
            targetId: 'forge',
            required: true,
            side: 'both',
            versionRange: '[47,48)',
            evidenceReference: 'example.jar!META-INF/mods.toml',
          },
        ],
      },
    ],
  };
}

function validReconciliationReport(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    reconciliationId: 'reconcile-20260803',
    generatedAt: '2026-08-03T12:01:00Z',
    targetRuntime: {
      minecraftVersion: '1.20.1',
      loader: 'forge',
      loaderVersion: '1.20.1-47.4.4',
    },
    catalogEntryCount: 1,
    inputs: [
      {
        inventoryId: 'launcher-20260803',
        sourceId: 'voidfall-launcher',
        scope: 'client',
        type: 'launcher-export',
        observedAt: '2026-08-03T12:00:00Z',
        entryCount: 1,
      },
    ],
    artifacts: [
      {
        artifactId: `sha256:${hashA}`,
        sha256: hashA,
        matchState: 'cataloged',
        catalogEntryIds: ['example-mod'],
        filenames: ['example.jar'],
        suggestedSide: 'client',
        observations: [
          {
            inventoryId: 'launcher-20260803',
            sourceId: 'voidfall-launcher',
            scope: 'client',
            path: 'mods/example.jar',
            filename: 'example.jar',
            state: 'active',
            sizeBytes: 1_024,
          },
        ],
        blockers: [],
      },
    ],
    summary: {
      totalArtifacts: 1,
      catalogedArtifacts: 1,
      untrackedArtifacts: 0,
      ambiguousArtifacts: 0,
      blockedArtifacts: 0,
      unblockedArtifacts: 1,
    },
  };
}

describe('Job', () => {
  it('accepts a queued versioned job', () => {
    assert.equal(validateJob(validJob()).success, true);
  });

  it('rejects unknown top-level fields', () => {
    const job = { ...validJob(), command: 'rm -rf .' };
    assert.equal(validateJob(job).success, false);
  });

  it('requires a lease for running jobs', () => {
    const job = { ...validJob(), status: 'running' };
    const result = validateJob(job);
    assert.equal(result.success, false);
    assert.ok(!result.success && result.issues.some((issue) => issue.path === '/lease'));
  });
});

describe('AgentEnvelope', () => {
  it('accepts the shape of a signed, expiring envelope', () => {
    const envelope = {
      schemaVersion: 1,
      messageId: uuid,
      correlationId: otherUuid,
      agentId: uuid,
      serverInstanceId: otherUuid,
      kind: 'heartbeat',
      issuedAt: '2026-08-03T12:00:00Z',
      expiresAt: '2026-08-03T12:05:00Z',
      nonce: 'n'.repeat(43),
      payloadHash: hashA,
      payload: { schemaVersion: 1, data: { state: 'online' } },
      signature: { algorithm: 'Ed25519', keyId: 'agent-2026-01', value: signature },
    };
    assert.equal(validateAgentEnvelope(envelope).success, true);
  });

  it('rejects an envelope whose expiry precedes issuance', () => {
    const envelope = {
      schemaVersion: 1,
      messageId: uuid,
      correlationId: otherUuid,
      agentId: uuid,
      serverInstanceId: otherUuid,
      kind: 'heartbeat',
      issuedAt: '2026-08-03T12:05:00Z',
      expiresAt: '2026-08-03T12:00:00Z',
      nonce: 'n'.repeat(43),
      payloadHash: hashA,
      payload: { schemaVersion: 1, data: {} },
      signature: { algorithm: 'Ed25519', keyId: 'agent-2026-01', value: signature },
    };
    assert.equal(validateAgentEnvelope(envelope).success, false);
  });

  it('validates heartbeat payloads separately from the generic envelope', () => {
    assert.equal(
      validateAgentHeartbeatPayload({
        status: 'online',
        observedAt: '2026-08-03T12:00:00Z',
        protocolVersion: 1,
        softwareVersion: '0.1.0',
        capabilities: ['heartbeat'],
      }).success,
      true,
    );
    assert.equal(
      validateAgentHeartbeatPayload({ status: 'online', capabilities: ['process.control'] }).success,
      false,
    );
  });
});

describe('ModCatalogEntry', () => {
  it('accepts reviewed provenance and allows stable publication', () => {
    const result = validateModCatalogEntry(validCatalogEntry());
    assert.equal(result.success, true);
    assert.ok(result.success && canPublishInStable(result.value));
  });

  it('keeps unknown-side entries out of stable', () => {
    const result = validateModCatalogEntry({ ...validCatalogEntry(), side: 'unknown' });
    assert.equal(result.success, true);
    assert.ok(result.success && !canPublishInStable(result.value));
  });

  it('rejects allowed distribution without review evidence', () => {
    const entry = validCatalogEntry();
    entry.distribution = { decision: 'allowed' };
    assert.equal(validateModCatalogEntry(entry).success, false);
  });
});

describe('InventorySnapshot', () => {
  it('accepts a canonical sanitized launcher inventory', () => {
    assert.equal(validateInventorySnapshot(validInventorySnapshot()).success, true);
  });

  it('rejects non-canonical paths and source scope mismatches', () => {
    const unordered = validInventorySnapshot();
    unordered.entries = [
      {
        path: 'mods/z.jar',
        filename: 'z.jar',
        kind: 'mod',
        state: 'active',
        sizeBytes: 1,
        sha256: hashA,
      },
      {
        path: 'mods/A.jar',
        filename: 'A.jar',
        kind: 'mod',
        state: 'active',
        sizeBytes: 1,
        sha256: hashB,
      },
    ];
    assert.equal(validateInventorySnapshot(unordered).success, false);

    const wrongScope = validInventorySnapshot();
    wrongScope.source = {
      sourceId: 'voidfall-server',
      scope: 'client',
      type: 'server-export',
    };
    assert.equal(validateInventorySnapshot(wrongScope).success, false);
  });
});

describe('ModCompatibility', () => {
  it('accepts contextual occurrences and side-aware dependencies', () => {
    assert.equal(validateModCompatibilityAnalysisPlan(validCompatibilityPlan()).success, true);
  });

  it('rejects duplicate occurrences and incorrect JarJar classification', () => {
    const duplicate = validCompatibilityPlan();
    const components = duplicate.components as Array<Record<string, unknown>>;
    const occurrences = components[0]?.occurrences as Array<Record<string, unknown>>;
    occurrences.push({ ...occurrences[0] });
    assert.equal(validateModCompatibilityAnalysisPlan(duplicate).success, false);

    const wrongContainer = validCompatibilityPlan();
    const wrongComponents = wrongContainer.components as Array<Record<string, unknown>>;
    const wrongOccurrences = wrongComponents[0]?.occurrences as Array<Record<string, unknown>>;
    wrongOccurrences[0] = {
      ...wrongOccurrences[0],
      container: { kind: 'jarjar', parentArtifactId: 'fixture:parent' },
    };
    assert.equal(validateModCompatibilityAnalysisPlan(wrongContainer).success, false);
  });

  it('rejects stale compatibility report totals', () => {
    const plan = validCompatibilityPlan();
    const report = {
      schemaVersion: 1,
      analysisId: plan.analysisId,
      generatedAt: plan.generatedAt,
      contexts: plan.contexts,
      components: [
        {
          componentId: 'example-mod',
          kind: 'root-mod',
          status: 'compatible',
          contexts: [
            {
              contextId: 'launcher-current',
              status: 'compatible',
              versions: ['1.0.0'],
              loaders: ['forge'],
            },
            {
              contextId: 'server-active',
              status: 'not-present',
              versions: [],
              loaders: [],
            },
          ],
        },
      ],
      findings: [],
      summary: {
        compatibleComponents: 0,
        incompatibleComponents: 0,
        unknownComponents: 0,
        blockerCount: 0,
        warningCount: 0,
        informationCount: 0,
      },
    };
    assert.equal(validateModCompatibilityReport(report).success, false);
  });
});

describe('CatalogReconciliationReport', () => {
  it('accepts a canonical report whose summary matches its artifacts', () => {
    assert.equal(validateCatalogReconciliationReport(validReconciliationReport()).success, true);
  });

  it('rejects artifact IDs not derived from their hash and stale summaries', () => {
    const report = validReconciliationReport();
    const artifacts = report.artifacts as Array<Record<string, unknown>>;
    artifacts[0] = { ...artifacts[0], artifactId: `sha256:${hashB}` };
    assert.equal(validateCatalogReconciliationReport(report).success, false);

    const staleSummary = validReconciliationReport();
    staleSummary.summary = {
      totalArtifacts: 2,
      catalogedArtifacts: 1,
      untrackedArtifacts: 1,
      ambiguousArtifacts: 0,
      blockedArtifacts: 0,
      unblockedArtifacts: 2,
    };
    assert.equal(validateCatalogReconciliationReport(staleSummary).success, false);
  });
});

describe('ReleaseManifest', () => {
  it('accepts a canonical VoidFall manifest', () => {
    assert.equal(validateReleaseManifest(validManifest()).success, true);
  });

  it('rejects a different product identity', () => {
    const manifest = validManifest();
    manifest.product = { id: 'another-pack', displayName: 'Another Pack' };
    assert.equal(validateReleaseManifest(manifest).success, false);
  });

  it('rejects traversal and duplicate cross-platform paths', () => {
    const traversal = validManifest();
    const traversalFiles = traversal.files as Array<Record<string, unknown>>;
    traversalFiles[0] = { ...traversalFiles[0], path: '../server.properties' };
    assert.equal(validateReleaseManifest(traversal).success, false);

    const duplicate = validManifest();
    const duplicateFiles = duplicate.files as Array<Record<string, unknown>>;
    duplicateFiles[1] = { ...duplicateFiles[1], path: 'CONFIG/EXAMPLE.TOML' };
    assert.equal(validateReleaseManifest(duplicate).success, false);
  });
});

describe('LauncherChannel', () => {
  it('accepts a signed first promotion and a contiguous rollback', () => {
    const first = {
      schemaVersion: 1,
      product: { id: 'voidfall', displayName: 'VoidFall' },
      channel: 'stable',
      revision: 1,
      operation: 'promotion',
      releaseVersion: '1.0.0',
      buildId: 'build-20260803-120000',
      manifestSha256: hashA,
      manifestUrl:
        'https://updates.voidfall.invalid/launcher/v1/releases/1.0.0/build-20260803-120000/manifest',
      publishedAt: '2026-08-03T12:00:00Z',
      signature: { algorithm: 'Ed25519', keyId: 'release-2026-01', value: signature },
    };
    assert.equal(validateLauncherChannel(first).success, true);
    assert.equal(
      validateLauncherChannel({
        ...first,
        revision: 2,
        operation: 'rollback',
        previous: { revision: 1, releaseVersion: '1.0.0', buildId: 'build-20260803-120000' },
      }).success,
      true,
    );
  });

  it('rejects insecure URLs and gaps in channel history', () => {
    const invalid = {
      schemaVersion: 1,
      product: { id: 'voidfall', displayName: 'VoidFall' },
      channel: 'stable',
      revision: 3,
      operation: 'promotion',
      releaseVersion: '1.0.0',
      buildId: 'build-20260803-120000',
      manifestSha256: hashA,
      manifestUrl: 'http://updates.example.test/manifest',
      publishedAt: '2026-08-03T12:00:00Z',
      previous: { revision: 1, releaseVersion: '0.9.0', buildId: 'build-20260802-120000' },
      signature: { algorithm: 'Ed25519', keyId: 'release-2026-01', value: signature },
    };
    assert.equal(validateLauncherChannel(invalid).success, false);
  });
});

describe('LauncherManagedState', () => {
  it('accepts sorted managed files and rejects cross-platform duplicates', () => {
    const state = {
      schemaVersion: 1,
      product: { id: 'voidfall', displayName: 'VoidFall' },
      channel: 'stable',
      channelRevision: 1,
      releaseVersion: '1.0.0',
      buildId: 'build-20260803-120000',
      installedAt: '2026-08-03T12:00:00Z',
      files: [
        { path: 'config/example.json', sha256: hashA },
        { path: 'mods/example.jar', sha256: hashB },
      ],
    };
    assert.equal(validateLauncherManagedState(state).success, true);
    assert.equal(
      validateLauncherManagedState({
        ...state,
        files: [
          { path: 'mods/example.jar', sha256: hashA },
          { path: 'MODS/EXAMPLE.JAR', sha256: hashB },
        ],
      }).success,
      false,
    );
  });
});

describe('ForgeBuildRequest', () => {
  it('accepts a short-lived signed intent and rejects an excessive lifetime', () => {
    const request = {
      schemaVersion: 1,
      protocolVersion: 1,
      kind: 'modpack.build.request',
      requestId: uuid,
      correlationId: otherUuid,
      playerUuid: uuid,
      serverInstanceId: otherUuid,
      permission: 'modpack.build.request',
      nonce: 'n'.repeat(43),
      issuedAt: '2026-08-03T12:00:00Z',
      expiresAt: '2026-08-03T12:01:00Z',
      signature: { algorithm: 'Ed25519', keyId: 'forge-bridge-01', value: signature },
    };
    assert.equal(validateForgeBuildRequest(request).success, true);
    assert.equal(
      validateForgeBuildRequest({ ...request, expiresAt: '2026-08-03T12:03:00Z' }).success,
      false,
    );
  });
});

describe('AuditEvent', () => {
  it('accepts sanitized audit data', () => {
    const event = {
      schemaVersion: 1,
      id: uuid,
      occurredAt: '2026-08-03T12:00:00Z',
      correlationId: otherUuid,
      actor: { type: 'panel-user', id: otherUuid },
      source: 'api',
      action: 'modpack.build.requested',
      resource: { type: 'build', id: 'build-20260803-120000' },
      outcome: 'succeeded',
      after: { requestedVersion: '0.1.0' },
    };
    assert.equal(validateAuditEvent(event).success, true);
  });

  it('rejects secret-bearing keys at any depth', () => {
    const event = {
      schemaVersion: 1,
      id: uuid,
      occurredAt: '2026-08-03T12:00:00Z',
      correlationId: otherUuid,
      actor: { type: 'panel-user', id: otherUuid },
      source: 'api',
      action: 'agent.config.changed',
      resource: { type: 'agent', id: uuid },
      outcome: 'succeeded',
      after: { nested: { accessToken: '[REDACTED]' } },
    };
    assert.equal(validateAuditEvent(event).success, false);
  });
});

describe('PlayerProfile', () => {
  const validProfile = () => ({
    schemaVersion: 1,
    playerUuid: uuid,
    revision: 2,
    status: 'active',
    createdAt: '2026-08-03T12:00:00Z',
    updatedAt: '2026-08-03T12:05:00Z',
    aliases: [
      {
        name: 'Void_Player',
        normalizedName: 'void_player',
        source: 'forge-bridge',
        serverInstanceId: otherUuid,
        firstObservedAt: '2026-08-03T12:00:00Z',
        lastObservedAt: '2026-08-03T12:05:00Z',
        observationCount: 2,
      },
    ],
  });

  it('accepts a UUID profile with canonical observed aliases', () => {
    assert.equal(validatePlayerProfile(validProfile()).success, true);
  });

  it('rejects aliases that collide after case normalization', () => {
    const profile = validProfile();
    const originalAlias = profile.aliases[0];
    assert.ok(originalAlias);
    profile.aliases.push({
      ...originalAlias,
      name: 'VOID_PLAYER',
    });
    assert.equal(validatePlayerProfile(profile).success, false);
  });
});

describe('MinecraftPermissionBinding', () => {
  const validBinding = () => ({
    schemaVersion: 1,
    bindingId: uuid,
    playerUuid: uuid,
    serverInstanceId: otherUuid,
    revision: 1,
    status: 'pending',
    groups: ['moderator', 'player'],
    requestedBy: { type: 'panel-user', id: otherUuid },
    reason: 'Approved moderation assignment.',
    requestedAt: '2026-08-03T12:00:00Z',
    updatedAt: '2026-08-03T12:00:00Z',
  });

  it('keeps Minecraft groups separate and requires the baseline player group', () => {
    assert.equal(validateMinecraftPermissionBinding(validBinding()).success, true);
    assert.equal(
      validateMinecraftPermissionBinding({ ...validBinding(), groups: ['moderator'] }).success,
      false,
    );
  });

  it('requires synchronization evidence to match the resulting state', () => {
    assert.equal(
      validateMinecraftPermissionBinding({ ...validBinding(), status: 'synchronized' }).success,
      false,
    );
    assert.equal(
      validateMinecraftPermissionBinding({
        ...validBinding(),
        status: 'synchronized',
        updatedAt: '2026-08-03T12:01:00Z',
        synchronization: {
          providerId: 'fixture-provider',
          outcome: 'succeeded',
          attemptedAt: '2026-08-03T12:01:00Z',
          receiptId: 'fixture-receipt-1',
        },
      }).success,
      true,
    );
  });
});

describe('ModerationCase', () => {
  const validCase = () => ({
    schemaVersion: 1,
    caseId: uuid,
    playerUuid: uuid,
    serverInstanceId: otherUuid,
    revision: 1,
    action: 'temporary-ban',
    status: 'requested',
    reasonCode: 'abuse-review',
    reason: 'Reviewed fixture reason.',
    requestedBy: { type: 'panel-user', id: otherUuid },
    requestedAt: '2026-08-03T12:00:00Z',
    expiresAt: '2026-08-04T12:00:00Z',
    updatedAt: '2026-08-03T12:00:00Z',
  });

  it('accepts a typed temporary action with an explicit expiry', () => {
    assert.equal(validateModerationCase(validCase()).success, true);
  });

  it('rejects missing expiry and fabricated completion without executor evidence', () => {
    const noExpiry = validCase();
    delete (noExpiry as Partial<typeof noExpiry>).expiresAt;
    assert.equal(validateModerationCase(noExpiry).success, false);
    assert.equal(validateModerationCase({ ...validCase(), status: 'applied' }).success, false);
  });
});

describe('PlayerDataPolicy', () => {
  const validPolicy = () => ({
    schemaVersion: 1,
    policyId: 'player-safety',
    revision: 1,
    status: 'approved',
    purposeCode: 'moderation-safety',
    purpose: 'Support proportionate moderation review.',
    createdAt: '2026-08-03T12:00:00Z',
    updatedAt: '2026-08-03T12:05:00Z',
    approvedBy: { type: 'panel-user', id: otherUuid },
    approvedAt: '2026-08-03T12:03:00Z',
    effectiveAt: '2026-08-03T12:04:00Z',
    rules: [
      {
        category: 'activity',
        collection: 'allowed',
        maximumRetentionSeconds: 86_400,
        viewPermission: 'player.activity.sensitive',
        export: 'disabled',
      },
      {
        category: 'chat',
        collection: 'disabled',
        viewPermission: 'player.activity.sensitive',
        export: 'disabled',
      },
      {
        category: 'coordinates',
        collection: 'disabled',
        viewPermission: 'player.activity.sensitive',
        export: 'disabled',
      },
    ],
  });

  it('accepts an approved policy with all categories and bounded retention', () => {
    assert.equal(validatePlayerDataPolicy(validPolicy()).success, true);
  });

  it('rejects exports for a category whose collection is disabled', () => {
    const policy = validPolicy();
    const chatRule = policy.rules[1];
    assert.ok(chatRule);
    policy.rules[1] = { ...chatRule, export: 'allowed' };
    assert.equal(validatePlayerDataPolicy(policy).success, false);
  });
});

describe('AuditChainExportManifest', () => {
  const validExport = () => ({
    schemaVersion: 1,
    exportId: uuid,
    algorithm: 'sha256-chain-v1',
    partitionId: 'administrative',
    generatedAt: '2026-08-03T12:05:00Z',
    firstSequence: 2,
    lastSequence: 4,
    recordCount: 3,
    previousHash: hashA,
    finalHash: hashB,
    contentSha256: hashA,
    mediaType: 'application/x-ndjson',
    encoding: 'utf-8',
  });

  it('accepts a contiguous export range and rejects a stale count', () => {
    assert.equal(validateAuditChainExportManifest(validExport()).success, true);
    assert.equal(
      validateAuditChainExportManifest({ ...validExport(), recordCount: 2 }).success,
      false,
    );
  });
});
