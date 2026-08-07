import type { ChangelogEntry, WorkspaceDiff } from './types.js';

/**
 * Turns a diff into something a person reads before deciding to publish.
 *
 * Every line comes from a digest comparison. Nothing here summarises what a
 * change *does* — that would require knowing what the mods mean, which nothing
 * in this pipeline does — so the entries say what moved and leave the judgement
 * to whoever is reading.
 */

/** Roles that are content changes rather than configuration. */
const CONTENT_ROLES: ReadonlySet<string> = new Set(['datapack', 'resource', 'script']);

function describeMod(
  displayName: string | null,
  modId: string,
  from: string | null,
  to: string | null,
): string {
  // The display name is what a person recognises; the id is what is unique.
  // Both, because a pack can hold two mods with the same display name.
  const label = displayName === null || displayName === modId ? modId : `${displayName} (${modId})`;
  if (from === null) return `${label} ${to ?? 'unknown version'}`;
  if (to === null) return `${label} ${from}`;
  return from === to ? `${label} ${from} (rebuilt)` : `${label} ${from} → ${to}`;
}

export function buildChangelog(diff: WorkspaceDiff): readonly ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];

  for (const change of diff.mods) {
    const text = describeMod(
      change.displayName,
      change.modId,
      change.fromVersion,
      change.toVersion,
    );
    if (change.kind === 'added') entries.push({ section: 'Added', text });
    else if (change.kind === 'removed') entries.push({ section: 'Removed', text });
    else entries.push({ section: 'Updated', text });
  }

  const configuration = diff.files.filter((file) => file.role === 'configuration');
  const content = diff.files.filter((file) => CONTENT_ROLES.has(file.role));

  for (const file of configuration) {
    entries.push({ section: 'Configuration', text: `${file.kind}: ${file.path}` });
  }
  for (const file of content) {
    entries.push({ section: 'Content', text: `${file.kind}: ${file.path}` });
  }

  return Object.freeze(entries);
}

/**
 * Renders the changelog as Markdown.
 *
 * A release with nothing in it says so rather than producing an empty document
 * that looks like a generation failure.
 */
export function renderChangelog(input: {
  readonly entries: readonly ChangelogEntry[];
  readonly version: string;
  readonly previousVersion: string | null;
}): string {
  const heading =
    input.previousVersion === null
      ? `# ${input.version}`
      : `# ${input.version} (from ${input.previousVersion})`;

  if (input.entries.length === 0) {
    return `${heading}\n\nNo mod, configuration or content changes.\n`;
  }

  const sections: readonly ChangelogEntry['section'][] = [
    'Added',
    'Removed',
    'Updated',
    'Configuration',
    'Content',
  ];
  const lines: string[] = [heading, ''];
  for (const section of sections) {
    const inSection = input.entries.filter((entry) => entry.section === section);
    if (inSection.length === 0) continue;
    lines.push(`## ${section}`, '');
    for (const entry of inSection) lines.push(`- ${entry.text}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
