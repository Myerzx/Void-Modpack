'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { PanelShell, serverSteps } from '../components/shell';
import {
  readOperationalContext,
  rememberActiveServerId,
  type OperationalSession,
} from '../../lib/active-server';
import {
  createWorldBackup,
  listBackups,
  readBackupOperation,
  readBackupProcessState,
  verifyBackupRestore,
  type BackupProcessState,
  type BackupRecord,
} from '../../lib/backup-client';
import { actionView } from '../../lib/panel-shell';
import { PanelApiError } from '../../lib/workspace-client';
import { serverRuntimeLabel, type ServerInstance } from '../../lib/panel-views';

const STATUS_LABEL: Readonly<Record<BackupRecord['status'], string>> = {
  creating: 'Criando',
  available: 'Disponível',
  failed: 'Falhou',
  pruned: 'Removido pela retenção',
};

function backupId(): string {
  return `world-${new Date().toISOString().replaceAll(/[-:.Z]/gu, '').toLowerCase()}`;
}

function formatBytes(value: number | null): string {
  if (value === null) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toLocaleString('pt-BR', { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

function processLabel(state: BackupProcessState | null): string {
  if (state === null || !state.observed) return 'Processo ainda não observado';
  if (state.stale) return 'Observação desatualizada';
  return state.lifecycle === 'offline'
    ? 'Servidor desligado — janela segura disponível'
    : `Servidor ${state.lifecycle} — desligue antes do backup`;
}

export default function BackupsPage() {
  const [session, setSession] = useState<OperationalSession | null>(null);
  const [servers, setServers] = useState<readonly ServerInstance[]>([]);
  const [records, setRecords] = useState<readonly BackupRecord[]>([]);
  const [processState, setProcessState] = useState<BackupProcessState | null>(null);
  const [screen, setScreen] = useState<'loading' | 'ready' | 'signed-out' | 'denied' | 'error'>(
    'loading',
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [verification, setVerification] = useState<{
    readonly backupId: string;
    readonly operationId: string;
  } | null>(null);

  const load = useCallback(async (serverId: string) => {
    const [backupPage, observed] = await Promise.all([
      listBackups(serverId),
      readBackupProcessState(serverId),
    ]);
    setRecords(backupPage.backups);
    setProcessState(observed);
    if (!backupPage.backups.some((record) => record.status === 'creating')) {
      setNotice((current) =>
        current?.startsWith('Backup aceito') === true
          ? 'Backup concluído, cifrado e verificado com sucesso.'
          : current,
      );
    }
    setScreen('ready');
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const context = await readOperationalContext();
        if (cancelled) return;
        if (context.kind !== 'ready') {
          setScreen(context.kind === 'signed-out' ? 'signed-out' : 'denied');
          return;
        }
        setSession(context.session);
        setServers(context.servers);
      } catch {
        if (!cancelled) setScreen('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (session === null) return;
    void load(session.serverId).catch((error: unknown) => {
      setScreen(error instanceof PanelApiError && error.status === 403 ? 'denied' : 'error');
    });
  }, [load, session]);

  const creating = records.some((record) => record.status === 'creating');
  useEffect(() => {
    if (session === null || !creating) return;
    const timer = setInterval(() => {
      void load(session.serverId).catch(() => undefined);
    }, 3_000);
    return () => clearInterval(timer);
  }, [creating, load, session]);

  const createAction = useMemo(
    () => actionView({ permissions: session?.permissions ?? [] }, 'backup.create'),
    [session],
  );
  const verifyAction = useMemo(
    () => actionView({ permissions: session?.permissions ?? [] }, 'backup.verify-restore'),
    [session],
  );
  const safeWindow =
    processState?.observed === true && processState.stale === false && processState.lifecycle === 'offline';

  const selectServer = useCallback((serverId: string) => {
    rememberActiveServerId(serverId);
    setRecords([]);
    setProcessState(null);
    setNotice(null);
    setVerification(null);
    setScreen('loading');
    setSession((current) => (current === null ? null : { ...current, serverId }));
  }, []);

  const create = useCallback(async () => {
    if (session === null) return;
    setPending(true);
    setNotice(null);
    try {
      const accepted = await createWorldBackup({
        serverId: session.serverId,
        csrfToken: session.csrfToken,
        backupId: backupId(),
      });
      setRecords((current) => [accepted, ...current]);
      setNotice('Backup aceito. O agente está copiando e verificando o mundo.');
    } catch (error) {
      setNotice(error instanceof PanelApiError ? error.message : 'Não foi possível solicitar o backup.');
    } finally {
      setPending(false);
    }
  }, [session]);

  const verify = useCallback(
    async (backupIdToVerify: string) => {
      if (session === null) return;
      setPending(true);
      setNotice(null);
      try {
        const operation = await verifyBackupRestore({
          serverId: session.serverId,
          csrfToken: session.csrfToken,
          backupId: backupIdToVerify,
        });
        setVerification({ backupId: backupIdToVerify, operationId: operation.operationId });
        setNotice('Teste de restauração aceito. A cópia isolada está sendo verificada.');
      } catch (error) {
        setNotice(
          error instanceof PanelApiError
            ? error.message
            : 'Não foi possível iniciar o teste de restauração.',
        );
      } finally {
        setPending(false);
      }
    },
    [session],
  );

  useEffect(() => {
    if (session === null || verification === null) return;
    let cancelled = false;
    const observe = async () => {
      try {
        const operation = await readBackupOperation(session.serverId, verification.operationId);
        if (cancelled || operation.status === 'accepted' || operation.status === 'running') return;
        if (operation.status === 'succeeded') {
          setNotice('Teste concluído: a cópia restaurada iniciou e foi encerrada com segurança.');
        } else {
          const failure = operation.receipt?.failureCode;
          setNotice(`O teste de restauração falhou${failure === null || failure === undefined ? '.' : `: ${failure}.`}`);
        }
        setVerification(null);
      } catch {
        if (!cancelled) setNotice('Não foi possível acompanhar o teste de restauração.');
      }
    };
    void observe();
    const timer = setInterval(() => void observe(), 3_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session, verification]);

  const content =
    screen === 'signed-out'
      ? 'Sua sessão terminou. Entre novamente para continuar.'
      : screen === 'denied'
        ? 'Sua sessão não tem permissão para consultar backups.'
        : screen === 'error'
          ? 'A Control API não respondeu como esperado.'
          : null;

  return (
    <PanelShell
      category="backups"
      title="Backups"
      subtitle="Cópias cifradas do mundo, verificadas e catalogadas pela Control API."
      steps={serverSteps('backups')}
      actions={
        session === null ? undefined : (
          <label className="compact-select server-instance-select">
            <span>Instância ativa</span>
            <select value={session.serverId} onChange={(event) => selectServer(event.target.value)}>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.displayName} — {serverRuntimeLabel(server)}
                </option>
              ))}
            </select>
          </label>
        )
      }
    >
      {content === null ? null : <p className="banner banner-warning">{content}</p>}
      {screen === 'loading' ? <p>Carregando…</p> : null}
      {screen === 'ready' ? (
        <>
          <section className="card backup-create-card" aria-label="Criar backup">
            <header className="card-head">
              <div>
                <h2>Backup do mundo ativo</h2>
                <p className="subtle">
                  O agente copia somente com o Minecraft desligado e mantém as chaves fora do
                  repositório de snapshots.
                </p>
              </div>
              <span className={`tag${safeWindow ? ' is-positive' : ''}`}>
                {processLabel(processState)}
              </span>
            </header>
            {notice === null ? null : (
              <p
                className={`banner ${notice.includes('aceito') || notice.includes('concluído') ? 'banner-positive' : 'banner-danger'}`}
              >
                {notice}
              </p>
            )}
            <div className="inline-actions">
              {createAction.visible ? (
                <button
                  className="primary"
                  type="button"
                  disabled={
                    !createAction.enabled ||
                    !safeWindow ||
                    creating ||
                    pending ||
                    verification !== null
                  }
                  title={createAction.reason || (!safeWindow ? 'Desligue o servidor e aguarde uma observação atual.' : '')}
                  onClick={() => void create()}
                >
                  {pending ? 'Solicitando…' : creating ? 'Backup em andamento…' : 'Criar backup agora'}
                </button>
              ) : null}
              <span className="subtle">Cifrado em repouso · retenção local controlada · operação auditada</span>
            </div>
          </section>

          <section className="card" aria-label="Catálogo de backups">
            <header className="card-head">
              <div>
                <h2>Histórico</h2>
                <p className="subtle">{records.length} snapshot(s) catalogado(s) nesta instância.</p>
              </div>
            </header>
            {records.length === 0 ? (
              <p className="muted">Nenhum backup foi criado ainda.</p>
            ) : (
              <div className="table-scroll">
                <table className="table backup-table">
                  <thead><tr><th>Backup</th><th>Estado</th><th>Ação</th><th>Criado</th><th>Tamanho</th><th>Arquivos</th><th>Integridade</th></tr></thead>
                  <tbody>
                    {records.map((record) => (
                      <tr key={record.backupId}>
                        <td><strong>{record.backupId}</strong><small>Mundo</small></td>
                        <td><span className={`analysis-status is-${record.status}`}>{STATUS_LABEL[record.status]}</span>{record.failureCode === null ? null : <small>{record.failureCode}</small>}</td>
                        <td>
                          {verifyAction.visible && record.status === 'available' ? (
                            <button
                              className="secondary"
                              type="button"
                              disabled={
                                !verifyAction.enabled ||
                                !safeWindow ||
                                creating ||
                                pending ||
                                verification !== null
                              }
                              title={
                                verifyAction.reason ||
                                (!safeWindow
                                  ? 'Desligue o servidor e aguarde uma observação atual.'
                                  : '')
                              }
                              onClick={() => void verify(record.backupId)}
                            >
                              {verification?.backupId === record.backupId
                                ? 'Testando…'
                                : 'Testar restauração'}
                            </button>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{new Date(record.createdAt).toLocaleString('pt-BR')}</td>
                        <td>{formatBytes(record.sizeBytes)}</td>
                        <td>{record.fileCount?.toLocaleString('pt-BR') ?? '—'}</td>
                        <td>{record.manifestSha256 === null ? '—' : <code>{record.manifestSha256.slice(0, 12)}</code>}<small>{record.encryptionKeyId === null ? 'sem cifra' : 'AES-256-GCM'}</small></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="banner banner-neutral">
            O teste acima nunca substitui o mundo ativo. A restauração destrutiva continua bloqueada
            até existir troca atômica com rollback do mundo substituído.
          </p>
        </>
      ) : null}
    </PanelShell>
  );
}
