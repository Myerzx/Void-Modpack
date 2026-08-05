import {
  provenance,
  screenStateForStatus,
  screenStateView,
  type DataProvenance,
  type PanelSession,
  type ScreenStateView,
} from './panel-shell';

/**
 * View models for the Phase 9.3 panel areas backed by the real Control API:
 * the instance selector, the dashboard, the operations list and the audit
 * page.
 *
 * Every value states where it came from. An area whose source is not wired yet
 * says so through `unavailable`, and a fixture is labelled a fixture — nothing
 * here lets demonstration data look like a live reading.
 */

export interface ServerInstance {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly environment: string;
  readonly minecraftVersion: string;
  readonly loader: string;
  readonly loaderVersion?: string;
  readonly desiredState: string;
  readonly observedState: string;
}

export interface InstanceOption {
  readonly id: string;
  readonly label: string;
  readonly environment: string;
  readonly runtimeLabel: string;
  readonly selected: boolean;
}

export interface InstanceSelectorView {
  readonly screen: ScreenStateView;
  readonly options: readonly InstanceOption[];
  readonly selectedId: string | null;
  readonly provenance: DataProvenance;
}

/**
 * Builds the instance selector from the real server list.
 *
 * A selection that is not in the list is dropped rather than kept, so the
 * panel cannot go on showing data for an instance the session can no longer
 * see.
 */
export function buildInstanceSelectorView(input: {
  readonly session: PanelSession;
  readonly instances?: readonly ServerInstance[];
  readonly selectedId?: string | null;
  readonly status?: number;
}): InstanceSelectorView {
  const source = provenance({ source: 'control-api', quality: 'live' });
  if (!input.session.permissions.includes('server.view')) {
    return { screen: screenStateView('denied'), options: [], selectedId: null, provenance: source };
  }
  if (input.status !== undefined && input.status >= 400) {
    return {
      screen: screenStateView(screenStateForStatus(input.status)),
      options: [],
      selectedId: null,
      provenance: source,
    };
  }
  if (input.instances === undefined) {
    return { screen: screenStateView('loading'), options: [], selectedId: null, provenance: source };
  }
  if (input.instances.length === 0) {
    return {
      screen: screenStateView('empty', 'Nenhuma instância registrada.'),
      options: [],
      selectedId: null,
      provenance: source,
    };
  }

  const known = new Set(input.instances.map((instance) => instance.id));
  const selectedId =
    input.selectedId !== undefined && input.selectedId !== null && known.has(input.selectedId)
      ? input.selectedId
      : (input.instances[0]?.id ?? null);

  return {
    screen: screenStateView('ready'),
    selectedId,
    provenance: source,
    options: input.instances.map((instance) => ({
      id: instance.id,
      label: instance.displayName,
      environment: instance.environment,
      runtimeLabel:
        instance.loaderVersion === undefined
          ? `${instance.minecraftVersion} · ${instance.loader}`
          : `${instance.minecraftVersion} · ${instance.loader} ${instance.loaderVersion}`,
      selected: instance.id === selectedId,
    })),
  };
}

export interface ProcessStateReading {
  readonly lifecycle: 'unknown' | 'offline' | 'starting' | 'online' | 'stopping' | 'error';
  readonly observedPid: number | null;
  readonly observedAt: string;
  readonly stale: boolean;
  readonly observed: boolean;
}

export interface DashboardTile {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly provenance: DataProvenance;
}

export interface DashboardView {
  readonly screen: ScreenStateView;
  readonly tiles: readonly DashboardTile[];
  /** Areas still backed by fixtures, named so nobody mistakes them for live. */
  readonly fixtureAreas: readonly string[];
}

const LIFECYCLE_LABELS: Readonly<Record<ProcessStateReading['lifecycle'], string>> = Object.freeze({
  unknown: 'Desconhecido',
  offline: 'Desligado',
  starting: 'Iniciando',
  online: 'Ligado',
  stopping: 'Parando',
  error: 'Erro',
});

/**
 * Builds the dashboard for one instance.
 *
 * The process tile is the honest one: an observation nobody is following any
 * more is reported as unknown and stale, never as the last thing somebody saw.
 */
export function buildDashboardView(input: {
  readonly session: PanelSession;
  readonly instance?: ServerInstance;
  readonly processState?: ProcessStateReading;
  readonly openOperations?: number;
  readonly status?: number;
}): DashboardView {
  if (!input.session.permissions.includes('dashboard.view')) {
    return { screen: screenStateView('denied'), tiles: [], fixtureAreas: [] };
  }
  if (input.status !== undefined && input.status >= 400) {
    return { screen: screenStateView(screenStateForStatus(input.status)), tiles: [], fixtureAreas: [] };
  }
  if (input.instance === undefined) {
    return { screen: screenStateView('loading'), tiles: [], fixtureAreas: [] };
  }

  const tiles: DashboardTile[] = [
    {
      id: 'instance',
      label: 'Instância',
      value: input.instance.displayName,
      provenance: provenance({ source: 'control-api', quality: 'live' }),
    },
    {
      id: 'runtime',
      label: 'Runtime',
      value: `${input.instance.minecraftVersion} · ${input.instance.loader}`,
      provenance: provenance({ source: 'control-api', quality: 'live' }),
    },
  ];

  if (input.processState === undefined || !input.processState.observed) {
    // Never observed is not the same as offline, and the panel says so.
    tiles.push({
      id: 'process',
      label: 'Processo',
      value: LIFECYCLE_LABELS.unknown,
      provenance: provenance({ source: 'agent-observation', quality: 'unknown', observedAt: null }),
    });
  } else {
    const reading = input.processState;
    tiles.push({
      id: 'process',
      label: 'Processo',
      value: LIFECYCLE_LABELS[reading.lifecycle],
      provenance: provenance({
        source: 'agent-observation',
        quality: reading.stale ? 'stale' : 'live',
        observedAt: reading.observedAt,
      }),
    });
    if (reading.observedPid !== null) {
      tiles.push({
        id: 'pid',
        label: 'PID observado',
        value: String(reading.observedPid),
        provenance: provenance({
          source: 'agent-observation',
          quality: reading.stale ? 'stale' : 'live',
          observedAt: reading.observedAt,
        }),
      });
    }
  }

  if (input.openOperations !== undefined) {
    tiles.push({
      id: 'operations',
      label: 'Operações em voo',
      value: String(input.openOperations),
      provenance: provenance({ source: 'control-api', quality: 'live' }),
    });
  }

  return {
    screen: screenStateView('ready'),
    tiles,
    // Named explicitly so the dashboard never implies these are live.
    fixtureAreas: ['Métricas de host', 'Atividade recente'],
  };
}

export interface OperationRow {
  readonly operationId: string;
  readonly kind: string;
  readonly status: string;
  readonly acceptedAt: string;
  readonly correlationId: string;
  readonly receiptOutcome: string | null;
  readonly failureCode: string | null;
}

export interface OperationsView {
  readonly screen: ScreenStateView;
  readonly rows: readonly OperationRow[];
  readonly total: number;
  readonly provenance: DataProvenance;
}

export interface OperationPageInput {
  readonly operations: readonly {
    readonly operationId: string;
    readonly kind: string;
    readonly status: string;
    readonly acceptedAt: string;
    readonly correlationId: string;
    readonly receipt: { readonly outcome: string; readonly failureCode: string | null } | null;
  }[];
  readonly total: number;
}

export function buildOperationsView(input: {
  readonly session: PanelSession;
  readonly page?: OperationPageInput;
  readonly status?: number;
}): OperationsView {
  const source = provenance({ source: 'control-api', quality: 'live' });
  if (!input.session.permissions.includes('server.view')) {
    return { screen: screenStateView('denied'), rows: [], total: 0, provenance: source };
  }
  if (input.status !== undefined && input.status >= 400) {
    return {
      screen: screenStateView(screenStateForStatus(input.status)),
      rows: [],
      total: 0,
      provenance: source,
    };
  }
  if (input.page === undefined) {
    return { screen: screenStateView('loading'), rows: [], total: 0, provenance: source };
  }
  if (input.page.operations.length === 0) {
    return {
      screen: screenStateView('empty', 'Nenhuma operação registrada para esta instância.'),
      rows: [],
      total: input.page.total,
      provenance: source,
    };
  }

  return {
    screen: screenStateView('ready'),
    total: input.page.total,
    provenance: source,
    rows: input.page.operations.map((operation) => ({
      operationId: operation.operationId,
      kind: operation.kind,
      status: operation.status,
      acceptedAt: operation.acceptedAt,
      correlationId: operation.correlationId,
      receiptOutcome: operation.receipt?.outcome ?? null,
      failureCode: operation.receipt?.failureCode ?? null,
    })),
  };
}

export interface AuditRow {
  readonly id: string;
  readonly occurredAt: string;
  readonly action: string;
  readonly outcome: string;
  readonly actorLabel: string;
  readonly correlationId: string;
}

export interface AuditView {
  readonly screen: ScreenStateView;
  readonly rows: readonly AuditRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export function buildAuditView(input: {
  readonly session: PanelSession;
  readonly page?: {
    readonly events: readonly {
      readonly id: string;
      readonly occurredAt: string;
      readonly action: string;
      readonly outcome: string;
      readonly actor: { readonly type: string; readonly id: string };
      readonly correlationId: string;
    }[];
    readonly total: number;
    readonly limit: number;
    readonly offset: number;
  };
  readonly status?: number;
}): AuditView {
  const empty = { rows: [], total: 0, limit: 0, offset: 0 };
  if (!input.session.permissions.includes('audit.view')) {
    return { screen: screenStateView('denied'), ...empty };
  }
  if (input.status !== undefined && input.status >= 400) {
    return { screen: screenStateView(screenStateForStatus(input.status)), ...empty };
  }
  if (input.page === undefined) return { screen: screenStateView('loading'), ...empty };
  if (input.page.events.length === 0) {
    return {
      screen: screenStateView('empty', 'Nenhum evento para os filtros atuais.'),
      rows: [],
      total: input.page.total,
      limit: input.page.limit,
      offset: input.page.offset,
    };
  }

  return {
    screen: screenStateView('ready'),
    total: input.page.total,
    limit: input.page.limit,
    offset: input.page.offset,
    rows: input.page.events.map((event) => ({
      id: event.id,
      occurredAt: event.occurredAt,
      action: event.action,
      outcome: event.outcome,
      // The actor is shown by kind and short id; the panel never renders a
      // full identifier it has no need to display.
      actorLabel: `${event.actor.type}:${event.actor.id.slice(0, 8)}`,
      correlationId: event.correlationId,
    })),
  };
}
