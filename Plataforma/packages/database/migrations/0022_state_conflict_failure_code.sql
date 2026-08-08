-- Um `restart` de um servidor que já está offline não é uma falha de execução.
--
-- Nada foi tentado: o controlador recusa a ação porque o estado observado não é
-- aquele em que ela é definida. Medido no servidor real — o recibo voltava como
-- `operation-failed`, indistinguível de um restart que subiu o servidor e
-- quebrou no meio. O operador precisa saber qual dos dois aconteceu, porque a
-- resposta a cada um é outra: um pede `start`, o outro pede investigar o log.
--
-- `state-conflict` nomeia essa recusa. Não é `precondition-not-met`, que é
-- sobre o que cerca a operação (um lock tomado, um pré-requisito ausente); é
-- sobre o estado do próprio servidor contradizer a ação pedida.

ALTER TABLE agent_work_leases
  DROP CONSTRAINT agent_work_leases_failure_code_check;

ALTER TABLE agent_work_leases
  ADD CONSTRAINT agent_work_leases_failure_code_check CHECK (
    failure_code IS NULL OR failure_code IN (
      'capability-refused',
      'precondition-not-met',
      'lease-expired',
      'operation-failed',
      'unsupported-parameters',
      'state-conflict'
    )
  );

-- O recibo da operação carrega o mesmo vocabulário adiante, para o painel.
ALTER TABLE server_operations
  DROP CONSTRAINT server_operations_receipt_failure_code_check;

ALTER TABLE server_operations
  ADD CONSTRAINT server_operations_receipt_failure_code_check CHECK (
    receipt_failure_code IS NULL OR receipt_failure_code IN (
      'precondition-not-met',
      'lock-unavailable',
      'lease-expired',
      'agent-unavailable',
      'agent-refused',
      'timed-out',
      'operation-failed',
      'reconciled-unknown',
      'state-conflict'
    )
  );
