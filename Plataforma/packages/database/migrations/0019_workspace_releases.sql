-- Releases: o que foi produzido a partir de um inventário aprovado.
--
-- Uma release é evidência, como um inventário e como uma execução de sandbox:
-- criada uma vez, concluída uma vez, nunca reescrita. Ela responde "o que este
-- servidor era na versão X" muito depois de o diretório ter mudado, e é a isso
-- que o grafo de conhecimento vai se ancorar no tempo.
--
-- O manifesto é guardado inteiro, como o construtor o escreveu. O painel lê
-- exatamente o que o motor produziu, e não uma segunda forma mantida à mão.
--
-- O que este arquivo deliberadamente não contém: nenhum caminho de host numa
-- coluna que o painel leia. O diretório de saída é resolvido pelo processo que
-- escreveu os arquivos; a tela recebe nome, tamanho e digest, e baixa por id.

CREATE TABLE workspace_releases (
  release_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES panel_workspaces (workspace_id) ON DELETE CASCADE,
  -- Vira nome de arquivo, então a forma é restrita aqui e não na rota.
  version TEXT NOT NULL CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'refused')),
  -- 'local-use' ou 'distribution'. Uma escolha, nunca inferida: ninguém produz
  -- um artefato redistribuível por esquecer de perguntar.
  intent TEXT NOT NULL CHECK (intent IN ('local-use', 'distribution')),
  -- O inventário de onde saiu, e o anterior quando havia um.
  inventory_id UUID NOT NULL REFERENCES workspace_inventories (inventory_id) ON DELETE CASCADE,
  previous_inventory_id UUID REFERENCES workspace_inventories (inventory_id) ON DELETE SET NULL,
  -- Nomeado quando o construtor recusou: licença, formulário incompleto, nada
  -- para empacotar. Uma recusa sem causa não se distingue de um defeito.
  refusal TEXT,
  -- Diff, changelog, decisão de distribuição e manifesto de cada pacote, como
  -- o `release-planner` os escreveu.
  plan JSONB,
  packages JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_by JSONB NOT NULL,
  CONSTRAINT workspace_releases_finished_has_an_end
    CHECK ((status = 'building') = (finished_at IS NULL)),
  -- Uma versão por workspace. Reconstruir a mesma versão sobre outra evidência
  -- é como um número de versão deixa de significar alguma coisa.
  UNIQUE (workspace_id, version)
);

CREATE INDEX workspace_releases_by_workspace
  ON workspace_releases (workspace_id, started_at DESC);
