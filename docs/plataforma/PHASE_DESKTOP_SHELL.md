# Aplicativo desktop — shell e pacote portátil de QA

Status: **aplicativo desktop Windows e pacote portátil de QA executáveis; instalador assinado, atualização e distribuição pública ainda não implementados**.

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

## Como executar em desenvolvimento

Na raiz `Plataforma`:

```powershell
npm install
npm run desktop
```

O comando compila os pacotes, Server Agent, Control API, export estático do painel e shell Electron antes de abrir a janela. Ele não inicia o Minecraft automaticamente.

O estado criado pelo aplicativo não pertence ao repositório:

```text
%LOCALAPPDATA%\VoidFall\runtime-development
```

## Como gerar e validar o pacote portátil

Na raiz `Plataforma`:

```powershell
npm run desktop:qa
```

O comando compila a plataforma, materializa somente o fechamento de dependências necessário, gera o aplicativo Windows x64 e executa o ZIP extraído em um diretório temporário fora do checkout. A saída local, ignorada pelo Git, fica em:

```text
apps/desktop/out/make/zip/win32/x64/
```

O layout de runtime do pacote é explícito:

```text
resources/app.asar
resources/voidfall/control-api/
resources/voidfall/desktop/backend.js
resources/voidfall/panel/
resources/voidfall/node_modules/
resources/voidfall/THIRD_PARTY_NOTICES.json
```

As migrations do banco acompanham os pacotes internos que as possuem. O inventário `THIRD_PARTY_NOTICES.json` registra nome, versão e licença declarada das dependências empacotadas. Ele auxilia a revisão, mas não substitui a aprovação jurídica de distribuição.

## Segurança comprovada

- renderer com `sandbox: true`, `nodeIntegration: false`, `contextIsolation: true` e `webSecurity: true`;
- ausência de preload e IPC renderer → main;
- somente HTTP loopback em `127.0.0.1` e porta escolhida em runtime;
- mensagem de readiness validada antes de carregar a página;
- navegação e redirects limitados à origem exata; popups recusados;
- token forte por processo, comparação constante e 403 para token ausente/incorreto;
- `/` não revela a credencial de abertura;
- sessão, cookie HttpOnly/SameSite, CSRF, RBAC e auditoria continuam os mesmos da Control API;
- lock de instância do Electron e lock separado do diretório PGlite;
- o canal de smoke não grava o token e somente é ativado por variáveis de ambiente explícitas com caminhos absolutos.

## Validação de 2026-08-11

- pacote `VoidFall-win32-x64-0.1.0.zip`: 159.124.321 bytes;
- SHA-256: `1196d03614a85bb14b36d092b6ae12f30ab506b94811ee6637d4a674ea410ae2`;
- 20 pacotes internos VoidFall e 105 dependências de terceiros materializados;
- extração e execução reais em diretório temporário fora do checkout;
- PGlite, migrations, sessão do painel, `/health/live` e conteúdo estático: aprovados;
- segunda instância recusada pelo lock;
- encerramento gracioso do backend: aprovado;
- reabertura com o mesmo estado e credencial inicial persistida: aprovada;
- painel inspecionado no navegador em 1440×900 e 900×650, sem overflow horizontal; a largura compacta usa trilho lateral de ícones;
- typecheck, 62 testes e build das 17 páginas estáticas do painel: aprovados;
- typecheck, 2 testes do protocolo e build do desktop: aprovados;
- `npm run check`: código 0 em 394,7 segundos, cobrindo toda a plataforma, integrações, testes e builds;
- `npm audit` e `npm audit --omit=dev`: zero vulnerabilidades.

O artefato é deliberadamente **não assinado e exclusivo para QA**. A documentação oficial do Electron recomenda ferramentas de empacotamento e assinatura antes da distribuição; este recorte usa o empacotador de baixo nível suportado para provar o runtime, sem fingir que o gate de publicação já passou.

## Próximo gate limitado

Escolher o formato do instalador, fornecer ícone e metadados finais, definir a identidade/certificado de assinatura e executar o pacote assinado em uma máquina Windows limpa e separada do ambiente de desenvolvimento. Auto-update, canal público e rollback do aplicativo permanecem desabilitados até essas decisões e a aprovação do smoke.

O estado completo e as dependências externas estão em [Análise de lacunas do produto final](FINAL_PRODUCT_GAP_ANALYSIS.md).
