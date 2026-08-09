import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { inferForm, validateProposedValue } from '@voidfall/configuration-inference';
import {
  ConfigurationStaging,
  changedLines,
  diffLines,
  type FieldChange,
} from '@voidfall/configuration-staging';
import { VOIDFALL_TRUSTED_DATAPACK_SCHEMA_REGISTRY } from '@voidfall/ecosystem-analysis';

import type { WorkspaceConfigurationService } from './workspace-routes.js';

/**
 * Wires the configuration engines into the API.
 *
 * Thin on purpose, like the scanner adapter. Which fields exist, what bounds a
 * mod declared, whether a value is acceptable and how a file is rewritten are
 * all already decided in `configuration-inference` and
 * `configuration-staging`. Deciding any of it again here would create a second
 * answer, and the panel would then be able to disagree with the thing that
 * actually writes the file.
 *
 * The staging root is provisioned, not configured: it sits beside the local
 * environment's database, one directory per workspace. Nothing is ever written
 * into the workspace itself — that is the whole point of staging, and the one
 * destructive step, `apply`, still has no owner anywhere in this repository.
 */

function formatOf(path: string): 'toml' | 'json' | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.json') || lower.endsWith('.json5')) return 'json';
  return null;
}

class WorkspaceConfigurationValidationError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(`workspace-configuration:${code}`);
    this.name = 'WorkspaceConfigurationValidationError';
    this.code = code;
  }
}

export function createWorkspaceConfigurationService(
  stagingParent: string,
): WorkspaceConfigurationService {
  return {
    formatOf,

    async readForm(input) {
      const format = formatOf(input.path);
      if (format === null) return null;
      const absolute = join(input.workspaceRoot, ...input.path.split('/'));
      const content = await readFile(absolute, 'utf8');
      if (input.reviewedDatapack !== null) {
        const inspection = VOIDFALL_TRUSTED_DATAPACK_SCHEMA_REGISTRY.inspect({
          schemaId: input.reviewedDatapack.schemaId,
          resourcePath: input.reviewedDatapack.resourcePath,
          content,
        });
        if (!inspection.success) {
          throw new WorkspaceConfigurationValidationError(`reviewed-schema-${inspection.code}`);
        }
        return {
          format: 'json',
          complete: true,
          issues: [],
          fields: inspection.schema.fields.map((field) => ({
            path: field.path,
            type: field.type,
            value: inspection.values[field.path],
            constraints: [],
            documentation: field.description === null ? [] : [field.description],
            line: 0,
          })),
        };
      }
      const form = inferForm({ format, content });
      return {
        format: form.format,
        complete: form.complete,
        issues: form.issues,
        fields: form.fields.map((field) => ({
          path: field.path,
          type: field.type,
          value: field.value,
          constraints: field.constraints,
          documentation: field.documentation,
          line: field.line,
        })),
      };
    },

    async validate(input) {
      const format = formatOf(input.path);
      if (format === null) return null;
      const absolute = join(input.workspaceRoot, ...input.path.split('/'));
      const content = await readFile(absolute, 'utf8');
      if (input.reviewedDatapack !== null) {
        return VOIDFALL_TRUSTED_DATAPACK_SCHEMA_REGISTRY.validateChanges({
          schemaId: input.reviewedDatapack.schemaId,
          resourcePath: input.reviewedDatapack.resourcePath,
          content,
          changes: input.changes,
        }).map((decision) => decision.accepted
          ? {
              path: decision.path,
              accepted: true as const,
              checkedAgainstDeclaredBounds: false,
              checkedAgainstReviewedSchema: true,
            }
          : { path: decision.path, accepted: false as const, code: decision.code ?? 'value-rejected' });
      }
      const form = inferForm({ format, content });

      return input.changes.map((change) => {
        const field = form.fields.find((entry) => entry.path === change.path);
        if (field === undefined) {
          // A field the form does not have is not a validation failure of the
          // value — it is the panel naming something that is not there.
          return { path: change.path, accepted: false, code: 'unknown-field' as const };
        }
        const decision = validateProposedValue(field, change.value);
        return decision.accepted
          ? {
              path: change.path,
              accepted: true as const,
              // Carried through rather than flattened: "well-typed" and
              // "checked against what the mod declared" are different claims,
              // and a form that showed them the same way would be lying by
              // omission.
              checkedAgainstDeclaredBounds: decision.checkedAgainstDeclaredBounds,
              checkedAgainstReviewedSchema: false,
            }
          : { path: change.path, accepted: false as const, code: decision.code };
      });
    },

    async stage(input) {
      if (input.reviewedDatapack !== null) {
        const content = await readFile(
          join(input.workspaceRoot, ...input.path.split('/')),
          'utf8',
        );
        const decisions = VOIDFALL_TRUSTED_DATAPACK_SCHEMA_REGISTRY.validateChanges({
          schemaId: input.reviewedDatapack.schemaId,
          resourcePath: input.reviewedDatapack.resourcePath,
          content,
          changes: input.changes,
        });
        const refused = decisions.find((decision) => !decision.accepted);
        if (refused !== undefined) {
          throw new WorkspaceConfigurationValidationError(
            `reviewed-schema-${refused.code ?? 'value-rejected'}`,
          );
        }
      }
      const staging = new ConfigurationStaging({
        workspaceRoot: input.workspaceRoot,
        stagingRoot: join(stagingParent, input.workspaceId),
      });
      const staged = await staging.stage({
        path: input.path,
        changes: input.changes as readonly FieldChange[],
        expectedBaseSha256: input.expectedSha256,
      });

      const before = await readFile(
        join(input.workspaceRoot, ...input.path.split('/')),
        'utf8',
      );
      const after = (await staging.readStaged(input.path)) ?? '';
      const diff = changedLines(diffLines(before, after));

      return {
        path: staged.path,
        baseSha256: staged.baseSha256,
        stagedSha256: staged.stagedSha256,
        changes: staged.changes,
        // Only the lines that moved. A configuration diff is read by somebody
        // deciding whether to apply it, and five thousand context lines is not
        // a review, it is a scroll.
        diff,
      };
    },

    async readStaged(input) {
      const staging = new ConfigurationStaging({
        workspaceRoot: input.workspaceRoot,
        stagingRoot: join(stagingParent, input.workspaceId),
      });
      const staged = await staging.readStaged(input.path);
      if (staged === undefined) return null;
      const before = await readFile(
        join(input.workspaceRoot, ...input.path.split('/')),
        'utf8',
      );
      return { diff: changedLines(diffLines(before, staged)) };
    },

    async discard(input) {
      const staging = new ConfigurationStaging({
        workspaceRoot: input.workspaceRoot,
        stagingRoot: join(stagingParent, input.workspaceId),
      });
      await staging.discard(input.path);
    },
  };
}
