import type {
  ConfigurationCandidate,
  ConfigurationMatchRule,
  ModEditLevel,
  WorkspaceFile,
} from './types.js';

/**
 * Decides how far a mod's configuration can safely be edited.
 *
 * The rule that governs everything here: **locating a file is not
 * understanding it.** A JAR states its id, its version and its dependencies;
 * it does not state where its configuration lives, what the fields mean or
 * which values are safe. So the default is the least capable level, and moving
 * up requires evidence rather than absence of evidence.
 *
 * `UNSUPPORTED` and `RUNTIME_ONLY` are ordinary results. An inventory that
 * classified everything as editable would be claiming knowledge it does not
 * have, and the cost of that claim is a corrupted configuration on somebody's
 * server.
 */

/** Formats whose structure can be parsed into a tree and written back. */
const STRUCTURED_EXTENSIONS: ReadonlySet<string> = new Set(['.toml', '.json', '.properties']);

/**
 * Formats that can be located and shown as text, but not parsed into a form.
 *
 * Editing these is an advanced mode with a warning, not a form: `.cfg` covers
 * a dozen incompatible dialects and `.snbt` is a serialisation nobody should
 * round-trip without a reviewed codec.
 */
const RAW_EDITABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.cfg',
  '.conf',
  '.json5',
  '.snbt',
  '.yaml',
  '.yml',
]);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLocaleLowerCase('en-US');
}

/**
 * Finds the files a mod probably owns.
 *
 * "Probably" is load-bearing. These are naming conventions Forge mods tend to
 * follow, not declarations, so each match carries the rule that produced it —
 * a reader can then judge a match instead of trusting it, and a wrong guess is
 * visible rather than silent.
 *
 * A mod id is matched exactly against the file stem or the directory name.
 * Prefix matching would make `jei` claim `jeitweaker`'s configuration, and the
 * two are different mods by different people.
 */
export function configurationCandidatesFor(input: {
  readonly modId: string;
  readonly files: readonly WorkspaceFile[];
  readonly reviewedResourcePaths?: readonly string[];
}): readonly ConfigurationCandidate[] {
  const modId = input.modId.toLocaleLowerCase('en-US');
  const reviewed = new Set((input.reviewedResourcePaths ?? []).map((path) => path.toLowerCase()));
  const candidates: ConfigurationCandidate[] = [];

  for (const file of input.files) {
    if (file.role !== 'configuration') continue;
    const lower = file.path.toLocaleLowerCase('en-US');
    if (!lower.startsWith('config/')) continue;

    const withoutRoot = lower.slice('config/'.length);
    const firstSegment = withoutRoot.split('/')[0] ?? '';
    let rule: ConfigurationMatchRule | undefined;

    if (withoutRoot.includes('/')) {
      // config/<modId>/** — a directory named for the mod.
      if (firstSegment === modId) rule = 'config-directory-by-mod-id';
    } else {
      // config/<modId>.toml, and the side-specific variants Forge generates.
      const stem = firstSegment.slice(0, firstSegment.lastIndexOf('.'));
      if (
        stem === modId ||
        stem === `${modId}-common` ||
        stem === `${modId}-server` ||
        stem === `${modId}-client`
      ) {
        rule = 'config-file-by-mod-id';
      }
    }
    if (rule === undefined) continue;

    // Being reviewed *upgrades* a file this mod already owns; it never makes a
    // file belong to a mod. Matching on reviewed-ness alone would attribute one
    // mod's reviewed resource to every mod in the pack, and the resulting
    // FULLY_MANAGED would be a claim that somebody understood fields they had
    // never seen.
    candidates.push({ path: file.path, rule: reviewed.has(lower) ? 'reviewed-resource' : rule });
  }

  candidates.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
  return Object.freeze(candidates);
}

export interface EditLevelDecision {
  readonly level: ModEditLevel;
  readonly reason: string;
}

/**
 * Classifies from the candidates found, taking the least capable answer.
 *
 * The order below is the argument. A reviewed schema is the only thing that
 * earns `FULLY_MANAGED`, because it is the only evidence that anybody looked
 * at what the fields mean. Everything else is structure at best.
 */
export function classifyEditLevel(
  candidates: readonly ConfigurationCandidate[],
): EditLevelDecision {
  if (candidates.length === 0) {
    // Nothing found. This does not mean the mod has no configuration — most
    // Forge mods write theirs on first boot — so the honest answer names the
    // thing that would resolve it rather than declaring the mod unsupported.
    return {
      level: 'RUNTIME_ONLY',
      reason: 'no configuration file present; it may only exist after the mod has run',
    };
  }

  if (candidates.some((candidate) => candidate.rule === 'reviewed-resource')) {
    return {
      level: 'FULLY_MANAGED',
      reason: 'a reviewed schema in the closed registry covers this resource',
    };
  }

  const extensions = candidates.map((candidate) => extensionOf(candidate.path));
  if (extensions.some((extension) => STRUCTURED_EXTENSIONS.has(extension))) {
    return {
      level: 'STRUCTURED',
      reason: 'structure is parseable, but no reviewed schema states what the fields mean',
    };
  }
  if (extensions.some((extension) => RAW_EDITABLE_EXTENSIONS.has(extension))) {
    return {
      level: 'RAW_EDITABLE',
      reason: 'located as text; the format has no safe structural round-trip',
    };
  }
  return {
    level: 'UNSUPPORTED',
    reason: 'located, but this format has no safe mutation',
  };
}

/** Rules, in the order they are attempted. Exported so a reader can check it. */
export const CONFIGURATION_MATCH_RULES: readonly ConfigurationMatchRule[] = Object.freeze([
  'reviewed-resource',
  'config-file-by-mod-id',
  'config-directory-by-mod-id',
]);
