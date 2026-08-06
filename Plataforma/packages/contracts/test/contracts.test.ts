import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canPublishInStable,
  validateAgentEnvelope,
  validateClaimEvidence,
  validateClaimInvalidation,
  validateSignedClaimEvidence,
  validatePermissionOperation,
  validatePermissionOperationReceipt,
  validatePermissionRebindOperation,
  validatePermissionSnapshot,
  validateArtifactCompatibilityPlan,
  validateArtifactCompatibilityReport,
  validateArtifactInspectionReport,
  validateOutboxEvent,
  validateServerOperation,
  validateServerOperationPage,
  validateServerProcessState,
  isAllowedOperationTransition,
  isOperationInFlight,
  validateArtifactSubmission,
  validateArtifactSubmissionDetail,
  validateArtifactSubmissionPage,
  isAllowedSubmissionTransition,
  validateAgentHeartbeatPayload,
  validateAuditChainExportManifest,
  validateAuditEvent,
  validateAuthorizedFileDiffRequest,
  validateCopyAuthorizedFileRequest,
  validateCreateAuthorizedFileRequest,
  validateDeleteAuthorizedFileRequest,
  validateMoveAuthorizedFileRequest,
  validateCatalogReconciliationReport,
  validateConfigurationApplyRequest,
  validateConfigurationOperationCommand,
  validateConfigurationOperationResult,
  validateConfigurationResourceState,
  validateConfigurationRevisionPage,
  validateConfigurationSchemaCatalog,
  validateConfigurationValidationRequest,
  validateConfigurationValidationResult,
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
    identityId: uuid,
    serverInstanceId: otherUuid,
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
    subjectIdentityId: uuid,
    incidentContext: {
      claimId: otherUuid,
      minecraftUuid: uuid,
      minecraftName: 'Void_Player',
    },
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

describe('ServerConfiguration boundary contracts', () => {
  const validCatalog = () => ({
    schemaVersion: 1,
    serverInstanceId: uuid,
    generatedAt: '2026-08-04T12:00:00Z',
    schemas: [
      {
        schemaId: 'openloader-advanced-options',
        resourceId: 'openloader-advanced-options',
        definitionVersion: '1.0.0',
        definitionSha256: hashA,
        codecId: 'openloader-advanced-options-v1',
        applyMode: 'offline-only',
        maximumBytes: 4_096,
        restartRequired: true,
        registered: true,
        fields: [
          { name: 'dataPacks.enabled', type: 'boolean', restartRequired: true, readable: true },
          { name: 'resourcePacks.enabled', type: 'boolean', restartRequired: true, readable: true },
        ],
      },
    ],
  });

  it('accepts a reviewed catalog and rejects an unreviewed codec or a public path', () => {
    assert.equal(validateConfigurationSchemaCatalog(validCatalog()).success, true);

    const unreviewed = validCatalog();
    unreviewed.schemas[0] = { ...unreviewed.schemas[0], codecId: 'generic-json-v1' } as never;
    assert.equal(validateConfigurationSchemaCatalog(unreviewed).success, false);

    const withPath = validCatalog();
    withPath.schemas[0] = {
      ...withPath.schemas[0],
      filePath: 'config/openloader/advanced_options.json',
    } as never;
    assert.equal(validateConfigurationSchemaCatalog(withPath).success, false);
  });

  it('requires restartRequired to summarize the declared fields', () => {
    const catalog = validCatalog();
    catalog.schemas[0] = { ...catalog.schemas[0], restartRequired: false } as never;
    assert.equal(validateConfigurationSchemaCatalog(catalog).success, false);
  });

  const validState = () => ({
    schemaVersion: 1,
    serverInstanceId: uuid,
    resourceId: 'openloader-advanced-options',
    schemaId: 'openloader-advanced-options',
    definitionVersion: '1.0.0',
    definitionSha256: hashA,
    status: 'applied',
    currentSha256: hashB,
    stateVersion: 3,
    updatedAt: '2026-08-04T12:00:00Z',
    pendingRevisionId: null,
    lastAppliedRevisionId: 'cfg-0002',
    lastFailedRevisionId: null,
    restartRequired: true,
    valuesAvailable: true,
    values: [
      { name: 'dataPacks.enabled', redacted: false, value: true },
      { name: 'resourcePacks.enabled', redacted: true },
    ],
  });

  it('never lets a redacted field carry a value', () => {
    assert.equal(validateConfigurationResourceState(validState()).success, true);
    const leaking = validState();
    leaking.values[1] = { name: 'resourcePacks.enabled', redacted: true, value: false } as never;
    assert.equal(validateConfigurationResourceState(leaking).success, false);
  });

  it('keeps values empty when no authorized reader is available', () => {
    const state = { ...validState(), valuesAvailable: false };
    assert.equal(validateConfigurationResourceState(state).success, false);
    assert.equal(validateConfigurationResourceState({ ...state, values: [] }).success, true);
  });

  it('binds a pending revision to the prepared status', () => {
    const state = { ...validState(), status: 'prepared' };
    assert.equal(validateConfigurationResourceState(state).success, false);
    assert.equal(
      validateConfigurationResourceState({ ...state, pendingRevisionId: 'cfg-0003' }).success,
      true,
    );
  });

  const validRevision = () => ({
    revisionId: 'cfg-0002',
    operation: 'update',
    status: 'applied',
    sourceRevisionId: null,
    expectedCurrentSha256: hashA,
    previousSha256: hashA,
    currentSha256: hashB,
    requestedFields: ['dataPacks.enabled'],
    changedFields: ['dataPacks.enabled'],
    restartRequired: true,
    actor: { type: 'panel-user', id: uuid },
    reasonCode: 'operator-request',
    correlationId: otherUuid,
    failureCode: null,
    rollbackEligible: true,
    createdAt: '2026-08-04T12:00:00Z',
    completedAt: '2026-08-04T12:00:05Z',
  });

  const pageWith = (revision: Record<string, unknown>) => ({
    schemaVersion: 1,
    serverInstanceId: uuid,
    resourceId: 'openloader-advanced-options',
    revisions: [revision],
  });

  it('accepts an applied revision page and rejects rollback eligibility for a failure', () => {
    assert.equal(validateConfigurationRevisionPage(pageWith(validRevision())).success, true);

    const failed = {
      ...validRevision(),
      status: 'failed',
      currentSha256: null,
      changedFields: null,
      restartRequired: null,
      failureCode: 'verification-failed',
    };
    assert.equal(validateConfigurationRevisionPage(pageWith(failed)).success, false);
    assert.equal(
      validateConfigurationRevisionPage(pageWith({ ...failed, rollbackEligible: false })).success,
      true,
    );
  });

  it('requires a rollback revision to name exactly one source', () => {
    const rollback = { ...validRevision(), revisionId: 'cfg-0003', operation: 'rollback' };
    assert.equal(validateConfigurationRevisionPage(pageWith(rollback)).success, false);
    assert.equal(
      validateConfigurationRevisionPage(pageWith({ ...rollback, sourceRevisionId: 'cfg-0002' }))
        .success,
      true,
    );
  });

  it('rejects a duplicated field in a validation or apply request', () => {
    const changes = [
      { name: 'dataPacks.enabled', value: true },
      { name: 'dataPacks.enabled', value: false },
    ];
    assert.equal(
      validateConfigurationValidationRequest({ schemaVersion: 1, changes }).success,
      false,
    );
    assert.equal(
      validateConfigurationApplyRequest({
        schemaVersion: 1,
        expectedCurrentSha256: hashA,
        expectedStateVersion: 2,
        idempotencyKey: 'configuration-apply-0001',
        reasonCode: 'operator-request',
        changes,
      }).success,
      false,
    );
  });

  it('refuses an apply request without an expected hash, version or idempotency key', () => {
    const base = {
      schemaVersion: 1,
      expectedCurrentSha256: hashA,
      expectedStateVersion: 2,
      idempotencyKey: 'configuration-apply-0001',
      reasonCode: 'operator-request',
      changes: [{ name: 'dataPacks.enabled', value: false }],
    };
    assert.equal(validateConfigurationApplyRequest(base).success, true);
    for (const omitted of [
      'expectedCurrentSha256',
      'expectedStateVersion',
      'idempotencyKey',
    ] as const) {
      const incomplete: Record<string, unknown> = { ...base };
      delete incomplete[omitted];
      assert.equal(validateConfigurationApplyRequest(incomplete).success, false);
    }
    assert.equal(
      validateConfigurationApplyRequest({
        ...base,
        changes: [{ name: 'dataPacks.enabled', value: { nested: true } }],
      }).success,
      false,
    );
  });

  it('states explicitly that a validation result never applies', () => {
    const result = {
      schemaVersion: 1,
      resourceId: 'openloader-advanced-options',
      applied: false,
      valid: true,
      issues: [],
      restartRequired: true,
      changedFields: ['dataPacks.enabled'],
    };
    assert.equal(validateConfigurationValidationResult(result).success, true);
    assert.equal(validateConfigurationValidationResult({ ...result, applied: true }).success, false);
    assert.equal(
      validateConfigurationValidationResult({
        ...result,
        valid: false,
        issues: [{ field: 'dataPacks.enabled', code: 'invalid-type' }],
      }).success,
      false,
    );
  });

  const validCommand = () => ({
    schemaVersion: 1,
    operation: 'update',
    serverInstanceId: uuid,
    resourceId: 'openloader-advanced-options',
    revisionId: 'cfg-0003',
    sourceRevisionId: null,
    expectedCurrentSha256: hashA,
    expectedStateVersion: 2,
    reasonCode: 'operator-request',
    correlationId: otherUuid,
    actor: { type: 'panel-user', id: uuid },
    changes: [{ name: 'dataPacks.enabled', value: false }],
  });

  it('never carries a root, path or command string to the agent', () => {
    assert.equal(validateConfigurationOperationCommand(validCommand()).success, true);
    for (const injected of ['configurationRoot', 'filePath', 'command', 'schema'] as const) {
      assert.equal(
        validateConfigurationOperationCommand({ ...validCommand(), [injected]: 'x' }).success,
        false,
      );
    }
  });

  it('separates update and rollback commands exactly', () => {
    assert.equal(
      validateConfigurationOperationCommand({ ...validCommand(), sourceRevisionId: 'cfg-0002' })
        .success,
      false,
    );
    const rollback = {
      ...validCommand(),
      operation: 'rollback',
      sourceRevisionId: 'cfg-0002',
      changes: [] as { readonly name: string; readonly value: boolean }[],
    };
    assert.equal(validateConfigurationOperationCommand(rollback).success, true);
    assert.equal(
      validateConfigurationOperationCommand({
        ...rollback,
        changes: [{ name: 'dataPacks.enabled', value: true }],
      }).success,
      false,
    );
    assert.equal(
      validateConfigurationOperationCommand({ ...rollback, sourceRevisionId: rollback.revisionId })
        .success,
      false,
    );
  });

  it('reports a sanitized agent result without values or stages', () => {
    const applied = {
      schemaVersion: 1,
      revisionId: 'cfg-0003',
      resourceId: 'openloader-advanced-options',
      operation: 'update',
      outcome: 'applied',
      previousSha256: hashA,
      currentSha256: hashB,
      changedFields: ['dataPacks.enabled'],
      restartRequired: true,
      failureCode: null,
      completedAt: '2026-08-04T12:00:05Z',
    };
    assert.equal(validateConfigurationOperationResult(applied).success, true);
    assert.equal(
      validateConfigurationOperationResult({ ...applied, failureCode: 'verification-failed' })
        .success,
      false,
    );
    const failed = {
      ...applied,
      outcome: 'failed',
      previousSha256: null,
      currentSha256: null,
      changedFields: [] as string[],
      restartRequired: false,
      failureCode: 'verification-failed',
    };
    assert.equal(validateConfigurationOperationResult(failed).success, true);
    assert.equal(
      validateConfigurationOperationResult({ ...failed, changedFields: ['dataPacks.enabled'] })
        .success,
      false,
    );
  });

  it('accepts the two durable configuration job types', () => {
    for (const type of ['configuration.apply', 'configuration.rollback'] as const) {
      assert.equal(validateJob({ ...validJob(), type }).success, true);
    }
    assert.equal(validateJob({ ...validJob(), type: 'configuration.write' }).success, false);
  });
});

describe('ArtifactInspectionReport', () => {
  const validReport = () => ({
    format: 'voidfall-artifact-inspection',
    schemaVersion: 1,
    sha256: hashA,
    sizeBytes: 4_096,
    inspectedAt: '2026-08-04T12:00:00Z',
    container: 'zip',
    entryCount: 12,
    expandedBytes: 900,
    loaders: ['forge'],
    mods: [
      {
        modId: 'voidfall_probe',
        displayName: 'VoidFall Probe',
        version: '${file.jarVersion}',
        loader: 'forge',
        dependencies: [
          {
            target: 'forge',
            mandatory: true,
            versionRange: '[47,)',
            side: 'BOTH',
            evidence: 'META-INF/mods.toml',
          },
        ],
        evidence: 'META-INF/mods.toml',
      },
    ],
    embeddedLibraries: [],
    evidence: ['META-INF/mods.toml'],
    metadataIssues: [],
    features: {
      containsClasses: true,
      containsData: false,
      containsAssets: false,
      containsMixins: false,
      containsNestedJars: false,
    },
  });

  it('accepts a declared report and preserves an unresolved version verbatim', () => {
    const report = validReport();
    assert.equal(validateArtifactInspectionReport(report).success, true);
    const declared = report.mods[0];
    assert.ok(declared);
    assert.equal(declared.version, '${file.jarVersion}');
  });

  it('refuses a path, absolute location or raw bytes anywhere in the report', () => {
    for (const injected of ['filePath', 'absolutePath', 'content', 'payload']) {
      assert.equal(
        validateArtifactInspectionReport({ ...validReport(), [injected]: 'x' }).success,
        false,
      );
    }
    // Evidence is a closed set, so an arbitrary entry name cannot be reported.
    assert.equal(
      validateArtifactInspectionReport({ ...validReport(), evidence: ['config/secret.toml'] }).success,
      false,
    );
  });

  it('requires every mod loader and evidence to be declared by the report', () => {
    const reportWith = (overrides: Record<string, unknown>) => {
      const report = validReport();
      const declared = report.mods[0];
      assert.ok(declared);
      return { ...report, mods: [{ ...declared, ...overrides }] };
    };

    assert.equal(validateArtifactInspectionReport(reportWith({ loader: 'fabric' })).success, false);
    assert.equal(
      validateArtifactInspectionReport(reportWith({ evidence: 'fabric.mod.json' })).success,
      false,
    );
  });

  it('treats unknown as the absence of a declaration', () => {
    const unknown = { ...validReport(), loaders: ['unknown'], mods: [], evidence: [] };
    assert.equal(validateArtifactInspectionReport(unknown).success, true);
    assert.equal(
      validateArtifactInspectionReport({ ...unknown, loaders: ['unknown', 'forge'] }).success,
      false,
    );
    assert.equal(
      validateArtifactInspectionReport({ ...validReport(), loaders: ['unknown'] }).success,
      false,
    );
  });

  it('rejects an implausible expansion for the archive size', () => {
    assert.equal(
      validateArtifactInspectionReport({ ...validReport(), sizeBytes: 10, expandedBytes: 1_000_000 }).success,
      false,
    );
  });
});

describe('ArtifactCompatibilityPlan', () => {
  const inspection = () => ({
    format: 'voidfall-artifact-inspection',
    schemaVersion: 1,
    sha256: hashA,
    sizeBytes: 4_096,
    inspectedAt: '2026-08-05T12:00:00Z',
    container: 'zip',
    entryCount: 12,
    expandedBytes: 900,
    loaders: ['forge'],
    mods: [
      {
        modId: 'voidfall_probe',
        displayName: 'VoidFall Probe',
        version: '1.0.0',
        loader: 'forge',
        dependencies: [
          {
            target: 'minecraft',
            mandatory: true,
            versionRange: '[1.20.1]',
            side: 'BOTH',
            evidence: 'META-INF/mods.toml',
          },
        ],
        evidence: 'META-INF/mods.toml',
      },
    ],
    embeddedLibraries: [],
    evidence: ['META-INF/mods.toml'],
    metadataIssues: [],
    features: {
      containsClasses: true,
      containsData: false,
      containsAssets: false,
      containsMixins: false,
      containsNestedJars: false,
    },
  });

  const validPlan = () => ({
    schemaVersion: 1,
    analysisId: 'phase-8-2-probe',
    generatedAt: '2026-08-05T12:00:00Z',
    contexts: [
      {
        contextId: 'server-active',
        kind: 'server_active',
        side: 'server',
        runtime: { minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '1.20.1-47.4.4' },
        javaVersion: '17',
      },
    ],
    candidates: [
      {
        artifactId: 'candidate-probe',
        filename: 'probe-1.0.0.jar',
        inspection: inspection(),
        reviewedSide: 'both',
        targetContextIds: ['server-active'],
        distributionReviewed: true,
      },
    ],
    installed: [],
    explicitConflicts: [],
  });

  it('accepts a reviewed plan', () => {
    assert.equal(validateArtifactCompatibilityPlan(validPlan()).success, true);
  });

  it('refuses a target context that cannot load mods', () => {
    const plan = validPlan();
    const context = plan.contexts[0];
    assert.ok(context);
    assert.equal(
      validateArtifactCompatibilityPlan({
        ...plan,
        contexts: [{ ...context, runtime: { ...context.runtime, loader: 'vanilla' } }],
      }).success,
      false,
    );
  });

  it('requires a context kind to agree with its side', () => {
    const plan = validPlan();
    const context = plan.contexts[0];
    assert.ok(context);
    assert.equal(
      validateArtifactCompatibilityPlan({
        ...plan,
        contexts: [{ ...context, kind: 'launcher_current' }],
      }).success,
      false,
    );
  });

  it('refuses an unknown target context and an artifact that is both candidate and installed', () => {
    const plan = validPlan();
    const candidate = plan.candidates[0];
    assert.ok(candidate);

    assert.equal(
      validateArtifactCompatibilityPlan({
        ...plan,
        candidates: [{ ...candidate, targetContextIds: ['launcher-current'] }],
      }).success,
      false,
    );
    assert.equal(
      validateArtifactCompatibilityPlan({
        ...plan,
        installed: [
          {
            artifactId: candidate.artifactId,
            filename: 'probe-1.0.0.jar',
            sha256: hashB,
            contextIds: ['server-active'],
            mods: [],
          },
        ],
      }).success,
      false,
    );
  });

  it('refuses a mod that conflicts with itself', () => {
    assert.equal(
      validateArtifactCompatibilityPlan({
        ...validPlan(),
        explicitConflicts: [{ modId: 'voidfall_probe', conflictsWith: 'voidfall_probe' }],
      }).success,
      false,
    );
  });

  it('requires a reviewed side to be stated, even as null', () => {
    const plan = validPlan();
    const candidate = plan.candidates[0];
    assert.ok(candidate);
    const { reviewedSide: _omitted, ...withoutSide } = candidate;
    assert.equal(
      validateArtifactCompatibilityPlan({ ...plan, candidates: [withoutSide] }).success,
      false,
    );
    assert.equal(
      validateArtifactCompatibilityPlan({
        ...plan,
        candidates: [{ ...candidate, reviewedSide: null }],
      }).success,
      true,
    );
  });
});

describe('ArtifactCompatibilityReport', () => {
  const validReport = () => ({
    schemaVersion: 1,
    analysisId: 'phase-8-2-probe',
    generatedAt: '2026-08-05T12:00:00Z',
    contexts: [
      {
        contextId: 'server-active',
        kind: 'server_active',
        side: 'server',
        runtime: { minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '1.20.1-47.4.4' },
        javaVersion: '17',
      },
    ],
    artifacts: [
      {
        artifactId: 'candidate-probe',
        filename: 'probe-1.0.0.jar',
        sha256: hashA,
        modIds: ['voidfall_probe'],
        status: 'incompatible',
        contexts: [{ contextId: 'server-active', status: 'incompatible' }],
      },
    ],
    relatedInstalled: [],
    issues: [
      {
        code: 'minecraft-version-mismatch',
        severity: 'blocker',
        determinacy: 'proven',
        reason: 'declared-mismatch',
        contextIds: ['server-active'],
        artifactIds: ['candidate-probe'],
        modIds: ['voidfall_probe'],
        evidence: ['META-INF/mods.toml'],
        detail: 'expected=1.20.1;declared=[1.19.2]',
        explanation: 'The mod declares a Minecraft range that excludes the target version.',
        recommendedAction: 'match-minecraft-version',
      },
    ],
    summary: {
      compatibleArtifacts: 0,
      incompatibleArtifacts: 1,
      unknownArtifacts: 0,
      blockerCount: 1,
      warningCount: 0,
      informationCount: 0,
    },
  });

  it('accepts a report whose totals match its content', () => {
    assert.equal(validateArtifactCompatibilityReport(validReport()).success, true);
  });

  it('refuses totals that contradict the report', () => {
    const report = validReport();
    assert.equal(
      validateArtifactCompatibilityReport({
        ...report,
        summary: { ...report.summary, blockerCount: 0 },
      }).success,
      false,
    );
    assert.equal(
      validateArtifactCompatibilityReport({
        ...report,
        summary: { ...report.summary, incompatibleArtifacts: 0, compatibleArtifacts: 1 },
      }).success,
      false,
    );
  });

  it('requires every identifier an issue cites to be declared by the report', () => {
    const report = validReport();
    const issue = report.issues[0];
    assert.ok(issue);

    for (const override of [
      { artifactIds: ['unlisted-artifact'] },
      { contextIds: ['launcher-current'] },
      { modIds: ['undeclared_mod'] },
    ]) {
      assert.equal(
        validateArtifactCompatibilityReport({ ...report, issues: [{ ...issue, ...override }] }).success,
        false,
      );
    }
  });

  it('refuses evidence outside the reviewed descriptors and a path in the detail', () => {
    const report = validReport();
    const issue = report.issues[0];
    assert.ok(issue);

    assert.equal(
      validateArtifactCompatibilityReport({
        ...report,
        issues: [{ ...issue, evidence: ['config/secret.toml'] }],
      }).success,
      false,
    );
    for (const detail of ['/etc/passwd', 'C:\\servidor\\mods', 'a"b']) {
      assert.equal(
        validateArtifactCompatibilityReport({ ...report, issues: [{ ...issue, detail }] }).success,
        false,
      );
    }
  });

  it('keeps unknown blocking: an unproven issue may not be downgraded', () => {
    const report = validReport();
    const issue = report.issues[0];
    assert.ok(issue);

    assert.equal(
      validateArtifactCompatibilityReport({
        ...report,
        artifacts: report.artifacts.map((artifact) => ({
          ...artifact,
          status: 'unknown',
          contexts: [{ contextId: 'server-active', status: 'unknown' }],
        })),
        issues: [{ ...issue, determinacy: 'unproven', reason: 'not-declared' }],
        summary: { ...report.summary, incompatibleArtifacts: 0, unknownArtifacts: 1 },
      }).success,
      true,
    );
    assert.equal(
      validateArtifactCompatibilityReport({
        ...report,
        issues: [{ ...issue, determinacy: 'unproven', reason: 'not-declared', severity: 'warning' }],
        summary: { ...report.summary, blockerCount: 0, warningCount: 1 },
      }).success,
      false,
    );
  });

  it('refuses an artifact evaluated twice for the same context', () => {
    const report = validReport();
    const artifact = report.artifacts[0];
    assert.ok(artifact);

    assert.equal(
      validateArtifactCompatibilityReport({
        ...report,
        artifacts: [
          {
            ...artifact,
            contexts: [
              { contextId: 'server-active', status: 'incompatible' },
              { contextId: 'server-active', status: 'compatible' },
            ],
          },
        ],
      }).success,
      false,
    );
  });
});

describe('ArtifactSubmission', () => {
  const analysis = (overrides: Record<string, unknown> = {}) => ({
    inspected: true,
    analyzed: true,
    loaders: ['forge'],
    modIds: ['voidfall_probe'],
    declaredVersions: ['1.0.0'],
    verdict: 'unknown',
    blockerCount: 1,
    warningCount: 0,
    informationCount: 0,
    provenBlockerCount: 0,
    ...overrides,
  });

  const emptyAnalysis = () =>
    analysis({
      inspected: false,
      analyzed: false,
      loaders: [],
      modIds: [],
      declaredVersions: [],
      verdict: null,
      blockerCount: 0,
    });

  const validSubmission = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    submissionId: uuid,
    filename: 'probe-1.0.0.jar',
    sha256: hashA,
    sizeBytes: 4_096,
    state: 'reviewable',
    submittedBy: { type: 'panel-user', id: otherUuid },
    reviewedSide: 'both',
    submittedAt: '2026-08-05T12:00:00Z',
    updatedAt: '2026-08-05T12:01:00Z',
    version: 3,
    analysis: analysis(),
    failure: null,
    decision: null,
    ...overrides,
  });

  const approval = (overrides: Record<string, unknown> = {}) => ({
    decision: 'approved',
    actor: { type: 'panel-user', id: otherUuid },
    reasonCode: 'reviewed',
    analyzedSha256: hashA,
    decidedAt: '2026-08-05T12:02:00Z',
    ...overrides,
  });

  it('accepts a reviewable submission awaiting a decision', () => {
    assert.equal(validateArtifactSubmission(validSubmission()).success, true);
  });

  it('refuses an analysis reported before it could have run', () => {
    for (const state of ['uploaded', 'quarantined']) {
      assert.equal(validateArtifactSubmission(validSubmission({ state })).success, false);
      assert.equal(
        validateArtifactSubmission(validSubmission({ state, analysis: emptyAnalysis() })).success,
        true,
      );
    }
    // Compatibility cannot run on an artifact that was never inspected.
    assert.equal(
      validateArtifactSubmission(
        validSubmission({ analysis: analysis({ inspected: false, loaders: [], modIds: [] }) }),
      ).success,
      false,
    );
  });

  it('keeps a proven blocker out of reviewable and approved', () => {
    assert.equal(
      validateArtifactSubmission(validSubmission({ analysis: analysis({ provenBlockerCount: 1 }) }))
        .success,
      false,
    );
    assert.equal(
      validateArtifactSubmission(
        validSubmission({
          state: 'approved',
          analysis: analysis({ provenBlockerCount: 1 }),
          decision: approval(),
        }),
      ).success,
      false,
    );
    assert.equal(
      validateArtifactSubmission(
        validSubmission({ analysis: analysis({ provenBlockerCount: 2, blockerCount: 1 }) }),
      ).success,
      false,
    );
  });

  it('requires blocked to be justified by a blocker or a failure', () => {
    assert.equal(validateArtifactSubmission(validSubmission({ state: 'blocked' })).success, false);
    assert.equal(
      validateArtifactSubmission(
        validSubmission({ state: 'blocked', analysis: analysis({ provenBlockerCount: 1 }) }),
      ).success,
      true,
    );
    assert.equal(
      validateArtifactSubmission(
        validSubmission({
          state: 'blocked',
          analysis: emptyAnalysis(),
          failure: { code: 'not-a-zip-container', stage: 'inspection' },
        }),
      ).success,
      true,
    );
  });

  it('binds a decision to its state and to the analyzed artifact', () => {
    const decided = (overrides: Record<string, unknown>) =>
      validateArtifactSubmission(
        validSubmission({ state: 'approved', decision: approval(overrides) }),
      ).success;

    assert.equal(decided({}), true);
    // A decision naming other bytes could be replayed onto another artifact.
    assert.equal(decided({ analyzedSha256: hashB }), false);
    assert.equal(decided({ decision: 'rejected' }), false);
    assert.equal(validateArtifactSubmission(validSubmission({ decision: approval() })).success, false);
    assert.equal(
      validateArtifactSubmission(validSubmission({ state: 'approved', decision: null })).success,
      false,
    );
  });

  it('allows only the reviewed transitions', () => {
    assert.equal(isAllowedSubmissionTransition('uploaded', 'quarantined'), true);
    assert.equal(isAllowedSubmissionTransition('quarantined', 'analyzing'), true);
    assert.equal(isAllowedSubmissionTransition('analyzing', 'reviewable'), true);
    assert.equal(isAllowedSubmissionTransition('reviewable', 'approved'), true);
    assert.equal(isAllowedSubmissionTransition('blocked', 'rejected'), true);
    // A blocked artifact is never silently admitted, and a decision is final.
    assert.equal(isAllowedSubmissionTransition('blocked', 'approved'), false);
    assert.equal(isAllowedSubmissionTransition('blocked', 'reviewable'), false);
    assert.equal(isAllowedSubmissionTransition('uploaded', 'approved'), false);
    assert.equal(isAllowedSubmissionTransition('approved', 'rejected'), false);
  });

  it('keeps a page consistent with its own bounds', () => {
    const page = (overrides: Record<string, unknown> = {}) => ({
      schemaVersion: 1,
      submissions: [validSubmission()],
      total: 1,
      limit: 50,
      offset: 0,
      ...overrides,
    });

    assert.equal(validateArtifactSubmissionPage(page()).success, true);
    assert.equal(validateArtifactSubmissionPage(page({ total: 0 })).success, false);
    assert.equal(
      validateArtifactSubmissionPage(page({ submissions: [validSubmission(), validSubmission()], total: 2 }))
        .success,
      false,
    );
    // A malformed submission cannot hide inside a well formed page.
    assert.equal(
      validateArtifactSubmissionPage(
        page({ submissions: [validSubmission({ state: 'approved', decision: null })] }),
      ).success,
      false,
    );
  });

  it('requires a detail to carry the reports it claims, about this artifact', () => {
    const inspection = {
      format: 'voidfall-artifact-inspection',
      schemaVersion: 1,
      sha256: hashA,
      sizeBytes: 4_096,
      inspectedAt: '2026-08-05T12:00:30Z',
      container: 'zip',
      entryCount: 12,
      expandedBytes: 900,
      loaders: ['forge'],
      mods: [],
      embeddedLibraries: [],
      evidence: [],
      metadataIssues: [],
      features: {
        containsClasses: true,
        containsData: false,
        containsAssets: false,
        containsMixins: false,
        containsNestedJars: false,
      },
    };
    const compatibility = {
      schemaVersion: 1,
      analysisId: 'submission-probe',
      generatedAt: '2026-08-05T12:00:40Z',
      contexts: [
        {
          contextId: 'server-active',
          kind: 'server_active',
          side: 'server',
          runtime: { minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '1.20.1-47.4.4' },
          javaVersion: '17',
        },
      ],
      artifacts: [
        {
          artifactId: 'submission-probe',
          filename: 'probe-1.0.0.jar',
          sha256: hashA,
          modIds: [],
          status: 'unknown',
          contexts: [{ contextId: 'server-active', status: 'unknown' }],
        },
      ],
      relatedInstalled: [],
      issues: [],
      summary: {
        compatibleArtifacts: 0,
        incompatibleArtifacts: 0,
        unknownArtifacts: 1,
        blockerCount: 0,
        warningCount: 0,
        informationCount: 0,
      },
    };
    const detail = (overrides: Record<string, unknown> = {}) => ({
      schemaVersion: 1,
      submission: validSubmission(),
      inspection,
      compatibility,
      ...overrides,
    });

    assert.equal(validateArtifactSubmissionDetail(detail()).success, true);
    // A claimed report may not be missing, and may not describe other bytes.
    assert.equal(validateArtifactSubmissionDetail(detail({ inspection: null })).success, false);
    assert.equal(validateArtifactSubmissionDetail(detail({ compatibility: null })).success, false);
    assert.equal(
      validateArtifactSubmissionDetail(detail({ inspection: { ...inspection, sha256: hashB } })).success,
      false,
    );
    assert.equal(
      validateArtifactSubmissionDetail(
        detail({
          compatibility: {
            ...compatibility,
            artifacts: compatibility.artifacts.map((artifact) => ({ ...artifact, sha256: hashB })),
          },
        }),
      ).success,
      false,
    );
  });
});

describe('ServerOperation', () => {
  const receipt = (overrides: Record<string, unknown> = {}) => ({
    outcome: 'succeeded',
    failureCode: null,
    observedLifecycle: 'online',
    observedPid: 4242,
    bootId: otherUuid,
    completedAt: '2026-08-05T12:05:00Z',
    ...overrides,
  });

  const validOperation = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    operationId: uuid,
    serverInstanceId: otherUuid,
    kind: 'server.start',
    status: 'accepted',
    idempotencyKey: 'operation-start-0001',
    requestFingerprint: hashA,
    correlationId: uuid,
    jobId: null,
    requestedBy: { type: 'panel-user', id: otherUuid },
    reasonCode: 'operator-request',
    consoleCommand: null,
    backupId: null,
    receipt: null,
    version: 1,
    acceptedAt: '2026-08-05T12:00:00Z',
    updatedAt: '2026-08-05T12:00:00Z',
    ...overrides,
  });

  const settled = (overrides: Record<string, unknown> = {}) =>
    validOperation({ status: 'succeeded', receipt: receipt(), updatedAt: '2026-08-05T12:05:00Z', ...overrides });

  it('accepts an operation still in flight and one that settled', () => {
    assert.equal(validateServerOperation(validOperation()).success, true);
    assert.equal(validateServerOperation(settled()).success, true);
  });

  it('ties the receipt to the status it belongs to', () => {
    // In flight means no receipt yet.
    assert.equal(validateServerOperation(validOperation({ receipt: receipt() })).success, false);
    // Settled means the receipt must exist and agree with the status.
    assert.equal(validateServerOperation(validOperation({ status: 'succeeded' })).success, false);
    assert.equal(validateServerOperation(settled({ status: 'failed' })).success, false);
    // A rejected operation never ran, so it produces nothing.
    assert.equal(
      validateServerOperation(validOperation({ status: 'rejected', receipt: receipt() })).success,
      false,
    );
  });

  it('requires a failure to be named and a success not to name one', () => {
    assert.equal(
      validateServerOperation(
        settled({ status: 'failed', receipt: receipt({ outcome: 'failed', failureCode: 'agent-refused' }) }),
      ).success,
      true,
    );
    assert.equal(
      validateServerOperation(
        settled({ status: 'failed', receipt: receipt({ outcome: 'failed', failureCode: null }) }),
      ).success,
      false,
    );
    assert.equal(
      validateServerOperation(settled({ receipt: receipt({ failureCode: 'timed-out' }) })).success,
      false,
    );
  });

  it('refuses a pid without the boot it belongs to', () => {
    assert.equal(
      validateServerOperation(settled({ receipt: receipt({ bootId: null }) })).success,
      false,
    );
  });

  it('refuses a receipt or an update that precedes the operation', () => {
    assert.equal(
      validateServerOperation(validOperation({ updatedAt: '2026-08-05T11:00:00Z' })).success,
      false,
    );
    assert.equal(
      validateServerOperation(settled({ receipt: receipt({ completedAt: '2026-08-05T11:00:00Z' }) }))
        .success,
      false,
    );
  });

  it('binds a backup identifier to a backup operation and to nothing else', () => {
    // A start naming a backup, or a backup naming none, would both be
    // meaningless — and the second would leave an agent with no target.
    assert.equal(validateServerOperation(validOperation({ backupId: 'backup-0001' })).success, false);
    assert.equal(
      validateServerOperation(validOperation({ kind: 'backup.create', backupId: null })).success,
      false,
    );
    assert.equal(
      validateServerOperation(validOperation({ kind: 'backup.create', backupId: 'backup-0001' }))
        .success,
      true,
    );
    assert.equal(
      validateServerOperation(validOperation({ kind: 'backup.restore', backupId: 'backup-0001' }))
        .success,
      true,
    );
  });

  it('binds a console command to a console operation and to nothing else', () => {
    // A start that carried a command, and a console operation that carried
    // none, are both meaningless.
    assert.equal(
      validateServerOperation(validOperation({ consoleCommand: 'save-all' })).success,
      false,
    );
    assert.equal(
      validateServerOperation(validOperation({ kind: 'server.command' })).success,
      false,
    );
    assert.equal(
      validateServerOperation(
        validOperation({ kind: 'server.command', consoleCommand: 'list-players' }),
      ).success,
      true,
    );
  });

  it('never reopens a settled operation', () => {
    assert.equal(isAllowedOperationTransition('accepted', 'running'), true);
    assert.equal(isAllowedOperationTransition('running', 'succeeded'), true);
    assert.equal(isAllowedOperationTransition('accepted', 'rejected'), true);
    for (const from of ['succeeded', 'failed', 'rejected'] as const) {
      for (const to of ['accepted', 'running', 'succeeded', 'failed', 'rejected'] as const) {
        assert.equal(isAllowedOperationTransition(from, to), false);
      }
    }
    assert.equal(isOperationInFlight('accepted'), true);
    assert.equal(isOperationInFlight('running'), true);
    assert.equal(isOperationInFlight('succeeded'), false);
  });

  it('never presents two in-flight operations for one server', () => {
    const page = (operations: readonly unknown[]) => ({
      schemaVersion: 1,
      operations: [...operations],
      total: operations.length,
      limit: 50,
      offset: 0,
    });

    assert.equal(validateServerOperationPage(page([validOperation()])).success, true);
    assert.equal(
      validateServerOperationPage(
        page([
          validOperation(),
          validOperation({ operationId: otherUuid, idempotencyKey: 'operation-start-0002' }),
        ]),
      ).success,
      false,
    );
    // Two settled operations for one server are perfectly ordinary.
    assert.equal(
      validateServerOperationPage(
        page([settled(), settled({ operationId: otherUuid, idempotencyKey: 'operation-start-0002' })]),
      ).success,
      true,
    );
  });
});

describe('ServerProcessState', () => {
  const validState = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    serverInstanceId: uuid,
    lifecycle: 'online',
    observedPid: 4242,
    bootId: otherUuid,
    observedBy: otherUuid,
    observedAt: '2026-08-05T12:00:00Z',
    stale: false,
    version: 1,
    ...overrides,
  });

  it('accepts a current observation and a reconciled unknown one', () => {
    assert.equal(validateServerProcessState(validState()).success, true);
    assert.equal(
      validateServerProcessState(
        validState({
          lifecycle: 'unknown',
          observedPid: null,
          bootId: null,
          observedBy: null,
          stale: true,
        }),
      ).success,
      true,
    );
  });

  it('refuses a pid that nothing can identify or that cannot be running', () => {
    assert.equal(validateServerProcessState(validState({ bootId: null })).success, false);
    assert.equal(validateServerProcessState(validState({ lifecycle: 'offline' })).success, false);
    assert.equal(validateServerProcessState(validState({ lifecycle: 'unknown' })).success, false);
  });

  it('treats a state nobody is observing as stale by definition', () => {
    const unobserved = (stale: boolean) =>
      validateServerProcessState(
        validState({
          observedBy: null,
          observedPid: null,
          bootId: null,
          lifecycle: 'offline',
          stale,
        }),
      ).success;

    assert.equal(unobserved(false), false);
    assert.equal(unobserved(true), true);
  });
});

describe('OutboxEvent', () => {
  const validEvent = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    eventId: uuid,
    topic: 'operation.completed',
    correlationId: otherUuid,
    resourceType: 'server-instance',
    resourceId: otherUuid,
    occurredAt: '2026-08-05T12:00:00Z',
    publishedAt: null,
    attempts: 0,
    payload: { status: 'succeeded', outcome: 'succeeded', failureCode: null },
    ...overrides,
  });

  it('accepts an unpublished and a published event', () => {
    assert.equal(validateOutboxEvent(validEvent()).success, true);
    assert.equal(
      validateOutboxEvent(validEvent({ publishedAt: '2026-08-05T12:00:01Z', attempts: 1 })).success,
      true,
    );
  });

  it('refuses a publication that precedes the event', () => {
    assert.equal(
      validateOutboxEvent(validEvent({ publishedAt: '2026-08-05T11:00:00Z' })).success,
      false,
    );
  });

  it('carries no payload beyond the reviewed status fields', () => {
    assert.equal(
      validateOutboxEvent(
        validEvent({ payload: { status: 'x', outcome: null, failureCode: null, path: '/srv' } }),
      ).success,
      false,
    );
    assert.equal(validateOutboxEvent(validEvent({ topic: 'anything.else' })).success, false);
  });
});

describe('authorized file operations', () => {
  const create = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    rootId: 'server-config',
    filePath: 'config/server.properties',
    reasonCode: 'operator-request',
    content: 'motd=VoidFall\n',
    ...overrides,
  });

  it('accepts a plain relative path inside a named root', () => {
    assert.equal(validateCreateAuthorizedFileRequest(create()).success, true);
  });

  it('refuses every way of naming somewhere else', () => {
    for (const filePath of [
      '../escape.properties',
      'config/../../escape.properties',
      '/etc/passwd',
      'C:/Windows/system.ini',
      'C:\\Windows\\system.ini',
      'config\\server.properties',
      '\\\\host\\share\\server.properties',
      // An NTFS alternate data stream: the colon is refused outright, so this
      // cannot be expressed even on a platform where it would be honoured.
      'config/server.properties:$DATA',
      'config//server.properties',
      'config/./server.properties',
    ]) {
      assert.equal(
        validateCreateAuthorizedFileRequest(create({ filePath })).success,
        false,
        `expected ${filePath} to be refused`,
      );
    }
  });

  it('refuses names that resolve to a different file than they read as', () => {
    // Windows strips a trailing dot, so this opens `server.properties`.
    assert.equal(
      validateCreateAuthorizedFileRequest(create({ filePath: 'config/server.properties.' })).success,
      false,
    );
    assert.equal(
      validateCreateAuthorizedFileRequest(create({ filePath: 'config/server.properties ' })).success,
      false,
    );
    assert.equal(validateCreateAuthorizedFileRequest(create({ filePath: 'con.properties' })).success, false);
    // Composed and decomposed forms would be two indistinguishable names.
    assert.equal(
      validateCreateAuthorizedFileRequest(create({ filePath: 'config/servic\u0327o.properties' })).success,
      false,
    );
  });

  it('refuses content carrying control characters', () => {
    assert.equal(validateCreateAuthorizedFileRequest(create({ content: 'a\u0000b' })).success, false);
    assert.equal(validateCreateAuthorizedFileRequest(create({ content: 'a\u001bb' })).success, false);
    // Tabs and newlines are ordinary in a configuration file.
    assert.equal(validateCreateAuthorizedFileRequest(create({ content: 'a\tb\nc\n' })).success, true);
  });

  it('refuses a move or copy onto its own source', () => {
    const move = {
      schemaVersion: 1,
      rootId: 'server-config',
      sourcePath: 'config/server.properties',
      destinationPath: 'config/server.properties',
      revisionId: 'revision-1',
      reasonCode: 'operator-request',
      expectedSha256: 'a'.repeat(64),
    };
    assert.equal(validateMoveAuthorizedFileRequest(move).success, false);
    assert.equal(
      validateMoveAuthorizedFileRequest({ ...move, destinationPath: 'backup/server.properties' })
        .success,
      true,
    );
    const { revisionId: _unused, ...copy } = move;
    assert.equal(validateCopyAuthorizedFileRequest(copy).success, false);
  });

  it('will not let a deletion be reached by omitting the acknowledgement', () => {
    const remove = {
      schemaVersion: 1,
      rootId: 'server-config',
      filePath: 'config/server.properties',
      revisionId: 'revision-1',
      reasonCode: 'operator-request',
      expectedSha256: 'a'.repeat(64),
      acknowledgesDataLoss: true,
    };
    assert.equal(validateDeleteAuthorizedFileRequest(remove).success, true);
    const { acknowledgesDataLoss: _dropped, ...withoutAcknowledgement } = remove;
    assert.equal(validateDeleteAuthorizedFileRequest(withoutAcknowledgement).success, false);
    assert.equal(
      validateDeleteAuthorizedFileRequest({ ...remove, acknowledgesDataLoss: false }).success,
      false,
    );
  });

  it('accepts a diff against a revision or against proposed text, and nothing else', () => {
    const base = { schemaVersion: 1, rootId: 'server-config', filePath: 'config/server.properties' };
    assert.equal(
      validateAuthorizedFileDiffRequest({ ...base, against: { type: 'revision', revisionId: 'r-1' } })
        .success,
      true,
    );
    assert.equal(
      validateAuthorizedFileDiffRequest({ ...base, against: { type: 'proposed', content: 'a=1\n' } })
        .success,
      true,
    );
    assert.equal(
      validateAuthorizedFileDiffRequest({ ...base, against: { type: 'path', path: '/etc/shadow' } })
        .success,
      false,
    );
  });
});

describe('typed permission operations', () => {
  const IDENTITY = '018f6b8c-76a3-7d10-9f2e-1d9e52a63711';
  const SERVER = '018f6b8c-76a3-7d10-9f2e-1d9e52a63712';
  const CLAIM = '018f6b8c-76a3-7d10-9f2e-1d9e52a63713';
  const OPERATION = '018f6b8c-76a3-7d10-9f2e-1d9e52a63714';
  const ISSUED = '2026-08-06T12:00:00.000Z';

  const envelope = {
    schemaVersion: 1,
    operationId: OPERATION,
    serverInstanceId: SERVER,
    identityId: IDENTITY,
    expectedClaimId: CLAIM,
    actor: { type: 'panel-user', id: '018f6b8c-76a3-7d10-9f2e-1d9e52a63715' },
    reason: 'promocao-para-moderador',
    issuedAt: ISSUED,
    expiresAt: '2026-08-06T12:01:00.000Z',
  } as const;

  it('accepts the four operations authorised to start, and nothing else', () => {
    assert.equal(
      validatePermissionOperation({ ...envelope, kind: 'USER_GROUP_ADD', group: 'moderator' })
        .success,
      true,
    );
    assert.equal(
      validatePermissionOperation({ ...envelope, kind: 'USER_GROUP_REMOVE', group: 'moderator' })
        .success,
      true,
    );
    assert.equal(
      validatePermissionOperation({
        ...envelope,
        kind: 'USER_NODE_SET',
        node: 'voidfall.build.request',
        value: false,
      }).success,
      true,
    );
    assert.equal(
      validatePermissionOperation({
        ...envelope,
        kind: 'USER_NODE_UNSET',
        node: 'voidfall.build.request',
      }).success,
      true,
    );
    // Kick is not one of the four. Widening the set is a decision, not a field.
    assert.equal(
      validatePermissionOperation({ ...envelope, kind: 'USER_KICK', group: 'moderator' }).success,
      false,
    );
  });

  it('refuses to carry a player name or a Minecraft UUID', () => {
    // The property the whole design rests on. An offline UUID is derived from
    // the name, so accepting either would let anyone operate on any identity by
    // choosing the right name.
    for (const extra of [
      { playerName: 'Notch' },
      { playerUuid: '018f6b8c-76a3-7d10-9f2e-1d9e52a63716' },
      { minecraftUuid: '018f6b8c-76a3-7d10-9f2e-1d9e52a63716' },
    ]) {
      assert.equal(
        validatePermissionOperation({
          ...envelope,
          kind: 'USER_GROUP_ADD',
          group: 'moderator',
          ...extra,
        }).success,
        false,
        JSON.stringify(extra),
      );
    }
  });

  it('refuses an operation whose window is missing or too long', () => {
    assert.equal(
      validatePermissionOperation({
        ...envelope,
        expiresAt: ISSUED,
        kind: 'USER_GROUP_ADD',
        group: 'moderator',
      }).success,
      false,
    );
    // Decided against a world that has since moved.
    assert.equal(
      validatePermissionOperation({
        ...envelope,
        expiresAt: '2026-08-06T13:00:00.000Z',
        kind: 'USER_GROUP_ADD',
        group: 'moderator',
      }).success,
      false,
    );
  });

  it('refuses a wildcard buried inside a node', () => {
    // A node matches by prefix, so a trailing wildcard has a blast radius a
    // reviewer can see. One in the middle does not.
    assert.equal(
      validatePermissionOperation({
        ...envelope,
        kind: 'USER_NODE_UNSET',
        node: 'voidfall.*',
      }).success,
      true,
    );
    assert.equal(
      validatePermissionOperation({
        ...envelope,
        kind: 'USER_NODE_UNSET',
        node: 'voidfall.*.request',
      }).success,
      false,
    );
  });

  it('requires a rebind to name a claim other than the active one', () => {
    const rebind = {
      ...envelope,
      kind: 'USER_REBIND',
      newClaimId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63717',
    };
    assert.equal(validatePermissionRebindOperation(rebind).success, true);
    // Rebinding to the claim already active would revoke what it just promoted.
    assert.equal(
      validatePermissionRebindOperation({ ...rebind, newClaimId: CLAIM }).success,
      false,
    );
    // And it carries no UUID either.
    assert.equal(
      validatePermissionRebindOperation({
        ...rebind,
        previousMinecraftUuid: '018f6b8c-76a3-7d10-9f2e-1d9e52a63718',
      }).success,
      false,
    );
  });

  it('makes a receipt name its failure, and show what was read back', () => {
    const snapshot = {
      schemaVersion: 1,
      identityId: IDENTITY,
      claimId: CLAIM,
      minecraftUuid: '018f6b8c-76a3-7d10-9f2e-1d9e52a63719',
      groups: ['moderator'],
      nodes: [{ node: 'voidfall.build.request', value: true }],
      source: { providerId: 'luckperms', providerVersion: null },
      observedAt: '2026-08-06T12:00:02.000Z',
    };
    assert.equal(validatePermissionSnapshot(snapshot).success, true);

    const receipt = {
      schemaVersion: 1,
      operationId: OPERATION,
      outcome: 'applied',
      failureCode: null,
      snapshot,
      completedAt: '2026-08-06T12:00:02.000Z',
    };
    assert.equal(validatePermissionOperationReceipt(receipt).success, true);

    // Applied with nothing read back is "it worked, I think" — not an outcome.
    assert.equal(
      validatePermissionOperationReceipt({ ...receipt, snapshot: null }).success,
      false,
    );
    // A failure names itself, and a success does not.
    assert.equal(
      validatePermissionOperationReceipt({ ...receipt, outcome: 'failed' }).success,
      false,
    );
    assert.equal(
      validatePermissionOperationReceipt({ ...receipt, failureCode: 'claim-mismatch' }).success,
      false,
    );
    assert.equal(
      validatePermissionOperationReceipt({
        ...receipt,
        outcome: 'failed',
        failureCode: 'claim-mismatch',
        snapshot: null,
      }).success,
      true,
    );
  });
});

describe('claim evidence', () => {
  const IDENTITY = '018f6b8c-76a3-7d10-9f2e-1d9e52a63731';
  const CLAIM = '018f6b8c-76a3-7d10-9f2e-1d9e52a63732';
  const SERVER = '018f6b8c-76a3-7d10-9f2e-1d9e52a63733';
  const ACCOUNT = '018f6b8c-76a3-7d10-9f2e-1d9e52a63734';

  const evidence = () => ({
    schemaVersion: 1,
    identityId: IDENTITY,
    claimId: CLAIM,
    claimRevision: 3,
    serverInstanceId: SERVER,
    expectedMinecraftName: 'Void_Player',
    expectedMinecraftUuid: ACCOUNT,
    issuedAt: '2026-08-06T12:00:00.000Z',
    expiresAt: '2026-08-06T12:02:00.000Z',
  });

  it('carries the revision, so a pre-revocation replay is distinguishable', () => {
    assert.equal(validateClaimEvidence(evidence()).success, true);
    // Without a revision, a ticket minted before a revocation would look
    // exactly like one minted after it.
    const { claimRevision, ...withoutRevision } = evidence();
    assert.equal(validateClaimEvidence(withoutRevision).success, false);
  });

  it('expires within minutes, because it asserts a fact that can change', () => {
    assert.equal(
      validateClaimEvidence({ ...evidence(), expiresAt: '2026-08-06T12:00:00.000Z' }).success,
      false,
    );
    // The window is the latency of a revocation the Bridge validates locally.
    assert.equal(
      validateClaimEvidence({ ...evidence(), expiresAt: '2026-08-06T18:00:00.000Z' }).success,
      false,
    );
  });

  it('names both the expected name and the expected account', () => {
    // The Bridge compares the real connection name against one and derives the
    // offline UUID to compare against the other. Dropping either would leave a
    // check that a supplied value could satisfy on its own.
    const { expectedMinecraftUuid, ...withoutUuid } = evidence();
    assert.equal(validateClaimEvidence(withoutUuid).success, false);
    const { expectedMinecraftName, ...withoutName } = evidence();
    assert.equal(validateClaimEvidence(withoutName).success, false);
  });

  it('validates the evidence inside a signed envelope', () => {
    const signed = {
      schemaVersion: 1,
      evidence: evidence(),
      signature: { algorithm: 'Ed25519', keyId: 'agent-key-1', value: 'a'.repeat(86) },
    };
    assert.equal(validateSignedClaimEvidence(signed).success, true);
    // A signature over evidence the contract rejects is still rejected.
    assert.equal(
      validateSignedClaimEvidence({
        ...signed,
        evidence: { ...evidence(), expiresAt: '2026-08-06T18:00:00.000Z' },
      }).success,
      false,
    );
  });

  it('withdraws through a revision rather than syncing claim state', () => {
    assert.equal(
      validateClaimInvalidation({
        schemaVersion: 1,
        identityId: IDENTITY,
        claimId: CLAIM,
        invalidatedThroughRevision: 3,
        serverInstanceId: SERVER,
        reason: 'claim-revoked',
        dropActiveSession: true,
        issuedAt: '2026-08-06T12:00:00.000Z',
      }).success,
      true,
    );
    // It says one thing. Carrying the claim's whole state would rebuild the
    // mirror this design avoids, by increments.
    assert.equal(
      validateClaimInvalidation({
        schemaVersion: 1,
        identityId: IDENTITY,
        claimId: CLAIM,
        invalidatedThroughRevision: 3,
        serverInstanceId: SERVER,
        reason: 'claim-revoked',
        dropActiveSession: true,
        issuedAt: '2026-08-06T12:00:00.000Z',
        expectedMinecraftUuid: ACCOUNT,
      }).success,
      false,
    );
  });
});
