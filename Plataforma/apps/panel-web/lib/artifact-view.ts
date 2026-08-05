/**
 * The shapes this screen consumes are declared locally, mirroring the public
 * contracts, so the panel stays a self-contained static export rather than
 * pulling the contract package into the browser bundle. This is the same
 * approach the configuration screen takes.
 */

export type ArtifactSubmissionState =
  | 'uploaded'
  | 'quarantined'
  | 'analyzing'
  | 'blocked'
  | 'reviewable'
  | 'approved'
  | 'rejected';

export interface ArtifactAnalysisSummary {
  readonly inspected: boolean;
  readonly analyzed: boolean;
  readonly loaders: readonly string[];
  readonly modIds: readonly string[];
  readonly declaredVersions: readonly string[];
  readonly verdict: 'compatible' | 'incompatible' | 'unknown' | null;
  readonly blockerCount: number;
  readonly warningCount: number;
  readonly informationCount: number;
  readonly provenBlockerCount: number;
}

export interface ArtifactSubmission {
  readonly submissionId: string;
  readonly filename: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly state: ArtifactSubmissionState;
  readonly reviewedSide: 'client' | 'server' | 'both' | null;
  readonly submittedAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly analysis: ArtifactAnalysisSummary;
  readonly failure: { readonly code: string; readonly stage: string } | null;
  readonly decision: {
    readonly decision: 'approved' | 'rejected';
    readonly reasonCode: string;
    readonly analyzedSha256: string;
    readonly decidedAt: string;
  } | null;
}

export interface ArtifactSubmissionPage {
  readonly submissions: readonly ArtifactSubmission[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface CompatibilityIssue {
  readonly code: string;
  readonly severity: 'blocker' | 'warning' | 'information';
  readonly determinacy: 'proven' | 'unproven';
  readonly reason: string;
  readonly contextIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly modIds: readonly string[];
  readonly evidence: readonly string[];
  readonly detail: string | null;
  readonly explanation: string;
  readonly recommendedAction: string;
}

export interface ArtifactSubmissionDetail {
  readonly submission: ArtifactSubmission;
  readonly inspection: {
    readonly sha256: string;
    readonly mods: readonly {
      readonly modId: string;
      readonly displayName: string | null;
      readonly version: string | null;
      readonly dependencies: readonly {
        readonly target: string;
        readonly mandatory: boolean;
        readonly versionRange: string | null;
      }[];
    }[];
  } | null;
  readonly compatibility: {
    readonly artifacts: readonly {
      readonly artifactId: string;
      readonly sha256: string;
    }[];
    readonly issues: readonly CompatibilityIssue[];
  } | null;
}

/**
 * View model for the mod review screen.
 *
 * Everything here is pure so the rules that matter are testable without a
 * browser. Three of them hold throughout:
 *  - the panel never offers an install action in this phase;
 *  - a side nobody reviewed is shown as unreviewed, never guessed from a
 *    filename, a loader or the mere presence of the artifact;
 *  - an unproven issue is presented as unverified, never as a proven defect.
 */

export type IssueSeverityFilter = 'all' | 'blocker' | 'warning' | 'information';

export interface ArtifactListItemView {
  readonly submissionId: string;
  readonly filename: string;
  /** Short digest for display. The full hash stays available for a decision. */
  readonly shortSha256: string;
  readonly sha256: string;
  readonly state: ArtifactSubmissionState;
  readonly stateLabel: string;
  readonly sideLabel: string;
  readonly versionLabel: string;
  readonly modIds: readonly string[];
  readonly blockerCount: number;
  readonly warningCount: number;
  readonly informationCount: number;
  readonly unverified: boolean;
  /** Whether a person may take a decision from this state right now. */
  readonly decidable: boolean;
  readonly version: number;
}

export interface ArtifactListView {
  readonly items: readonly ArtifactListItemView[];
  readonly total: number;
  readonly shown: number;
  readonly emptyReason: 'none' | 'no-submissions' | 'no-match';
}

const STATE_LABELS: Readonly<Record<ArtifactSubmissionState, string>> = Object.freeze({
  uploaded: 'Enviado',
  quarantined: 'Em quarentena',
  analyzing: 'Em análise',
  blocked: 'Bloqueado',
  reviewable: 'Aguardando revisão',
  approved: 'Aprovado',
  rejected: 'Rejeitado',
});

const SIDE_LABELS: Readonly<Record<'client' | 'server' | 'both', string>> = Object.freeze({
  client: 'Cliente',
  server: 'Servidor',
  both: 'Cliente e servidor',
});

/** A side nobody reviewed is stated as such; presence never stands in for it. */
export function sideLabelFor(submission: ArtifactSubmission): string {
  return submission.reviewedSide === null ? 'Não revisado' : SIDE_LABELS[submission.reviewedSide];
}

export function versionLabelFor(submission: ArtifactSubmission): string {
  const versions = submission.analysis.declaredVersions;
  if (versions.length === 0) return submission.analysis.inspected ? 'Não declarada' : '—';
  return versions.length === 1 ? (versions[0] as string) : versions.join(', ');
}

function matchesSearch(submission: ArtifactSubmission, search: string): boolean {
  const term = search.trim().toLocaleLowerCase('pt-BR');
  if (term.length === 0) return true;
  if (submission.filename.toLocaleLowerCase('pt-BR').includes(term)) return true;
  if (submission.sha256.startsWith(term)) return true;
  return submission.analysis.modIds.some((modId) => modId.includes(term));
}

/** Only these states let a person record a decision. */
export function isDecidable(state: ArtifactSubmissionState): boolean {
  return state === 'reviewable' || state === 'blocked';
}

export function buildArtifactListView(input: {
  readonly page: ArtifactSubmissionPage;
  readonly search?: string;
  readonly side?: 'client' | 'server' | 'both' | 'unreviewed';
  readonly state?: ArtifactSubmissionState;
}): ArtifactListView {
  const matched = input.page.submissions.filter((submission) => {
    if (!matchesSearch(submission, input.search ?? '')) return false;
    if (input.state !== undefined && submission.state !== input.state) return false;
    if (input.side !== undefined) {
      const side = submission.reviewedSide;
      if (input.side === 'unreviewed' ? side !== null : side !== input.side) return false;
    }
    return true;
  });

  const items = matched.map((submission) => ({
    submissionId: submission.submissionId,
    filename: submission.filename,
    shortSha256: submission.sha256.slice(0, 12),
    sha256: submission.sha256,
    state: submission.state,
    stateLabel: STATE_LABELS[submission.state],
    sideLabel: sideLabelFor(submission),
    versionLabel: versionLabelFor(submission),
    modIds: [...submission.analysis.modIds],
    blockerCount: submission.analysis.blockerCount,
    warningCount: submission.analysis.warningCount,
    informationCount: submission.analysis.informationCount,
    // A blocker that was only unproven means the artifact could not be cleared,
    // not that it was shown to be broken.
    unverified:
      submission.analysis.blockerCount > submission.analysis.provenBlockerCount ||
      submission.failure !== null,
    decidable: isDecidable(submission.state),
    version: submission.version,
  }));

  return {
    items,
    total: input.page.total,
    shown: items.length,
    emptyReason:
      items.length > 0 ? 'none' : input.page.submissions.length === 0 ? 'no-submissions' : 'no-match',
  };
}

export type UploadPhase = 'idle' | 'hashing' | 'uploading' | 'quarantined' | 'analyzing' | 'failed';

export interface UploadProgressView {
  readonly phase: UploadPhase;
  readonly percent: number;
  readonly label: string;
  readonly busy: boolean;
}

/**
 * Progress for one upload. The percentage only describes bytes sent; quarantine
 * and analysis are separate durable steps, so they are never reported as a
 * fraction of an upload that already finished.
 */
export function buildUploadProgressView(input: {
  readonly phase: UploadPhase;
  readonly sentBytes?: number;
  readonly totalBytes?: number;
}): UploadProgressView {
  const total = input.totalBytes ?? 0;
  const sent = Math.min(input.sentBytes ?? 0, total);
  const percent = total > 0 ? Math.floor((sent / total) * 100) : 0;

  if (input.phase === 'idle') return { phase: 'idle', percent: 0, label: 'Nenhum envio', busy: false };
  if (input.phase === 'hashing') {
    return { phase: 'hashing', percent: 0, label: 'Calculando o hash do arquivo', busy: true };
  }
  if (input.phase === 'uploading') {
    return { phase: 'uploading', percent, label: `Enviando ${String(percent)}%`, busy: true };
  }
  if (input.phase === 'quarantined') {
    return { phase: 'quarantined', percent: 100, label: 'Em quarentena', busy: false };
  }
  if (input.phase === 'analyzing') {
    return { phase: 'analyzing', percent: 100, label: 'Em análise', busy: true };
  }
  return { phase: 'failed', percent, label: 'O envio foi recusado', busy: false };
}

export interface IncompatibilityRowView {
  readonly code: string;
  readonly severity: CompatibilityIssue['severity'];
  readonly severityLabel: string;
  readonly determinacy: CompatibilityIssue['determinacy'];
  readonly determinacyLabel: string;
  readonly reason: string;
  readonly explanation: string;
  readonly detail: string | null;
  readonly evidence: readonly string[];
  readonly recommendedAction: string;
  readonly modIds: readonly string[];
}

export interface IncompatibilityDrawerView {
  readonly available: boolean;
  readonly rows: readonly IncompatibilityRowView[];
  readonly counts: {
    readonly blocker: number;
    readonly warning: number;
    readonly information: number;
  };
  readonly filter: IssueSeverityFilter;
  readonly emptyLabel: string;
}

const SEVERITY_LABELS = Object.freeze({
  blocker: 'Bloqueio',
  warning: 'Aviso',
  information: 'Informação',
});

const DETERMINACY_LABELS = Object.freeze({
  proven: 'Comprovado',
  unproven: 'Não comprovado',
});

/**
 * Builds the incompatibility drawer from the stored report. Severity, reason
 * and evidence come straight from the engine; the panel adds a label and never
 * a judgement of its own.
 */
export function buildIncompatibilityDrawerView(
  detail: ArtifactSubmissionDetail,
  filter: IssueSeverityFilter = 'all',
): IncompatibilityDrawerView {
  const report = detail.compatibility;
  if (report === null) {
    return {
      available: false,
      rows: [],
      counts: { blocker: 0, warning: 0, information: 0 },
      filter,
      emptyLabel:
        detail.submission.failure === null
          ? 'A análise ainda não foi concluída.'
          : 'O artefato foi recusado antes da análise de compatibilidade.',
    };
  }

  const judged = report.artifacts.find(
    (artifact) => artifact.sha256 === detail.submission.sha256,
  );
  const issues = report.issues.filter((issue) =>
    judged === undefined ? false : issue.artifactIds.includes(judged.artifactId),
  );
  const counts = {
    blocker: issues.filter((issue) => issue.severity === 'blocker').length,
    warning: issues.filter((issue) => issue.severity === 'warning').length,
    information: issues.filter((issue) => issue.severity === 'information').length,
  };
  const visible = filter === 'all' ? issues : issues.filter((issue) => issue.severity === filter);

  return {
    available: true,
    rows: visible.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      severityLabel: SEVERITY_LABELS[issue.severity],
      determinacy: issue.determinacy,
      determinacyLabel: DETERMINACY_LABELS[issue.determinacy],
      reason: issue.reason,
      explanation: issue.explanation,
      detail: issue.detail,
      evidence: [...issue.evidence],
      recommendedAction: issue.recommendedAction,
      modIds: [...issue.modIds],
    })),
    counts,
    filter,
    emptyLabel:
      issues.length === 0
        ? 'Nenhuma incompatibilidade registrada.'
        : 'Nenhuma incompatibilidade nesta severidade.',
  };
}

export interface DependencyNodeView {
  readonly id: string;
  readonly kind: 'declared-mod' | 'dependency';
  readonly label: string;
}

export interface DependencyEdgeView {
  readonly from: string;
  readonly to: string;
  readonly mandatory: boolean;
  readonly versionRange: string | null;
}

export interface DependencyGraphView {
  readonly available: boolean;
  readonly nodes: readonly DependencyNodeView[];
  readonly edges: readonly DependencyEdgeView[];
}

/**
 * Builds the dependency graph on demand from the stored inspection. It shows
 * what the artifact declares; it never resolves a dependency against a
 * repository and never opens a nested JAR.
 */
export function buildDependencyGraphView(detail: ArtifactSubmissionDetail): DependencyGraphView {
  const inspection = detail.inspection;
  if (inspection === null) return { available: false, nodes: [], edges: [] };

  const nodes = new Map<string, DependencyNodeView>();
  const edges: DependencyEdgeView[] = [];
  for (const mod of inspection.mods) {
    nodes.set(mod.modId, { id: mod.modId, kind: 'declared-mod', label: mod.displayName ?? mod.modId });
  }
  for (const mod of inspection.mods) {
    for (const dependency of mod.dependencies) {
      const target = dependency.target.trim().toLocaleLowerCase('en-US');
      if (!nodes.has(target)) {
        nodes.set(target, { id: target, kind: 'dependency', label: target });
      }
      edges.push({
        from: mod.modId,
        to: target,
        mandatory: dependency.mandatory,
        versionRange: dependency.versionRange,
      });
    }
  }

  const ordered = [...nodes.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const orderedEdges = [...edges].sort((left, right) =>
    left.from === right.from ? (left.to < right.to ? -1 : 1) : left.from < right.from ? -1 : 1,
  );
  return { available: true, nodes: ordered, edges: orderedEdges };
}

export interface InstallActionView {
  readonly present: boolean;
  readonly enabled: boolean;
  readonly reason: string;
}

/**
 * Phase 8 reviews artifacts; it never installs one. The action is reported as
 * absent so no screen can render an enabled button by accident.
 */
export function buildInstallActionView(): InstallActionView {
  return {
    present: false,
    enabled: false,
    reason: 'A instalação não pertence a esta fase; aprovar altera somente o estado de revisão.',
  };
}
