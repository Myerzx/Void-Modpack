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
  type InspectionLayerResult,
} from './types.js';
import {
  readZipDirectory,
  readZipEntry,
  scanZipDirectoryFor,
  type ExpansionBudget,
  type ZipEntry,
} from './zip.js';

/**
 * Bounded artifact inspection, in layers.
 *
 * The service answers what an archive *declares*. It never loads a class,
 * never executes an artifact, never opens a nested JAR and never writes to
 * disk. Compatibility judgement belongs to Phase 8.2.
 *
 * What changed, and why: one set of limits used to gate everything, so an
 * artifact too large or too numerous for a full enumeration was refused before
 * anybody tried to read the four hundred bytes that identify it. A 122 MiB mod
 * then reported as declaring nothing — which is not what "we did not look"
 * means, and a pack builder cannot act on the difference if the report will not
 * state it.
 *
 * So identification is separated from enumeration:
 *
 *  - **metadata** reads a closed set of descriptor paths out of the index. Its
 *    cost is the directory plus a few hundred bytes, so the size of the artifact
 *    around it is not a reason to refuse.
 *  - **structural** enumerates every entry, and keeps the generic limits,
 *    because that is the work those limits were written for.
 *  - **deep** expands content beyond the descriptors, and is deliberately not
 *    attempted generically: with no idea which files matter, "read more" has no
 *    meaningful bound. An adapter that knows exactly what it wants can call
 *    `readSelectedEntries` with its own budget.
 *
 * Every layer reports what it did, which limit stopped it, and what stays
 * unknown as a result. Raising a limit to make one specific mod pass would have
 * been the other road, and it buys silence rather than knowledge.
 */

const SHA256 = /^[a-f0-9]{64}$/u;

// Closed set of descriptors this package will expand. Nothing else is read.
const MANIFEST_ENTRY = 'META-INF/MANIFEST.MF';
const FORGE_ENTRY = 'META-INF/mods.toml';
const NEOFORGE_ENTRY = 'META-INF/neoforge.mods.toml';
const FABRIC_ENTRY = 'fabric.mod.json';
const JARJAR_ENTRY = 'META-INF/jarjar/metadata.json';
const LEGACY_ENTRY = 'mcmod.info';

/**
 * Every path the selective layer will look for, lowercased.
 *
 * Closed on purpose. The scan reads what is on this list and nothing else, so
 * "read only known paths" is a property of the code rather than a promise in a
 * comment.
 */
const KNOWN_DESCRIPTOR_PATHS: ReadonlySet<string> = new Set(
  [MANIFEST_ENTRY, FORGE_ENTRY, NEOFORGE_ENTRY, FABRIC_ENTRY, JARJAR_ENTRY, LEGACY_ENTRY].map(
    (name) => name.toLowerCase(),
  ),
);

/** What a structural enumeration would have answered, when it does not run. */
const STRUCTURAL_UNKNOWNS: readonly string[] = Object.freeze([
  'entryCount',
  'features.containsClasses',
  'features.containsData',
  'features.containsAssets',
  'features.containsMixins',
  'features.containsNestedJars',
]);

/**
 * The only two structural failures that become a layer refusal.
 *
 * Both are capacity bounds this package chose: an artifact can be legitimately
 * huge or legitimately full of files, and neither says anything about whether
 * it declares a mod. Everything else `readZipDirectory` refuses — an unsafe
 * name, an encrypted entry, a truncated directory — is a statement about the
 * artifact, and those keep failing the whole inspection exactly as before.
 * Downgrading them to "one layer did not run" would quietly turn a security
 * decision into a warning.
 */
const STRUCTURAL_CAPACITY_LIMITS: ReadonlySet<string> = new Set(['too-many-entries']);

/** What content expansion would have answered. Never attempted generically. */
const DEEP_UNKNOWNS: readonly string[] = Object.freeze([
  'configuration-defaults-embedded-in-the-artifact',
  'registry-content',
  'nested-jar-contents',
]);

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

    const sha256 = createHash('sha256').update(content).digest('hex');
    if (plan.expectedSha256 !== undefined && plan.expectedSha256 !== sha256) {
      throw new ArtifactInspectionError('hash-mismatch', 'plan');
    }

    const budget: ExpansionBudget = { remaining: this.#limits.maximumExpandedBytes };
    const evidence: string[] = [];
    const metadataIssues: string[] = [];
    const loaders = new Set<DeclaredLoader>();
    const mods: DeclaredMod[] = [];
    let embeddedLibraries: readonly EmbeddedLibrary[] = Object.freeze([]);

    // --- Layer 1: selective metadata -------------------------------------
    //
    // A container that is not a container, or that is truncated, still fails
    // the whole inspection: there is no artifact to report on. Only a *limit*
    // becomes a layer refusal, because a limit is our choice and the caller
    // deserves to know which one.
    let scan;
    let metadataLayer: InspectionLayerResult;
    try {
      scan = scanZipDirectoryFor(content, KNOWN_DESCRIPTOR_PATHS, this.#limits);
      metadataLayer = { layer: 'metadata', outcome: 'completed', limit: null, unknown: [] };
    } catch (error) {
      if (!(error instanceof ArtifactInspectionError) || error.code !== 'directory-too-large') {
        throw error;
      }
      metadataLayer = {
        layer: 'metadata',
        outcome: 'refused',
        limit: 'maximumDirectoryBytes',
        unknown: Object.freeze(['declared-mods', 'declared-loader', 'declared-dependencies']),
      };
    }

    const entries: readonly ZipEntry[] = scan === undefined ? [] : [...scan.found.values()];

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
      // A descriptor that trips an expansion guard — implausible ratio, size
      // past the metadata bound, a size that disagrees with its own header —
      // still fails the whole inspection. Those are not capacity questions
      // about a large mod; they are the shape of a hostile archive.
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

    // --- Layer 2: structural enumeration ---------------------------------
    //
    // This is the work the generic limits were written for: walking every
    // entry and validating every name. They stay exactly as they were.
    let entryCount: number | null = null;
    let features: ArtifactInspectionReport['features'] = null;
    let structuralLayer: InspectionLayerResult;

    if (content.length > this.#limits.maximumArchiveBytes) {
      structuralLayer = {
        layer: 'structural',
        outcome: 'refused',
        limit: 'maximumArchiveBytes',
        unknown: STRUCTURAL_UNKNOWNS,
      };
    } else {
      try {
        const names = readZipDirectory(content, this.#limits).entries.map((entry) => entry.name);
        entryCount = names.length;
        features = Object.freeze({
          containsClasses: names.some((name) => name.endsWith('.class')),
          containsData: names.some((name) => name.startsWith('data/')),
          containsAssets: names.some((name) => name.startsWith('assets/')),
          containsMixins: names.some((name) => /(^|\/)[^/]*mixins?[^/]*\.json$/u.test(name)),
          containsNestedJars: names.some((name) => name.endsWith('.jar')),
        });
        structuralLayer = {
          layer: 'structural',
          outcome: 'completed',
          limit: null,
          unknown: [],
        };
      } catch (error) {
        if (
          !(error instanceof ArtifactInspectionError) ||
          !STRUCTURAL_CAPACITY_LIMITS.has(error.code)
        ) {
          // Not a capacity bound. An unsafe entry name still refuses the whole
          // artifact, and must not reach a report as a layer that merely did
          // not run.
          throw error;
        }
        structuralLayer = {
          layer: 'structural',
          outcome: 'refused',
          limit: error.code,
          unknown: STRUCTURAL_UNKNOWNS,
        };
      }
    }

    const report: ArtifactInspectionReport = {
      format: VOIDFALL_ARTIFACT_INSPECTION_FORMAT,
      schemaVersion: VOIDFALL_ARTIFACT_INSPECTION_SCHEMA_VERSION,
      sha256,
      sizeBytes: content.length,
      inspectedAt: (plan.inspectedAt ?? this.#clock()).toISOString(),
      container: 'zip',
      entryCount,
      expandedBytes: this.#limits.maximumExpandedBytes - budget.remaining,
      layers: Object.freeze([
        Object.freeze(metadataLayer),
        Object.freeze(structuralLayer),
        // --- Layer 3: deep -------------------------------------------------
        // Unavailable by design until an adapter names the files it needs.
        Object.freeze({
          layer: 'deep' as const,
          outcome: 'not-attempted' as const,
          limit: 'no-adapter',
          unknown: DEEP_UNKNOWNS,
        }),
      ]),
      loaders: Object.freeze([...loaders].sort()),
      mods: Object.freeze(mods),
      embeddedLibraries,
      evidence: Object.freeze([...evidence].sort()),
      metadataIssues: Object.freeze([...metadataIssues].sort()),
      features,
    };
    return Object.freeze(report);
  }
}

/**
 * Reads a named set of entries on behalf of an adapter.
 *
 * The escape hatch the layering leaves open, and deliberately a narrow one: an
 * adapter that knows exactly which files it needs passes their names and its
 * own budget. It cannot enumerate, cannot search and cannot spend more than it
 * declared, so "an adapter may look deeper" stays a bounded statement rather
 * than a hole under the limits.
 */
export function readSelectedEntries(input: {
  readonly content: Uint8Array;
  /** Exact entry paths. Nothing is matched by pattern or by prefix. */
  readonly names: readonly string[];
  /** The adapter's own budget, in bytes. Justified by the adapter, not here. */
  readonly budgetBytes: number;
  readonly limits?: Partial<ArtifactInspectionLimits>;
}): ReadonlyMap<string, Buffer> {
  if (
    !(input.content instanceof Uint8Array) ||
    !Array.isArray(input.names) ||
    input.names.length === 0 ||
    !Number.isSafeInteger(input.budgetBytes) ||
    input.budgetBytes < 1
  ) {
    throw new ArtifactInspectionError('invalid-plan', 'plan');
  }
  const limits = resolveLimits(input.limits);
  const content = Buffer.from(input.content.buffer, input.content.byteOffset, input.content.byteLength);
  const wanted = new Set(input.names.map((name) => name.toLowerCase()));
  const scan = scanZipDirectoryFor(content, wanted, limits);
  const budget: ExpansionBudget = { remaining: input.budgetBytes };
  const read = new Map<string, Buffer>();
  for (const [name, entry] of scan.found) {
    read.set(name, readZipEntry(content, entry, limits, budget));
  }
  return read;
}
