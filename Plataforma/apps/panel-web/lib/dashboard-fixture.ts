export interface DashboardFixture {
  readonly dataMode: 'demo-fixture';
  readonly generatedAt: string;
  readonly instance: {
    readonly name: string;
    readonly environment: string;
    readonly observedState: string;
    readonly observedStateTone: 'warning';
    readonly desiredState: string;
    readonly release: string;
    readonly agent: string;
  };
  readonly metrics: readonly {
    readonly label: string;
    readonly value: string;
    readonly detail: string;
    readonly source: 'fixture-local';
    readonly tone: 'neutral' | 'positive' | 'warning';
  }[];
  readonly activity: readonly {
    readonly time: string;
    readonly title: string;
    readonly detail: string;
    readonly kind: 'build' | 'security' | 'backup';
  }[];
}

export const dashboardFixture: DashboardFixture = {
  dataMode: 'demo-fixture',
  generatedAt: '2026-08-03T12:00:00.000Z',
  instance: {
    name: 'VoidFall Principal',
    environment: 'Ambiente de demonstração',
    observedState: 'Sem agente real',
    observedStateTone: 'warning',
    desiredState: 'Não definido',
    release: 'Candidato 0.1.0',
    agent: 'Não conectado',
  },
  metrics: [
    {
      label: 'Jogadores',
      value: '7 / 20',
      detail: 'amostra de ocupação',
      source: 'fixture-local',
      tone: 'positive',
    },
    {
      label: 'Memória',
      value: '8,4 GB',
      detail: 'de 16 GB simulados',
      source: 'fixture-local',
      tone: 'neutral',
    },
    {
      label: 'TPS',
      value: '19,8',
      detail: 'amostra estável',
      source: 'fixture-local',
      tone: 'positive',
    },
    {
      label: 'Último backup',
      value: '2h atrás',
      detail: 'restore não verificado',
      source: 'fixture-local',
      tone: 'warning',
    },
  ],
  activity: [
    {
      time: '08:48',
      title: 'Build candidato concluído',
      detail: 'voidfall-0.1.0-rc.3 · fixture de fluxo',
      kind: 'build',
    },
    {
      time: '08:31',
      title: 'Sessão administrativa revisada',
      detail: 'nenhuma anomalia na amostra local',
      kind: 'security',
    },
    {
      time: '07:55',
      title: 'Backup de mundo catalogado',
      detail: '12,6 GB · verificação pendente',
      kind: 'backup',
    },
  ],
};
