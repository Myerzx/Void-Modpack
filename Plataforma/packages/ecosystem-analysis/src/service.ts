import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  DEFAULT_ARTIFACT_INSPECTION_LIMITS,
  readZipDirectory,
  type ClassConfigurationDefinition,
  type ClassInvocation,
  type ZipEntry,
} from '@voidfall/artifact-inspection';
import { inferForm, type InferredForm } from '@voidfall/configuration-inference';
import type {
  InventoriedMod,
  WorkspaceFile,
  WorkspaceInventory,
} from '@voidfall/workspace-inventory';

import { classifySystem, type SystemClassification } from './systems.js';
import {
  DEFAULT_ARCHIVE_BYTECODE_LIMITS,
  inspectArchiveBytecode,
} from './bytecode.js';
import {
  ECOSYSTEM_ANALYSIS_SCHEMA_VERSION,
  ECOSYSTEM_ANALYZER_VERSION,
  EcosystemAnalysisError,
  type AnalysisConfidence,
  type AnalysisEvidence,
  type AnalysisSide,
  type AnalyzedConfiguration,
  type AnalyzedDatapack,
  type AnalyzedDatapackResource,
  type AnalyzedMod,
  type AnalyzedSystem,
  type DatapackLoader,
  type EcosystemAnalysis,
  type EcosystemAnalysisIssue,
  type EcosystemEntityType,
  type EcosystemGraphEntity,
  type EcosystemRelationship,
  type EcosystemRelationshipType,
  type EvidenceSource,
  type KnowledgeStatus,
} from './types.js';

const MAXIMUM_CONFIGURATION_BYTES = 4 * 1024 * 1024;
const MAXIMUM_PACK_METADATA_BYTES = 256 * 1024;
const MAXIMUM_TOTAL_BYTECODE_BYTES = 64 * 1024 * 1024;
const BUILTIN_DEPENDENCIES = new Set([
  'fabricloader',
  'fml',
  'forge',
  'java',
  'minecraft',
  'neoforge',
  'quilt_loader',
]);

interface SystemDraft {
  readonly systemId: string;
  readonly modId: string;
  readonly slug: string;
  readonly title: string;
  status: KnowledgeStatus;
  confidence: AnalysisConfidence;
  readonly configurationIds: Set<string>;
  readonly datapackResourceIds: Set<string>;
  readonly relationshipIds: Set<string>;
  readonly evidenceIds: Set<string>;
}

interface ModDraft {
  readonly source: InventoriedMod;
  readonly configurationIds: Set<string>;
  readonly systemIds: Set<string>;
  readonly datapackIds: Set<string>;
  readonly relationshipIds: Set<string>;
  readonly issueIds: Set<string>;
  readonly evidenceIds: Set<string>;
  archiveIndexed: boolean;
}

interface RelationshipDraft extends Omit<EcosystemRelationship, 'evidenceIds'> {
  readonly evidenceIds: Set<string>;
}

interface DatapackLocation {
  readonly name: string;
  readonly loader: DatapackLoader;
  readonly rootPath: string;
  readonly insidePath: string;
}

interface BytecodeDefinitionFact {
  readonly definition: ClassConfigurationDefinition;
  readonly entry: string;
  readonly evidenceId: string;
}

interface BytecodeRelationGroup {
  readonly targetModId: string;
  readonly type: 'INTEGRATES_WITH' | 'COMPATIBILITY' | 'READS_REGISTRY_FROM' | 'MODIFIES_GAMEPLAY_OF';
  readonly classification: SystemClassification;
  readonly evidenceIds: string[];
  count: number;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}:${sha256(parts.join('\u0000')).slice(0, 24)}`;
}

function compare(left: string, right: string): number {
  return left.localeCompare(right, 'en-US');
}

function sorted(values: ReadonlySet<string>): readonly string[] {
  return Object.freeze([...values].sort(compare));
}

function safeAbsolute(root: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((segment) => segment === '..' || segment === '.')
  ) {
    throw new EcosystemAnalysisError('invalid-root');
  }
  return join(root, ...relativePath.split('/'));
}

function sideOf(path: string): AnalysisSide {
  const lower = path.toLocaleLowerCase('en-US');
  if (lower.includes('/serverconfig/') || /-server\.[^/]+$/u.test(lower)) return 'server';
  if (/-client\.[^/]+$/u.test(lower)) return 'client';
  if (/-common\.[^/]+$/u.test(lower)) return 'both';
  return 'unknown';
}

function formatOf(path: string): 'toml' | 'json' | null {
  const lower = path.toLocaleLowerCase('en-US');
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.json')) return 'json';
  return null;
}

function datapackLocation(path: string): DatapackLocation | null {
  const segments = path.split('/');
  const lower = segments.map((segment) => segment.toLocaleLowerCase('en-US'));
  if (lower[0] === 'config' && lower[1] === 'openloader' && lower[2] === 'data') {
    const name = segments[3];
    if (name === undefined) return null;
    return {
      name,
      loader: 'openloader',
      rootPath: segments.slice(0, 4).join('/'),
      insidePath: segments.slice(4).join('/'),
    };
  }
  if (lower[0] === 'world' && lower[1] === 'datapacks') {
    const name = segments[2];
    if (name === undefined) return null;
    return {
      name,
      loader: 'minecraft',
      rootPath: segments.slice(0, 3).join('/'),
      insidePath: segments.slice(3).join('/'),
    };
  }
  if (lower[0] === 'datapacks') {
    const name = segments[1];
    if (name === undefined) return null;
    return {
      name,
      loader: 'minecraft',
      rootPath: segments.slice(0, 2).join('/'),
      insidePath: segments.slice(2).join('/'),
    };
  }
  if (lower[0] === 'kubejs' && lower[1] === 'data') {
    return {
      name: 'KubeJS data',
      loader: 'kubejs',
      rootPath: 'kubejs',
      insidePath: segments.slice(1).join('/'),
    };
  }
  return null;
}

function resourceCoordinates(insidePath: string): {
  readonly namespace: string;
  readonly resourceType: string;
  readonly resourcePath: string;
} | null {
  const segments = insidePath.split('/');
  if (segments[0]?.toLocaleLowerCase('en-US') !== 'data') return null;
  const namespace = segments[1];
  const resourceType = segments[2];
  if (namespace === undefined || resourceType === undefined || segments.length < 4) return null;
  return {
    namespace: namespace.toLocaleLowerCase('en-US'),
    resourceType: resourceType.toLocaleLowerCase('en-US'),
    resourcePath: segments.slice(3).join('/'),
  };
}

function confidenceRank(value: AnalysisConfidence): number {
  return value === 'high' ? 3 : value === 'medium' ? 2 : value === 'low' ? 1 : 0;
}

function statusRank(value: KnowledgeStatus): number {
  return value === 'detected' ? 3 : value === 'interpreted' ? 2 : value === 'inferred' ? 1 : 0;
}

function sameConfigurationValue(
  left: ClassConfigurationDefinition['defaultValue'],
  right: ClassConfigurationDefinition['defaultValue'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function valueMatchesField(
  value: ClassConfigurationDefinition['defaultValue'],
  fieldType: InferredForm['fields'][number]['type'],
): value is NonNullable<ClassConfigurationDefinition['defaultValue']> {
  if (value === null) return false;
  if (fieldType === 'boolean') return typeof value === 'boolean';
  if (fieldType === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (fieldType === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (fieldType === 'string') return typeof value === 'string';
  if (!Array.isArray(value)) return false;
  if (fieldType === 'boolean-list') return value.every((entry) => typeof entry === 'boolean');
  if (fieldType === 'number-list') return value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
  return value.every((entry) => typeof entry === 'string');
}

function isRegistryInvocation(invocation: ClassInvocation): boolean {
  const text = `${invocation.owner}/${invocation.name}`.toLocaleLowerCase('en-US');
  return (
    text.includes('/registry') ||
    text.includes('/registries') ||
    text.includes('deferredregister') ||
    text.includes('registryobject') ||
    /\/(?:getregistry|getvalue|register|registerall)$/u.test(text)
  );
}

function isCompatibilityClass(entry: string): boolean {
  return /(?:^|\/)(?:compat|compatibility|integration|integrations|plugin|plugins)(?:\/|[^/]*)/iu.test(entry);
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export interface AnalyzeEcosystemPlan {
  readonly root: string;
  readonly inventory: WorkspaceInventory;
  readonly generatedAt?: Date;
}

/**
 * Builds one evidence-backed semantic snapshot from an existing inventory.
 *
 * The inventory remains the source of truth for paths, hashes and declared
 * mods. This service adds meaning on top and records exactly which rule did so;
 * it does not rescan the tree, execute classes, edit a file or apply a change.
 */
export class EcosystemAnalysisService {
  public async analyze(plan: AnalyzeEcosystemPlan): Promise<EcosystemAnalysis> {
    if (!isAbsolute(plan.root)) throw new EcosystemAnalysisError('invalid-root');
    const rootInfo = await stat(plan.root).catch(() => null);
    if (rootInfo === null || !rootInfo.isDirectory()) {
      throw new EcosystemAnalysisError('invalid-root');
    }

    const evidence = new Map<string, AnalysisEvidence>();
    const issues: EcosystemAnalysisIssue[] = [];
    const configurations: AnalyzedConfiguration[] = [];
    const datapacks: AnalyzedDatapack[] = [];
    const datapackResources: AnalyzedDatapackResource[] = [];
    const systems = new Map<string, SystemDraft>();
    const relationships = new Map<string, RelationshipDraft>();
    const archiveEntries = new Map<string, ReadonlySet<string>>();
    const archiveDirectories = new Map<string, readonly ZipEntry[]>();
    const bytecodeDefinitions = new Map<string, Map<string, BytecodeDefinitionFact[]>>();
    const filesByPath = new Map(plan.inventory.files.map((file) => [file.path, file]));
    const mods = new Map<string, ModDraft>();

    for (const source of plan.inventory.mods) {
      const current = mods.get(source.modId);
      if (current !== undefined) {
        const issueId = stableId('issue', 'duplicate-mod-id', source.modId, source.archivePath);
        issues.push({
          issueId,
          severity: 'blocker',
          code: 'duplicate-mod-id',
          detail: 'More than one installed artifact declares this mod id.',
          subjectId: source.modId,
          evidenceIds: [],
        });
        current.issueIds.add(issueId);
        continue;
      }
      mods.set(source.modId, {
        source,
        configurationIds: new Set(),
        systemIds: new Set(),
        datapackIds: new Set(),
        relationshipIds: new Set(),
        issueIds: new Set(),
        evidenceIds: new Set(),
        archiveIndexed: false,
      });
    }

    const addEvidence = (input: {
      readonly source: EvidenceSource;
      readonly sourcePath: string;
      readonly sha256?: string | null;
      readonly detail: string;
      readonly status: KnowledgeStatus;
      readonly confidence: AnalysisConfidence;
    }): string => {
      const evidenceId = stableId(
        'evidence',
        input.source,
        input.sourcePath,
        input.sha256 ?? '',
        input.detail,
        input.status,
        input.confidence,
      );
      evidence.set(evidenceId, {
        evidenceId,
        source: input.source,
        sourcePath: input.sourcePath,
        sha256: input.sha256 ?? null,
        detail: input.detail,
        status: input.status,
        confidence: input.confidence,
      });
      return evidenceId;
    };

    const addRelationship = (input: {
      readonly from: { readonly type: EcosystemEntityType; readonly id: string };
      readonly to: { readonly type: EcosystemEntityType; readonly id: string };
      readonly type: EcosystemRelationshipType;
      readonly systemId?: string | null;
      readonly reason: string;
      readonly status: KnowledgeStatus;
      readonly confidence: AnalysisConfidence;
      readonly evidenceIds: readonly string[];
    }): string => {
      const relationshipId = stableId(
        'relationship',
        input.from.type,
        input.from.id,
        input.type,
        input.to.type,
        input.to.id,
        input.systemId ?? '',
      );
      const existing = relationships.get(relationshipId);
      if (existing !== undefined) {
        for (const evidenceId of input.evidenceIds) existing.evidenceIds.add(evidenceId);
        return relationshipId;
      }
      relationships.set(relationshipId, {
        relationshipId,
        from: input.from,
        to: input.to,
        type: input.type,
        systemId: input.systemId ?? null,
        reason: input.reason,
        status: input.status,
        confidence: input.confidence,
        evidenceIds: new Set(input.evidenceIds),
      });
      return relationshipId;
    };

    const ensureSystem = (
      modId: string,
      classification: SystemClassification,
      evidenceId: string,
    ): SystemDraft => {
      const systemId = `system:${modId}:${classification.slug}`;
      let system = systems.get(systemId);
      if (system === undefined) {
        system = {
          systemId,
          modId,
          slug: classification.slug,
          title: classification.title,
          status: classification.status,
          confidence: classification.confidence,
          configurationIds: new Set(),
          datapackResourceIds: new Set(),
          relationshipIds: new Set(),
          evidenceIds: new Set(),
        };
        systems.set(systemId, system);
        const relationshipId = addRelationship({
          from: { type: 'Mod', id: modId },
          to: { type: 'System', id: systemId },
          type: 'OWNS',
          systemId,
          reason: 'The analyzed mod has fields or resources classified in this system.',
          status: classification.status,
          confidence: classification.confidence,
          evidenceIds: [evidenceId],
        });
        system.relationshipIds.add(relationshipId);
        mods.get(modId)?.relationshipIds.add(relationshipId);
      }
      if (statusRank(classification.status) > statusRank(system.status)) {
        system.status = classification.status;
      }
      if (confidenceRank(classification.confidence) > confidenceRank(system.confidence)) {
        system.confidence = classification.confidence;
      }
      system.evidenceIds.add(evidenceId);
      mods.get(modId)?.systemIds.add(systemId);
      return system;
    };

    // Archive entry names are used only to prove whether a datapack path
    // replaces a resource the installed mod already contains. Content is not
    // expanded and a capacity refusal becomes an explicit partial-analysis issue.
    for (const mod of mods.values()) {
      const file = filesByPath.get(mod.source.archivePath);
      if (file === undefined || file.sizeBytes > DEFAULT_ARTIFACT_INSPECTION_LIMITS.maximumArchiveBytes) {
        const issueId = stableId('issue', 'artifact-index-unavailable', mod.source.modId);
        issues.push({
          issueId,
          severity: 'warning',
          code: 'artifact-index-unavailable',
          detail: 'The artifact could not be structurally indexed within the reviewed limit.',
          subjectId: mod.source.modId,
          evidenceIds: [],
        });
        mod.issueIds.add(issueId);
        continue;
      }
      try {
        const content = await readFile(safeAbsolute(plan.root, mod.source.archivePath));
        const directory = readZipDirectory(Buffer.from(content), DEFAULT_ARTIFACT_INSPECTION_LIMITS);
        const entries = directory.entries
          .filter((entry) => !entry.isDirectory)
          .map((entry) => entry.name);
        archiveEntries.set(mod.source.archivePath, new Set(entries));
        archiveDirectories.set(mod.source.archivePath, directory.entries);
        mod.archiveIndexed = true;
        const evidenceId = addEvidence({
          source: 'archive-entry',
          sourcePath: mod.source.archivePath,
          sha256: mod.source.archiveSha256,
          detail: `Safely indexed ${String(entries.length)} archive entry names without expansion.`,
          status: 'detected',
          confidence: 'high',
        });
        mod.evidenceIds.add(evidenceId);
      } catch {
        const issueId = stableId('issue', 'artifact-index-unavailable', mod.source.modId);
        issues.push({
          issueId,
          severity: 'warning',
          code: 'artifact-index-unavailable',
          detail: 'The artifact index was unreadable; embedded resources remain unknown.',
          subjectId: mod.source.modId,
          evidenceIds: [],
        });
        mod.issueIds.add(issueId);
      }
    }

    // Deep inspection stays selective: only class entries whose path declares
    // a high-signal concern are expanded, under per-archive and global budgets.
    // Class files are parsed as data; they are never linked, loaded or run.
    const modsByArchive = new Map<string, ModDraft[]>();
    for (const mod of mods.values()) {
      const entries = modsByArchive.get(mod.source.archivePath) ?? [];
      entries.push(mod);
      modsByArchive.set(mod.source.archivePath, entries);
    }
    const classOwners = new Map<string, string | null>();
    for (const [archivePath, entries] of archiveEntries) {
      const archiveMods = modsByArchive.get(archivePath) ?? [];
      const owner = archiveMods.length === 1 ? archiveMods[0]?.source.modId ?? null : null;
      for (const entry of entries) {
        if (!entry.endsWith('.class')) continue;
        const name = entry.slice(0, -'.class'.length);
        if (!classOwners.has(name)) classOwners.set(name, owner);
        else if (classOwners.get(name) !== owner) classOwners.set(name, null);
      }
    }

    const deepSources = [...modsByArchive.values()]
      .filter((archiveMods) => archiveMods.length === 1)
      .map((archiveMods) => archiveMods[0])
      .filter((mod): mod is ModDraft => mod !== undefined)
      .sort((left, right) => {
        const priority = Number(right.source.configurationCandidates.length > 0) - Number(left.source.configurationCandidates.length > 0);
        return priority !== 0 ? priority : compare(left.source.modId, right.source.modId);
      });
    let remainingBytecodeBytes = MAXIMUM_TOTAL_BYTECODE_BYTES;
    for (const mod of deepSources) {
      const directory = archiveDirectories.get(mod.source.archivePath);
      if (directory === undefined) continue;
      if (remainingBytecodeBytes < 1) {
        const issueId = stableId('issue', 'bytecode-analysis-budget-exhausted', mod.source.modId);
        issues.push({
          issueId,
          severity: 'information',
          code: 'bytecode-analysis-budget-exhausted',
          detail: 'The snapshot-wide class inspection budget was exhausted before this artifact.',
          subjectId: mod.source.modId,
          evidenceIds: [],
        });
        mod.issueIds.add(issueId);
        continue;
      }
      try {
        const content = await readFile(safeAbsolute(plan.root, mod.source.archivePath));
        const deep = inspectArchiveBytecode({
          content,
          entries: directory,
          limits: {
            maximumExpandedBytes: Math.min(
              DEFAULT_ARCHIVE_BYTECODE_LIMITS.maximumExpandedBytes,
              remainingBytecodeBytes,
            ),
          },
        });
        remainingBytecodeBytes -= deep.expandedBytes;
        if (deep.eligibleClasses === 0) continue;
        const summaryEvidenceId = addEvidence({
          source: 'class-bytecode',
          sourcePath: mod.source.archivePath,
          sha256: mod.source.archiveSha256,
          detail: `Statically parsed ${String(deep.inspectedClasses.length)} of ${String(deep.eligibleClasses)} high-signal class file(s) within ${String(deep.expandedBytes)} expanded byte(s).`,
          status: 'detected',
          confidence: 'high',
        });
        mod.evidenceIds.add(summaryEvidenceId);
        if (deep.limited) {
          const issueId = stableId('issue', 'bytecode-analysis-limited', mod.source.modId);
          issues.push({
            issueId,
            severity: 'information',
            code: 'bytecode-analysis-limited',
            detail: `${String(deep.refusedClasses)} high-signal class file(s) exceeded a parser or expansion limit.`,
            subjectId: mod.source.modId,
            evidenceIds: [summaryEvidenceId],
          });
          mod.issueIds.add(issueId);
        }

        const definitionsByPath = bytecodeDefinitions.get(mod.source.modId) ?? new Map<string, BytecodeDefinitionFact[]>();
        const relationGroups = new Map<string, BytecodeRelationGroup>();
        const addRelationFact = (input: {
          readonly targetModId: string;
          readonly type: BytecodeRelationGroup['type'];
          readonly classification: SystemClassification;
          readonly evidenceId: string;
        }): void => {
          const key = `${input.targetModId}\u0000${input.type}\u0000${input.classification.slug}`;
          const group = relationGroups.get(key) ?? {
            targetModId: input.targetModId,
            type: input.type,
            classification: input.classification,
            evidenceIds: [],
            count: 0,
          };
          group.count += 1;
          if (group.evidenceIds.length < 32) group.evidenceIds.push(input.evidenceId);
          relationGroups.set(key, group);
        };

        for (const inspectedClass of deep.inspectedClasses) {
          for (const definition of inspectedClass.report.configurationDefinitions) {
            const evidenceId = addEvidence({
              source: 'class-bytecode',
              sourcePath: `${mod.source.archivePath}!/${inspectedClass.entry}#${definition.methodName}@${String(definition.offset)}`,
              sha256: mod.source.archiveSha256,
              detail: `ForgeConfigSpec.${definition.type} definition declares ${definition.path}${definition.defaultValue === null ? '' : ' with a literal default'}${definition.minimum === null || definition.maximum === null ? '' : ' and literal bounds'}.`,
              status: 'detected',
              confidence: 'high',
            });
            const facts = definitionsByPath.get(definition.path) ?? [];
            facts.push({ definition, entry: inspectedClass.entry, evidenceId });
            definitionsByPath.set(definition.path, facts);
            mod.evidenceIds.add(evidenceId);
            const classification = classifySystem({
              path: `${definition.path} ${definition.fieldName ?? ''} ${inspectedClass.entry}`,
              documentation: definition.comment === null ? [] : [definition.comment],
            });
            ensureSystem(mod.source.modId, classification, evidenceId);
          }

          for (const invocation of inspectedClass.report.invocations) {
            const classification = classifySystem({
              path: `${inspectedClass.entry} ${invocation.owner} ${invocation.name}`,
            });
            const targetModId = classOwners.get(invocation.owner);
            const registry = isRegistryInvocation(invocation);
            if (registry) {
              const evidenceId = addEvidence({
                source: 'class-bytecode',
                sourcePath: `${mod.source.archivePath}!/${inspectedClass.entry}#${invocation.methodName}@${String(invocation.offset)}`,
                sha256: mod.source.archiveSha256,
                detail: `Bytecode invokes registry-related member ${invocation.owner}.${invocation.name}${invocation.descriptor}.`,
                status: 'detected',
                confidence: 'high',
              });
              ensureSystem(mod.source.modId, classification, evidenceId);
              mod.evidenceIds.add(evidenceId);
              if (targetModId !== undefined && targetModId !== null && targetModId !== mod.source.modId) {
                addRelationFact({ targetModId, type: 'READS_REGISTRY_FROM', classification, evidenceId });
              }
              continue;
            }
            if (targetModId === undefined || targetModId === null || targetModId === mod.source.modId) continue;
            const evidenceId = addEvidence({
              source: 'class-bytecode',
              sourcePath: `${mod.source.archivePath}!/${inspectedClass.entry}#${invocation.methodName}@${String(invocation.offset)}`,
              sha256: mod.source.archiveSha256,
              detail: `Bytecode invokes ${invocation.owner}.${invocation.name}${invocation.descriptor}, whose class is provided by ${targetModId}.`,
              status: 'detected',
              confidence: 'high',
            });
            addRelationFact({
              targetModId,
              type: isCompatibilityClass(inspectedClass.entry) ? 'COMPATIBILITY' : 'INTEGRATES_WITH',
              classification,
              evidenceId,
            });
          }

          for (const annotation of inspectedClass.report.annotations) {
            if (annotation.descriptor !== 'Lorg/spongepowered/asm/mixin/Mixin;') continue;
            for (const targetClass of [...annotation.classValues, ...annotation.stringValues.map((value) => value.replaceAll('.', '/'))]) {
              const classification = classifySystem({ path: `${inspectedClass.entry} ${targetClass}` });
              const evidenceId = addEvidence({
                source: 'class-bytecode',
                sourcePath: `${mod.source.archivePath}!/${inspectedClass.entry}`,
                sha256: mod.source.archiveSha256,
                detail: `Mixin annotation targets ${targetClass}.`,
                status: 'detected',
                confidence: 'high',
              });
              ensureSystem(mod.source.modId, classification, evidenceId);
              mod.evidenceIds.add(evidenceId);
              const targetModId = classOwners.get(targetClass);
              if (targetModId !== undefined && targetModId !== null && targetModId !== mod.source.modId) {
                addRelationFact({ targetModId, type: 'MODIFIES_GAMEPLAY_OF', classification, evidenceId });
              }
            }
          }
        }
        bytecodeDefinitions.set(mod.source.modId, definitionsByPath);
        for (const group of relationGroups.values()) {
          const firstEvidenceId = group.evidenceIds[0];
          if (firstEvidenceId === undefined) continue;
          const system = ensureSystem(mod.source.modId, group.classification, firstEvidenceId);
          const relationshipId = addRelationship({
            from: { type: 'Mod', id: mod.source.modId },
            to: { type: 'Mod', id: group.targetModId },
            type: group.type,
            systemId: system.systemId,
            reason: `${String(group.count)} static bytecode fact(s) prove this directed relationship in ${group.classification.title}.`,
            status: 'detected',
            confidence: 'high',
            evidenceIds: group.evidenceIds,
          });
          mod.relationshipIds.add(relationshipId);
          mods.get(group.targetModId)?.relationshipIds.add(relationshipId);
          system.relationshipIds.add(relationshipId);
        }
      } catch {
        const issueId = stableId('issue', 'bytecode-analysis-unavailable', mod.source.modId);
        issues.push({
          issueId,
          severity: 'warning',
          code: 'bytecode-analysis-unavailable',
          detail: 'High-signal class files could not be read within the reviewed static-analysis limits.',
          subjectId: mod.source.modId,
          evidenceIds: [],
        });
        mod.issueIds.add(issueId);
      }
    }

    // Declared dependencies are the highest-confidence mod-to-mod relations in
    // this slice. Functional relations are added separately from resource
    // evidence and never inferred from this declaration alone.
    for (const mod of mods.values()) {
      for (const dependency of mod.source.dependencies) {
        const target = dependency.target.toLocaleLowerCase('en-US');
        if (BUILTIN_DEPENDENCIES.has(target)) continue;
        const evidenceId = addEvidence({
          source: 'artifact-metadata',
          sourcePath: `${mod.source.archivePath}!/${dependency.evidence}`,
          sha256: mod.source.archiveSha256,
          detail: `${dependency.mandatory ? 'Mandatory' : 'Optional'} dependency on ${target}${
            dependency.versionRange === null ? '' : ` ${dependency.versionRange}`
          } (${dependency.side}).`,
          status: 'detected',
          confidence: 'high',
        });
        const relationshipId = addRelationship({
          from: { type: 'Mod', id: mod.source.modId },
          to: { type: 'Mod', id: target },
          type: dependency.mandatory ? 'REQUIRES' : 'OPTIONAL_DEPENDENCY',
          reason: 'Declared in the installed artifact metadata.',
          status: 'detected',
          confidence: 'high',
          evidenceIds: [evidenceId],
        });
        mod.relationshipIds.add(relationshipId);
        mod.evidenceIds.add(evidenceId);
        mods.get(target)?.relationshipIds.add(relationshipId);
      }
    }

    // Embedded data in another installed mod's namespace is functional
    // evidence, independent of metadata. The path proves the direction:
    // source artifact -> target namespace. Exact path matches are overrides;
    // otherwise the source extends the target's data surface. Names and
    // filenames are never used to invent a compatibility relation.
    for (const source of mods.values()) {
      const entries = archiveEntries.get(source.source.archivePath);
      if (entries === undefined) continue;
      const grouped = new Map<
        string,
        {
          readonly targetModId: string;
          readonly effect: 'OVERRIDES' | 'DATAPACK_EXTENDS';
          readonly classification: SystemClassification;
          readonly evidenceIds: string[];
          count: number;
        }
      >();
      for (const entry of entries) {
        const coordinates = resourceCoordinates(entry);
        if (coordinates === null || coordinates.namespace === source.source.modId) continue;
        const target = mods.get(coordinates.namespace);
        if (target === undefined || target.source.archivePath === source.source.archivePath) continue;
        const targetEntries = archiveEntries.get(target.source.archivePath);
        const effect = targetEntries?.has(entry) === true ? 'OVERRIDES' : 'DATAPACK_EXTENDS';
        const classification = classifySystem({
          resourceType: coordinates.resourceType,
          path: coordinates.resourcePath,
        });
        const key = `${target.source.modId}\u0000${effect}\u0000${classification.slug}`;
        let group = grouped.get(key);
        if (group === undefined) {
          group = {
            targetModId: target.source.modId,
            effect,
            classification,
            evidenceIds: [],
            count: 0,
          };
          grouped.set(key, group);
        }
        group.count += 1;
        if (group.evidenceIds.length < 32) {
          group.evidenceIds.push(addEvidence({
            source: 'archive-entry',
            sourcePath: `${source.source.archivePath}!/${entry}`,
            sha256: source.source.archiveSha256,
            detail: `Embedded resource targets the installed ${target.source.modId} namespace.`,
            status: 'detected',
            confidence: 'high',
          }));
        }
      }
      for (const group of grouped.values()) {
        const firstEvidence = group.evidenceIds[0];
        if (firstEvidence === undefined) continue;
        const system = ensureSystem(group.targetModId, group.classification, firstEvidence);
        const relationshipId = addRelationship({
          from: { type: 'Mod', id: source.source.modId },
          to: { type: 'Mod', id: group.targetModId },
          type: group.effect,
          systemId: system.systemId,
          reason: `${String(group.count)} embedded resource path(s) ${
            group.effect === 'OVERRIDES'
              ? 'match the target artifact exactly'
              : 'extend the target namespace'
          } in ${group.classification.title}.`,
          status: 'detected',
          confidence: 'high',
          evidenceIds: group.evidenceIds,
        });
        source.relationshipIds.add(relationshipId);
        mods.get(group.targetModId)?.relationshipIds.add(relationshipId);
        for (const evidenceId of group.evidenceIds) source.evidenceIds.add(evidenceId);
      }
    }

    for (const mod of mods.values()) {
      for (const candidate of mod.source.configurationCandidates) {
        const file = filesByPath.get(candidate.path);
        if (file === undefined || file.sizeBytes > MAXIMUM_CONFIGURATION_BYTES) {
          const issueId = stableId('issue', 'configuration-unreadable', mod.source.modId, candidate.path);
          issues.push({
            issueId,
            severity: 'warning',
            code: 'configuration-unreadable',
            detail: 'A matched configuration file could not be read within the configured limit.',
            subjectId: mod.source.modId,
            evidenceIds: [],
          });
          mod.issueIds.add(issueId);
          continue;
        }
        const format = formatOf(candidate.path);
        if (format === null) continue;

        let form: InferredForm;
        try {
          const content = await readFile(safeAbsolute(plan.root, candidate.path), 'utf8');
          form = inferForm({ format, content });
        } catch {
          const issueId = stableId('issue', 'configuration-unreadable', mod.source.modId, candidate.path);
          issues.push({
            issueId,
            severity: 'warning',
            code: 'configuration-unreadable',
            detail: 'The configuration parser refused this file.',
            subjectId: mod.source.modId,
            evidenceIds: [],
          });
          mod.issueIds.add(issueId);
          continue;
        }

        const ownershipConfidence: AnalysisConfidence =
          candidate.rule === 'reviewed-resource'
            ? 'high'
            : candidate.rule === 'serverconfig-file-by-mod-alias'
              ? 'medium'
              : 'high';
        const fileEvidenceId = addEvidence({
          source: candidate.rule === 'reviewed-resource' ? 'workspace-file' : 'path-convention',
          sourcePath: candidate.path,
          sha256: file.sha256,
          detail: `Configuration ownership matched by ${candidate.rule}.`,
          status: candidate.rule === 'reviewed-resource' ? 'detected' : 'interpreted',
          confidence: ownershipConfidence,
        });
        mod.evidenceIds.add(fileEvidenceId);

        for (const field of form.fields) {
          const classification = classifySystem({
            path: field.path,
            documentation: field.documentation,
          });
          const systemEvidenceId = addEvidence({
            source: 'analysis-rule',
            sourcePath: `${candidate.path}#${field.path}`,
            sha256: file.sha256,
            detail: `Grouped by ${classification.ruleId}.`,
            status: classification.status,
            confidence: classification.confidence,
          });
          const system = ensureSystem(mod.source.modId, classification, systemEvidenceId);
          const configurationId = stableId('configuration', mod.source.modId, candidate.path, field.path);
          const allowedValues = field.constraints.flatMap((constraint) =>
            constraint.kind === 'allowed-values' ? [...constraint.values] : [],
          );
          const constraints: Array<AnalyzedConfiguration['constraints'][number]> = field.constraints.map((constraint) =>
            constraint.kind === 'range'
              ? {
                  kind: 'range' as const,
                  minimum: constraint.minimum,
                  maximum: constraint.maximum,
                  source: constraint.source,
                }
              : {
                  kind: 'allowed-values' as const,
                  values: [...constraint.values],
                  source: constraint.source,
                },
          );
          const definitionFacts = bytecodeDefinitions.get(mod.source.modId)?.get(field.path) ?? [];
          const literalDefinitions = definitionFacts.filter((fact) =>
            valueMatchesField(fact.definition.defaultValue, field.type),
          );
          const firstLiteralDefault = literalDefinitions[0]?.definition.defaultValue ?? null;
          const defaultValue = firstLiteralDefault !== null && literalDefinitions.every((fact) =>
            sameConfigurationValue(fact.definition.defaultValue, firstLiteralDefault),
          ) ? firstLiteralDefault : null;
          if (
            firstLiteralDefault !== null &&
            literalDefinitions.some((fact) => !sameConfigurationValue(fact.definition.defaultValue, firstLiteralDefault))
          ) {
            const issueId = stableId('issue', 'configuration-default-conflict', mod.source.modId, candidate.path, field.path);
            issues.push({
              issueId,
              severity: 'warning',
              code: 'configuration-default-conflict',
              detail: 'More than one static definition declares a different default; no default was selected.',
              subjectId: configurationId,
              evidenceIds: literalDefinitions.map((fact) => fact.evidenceId),
            });
            mod.issueIds.add(issueId);
          }
          if (!constraints.some((constraint) => constraint.kind === 'range')) {
            const ranges = definitionFacts.filter((fact) =>
              fact.definition.minimum !== null && fact.definition.maximum !== null,
            );
            const firstRange = ranges[0]?.definition;
            if (
              firstRange?.minimum !== null && firstRange?.minimum !== undefined &&
              firstRange.maximum !== null &&
              ranges.every((fact) =>
                fact.definition.minimum === firstRange.minimum && fact.definition.maximum === firstRange.maximum,
              )
            ) {
              constraints.push({
                kind: 'range',
                minimum: firstRange.minimum,
                maximum: firstRange.maximum,
                source: 'declared',
              });
            }
          }
          const definitionComments = [...new Set(definitionFacts.flatMap((fact) =>
            fact.definition.comment === null ? [] : [fact.definition.comment],
          ))].sort(compare);
          const fieldEvidenceId = addEvidence({
            source: field.documentation.length > 0 || field.constraints.length > 0
              ? 'forge-comment'
              : 'workspace-file',
            sourcePath: `${candidate.path}#L${String(field.line)}`,
            sha256: file.sha256,
            detail: `Parsed ${field.path} as ${field.type}; ${String(field.constraints.length)} declared constraint(s).`,
            status: 'detected',
            confidence: 'high',
          });
          const configuration: AnalyzedConfiguration = {
            configurationId,
            modId: mod.source.modId,
            systemId: system.systemId,
            name: field.path.split('.').at(-1) ?? field.path,
            description: field.documentation.length > 0
              ? field.documentation.join(' ')
              : definitionComments.length === 1
                ? definitionComments[0] ?? null
                : null,
            category: system.title,
            type: field.type === 'string' && allowedValues.length > 0 ? 'enum' : field.type,
            currentValue: field.value,
            defaultValue,
            constraints,
            allowedValues,
            source: {
              file: candidate.path,
              path: field.path,
              line: field.line,
              format: form.format,
              parser: `configuration-inference/${form.format}`,
            },
            side: sideOf(candidate.path),
            // Forge can reload some specs, but whether a mod consumes the
            // reload event is not present in the generated file.
            restartRequired: null,
            editable: form.complete,
            status: 'detected',
            confidence: ownershipConfidence,
            evidenceIds: Object.freeze([
              fileEvidenceId,
              fieldEvidenceId,
              systemEvidenceId,
              ...definitionFacts.map((fact) => fact.evidenceId),
            ].sort(compare)),
          };
          configurations.push(configuration);
          mod.configurationIds.add(configurationId);
          system.configurationIds.add(configurationId);
          for (const fact of definitionFacts) system.evidenceIds.add(fact.evidenceId);

          const ownsId = addRelationship({
            from: { type: 'System', id: system.systemId },
            to: { type: 'Configuration', id: configurationId },
            type: 'OWNS',
            systemId: system.systemId,
            reason: 'The field was classified into this functional system.',
            status: classification.status,
            confidence: classification.confidence,
            evidenceIds: [systemEvidenceId, fieldEvidenceId],
          });
          const definedInId = addRelationship({
            from: { type: 'Configuration', id: configurationId },
            to: { type: 'ConfigFile', id: `file:${sha256(candidate.path).slice(0, 24)}` },
            type: 'DEFINED_IN',
            systemId: system.systemId,
            reason: 'The parser read this field from the cited file and path.',
            status: 'detected',
            confidence: 'high',
            evidenceIds: [fieldEvidenceId],
          });
          system.relationshipIds.add(ownsId);
          system.relationshipIds.add(definedInId);
          mod.relationshipIds.add(ownsId);
          mod.relationshipIds.add(definedInId);
        }

        if (!form.complete) {
          const issueId = stableId('issue', 'configuration-partial', mod.source.modId, candidate.path);
          issues.push({
            issueId,
            severity: 'warning',
            code: 'configuration-partial',
            detail: `${String(form.issues.length)} line(s) were not safely represented; semantic editing is disabled.`,
            subjectId: mod.source.modId,
            evidenceIds: [fileEvidenceId],
          });
          mod.issueIds.add(issueId);
        }
      }
    }

    const groupedDatapackFiles = new Map<
      string,
      { readonly location: DatapackLocation; readonly files: WorkspaceFile[] }
    >();
    for (const file of plan.inventory.files) {
      if (file.role !== 'datapack') continue;
      const location = datapackLocation(file.path);
      if (location === null) continue;
      const group = groupedDatapackFiles.get(location.rootPath);
      if (group === undefined) groupedDatapackFiles.set(location.rootPath, { location, files: [file] });
      else group.files.push(file);
    }

    for (const [rootPath, group] of [...groupedDatapackFiles].sort(([left], [right]) => compare(left, right))) {
      group.files.sort((left, right) => compare(left.path, right.path));
      const datapackId = stableId('datapack', rootPath);
      const packSha256 = sha256(group.files.map((file) => `${file.path}:${file.sha256}`).join('\n'));
      const packEvidenceId = addEvidence({
        source: 'workspace-file',
        sourcePath: rootPath,
        sha256: packSha256,
        detail: `${group.location.loader} datapack with ${String(group.files.length)} inventoried file(s).`,
        status: 'detected',
        confidence: 'high',
      });
      let description: string | null = null;
      const metadataFile = group.files.find((file) => file.path === `${rootPath}/pack.mcmeta`);
      if (metadataFile !== undefined && metadataFile.sizeBytes <= MAXIMUM_PACK_METADATA_BYTES) {
        try {
          const parsed = JSON.parse(
            await readFile(safeAbsolute(plan.root, metadataFile.path), 'utf8'),
          ) as { readonly pack?: { readonly description?: unknown } };
          if (typeof parsed.pack?.description === 'string') description = parsed.pack.description;
        } catch {
          // Metadata is optional for classification. The file remains cited by
          // the pack evidence and no description is invented from its folder.
        }
      }

      const resourceIds: string[] = [];
      const namespaces = new Set<string>();
      const relatedModIds = new Set<string>();
      const packIssueIds = new Set<string>();
      const relationEvidence = new Map<
        string,
        { readonly effect: 'overrides' | 'extends'; readonly evidenceIds: string[]; count: number }
      >();

      for (const file of group.files) {
        const location = datapackLocation(file.path);
        if (location === null) continue;
        const coordinates = resourceCoordinates(location.insidePath);
        if (coordinates === null) continue;
        namespaces.add(coordinates.namespace);
        const owner = mods.get(coordinates.namespace);
        const ownerModId = owner?.source.modId ?? null;
        if (ownerModId !== null) relatedModIds.add(ownerModId);
        const classification = classifySystem({
          resourceType: coordinates.resourceType,
          path: coordinates.resourcePath,
        });
        const resourceEvidenceId = addEvidence({
          source: 'datapack-resource',
          sourcePath: file.path,
          sha256: file.sha256,
          detail: `Resource ${coordinates.namespace}:${coordinates.resourceType}/${coordinates.resourcePath}.`,
          status: 'detected',
          confidence: 'high',
        });
        const systemEvidenceId = addEvidence({
          source: 'analysis-rule',
          sourcePath: file.path,
          sha256: file.sha256,
          detail: `Grouped by ${classification.ruleId}.`,
          status: classification.status,
          confidence: classification.confidence,
        });
        const resourceId = stableId('datapack-resource', file.path);
        resourceIds.push(resourceId);

        let effect: 'overrides' | 'extends' | 'unknown' = 'unknown';
        let systemId: string | null = null;
        if (owner !== undefined) {
          const system = ensureSystem(owner.source.modId, classification, systemEvidenceId);
          systemId = system.systemId;
          system.datapackResourceIds.add(resourceId);
          owner.datapackIds.add(datapackId);
          const entries = archiveEntries.get(owner.source.archivePath);
          effect =
            entries === undefined
              ? 'unknown'
              : entries.has(location.insidePath)
                ? 'overrides'
                : 'extends';
          const ownsResourceId = addRelationship({
            from: { type: 'Datapack', id: datapackId },
            to: { type: 'DatapackResource', id: resourceId },
            type: 'OWNS',
            systemId,
            reason: 'The resource path is contained by this inventoried datapack root.',
            status: 'detected',
            confidence: 'high',
            evidenceIds: [resourceEvidenceId],
          });
          const usesId = addRelationship({
            from: { type: 'System', id: system.systemId },
            to: { type: 'DatapackResource', id: resourceId },
            type: 'USES',
            systemId,
            reason: 'The resource namespace belongs to the mod and its path was classified in this system.',
            status: classification.status,
            confidence: classification.confidence,
            evidenceIds: [resourceEvidenceId, systemEvidenceId],
          });
          system.relationshipIds.add(ownsResourceId);
          system.relationshipIds.add(usesId);
          owner.relationshipIds.add(ownsResourceId);
          owner.relationshipIds.add(usesId);

          const relationKey = `${ownerModId}:${effect}`;
          const existing = relationEvidence.get(relationKey);
          if (existing === undefined && effect !== 'unknown') {
            relationEvidence.set(relationKey, {
              effect,
              evidenceIds: [resourceEvidenceId],
              count: 1,
            });
          } else if (existing !== undefined) {
            existing.count += 1;
            if (existing.evidenceIds.length < 64) existing.evidenceIds.push(resourceEvidenceId);
          }
        }

        datapackResources.push({
          resourceId,
          datapackId,
          namespace: coordinates.namespace,
          resourceType: coordinates.resourceType,
          resourcePath: coordinates.resourcePath,
          sourceFile: file.path,
          sha256: file.sha256,
          ownerModId,
          systemId,
          effect,
          status: ownerModId === null ? 'unknown' : effect === 'unknown' ? 'inferred' : 'detected',
          confidence: ownerModId === null ? 'unknown' : effect === 'unknown' ? 'low' : 'high',
          evidenceIds: Object.freeze([resourceEvidenceId, systemEvidenceId].sort(compare)),
        });
      }

      for (const [key, relation] of relationEvidence) {
        const ownerModId = key.slice(0, key.lastIndexOf(':'));
        const relationshipId = addRelationship({
          from: { type: 'Datapack', id: datapackId },
          to: { type: 'Mod', id: ownerModId },
          type: relation.effect === 'overrides' ? 'OVERRIDES' : 'DATAPACK_EXTENDS',
          reason: `${String(relation.count)} resource path(s) ${
            relation.effect === 'overrides'
              ? 'match resources in the installed artifact'
              : 'extend the installed mod namespace'
          }.`,
          status: 'detected',
          confidence: 'high',
          evidenceIds: relation.evidenceIds,
        });
        mods.get(ownerModId)?.relationshipIds.add(relationshipId);
      }

      const onlyOwner = relatedModIds.size === 1 ? [...relatedModIds][0] ?? null : null;
      datapacks.push({
        datapackId,
        name: group.location.name,
        loader: group.location.loader,
        rootPath,
        sha256: packSha256,
        description,
        resourceIds: Object.freeze(resourceIds.sort(compare)),
        namespaces: sorted(namespaces),
        ownerModId: onlyOwner,
        relatedModIds: sorted(relatedModIds),
        issueIds: sorted(packIssueIds),
        evidenceIds: Object.freeze([packEvidenceId]),
      });
    }

    const relationshipList: EcosystemRelationship[] = [...relationships.values()]
      .map((relationship) => ({
        ...relationship,
        evidenceIds: sorted(relationship.evidenceIds),
      }))
      .sort((left, right) => compare(left.relationshipId, right.relationshipId));
    const analyzedSystems: AnalyzedSystem[] = [...systems.values()]
      .map((system) => ({
        systemId: system.systemId,
        modId: system.modId,
        slug: system.slug,
        title: system.title,
        status: system.status,
        confidence: system.confidence,
        configurationIds: sorted(system.configurationIds),
        datapackResourceIds: sorted(system.datapackResourceIds),
        relationshipIds: sorted(system.relationshipIds),
        evidenceIds: sorted(system.evidenceIds),
      }))
      .sort((left, right) => compare(left.systemId, right.systemId));
    const analyzedMods: AnalyzedMod[] = [...mods.values()]
      .map((mod): AnalyzedMod => ({
        modId: mod.source.modId,
        displayName: mod.source.displayName,
        version: mod.source.version,
        loader: mod.source.loader,
        archivePath: mod.source.archivePath,
        archiveSha256: mod.source.archiveSha256,
        side: 'unknown',
        editLevel: mod.source.editLevel,
        configurationIds: sorted(mod.configurationIds),
        systemIds: sorted(mod.systemIds),
        datapackIds: sorted(mod.datapackIds),
        relationshipIds: sorted(mod.relationshipIds),
        issueIds: sorted(mod.issueIds),
        evidenceIds: sorted(mod.evidenceIds),
        analysisStatus:
          mod.configurationIds.size > 0 || mod.systemIds.size > 0
            ? mod.issueIds.size === 0
              ? 'complete'
              : 'partial'
            : mod.archiveIndexed
              ? 'partial'
              : 'unavailable',
      }))
      .sort((left, right) => compare(left.modId, right.modId));

    configurations.sort((left, right) => compare(left.configurationId, right.configurationId));
    datapacks.sort((left, right) => compare(left.datapackId, right.datapackId));
    datapackResources.sort((left, right) => compare(left.resourceId, right.resourceId));
    issues.sort((left, right) => compare(left.issueId, right.issueId));
    const evidenceList = [...evidence.values()].sort((left, right) =>
      compare(left.evidenceId, right.evidenceId),
    );

    const graphEntities = new Map<string, EcosystemGraphEntity>();
    const addEntity = (entity: EcosystemGraphEntity): void => {
      graphEntities.set(`${entity.type}:${entity.id}`, entity);
    };
    addEntity({
      id: `server:${plan.inventory.inventorySha256.slice(0, 24)}`,
      type: 'Server',
      label: 'Imported server workspace',
      modId: null,
      evidenceIds: [],
    });
    for (const mod of analyzedMods) {
      addEntity({
        id: mod.modId,
        type: 'Mod',
        label: mod.displayName ?? mod.modId,
        modId: mod.modId,
        evidenceIds: mod.evidenceIds,
      });
      addEntity({
        id: `mod-version:${mod.modId}:${mod.archiveSha256.slice(0, 12)}`,
        type: 'ModVersion',
        label: `${mod.displayName ?? mod.modId} ${mod.version ?? 'unknown version'}`,
        modId: mod.modId,
        evidenceIds: mod.evidenceIds,
      });
    }
    for (const system of analyzedSystems) {
      addEntity({
        id: system.systemId,
        type: 'System',
        label: system.title,
        modId: system.modId,
        evidenceIds: system.evidenceIds,
      });
    }
    const configFiles = new Map<string, { readonly modId: string; readonly evidenceIds: Set<string> }>();
    for (const configuration of configurations) {
      addEntity({
        id: configuration.configurationId,
        type: 'Configuration',
        label: configuration.name,
        modId: configuration.modId,
        evidenceIds: configuration.evidenceIds,
      });
      const fileId = `file:${sha256(configuration.source.file).slice(0, 24)}`;
      const file = configFiles.get(fileId) ?? {
        modId: configuration.modId,
        evidenceIds: new Set<string>(),
      };
      for (const evidenceId of configuration.evidenceIds) file.evidenceIds.add(evidenceId);
      configFiles.set(fileId, file);
    }
    for (const [fileId, file] of configFiles) {
      const path = configurations.find(
        (configuration) => `file:${sha256(configuration.source.file).slice(0, 24)}` === fileId,
      )?.source.file;
      addEntity({
        id: fileId,
        type: 'ConfigFile',
        label: path ?? fileId,
        modId: file.modId,
        evidenceIds: sorted(file.evidenceIds),
      });
    }
    for (const datapack of datapacks) {
      addEntity({
        id: datapack.datapackId,
        type: 'Datapack',
        label: datapack.name,
        modId: datapack.ownerModId,
        evidenceIds: datapack.evidenceIds,
      });
    }
    for (const resource of datapackResources) {
      addEntity({
        id: resource.resourceId,
        type: 'DatapackResource',
        label: `${resource.namespace}:${resource.resourceType}/${resource.resourcePath}`,
        modId: resource.ownerModId,
        evidenceIds: resource.evidenceIds,
      });
      const registryId = `registry:${resource.namespace}:${resource.resourceType}`;
      addEntity({
        id: registryId,
        type: 'Registry',
        label: `${resource.namespace}:${resource.resourceType}`,
        modId: resource.ownerModId,
        evidenceIds: resource.evidenceIds,
      });
    }
    for (const item of evidenceList) {
      addEntity({
        id: item.evidenceId,
        type: 'Evidence',
        label: item.detail,
        modId: null,
        evidenceIds: [item.evidenceId],
      });
    }

    const generatedAt = (plan.generatedAt ?? new Date()).toISOString();
    const analysisId = sha256(
      `${plan.inventory.inventorySha256}\u0000${ECOSYSTEM_ANALYZER_VERSION}`,
    );
    const result: EcosystemAnalysis = {
      schemaVersion: ECOSYSTEM_ANALYSIS_SCHEMA_VERSION,
      analyzerVersion: ECOSYSTEM_ANALYZER_VERSION,
      analysisId,
      inventorySha256: plan.inventory.inventorySha256,
      generatedAt,
      mods: analyzedMods,
      systems: analyzedSystems,
      configurations,
      datapacks,
      datapackResources,
      relationships: relationshipList,
      evidence: evidenceList,
      issues,
      graph: {
        entities: [...graphEntities.values()].sort((left, right) =>
          compare(`${left.type}:${left.id}`, `${right.type}:${right.id}`),
        ),
        relationshipIds: Object.freeze(relationshipList.map((relationship) => relationship.relationshipId)),
      },
      summary: {
        mods: analyzedMods.length,
        systems: analyzedSystems.length,
        configurations: configurations.length,
        datapacks: datapacks.length,
        datapackResources: datapackResources.length,
        relationships: relationshipList.length,
        issues: issues.length,
      },
    };
    return freezeDeep(result);
  }
}
