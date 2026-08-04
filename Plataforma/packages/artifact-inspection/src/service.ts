import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
  declaredEmbeddedLibraries,
  declaredModsFromFabric,
  declaredModsFromToml,
  parseJarManifest,
  parseModsToml,
} from './metadata.js';
import {
  ArtifactInspectionError,
  DEFAULT_ARTIFACT_INSPECTION_LIMITS,
  VOIDFALL_ARTIFACT_INSPECTION_FORMAT,
  VOIDFALL_ARTIFACT_INSPECTION_SCHEMA_VERSION,
  type ArtifactInspectionLimits,
  type ArtifactInspectionReport,
  type DeclaredLoader,
  type DeclaredMod,
  type EmbeddedLibrary,
} from './types.js';
import { readZipDirectory, readZipEntry, type ZipEntry } from './zip.js';

/**
 * Bounded artifact inspection.
 *
 * The service answers one question: what does this archive *declare*? It reads
 * the ZIP central directory and inflates only the known metadata descriptors.
 * It never loads a class, never executes an artifact, never opens a nested JAR
 * and never writes to disk. Compatibility judgement belongs to Phase 8.2.
 */

const SHA256 = /^[a-f0-9]{64}$/u;

// Closed set of descriptors this package will expand. Nothing else is read.
const MANIFEST_ENTRY = 'META-INF/MANIFEST.MF';
const FORGE_ENTRY = 'META-INF/mods.toml';
const NEOFORGE_ENTRY = 'META-INF/neoforge.mods.toml';
const FABRIC_ENTRY = 'fabric.mod.json';
const JARJAR_ENTRY = 'META-INF/jarjar/metadata.json';
const LEGACY_ENTRY = 'mcmod.info';

export interface InspectArtifactPlan {
  readonly content: Uint8Array;
  /** Optional expected digest; a mismatch refuses the inspection. */
  readonly expectedSha256?: string;
  readonly inspectedAt?: Date;
}

export interface ArtifactInspectionServiceOptions {
  readonly limits?: Partial<ArtifactInspectionLimits>;
  readonly clock?: () => Date;
}

function resolveLimits(overrides: Partial<ArtifactInspectionLimits> | undefined): ArtifactInspectionLimits {
  const limits = { ...DEFAULT_ARTIFACT_INSPECTION_LIMITS, ...(overrides ?? {}) };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ArtifactInspectionError('invalid-options', 'options');
    }
  }
  if (limits.maximumExpandedBytes < limits.maximumMetadataBytes) {
    throw new ArtifactInspectionError('invalid-options', 'options');
  }
  return Object.freeze(limits);
}

/** Case-insensitive lookup, because archives disagree about descriptor casing. */
function findEntry(entries: readonly ZipEntry[], name: string): ZipEntry | undefined {
  const wanted = name.toLowerCase();
  return entries.find((entry) => !entry.isDirectory && entry.name.toLowerCase() === wanted);
}

export class ArtifactInspectionService {
  readonly #limits: ArtifactInspectionLimits;
  readonly #clock: () => Date;

  public constructor(options: ArtifactInspectionServiceOptions = {}) {
    if (options === null || typeof options !== 'object') {
      throw new ArtifactInspectionError('invalid-options', 'options');
    }
    this.#limits = resolveLimits(options.limits);
    this.#clock = options.clock ?? (() => new Date());
  }

  public get limits(): ArtifactInspectionLimits {
    return this.#limits;
  }

  public inspect(plan: InspectArtifactPlan): ArtifactInspectionReport {
    if (
      plan === null ||
      typeof plan !== 'object' ||
      !(plan.content instanceof Uint8Array) ||
      (plan.expectedSha256 !== undefined &&
        (typeof plan.expectedSha256 !== 'string' || !SHA256.test(plan.expectedSha256)))
    ) {
      throw new ArtifactInspectionError('invalid-plan', 'plan');
    }
    const content = Buffer.from(
      plan.content.buffer,
      plan.content.byteOffset,
      plan.content.byteLength,
    );
    if (content.length > this.#limits.maximumArchiveBytes) {
      throw new ArtifactInspectionError('content-too-large', 'plan');
    }

    const sha256 = createHash('sha256').update(content).digest('hex');
    if (plan.expectedSha256 !== undefined && plan.expectedSha256 !== sha256) {
      throw new ArtifactInspectionError('hash-mismatch', 'plan');
    }

    const directory = readZipDirectory(content, this.#limits);
    const entries = directory.entries;
    const budget = { remaining: this.#limits.maximumExpandedBytes };
    const evidence: string[] = [];
    const metadataIssues: string[] = [];
    const loaders = new Set<DeclaredLoader>();
    const mods: DeclaredMod[] = [];
    let embeddedLibraries: readonly EmbeddedLibrary[] = Object.freeze([]);

    const read = (entry: ZipEntry): Buffer => readZipEntry(content, entry, this.#limits, budget);

    /**
     * Records a descriptor that exists but cannot be read within the strict
     * subset. An unreadable declaration is never silently dropped, because a
     * later phase must be able to treat it as unknown rather than absent.
     */
    const recordIssue = (name: string, error: unknown): void => {
      if (error instanceof ArtifactInspectionError && error.code === 'invalid-metadata') {
        metadataIssues.push(`${name}: unreadable within the reviewed subset`);
        return;
      }
      throw error;
    };

    let manifest: Readonly<Record<string, string>> = Object.freeze({});
    const manifestEntry = findEntry(entries, MANIFEST_ENTRY);
    if (manifestEntry !== undefined) {
      evidence.push(MANIFEST_ENTRY);
      try {
        manifest = parseJarManifest(read(manifestEntry));
      } catch (error) {
        recordIssue(MANIFEST_ENTRY, error);
      }
    }

    for (const [name, loader] of [
      [FORGE_ENTRY, 'forge'],
      [NEOFORGE_ENTRY, 'neoforge'],
    ] as const) {
      const entry = findEntry(entries, name);
      if (entry === undefined) continue;
      evidence.push(name);
      loaders.add(loader);
      try {
        const parsed = parseModsToml(read(entry));
        const declared = declaredModsFromToml(parsed, loader, name, manifest, this.#limits);
        if (declared.length === 0) {
          metadataIssues.push(`${name}: no recognized [[mods]] block`);
        }
        mods.push(...declared);
      } catch (error) {
        recordIssue(name, error);
      }
    }

    const fabricEntry = findEntry(entries, FABRIC_ENTRY);
    if (fabricEntry !== undefined) {
      evidence.push(FABRIC_ENTRY);
      // A Forge descriptor wins for loader attribution; a Fabric descriptor
      // alongside it is recorded as evidence without claiming the loader.
      if (loaders.size === 0) {
        loaders.add('fabric');
        try {
          mods.push(...declaredModsFromFabric(read(fabricEntry), FABRIC_ENTRY, this.#limits));
        } catch (error) {
          recordIssue(FABRIC_ENTRY, error);
        }
      } else {
        metadataIssues.push(`${FABRIC_ENTRY}: ignored because a Forge descriptor is present`);
      }
    }

    if (loaders.size === 0 && findEntry(entries, LEGACY_ENTRY) !== undefined) {
      evidence.push(LEGACY_ENTRY);
      loaders.add('legacy-mcmod');
      metadataIssues.push(`${LEGACY_ENTRY}: legacy descriptor has no reviewed parser`);
    }

    const jarJarEntry = findEntry(entries, JARJAR_ENTRY);
    if (jarJarEntry !== undefined) {
      evidence.push(JARJAR_ENTRY);
      try {
        embeddedLibraries = declaredEmbeddedLibraries(read(jarJarEntry), JARJAR_ENTRY, this.#limits);
      } catch (error) {
        recordIssue(JARJAR_ENTRY, error);
      }
    }

    if (loaders.size === 0) loaders.add('unknown');

    const names = entries.map((entry) => entry.name);
    const report: ArtifactInspectionReport = {
      format: VOIDFALL_ARTIFACT_INSPECTION_FORMAT,
      schemaVersion: VOIDFALL_ARTIFACT_INSPECTION_SCHEMA_VERSION,
      sha256,
      sizeBytes: content.length,
      inspectedAt: (plan.inspectedAt ?? this.#clock()).toISOString(),
      container: 'zip',
      entryCount: entries.length,
      expandedBytes: this.#limits.maximumExpandedBytes - budget.remaining,
      loaders: Object.freeze([...loaders].sort()),
      mods: Object.freeze(mods),
      embeddedLibraries,
      evidence: Object.freeze([...evidence].sort()),
      metadataIssues: Object.freeze([...metadataIssues].sort()),
      features: Object.freeze({
        containsClasses: names.some((name) => name.endsWith('.class')),
        containsData: names.some((name) => name.startsWith('data/')),
        containsAssets: names.some((name) => name.startsWith('assets/')),
        containsMixins: names.some((name) => /(^|\/)[^/]*mixins?[^/]*\.json$/u.test(name)),
        containsNestedJars: names.some((name) => name.endsWith('.jar')),
      }),
    };
    return Object.freeze(report);
  }
}
