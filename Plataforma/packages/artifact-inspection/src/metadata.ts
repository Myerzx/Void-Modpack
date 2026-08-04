import { Buffer } from 'node:buffer';

import {
  ArtifactInspectionError,
  type ArtifactInspectionLimits,
  type DeclaredDependency,
  type DeclaredMod,
  type DeclaredSide,
  type EmbeddedLibrary,
} from './types.js';

/**
 * Strict, minimal readers for the declared metadata formats.
 *
 * Each reader accepts only the narrow subset a mod descriptor actually needs
 * and refuses anything else. None of them evaluates, interpolates or executes
 * what it reads: a version such as `${file.jarVersion}` is reported verbatim,
 * because this package records what an artifact declares, not what it means.
 */

const MOD_ID = /^[a-z][a-z0-9_-]{1,63}$/u;
const SIDES: ReadonlySet<string> = new Set(['CLIENT', 'SERVER', 'BOTH']);

function decodeUtf8(content: Buffer): string {
  try {
    // A BOM is tolerated; invalid UTF-8 is refused rather than replaced.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    return text.startsWith('﻿') ? text.slice(1) : text;
  } catch {
    throw new ArtifactInspectionError('invalid-metadata', 'metadata');
  }
}

function boundedText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maximumLength ? trimmed.slice(0, maximumLength) : trimmed;
}

function normalizedSide(value: unknown): DeclaredSide {
  if (typeof value !== 'string') return 'BOTH';
  const upper = value.trim().toUpperCase();
  return SIDES.has(upper) ? (upper as DeclaredSide) : 'BOTH';
}

/** Reads `META-INF/MANIFEST.MF` as bounded main-section key/value pairs. */
export function parseJarManifest(content: Buffer): Readonly<Record<string, string>> {
  const text = decodeUtf8(content);
  const attributes: Record<string, string> = {};
  let lastKey: string | undefined;

  for (const rawLine of text.split(/\r\n|\r|\n/u)) {
    if (rawLine.length === 0) {
      // A blank line ends the main section; per-entry sections are ignored.
      break;
    }
    if (rawLine.startsWith(' ') && lastKey !== undefined) {
      attributes[lastKey] = `${attributes[lastKey] ?? ''}${rawLine.slice(1)}`;
      continue;
    }
    const separator = rawLine.indexOf(': ');
    if (separator <= 0) {
      lastKey = undefined;
      continue;
    }
    const key = rawLine.slice(0, separator);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,70}$/u.test(key)) {
      lastKey = undefined;
      continue;
    }
    attributes[key] = rawLine.slice(separator + 2);
    lastKey = key;
  }
  return Object.freeze(attributes);
}

interface TomlTable {
  readonly [key: string]: string | boolean | number | TomlTable | TomlTable[];
}

/**
 * Reads the strict TOML subset a `mods.toml` descriptor uses: top-level
 * assignments, `[[mods]]` array-of-tables and `[[dependencies.<modId>]]`.
 * Multi-line strings, inline tables, arrays of values and anything else are
 * refused rather than approximated.
 */
export function parseModsToml(content: Buffer): TomlTable {
  const text = decodeUtf8(content);
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;

  for (const rawLine of text.split(/\r\n|\r|\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    if (line.startsWith('[[') && line.endsWith(']]')) {
      const path = line.slice(2, -2).trim();
      if (!/^[A-Za-z0-9_.-]+$/u.test(path)) {
        throw new ArtifactInspectionError('invalid-metadata', 'metadata');
      }
      const segments = path.split('.');
      let holder = root;
      for (const segment of segments.slice(0, -1)) {
        const next = holder[segment];
        if (next === undefined) {
          const created: Record<string, unknown> = {};
          holder[segment] = created;
          holder = created;
        } else if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
          holder = next as Record<string, unknown>;
        } else {
          throw new ArtifactInspectionError('invalid-metadata', 'metadata');
        }
      }
      const leaf = segments[segments.length - 1];
      if (leaf === undefined) throw new ArtifactInspectionError('invalid-metadata', 'metadata');
      const existing = holder[leaf];
      const table: Record<string, unknown> = {};
      if (existing === undefined) {
        holder[leaf] = [table];
      } else if (Array.isArray(existing)) {
        existing.push(table);
      } else {
        throw new ArtifactInspectionError('invalid-metadata', 'metadata');
      }
      current = table;
      continue;
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      const path = line.slice(1, -1).trim();
      if (!/^[A-Za-z0-9_.-]+$/u.test(path)) {
        throw new ArtifactInspectionError('invalid-metadata', 'metadata');
      }
      let holder = root;
      for (const segment of path.split('.')) {
        const next = holder[segment];
        if (next === undefined) {
          const created: Record<string, unknown> = {};
          holder[segment] = created;
          holder = created;
        } else if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
          holder = next as Record<string, unknown>;
        } else {
          throw new ArtifactInspectionError('invalid-metadata', 'metadata');
        }
      }
      current = holder;
      continue;
    }

    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(key)) continue;

    if (rawValue.startsWith("'''") || rawValue.startsWith('"""')) {
      // Multi-line strings are common in `description` and carry no value for
      // an inspection, so the key is skipped rather than half-parsed.
      continue;
    }
    if (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2) {
      current[key] = rawValue.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
    } else if (rawValue.startsWith("'") && rawValue.endsWith("'") && rawValue.length >= 2) {
      current[key] = rawValue.slice(1, -1);
    } else if (rawValue === 'true' || rawValue === 'false') {
      current[key] = rawValue === 'true';
    }
    // Numbers, dates, arrays and inline tables are intentionally ignored.
  }

  return root as TomlTable;
}

function declaredDependenciesFor(
  dependencies: unknown,
  modId: string,
  evidence: string,
  limits: ArtifactInspectionLimits,
): readonly DeclaredDependency[] {
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    return Object.freeze([]);
  }
  const declared = (dependencies as Record<string, unknown>)[modId];
  const list = Array.isArray(declared) ? declared : declared === undefined ? [] : [declared];
  const result: DeclaredDependency[] = [];

  for (const entry of list) {
    if (result.length >= limits.maximumDeclaredDependencies) break;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const target = boundedText(record['modId'], 64);
    if (target === null) continue;
    result.push(
      Object.freeze({
        target,
        mandatory: record['mandatory'] === undefined ? true : record['mandatory'] === true,
        versionRange: boundedText(record['versionRange'], 128),
        side: normalizedSide(record['side']),
        evidence,
      }),
    );
  }
  return Object.freeze(result);
}

/** Extracts declared mods from a parsed Forge/NeoForge descriptor. */
export function declaredModsFromToml(
  parsed: TomlTable,
  loader: 'forge' | 'neoforge',
  evidence: string,
  manifest: Readonly<Record<string, string>>,
  limits: ArtifactInspectionLimits,
): readonly DeclaredMod[] {
  const rawMods = (parsed as Record<string, unknown>)['mods'];
  const list = Array.isArray(rawMods) ? rawMods : rawMods === undefined ? [] : [rawMods];
  const dependencies = (parsed as Record<string, unknown>)['dependencies'];
  const mods: DeclaredMod[] = [];

  for (const entry of list) {
    if (mods.length >= limits.maximumDeclaredMods) break;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const modId = boundedText(record['modId'], 64);
    if (modId === null || !MOD_ID.test(modId)) continue;

    // `${file.jarVersion}` resolves from the manifest when the manifest states
    // it. It is never invented, and an unresolved placeholder stays verbatim.
    const rawVersion = boundedText(record['version'], 128);
    const version =
      rawVersion === '${file.jarVersion}'
        ? boundedText(manifest['Implementation-Version'], 128) ?? rawVersion
        : rawVersion;

    mods.push(
      Object.freeze({
        modId,
        displayName: boundedText(record['displayName'], 128),
        version,
        loader,
        dependencies: declaredDependenciesFor(dependencies, modId, evidence, limits),
        evidence,
      }),
    );
  }
  return Object.freeze(mods);
}

function parseJson(content: Buffer): unknown {
  try {
    return JSON.parse(decodeUtf8(content)) as unknown;
  } catch (error) {
    if (error instanceof ArtifactInspectionError) throw error;
    throw new ArtifactInspectionError('invalid-metadata', 'metadata');
  }
}

/** Extracts declared mods from `fabric.mod.json`. */
export function declaredModsFromFabric(
  content: Buffer,
  evidence: string,
  limits: ArtifactInspectionLimits,
): readonly DeclaredMod[] {
  const parsed = parseJson(content);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ArtifactInspectionError('invalid-metadata', 'metadata');
  }
  const record = parsed as Record<string, unknown>;
  const modId = boundedText(record['id'], 64);
  if (modId === null || !MOD_ID.test(modId)) return Object.freeze([]);

  const dependencies: DeclaredDependency[] = [];
  const depends = record['depends'];
  if (depends !== null && typeof depends === 'object' && !Array.isArray(depends)) {
    for (const [target, range] of Object.entries(depends as Record<string, unknown>)) {
      if (dependencies.length >= limits.maximumDeclaredDependencies) break;
      const boundedTarget = boundedText(target, 64);
      if (boundedTarget === null) continue;
      dependencies.push(
        Object.freeze({
          target: boundedTarget,
          mandatory: true,
          versionRange: boundedText(range, 128),
          side: 'BOTH' as const,
          evidence,
        }),
      );
    }
  }

  return Object.freeze([
    Object.freeze({
      modId,
      displayName: boundedText(record['name'], 128),
      version: boundedText(record['version'], 128),
      loader: 'fabric' as const,
      dependencies: Object.freeze(dependencies),
      evidence,
    }),
  ]);
}

/**
 * Reads the JarJar index. Embedded libraries are reported as declarations only;
 * this package never opens a nested JAR, which would mean unbounded recursion.
 */
export function declaredEmbeddedLibraries(
  content: Buffer,
  evidence: string,
  limits: ArtifactInspectionLimits,
): readonly EmbeddedLibrary[] {
  const parsed = parseJson(content);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ArtifactInspectionError('invalid-metadata', 'metadata');
  }
  const jars = (parsed as Record<string, unknown>)['jars'];
  if (!Array.isArray(jars)) return Object.freeze([]);

  const libraries: EmbeddedLibrary[] = [];
  for (const entry of jars) {
    if (libraries.length >= limits.maximumEmbeddedLibraries) break;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const identifier = record['identifier'];
    if (identifier === null || typeof identifier !== 'object' || Array.isArray(identifier)) continue;
    const identifierRecord = identifier as Record<string, unknown>;
    const group = boundedText(identifierRecord['group'], 128);
    const artifact = boundedText(identifierRecord['artifact'], 128);
    if (group === null || artifact === null) continue;

    const version = record['version'];
    const versionText =
      version !== null && typeof version === 'object' && !Array.isArray(version)
        ? boundedText((version as Record<string, unknown>)['artifactVersion'], 128)
        : boundedText(version, 128);

    libraries.push(Object.freeze({ identifier: `${group}:${artifact}`, version: versionText, evidence }));
  }
  return Object.freeze(libraries);
}
