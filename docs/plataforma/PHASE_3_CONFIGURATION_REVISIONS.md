# Configurações básicas e revisões da Fase 3

Status: concluído em 2026-08-03; gate aprovado em Windows e Linux.

## Objetivo do recorte

Criar um núcleo TypeScript portátil para alterar campos básicos de uma configuração textual previamente registrada, sempre preservando uma revisão imutável do conteúdo anterior e permitindo rollback verificável. O recorte termina em um pacote isolado e testes Windows/Linux sobre diretórios temporários. Não cria tela, rota, job, tabela, editor genérico, schema específico de mod nem acesso a `Servidor/workspace/`.

## Formato inicial

O primeiro codec aceito será `java-properties-v1`, um subconjunto deliberadamente estrito de arquivos `.properties`:

- UTF-8 sem BOM;
- linhas vazias e comentários iniciados por `#` ou `!` são preservados;
- propriedades usam somente `chave=valor` sem continuação, escape ou separador ambíguo;
- chaves são identificadores ASCII limitados e não podem repetir;
- o arquivo usa somente LF ou somente CRLF;
- todo campo presente precisa existir no schema confiável do recurso;
- todo campo declarado precisa existir no arquivo;
- valores são validados e serializados por tipo antes da escrita.

Arquivos Java Properties completos, JSON, JSON5, TOML, YAML, CFG e schemas específicos de mods permanecem para recortes posteriores. O pacote não deve fingir compatibilidade com sintaxes que ainda não interpreta integralmente.

## Registro confiável de recursos

O serviço recebe por construção uma lista fechada de recursos. Cada definição contém:

- `resourceId` sem semântica de path;
- `schemaVersion` versionada;
- path absoluto do arquivo vindo de configuração confiável do agente futuro;
- formato fixo `java-properties-v1`;
- limite máximo de bytes;
- campos editáveis e seus tipos, limites e necessidade de restart.

O chamador de uma alteração fornece somente `resourceId`, `revisionId`, hash SHA-256 atual esperado, `reasonCode` sanitizado e valores dos campos conhecidos. Path, schema, limite, formato e política de restart não são payload livre de painel/API.

## Schema básico

Os tipos iniciais são:

- `boolean`, serializado somente como `true` ou `false`;
- `integer`, inteiro seguro com mínimo e máximo obrigatórios;
- `enum`, string pertencente a uma lista fechada;
- `string`, com comprimento máximo e sem controles, quebras ou escapes ambíguos.

Cada campo declara `restartRequired`. O recibo agrega essa informação quando pelo menos um campo alterado exigir restart. Valores anteriores e novos nunca entram em recibos, manifestos ou erros públicos.

## Concorrência e consistência

Toda mutação exige duas proteções independentes:

1. uma `OfflineExclusiveConfigurationGuard` injetada, que promete acesso exclusivo enquanto o Minecraft está offline;
2. um lock exclusivo por `resourceId` no repositório local de revisões.

O pacote não implementa a guarda operacional. Uma implementação futura precisa compartilhar exclusão durável com start, stop, backup e file manager, além de reconciliar crash e processo órfão. O hash atual esperado aplica concorrência otimista e impede sobrescrever uma edição externa silenciosamente.

## Repositório de revisões

```text
repository-root/
  staging/
    <revision-id>.partial/
  revisions/
    <resource-id>/
      <revision-id>/
        manifest.json
        previous.properties
  locks/
    <resource-id>.lock
```

- staging e revisions ficam no mesmo filesystem;
- `revisionId` existente é conflito, nunca overwrite;
- `previous.properties` contém os bytes exatos anteriores à mutação;
- a revisão é publicada e verificada antes de substituir o arquivo ativo;
- uma revisão publicada não é apagada quando a escrita posterior falha, pois continua sendo evidência de recuperação;
- retenção e exclusão não são implementadas neste recorte;
- o repositório pode conter segredos presentes na configuração e exige permissão restrita; criptografia e backend remoto são contratos futuros.

## Manifesto da revisão

`manifest.json` será JSON canônico UTF-8 e conterá:

- identidade `voidfall-configuration-revision` e `schemaVersion` do manifesto;
- `revisionId`, `resourceId`, versão do schema e formato;
- horário canônico, `reasonCode` e operação `update` ou `rollback`;
- revisão restaurada, somente no rollback;
- SHA-256 e tamanho do conteúdo anterior;
- SHA-256 pretendido para o conteúdo novo;
- campos alterados em ordem canônica, sem valores;
- necessidade agregada de restart.

O manifesto não contém path absoluto, conteúdo, ator, IP, token ou segredo. Ator, motivo humano, decisão de autorização e resultado da aplicação pertencem à auditoria futura da Control API.

## Preflight e contenção

Antes de ler ou escrever:

1. validar definições, plano, IDs, limites, relógio e schema;
2. resolver o arquivo e o repositório por paths absolutos confiáveis;
3. recusar sobreposição entre arquivo/diretório de configuração e repositório;
4. abrir somente arquivo regular e comparar identidade antes/depois da abertura;
5. recusar symlink, junction, hardlink e tipos especiais;
6. aplicar limite de bytes durante a leitura;
7. validar integralmente sintaxe e schema do conteúdo atual;
8. comparar o hash atual com `expectedCurrentSha256`;
9. rejeitar alteração vazia, campo desconhecido e valor inválido;
10. manter temporário de substituição como sibling do arquivo final.

## Fluxo de alteração

1. validar o plano sem efeito;
2. adquirir a guarda offline e o lock do recurso;
3. executar preflight e ler o arquivo por handle limitado;
4. validar hash, sintaxe, tipos e limites;
5. aplicar os campos em memória preservando comentários, ordem e line ending;
6. calcular o diff sem valores e o hash resultante;
7. gravar e verificar `previous.properties` e manifesto em staging;
8. promover a revisão por `rename`;
9. gravar o conteúdo novo em sibling exclusivo, sincronizar e verificar;
10. substituir o arquivo final por `rename` no mesmo diretório;
11. reabrir e verificar o hash aplicado;
12. retornar recibo imutável e liberar lock/guarda.

Falha antes da publicação limpa somente o staging próprio. Falha depois da publicação preserva a revisão anterior. O pacote nunca tenta esconder uma falha de recuperação retornando sucesso.

## Fluxo de rollback

Rollback é uma nova mutação, não uma movimentação de ponteiro invisível:

1. validar a revisão de origem e seu manifesto;
2. exigir mesmo `resourceId`, formato e `schemaVersion` atuais;
3. verificar tamanho e SHA-256 de `previous.properties`;
4. validar o conteúdo antigo contra o schema atual;
5. exigir hash esperado do arquivo ativo;
6. calcular o diff entre o ativo e o conteúdo restaurado;
7. criar uma nova revisão contendo o estado ativo anterior ao rollback;
8. substituir o arquivo pelo conteúdo restaurado;
9. retornar recibo que referencia a revisão restaurada, sem valores.

Rollback não reinicia Minecraft, não altera banco, não apaga revisões e não aceita arquivo enviado pelo usuário.

## Estados e erros

Alteração e rollback seguem `accepted -> guarded -> validated -> revision-published -> replacing -> verified`.

Erros públicos usam códigos fechados: `invalid-definition`, `invalid-plan`, `consistency-unavailable`, `resource-not-found`, `unsafe-path`, `unsupported-entry`, `content-too-large`, `invalid-content`, `schema-mismatch`, `revision-conflict`, `concurrent-modification`, `no-change`, `revision-integrity-mismatch`, `replacement-failed`, `verification-failed`, `recovery-failed` e `cleanup-failed`. Mensagens não carregam path, valor, conteúdo ou exceção bruta.

## Matriz de testes implementada

1. alteração tipada preserva comentários, ordem, UTF-8 e LF/CRLF;
2. boolean, inteiro, enum e string aplicam validação e serialização canônica;
3. campo desconhecido, schema incompleto, duplicata e sintaxe ambígua são recusados;
4. hash esperado divergente não cria revisão nem altera arquivo;
5. guarda indisponível impede staging e escrita;
6. lock concorrente e `revisionId` duplicado não sobrescrevem estado;
7. symlink/junction, hardlink, tipo especial e sobreposição são recusados;
8. limite de bytes é aplicado antes da mutação;
9. falha de substituição preserva o arquivo e mantém a revisão publicada;
10. rollback restaura bytes exatos e captura o estado substituído em nova revisão;
11. revisão adulterada, recurso diferente ou schema antigo bloqueiam rollback;
12. alteração vazia é recusada;
13. recibos, manifestos e erros não expõem paths nem valores;
14. testes usam somente diretórios temporários e comprovam ausência de `Servidor/workspace` e `Launcher/workspace`.

Os comportamentos estão agrupados em 11 testes do pacote. No Windows, os 10 casos aplicáveis passam e o caso de socket Unix é ignorado por ser específico da plataforma; no Linux, os 11 passam. A suíte injeta falha antes da substituição e conteúdo corrompido depois dela para comprovar preservação ou recuperação dos bytes anteriores.

## Gate de saída

O item 6 foi concluído após contrato, implementação e testes passarem localmente e na [matriz Windows/Linux 30848108269](https://github.com/Myerzx/Void-Modpack/actions/runs/30848108269). Esse gate encerra a Fase 3 isolada, mas não autoriza edição real: integração com API/agente/painel, persistência PostgreSQL, auditoria, schemas genéricos, file manager, arquivos de mods e restart automático exigem recortes próprios.
