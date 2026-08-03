import { Type, type Static } from '@sinclair/typebox';
import {
  BuildIdSchema,
  ContractSchemaVersion,
  IsoDateTimeSchema,
  RelativePathSchema,
  SemanticVersionSchema,
  Sha256Schema,
  SignatureSchema,
  SlugSchema,
} from './common.js';
import {
  appendSemanticIssues,
  semanticIssue,
  validateContract,
  type ContractValidationIssue,
  type ContractValidationResult,
} from './validation.js';

export const ReleaseManifestSchema = Type.Object(
  {
    schemaVersion: ContractSchemaVersion,
    product: Type.Object(
      {
        id: Type.Literal('voidfall'),
        displayName: Type.Literal('VoidFall'),
      },
      { additionalProperties: false },
    ),
    release: Type.Object(
      {
        version: SemanticVersionSchema,
        buildId: BuildIdSchema,
        previousVersion: Type.Optional(SemanticVersionSchema),
        publishedAt: IsoDateTimeSchema,
        message: Type.String({ minLength: 1, maxLength: 2_000 }),
      },
      { additionalProperties: false },
    ),
    runtime: Type.Object(
      {
        minecraft: Type.String({ minLength: 1, maxLength: 32 }),
        loader: Type.Union([
          Type.Literal('forge'),
          Type.Literal('neoforge'),
          Type.Literal('fabric'),
          Type.Literal('quilt'),
        ]),
        loaderVersion: Type.String({ minLength: 1, maxLength: 64 }),
        javaMajor: Type.Integer({ minimum: 17, maximum: 99 }),
      },
      { additionalProperties: false },
    ),
    serverProfile: Type.Object(
      {
        id: SlugSchema,
        displayName: Type.String({ minLength: 1, maxLength: 96 }),
      },
      { additionalProperties: false },
    ),
    files: Type.Array(
      Type.Object(
        {
          path: RelativePathSchema,
          artifactId: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
          size: Type.Integer({ minimum: 1 }),
          sha256: Sha256Schema,
          kind: Type.Union([
            Type.Literal('mod'),
            Type.Literal('library'),
            Type.Literal('config'),
            Type.Literal('resource-pack'),
            Type.Literal('shader-pack'),
            Type.Literal('script'),
            Type.Literal('datapack'),
            Type.Literal('patch'),
            Type.Literal('other'),
          ]),
          side: Type.Union([Type.Literal('client'), Type.Literal('both')]),
          required: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100_000 },
    ),
    removedPaths: Type.Array(RelativePathSchema, { maxItems: 100_000 }),
    signature: SignatureSchema,
  },
  {
    $id: 'https://schemas.voidfall.invalid/v1/release-manifest.schema.json',
    additionalProperties: false,
  },
);

export type ReleaseManifest = Static<typeof ReleaseManifestSchema>;

function normalizedPath(path: string): string {
  return path.normalize('NFC').toLocaleLowerCase('en-US');
}

function validateCanonicalPaths(paths: readonly string[], rootPath: string): ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];
  const normalized = paths.map(normalizedPath);

  if (new Set(normalized).size !== normalized.length) {
    issues.push(semanticIssue(rootPath, 'paths must be unique after cross-platform normalization'));
  }

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];

    if (previous !== undefined && current !== undefined && previous.localeCompare(current, 'en-US') >= 0) {
      issues.push(semanticIssue(rootPath, 'paths must be strictly sorted for canonical serialization'));
      break;
    }
  }

  return issues;
}

export function validateReleaseManifest(value: unknown): ContractValidationResult<ReleaseManifest> {
  const result = validateContract(ReleaseManifestSchema, value);

  if (!result.success) {
    return result;
  }

  const manifest = result.value;
  const filePaths = manifest.files.map((file) => file.path);
  const issues = [
    ...validateCanonicalPaths(filePaths, '/files'),
    ...validateCanonicalPaths(manifest.removedPaths, '/removedPaths'),
  ];
  const filePathSet = new Set(filePaths.map(normalizedPath));

  for (const [index, file] of manifest.files.entries()) {
    if (file.artifactId !== `sha256:${file.sha256}`) {
      issues.push(
        semanticIssue(`/files/${index}/artifactId`, 'artifactId must be derived from the file SHA-256'),
      );
    }
  }

  for (const [index, path] of manifest.removedPaths.entries()) {
    if (filePathSet.has(normalizedPath(path))) {
      issues.push(
        semanticIssue(`/removedPaths/${index}`, 'a path cannot be both delivered and removed'),
      );
    }
  }

  return appendSemanticIssues(result, issues);
}
