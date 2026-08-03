import { createRequire } from 'node:module';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { FormatsPlugin } from 'ajv-formats';
import type { Static, TSchema } from '@sinclair/typebox';

export interface ContractValidationIssue {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

export type ContractValidationResult<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly issues: readonly ContractValidationIssue[] };

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  validateFormats: true,
});

const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as FormatsPlugin;
addFormats(ajv);

const validatorCache = new WeakMap<TSchema, ValidateFunction>();

function getValidator(schema: TSchema): ValidateFunction {
  const cached = validatorCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }

  const compiled = ajv.compile(schema);
  validatorCache.set(schema, compiled);
  return compiled;
}

function mapAjvError(error: ErrorObject): ContractValidationIssue {
  return {
    path: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message ?? 'invalid contract value',
  };
}

export function validateContract<TSchemaType extends TSchema>(
  schema: TSchemaType,
  value: unknown,
): ContractValidationResult<Static<TSchemaType>> {
  const validator = getValidator(schema);

  if (validator(value)) {
    return { success: true, value: value as Static<TSchemaType> };
  }

  return {
    success: false,
    issues: (validator.errors ?? []).map(mapAjvError),
  };
}

export function semanticIssue(path: string, message: string): ContractValidationIssue {
  return { path, keyword: 'semantic', message };
}

export function appendSemanticIssues<T>(
  result: ContractValidationResult<T>,
  issues: readonly ContractValidationIssue[],
): ContractValidationResult<T> {
  if (!result.success || issues.length === 0) {
    return result;
  }

  return { success: false, issues };
}
