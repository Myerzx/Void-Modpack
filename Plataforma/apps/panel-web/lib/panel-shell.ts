/**
 * Shared shell for every panel screen.
 *
 * Three rules hold across the whole panel and are expressed here once rather
 * than repeated per page:
 *
 *  - a screen states which of loading, empty, unavailable, denied or error it
 *    is in, and never renders content for a state it is not in;
 *  - an action the session has no permission for is not rendered at all, so a
 *    disabled control never hints at authority the user does not hold;
 *  - a mutation that belongs to a later phase stays unavailable, whatever the
 *    permissions say, because the capability behind it does not exist yet.
 *
 * The shapes are declared locally, mirroring the public contracts, so the
 * panel stays a self-contained static export.
 */

export type ScreenState = 'ready' | 'loading' | 'empty' | 'unavailable' | 'denied' | 'error';

export interface ScreenStateView {
  readonly state: ScreenState;
  readonly title: string;
  readonly detail: string;
  /** True only when the screen should render its content. */
  readonly showsContent: boolean;
}

const SCREEN_COPY: Readonly<Record<Exclude<ScreenState, 'ready'>, { title: string; detail: string }>> =
  Object.freeze({
    loading: { title: 'Carregando', detail: 'Consultando a Control API.' },
    empty: { title: 'Nada por aqui', detail: 'Não há registros para os filtros atuais.' },
    unavailable: {
      title: 'Indisponível',
      detail: 'A área existe, mas a origem dos dados ainda não está ligada.',
    },
    denied: {
      title: 'Sem permissão',
      detail: 'Sua sessão não tem permissão para ver esta área.',
    },
    error: { title: 'Falha ao carregar', detail: 'A Control API não respondeu como esperado.' },
  });

export function screenStateView(state: ScreenState, detail?: string): ScreenStateView {
  if (state === 'ready') {
    return { state, title: '', detail: detail ?? '', showsContent: true };
  }
  const copy = SCREEN_COPY[state];
  return {
    state,
    title: copy.title,
    detail: detail ?? copy.detail,
    showsContent: false,
  };
}

/**
 * Maps an HTTP status onto a screen state.
 *
 * A refusal is never shown as an error: being denied is a different fact from
 * something breaking, and conflating them would teach an operator to ignore
 * both.
 */
export function screenStateForStatus(status: number): ScreenState {
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'empty';
  if (status === 503) return 'unavailable';
  return 'error';
}

export interface PanelSession {
  readonly userId: string;
  readonly displayName: string;
  readonly permissions: readonly string[];
  readonly csrfToken: string;
}

export function hasPermission(session: PanelSession, permission: string): boolean {
  return session.permissions.includes(permission);
}

/**
 * Actions the panel knows about, each bound to the permission that authorizes
 * it and to whether the capability behind it exists yet.
 *
 * `available: false` means the phase that implements it has not landed. It is
 * deliberately separate from permission: an owner still may not start a server
 * from the panel, because nothing in the control plane can carry that out.
 */
interface ActionPolicy {
  readonly permission: string;
  readonly available: boolean;
  readonly unavailableReason: string;
}

const ACTIONS: Readonly<Record<string, ActionPolicy>> = Object.freeze({
  'artifact.upload': {
    permission: 'mods.manage',
    available: true,
    unavailableReason: '',
  },
  'artifact.decide': {
    permission: 'mods.classify',
    available: true,
    unavailableReason: '',
  },
  'configuration.apply': {
    permission: 'configuration.apply',
    available: true,
    unavailableReason: '',
  },
  'configuration.rollback': {
    permission: 'configuration.rollback',
    available: true,
    unavailableReason: '',
  },
  // Waited for the phase that actually carries them out, and it arrived: the
  // agent runs, claims a durable operation, starts a real Forge server and
  // settles the operation afterwards. Turning these on before the settlement
  // worked would have given the panel a start button and no stop button.
  'server.start': {
    permission: 'server.control.start',
    available: true,
    unavailableReason: '',
  },
  'server.stop': {
    permission: 'server.control.stop',
    available: true,
    unavailableReason: '',
  },
  'server.restart': {
    permission: 'server.control.restart',
    available: true,
    unavailableReason: '',
  },
  'console.command': {
    permission: 'console.command',
    available: true,
    unavailableReason: '',
  },
  'backup.create': {
    permission: 'backups.create',
    available: false,
    unavailableReason: 'Backups operacionais pertencem à Fase 10.',
  },
  'artifact.install': {
    permission: 'mods.manage',
    available: false,
    unavailableReason: 'Aprovar altera o estado de revisão; instalar não pertence a esta fase.',
  },
});

export interface ActionView {
  readonly id: string;
  /** False when the action must not be rendered at all. */
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly reason: string;
}

/**
 * Decides how one action may appear.
 *
 * Without the permission the action is invisible, not merely disabled — a
 * greyed-out control still tells the user the capability exists and that they
 * were refused, which is information they have no need for.
 */
export function actionView(session: PanelSession, actionId: string): ActionView {
  const policy = ACTIONS[actionId];
  if (policy === undefined) {
    return { id: actionId, visible: false, enabled: false, reason: 'Ação desconhecida.' };
  }
  if (!hasPermission(session, policy.permission)) {
    return { id: actionId, visible: false, enabled: false, reason: 'Sem permissão.' };
  }
  if (!policy.available) {
    return { id: actionId, visible: true, enabled: false, reason: policy.unavailableReason };
  }
  return { id: actionId, visible: true, enabled: true, reason: '' };
}

export function knownActionIds(): readonly string[] {
  return Object.keys(ACTIONS).sort();
}

/**
 * Where a displayed value came from and how much it can be trusted.
 *
 * Every tile carries this, so a fixture can never be mistaken for a live
 * reading and a stale observation is never presented as current.
 */
export type DataSource = 'control-api' | 'agent-observation' | 'demo-fixture';
export type DataQuality = 'live' | 'stale' | 'unknown' | 'demo';

export interface DataProvenance {
  readonly source: DataSource;
  readonly quality: DataQuality;
  /** ISO instant the value was observed, or null when nothing observed it. */
  readonly observedAt: string | null;
  readonly label: string;
}

const SOURCE_LABELS: Readonly<Record<DataSource, string>> = Object.freeze({
  'control-api': 'Control API',
  'agent-observation': 'Observado pelo agente',
  'demo-fixture': 'Fixture de demonstração',
});

const QUALITY_LABELS: Readonly<Record<DataQuality, string>> = Object.freeze({
  live: 'atual',
  stale: 'desatualizado',
  unknown: 'desconhecido',
  demo: 'demonstração',
});

export function provenance(input: {
  readonly source: DataSource;
  readonly quality: DataQuality;
  readonly observedAt?: string | null;
}): DataProvenance {
  return {
    source: input.source,
    quality: input.quality,
    observedAt: input.observedAt ?? null,
    label: `${SOURCE_LABELS[input.source]} · ${QUALITY_LABELS[input.quality]}`,
  };
}
