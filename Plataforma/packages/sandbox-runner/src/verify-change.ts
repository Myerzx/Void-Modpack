import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inferForm } from '@voidfall/configuration-inference';
import { ConfigurationStaging, type FieldChange } from '@voidfall/configuration-staging';

import { sandboxTargetPath } from './sandbox.js';
import { SandboxError } from './types.js';

/**
 * Stages a change and reports what a booted server actually held.
 *
 * The point of a sandbox is to test a change, not to test what is already
 * installed — and the only honest proof that a change was tested is to read it
 * back out of the copy the server ran on. Believing the staged bytes were used
 * because we passed them in is the class of assumption this whole pipeline
 * exists to avoid.
 */

export interface FileChangeSet {
  /** Relative to the workspace root, `/`-separated. */
  readonly path: string;
  readonly changes: readonly FieldChange[];
}

export interface StagedChangeOutcome {
  readonly path: string;
  readonly baseSha256: string;
  readonly stagedSha256: string;
  /**
   * What the file held in the sandbox after the boot.
   *
   * `null` when it could not be read back. A server may legitimately rewrite
   * its own configuration on startup, so this is reported rather than asserted
   * equal to what was staged.
   */
  readonly observedSha256: string | null;
  /** Whether every changed field still held the staged value afterwards. */
  readonly valuesHeld: boolean | null;
}

/**
 * Prepares staged content for a boot, and checks it afterwards.
 *
 * Kept separate from the sandbox itself: staging is a workspace concern with
 * its own rules about not touching the source, and a sandbox should not grow a
 * second opinion about how a configuration file is edited.
 */
export class ChangeVerification {
  readonly #workspaceRoot: string;
  readonly #stagingRoot: string;
  readonly #staged = new Map<string, { readonly base: string; readonly digest: string }>();
  readonly #changeSets: readonly FileChangeSet[];

  private constructor(
    workspaceRoot: string,
    stagingRoot: string,
    changeSets: readonly FileChangeSet[],
  ) {
    this.#workspaceRoot = workspaceRoot;
    this.#stagingRoot = stagingRoot;
    this.#changeSets = changeSets;
  }

  /** Stages every change into a temporary area the workspace never sees. */
  public static async prepare(input: {
    readonly workspaceRoot: string;
    readonly changeSets: readonly FileChangeSet[];
  }): Promise<{
    readonly verification: ChangeVerification;
    readonly stagedFiles: ReadonlyMap<string, string>;
  }> {
    if (input.changeSets.length === 0) throw new SandboxError('invalid-input');
    const stagingRoot = await mkdtemp(join(tmpdir(), 'voidfall-staging-'));
    const verification = new ChangeVerification(input.workspaceRoot, stagingRoot, input.changeSets);
    const staging = new ConfigurationStaging({
      workspaceRoot: input.workspaceRoot,
      stagingRoot,
    });

    const stagedFiles = new Map<string, string>();
    for (const set of input.changeSets) {
      const staged = await staging.stage({ path: set.path, changes: set.changes });
      const content = await staging.readStaged(set.path);
      if (content === undefined) throw new SandboxError('source-missing', set.path);
      stagedFiles.set(set.path, content);
      verification.#staged.set(set.path, {
        base: staged.baseSha256,
        digest: staged.stagedSha256,
      });
    }
    return { verification, stagedFiles: stagedFiles };
  }

  /**
   * Reads each changed file back out of the sandbox.
   *
   * Called before disposal, because after it there is nothing to read. What it
   * reports is what the server actually had, which is the only version of this
   * question worth answering.
   */
  public async observe(sandboxRoot: string): Promise<readonly StagedChangeOutcome[]> {
    const outcomes: StagedChangeOutcome[] = [];
    for (const set of this.#changeSets) {
      const staged = this.#staged.get(set.path);
      // The same mapping the composition used. Reading the workspace path
      // would look in a directory the sandbox never wrote to.
      const content = await readFile(
        join(sandboxRoot, ...sandboxTargetPath(set.path).split('/')),
        'utf8',
      ).catch(() => undefined);

      let valuesHeld: boolean | null = null;
      if (content !== undefined) {
        try {
          const form = inferForm({ format: 'toml', content });
          const byPath = new Map(form.fields.map((field) => [field.path, field.value]));
          valuesHeld = set.changes.every((change) => {
            const observed = byPath.get(change.path);
            return Array.isArray(change.value)
              ? JSON.stringify(observed) === JSON.stringify(change.value)
              : observed === change.value;
          });
        } catch {
          valuesHeld = null;
        }
      }

      outcomes.push({
        path: set.path,
        baseSha256: staged?.base ?? '',
        stagedSha256: staged?.digest ?? '',
        observedSha256:
          content === undefined ? null : createHash('sha256').update(content, 'utf8').digest('hex'),
        valuesHeld,
      });
    }
    return Object.freeze(outcomes);
  }

  /** Confirms the workspace copy is byte-for-byte what it was before staging. */
  public async workspaceUnchanged(): Promise<boolean> {
    for (const set of this.#changeSets) {
      const staged = this.#staged.get(set.path);
      const content = await readFile(
        join(this.#workspaceRoot, ...set.path.split('/')),
        'utf8',
      ).catch(() => undefined);
      if (content === undefined) return false;
      if (createHash('sha256').update(content, 'utf8').digest('hex') !== staged?.base) return false;
    }
    return true;
  }

  public async dispose(): Promise<void> {
    await rm(this.#stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
