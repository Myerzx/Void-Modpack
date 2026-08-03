# Backup consistente e restore isolado da Fase 3

Status: concluído em 2026-08-03; gate aprovado na matriz Windows/Linux.

## Objetivo do recorte

Criar um núcleo portátil que transforme raízes lógicas autorizadas em um snapshot imutável, verificável e promovido atomicamente, e que restaure esse snapshot somente em um diretório novo e isolado. O recorte termina em um pacote TypeScript e em testes Windows/Linux. Não cria rota, job, agendamento, política destrutiva de retenção, integração com agente, object storage ou acesso a `Servidor/workspace/`.

## Implementação entregue

O pacote isolado `@voidfall/server-backup` implementa o método `offline-exclusive-v1` por meio de `FilesystemBackupService`. O chamador precisa injetar uma `OfflineExclusiveBackupGuard`; o pacote não possui fallback que tente inferir consistência. O serviço:

- valida planos, IDs, relógio, fontes lógicas e limites antes do efeito;
- inventaria diretórios sem seguir links e rejeita hardlinks e tipos especiais;
- produz manifesto canônico v1 com hashes SHA-256 e sem paths absolutos;
- copia para staging exclusivo, verifica origem e destino e publica por `rename`;
- verifica o snapshot antes de restaurar para um destino novo e isolado;
- limpa somente o `.partial` pertencente à operação quando uma etapa falha;
- retorna recibos imutáveis e erros públicos tipados e sanitizados.

A implementação operacional da guarda, o backend remoto, a política de retenção, a troca do mundo ativo e qualquer integração com API/agente continuam deliberadamente ausentes.

## Decisão de consistência

O primeiro método aceito será `offline-exclusive-v1`. A cópia só ocorre dentro de uma guarda confiável que promete acesso exclusivo enquanto o processo Minecraft está offline. O executor de arquivos não tenta deduzir essa exclusão consultando o processo antes e depois: duas observações não impedem uma escrita entre elas.

A guarda é um trust boundary injetado. Neste recorte haverá apenas uma implementação falsa para testes. Uma implementação operacional futura deverá compartilhar exclusão durável com start, stop e restart, reconciliar PID após crash e provar que o processo não pode iniciar durante a cópia.

O método online abaixo permanece planejado e desabilitado:

1. adquirir a mesma exclusão operacional usada pelo ciclo de vida;
2. enviar `save-off` por identificador fechado;
3. enviar `save-all flush` e confirmar a resposta do Minecraft;
4. copiar ou criar snapshot;
5. executar `save-on` em `finally`, inclusive quando cópia, hash ou promoção falhar;
6. recusar sucesso quando a confirmação ou a recuperação for ambígua.

O console atual não confirma processamento e ainda não aceita `save-off`/`save-on`. Portanto, ampliar a allowlist agora produziria uma garantia falsa e está fora deste recorte.

## Limites de armazenamento

O backend real de backups continua P1. O adaptador inicial usa somente um repositório em filesystem fornecido por configuração confiável e testado em diretório temporário.

```text
repository-root/
  staging/
    <backup-id>.partial/
  snapshots/
    <backup-id>/
      manifest.json
      payload/
        <logical-source>/
```

- staging e snapshots ficam no mesmo filesystem para permitir `rename` atômico;
- backup publicado nunca é alterado;
- ID existente é conflito, nunca overwrite;
- falha remove somente o diretório `.partial` criado pela própria operação;
- retenção é metadata, não autorização para excluir backups;
- PostgreSQL guardará futuramente apenas metadata e ponteiro, nunca o conteúdo.

## Entradas confiáveis

O chamador interno fornece:

- `backupId` validado e sem semântica de path;
- `serverInstanceId`, versão/release e `retentionPolicyId` como identificadores sanitizados;
- `repositoryRoot` absoluto vindo da configuração do agente;
- uma lista fechada de fontes com `logicalName` e path absoluto;
- limites máximos de arquivos, bytes totais, bytes por arquivo e profundidade;
- relógio injetável;
- guarda `offline-exclusive-v1`.

Paths, fontes, limites e método de consistência não serão payload livre de painel/API neste recorte.

## Preflight e contenção

Antes de copiar:

1. resolver `realpath` de cada fonte e do repositório;
2. exigir diretórios existentes e distintos;
3. recusar fonte dentro do repositório ou repositório dentro de uma fonte;
4. recusar fontes duplicadas, sobrepostas ou com nomes lógicos duplicados;
5. percorrer sem seguir symlink ou junction;
6. recusar hardlink, socket, dispositivo e qualquer tipo especial;
7. normalizar paths relativos para `/` e recusar absoluto, `..`, vazio, controles e colisão por case fold;
8. aplicar limites de contagem, tamanho, profundidade e comprimento;
9. medir bytes antes da cópia e verificar espaço livre com margem explícita;
10. exigir que staging e snapshots pertençam ao mesmo dispositivo quando a plataforma expuser essa informação.

Uma falha de preflight não cria snapshot publicado.

## Manifesto

`manifest.json` será JSON canônico UTF-8 e conterá:

- `schemaVersion` e identidade `voidfall-backup`;
- `backupId`, `serverInstanceId`, `createdAt` e release associada;
- método de consistência e horário de aquisição da guarda;
- política de retenção referenciada, sem data de exclusão automática;
- fontes lógicas, sem paths absolutos locais;
- entradas ordenadas com path relativo, tipo, tamanho e SHA-256 de cada arquivo;
- totais de arquivos, diretórios e bytes;
- hash do conteúdo canônico do manifesto no recibo da operação.

SHA-256 detecta corrupção; não prova autoria. Assinatura, criptografia e imutabilidade do backend exigem contratos posteriores.

## Fluxo de backup

1. validar configuração e identificadores;
2. adquirir a guarda offline exclusiva;
3. executar preflight e inventário determinístico;
4. criar staging exclusivo;
5. copiar cada entrada sem seguir links;
6. calcular e comparar tamanho/hash da origem e da cópia;
7. escrever o manifesto por último;
8. verificar novamente todo o staging pelo manifesto;
9. promover com `rename` para `snapshots/<backup-id>`;
10. retornar recibo imutável e liberar a guarda;
11. em falha, limpar somente o staging da operação e retornar erro tipado.

O recibo não expõe path, nome privado de arquivo, conteúdo ou segredo.

## Fluxo de restore isolado

1. receber backup publicado e parent isolado por configuração confiável;
2. validar manifesto e verificar integralmente hashes/tamanhos antes de copiar;
3. exigir que o destino final ainda não exista;
4. recusar destino dentro do backup, do repositório ou de uma fonte ativa;
5. copiar para um sibling `.partial` criado pela operação;
6. verificar novamente o conteúdo restaurado;
7. promover por `rename` para o destino novo;
8. retornar recibo imutável com ID, horário, totais e hash do manifesto;
9. em falha, limpar somente o sibling parcial.

Restore não troca ponteiro, não move mundo para produção, não inicia Minecraft e não apaga destino anterior. Boot, dimensões, inventários e dados de mods continuam smoke tests separados.

## Estados e erros

Backup: `accepted -> guarded -> inventoried -> copying -> verified -> promoted`.

Restore: `accepted -> source-verified -> copying -> target-verified -> promoted`.

Erros públicos são códigos fechados, como `invalid-plan`, `consistency-unavailable`, `unsafe-path`, `unsupported-entry`, `limit-exceeded`, `insufficient-space`, `integrity-mismatch`, `destination-conflict`, `promotion-failed` e `cleanup-failed`. Mensagens públicas não carregam paths ou exceções brutas.

## Matriz de testes implementada

1. backup e restore completo de uma fixture com arquivos aninhados e Unicode;
2. ordem canônica e hashes determinísticos;
3. backup só copia enquanto a guarda está adquirida;
4. falha da guarda impede qualquer staging;
5. ID duplicado não altera o snapshot existente;
6. destino de restore existente nunca é alterado;
7. manifesto adulterado bloqueia restore antes da cópia;
8. arquivo restaurado divergente bloqueia promoção;
9. symlink/junction, hardlink e tipo especial são recusados;
10. fontes sobrepostas e colisões de path/case são recusadas;
11. limites de arquivo, total, profundidade e espaço são aplicados;
12. falha no meio da cópia remove apenas o `.partial` próprio;
13. relógio e identificadores inválidos são recusados;
14. recibos e manifestos não expõem paths absolutos;
15. testes confirmam que nenhum path contém `Servidor/workspace` ou `Launcher/workspace`.

Os 15 comportamentos estão agrupados em 10 testes do pacote. No Windows, 9 passam e o caso de socket Unix é ignorado por ser específico da plataforma; no Linux, os 10 passam. Além do caminho feliz, a suíte injeta falhas no meio da cópia e corrupção durante o restore para comprovar limpeza e ausência de promoção parcial.

## Gate de saída

O item 5 foi concluído após contrato, implementação e testes do adaptador local passarem na [matriz Ubuntu/Windows 30845229436](https://github.com/Myerzx/Void-Modpack/actions/runs/30845229436). O gate não autoriza restore real: API, agente, processo privado, backend remoto, retenção destrutiva e estratégia online permanecem bloqueados até exclusão durável, confirmação de console, autorização reforçada, auditoria e testes de recuperação próprios.
