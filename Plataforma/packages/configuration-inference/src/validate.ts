import type { InferredField } from './types.js';

/**
 * Checks a proposed value against what is actually known about a field.
 *
 * The rule that matters: **a field with no declared bound is validated on type
 * alone, and the answer says so.** Inventing a plausible range would reject
 * values the mod accepts, and the operator would have no way to tell the
 * editor's opinion from the mod's requirement.
 */

export type ValueRejectionCode =
  | 'wrong-type'
  | 'out-of-declared-range'
  | 'not-an-allowed-value'
  | 'not-an-integer'
  | 'mixed-list';

export interface ValueAcceptance {
  readonly accepted: true;
  /**
   * Whether a declared bound was actually checked.
   *
   * `false` means the value is well-typed and nothing more is known — the form
   * should present it as such rather than implying it was validated.
   */
  readonly checkedAgainstDeclaredBounds: boolean;
}

export interface ValueRejection {
  readonly accepted: false;
  readonly code: ValueRejectionCode;
}

export type ValueDecision = ValueAcceptance | ValueRejection;

function listKindOf(type: InferredField['type']): 'string' | 'number' | 'boolean' | undefined {
  if (type === 'string-list') return 'string';
  if (type === 'number-list') return 'number';
  if (type === 'boolean-list') return 'boolean';
  return undefined;
}

export function validateProposedValue(
  field: InferredField,
  proposed: unknown,
): ValueDecision {
  const listKind = listKindOf(field.type);
  if (listKind !== undefined) {
    if (!Array.isArray(proposed)) return { accepted: false, code: 'wrong-type' };
    if (proposed.some((entry) => typeof entry !== listKind)) {
      // A list that changed type halfway is how a save turns a number into a
      // string without anybody choosing that.
      return { accepted: false, code: 'mixed-list' };
    }
    if (listKind === 'number' && proposed.some((entry) => !Number.isFinite(entry))) {
      return { accepted: false, code: 'wrong-type' };
    }
    return { accepted: true, checkedAgainstDeclaredBounds: false };
  }

  if (field.type === 'boolean') {
    return typeof proposed === 'boolean'
      ? { accepted: true, checkedAgainstDeclaredBounds: false }
      : { accepted: false, code: 'wrong-type' };
  }

  if (field.type === 'integer' || field.type === 'number') {
    if (typeof proposed !== 'number' || !Number.isFinite(proposed)) {
      return { accepted: false, code: 'wrong-type' };
    }
    if (field.type === 'integer' && !Number.isInteger(proposed)) {
      return { accepted: false, code: 'not-an-integer' };
    }
    let checked = false;
    for (const constraint of field.constraints) {
      if (constraint.kind !== 'range' || constraint.source !== 'declared') continue;
      checked = true;
      if (constraint.minimum !== null && proposed < constraint.minimum) {
        return { accepted: false, code: 'out-of-declared-range' };
      }
      if (constraint.maximum !== null && proposed > constraint.maximum) {
        return { accepted: false, code: 'out-of-declared-range' };
      }
    }
    return { accepted: true, checkedAgainstDeclaredBounds: checked };
  }

  if (typeof proposed !== 'string') return { accepted: false, code: 'wrong-type' };
  let checked = false;
  for (const constraint of field.constraints) {
    if (constraint.kind !== 'allowed-values' || constraint.source !== 'declared') continue;
    checked = true;
    if (!constraint.values.includes(proposed)) {
      return { accepted: false, code: 'not-an-allowed-value' };
    }
  }
  return { accepted: true, checkedAgainstDeclaredBounds: checked };
}
