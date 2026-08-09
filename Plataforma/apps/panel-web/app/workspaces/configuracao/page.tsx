'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  PanelApiError,
  readConfigurationForm,
  readSession,
  readStagedDiff,
  REJECTION_LABELS,
  stageConfiguration,
  validateConfiguration,
  type DiffLineView,
  type FieldDecision,
  type FormField,
  type InferredFormView,
  type PanelSession,
} from '../../../lib/workspace-client';
import { PanelShell, stepsFor } from '../../components/shell';

/**
 * Editing a mod's configuration, and seeing exactly what would change.
 *
 * Everything decided here was decided elsewhere. The fields, their types, the
 * bounds and the documentation come from `configuration-inference`; whether a
 * value is acceptable comes from the same package's validator; the rewritten
 * file and the diff come from `configuration-staging`. This screen collects
 * input and renders answers.
 *
 * Three things it refuses to smooth over:
 *
 * **A bound that was declared and a bound that was not read differently.** The
 * validator reports whether it actually checked against something the mod
 * declared, and a field where it did not says "sem limite declarado" instead of
 * a reassuring green tick.
 *
 * **A form that could not represent the whole file cannot be saved.** Writing
 * back a partial view would drop whatever the reader refused, so staging is
 * disabled and the reason is on screen.
 *
 * **Nothing is applied.** Staging writes somewhere else and the workspace file
 * is untouched — the screen says so, because a save button that did not save
 * would otherwise be the most dangerous thing here.
 */

type Draft = Record<string, boolean | number | string>;

function displayValue(value: FormField['value']): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function describeConstraints(field: FormField): string | null {
  const parts: string[] = [];
  for (const constraint of field.constraints) {
    if (constraint.kind === 'range') {
      const low = constraint.minimum === null ? '−∞' : String(constraint.minimum);
      const high = constraint.maximum === null ? '∞' : String(constraint.maximum);
      parts.push(`${low} a ${high}`);
    } else {
      parts.push(constraint.values.join(' · '));
    }
  }
  return parts.length === 0 ? null : parts.join(' | ');
}

function ConfigurationView() {
  const [session, setSession] = useState<PanelSession | null>(null);
  const [target, setTarget] = useState<{ id: string; path: string } | null>(null);
  const [form, setForm] = useState<InferredFormView | null | 'loading'>('loading');
  const [unsupported, setUnsupported] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [decisions, setDecisions] = useState<readonly FieldDecision[]>([]);
  const [diff, setDiff] = useState<readonly DiffLineView[]>([]);
  const [staged, setStaged] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const id = query.get('id');
    const path = query.get('path');
    if (id !== null && path !== null) setTarget({ id, path });
  }, []);

  useEffect(() => {
    if (target === null) return;
    let cancelled = false;
    void (async () => {
      const current = await readSession().catch(() => null);
      if (cancelled) return;
      if (current === null) {
        window.location.href = '/entrar';
        return;
      }
      setSession(current);
      try {
        const result = await readConfigurationForm(target.id, target.path);
        if (cancelled) return;
        setUnsupported(result.form === null);
        setForm(result.form);
        const existing = await readStagedDiff(target.id, target.path).catch(() => null);
        if (!cancelled && existing !== null && existing.diff.length > 0) {
          setDiff(existing.diff);
          setStaged(true);
        }
      } catch (error) {
        if (cancelled) return;
        setFailure(error instanceof PanelApiError ? error.message : 'Falha ao ler o arquivo.');
        setForm(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  const changes = useMemo(
    () => Object.entries(draft).map(([path, value]) => ({ path, value })),
    [draft],
  );

  const decisionFor = useCallback(
    (path: string): FieldDecision | undefined => decisions.find((entry) => entry.path === path),
    [decisions],
  );

  const runValidation = useCallback(async () => {
    if (target === null || session?.csrfToken == null || changes.length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await validateConfiguration({
        workspaceId: target.id,
        path: target.path,
        changes,
        csrfToken: session.csrfToken,
      });
      setDecisions(result.decisions);
    } catch (error) {
      setFailure(error instanceof PanelApiError ? error.message : 'Falha ao validar.');
    } finally {
      setBusy(false);
    }
  }, [changes, session, target]);

  const runStaging = useCallback(async () => {
    if (target === null || session?.csrfToken == null || changes.length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await stageConfiguration({
        workspaceId: target.id,
        path: target.path,
        changes,
        csrfToken: session.csrfToken,
      });
      setDiff(result.diff);
      setStaged(true);
      setDecisions([]);
    } catch (error) {
      setFailure(
        error instanceof PanelApiError ? error.message : 'Não foi possível preparar a mudança.',
      );
    } finally {
      setBusy(false);
    }
  }, [changes, session, target]);

  if (target === null) {
    return (
      <PanelShell title="Configuração" category="files" steps={stepsFor(null, 'configuracao')}>
        <p className="muted">Nenhum arquivo informado.</p>
      </PanelShell>
    );
  }

  if (form === 'loading') {
    return (
      <PanelShell title="Configuração" category="files" steps={stepsFor(target.id, 'configuracao')}>
        <p className="muted">Lendo o arquivo…</p>
      </PanelShell>
    );
  }

  const needle = filter.trim().toLowerCase();
  const visible =
    form === null || needle === ''
      ? (form?.fields ?? [])
      : form.fields.filter((field) =>
          `${field.path} ${field.documentation.join(' ')}`.toLowerCase().includes(needle),
        );

  const rejected = decisions.filter((decision) => !decision.accepted);
  const canStage = form !== null && form.complete && changes.length > 0 && rejected.length === 0;

  return (
    <PanelShell
      category="files"
      title="Configuração"
      steps={stepsFor(target.id, 'configuracao')}
      subtitle={
        <>
          <code>{target.path}</code> · nada é aplicado ao servidor por esta tela
        </>
      }
    >

      {failure === null ? null : <p className="banner banner-danger">{failure}</p>}

      {unsupported ? (
        <p className="banner banner-warning">
          Este formato não tem formulário inferido. O arquivo continua no inventário — só não é
          editável por aqui.
        </p>
      ) : null}

      {diff.length === 0 ? null : (
        <section className="card">
          <header className="card-head">
            <h2>Diferença preparada</h2>
            {staged ? <span className="tag">não aplicada ao servidor</span> : null}
          </header>
          <p className="muted">
            A mudança foi escrita em outro lugar. O arquivo do servidor continua byte a byte o que
            era — aplicar ainda não existe no painel.
          </p>
          <pre className="diff">
            {diff.map((line, index) => (
              <span key={`${String(line.line)}:${String(index)}`} className={`diff-${line.kind}`}>
                {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} {line.text}
                {'\n'}
              </span>
            ))}
          </pre>
        </section>
      )}
      {form === null ? null : (
        <>
          {form.complete ? null : (
            <p className="banner banner-warning">
              O leitor não conseguiu representar {form.issues.length} linha(s) deste arquivo, então
              a mudança não pode ser preparada: gravar uma visão parcial descartaria justamente o
              que ninguém conseguiu ler.
            </p>
          )}

          <section className="card">
            <header className="card-head">
              <h2>
                {visible.length === form.fields.length
                  ? `${String(form.fields.length)} campos`
                  : `${String(visible.length)} de ${String(form.fields.length)} campos`}
              </h2>
              <input
                className="filter"
                placeholder="Filtrar campo"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </header>

            <div className="field-list">
              {visible.map((field) => {
                const decision = decisionFor(field.path);
                const bounds = describeConstraints(field);
                const current = draft[field.path];
                return (
                  <div key={field.path} className="config-field">
                    <div className="config-head">
                      <code>{field.path}</code>
                      <span className="tag">{field.type}</span>
                      {bounds === null ? (
                        <span className="subtle">sem limite declarado</span>
                      ) : (
                        <span className="subtle">{bounds}</span>
                      )}
                    </div>

                    {field.documentation.length === 0 ? null : (
                      // Verbatim, as the mod author wrote it. Rewording would
                      // be this panel inventing meaning through the back door.
                      <p className="config-doc">{field.documentation.join(' ')}</p>
                    )}

                    {field.type === 'boolean' ? (
                      <select
                        value={String(current ?? field.value)}
                        onChange={(event) =>
                          setDraft({ ...draft, [field.path]: event.target.value === 'true' })
                        }
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : (
                      <input
                        value={current === undefined ? displayValue(field.value) : String(current)}
                        onChange={(event) => {
                          const raw = event.target.value;
                          const parsed =
                            field.type === 'number' || field.type === 'integer'
                              ? raw.trim() === ''
                                ? raw
                                : Number(raw)
                              : raw;
                          setDraft({ ...draft, [field.path]: parsed as never });
                        }}
                      />
                    )}

                    {decision === undefined ? null : decision.accepted ? (
                      <p className="config-verdict ok">
                        {decision.checkedAgainstDeclaredBounds
                          ? 'Dentro do limite que o mod declarou.'
                          : 'Tipo correto. O mod não declarou limite para conferir.'}
                      </p>
                    ) : (
                      <p className="config-verdict bad">
                        {REJECTION_LABELS[decision.code] ?? decision.code}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

          </section>
        </>
      )}

      {changes.length === 0 ? null : (
        // A page of 249 fields put the actions somewhere nobody scrolls to.
        <div className="action-bar">
          <span>
            {changes.length} campo(s) alterado(s)
            {rejected.length === 0 ? '' : ` · ${String(rejected.length)} recusado(s)`}
          </span>
          <div>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => void runValidation()}
            >
              Validar
            </button>
            <button
              className="primary"
              type="button"
              disabled={busy || !canStage}
              onClick={() => void runStaging()}
            >
              Preparar mudança
            </button>
          </div>
        </div>
      )}
    </PanelShell>
  );
}

export default function ConfigurationPage() {
  return (
    <Suspense
      fallback={
        <main className="page">
          <p className="muted">Carregando…</p>
        </main>
      }
    >
      <ConfigurationView />
    </Suspense>
  );
}
