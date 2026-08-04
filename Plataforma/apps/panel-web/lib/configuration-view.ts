/**
 * View model for the configuration workflow.
 *
 * This is the only panel area backed by the real Control API. Everything here
 * is pure so the rules that matter — what may be edited, what may be shown and
 * what a failure means — are testable without a browser.
 *
 * Three rules hold throughout:
 *  - a redacted value is never rendered and never diffed;
 *  - an action absent from the session's permissions is not offered at all;
 *  - a restart requirement is metadata, never a button.
 */

export type ConfigurationFieldDescriptorView =
  | { readonly name: string; readonly type: 'boolean'; readonly restartRequired: boolean; readonly readable: boolean }
  | {
      readonly name: string;
      readonly type: 'integer';
      readonly minimum: number;
      readonly maximum: number;
      readonly restartRequired: boolean;
      readonly readable: boolean;
    }
  | {
      readonly name: string;
      readonly type: 'enum';
      readonly values: readonly string[];
      readonly restartRequired: boolean;
      readonly readable: boolean;
    }
  | {
      readonly name: string;
      readonly type: 'string';
      readonly maximumLength: number;
      readonly restartRequired: boolean;
      readonly readable: boolean;
    };

export interface ConfigurationSchemaView {
  readonly schemaId: string;
  readonly resourceId: string;
  readonly definitionVersion: string;
  readonly definitionSha256: string;
  readonly codecId: string;
  readonly applyMode: string;
  readonly maximumBytes: number;
  readonly restartRequired: boolean;
  readonly registered: boolean;
  readonly fields: readonly ConfigurationFieldDescriptorView[];
}

export type ConfigurationValueView =
  | { readonly name: string; readonly redacted: false; readonly value: boolean | number | string }
  | { readonly name: string; readonly redacted: true };

export interface ConfigurationResourceStateView {
  readonly resourceId: string;
  readonly status: 'registered' | 'prepared' | 'applied' | 'failed';
  readonly currentSha256: string;
  readonly stateVersion: number;
  readonly updatedAt: string;
  readonly pendingRevisionId: string | null;
  readonly lastAppliedRevisionId: string | null;
  readonly restartRequired: boolean;
  readonly valuesAvailable: boolean;
  readonly values: readonly ConfigurationValueView[];
}

export interface ConfigurationRevisionView {
  readonly revisionId: string;
  readonly operation: 'update' | 'rollback';
  readonly status: 'prepared' | 'applied' | 'failed';
  readonly changedFields: readonly string[] | null;
  readonly restartRequired: boolean | null;
  readonly reasonCode: string;
  readonly failureCode: string | null;
  readonly rollbackEligible: boolean;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export type ConfigurationPermissionName =
  | 'configuration.view'
  | 'configuration.validate'
  | 'configuration.apply'
  | 'configuration.rollback';

export interface ConfigurationCapabilities {
  readonly canView: boolean;
  readonly canValidate: boolean;
  readonly canApply: boolean;
  readonly canRollback: boolean;
}

export function capabilitiesFor(permissions: readonly string[]): ConfigurationCapabilities {
  const granted = new Set(permissions);
  return Object.freeze({
    canView: granted.has('configuration.view'),
    canValidate: granted.has('configuration.validate'),
    canApply: granted.has('configuration.apply'),
    canRollback: granted.has('configuration.rollback'),
  });
}

export type ConfigurationDraft = Readonly<Record<string, boolean | number | string>>;

export interface ConfigurationDiffEntry {
  readonly name: string;
  readonly from: boolean | number | string;
  readonly to: boolean | number | string;
  readonly restartRequired: boolean;
}

export interface ConfigurationDiff {
  readonly entries: readonly ConfigurationDiffEntry[];
  /** Fields the operator edited whose current value could not be read. */
  readonly undiffableFields: readonly string[];
  readonly restartRequired: boolean;
  readonly hasChanges: boolean;
}

/**
 * Builds a diff that can be shown safely.
 *
 * A redacted field has no readable current value, so it is reported as
 * undiffable instead of being displayed as changing from an invented baseline.
 * A field missing from the schema is ignored: the panel never invents one.
 */
export function computeSafeDiff(
  schema: ConfigurationSchemaView,
  state: ConfigurationResourceStateView,
  draft: ConfigurationDraft,
): ConfigurationDiff {
  const descriptors = new Map(schema.fields.map((field) => [field.name, field]));
  const readable = new Map(
    state.values.flatMap((value) => (value.redacted ? [] : ([[value.name, value.value]] as const))),
  );
  const entries: ConfigurationDiffEntry[] = [];
  const undiffableFields: string[] = [];

  for (const name of Object.keys(draft).sort()) {
    const descriptor = descriptors.get(name);
    const next = draft[name];
    if (descriptor === undefined || next === undefined) continue;
    if (!descriptor.readable || !state.valuesAvailable || !readable.has(name)) {
      undiffableFields.push(name);
      continue;
    }
    const current = readable.get(name);
    if (current === undefined || current === next) continue;
    entries.push(
      Object.freeze({
        name,
        from: current,
        to: next,
        restartRequired: descriptor.restartRequired,
      }),
    );
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    undiffableFields: Object.freeze(undiffableFields),
    restartRequired: entries.some((entry) => entry.restartRequired),
    hasChanges: entries.length > 0,
  });
}

/** Change entries for the API, derived from the safe diff so they always agree. */
export function changeEntriesFor(
  diff: ConfigurationDiff,
): readonly { readonly name: string; readonly value: boolean | number | string }[] {
  return Object.freeze(diff.entries.map((entry) => Object.freeze({ name: entry.name, value: entry.to })));
}

export type ConfigurationScreenState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'denied'; readonly message: string }
  | { readonly kind: 'empty'; readonly message: string }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'error'; readonly code: string; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly schema: ConfigurationSchemaView;
      readonly state: ConfigurationResourceStateView;
      readonly revisions: readonly ConfigurationRevisionView[];
      readonly capabilities: ConfigurationCapabilities;
      readonly editableFields: readonly ConfigurationFieldDescriptorView[];
      readonly rollbackCandidates: readonly ConfigurationRevisionView[];
      readonly restartNotice: string | null;
      readonly valuesNotice: string | null;
      readonly busyNotice: string | null;
    };

const MESSAGES = Object.freeze({
  denied: 'Sua sessão não tem permissão para ver as configurações desta instância.',
  empty: 'Nenhuma configuração revisada está registrada para esta instância.',
  conflict: 'A configuração mudou desde a leitura. Recarregue antes de aplicar novamente.',
  idempotency: 'Esta chave de idempotência já foi usada para outra solicitação.',
  invalid: 'As alterações não são válidas para o schema revisado.',
  unavailable: 'Não foi possível concluir a operação. Tente novamente.',
});

/** Maps a Control API failure onto a screen state without echoing internals. */
export function screenStateForError(status: number, code?: string): ConfigurationScreenState {
  if (status === 401 || status === 403) return { kind: 'denied', message: MESSAGES.denied };
  if (status === 404) return { kind: 'empty', message: MESSAGES.empty };
  if (status === 409) {
    return {
      kind: 'conflict',
      message:
        code === 'CONFIGURATION_IDEMPOTENCY_CONFLICT' ? MESSAGES.idempotency : MESSAGES.conflict,
    };
  }
  if (status === 422) {
    return { kind: 'error', code: code ?? 'CONFIGURATION_CHANGES_INVALID', message: MESSAGES.invalid };
  }
  return { kind: 'error', code: code ?? 'UNKNOWN', message: MESSAGES.unavailable };
}

export function buildConfigurationScreen(input: {
  readonly schema: ConfigurationSchemaView | undefined;
  readonly state: ConfigurationResourceStateView | undefined;
  readonly revisions: readonly ConfigurationRevisionView[];
  readonly permissions: readonly string[];
}): ConfigurationScreenState {
  const capabilities = capabilitiesFor(input.permissions);
  if (!capabilities.canView) return { kind: 'denied', message: MESSAGES.denied };
  if (input.schema === undefined || input.state === undefined || !input.schema.registered) {
    return { kind: 'empty', message: MESSAGES.empty };
  }

  // Only a readable field can be edited: an operator must never overwrite a
  // value the panel could not show them.
  const editableFields = capabilities.canApply
    ? input.schema.fields.filter((field) => field.readable)
    : [];

  const busyNotice =
    input.state.status === 'prepared'
      ? 'Uma operação está em andamento nesta configuração. Aguarde a conclusão.'
      : null;

  return {
    kind: 'ready',
    schema: input.schema,
    state: input.state,
    revisions: input.revisions,
    capabilities,
    editableFields: Object.freeze(editableFields),
    rollbackCandidates: capabilities.canRollback
      ? Object.freeze(input.revisions.filter((revision) => revision.rollbackEligible))
      : Object.freeze([]),
    restartNotice: input.schema.restartRequired
      ? 'Alterações nesta configuração só passam a valer após o próximo reinício do Minecraft. O painel não reinicia o servidor.'
      : null,
    valuesNotice: input.state.valuesAvailable
      ? null
      : 'Os valores atuais não estão disponíveis porque nenhum leitor autorizado está conectado.',
    busyNotice,
  };
}

/** Human label for a value, never revealing a redacted one. */
export function displayValue(value: ConfigurationValueView): string {
  if (value.redacted) return 'Redigido';
  if (typeof value.value === 'boolean') return value.value ? 'Ativado' : 'Desativado';
  return String(value.value);
}
