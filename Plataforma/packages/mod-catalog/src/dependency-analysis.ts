import {
  IsoDateTimeSchema,
  SlugSchema,
  validateContract,
  validateModCatalogEntry,
  type ModCatalogEntry,
} from '@voidfall/contracts';

import { freezeDeep } from './canonical.js';
import {
  CatalogDependencyAnalysisError,
  type CatalogAnalysisIssue,
  type CatalogAnalysisIssueCode,
  type CatalogConflictConstraint,
  type CatalogDependencyAnalysisPlan,
  type CatalogDependencyAnalysisReport,
} from './types.js';

const MAXIMUM_CATALOG_ENTRIES = 100_000;
const MAXIMUM_CONFLICTS = 100_000;

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareOrdinal);
  const wanted = [...expected].sort(compareOrdinal);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function scalarValid(schema: Parameters<typeof validateContract>[0], value: unknown): boolean {
  return validateContract(schema, value).success;
}

function normalizedFilename(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function sameRuntime(left: ModCatalogEntry, right: ModCatalogEntry): boolean {
  return (
    left.runtime.minecraftVersion === right.runtime.minecraftVersion &&
    left.runtime.loader === right.runtime.loader &&
    left.runtime.loaderVersion === right.runtime.loaderVersion
  );
}

function issueKey(issue: CatalogAnalysisIssue): string {
  return [issue.code, issue.entryIds.join('\u0000'), issue.reference ?? ''].join('\u0001');
}

function compareIssue(left: CatalogAnalysisIssue, right: CatalogAnalysisIssue): number {
  return compareOrdinal(issueKey(left), issueKey(right));
}

function validateConflict(value: CatalogConflictConstraint): CatalogConflictConstraint {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['constraintId', 'leftId', 'rightId', 'evidenceReference']) ||
    !scalarValid(SlugSchema, value.constraintId) ||
    !scalarValid(SlugSchema, value.leftId) ||
    !scalarValid(SlugSchema, value.rightId) ||
    value.leftId === value.rightId ||
    typeof value.evidenceReference !== 'string' ||
    value.evidenceReference.length < 1 ||
    value.evidenceReference.length > 2_048 ||
    /[\u0000-\u001f\u007f]/u.test(value.evidenceReference)
  ) {
    throw new CatalogDependencyAnalysisError('invalid-conflict');
  }
  return Object.freeze({ ...value });
}

function stronglyConnectedComponents(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (node: string): void => {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of [...(graph.get(node) ?? [])].sort(compareOrdinal)) {
      if (!indices.has(neighbor)) {
        visit(neighbor);
        lowLinks.set(node, Math.min(lowLinks.get(node) ?? 0, lowLinks.get(neighbor) ?? 0));
      } else if (onStack.has(neighbor)) {
        lowLinks.set(node, Math.min(lowLinks.get(node) ?? 0, indices.get(neighbor) ?? 0));
      }
    }

    if (lowLinks.get(node) === indices.get(node)) {
      const component: string[] = [];
      let current: string | undefined;
      do {
        current = stack.pop();
        if (current !== undefined) {
          onStack.delete(current);
          component.push(current);
        }
      } while (current !== node);
      if (component.length > 1) components.push(component.sort(compareOrdinal));
    }
  };

  for (const node of [...graph.keys()].sort(compareOrdinal)) {
    if (!indices.has(node)) visit(node);
  }
  return components.sort((left, right) => compareOrdinal(left.join('\u0000'), right.join('\u0000')));
}

export function analyzeCatalogDependencies(
  input: CatalogDependencyAnalysisPlan,
): CatalogDependencyAnalysisReport {
  if (
    !isRecord(input) ||
    !exactKeys(input, ['analysisId', 'generatedAt', 'catalog', 'conflicts']) ||
    !scalarValid(SlugSchema, input.analysisId) ||
    !scalarValid(IsoDateTimeSchema, input.generatedAt) ||
    !Array.isArray(input.catalog) ||
    input.catalog.length > MAXIMUM_CATALOG_ENTRIES ||
    !Array.isArray(input.conflicts) ||
    input.conflicts.length > MAXIMUM_CONFLICTS
  ) {
    throw new CatalogDependencyAnalysisError('invalid-plan');
  }

  const catalog = input.catalog.map((entry) => {
    const result = validateModCatalogEntry(entry);
    if (!result.success) throw new CatalogDependencyAnalysisError('invalid-catalog-entry');
    return result.value;
  });
  const conflicts = input.conflicts.map((constraint) => validateConflict(constraint));
  const constraintIds = new Set<string>();
  for (const constraint of conflicts) {
    if (constraintIds.has(constraint.constraintId)) {
      throw new CatalogDependencyAnalysisError('invalid-conflict');
    }
    constraintIds.add(constraint.constraintId);
  }

  const issues = new Map<string, CatalogAnalysisIssue>();
  const addIssue = (
    code: CatalogAnalysisIssueCode,
    severity: CatalogAnalysisIssue['severity'],
    entryIds: readonly string[],
    reference?: string,
  ): void => {
    const issue: CatalogAnalysisIssue = {
      code,
      severity,
      entryIds: [...new Set(entryIds)].sort(compareOrdinal),
      ...(reference !== undefined ? { reference } : {}),
    };
    issues.set(issueKey(issue), issue);
  };

  const byId = new Map<string, ModCatalogEntry[]>();
  const byHash = new Map<string, Set<string>>();
  const hashesByFilename = new Map<string, Set<string>>();
  for (const entry of catalog) {
    byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
    const hashIds = byHash.get(entry.sha256) ?? new Set<string>();
    hashIds.add(entry.id);
    byHash.set(entry.sha256, hashIds);
    const filenameHashes = hashesByFilename.get(normalizedFilename(entry.filename)) ?? new Set<string>();
    filenameHashes.add(entry.sha256);
    hashesByFilename.set(normalizedFilename(entry.filename), filenameHashes);
  }

  for (const [id, entries] of byId) {
    if (entries.length > 1) addIssue('duplicate-catalog-id', 'blocker', [id]);
  }
  for (const ids of byHash.values()) {
    if (ids.size > 1) addIssue('duplicate-content', 'blocker', [...ids]);
  }
  for (const hashes of hashesByFilename.values()) {
    if (hashes.size > 1) {
      const ids = catalog.filter((entry) => hashes.has(entry.sha256)).map((entry) => entry.id);
      addIssue('filename-collision', 'blocker', ids);
    }
  }

  const graph = new Map<string, Set<string>>();
  for (const [id, entries] of byId) {
    if (entries.length === 1) graph.set(id, new Set<string>());
  }
  for (const entry of catalog) {
    for (const dependency of entry.dependencies) {
      if (dependency.id === entry.id) {
        addIssue('self-dependency', 'blocker', [entry.id]);
        continue;
      }
      const candidates = byId.get(dependency.id) ?? [];
      if (candidates.length === 0) {
        addIssue(
          dependency.required ? 'missing-required-dependency' : 'missing-optional-dependency',
          dependency.required ? 'blocker' : 'warning',
          [entry.id, dependency.id],
        );
        continue;
      }
      if (dependency.versionRange !== undefined) {
        addIssue('unverified-version-range', 'blocker', [entry.id, dependency.id], dependency.versionRange);
      }
      if (candidates.length === 1 && candidates[0] !== undefined) {
        if (!sameRuntime(entry, candidates[0])) {
          addIssue('runtime-mismatch', 'blocker', [entry.id, dependency.id]);
        }
        if (dependency.required && byId.get(entry.id)?.length === 1) {
          graph.get(entry.id)?.add(dependency.id);
        }
      }
    }
  }
  for (const component of stronglyConnectedComponents(graph)) {
    addIssue('required-dependency-cycle', 'blocker', component);
  }
  for (const constraint of conflicts) {
    if (byId.has(constraint.leftId) && byId.has(constraint.rightId)) {
      addIssue(
        'explicit-conflict',
        'blocker',
        [constraint.leftId, constraint.rightId],
        constraint.constraintId,
      );
    }
  }

  const orderedIssues = [...issues.values()].sort(compareIssue);
  const affected = new Set(orderedIssues.flatMap((issue) => issue.entryIds));
  return freezeDeep({
    schemaVersion: 1,
    analysisId: input.analysisId,
    generatedAt: input.generatedAt,
    catalogEntryCount: catalog.length,
    issues: orderedIssues,
    summary: {
      blockerCount: orderedIssues.filter((issue) => issue.severity === 'blocker').length,
      warningCount: orderedIssues.filter((issue) => issue.severity === 'warning').length,
      affectedEntryCount: affected.size,
    },
  });
}
