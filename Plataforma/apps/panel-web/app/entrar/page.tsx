'use client';

import { useCallback, useEffect, useState } from 'react';
import { PanelApiError, readSession, signIn } from '../../lib/workspace-client';

/**
 * The sign-in screen.
 *
 * It did not exist. The API had a login endpoint from Phase 1 and the panel
 * had a client that knew how to call it, and no page ever did — so the only
 * way into the panel was to POST the credentials by hand and paste the cookie.
 * That is the first thing the integration track had to fix, because every
 * other screen is behind it.
 */

type Phase = 'checking' | 'ready' | 'submitting';

export default function SignInPage() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = await readSession().catch(() => null);
      if (cancelled) return;
      if (session !== null) {
        window.location.href = '/workspaces';
        return;
      }
      setPhase('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setPhase('submitting');
      setFailure(null);
      try {
        await signIn(email, password);
        window.location.href = '/workspaces';
      } catch (error) {
        // The API answers the same way for a wrong password and an unknown
        // account, and this screen does not add a distinction it was
        // deliberately not given.
        setFailure(
          error instanceof PanelApiError ? error.message : 'Não foi possível entrar agora.',
        );
        setPhase('ready');
      }
    },
    [email, password],
  );

  if (phase === 'checking') {
    return (
      <main className="auth-shell">
        <p className="muted">Verificando sessão…</p>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="auth-title">VoidFall</h1>
        <p className="auth-subtitle">Painel de construção e publicação</p>

        <label className="field">
          <span>E-mail</span>
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label className="field">
          <span>Senha</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {failure === null ? null : <p className="field-error">{failure}</p>}

        <button className="primary" type="submit" disabled={phase === 'submitting'}>
          {phase === 'submitting' ? 'Entrando…' : 'Entrar'}
        </button>

        <p className="auth-note">
          O primeiro usuário é criado pelo comando <code>bootstrap-owner</code> da Control API.
          Este painel não cria contas.
        </p>
      </form>
    </main>
  );
}
