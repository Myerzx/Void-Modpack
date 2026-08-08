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

export function PanelShell(props: {
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly steps: readonly ShellStep[];
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

        <nav className="shell-nav">
          {props.steps.map((step) => {
            const className = `shell-link${step.active === true ? ' is-active' : ''}${
              step.href === null ? ' is-disabled' : ''
            }`;
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
            Leitura somente leitura. Nada é aplicado ao servidor por este painel.
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
        <div className="shell-body">{props.children}</div>
      </div>
    </div>
  );
}
