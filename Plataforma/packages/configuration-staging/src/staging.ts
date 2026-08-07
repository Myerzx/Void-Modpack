import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { inferForm, type ConfigurationFormat } from '@voidfall/configuration-inference';

import { rewriteConfiguration } from './rewrite.js';
import {
  ConfigurationStagingError,
  type DiffLine,
  type FieldChange,
  type StagedFile,
} from './types.js';

/**
 * A staging area: changes that exist, and have not happened.
 *
 * Two directories, and the difference between them is the whole point. The
 * workspace is somebody's installation and is opened read-only. Staging is a
 * separate tree this service owns, and everything written goes there.
 *
 * Applying staged content to the workspace is deliberately **not** here. It is
 * the one destructive step, it belongs behind its own authorization, and
 * putting it in the same object as the safe operations is how it ends up
 * called by accident.
 */

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function formatFor(path: string): ConfigurationFormat {
  const lower = path.toLocaleLowerCase('en-US');
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.json')) return 'json';
  throw new ConfigurationStagingError('unsupported-format', path);
}

function resolveInside(root: string, relativePath: string): string {
  const segments = relativePath.split('/');
  if (
    relativePath.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    // A traversal in the relative path would put a staged write outside the
    // staging tree, which is the one thing this service promises never to do.
    throw new ConfigurationStagingError('invalid-input', relativePath);
  }
  return join(root, ...segments);
}

export interface ConfigurationStagingOptions {
  /** The installation being edited. Opened read-only, always. */
  readonly workspaceRoot: string;
  /** Where staged content lives. Owned by this service.  */
  readonly stagingRoot: string;
}

export class ConfigurationStaging {
  readonly #workspaceRoot: string;
  readonly #stagingRoot: string;

  public constructor(options: ConfigurationStagingOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      !isAbsolute(options.workspaceRoot) ||
      !isAbsolute(options.stagingRoot)
    ) {
      throw new ConfigurationStagingError('invalid-input');
    }
    this.#workspaceRoot = options.workspaceRoot;
    this.#stagingRoot = options.stagingRoot;
  }

  /**
   * Computes the changed content and writes it to staging.
   *
   * The source is read and never written. The digest of what was read is
   * recorded, so a later apply can refuse when the file has moved on since.
   */
  public async stage(input: {
    readonly path: string;
    readonly changes: readonly FieldChange[];
  }): Promise<StagedFile> {
    const format = formatFor(input.path);
    const source = resolveInside(this.#workspaceRoot, input.path);
    const content = await readFile(source, 'utf8');
    const form = inferForm({ format, content });

    const staged = rewriteConfiguration({ form, content, changes: input.changes });
    const target = resolveInside(this.#stagingRoot, input.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, staged, 'utf8');

    return Object.freeze({
      path: input.path,
      baseSha256: digest(content),
      stagedSha256: digest(staged),
      changes: Object.freeze([...input.changes]),
    });
  }

  /** Reads back what is staged for a path, or nothing. */
  public async readStaged(path: string): Promise<string | undefined> {
    const target = resolveInside(this.#stagingRoot, path);
    return readFile(target, 'utf8').catch(() => undefined);
  }

  /**
   * Discards a staged change.
   *
   * Rollback before apply is deleting a file this service wrote. It touches
   * nothing in the workspace, because nothing in the workspace was touched.
   */
  public async discard(path: string): Promise<void> {
    const target = resolveInside(this.#stagingRoot, path);
    await rm(target, { force: true });
  }

  /**
   * Confirms the source still hashes to what the change was computed against.
   *
   * Separated from `stage` on purpose: it is what an apply must call, and it
   * has to be callable at apply time rather than trusted from staging time.
   */
  public async verifyBase(staged: StagedFile): Promise<void> {
    const source = resolveInside(this.#workspaceRoot, staged.path);
    const content = await readFile(source, 'utf8').catch(() => undefined);
    if (content === undefined || digest(content) !== staged.baseSha256) {
      // Something changed the file after the edit was computed. Applying now
      // would overwrite an edit this change never saw.
      throw new ConfigurationStagingError('base-digest-mismatch', staged.path);
    }
  }

  /** The line difference between the source and what is staged for it. */
  public async diff(path: string): Promise<readonly DiffLine[]> {
    const source = await readFile(resolveInside(this.#workspaceRoot, path), 'utf8');
    const staged = await this.readStaged(path);
    if (staged === undefined) throw new ConfigurationStagingError('not-staged', path);
    return diffLines(source, staged);
  }
}

/**
 * A line diff, kept deliberately plain.
 *
 * Lines are compared in place rather than aligned by a minimal edit script.
 * A surgical value replacement changes lines without moving them, so this
 * reports exactly the lines that changed — and a reader deciding whether to
 * apply is better served by that than by the smallest possible script.
 */
export function diffLines(before: string, after: string): readonly DiffLine[] {
  const left = before.split(/\r\n|\r|\n/u);
  const right = after.split(/\r\n|\r|\n/u);
  const result: DiffLine[] = [];

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const from = left[index];
    const to = right[index];
    if (from === to) {
      if (from !== undefined) result.push({ kind: 'context', line: index + 1, text: from });
      continue;
    }
    if (from !== undefined) result.push({ kind: 'removed', line: index + 1, text: from });
    if (to !== undefined) result.push({ kind: 'added', line: index + 1, text: to });
  }
  return Object.freeze(result);
}

/** Just the changed lines, for a caller that wants the summary. */
export function changedLines(diff: readonly DiffLine[]): readonly DiffLine[] {
  return Object.freeze(diff.filter((entry) => entry.kind !== 'context'));
}
