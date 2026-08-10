# ADR-018 — Evidência de ordem efetiva de datapacks

- Status: aceita
- Data: 2026-08-10
- Proprietário: `voidfall-product-owner`
- Complementa: ADR-017, sem substituir o bloqueio de edição definido nele

## Contexto

O ADR-017 registra colisões por coordenada e hash e proíbe escolher um vencedor por nome, ordem lexical ou opinião de IA. A análise instalada encontrou seis colisões, mas o inventário descreve arquivos e packs, não a pilha efetiva que um mundo Minecraft selecionou.

A [documentação oficial do OpenLoader 1.20.1](https://docs.darkhax.net/1.20.1/open-loader/) informa que packs novos entram depois dos packs vanilla/modded e que o Minecraft conserva a ordem de carregamento em execuções futuras. Portanto, ordenar diretórios ou nomes de packs não reconstrói com segurança a prioridade efetiva de um mundo existente.

Também não é correto incorporar uma observação externa diretamente ao snapshot atual. Esse snapshot é imutável e identificado por `workspaceId + inventorySha256 + analyzerVersion`; uma ordem observada pode mudar sem alterar os arquivos inventariados.

## Decisão

### 1. Ordem efetiva exige uma observação versionada

`@voidfall/ecosystem-analysis` aceita somente um documento estrito `DatapackLoadOrderObservation` v1 já normalizado por um adaptador confiável. O documento contém:

- fonte literal e versionada;
- hash exato do inventário ao qual a observação pertence;
- horário canônico da observação;
- hash da evidência original, sem seus bytes;
- semântica explícita `lowest-priority-first`;
- lista limitada de `rootPath` relativos e SHA-256 dos packs, na ordem observada.

O identificador da observação é derivado deterministicamente do documento canônico. Campos extras, timestamp não canônico, hash inválido, path absoluto, traversal, barra invertida, duplicidade por case fold, ordem vazia ou lista acima do limite são recusados.

### 2. A coleta fica atrás de uma fronteira confiável

Somente duas origens são reservadas pelo contrato: `minecraft-world-metadata-v1` e `minecraft-runtime-report-v1`. Isso não implementa nem autoriza os adaptadores correspondentes.

Um adaptador futuro deverá resolver a semântica nativa da fonte e emitir apenas identidades normalizadas. Bytes de `level.dat`, caminhos absolutos, nomes de usuário, endereço do servidor, console bruto e outros dados privados não atravessam essa fronteira, não entram no inventário, não vão ao navegador e não são copiados para Git ou Graphify.

O browser não pode declarar fonte, ordem, root path, hash ou evidência como se fossem uma observação confiável.

### 3. A precedência é uma projeção separada e fail-closed

A projeção cruza uma observação com um `EcosystemAnalysis` imutável. Um conflito só recebe `observed-winner` na projeção quando:

- o hash do inventário é exatamente o mesmo;
- todos os datapacks participantes estão presentes na observação;
- cada `rootPath` corresponde ao SHA-256 do pack analisado;
- existe exatamente um recurso participante no pack de maior prioridade.

Inventário antigo, participante ausente, hash divergente ou recurso ambíguo produz resultado `unresolved` com motivo fechado. A lista dos conflitos é ordenada deterministicamente e os resultados são profundamente imutáveis.

### 4. Provar precedência ainda não autoriza edição

A projeção v1 fixa `authorizesSemanticEditing: false`. Ela não muta `DatapackConflict.resolution`, que continua `unknown-load-order` no snapshot persistido, e não altera o bloqueio dos campos semânticos.

Persistência, API, RBAC, auditoria, Server Agent, painel e qualquer mudança no gate de staging exigem outra fatia. Essa integração deverá manter a observação vinculada simultaneamente ao `analysisId`, `inventorySha256`, `observationId` e hashes dos participantes; não poderá reutilizar apenas a chave do cache de análise.

## Consequências

- a arquitetura passa a representar uma prova de precedência sem fingir que o inventário contém estado de mundo;
- a identidade e o cache do snapshot de ecossistema permanecem corretos;
- trocar a ordem ou qualquer hash produz outro `observationId`;
- uma fixture sanitizada comprova validação e projeção, mas não comprova a ordem do servidor privado atual;
- a futura coleta precisa ser tipada, autenticada, allowlisted, auditada e limitada à metadata necessária;
- colisões continuam bloqueando staging e escrita até uma decisão posterior explícita.

## Migração futura

1. implementar um único adaptador confiável sobre fixtures sanitizadas e definir sua guarda operacional;
2. persistir observação e projeção separadamente do snapshot, com unicidade e invalidação próprias;
3. expor somente a projeção sanitizada em uma rota de leitura com RBAC e auditoria;
4. validar a fonte em um smoke explícito, sem copiar bytes privados;
5. somente depois propor um ADR específico para alterar o gate de edição de recursos conflitantes.

## Não autorização

Este ADR não autoriza leitura do runtime privado nesta entrega, inferência lexical, comando livre, upload manual de ordem pelo browser, leitura irrestrita de `level.dat`, alteração de mundo, escrita em datapack, aplicação de staging, restart, resolução persistida, cópia de evidência privada para o repositório ou declaração de que as seis colisões atuais já possuem vencedor comprovado.
