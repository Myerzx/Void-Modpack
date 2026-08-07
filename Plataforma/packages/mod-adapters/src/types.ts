import type { InferredField, InferredForm } from '@voidfall/configuration-inference';

/**
 * Adapters that organise a mod's configuration into something usable.
 *
 * An adapter does exactly one thing the generic inferrer cannot: it groups
 * fields into categories a person can navigate. Eighty-three settings in a
 * single flat table is a document, not an interface.
 *
 * What an adapter deliberately does **not** do is add meaning. It does not say
 * what a field is for, does not recommend a value, and does not invent a bound
 * — bounds still come only from what the mod declared in its own file. Grouping
 * by name is a presentation aid, and a wrong grouping puts a setting on the
 * wrong screen; inventing semantics would put a wrong value in somebody's
 * server.
 *
 * `uncategorised` is therefore a first-class outcome, not a failure. A mod that
 * adds a setting the rules do not recognise gets it shown, in a bucket that
 * says so, rather than hidden because no rule matched.
 */

export interface CategoryDefinition {
  readonly id: string;
  /** Shown to a person. Deliberately plain, and not a claim about behaviour. */
  readonly title: string;
}

export interface CategorisedField {
  readonly field: InferredField;
  readonly categoryId: string;
  /** The rule that placed it, so a reader can judge the grouping. */
  readonly matchedBy: string;
}

export interface CategorisedForm {
  readonly modId: string;
  readonly categories: readonly CategoryDefinition[];
  readonly fields: readonly CategorisedField[];
  /** Fields no rule claimed. Shown, never dropped. */
  readonly uncategorised: readonly InferredField[];
}

export interface ModConfigurationAdapter {
  readonly modId: string;
  /** Whether this adapter owns a given workspace-relative path. */
  appliesTo(path: string): boolean;
  categorise(form: InferredForm): CategorisedForm;
}

/** One naming rule, kept as data so the whole set can be read at a glance. */
export interface CategoryRule {
  readonly categoryId: string;
  /** Named so a misplacement can be traced to the rule that caused it. */
  readonly id: string;
  readonly matches: (fieldName: string) => boolean;
}

/** The last path segment, lowercased — what the rules actually match on. */
export function fieldNameOf(field: InferredField): string {
  const segments = field.path.split('.');
  return (segments[segments.length - 1] ?? '').toLocaleLowerCase('en-US');
}

/**
 * Applies rules in order and keeps the first match.
 *
 * First match rather than best match: with overlapping name patterns, "best"
 * would need a scoring function nobody could predict from reading the rules,
 * and a categoriser whose output cannot be predicted from its rules is one
 * nobody can fix.
 */
export function categoriseByRules(input: {
  readonly modId: string;
  readonly form: InferredForm;
  readonly categories: readonly CategoryDefinition[];
  readonly rules: readonly CategoryRule[];
}): CategorisedForm {
  const fields: CategorisedField[] = [];
  const uncategorised: InferredField[] = [];

  for (const field of input.form.fields) {
    const name = fieldNameOf(field);
    const rule = input.rules.find((candidate) => candidate.matches(name));
    if (rule === undefined) {
      uncategorised.push(field);
      continue;
    }
    fields.push({ field, categoryId: rule.categoryId, matchedBy: rule.id });
  }

  return Object.freeze({
    modId: input.modId,
    // Only categories that actually hold something. An empty tab is a promise
    // the configuration did not keep.
    categories: Object.freeze(
      input.categories.filter((category) =>
        fields.some((entry) => entry.categoryId === category.id),
      ),
    ),
    fields: Object.freeze(fields),
    uncategorised: Object.freeze(uncategorised),
  });
}
