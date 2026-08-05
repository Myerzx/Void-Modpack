import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ArtifactSubmission,
  ArtifactSubmissionDetail,
  ArtifactSubmissionPage,
  CompatibilityIssue,
} from '../lib/artifact-view.js';
import {
  buildArtifactListView,
  buildDependencyGraphView,
  buildIncompatibilityDrawerView,
  buildInstallActionView,
  buildUploadProgressView,
  isDecidable,
  sideLabelFor,
} from '../lib/artifact-view.js';

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

function submission(overrides: Partial<ArtifactSubmission> = {}): ArtifactSubmission {
  return {
    submissionId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63701',
    filename: 'probe-1.0.0.jar',
    sha256: hash('a'),
    sizeBytes: 4_096,
    state: 'reviewable',
    reviewedSide: 'both',
    submittedAt: '2026-08-05T12:00:00Z',
    updatedAt: '2026-08-05T12:01:00Z',
    version: 4,
    analysis: {
      inspected: true,
      analyzed: true,
      loaders: ['forge'],
      modIds: ['voidfall_probe'],
      declaredVersions: ['1.0.0'],
      verdict: 'unknown',
      blockerCount: 1,
      warningCount: 1,
      informationCount: 0,
      provenBlockerCount: 0,
    },
    failure: null,
    decision: null,
    ...overrides,
  };
}

function page(submissions: readonly ArtifactSubmission[]): ArtifactSubmissionPage {
  return { submissions: [...submissions], total: submissions.length, limit: 50, offset: 0 };
}

function issue(overrides: Partial<CompatibilityIssue> = {}): CompatibilityIssue {
  return {
    code: 'minecraft-version-mismatch',
    severity: 'blocker',
    determinacy: 'proven',
    reason: 'declared-mismatch',
    contextIds: ['server-active'],
    artifactIds: ['submission-probe'],
    modIds: ['voidfall_probe'],
    evidence: ['META-INF/mods.toml'],
    detail: 'required=[1.19.2];running=1.20.1',
    explanation: 'The mod declares a Minecraft range that excludes the target version.',
    recommendedAction: 'match-minecraft-version',
    ...overrides,
  };
}

function detail(overrides: Partial<ArtifactSubmissionDetail> = {}): ArtifactSubmissionDetail {
  return {
    submission: submission(),
    inspection: {
      sha256: hash('a'),
      mods: [
        {
          modId: 'voidfall_probe',
          displayName: 'VoidFall Probe',
          version: '1.0.0',
          dependencies: [
            { target: 'minecraft', mandatory: true, versionRange: '[1.20.1]' },
            { target: 'jei', mandatory: false, versionRange: '[15,)' },
          ],
        },
      ],
    },
    compatibility: {
      artifacts: [{ artifactId: 'submission-probe', sha256: hash('a') }],
      issues: [
        issue({ determinacy: 'unproven', reason: 'not-declared', severity: 'blocker' }),
        issue({
          code: 'metadata-unverified',
          severity: 'warning',
          determinacy: 'proven',
          reason: 'nested-libraries-not-inspected',
          detail: 'libraries=1',
          explanation: 'The artifact declares embedded libraries that were never opened.',
          recommendedAction: 'review-metadata',
          modIds: [],
        }),
      ],
    },
    ...overrides,
  };
}

describe('mod list', () => {
  it('shows filename, side, version and state compactly', () => {
    const view = buildArtifactListView({ page: page([submission()]) });
    const item = view.items[0];
    assert.ok(item);

    assert.equal(item.filename, 'probe-1.0.0.jar');
    assert.equal(item.sideLabel, 'Cliente e servidor');
    assert.equal(item.versionLabel, '1.0.0');
    assert.equal(item.stateLabel, 'Aguardando revisão');
    assert.equal(item.shortSha256.length, 12);
    assert.equal(view.emptyReason, 'none');
  });

  it('never guesses a side nobody reviewed', () => {
    assert.equal(sideLabelFor(submission({ reviewedSide: null })), 'Não revisado');
    const view = buildArtifactListView({
      page: page([submission({ reviewedSide: null })]),
      side: 'unreviewed',
    });
    assert.equal(view.shown, 1);
    assert.equal(
      buildArtifactListView({ page: page([submission({ reviewedSide: null })]), side: 'server' }).shown,
      0,
    );
  });

  it('searches by filename, mod id and digest prefix', () => {
    const items = page([
      submission(),
      submission({
        submissionId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63703',
        filename: 'other.jar',
        sha256: hash('b'),
        analysis: { ...submission().analysis, modIds: ['other_mod'] },
      }),
    ]);

    assert.equal(buildArtifactListView({ page: items, search: 'probe' }).shown, 1);
    assert.equal(buildArtifactListView({ page: items, search: 'other_mod' }).shown, 1);
    assert.equal(buildArtifactListView({ page: items, search: 'bbbb' }).shown, 1);
    assert.equal(buildArtifactListView({ page: items, search: 'nothing' }).shown, 0);
    assert.equal(buildArtifactListView({ page: items, search: 'nothing' }).emptyReason, 'no-match');
    assert.equal(buildArtifactListView({ page: page([]) }).emptyReason, 'no-submissions');
  });

  it('marks an artifact that could not be cleared as unverified, not as broken', () => {
    const unverified = buildArtifactListView({ page: page([submission()]) }).items[0];
    assert.ok(unverified);
    assert.equal(unverified.unverified, true);

    const proven = buildArtifactListView({
      page: page([
        submission({
          state: 'blocked',
          analysis: { ...submission().analysis, blockerCount: 1, provenBlockerCount: 1 },
        }),
      ]),
    }).items[0];
    assert.ok(proven);
    assert.equal(proven.unverified, false);
  });

  it('offers a decision only from a state that allows one', () => {
    assert.equal(isDecidable('reviewable'), true);
    assert.equal(isDecidable('blocked'), true);
    for (const state of ['uploaded', 'quarantined', 'analyzing', 'approved', 'rejected'] as const) {
      assert.equal(isDecidable(state), false);
    }
  });
});

describe('upload progress', () => {
  it('reports bytes sent while uploading and stops at quarantine', () => {
    assert.deepEqual(buildUploadProgressView({ phase: 'idle' }), {
      phase: 'idle',
      percent: 0,
      label: 'Nenhum envio',
      busy: false,
    });
    const uploading = buildUploadProgressView({
      phase: 'uploading',
      sentBytes: 512,
      totalBytes: 1_024,
    });
    assert.equal(uploading.percent, 50);
    assert.equal(uploading.busy, true);

    const quarantined = buildUploadProgressView({ phase: 'quarantined' });
    assert.equal(quarantined.label, 'Em quarentena');
    assert.equal(quarantined.busy, false);
    // Analysis is a separate durable step, not a fraction of the upload.
    assert.equal(buildUploadProgressView({ phase: 'analyzing' }).percent, 100);
    assert.equal(buildUploadProgressView({ phase: 'failed' }).busy, false);
  });

  it('never reports more than what was sent', () => {
    const view = buildUploadProgressView({ phase: 'uploading', sentBytes: 9_999, totalBytes: 1_024 });
    assert.equal(view.percent, 100);
  });
});

describe('incompatibility drawer', () => {
  it('shows severity, reason, evidence and the manual action', () => {
    const view = buildIncompatibilityDrawerView(detail());
    assert.equal(view.available, true);
    assert.deepEqual(view.counts, { blocker: 1, warning: 1, information: 0 });

    const blocker = view.rows.find((row) => row.severity === 'blocker');
    assert.ok(blocker);
    assert.equal(blocker.severityLabel, 'Bloqueio');
    // An unproven issue is presented as unverified, never as a proven defect.
    assert.equal(blocker.determinacyLabel, 'Não comprovado');
    assert.equal(blocker.reason, 'not-declared');
    assert.deepEqual(blocker.evidence, ['META-INF/mods.toml']);
    assert.equal(blocker.recommendedAction, 'match-minecraft-version');
    assert.ok(blocker.explanation.length > 0);
  });

  it('filters by blocker, warning and information', () => {
    assert.equal(buildIncompatibilityDrawerView(detail(), 'blocker').rows.length, 1);
    assert.equal(buildIncompatibilityDrawerView(detail(), 'warning').rows.length, 1);
    assert.equal(buildIncompatibilityDrawerView(detail(), 'information').rows.length, 0);
    assert.equal(buildIncompatibilityDrawerView(detail(), 'all').rows.length, 2);
    assert.equal(
      buildIncompatibilityDrawerView(detail(), 'information').emptyLabel,
      'Nenhuma incompatibilidade nesta severidade.',
    );
  });

  it('replaces the fixture with a real state when no report exists yet', () => {
    const pending = buildIncompatibilityDrawerView(detail({ compatibility: null }));
    assert.equal(pending.available, false);
    assert.equal(pending.rows.length, 0);
    assert.equal(pending.emptyLabel, 'A análise ainda não foi concluída.');

    const refused = buildIncompatibilityDrawerView(
      detail({
        compatibility: null,
        submission: submission({
          state: 'blocked',
          failure: { code: 'not-a-zip-container', stage: 'inspection' },
          analysis: {
            inspected: false,
            analyzed: false,
            loaders: [],
            modIds: [],
            declaredVersions: [],
            verdict: null,
            blockerCount: 0,
            warningCount: 0,
            informationCount: 0,
            provenBlockerCount: 0,
          },
        }),
      }),
    );
    assert.equal(refused.emptyLabel, 'O artefato foi recusado antes da análise de compatibilidade.');
  });
});

describe('dependency graph', () => {
  it('is built on demand from what the artifact declares', () => {
    const view = buildDependencyGraphView(detail());
    assert.equal(view.available, true);
    assert.deepEqual(
      view.nodes.map((node) => node.id),
      ['jei', 'minecraft', 'voidfall_probe'],
    );
    assert.equal(view.nodes.find((node) => node.id === 'voidfall_probe')?.kind, 'declared-mod');
    assert.equal(view.nodes.find((node) => node.id === 'jei')?.kind, 'dependency');

    const optional = view.edges.find((edge) => edge.to === 'jei');
    assert.ok(optional);
    assert.equal(optional.mandatory, false);
    assert.equal(optional.versionRange, '[15,)');
  });

  it('is unavailable until an inspection exists', () => {
    const view = buildDependencyGraphView(detail({ inspection: null }));
    assert.equal(view.available, false);
    assert.deepEqual(view.nodes, []);
  });
});

describe('install action', () => {
  it('is absent in this phase', () => {
    const view = buildInstallActionView();
    assert.equal(view.present, false);
    assert.equal(view.enabled, false);
    assert.ok(view.reason.length > 0);
  });
});
