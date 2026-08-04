import {
  validateModCompatibilityAnalysisPlan,
  validateModCompatibilityReport,
  type ModCompatibilityAnalysisPlan,
  type ModCompatibilityComponent,
  type ModCompatibilityContext,
  type ModCompatibilityContextEvaluation,
  type ModCompatibilityFinding,
  type ModCompatibilityFindingCode,
  type ModCompatibilityOccurrence,
  type ModCompatibilityReport,
} from '@voidfall/contracts';

import { freezeDeep } from './canonical.js';
import { evaluateMavenVersionRange } from './maven-version.js';
import { ContextualCompatibilityAnalysisError } from './types.js';

const BUILTIN_DEPENDENCIES = new Set([
  'fabricloader',
  'fml',
  'forge',
  'java',
  'minecraft',
  'neoforge',
  'quilt_loader',
]);

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareOrdinal);
}

function findingKey(finding: ModCompatibilityFinding): string {
  return [
    finding.code,
    finding.severity,
    finding.componentIds.join('\u0000'),
    finding.contextIds.join('\u0000'),
    finding.reference ?? '',
    finding.evidenceReferences.join('\u0000'),
  ].join('\u0001');
}

function severityFor(context: ModCompatibilityContext): ModCompatibilityFinding['severity'] {
  if (context.kind === 'launcher_current' || context.kind === 'server_active') return 'blocker';
  if (context.kind === 'reference_client') return 'warning';
  return 'information';
}

function unknownSeverityFor(
  context: ModCompatibilityContext,
): ModCompatibilityFinding['severity'] {
  return context.kind === 'historical' ? 'information' : 'warning';
}

function dependencyApplies(
  side: 'client' | 'server' | 'both',
  context: ModCompatibilityContext,
): boolean {
  return side === 'both' || side === context.side;
}

function loaderVersion(context: ModCompatibilityContext): string | undefined {
  const value = context.runtime.loaderVersion;
  if (value === undefined) return undefined;
  const prefix = `${context.runtime.minecraftVersion}-`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function builtinVersion(
  targetId: string,
  context: ModCompatibilityContext,
): string | undefined {
  if (targetId === 'minecraft') return context.runtime.minecraftVersion;
  if (targetId === 'java') return context.javaVersion;
  if (targetId === 'forge' || targetId === 'fml') {
    return context.runtime.loader === 'forge' ? loaderVersion(context) : undefined;
  }
  if (targetId === 'neoforge') {
    return context.runtime.loader === 'neoforge' ? loaderVersion(context) : undefined;
  }
  if (targetId === 'fabricloader') {
    return context.runtime.loader === 'fabric' ? loaderVersion(context) : undefined;
  }
  if (targetId === 'quilt_loader') {
    return context.runtime.loader === 'quilt' ? loaderVersion(context) : undefined;
  }
  return undefined;
}

function builtinAvailable(targetId: string, context: ModCompatibilityContext): boolean {
  if (targetId === 'minecraft') return true;
  if (targetId === 'java') return context.javaVersion !== undefined;
  if (targetId === 'forge' || targetId === 'fml') return context.runtime.loader === 'forge';
  if (targetId === 'neoforge') return context.runtime.loader === 'neoforge';
  if (targetId === 'fabricloader') return context.runtime.loader === 'fabric';
  if (targetId === 'quilt_loader') return context.runtime.loader === 'quilt';
  return false;
}

function occurrencesInContext(
  component: ModCompatibilityComponent,
  context: ModCompatibilityContext,
): readonly ModCompatibilityOccurrence[] {
  return component.occurrences.filter((occurrence) => occurrence.contextId === context.id);
}

function selectedOccurrences(
  component: ModCompatibilityComponent,
  context: ModCompatibilityContext,
): readonly ModCompatibilityOccurrence[] {
  const observed = occurrencesInContext(component, context);
  const matching = observed.filter((occurrence) => occurrence.loader === context.runtime.loader);
  return matching.length > 0 ? matching : observed;
}

function evidenceForOccurrences(
  occurrences: readonly ModCompatibilityOccurrence[],
): string[] {
  return uniqueSorted(occurrences.map((occurrence) => occurrence.metadataPath));
}

function versionsFor(
  component: ModCompatibilityComponent,
  context: ModCompatibilityContext,
): string[] {
  return uniqueSorted(
    selectedOccurrences(component, context).flatMap((occurrence) =>
      occurrence.version === undefined ? [] : [occurrence.version],
    ),
  );
}

export function analyzeContextualCompatibility(
  input: ModCompatibilityAnalysisPlan,
): ModCompatibilityReport {
  const planResult = validateModCompatibilityAnalysisPlan(input);
  if (!planResult.success) {
    throw new ContextualCompatibilityAnalysisError(
      'invalid-plan',
      planResult.issues.map((issue) => `${issue.path}:${issue.message}`),
    );
  }
  const plan = planResult.value;
  const contexts = [...plan.contexts].sort((left, right) => compareOrdinal(left.id, right.id));
  const components = [...plan.components].sort((left, right) => compareOrdinal(left.id, right.id));
  const componentsById = new Map(components.map((component) => [component.id, component]));
  const findings = new Map<string, ModCompatibilityFinding>();

  const addFinding = (
    code: ModCompatibilityFindingCode,
    severity: ModCompatibilityFinding['severity'],
    componentIds: readonly string[],
    contextIds: readonly string[],
    evidenceReferences: readonly string[],
    reference?: string,
  ): void => {
    const finding: ModCompatibilityFinding = {
      code,
      severity,
      componentIds: uniqueSorted(componentIds),
      contextIds: uniqueSorted(contextIds),
      ...(reference !== undefined ? { reference } : {}),
      evidenceReferences: uniqueSorted(evidenceReferences),
    };
    findings.set(findingKey(finding), finding);
  };

  const evaluations = components.map((component) => {
    const contextEvaluations: ModCompatibilityContextEvaluation[] = [];
    for (const context of contexts) {
      const observed = occurrencesInContext(component, context);
      if (observed.length === 0) {
        contextEvaluations.push({
          contextId: context.id,
          status: 'not-present',
          versions: [],
          loaders: [],
        });
        continue;
      }

      const matching = observed.filter(
        (occurrence) => occurrence.loader === context.runtime.loader,
      );
      if (matching.length === 0) {
        addFinding(
          'loader-mismatch',
          severityFor(context),
          [component.id],
          [context.id],
          evidenceForOccurrences(observed),
          `expected=${context.runtime.loader};observed=${uniqueSorted(
            observed.map((occurrence) => occurrence.loader),
          ).join(',')}`,
        );
        contextEvaluations.push({
          contextId: context.id,
          status:
            context.kind === 'launcher_current' || context.kind === 'server_active'
              ? 'incompatible'
              : 'unknown',
          versions: uniqueSorted(
            observed.flatMap((occurrence) =>
              occurrence.version === undefined ? [] : [occurrence.version],
            ),
          ),
          loaders: uniqueSorted(observed.map((occurrence) => occurrence.loader)),
        });
        continue;
      }

      let status: ModCompatibilityContextEvaluation['status'] = 'compatible';
      for (const occurrence of matching) {
        for (const dependency of component.dependencies) {
          if (
            dependency.occurrenceId !== occurrence.occurrenceId ||
            !dependencyApplies(dependency.side, context)
          ) {
            continue;
          }

          let targetVersions: string[] = [];
          let evidence = [dependency.evidenceReference];
          if (BUILTIN_DEPENDENCIES.has(dependency.targetId)) {
            if (!builtinAvailable(dependency.targetId, context) && dependency.required) {
              addFinding(
                'missing-required-dependency',
                severityFor(context),
                [component.id, dependency.targetId],
                [context.id],
                evidence,
              );
              status = severityFor(context) === 'blocker' ? 'incompatible' : 'unknown';
              continue;
            }
            const version = builtinVersion(dependency.targetId, context);
            if (version !== undefined) targetVersions = [version];
          } else {
            const target = componentsById.get(dependency.targetId);
            if (target !== undefined) {
              const targetOccurrences = selectedOccurrences(target, context).filter(
                (candidate) => candidate.loader === context.runtime.loader,
              );
              targetVersions = uniqueSorted(
                targetOccurrences.flatMap((candidate) =>
                  candidate.version === undefined ? [] : [candidate.version],
                ),
              );
              evidence = uniqueSorted([
                ...evidence,
                ...evidenceForOccurrences(targetOccurrences),
              ]);
              if (targetOccurrences.length === 0 && dependency.required) {
                addFinding(
                  'missing-required-dependency',
                  severityFor(context),
                  [component.id, dependency.targetId],
                  [context.id],
                  evidence,
                );
                status = severityFor(context) === 'blocker' ? 'incompatible' : 'unknown';
                continue;
              }
            } else if (dependency.required) {
              addFinding(
                'missing-required-dependency',
                severityFor(context),
                [component.id, dependency.targetId],
                [context.id],
                evidence,
              );
              status = severityFor(context) === 'blocker' ? 'incompatible' : 'unknown';
              continue;
            }
          }

          if (dependency.versionRange === undefined) continue;
          const rangeResults =
            targetVersions.length === 0
              ? ['unknown' as const]
              : targetVersions.map((version) =>
                  evaluateMavenVersionRange(version, dependency.versionRange),
                );
          if (rangeResults.includes('match')) continue;
          if (rangeResults.every((result) => result === 'mismatch')) {
            addFinding(
              'dependency-version-mismatch',
              severityFor(context),
              [component.id, dependency.targetId],
              [context.id],
              evidence,
              dependency.versionRange,
            );
            status = severityFor(context) === 'blocker' ? 'incompatible' : 'unknown';
          } else {
            addFinding(
              'dependency-version-unknown',
              unknownSeverityFor(context),
              [component.id, dependency.targetId],
              [context.id],
              evidence,
              dependency.versionRange,
            );
            if (status !== 'incompatible') status = 'unknown';
          }
        }
      }

      contextEvaluations.push({
        contextId: context.id,
        status,
        versions: uniqueSorted(
          matching.flatMap((occurrence) =>
            occurrence.version === undefined ? [] : [occurrence.version],
          ),
        ),
        loaders: uniqueSorted(matching.map((occurrence) => occurrence.loader)),
      });
    }

    const launcher = contexts.find((context) => context.kind === 'launcher_current') as ModCompatibilityContext;
    const server = contexts.find((context) => context.kind === 'server_active') as ModCompatibilityContext;
    const launcherVersions = versionsFor(component, launcher);
    const serverVersions = versionsFor(component, server);
    if (
      launcherVersions.length > 0 &&
      serverVersions.length > 0 &&
      launcherVersions.every((version) => !serverVersions.includes(version))
    ) {
      addFinding(
        'canonical-version-conflict',
        'blocker',
        [component.id],
        [launcher.id, server.id],
        evidenceForOccurrences([
          ...selectedOccurrences(component, launcher),
          ...selectedOccurrences(component, server),
        ]),
        `launcher=${launcherVersions.join(',')};server=${serverVersions.join(',')}`,
      );
    }

    for (const reference of contexts.filter((context) => context.kind === 'reference_client')) {
      const referenceVersions = versionsFor(component, reference);
      const canonicalVersions = serverVersions.length > 0 ? serverVersions : launcherVersions;
      if (referenceVersions.length > 0 && canonicalVersions.length === 0) {
        addFinding(
          'reference-only-component',
          'information',
          [component.id],
          [reference.id],
          evidenceForOccurrences(selectedOccurrences(component, reference)),
        );
      } else if (
        referenceVersions.length > 0 &&
        canonicalVersions.length > 0 &&
        referenceVersions.every((version) => !canonicalVersions.includes(version))
      ) {
        addFinding(
          'reference-version-divergence',
          'warning',
          [component.id],
          [reference.id, serverVersions.length > 0 ? server.id : launcher.id],
          evidenceForOccurrences([
            ...selectedOccurrences(component, reference),
            ...selectedOccurrences(component, serverVersions.length > 0 ? server : launcher),
          ]),
          `reference=${referenceVersions.join(',')};canonical=${canonicalVersions.join(',')}`,
        );
      }
    }

    const activeVersions = uniqueSorted([...launcherVersions, ...serverVersions]);
    for (const historical of contexts.filter((context) => context.kind === 'historical')) {
      const historicalVersions = versionsFor(component, historical);
      if (
        historicalVersions.length > 0 &&
        activeVersions.length > 0 &&
        historicalVersions.every((version) => !activeVersions.includes(version))
      ) {
        addFinding(
          'historical-version-divergence',
          'information',
          [component.id],
          [historical.id],
          evidenceForOccurrences(selectedOccurrences(component, historical)),
          `historical=${historicalVersions.join(',')};active=${activeVersions.join(',')}`,
        );
      }
    }

    return {
      componentId: component.id,
      kind: component.kind,
      status: 'unknown' as const,
      contexts: contextEvaluations,
    };
  });

  const orderedFindings = [...findings.values()].sort((left, right) =>
    compareOrdinal(findingKey(left), findingKey(right)),
  );
  const finalizedEvaluations = evaluations.map((evaluation) => {
    const componentFindings = orderedFindings.filter((finding) =>
      finding.componentIds.includes(evaluation.componentId),
    );
    const hasCanonicalCompatible = evaluation.contexts.some((contextEvaluation) => {
      const context = contexts.find((candidate) => candidate.id === contextEvaluation.contextId);
      return (
        contextEvaluation.status === 'compatible' &&
        (context?.kind === 'launcher_current' || context?.kind === 'server_active')
      );
    });
    const status = componentFindings.some((finding) => finding.severity === 'blocker')
      ? ('incompatible' as const)
      : componentFindings.length > 0 || !hasCanonicalCompatible
        ? ('unknown' as const)
        : ('compatible' as const);
    return { ...evaluation, status };
  });

  const report: ModCompatibilityReport = {
    schemaVersion: 1,
    analysisId: plan.analysisId,
    generatedAt: plan.generatedAt,
    contexts,
    components: finalizedEvaluations,
    findings: orderedFindings,
    summary: {
      compatibleComponents: finalizedEvaluations.filter((item) => item.status === 'compatible').length,
      incompatibleComponents: finalizedEvaluations.filter((item) => item.status === 'incompatible').length,
      unknownComponents: finalizedEvaluations.filter((item) => item.status === 'unknown').length,
      blockerCount: orderedFindings.filter((finding) => finding.severity === 'blocker').length,
      warningCount: orderedFindings.filter((finding) => finding.severity === 'warning').length,
      informationCount: orderedFindings.filter(
        (finding) => finding.severity === 'information',
      ).length,
    },
  };
  const reportResult = validateModCompatibilityReport(report);
  if (!reportResult.success) {
    throw new ContextualCompatibilityAnalysisError(
      'invalid-report',
      reportResult.issues.map((issue) => `${issue.path}:${issue.message}`),
    );
  }
  return freezeDeep(reportResult.value);
}
