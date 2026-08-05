import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ArtifactCompatibilityContext,
  ArtifactCompatibilityPlan,
  ArtifactCompatibilityReport,
  ArtifactInspectionReportContract,
  CompatibilityCandidate,
  CompatibilityIssue,
  CompatibilityIssueCode,
  DeclaredDependencyContract,
  DeclaredModContract,
} from '@voidfall/contracts';

import { analyzeArtifactCompatibility } from '../src/engine.js';
import { KNOWN_ISSUE_KINDS, safeDetail } from '../src/messages.js';
import { ArtifactCompatibilityError } from '../src/types.js';

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

const serverContext: ArtifactCompatibilityContext = {
  contextId: 'server-active',
  kind: 'server_active',
  side: 'server',
  runtime: { minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '1.20.1-47.4.4' },
  javaVersion: '17',
};

const clientContext: ArtifactCompatibilityContext = {
  contextId: 'launcher-current',
  kind: 'launcher_current',
  side: 'client',
  runtime: { minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '1.20.1-47.4.4' },
  javaVersion: '17',
};

function dependency(
  overrides: Partial<DeclaredDependencyContract> = {},
): DeclaredDependencyContract {
  return {
    target: 'minecraft',
    mandatory: true,
    versionRange: '[1.20.1]',
    side: 'BOTH',
    evidence: 'META-INF/mods.toml',
    ...overrides,
  };
}

function mod(overrides: Partial<DeclaredModContract> = {}): DeclaredModContract {
  return {
    modId: 'voidfall_probe',
    displayName: 'VoidFall Probe',
    version: '1.0.0',
    loader: 'forge',
    dependencies: [dependency(), dependency({ target: 'forge', versionRange: '[47,)' })],
    evidence: 'META-INF/mods.toml',
    ...overrides,
  };
}

function inspection(
  overrides: Partial<ArtifactInspectionReportContract> = {},
): ArtifactInspectionReportContract {
  return {
    schemaVersion: 1,
    sha256: hash('a'),
    sizeBytes: 4_096,
    inspectedAt: '2026-08-05T12:00:00Z',
    container: 'zip',
    entryCount: 12,
    expandedBytes: 900,
    loaders: ['forge'],
    mods: [mod()],
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
    ...overrides,
  };
}

function candidate(overrides: Partial<CompatibilityCandidate> = {}): CompatibilityCandidate {
  return {
    artifactId: 'candidate-probe',
    filename: 'probe-1.0.0.jar',
    inspection: inspection(),
    reviewedSide: 'both',
    targetContextIds: ['server-active'],
    distributionReviewed: true,
    ...overrides,
  };
}

function plan(overrides: Partial<ArtifactCompatibilityPlan> = {}): ArtifactCompatibilityPlan {
  return {
    schemaVersion: 1,
    analysisId: 'phase-8-2',
    generatedAt: '2026-08-05T12:00:00Z',
    contexts: [serverContext],
    candidates: [candidate()],
    installed: [],
    explicitConflicts: [],
    ...overrides,
  };
}

function issuesOf(report: ArtifactCompatibilityReport, code: CompatibilityIssueCode): CompatibilityIssue[] {
  return report.issues.filter((issue) => issue.code === code);
}

function onlyIssue(
  report: ArtifactCompatibilityReport,
  code: CompatibilityIssueCode,
): CompatibilityIssue {
  const found = issuesOf(report, code);
  assert.equal(found.length, 1, `expected exactly one ${code}, got ${found.length}`);
  const issue = found[0];
  assert.ok(issue);
  return issue;
}

describe('artifact compatibility engine', () => {
  it('accepts a reviewed artifact that matches its context', () => {
    const report = analyzeArtifactCompatibility(plan());

    assert.deepEqual(report.issues, []);
    assert.equal(report.artifacts[0]?.status, 'compatible');
    assert.deepEqual(report.summary, {
      compatibleArtifacts: 1,
      incompatibleArtifacts: 0,
      unknownArtifacts: 0,
      blockerCount: 0,
      warningCount: 0,
      informationCount: 0,
    });
  });

  it('refuses a plan it cannot trust', () => {
    assert.throws(
      () => analyzeArtifactCompatibility({ ...plan(), analysisId: 'Invalid Id' } as never),
      (error: unknown) => {
        assert.ok(error instanceof ArtifactCompatibilityError);
        assert.equal(error.code, 'invalid-plan');
        assert.equal(error.stage, 'plan');
        return true;
      },
    );
  });
});

describe('runtime comparison', () => {
  it('proves a Minecraft range that excludes the running version', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              mods: [mod({ dependencies: [dependency({ versionRange: '[1.19.2]' })] })],
            }),
          }),
        ],
      }),
    );

    const issue = onlyIssue(report, 'minecraft-version-mismatch');
    assert.equal(issue.reason, 'declared-mismatch');
    assert.equal(issue.determinacy, 'proven');
    assert.equal(issue.severity, 'blocker');
    assert.equal(issue.recommendedAction, 'match-minecraft-version');
    assert.equal(report.artifacts[0]?.status, 'incompatible');
  });

  it('blocks when no Minecraft version is declared at all', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              mods: [mod({ dependencies: [dependency({ target: 'forge', versionRange: '[47,)' })] })],
            }),
          }),
        ],
      }),
    );

    const issue = onlyIssue(report, 'minecraft-version-mismatch');
    assert.equal(issue.reason, 'not-declared');
    assert.equal(issue.determinacy, 'unproven');
    assert.equal(issue.severity, 'blocker');
    // Unknown never passes silently, but it is not reported as a proven defect.
    assert.equal(report.artifacts[0]?.status, 'unknown');
  });

  it('keeps a range outside the supported syntax unknown instead of guessing', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              mods: [mod({ dependencies: [dependency({ versionRange: '>=1.20.1 <1.21' })] })],
            }),
          }),
        ],
      }),
    );

    const issue = onlyIssue(report, 'minecraft-version-mismatch');
    assert.equal(issue.reason, 'range-unsupported');
    assert.equal(issue.determinacy, 'unproven');
    assert.equal(issue.severity, 'blocker');
    assert.equal(report.artifacts[0]?.status, 'unknown');
  });

  it('proves a loader the context does not run', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              loaders: ['fabric'],
              mods: [
                mod({
                  loader: 'fabric',
                  evidence: 'fabric.mod.json',
                  dependencies: [dependency({ evidence: 'fabric.mod.json' })],
                }),
              ],
              evidence: ['fabric.mod.json'],
            }),
          }),
        ],
      }),
    );

    const issue = onlyIssue(report, 'loader-mismatch');
    assert.equal(issue.determinacy, 'proven');
    assert.equal(issue.recommendedAction, 'match-loader');
    assert.equal(issue.detail, 'running=forge;declared=fabric');
    assert.equal(report.artifacts[0]?.status, 'incompatible');
  });

  it('compares a loader range against the loader version alone', () => {
    const excluded = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              mods: [
                mod({
                  dependencies: [dependency(), dependency({ target: 'forge', versionRange: '[48,)' })],
                }),
              ],
            }),
          }),
        ],
      }),
    );

    const issue = onlyIssue(excluded, 'loader-version-mismatch');
    assert.equal(issue.reason, 'declared-mismatch');
    assert.equal(issue.determinacy, 'proven');
    // The `1.20.1-` prefix is stripped, so the range sees the loader version.
    assert.equal(issue.detail, 'loader=forge;required=[48,);running=47.4.4');
  });

  it('cannot judge a loader range when the context declares no loader version', () => {
    const context: ArtifactCompatibilityContext = {
      ...serverContext,
      runtime: { minecraftVersion: '1.20.1', loader: 'forge' },
    };
    const report = analyzeArtifactCompatibility(plan({ contexts: [context] }));

    const issue = onlyIssue(report, 'loader-version-mismatch');
    assert.equal(issue.reason, 'not-declared');
    assert.equal(issue.determinacy, 'unproven');
    assert.equal(report.artifacts[0]?.status, 'unknown');
  });

  it('does not repeat a loader mismatch once per dependency', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              loaders: ['neoforge'],
              mods: [
                mod({
                  loader: 'neoforge',
                  evidence: 'META-INF/neoforge.mods.toml',
                  dependencies: [
                    dependency({ evidence: 'META-INF/neoforge.mods.toml' }),
                    dependency({
                      target: 'neoforge',
                      versionRange: '[20,)',
                      evidence: 'META-INF/neoforge.mods.toml',
                    }),
                  ],
                }),
              ],
              evidence: ['META-INF/neoforge.mods.toml'],
            }),
          }),
        ],
      }),
    );

    assert.equal(issuesOf(report, 'loader-mismatch').length, 1);
    // The unavailable loader is not also reported as a missing mod.
    assert.deepEqual(issuesOf(report, 'missing-required-dependency'), []);
    assert.deepEqual(issuesOf(report, 'loader-version-mismatch'), []);
  });
});

describe('side', () => {
  it('proves a reviewed side the context does not serve', () => {
    const report = analyzeArtifactCompatibility(
      plan({ candidates: [candidate({ reviewedSide: 'client' })] }),
    );

    const issue = onlyIssue(report, 'side-mismatch');
    assert.equal(issue.reason, 'declared-mismatch');
    assert.equal(issue.severity, 'blocker');
    assert.equal(issue.determinacy, 'proven');
    assert.equal(issue.recommendedAction, 'match-side');
  });

  it('never lets presence stand in for an unreviewed side', () => {
    const report = analyzeArtifactCompatibility(
      plan({ candidates: [candidate({ reviewedSide: null })] }),
    );

    const issue = onlyIssue(report, 'metadata-unverified');
    assert.equal(issue.reason, 'side-not-reviewed');
    assert.equal(issue.severity, 'blocker');
    assert.equal(issue.determinacy, 'unproven');
    assert.equal(issue.recommendedAction, 'review-side');
    assert.equal(report.artifacts[0]?.status, 'unknown');
  });

  it('records a dependency declared for the other side as information, not a defect', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              mods: [
                mod({
                  dependencies: [
                    dependency(),
                    dependency({ target: 'embeddium', side: 'CLIENT', versionRange: '[0.3,)' }),
                  ],
                }),
              ],
            }),
          }),
        ],
      }),
    );

    const issue = onlyIssue(report, 'side-mismatch');
    assert.equal(issue.reason, 'dependency-side-not-applicable');
    assert.equal(issue.severity, 'information');
    // An information issue never changes the verdict.
    assert.equal(report.artifacts[0]?.status, 'compatible');
    assert.equal(report.summary.informationCount, 1);
  });

  it('judges the same artifact separately per context', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        contexts: [serverContext, clientContext],
        candidates: [
          candidate({ reviewedSide: 'client', targetContextIds: ['server-active', 'launcher-current'] }),
        ],
      }),
    );

    const artifact = report.artifacts[0];
    assert.ok(artifact);
    assert.equal(artifact.status, 'incompatible');
    assert.deepEqual(artifact.contexts, [
      { contextId: 'launcher-current', status: 'compatible' },
      { contextId: 'server-active', status: 'incompatible' },
    ]);
  });
});

describe('dependencies', () => {
  it('proves a mandatory dependency that no artifact provides', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              mods: [
                mod({ dependencies: [dependency(), dependency({ target: 'jei', versionRange: '[15,)' })] }),
              ],
            }),
          }),
        ],
      }),
    );

    const issue = onlyIssue(report, 'missing-required-dependency');
    assert.equal(issue.reason, 'not-declared');
    assert.equal(issue.determinacy, 'proven');
    assert.equal(issue.recommendedAction, 'provide-dependency');
    assert.equal(issue.detail, 'dependency=jei;required=[15,)');
    // The absent target is not declared by the report, so it cannot be cited.
    assert.deepEqual(issue.modIds, ['voidfall_probe']);
    assert.equal(report.artifacts[0]?.status, 'incompatible');
  });

  it('cannot prove absence when an unopened nested library may carry it', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              mods: [
                mod({ dependencies: [dependency(), dependency({ target: 'jei', versionRange: '[15,)' })] }),
              ],
              embeddedLibraries: [
                { identifier: 'org.example:probe-lib', version: '1.0.0', evidence: 'META-INF/jarjar/metadata.json' },
              ],
              evidence: ['META-INF/jarjar/metadata.json', 'META-INF/mods.toml'],
            }),
          }),
        ],
      }),
    );

    const issue = onlyIssue(report, 'missing-required-dependency');
    assert.equal(issue.reason, 'possibly-embedded');
    assert.equal(issue.determinacy, 'unproven');
    assert.equal(report.artifacts[0]?.status, 'unknown');
  });

  it('ignores an optional dependency that is simply absent', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              mods: [
                mod({
                  dependencies: [
                    dependency(),
                    dependency({ target: 'jei', mandatory: false, versionRange: '[15,)' }),
                  ],
                }),
              ],
            }),
          }),
        ],
      }),
    );

    assert.deepEqual(report.issues, []);
    assert.equal(report.artifacts[0]?.status, 'compatible');
  });

  it('proves a dependency present with an excluded version and names both artifacts', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              mods: [
                mod({ dependencies: [dependency(), dependency({ target: 'jei', versionRange: '[15,)' })] }),
              ],
            }),
          }),
        ],
        installed: [
          {
            artifactId: 'installed-jei',
            filename: 'jei-14.0.0.jar',
            sha256: hash('b'),
            contextIds: ['server-active'],
            mods: [{ modId: 'jei', version: '14.0.0' }],
          },
        ],
      }),
    );

    const issue = onlyIssue(report, 'dependency-version-mismatch');
    assert.equal(issue.reason, 'declared-mismatch');
    assert.equal(issue.determinacy, 'proven');
    assert.deepEqual(issue.artifactIds, ['candidate-probe', 'installed-jei']);
    assert.deepEqual(issue.modIds, ['jei', 'voidfall_probe']);
    assert.equal(issue.detail, 'dependency=jei;required=[15,);observed=14.0.0');
    // The installed artifact an issue cites is declared by the report itself.
    assert.deepEqual(report.relatedInstalled, [
      { artifactId: 'installed-jei', filename: 'jei-14.0.0.jar', sha256: hash('b'), modIds: ['jei'] },
    ]);
  });

  it('accepts a dependency present with a version inside the range', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              mods: [
                mod({ dependencies: [dependency(), dependency({ target: 'jei', versionRange: '[15,)' })] }),
              ],
            }),
          }),
        ],
        installed: [
          {
            artifactId: 'installed-jei',
            filename: 'jei-15.2.0.jar',
            sha256: hash('b'),
            contextIds: ['server-active'],
            mods: [{ modId: 'jei', version: '15.2.0' }],
          },
        ],
      }),
    );

    assert.deepEqual(report.issues, []);
    assert.deepEqual(report.relatedInstalled, []);
  });

  it('cannot judge a range against a provider with no declared version', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              mods: [
                mod({ dependencies: [dependency(), dependency({ target: 'jei', versionRange: '[15,)' })] }),
              ],
            }),
          }),
        ],
        installed: [
          {
            artifactId: 'installed-jei',
            filename: 'jei.jar',
            sha256: hash('b'),
            contextIds: ['server-active'],
            mods: [{ modId: 'jei', version: null }],
          },
        ],
      }),
    );

    const issue = onlyIssue(report, 'dependency-version-mismatch');
    assert.equal(issue.reason, 'not-declared');
    assert.equal(issue.determinacy, 'unproven');
    assert.equal(report.artifacts[0]?.status, 'unknown');
  });

  it('judges a java range against the context and never reports java as missing', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              mods: [mod({ dependencies: [dependency(), dependency({ target: 'java', versionRange: '[21,)' })] })],
            }),
          }),
        ],
      }),
    );

    const issue = onlyIssue(report, 'dependency-version-mismatch');
    assert.equal(issue.reason, 'declared-mismatch');
    assert.equal(issue.detail, 'dependency=java;required=[21,);running=17');
    assert.deepEqual(issuesOf(report, 'missing-required-dependency'), []);
  });
});

describe('duplicates, collisions and reviewed conflicts', () => {
  const second = (overrides: Partial<CompatibilityCandidate> = {}): CompatibilityCandidate =>
    candidate({
      artifactId: 'candidate-second',
      filename: 'probe-1.0.1.jar',
      inspection: inspection({ sha256: hash('c') }),
      ...overrides,
    });

  it('proves two artifacts declaring the same mod id', () => {
    const report = analyzeArtifactCompatibility(plan({ candidates: [candidate(), second()] }));

    const issue = onlyIssue(report, 'duplicate-mod-id');
    assert.deepEqual(issue.artifactIds, ['candidate-probe', 'candidate-second']);
    assert.deepEqual(issue.modIds, ['voidfall_probe']);
    assert.equal(issue.severity, 'blocker');
    assert.equal(issue.recommendedAction, 'deduplicate-mod-id');
  });

  it('warns on identical content without blocking the artifact', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({ inspection: inspection({ mods: [] }), filename: 'a.jar' }),
          second({ inspection: inspection({ mods: [] }), filename: 'b.jar' }),
        ],
      }),
    );

    // Both carry hash('a') because the second overrides only its filename.
    const duplicate = onlyIssue(report, 'duplicate-content');
    assert.equal(duplicate.severity, 'warning');
    assert.equal(duplicate.determinacy, 'proven');
    assert.equal(duplicate.recommendedAction, 'deduplicate-content');
    assert.equal(report.summary.warningCount, 1);
    assert.deepEqual(issuesOf(report, 'filename-collision'), []);
  });

  it('proves a filename claimed by two different contents', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({ inspection: inspection({ mods: [] }) }),
          second({ filename: 'probe-1.0.0.jar', inspection: inspection({ sha256: hash('c'), mods: [] }) }),
        ],
      }),
    );

    const issue = onlyIssue(report, 'filename-collision');
    assert.equal(issue.severity, 'blocker');
    assert.equal(issue.recommendedAction, 'rename-artifact');
    assert.deepEqual(issuesOf(report, 'duplicate-content'), []);
  });

  it('reports a reviewed conflict between two present mods', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({ mods: [mod({ modId: 'optifine_like' })] }),
          }),
        ],
        installed: [
          {
            artifactId: 'installed-embeddium',
            filename: 'embeddium.jar',
            sha256: hash('b'),
            contextIds: ['server-active'],
            mods: [{ modId: 'embeddium', version: '0.3.0' }],
          },
        ],
        explicitConflicts: [{ modId: 'optifine_like', conflictsWith: 'embeddium' }],
      }),
    );

    const issue = onlyIssue(report, 'explicit-conflict');
    assert.equal(issue.reason, 'reviewed-conflict');
    assert.equal(issue.severity, 'blocker');
    assert.equal(issue.recommendedAction, 'resolve-conflict');
    assert.deepEqual(issue.modIds, ['embeddium', 'optifine_like']);
    assert.deepEqual(issue.artifactIds, ['candidate-probe', 'installed-embeddium']);
  });

  it('keeps a large duplicate group inside the contract bound', () => {
    const many = Array.from({ length: 20 }, (_unused, index) =>
      candidate({
        artifactId: `candidate-${String(index).padStart(2, '0')}`,
        filename: `probe-${index}.jar`,
        inspection: inspection({ sha256: hash(String(index)) }),
      }),
    );
    const report = analyzeArtifactCompatibility(plan({ candidates: many }));

    const issue = onlyIssue(report, 'duplicate-mod-id');
    // The report validates, and the citation is bounded rather than truncated
    // in a way that could drop every artifact under judgement.
    assert.equal(issue.artifactIds.length, 16);
    assert.equal(issue.detail, 'modId=voidfall_probe;artifacts=20');
    assert.equal(report.artifacts.length, 20);
  });

  it('reports mods that require each other', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              mods: [
                mod({
                  modId: 'left_mod',
                  dependencies: [dependency(), dependency({ target: 'right_mod', versionRange: null })],
                }),
              ],
            }),
          }),
          second({
            inspection: inspection({
              sha256: hash('c'),
              mods: [
                mod({
                  modId: 'right_mod',
                  dependencies: [dependency(), dependency({ target: 'left_mod', versionRange: null })],
                }),
              ],
            }),
          }),
        ],
      }),
    );

    const issue = onlyIssue(report, 'dependency-cycle');
    assert.equal(issue.reason, 'cyclic-declaration');
    assert.equal(issue.severity, 'warning');
    assert.equal(issue.determinacy, 'proven');
    assert.deepEqual(issue.modIds, ['left_mod', 'right_mod']);
    assert.deepEqual(issue.artifactIds, ['candidate-probe', 'candidate-second']);
    assert.equal(issue.detail, 'mods=2;cycle=left_mod,right_mod');
    // A cycle is a structural fact to review, not proof that loading fails.
    assert.equal(report.artifacts[0]?.status, 'compatible');
  });

  it('does not invent a cycle from a plain dependency chain', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              mods: [
                mod({
                  modId: 'left_mod',
                  dependencies: [dependency(), dependency({ target: 'right_mod', versionRange: null })],
                }),
              ],
            }),
          }),
          second({
            inspection: inspection({ sha256: hash('c'), mods: [mod({ modId: 'right_mod' })] }),
          }),
        ],
      }),
    );

    assert.deepEqual(issuesOf(report, 'dependency-cycle'), []);
    assert.deepEqual(issuesOf(report, 'missing-required-dependency'), []);
  });

  it('leaves a conflict between two already approved artifacts to another analysis', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        installed: [
          {
            artifactId: 'installed-left',
            filename: 'left.jar',
            sha256: hash('b'),
            contextIds: ['server-active'],
            mods: [{ modId: 'left_mod', version: '1.0.0' }],
          },
          {
            artifactId: 'installed-right',
            filename: 'right.jar',
            sha256: hash('c'),
            contextIds: ['server-active'],
            mods: [{ modId: 'right_mod', version: '1.0.0' }],
          },
        ],
        explicitConflicts: [{ modId: 'left_mod', conflictsWith: 'right_mod' }],
      }),
    );

    assert.deepEqual(issuesOf(report, 'explicit-conflict'), []);
  });
});

describe('unverified metadata', () => {
  it('reports an unreadable descriptor without echoing its text', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({ metadataIssues: ['META-INF/mods.toml: unsupported table'] }),
          }),
        ],
      }),
    );

    const issue = onlyIssue(report, 'metadata-unverified');
    assert.equal(issue.reason, 'descriptor-unreadable');
    assert.equal(issue.determinacy, 'unproven');
    assert.equal(issue.detail, 'unreadable=1');
    assert.equal(report.artifacts[0]?.status, 'unknown');
  });

  it('blocks an artifact that declares no descriptor', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({ inspection: inspection({ loaders: ['unknown'], mods: [], evidence: [] }) }),
        ],
      }),
    );

    const issue = onlyIssue(report, 'metadata-unverified');
    assert.equal(issue.reason, 'loader-not-declared');
    assert.equal(issue.determinacy, 'unproven');
    assert.deepEqual(issuesOf(report, 'loader-mismatch'), []);
    assert.equal(report.artifacts[0]?.status, 'unknown');
  });

  it('blocks a legacy descriptor that has no reviewed parser', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({ loaders: ['legacy-mcmod'], mods: [], evidence: ['mcmod.info'] }),
          }),
        ],
      }),
    );

    const issue = onlyIssue(report, 'metadata-unverified');
    assert.equal(issue.reason, 'legacy-descriptor');
    assert.equal(issue.determinacy, 'unproven');
    assert.deepEqual(issuesOf(report, 'loader-mismatch'), []);
  });

  it('warns that a nested library was never opened without blocking on it', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              embeddedLibraries: [
                { identifier: 'org.example:probe-lib', version: '1.0.0', evidence: 'META-INF/jarjar/metadata.json' },
              ],
              evidence: ['META-INF/jarjar/metadata.json', 'META-INF/mods.toml'],
            }),
          }),
        ],
      }),
    );

    const issue = onlyIssue(report, 'metadata-unverified');
    assert.equal(issue.reason, 'nested-libraries-not-inspected');
    assert.equal(issue.severity, 'warning');
    assert.equal(issue.determinacy, 'proven');
    assert.deepEqual(issue.evidence, ['META-INF/jarjar/metadata.json']);
    // A declared library is a limit of the inspection, not a defect of the mod.
    assert.equal(report.artifacts[0]?.status, 'compatible');
  });

  it('warns when a version stayed an unresolved placeholder', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [candidate({ inspection: inspection({ mods: [mod({ version: '${file.jarVersion}' })] }) })],
      }),
    );

    const issue = onlyIssue(report, 'metadata-unverified');
    assert.equal(issue.reason, 'mod-version-unresolved');
    assert.equal(issue.severity, 'warning');
    assert.deepEqual(issue.modIds, ['voidfall_probe']);
    assert.equal(report.artifacts[0]?.status, 'compatible');
  });

  it('blocks an artifact whose redistribution was never reviewed', () => {
    const report = analyzeArtifactCompatibility(
      plan({ candidates: [candidate({ distributionReviewed: false })] }),
    );

    const issue = onlyIssue(report, 'distribution-unreviewed');
    assert.equal(issue.reason, 'not-reviewed');
    assert.equal(issue.severity, 'blocker');
    assert.equal(issue.determinacy, 'proven');
    assert.equal(issue.recommendedAction, 'review-distribution');
    assert.equal(report.artifacts[0]?.status, 'incompatible');
  });
});

describe('report shape', () => {
  const noisyPlan = (): ArtifactCompatibilityPlan =>
    plan({
      contexts: [serverContext, clientContext],
      candidates: [
        candidate({
          targetContextIds: ['server-active', 'launcher-current'],
          reviewedSide: null,
          distributionReviewed: false,
          inspection: inspection({
            metadataIssues: ['unreadable'],
            embeddedLibraries: [
              { identifier: 'org.example:lib', version: null, evidence: 'META-INF/jarjar/metadata.json' },
            ],
            evidence: ['META-INF/jarjar/metadata.json', 'META-INF/mods.toml'],
            mods: [
              mod({
                version: '${file.jarVersion}',
                dependencies: [
                  dependency({ versionRange: '[1.19.2]' }),
                  dependency({ target: 'jei', versionRange: '[15,)' }),
                  dependency({ target: 'embeddium', side: 'CLIENT', versionRange: 'nonsense' }),
                ],
              }),
            ],
          }),
        }),
        candidate({ artifactId: 'candidate-second', filename: 'second.jar' }),
      ],
      installed: [
        {
          artifactId: 'installed-jei',
          filename: 'jei-14.0.0.jar',
          sha256: hash('b'),
          contextIds: ['server-active', 'launcher-current'],
          mods: [{ modId: 'jei', version: '14.0.0' }],
        },
      ],
      explicitConflicts: [{ modId: 'voidfall_probe', conflictsWith: 'jei' }],
    });

  it('is deterministic and deeply frozen', () => {
    const first = analyzeArtifactCompatibility(noisyPlan());
    const again = analyzeArtifactCompatibility(noisyPlan());

    assert.equal(JSON.stringify(first), JSON.stringify(again));
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.issues));
    assert.ok(first.issues.every((issue) => Object.isFrozen(issue)));
    assert.ok(first.issues.length > 5);
  });

  it('gives every issue a human explanation and a manual action', () => {
    const report = analyzeArtifactCompatibility(noisyPlan());

    for (const issue of report.issues) {
      assert.ok(issue.explanation.length > 0, `${issue.code} has no explanation`);
      assert.ok(KNOWN_ISSUE_KINDS.includes(`${issue.code}:${issue.reason}`));
      // Nothing here is an automatic repair: every action is a human decision.
      assert.ok(issue.recommendedAction.length > 0);
    }
  });

  it('never downgrades an unproven issue below a blocker', () => {
    const report = analyzeArtifactCompatibility(noisyPlan());

    const unproven = report.issues.filter((issue) => issue.determinacy === 'unproven');
    assert.ok(unproven.length > 0);
    assert.ok(unproven.every((issue) => issue.severity === 'blocker'));
  });

  it('keeps totals and statuses in agreement', () => {
    const report = analyzeArtifactCompatibility(noisyPlan());

    assert.equal(
      report.summary.blockerCount + report.summary.warningCount + report.summary.informationCount,
      report.issues.length,
    );
    assert.equal(
      report.summary.compatibleArtifacts +
        report.summary.incompatibleArtifacts +
        report.summary.unknownArtifacts,
      report.artifacts.length,
    );
    assert.equal(report.artifacts[0]?.status, 'incompatible');
  });
});

describe('detail sanitizing', () => {
  it('strips anything that could carry a location out of a detail', () => {
    // Separators, quotes, control characters and the drive prefix all go.
    assert.equal(safeDetail('C:\\servidor\\mods\\probe.jar'), 'Cservidormodsprobe.jar');
    assert.equal(safeDetail('/etc/passwd'), 'etcpasswd');
    assert.equal(safeDetail('a"b\u0000c'), 'abc');
    assert.equal(safeDetail('\\\\'), null);
    // A supported range is preserved exactly, so evidence stays readable.
    assert.equal(safeDetail('[1.20.1,1.21)'), '[1.20.1,1.21)');
  });

  it('keeps a hostile declared range from breaking the report contract', () => {
    const report = analyzeArtifactCompatibility(
      plan({
        candidates: [
          candidate({
            inspection: inspection({
              mods: [
                mod({
                  dependencies: [
                    dependency(),
                    dependency({ target: 'jei', versionRange: '../../etc/"passwd"' }),
                  ],
                }),
              ],
            }),
          }),
        ],
      }),
    );

    const issue = onlyIssue(report, 'missing-required-dependency');
    assert.ok(issue.detail !== null);
    assert.ok(!issue.detail.includes('/'));
    assert.ok(!issue.detail.includes('"'));
  });
});
