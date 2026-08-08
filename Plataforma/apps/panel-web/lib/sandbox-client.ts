/**
 * Typed client for staged changes and sandbox runs.
 *
 * Same rule as the rest of the track: nothing is decided here. Whether a boot
 * succeeded, what it generated and what it logged are all the engine's answers,
 * and this file carries them to a screen.
 */

export interface StagedChangeSummary {
  readonly path: string;
  readonly changes: readonly { readonly path: string; readonly value: unknown }[];
  readonly baseSha256: string;
  readonly stagedSha256: string;
  readonly stagedAt: string;
}

export interface SandboxEvidence {
  readonly java?: { readonly version: string; readonly source: string };
  readonly filesCopied?: number;
  readonly mebibytesCopied?: number;
  /** Files that did not exist before the boot — the payoff of booting at all. */
  readonly generatedFiles?: readonly string[];
  /** Bounded: a crashing mod produces megabytes in seconds. */
  readonly tail?: readonly string[];
  readonly disposed?: boolean;
  readonly disposalError?: string | null;
  readonly changes?: readonly {
    readonly path: string;
    readonly observedSha256: string | null;
    readonly valuesHeld: boolean | null;
  }[];
  readonly workspaceUnchanged?: boolean | null;
}

export interface SandboxRunView {
  readonly runId: string;
  readonly status: 'running' | 'finished' | 'refused';
  /** `null` while it runs. Not knowing yet is its own state. */
  readonly outcome: string | null;
  readonly refusal: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly testedChanges: boolean;
  readonly progress: readonly string[];
  readonly evidence: SandboxEvidence | null;
}

/** What each boot outcome means, in the operator's language. */
export const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  booted: 'Subiu',
  'timed-out': 'Ainda carregando quando a janela fechou',
  'exited-early': 'Encerrou antes de terminar de carregar',
  'failed-to-start': 'Não chegou a iniciar',
};

export const OUTCOME_TONE: Readonly<Record<string, 'positive' | 'warning' | 'danger'>> = {
  booted: 'positive',
  // Not a failure — an unknown. The window closed, the server had not finished.
  'timed-out': 'warning',
  'exited-early': 'danger',
  'failed-to-start': 'danger',
};
