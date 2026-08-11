# Aplicativo desktop — primeiro spike executável

Status: **spike desktop Windows executável; instalador e distribuição ainda não implementados**.

## Objetivo entregue

`@voidfall/desktop` abre o painel existente em uma janela Electron e inicia a stack local em um utility process separado. Não há servidor web adicional, proxy, CORS, preload ou API Electron exposta à página.

Fluxo de boot:

1. Electron adquire o lock de instância única e define o estado em `%LOCALAPPDATA%\VoidFall`;
2. o utility process importa o bootstrap compilado da Control API;
3. PGlite, migrations, painel estático e `LocalAgentFleet` iniciam em `127.0.0.1` com porta efêmera;
4. o backend envia ao processo principal uma mensagem estrita `ready` com origem e URL de abertura;
5. a primeira navegação apresenta o token aleatório por processo, recebe a sessão HttpOnly real e redireciona para `/workspaces`;
6. a janela aceita somente a origem exata do backend;
7. ao fechar a janela, Electron encerra o utility process e o bootstrap libera API, banco, agente e lock.

## Como executar

Na raiz `Plataforma`:

```powershell
npm install
npm run desktop
```

O comando compila os pacotes, Server Agent, Control API, export estático do painel e shell Electron antes de abrir a janela. Ele não inicia o Minecraft automaticamente.

O estado criado pelo spike não pertence ao repositório:

```text
%LOCALAPPDATA%\VoidFall\runtime-development
```

## Segurança comprovada neste recorte

- renderer com `sandbox: true`, `nodeIntegration: false`, `contextIsolation: true` e `webSecurity: true`;
- ausência de preload e IPC renderer → main;
- somente HTTP loopback em `127.0.0.1` e porta escolhida em runtime;
- mensagem de readiness validada antes de carregar a página;
- navegação e redirects limitados à origem exata; popups recusados;
- token forte por processo, comparação constante e 403 para token ausente/incorreto;
- `/` não revela a credencial de abertura;
- sessão, cookie HttpOnly/SameSite, CSRF, RBAC e auditoria continuam os mesmos da Control API;
- lock de instância do Electron e lock separado do diretório PGlite.

## Validação de 2026-08-10

- typecheck e build de `@voidfall/desktop`: aprovados;
- 2 testes do protocolo desktop: aprovados;
- 5 testes da sessão local/desktop: aprovados;
- execução real do Electron: janela responsiva com título `VoidFall — Painel operacional`;
- `/health/live`: HTTP 200;
- token incorreto: HTTP 403;
- encerramento pela janela: processo principal, renderer, utility process e porta removidos, sem órfãos;
- `npm audit`: 0 vulnerabilidades após atualizar Next.js para 16.3.0.
- `npm run check`: código 0 em 394,7 segundos no estado final, incluindo todos os workspaces, Forge Bridge, seis apps, 17 páginas estáticas e o desktop.

O controle visual automatizado de apps Windows estava indisponível na sessão. A janela foi comprovada pelo runtime do Windows e o painel já havia sido inspecionado separadamente em 1920×911, 1280×800 e 1024×768.

## Próximo recorte limitado

Criar um pacote Windows não assinado somente para QA, com layout explícito de recursos e smoke em diretório limpo. Não habilitar auto-update nem publicação. O recorte deve provar que PGlite/WASM, migrations, painel e Control API funcionam fora do checkout antes de escolher o instalador e a assinatura final.
