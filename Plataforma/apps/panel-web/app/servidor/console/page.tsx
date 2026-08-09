'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { PanelShell, serverSteps } from '../../components/shell';
import {
  EMPTY_CONSOLE_VIEW,
  mergeConsolePage,
  readConsolePage,
  type ConsoleViewState,
} from '../../../lib/console-view';
import { PanelSessionClient, type PanelFetch } from '../../../lib/panel-session';
import { actionView, hasPermission, type PanelSession } from '../../../lib/panel-shell';
import { buildInstanceSelectorView, type ServerInstance } from '../../../lib/panel-views';

const panelFetch: PanelFetch = async (path, init) =>
  fetch(path, {
    method: init.method,
    credentials: 'include',
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    ...(init.body === undefined ? {} : { body: init.body }),
  });

const TIME_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

type ConsoleCommand = 'list-players' | 'save-all';
type PollState = 'loading' | 'live' | 'paused' | 'error';

const COMMAND_LABELS: Readonly<Record<ConsoleCommand, string>> = Object.freeze({
  'list-players': 'Listar jogadores',
  'save-all': 'Salvar mundo agora',
});

function errorMessage(payload: unknown, fallback: string): string {
  if (payload === null || typeof payload !== 'object') return fallback;
  const message = (payload as { readonly error?: { readonly message?: unknown } }).error?.message;
  return typeof message === 'string' ? message : fallback;
}

export default function ConsolePage() {
  const [session, setSession] = useState<PanelSession | undefined>(undefined);
  const [signedOut, setSignedOut] = useState(false);
  const [instances, setInstances] = useState<readonly ServerInstance[] | undefined>(undefined);
  const [instanceStatus, setInstanceStatus] = useState<number | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ConsoleViewState>(EMPTY_CONSOLE_VIEW);
  const [pollState, setPollState] = useState<PollState>('loading');
  const [pollFailure, setPollFailure] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [following, setFollowing] = useState(true);
  const [commands, setCommands] = useState<readonly ConsoleCommand[]>([]);
  const [selectedCommand, setSelectedCommand] = useState<ConsoleCommand>('list-players');
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<number | null>(null);
  const pausedRef = useRef(false);

  useEffect(() => {
    const client = new PanelSessionClient(panelFetch);
    void client.current().then((outcome) => {
      if (outcome.kind === 'authenticated') setSession(outcome.session);
      else setSignedOut(true);
    });
  }, []);

  useEffect(() => {
    if (session === undefined) return;
    void panelFetch('/api/v1/servers', { method: 'GET' }).then(async (response) => {
      if (!response.ok) {
        setInstanceStatus(response.status);
        return;
      }
      const body = (await response.json()) as { readonly servers?: unknown };
      setInstances(Array.isArray(body.servers) ? (body.servers as readonly ServerInstance[]) : []);
    });
  }, [session]);

  useEffect(() => {
    pausedRef.current = paused;
    setPollState((current) => (paused ? 'paused' : current === 'paused' ? 'live' : current));
  }, [paused]);

  const selector = useMemo(
    () =>
      session === undefined
        ? undefined
        : buildInstanceSelectorView({
            session,
            ...(instances === undefined ? {} : { instances }),
            selectedId,
            ...(instanceStatus === undefined ? {} : { status: instanceStatus }),
          }),
    [instanceStatus, instances, selectedId, session],
  );
  const activeId = selector?.selectedId ?? null;

  useEffect(() => {
    if (session === undefined || !hasPermission(session, 'console.view')) return;
    void panelFetch('/api/v1/console/commands', { method: 'GET' }).then(async (response) => {
      if (!response.ok) return;
      const body = (await response.json()) as { readonly commands?: unknown };
      if (!Array.isArray(body.commands)) return;
      const accepted = body.commands.filter(
        (command): command is ConsoleCommand =>
          command === 'list-players' || command === 'save-all',
      );
      setCommands(accepted);
      if (accepted[0] !== undefined) setSelectedCommand(accepted[0]);
    });
  }, [session]);

  useEffect(() => {
    if (
      session === undefined ||
      activeId === null ||
      !hasPermission(session, 'console.view')
    ) {
      return;
    }
    let disposed = false;
    let timer: number | undefined;
    cursorRef.current = null;
    setView(EMPTY_CONSOLE_VIEW);
    setPollState('loading');
    setPollFailure(null);
    setFollowing(true);

    const applyResponse = async (path: string): Promise<boolean | null> => {
      const response = await panelFetch(path, { method: 'GET' });
      if (response.status === 401) {
        if (!disposed) setSignedOut(true);
        return null;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        if (!disposed) {
          setPollState('error');
          setPollFailure(errorMessage(payload, `Console indisponível (HTTP ${String(response.status)}).`));
        }
        return null;
      }
      const page = readConsolePage(await response.json(), activeId);
      if (page === undefined) {
        if (!disposed) {
          setPollState('error');
          setPollFailure('A Control API retornou um lote de console inválido.');
        }
        return null;
      }
      if (disposed) return null;
      setView((current) => {
        const next = mergeConsolePage(current, page);
        cursorRef.current = next.nextCursor;
        return next;
      });
      setPollFailure(null);
      setPollState(pausedRef.current ? 'paused' : 'live');
      return page.hasMore;
    };

    const schedule = (callback: () => void, delay: number): void => {
      timer = window.setTimeout(callback, delay);
    };
    const poll = async (): Promise<void> => {
      if (disposed) return;
      if (pausedRef.current) {
        setPollState('paused');
        schedule(() => void poll(), 500);
        return;
      }
      const cursor = cursorRef.current;
      const hasMore = await applyResponse(
        `/api/v1/servers/${activeId}/console?from=${String(cursor ?? 1)}&limit=500`,
      );
      if (disposed) return;
      schedule(() => void poll(), hasMore === true ? 250 : document.hidden ? 5_000 : hasMore === null ? 3_000 : 1_000);
    };

    const openAtTail = async (): Promise<void> => {
      const result = await applyResponse(
        `/api/v1/servers/${activeId}/console?tail=true&limit=200`,
      );
      if (disposed) return;
      // A failed first request must retry the tail. Falling back to cursor 1
      // here could replay an arbitrarily old retained history.
      schedule(() => void (result === null ? openAtTail() : poll()), result === null ? 3_000 : 1_000);
    };
    void openAtTail();

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeId, session]);

  useEffect(() => {
    if (!following) return;
    const terminal = terminalRef.current;
    if (terminal !== null) terminal.scrollTop = terminal.scrollHeight;
  }, [following, view.lines]);

  const commandAction = session === undefined ? undefined : actionView(session, 'console.command');

  async function submitCommand(): Promise<void> {
    if (
      session === undefined ||
      activeId === null ||
      commandAction?.enabled !== true ||
      !commands.includes(selectedCommand)
    ) {
      return;
    }
    setCommandBusy(true);
    setCommandNotice(null);
    try {
      const response = await panelFetch(`/api/v1/servers/${activeId}/console/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
        body: JSON.stringify({
          schemaVersion: 1,
          command: selectedCommand,
          idempotencyKey: `painel-console-${String(Date.now())}`,
          reasonCode: 'panel-console',
        }),
      });
      const payload = await response.json().catch(() => null);
      setCommandNotice(
        response.ok
          ? `${COMMAND_LABELS[selectedCommand]} entrou na fila auditada.`
          : errorMessage(payload, `Comando recusado (HTTP ${String(response.status)}).`),
      );
    } finally {
      setCommandBusy(false);
    }
  }

  const selectedInstance = instances?.find((instance) => instance.id === activeId);
  const subtitle = selectedInstance === undefined
    ? 'Saída incremental persistida pelo agente.'
    : `${selectedInstance.displayName} · ${selectedInstance.environment}`;

  if (signedOut) {
    return (
      <PanelShell title="Console" steps={serverSteps('console')}>
        <p className="banner banner-warning">Sua sessão terminou. Entre novamente para continuar.</p>
      </PanelShell>
    );
  }

  return (
    <PanelShell
      title="Console"
      subtitle={subtitle}
      steps={serverSteps('console')}
      actions={
        selector?.screen.showsContent === true ? (
          <label className="console-instance">
            <span>Instância</span>
            <select value={activeId ?? ''} onChange={(event) => setSelectedId(event.target.value)}>
              {selector.options.map((option) => (
                <option key={option.id} value={option.id}>{option.label} · {option.environment}</option>
              ))}
            </select>
          </label>
        ) : undefined
      }
    >
      {session === undefined ? <p>Carregando sessão…</p> : null}
      {session !== undefined && !hasPermission(session, 'console.view') ? (
        <p className="banner banner-warning">Sua sessão não tem permissão para visualizar o console.</p>
      ) : null}
      {selector !== undefined && !selector.screen.showsContent ? (
        <section className="card">
          <h2>{selector.screen.title}</h2>
          <p className="muted">{selector.screen.detail}</p>
        </section>
      ) : null}
      {activeId !== null && session !== undefined && hasPermission(session, 'console.view') ? (
        <section className="console-card" aria-label="Console do servidor">
          <header className="console-toolbar">
            <div className="console-connection" aria-live="polite">
              <span className={`console-signal is-${pollState}`} aria-hidden="true" />
              <strong>{pollState === 'live' ? 'Ao vivo' : pollState === 'paused' ? 'Pausado' : pollState === 'loading' ? 'Conectando' : 'Reconectando'}</strong>
              <span>{view.lines.length.toLocaleString('pt-BR')} linhas nesta aba</span>
            </div>
            <div className="console-tools">
              <button className="secondary" type="button" onClick={() => setPaused((value) => !value)}>
                {paused ? 'Retomar' : 'Pausar'}
              </button>
              <button
                className={`secondary${following ? ' is-active' : ''}`}
                type="button"
                onClick={() => setFollowing((value) => !value)}
              >
                Seguir final
              </button>
              <button className="secondary" type="button" onClick={() => setView((current) => ({ ...current, lines: [] }))}>
                Limpar visual
              </button>
            </div>
          </header>

          {pollFailure === null ? null : <p className="console-alert">{pollFailure}</p>}
          {view.retentionGap ? (
            <p className="console-alert">Parte do histórico expirou enquanto esta aba estava atrás do cursor.</p>
          ) : null}

          <div
            className="console-terminal"
            ref={terminalRef}
            role="log"
            aria-label="Saída incremental do Minecraft"
            tabIndex={0}
            onScroll={(event) => {
              const element = event.currentTarget;
              setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 48);
            }}
          >
            {view.lines.length === 0 ? (
              <p className="console-empty">{pollState === 'loading' ? 'Buscando as linhas mais recentes…' : 'Nenhuma linha retida para esta instância.'}</p>
            ) : (
              view.lines.map((line) => (
                <div className={`console-line is-${line.stream}`} key={line.sequence}>
                  <time dateTime={line.occurredAt} title={line.occurredAt}>{TIME_FORMAT.format(new Date(line.occurredAt))}</time>
                  <span className="console-stream">{line.stream === 'stderr' ? 'ERR' : 'OUT'}</span>
                  <span className="console-text">{line.text.length === 0 ? ' ' : line.text}</span>
                  {line.redacted ? <span className="console-badge">redigido</span> : null}
                  {line.truncated ? <span className="console-badge">cortado</span> : null}
                </div>
              ))
            )}
          </div>

          {commandAction?.visible === true ? (
            <footer className="console-command">
              <div>
                <strong>Comando revisado</strong>
                <span>Sem texto livre: apenas o catálogo publicado pela Control API.</span>
              </div>
              <select value={selectedCommand} onChange={(event) => setSelectedCommand(event.target.value as ConsoleCommand)} disabled={commandBusy || commands.length === 0}>
                {commands.map((command) => <option key={command} value={command}>{COMMAND_LABELS[command]}</option>)}
              </select>
              <button className="primary" type="button" disabled={!commandAction.enabled || commandBusy || commands.length === 0} onClick={() => void submitCommand()}>
                {commandBusy ? 'Enviando…' : 'Executar'}
              </button>
            </footer>
          ) : null}
          {commandNotice === null ? null : <p className="console-notice" aria-live="polite">{commandNotice}</p>}
        </section>
      ) : null}
    </PanelShell>
  );
}
