import {
  Archive,
  CircleGauge,
  DatabaseBackup,
  HardDrive,
  Radio,
  ShieldCheck,
  Users,
} from 'lucide-react';

import { dashboardFixture } from '../lib/dashboard-fixture';
import { PanelShell } from './components/shell';

const metricIcons = [Users, HardDrive, CircleGauge, Archive] as const;

function DemoSource() {
  return (
    <span className="source-label">
      <Radio aria-hidden="true" size={12} /> Fixture local · 03 ago, 09:00 BRT
    </span>
  );
}

export default function DashboardPage() {
  return (
    <PanelShell
      title="Visão geral"
      category="overview"
      steps={[]}
      subtitle="Atalhos operacionais e uma amostra identificada; dados reais ficam nas áreas do servidor e dos workspaces."
      actions={<a className="primary-link" href="/servidor">Abrir servidor</a>}
    >
      <section className="demo-banner" aria-label="Aviso sobre dados">
        <div>
          <strong>Dados de demonstração</strong>
          <span>Os indicadores abaixo são uma amostra local e não descrevem o servidor real.</span>
        </div>
        <span className="demo-badge">DEMO</span>
      </section>

      <section className="metrics-grid" aria-label="Indicadores simulados">
        {dashboardFixture.metrics.map((metric, index) => {
          const Icon = metricIcons[index] ?? CircleGauge;
          return (
            <article className="metric-card" key={metric.label}>
              <div className={`metric-icon ${metric.tone}`}>
                <Icon aria-hidden="true" size={18} />
              </div>
              <div className="metric-copy">
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <small>{metric.detail}</small>
              </div>
              <DemoSource />
            </article>
          );
        })}
      </section>

      <div className="dashboard-grid">
        <section className="panel server-panel" id="estado-servidor">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Amostra de estado</span>
              <h2>{dashboardFixture.instance.name}</h2>
            </div>
            <span className="status-pill warning">
              <span className="status-dot" aria-hidden="true" /> Sem telemetria real
            </span>
          </div>
          <div className="state-comparison">
            <div>
              <span>Estado desejado</span>
              <strong>{dashboardFixture.instance.desiredState}</strong>
              <small>nenhuma operação solicitada</small>
            </div>
            <div className="state-divider" aria-hidden="true" />
            <div>
              <span>Estado observado</span>
              <strong>{dashboardFixture.instance.observedState}</strong>
              <small>consulte a área Servidor para dados reais</small>
            </div>
          </div>
          <dl className="server-facts">
            <div><dt>Minecraft</dt><dd>1.20.1</dd></div>
            <div><dt>Loader</dt><dd>Forge 47.4.4</dd></div>
            <div><dt>Release</dt><dd>{dashboardFixture.instance.release}</dd></div>
            <div><dt>Agente</dt><dd>{dashboardFixture.instance.agent}</dd></div>
          </dl>
          <div className="panel-note">
            <ShieldCheck aria-hidden="true" size={17} />
            <p>Lifecycle e console usam operações duráveis; capacidades ainda bloqueadas continuam indisponíveis na navegação.</p>
          </div>
        </section>

        <section className="panel activity-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Amostra</span>
              <h2>Atividade recente</h2>
            </div>
            <a href="/auditoria">Abrir auditoria real</a>
          </div>
          <ol className="activity-list">
            {dashboardFixture.activity.map((item) => (
              <li key={`${item.time}-${item.title}`}>
                <span className={`activity-marker ${item.kind}`} aria-hidden="true" />
                <time>{item.time}</time>
                <div><strong>{item.title}</strong><span>{item.detail}</span></div>
              </li>
            ))}
          </ol>
          <DemoSource />
        </section>

        <section className="panel readiness-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Acesso rápido</span>
              <h2>Fluxos disponíveis</h2>
            </div>
          </div>
          <div className="readiness-items">
            <div><span><ShieldCheck size={16} /> Operar servidor</span><a href="/servidor">Abrir</a></div>
            <div><span><HardDrive size={16} /> Importar workspace</span><a href="/workspaces">Abrir</a></div>
            <div><span><Archive size={16} /> Revisar mods</span><a href="/mods">Abrir</a></div>
            <div><span><DatabaseBackup size={16} /> Backup operacional</span><strong className="pending">Pendente</strong></div>
          </div>
        </section>
      </div>
    </PanelShell>
  );
}
