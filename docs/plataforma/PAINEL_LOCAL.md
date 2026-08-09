# Subir o painel localmente

```
cd Plataforma
npm install
npm run panel
```

É isso. Abra o endereço que o comando imprimir.

---

## O que esse comando faz

**Provisiona o banco.** PostgreSQL embutido — PGlite, que é PostgreSQL compilado para WebAssembly e já rodava a suíte de testes deste repositório — persistido em `Plataforma/.voidfall/database`. Sem daemon, sem porta, sem credencial para guardar. Apagar `Plataforma/.voidfall/` recomeça do zero.

**Entra sozinho.** Autenticação está adiada até o produto ser algo que outras pessoas rodem: abrir o endereço já entra como operador local. A máquina toda continua igual — sessão real, cookie `HttpOnly`, token CSRF real, todas as permissões conferidas. O que falta é só o passo de provar que você é quem está sentado na sua própria máquina. A rota recusa qualquer requisição que não venha de loopback, e a tela de login continua existindo para o dia do lançamento.

**Cria o primeiro dono, uma vez.** Gera uma senha e grava em `Plataforma/.voidfall/first-owner.txt`, para quando o login voltar a ser o caminho.

**Serve painel e API na mesma origem.** A própria API entrega o painel exportado. Não há proxy reverso, não há segunda origem, não há CORS — e o `SameSite=strict` do cookie de sessão continua valendo porque não existe requisição cross-site para fazer.

**Sobe tudo em `127.0.0.1:3100`.**

Nada disso é produção, e há três motivos independentes para não virar: só escuta loopback, recusa rodar com `NODE_ENV=production`, e o dono só é criado quando não existe nenhum usuário.

## Produção continua separada

```
DATABASE_URL=postgres://…  npm run start --workspace @voidfall/control-api
```

PGlite é single-connection e single-process: certo para um operador numa máquina, errado para qualquer outra coisa. São duas fábricas de banco distintas justamente para ninguém pegar a errada por engano. Em produção o painel exportado é servido pelo proxy reverso, e a API não recebe `panelExportRoot`.

## O que dá para usar hoje

Se a porta 3100 estiver ocupada, o comando avisa e usa a próxima livre.

| Rota | O que faz |
| --- | --- |
| `/` | Entra e vai para os workspaces |
| `/servidor` | Estado observado, operações e start/stop/restart auditados |
| `/servidor/console` | stdout/stderr incremental, pausa e comandos fechados |
| `/workspaces` | Registrar um servidor importado e inventariá-lo |
| `/workspaces/detalhe?id=…` | Inventário, exclusões, lista de mods e um mod aberto |
| `/workspaces/configuracao?id=…&path=…` | Formulário inferido, validação, preparo da mudança e diferença |
| `/workspaces/sandbox?id=…` | Executar um boot descartável com as mudanças preparadas, e ler resultado, arquivos gerados e log |
| `/workspaces/release?id=…` | Prévia com diff e changelog, gerar pacotes de servidor e cliente, e baixar |

Na tela de configuração, **nada é aplicado**. Validar confere contra o limite que o mod declarou — e diz quando não havia limite para conferir, em vez de fingir que houve. Preparar escreve em `.voidfall/staging/`, e o arquivo do servidor continua byte a byte o que era. Um arquivo cujo formulário não representa todas as linhas mostra os campos e recusa o preparo: gravar uma visão parcial descartaria justamente o que ninguém conseguiu ler.

No registro, o caminho é digitado **uma vez**:

```
H:/void pasta/Servidor/workspace/server-original
```

Barra normal ou invertida, tanto faz — a política normaliza. A partir daí nenhuma tela envia caminho: tudo é endereçado pelo id do workspace, e nada devolvido ao navegador carrega caminho do host.

**A leitura é somente leitura.** O scanner nunca abre arquivo para escrita, então apontar isso para um servidor real é seguro por construção.

## Ainda por ligar

A frente do [ADR-015](DECISIONS/ADR-015-frente-de-integracao-do-painel.md) está encerrada. O que vem agora está no [ADR-016](DECISIONS/ADR-016-painel-como-gerenciador-completo.md): operação do servidor (processo, console, backups), servidor e mundo, grafo de conhecimento e análise automática. O plano de ligar o servidor está em [PLANO_INICIAR_SERVIDOR.md](PLANO_INICIAR_SERVIDOR.md).

A página inicial da Fase 2 (`/`) redireciona para `/entrar`. A dashboard de fixture continua existindo e diz na própria tela que é fixture.
