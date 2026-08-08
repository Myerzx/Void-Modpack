-- A instância passa a saber onde executa e como inicia.
--
-- `panel_workspaces` e `server_instances` nasceram em fases diferentes e nunca
-- se falaram. Um workspace é uma **leitura imutável** de uma instalação, para
-- construir e publicar; uma instância é uma instalação **em operação**, que
-- escreve. Ligar o servidor pelo painel exige a aresta entre os dois.
--
-- Isso não afrouxa nada. O inventário continua estruturalmente incapaz de
-- escrever; quem escreve é o processo do Minecraft, sob o agente, que é onde
-- essa autoridade sempre esteve.
--
-- O runtime é **detectado**, não digitado. Um operador que precisa declarar o
-- loader e o nome do jar é um operador que vai declarar errado uma vez, e o
-- plano de lançamento errado roda um JVM no diretório que guarda o mundo.

ALTER TABLE server_instances
  ADD COLUMN run_directory TEXT
    CHECK (run_directory IS NULL OR length(run_directory) BETWEEN 2 AND 4096);

-- Família, forma de lançamento, entrada e a evidência que decidiu — como o
-- detector as escreveu. A entrada é relativa ao diretório de execução, porque
-- este documento termina numa tela.
ALTER TABLE server_instances
  ADD COLUMN runtime JSONB
    CHECK (runtime IS NULL OR jsonb_typeof(runtime) = 'object');

ALTER TABLE server_instances
  ADD COLUMN runtime_detected_at TIMESTAMPTZ;

-- Um workspace pode passar a ser servido por uma instância. Opcional dos dois
-- lados: importar um servidor para inventariar não obriga a operá-lo, e operar
-- um servidor não obriga a ter importado nada.
ALTER TABLE panel_workspaces
  ADD COLUMN server_instance_id UUID REFERENCES server_instances (id) ON DELETE SET NULL;

CREATE INDEX panel_workspaces_by_instance
  ON panel_workspaces (server_instance_id)
  WHERE server_instance_id IS NOT NULL;
