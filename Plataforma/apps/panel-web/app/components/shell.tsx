'use client';

import type { ReactNode } from 'react';

/**
 * The frame every workspace screen sits in.
 *
 * The panel is a path, not a set of pages: import, inventory, mods,
 * configuration, sandbox, release. The sidebar is that path, in order, so the
 * shape of the product is visible before anybody clicks anything — and a step
 * that is not connected yet says so rather than being hidden, because "not
 * built" and "not here" read the same when a link is simply absent.
 *
 * Deliberately plain. This is a working frame that will change as the phases
 * land; what it must not do is imply a capability the engine does not have.
 */

export interface ShellStep {
  readonly label: string;
  readonly href: string | null;
  readonly active?: boolean;
  /** Shown when the step exists in the engine but has no screen yet. */
  readonly pending?: boolean;
}

export type ShellCategory =
  | 'overview'
  | 'server'
  | 'mods'
  | 'datapacks'
  | 'players'
  | 'files'
  | 'backups'
  | 'logs'
  | 'audit';

const CATEGORIES: readonly (ShellStep & { readonly id: ShellCategory })[] = [
  { id: 'overview', label: 'Visão geral', href: '/' },
  { id: 'server', label: 'Servidor', href: '/servidor' },
  { id: 'mods', label: 'Mods', href: '/mods' },
  { id: 'datapacks', label: 'Datapacks', href: '/datapacks' },
  { id: 'players', label: 'Jogadores', href: null, pending: true },
  { id: 'files', label: 'Arquivos', href: '/workspaces' },
  { id: 'backups', label: 'Backups', href: null, pending: true },
  { id: 'logs', label: 'Logs', href: '/servidor/console' },
  { id: 'audit', label: 'Auditoria', href: '/auditoria' },
];

export function stepsFor(workspaceId: string | null, active: string): readonly ShellStep[] {
  const suffix = workspaceId === null ? null : `?id=${workspaceId}`;
  return [
    { label: 'Workspaces', href: '/workspaces', active: active === 'workspaces' },
    {
      label: 'Inventário',
      href: suffix === null ? null : `/workspaces/detalhe${suffix}`,
      active: active === 'inventario',
    },
    {
      label: 'Configuração',
      href: null,
      active: active === 'configuracao',
      // Reached from a mod, because a configuration file only means something
      // next to the mod that owns it.
      pending: active !== 'configuracao',
    },
    {
      label: 'Sandbox',
      href: suffix === null ? null : `/workspaces/sandbox${suffix}`,
      active: active === 'sandbox',
    },
    {
      label: 'Release',
      href: suffix === null ? null : `/workspaces/release${suffix}`,
      active: active === 'release',
    },
  ];
}

/** Operational navigation only exposes screens backed by the control plane. */
export function serverSteps(
  active: 'server' | 'settings' | 'console' | 'events' | 'players' | 'access' | 'files' | 'worlds' | 'backups',
): readonly ShellStep[] {
  return [
    { label: 'Visão geral', href: '/servidor', active: active === 'server' },
    { label: 'Configurações', href: '/configuracoes', active: active === 'settings' },
    { label: 'Console', href: '/servidor/console', active: active === 'console' },
    { label: 'Eventos', href: null, active: active === 'events', pending: true },
    { label: 'Jogadores', href: null, active: active === 'players', pending: true },
    { label: 'Acesso', href: null, active: active === 'access', pending: true },
    { label: 'Arquivos', href: '/workspaces', active: active === 'files' },
    { label: 'Mundos', href: null, active: active === 'worlds', pending: true },
    { label: 'Backups', href: null, active: active === 'backups', pending: true },
  ];
}

export function modsSteps(active: string, workspaceId?: string): readonly ShellStep[] {
  const suffix = workspaceId === undefined ? '' : `?workspace=${encodeURIComponent(workspaceId)}`;
  return [
    { label: 'Todos', href: `/mods${suffix}`, active: active === 'all' },
    { label: 'Configurações', href: `/mods${suffix}#configuracoes`, active: active === 'configurations' },
    { label: 'Dependências', href: `/mods${suffix}#dependencias`, active: active === 'dependencies' },
    { label: 'Compatibilidade', href: '/mods/compatibilidade', active: active === 'compatibility' },
    { label: 'Datapacks', href: '/datapacks', active: active === 'datapacks' },
    { label: 'Recursos', href: `/mods${suffix}#recursos`, active: active === 'resources' },
    { label: 'Grafo', href: `/mods${suffix}#grafo`, active: active === 'graph' },
  ];
}

export function modSteps(workspaceId: string, modId: string, active: string): readonly ShellStep[] {
  const base = `/mods/detalhe?workspace=${encodeURIComponent(workspaceId)}&mod=${encodeURIComponent(modId)}&tab=`;
  return [
    { label: 'Geral', href: `${base}geral`, active: active === 'geral' },
    { label: 'Configurações', href: `${base}configuracoes`, active: active === 'configuracoes' },
    { label: 'Sistemas', href: `${base}sistemas`, active: active === 'sistemas' },
    { label: 'Integrações', href: `${base}integracoes`, active: active === 'integracoes' },
    { label: 'Datapacks', href: `${base}datapacks`, active: active === 'datapacks' },
    { label: 'Arquivos', href: `${base}arquivos`, active: active === 'arquivos' },
    { label: 'Grafo', href: `${base}grafo`, active: active === 'grafo' },
  ];
}

export function PanelShell(props: {
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly steps: readonly ShellStep[];
  readonly category?: ShellCategory;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="shell">
      <aside className="shell-side">
        <div className="shell-brand">
          <span className="shell-mark">◇</span>
          <span>VoidFall</span>
        </div>

        <nav className="shell-nav" aria-label="Navegação principal">
          {CATEGORIES.map((step) => {
            const className = `shell-link${step.active === true ? ' is-active' : ''}${
              step.href === null ? ' is-disabled' : ''
            }${step.id === props.category ? ' is-active' : ''}`;
            return step.href === null ? (
              <span key={step.label} className={className}>
                {step.label}
                {step.pending === true ? <em>em breve</em> : null}
              </span>
            ) : (
              <a key={step.label} className={className} href={step.href}>
                {step.label}
              </a>
            );
          })}
        </nav>

        <footer className="shell-foot">
          <p>Ambiente local</p>
          <p className="subtle">
            Operações autorizadas passam pela Control API e ficam auditadas.
          </p>
        </footer>
      </aside>

      <div className="shell-main">
        <header className="shell-head">
          <div>
            <h1>{props.title}</h1>
            {props.subtitle === undefined ? null : (
              <div className="shell-subtitle">{props.subtitle}</div>
            )}
          </div>
          {props.actions === undefined ? null : <div className="shell-actions">{props.actions}</div>}
        </header>
        {props.steps.length === 0 ? null : (
          <nav className="shell-secondary" aria-label="Navegação da área">
            {props.steps.map((step) => {
              const className = `shell-tab${step.active === true ? ' is-active' : ''}${step.href === null ? ' is-disabled' : ''}`;
              return step.href === null ? (
                <span key={step.label} className={className} title={step.pending === true ? 'Ainda não implementado' : undefined}>
                  {step.label}
                </span>
              ) : (
                <a key={step.label} className={className} href={step.href}>{step.label}</a>
              );
            })}
          </nav>
        )}
        <div className="shell-body">{props.children}</div>
      </div>
    </div>
  );
}
