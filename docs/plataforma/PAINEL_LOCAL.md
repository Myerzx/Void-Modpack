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

**Cria o primeiro dono, uma vez.** Na primeira execução gera uma senha, imprime e grava em `Plataforma/.voidfall/first-owner.txt`. Não é mostrada de novo. Só acontece quando a tabela de usuários está vazia.

**Serve painel e API na mesma origem.** A própria API entrega o painel exportado. Não há proxy reverso, não há segunda origem, não há CORS — e o `SameSite=strict` do cookie de sessão continua valendo porque não existe requisição cross-site para fazer.

**Sobe tudo em `127.0.0.1:3100`.**

Nada disso é produção, e há três motivos independentes para não virar: só escuta loopback, recusa rodar com `NODE_ENV=production`, e o dono só é criado quando não existe nenhum usuário.

## Produção continua separada

```
DATABASE_URL=postgres://…  npm run start --workspace @voidfall/control-api
```

PGlite é single-connection e single-process: certo para um operador numa máquina, errado para qualquer outra coisa. São duas fábricas de banco distintas justamente para ninguém pegar a errada por engano. Em produção o painel exportado é servido pelo proxy reverso, e a API não recebe `panelExportRoot`.

## O que dá para usar hoje

| Rota | O que faz |
| --- | --- |
| `/entrar` | Entrar |
| `/workspaces` | Registrar um servidor importado e inventariá-lo |
| `/workspaces/detalhe?id=…` | Inventário, exclusões, lista de mods e um mod aberto |

No registro, o caminho é digitado **uma vez**:

```
H:/void pasta/Servidor/workspace/server-original
```

Barra normal ou invertida, tanto faz — a política normaliza. A partir daí nenhuma tela envia caminho: tudo é endereçado pelo id do workspace, e nada devolvido ao navegador carrega caminho do host.

**A leitura é somente leitura.** O scanner nunca abre arquivo para escrita, então apontar isso para um servidor real é seguro por construção.

## Ainda por ligar

Na ordem do [ADR-015](DECISIONS/ADR-015-frente-de-integracao-do-painel.md): editar e validar → staging → diff → sandbox com resultado e logs → release. O motor de cada um existe e é usável por CLI; falta a tela.

A página inicial da Fase 2 (`/`) redireciona para `/entrar`. A dashboard de fixture continua existindo e diz na própria tela que é fixture.
