# Subir o painel localmente

O que é preciso para deixar de olhar o VoidFall por CLI. Cinco passos, e o terceiro é o único que ainda exige uma decisão de operação.

---

## 1. PostgreSQL

A Control API exige `DATABASE_URL` e roda as migrações sozinha no boot. Não há `docker-compose` nem `Dockerfile` no repositório — subir o banco é trabalho de operação, não do produto, e por isso não foi inventado aqui.

Qualquer PostgreSQL 15+ serve. Um container basta:

```
docker run --name voidfall-db -e POSTGRES_PASSWORD=voidfall \
  -e POSTGRES_DB=voidfall -p 5432:5432 -d postgres:16
```

## 2. Criar o dono do painel

O painel **não cria contas**. O primeiro usuário sai de um comando, deliberadamente:

```
cd Plataforma
$env:DATABASE_URL = "postgres://postgres:voidfall@127.0.0.1:5432/voidfall"
$env:VOIDFALL_BOOTSTRAP_OWNER_EMAIL = "voce@exemplo.invalid"
$env:VOIDFALL_BOOTSTRAP_OWNER_PASSWORD = "uma senha longa"
npm run bootstrap-owner --workspace @voidfall/control-api
```

## 3. Subir a Control API

```
$env:VOIDFALL_COOKIE_SECURE = "false"   # só em local, sem TLS
npm run build
npm run start --workspace @voidfall/control-api
```

Ela escuta em `127.0.0.1:3100`.

`VOIDFALL_COOKIE_SECURE=false` é recusado quando `NODE_ENV=production`. É a única concessão local, e ela é explícita.

## 4. Servir o painel na mesma origem

Este é o passo que ainda exige decisão. O painel é exportado estático (`apps/panel-web/out`) e chama a API por caminho relativo — `/api/v1/...` — então **os dois precisam sair da mesma origem**. Um proxy reverso na frente dos dois é a topologia prevista, e não existe manifesto de serviço no repositório.

Para olhar agora, o caminho mais curto é o servidor de desenvolvimento do Next com proxy para a API. Alternativamente, sirva `apps/panel-web/out` por qualquer servidor estático que também encaminhe `/api` para `127.0.0.1:3100`.

```
npm run dev --workspace @voidfall/panel-web
```

## 5. Usar

| Rota | O que dá para fazer |
| --- | --- |
| `/entrar` | Entrar com o dono criado no passo 2 |
| `/workspaces` | Registrar um servidor importado e inventariá-lo |
| `/workspaces/detalhe?id=…` | Inventário, exclusões, lista de mods e um mod aberto |

No registro, o caminho é digitado **uma vez**. Por exemplo:

```
H:\void pasta\Servidor\workspace\server-original
```

A partir daí nenhuma tela envia caminho: tudo é endereçado pelo id do workspace, e nada devolvido ao navegador carrega caminho do host.

**A leitura é somente leitura.** O scanner nunca abre um arquivo para escrita, então apontar isso para um servidor real é seguro por construção — é a única razão pela qual importar uma instalação viva é permitido.

---

## O que ainda não está no painel

Ligado agora: importar servidor, inventário, mods, abrir mod, configurações detectadas (leitura).

Ainda por ligar, na ordem prevista pelo [ADR-015](DECISIONS/ADR-015-frente-de-integracao-do-painel.md): editar e validar, staging e diff, executar sandbox com resultado e logs, e gerar release. O motor de cada um já existe e já é usável por CLI — o que falta é a tela.

A página inicial (`/`) continua sendo fixture declarada da Fase 2 e diz isso na própria tela.
