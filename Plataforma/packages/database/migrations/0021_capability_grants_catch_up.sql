-- As concessões de capability pararam no conjunto da Fase 9.1.
--
-- `agent_capability_grants` aceita `heartbeat`, `configuration.apply`,
-- `artifact.inspect`, `artifact.analyze` e `process.observe`. O contrato
-- (`AgentCapabilitySchema`) já lista também `process.control`,
-- `process.force-kill`, `console.command`, `backup.create` e `backup.restore`,
-- e as três primeiras têm handler no agente desde a Fase 10.
--
-- Consequência medida: o agente registrava, anunciava `process.control`, e
-- **toda reivindicação de trabalho voltava 403**. A capability existia no
-- contrato, no handler e no anúncio, e não existia no único lugar que decide
-- se ela pode ser servida.
--
-- Uma capability continua precisando ser **concedida**, não apenas anunciada.
-- Isto não concede nada: apenas deixa de recusar por estar desatualizado o que
-- o resto do sistema já considera nomeado e revisado.
--
-- `process.force-kill` está na lista porque o contrato a tem, e continua sem
-- handler em lugar nenhum — a readiness a distingue como `deliberately-disabled`
-- em vez de `no-handler-implemented`. Poder conceder não é poder executar.

ALTER TABLE agent_capability_grants
  DROP CONSTRAINT agent_capability_grants_capability_check;

ALTER TABLE agent_capability_grants
  ADD CONSTRAINT agent_capability_grants_capability_check CHECK (
    capability IN (
      'heartbeat',
      'configuration.apply',
      'artifact.inspect',
      'artifact.analyze',
      'process.observe',
      'process.control',
      'process.force-kill',
      'console.command',
      -- Copiar um mundo e sobrescrever um mundo com uma cópia mais velha são
      -- duas confianças diferentes, e continuam sendo duas capabilities.
      'backup.create',
      'backup.restore'
    )
  );

-- A mesma defasagem, uma tabela adiante.
--
-- `agent_work_leases` aceita apenas as três capabilities que existiam quando o
-- transporte foi escrito. Conceder `process.control` passou a funcionar e a
-- reivindicação seguinte quebrava aqui, com HTTP 500 — encontrado só depois de
-- o tratador de erro passar a registrar a causa, que é uma correção à parte e
-- vale por si.
--
-- Uma lease é o registro de qual capability serviu qual job. A lista tem de
-- coincidir com a das concessões, ou uma capability concedida produz um 500 em
-- vez de trabalho.
ALTER TABLE agent_work_leases
  DROP CONSTRAINT agent_work_leases_capability_check;

ALTER TABLE agent_work_leases
  ADD CONSTRAINT agent_work_leases_capability_check CHECK (
    capability IN (
      'configuration.apply',
      'artifact.inspect',
      'artifact.analyze',
      'process.control',
      'process.force-kill',
      'console.command',
      'backup.create',
      'backup.restore'
    )
  );
