import {
  Activity,
  Archive,
  Bell,
  Blocks,
  BookOpen,
  Box,
  ChevronDown,
  CircleGauge,
  Clock3,
  DatabaseBackup,
  FileText,
  HardDrive,
  LayoutDashboard,
  LockKeyhole,
  Radio,
  ScrollText,
  Server,
  ShieldCheck,
  TerminalSquare,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { dashboardFixture } from '../lib/dashboard-fixture';

const navigation: readonly { readonly label: string; readonly icon: LucideIcon; readonly active?: boolean }[] = [
  { label: 'Visão geral', icon: LayoutDashboard, active: true },
  { label: 'Servidor', icon: Server },
  { label: 'Console', icon: TerminalSquare },
  { label: 'Jogadores', icon: Users },
  { label: 'Mods', icon: Blocks },
  { label: 'Modpack', icon: Box },
  { label: 'Backups', icon: DatabaseBackup },
  { label: 'Desempenho', icon: Activity },
  { label: 'Logs', icon: ScrollText },
  { label: 'Segurança', icon: ShieldCheck },
  { label: 'Auditoria', icon: FileText },
  { label: 'Documentação', icon: BookOpen },
];

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
    <div className="app-shell">
      <aside className="sidebar" aria-label="Navegação principal">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">V</div>
          <div>
            <strong>VoidFall</strong>
            <span>Control plane</span>
          </div>
        </div>
        <nav className="nav-list">
          {navigation.map(({ label, icon: Icon, active }) => (
            <a
              className={active ? 'nav-item active' : 'nav-item'}
              href={active ? '#conteudo' : '#indisponivel'}
              key={label}
              aria-current={active ? 'page' : undefined}
            >
              <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <LockKeyhole aria-hidden="true" size={16} />
          <span>Somente leitura</span>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <button className="instance-select" type="button" aria-label="Instância selecionada">
            <span className="instance-dot" aria-hidden="true" />
            <span>
              <small>Instância</small>
              {dashboardFixture.instance.name}
            </span>
            <ChevronDown aria-hidden="true" size={16} />
          </button>
          <div className="topbar-status">
            <span className="status-pill warning">
              <span className="status-dot" aria-hidden="true" />
              {dashboardFixture.instance.observedState}
            </span>
            <button className="icon-button" type="button" aria-label="Alertas da demonstração">
              <Bell aria-hidden="true" size={18} />
              <span className="notification-dot" aria-hidden="true" />
            </button>
            <button className="profile-button" type="button" aria-label="Abrir menu da sessão de demonstração">
              <span className="avatar">ZF</span>
              <span className="profile-copy"><strong>Operador</strong><small>Owner · demo</small></span>
              <ChevronDown aria-hidden="true" size={15} />
            </button>
          </div>
        </header>

        <main id="conteudo" className="content">
          <section className="demo-banner" aria-label="Aviso sobre dados">
            <div>
              <strong>Dados de demonstração</strong>
              <span>Esta tela usa fixtures locais e não representa o estado do servidor real.</span>
            </div>
            <span className="demo-badge">DEMO</span>
          </section>

          <div className="page-heading">
            <div>
              <span className="eyebrow">Operação / Visão geral</span>
              <h1>Bom dia, Operador.</h1>
              <p>Resumo operacional da instância selecionada, com origem e qualidade dos dados visíveis.</p>
            </div>
            <a className="primary-link" href="#estado-servidor">Abrir detalhes do servidor</a>
          </div>

          <section className="metrics-grid" aria-label="Indicadores simulados">
            {dashboardFixture.metrics.map((metric, index) => {
              const Icon = metricIcons[index] ?? CircleGauge;
              return (
                <article className="metric-card" key={metric.label}>
                  <div className={`metric-icon ${metric.tone}`}><Icon aria-hidden="true" size={18} /></div>
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
                  <span className="eyebrow">Estado da instância</span>
                  <h2>Servidor principal</h2>
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
                  <small>aguardando identidade do agente</small>
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
                <p>Start, stop, restart e console permanecem indisponíveis até os gates da Fase 3.</p>
              </div>
            </section>

            <section className="panel activity-panel">
              <div className="panel-header">
                <div>
                  <span className="eyebrow">Timeline</span>
                  <h2>Atividade recente</h2>
                </div>
                <a href="#atividade">Ver auditoria</a>
              </div>
              <ol className="activity-list" id="atividade">
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
                  <span className="eyebrow">Fundação</span>
                  <h2>Prontidão da plataforma</h2>
                </div>
                <span className="phase-label">Fase 2</span>
              </div>
              <div className="readiness-items">
                <div><span><ShieldCheck size={16} /> Sessões e RBAC</span><strong>Validado</strong></div>
                <div><span><DatabaseBackup size={16} /> Fila transacional</span><strong>Validado</strong></div>
                <div><span><Radio size={16} /> Identidade do agente</span><strong>Validado</strong></div>
                <div><span><Clock3 size={16} /> Controle Minecraft</span><strong className="pending">Bloqueado</strong></div>
              </div>
            </section>
          </div>

          <p className="unavailable-anchor" id="indisponivel">
            As demais áreas serão habilitadas em fases posteriores, conforme os gates documentados.
          </p>
        </main>
      </div>
    </div>
  );
}
