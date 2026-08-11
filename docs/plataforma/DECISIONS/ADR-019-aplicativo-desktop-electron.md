# ADR-019 — Aplicativo desktop Windows com Electron

- Status: aceita
- Data: 2026-08-10
- Proprietário: `voidfall-product-owner`
- Complementa: ADR-015 e ADR-016

## Contexto

O painel já é exportado estaticamente pelo Next.js e servido pela própria Control API. O ambiente local também já compõe PGlite, sessão, workspaces e `LocalAgentFleet` em um único processo Node. A entrega para PC deve reutilizar essas fronteiras, manter painel e API na mesma origem e não criar uma segunda implementação das operações do servidor.

Tauri permitiria reutilizar o export estático com uma janela menor, mas ainda exigiria empacotar todo o backend Node/PGlite como sidecar. Isso acrescentaria Rust e um segundo modelo de lifecycle antes de existir evidência de que o ganho de tamanho compensa esse risco.

## Decisão

A primeira aplicação desktop do VoidFall usa Electron e continua desktop-only, inicialmente para Windows.

- o processo principal Electron possui apenas lifecycle e política da janela;
- a Control API, PGlite e o agente local rodam em um `utilityProcess` Node separado;
- o renderer permanece sandboxed, sem Node integration, sem preload e sem IPC privilegiado;
- a janela carrega somente a origem HTTP exata em `127.0.0.1` escolhida pelo sistema operacional;
- novas janelas, navegação para outra origem, `file:` e conteúdo remoto são recusados;
- a sessão desktop exige uma credencial aleatória por processo, enviada diretamente à primeira navegação e nunca publicada pelo redirect de `/`;
- o estado de desenvolvimento fica em `%LOCALAPPDATA%\VoidFall\runtime-development`, separado do repositório;
- uma única instância gráfica pode rodar por perfil, e fechar a janela encerra o backend local graciosamente.

O painel continua acessando capacidades somente pela Control API autenticada, com CSRF, RBAC, jobs, allowlists e auditoria existentes. Electron não cria um caminho alternativo para processos, arquivos, backups, console ou configuração.

## Consequências

- o painel e o backend TypeScript são reaproveitados sem reescrita;
- Electron adiciona Chromium e aumenta o tamanho da futura distribuição;
- o backend não compartilha o processo do renderer e pode ser encerrado/reiniciado como unidade própria;
- o bootstrap local passa a aceitar caminhos absolutos injetados e porta efêmera em modo desktop;
- o modo terminal de desenvolvimento continua recusado sob `NODE_ENV=production`;
- a rota desktop pode existir em produção somente com token forte e loopback.

## Gates antes de distribuição

Este ADR não declara um instalador pronto. A entrega pública ainda exige:

1. empacotamento explícito dos arquivos compilados da Control API, dependências PGlite/WASM e export do painel;
2. instalador Windows reproduzível, assinatura de código e política de atualização/rollback;
3. ícone e metadata finais, licença dos componentes redistribuídos e inventário de dependências;
4. migração/backup do diretório de estado e mensagens de recuperação de falha;
5. smoke test em máquina virtual Windows limpa, incluindo instalação, primeira abertura, segunda instância, atualização e desinstalação;
6. decisão sobre fechar a janela versus manter agente em tray/serviço — por enquanto fechar encerra tudo.

## Não autorização

Esta decisão não habilita mobile, acesso remoto ao painel, CORS, Node no renderer, shell arbitrário, auto-start, serviço do Windows, atualização automática, publicação `stable`, leitura adicional do runtime privado ou qualquer capability que já esteja bloqueada pelos gates existentes.
