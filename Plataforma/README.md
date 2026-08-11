# Plataforma de gerenciamento

Status: **Fases 2–7 tecnicamente concluídas em isolamento; Fases 8–13 planejadas; ativação operacional, publicação stable e comando no jogo bloqueados pelos gates aplicáveis**.

Esta pasta é a raiz implementada do painel, das APIs, do agente, do worker, do Bridge e dos contratos da plataforma VoidFall. As Fases 2 a 7 foram implementadas em isolamento e validadas somente contra documentação pública, fixtures sanitizadas, bancos efêmeros e diretórios temporários. Nenhuma operação foi ligada ao servidor ou launcher privado.

## Linguagens definidas

| Escopo | Linguagem | Motivo |
| --- | --- | --- |
| Painel, APIs, agente e worker | TypeScript estrito | Contratos compartilhados, validação estática e uma base comum entre web e serviços |
| Ponte do comando Forge | Java 17 | O comando roda dentro do servidor Forge 1.20.1, cujo runtime auditado usa Java 17 |
| Persistência | SQL/PostgreSQL | Integridade transacional, auditoria e fila durável de baixa escala |
| Automação operacional | PowerShell e shell mínimos | Somente adaptadores revisados; nunca comandos montados por concatenação |

## Estrutura implementada

- `apps/control-api`: Fastify, sessões opacas, CSRF, RBAC, auditoria e identidade do agente;
- `apps/build-worker`: consumidor PostgreSQL de `system.noop` e `modpack.build`, este limitado a um `planId` opaco e executor confiável injetado;
- `apps/launcher-api`: leitura pública de canais, manifestos e artifacts assinados;
- `apps/server-agent`: cliente outbound-only de registro e heartbeat Ed25519;
- `apps/panel-web`: dashboard responsivo somente leitura, exportado como site estático;
- `apps/desktop`: shell Electron desktop-only, com renderer isolado e Control API/PGlite/agente em utility process;
- `packages/contracts`, `authentication`, `permissions` e `database`: fundação compartilhada;
- `packages/mod-catalog`: reconciliação determinística de snapshots sanitizados com o catálogo revisado, sem filesystem ou rede;
- `packages/modpack-release`: build reproduzível, sanitização, Ed25519, artifacts imutáveis, promoção CAS e rollback;
- `packages/launcher-protocol`: planner portátil com chave pinada e propriedade explícita dos arquivos gerenciados;
- `packages/minecraft-process`: planos, runtime, adaptadores Windows/Linux, controlador idempotente e catálogo fechado de console, com parada graciosa, saída limitada e testes por fixture Java.
- `packages/server-backup`: snapshots consistentes sob guarda offline e restore somente em destino isolado;
- `packages/server-configuration`: Java Properties tipado com revisão anterior, recuperação e rollback versionado.
- `integrations/forge-bridge`: núcleo Java 17 deny-by-default, ainda sem adapter/instalação Forge.

## Limite do recorte atual

- não apontar os adaptadores para o Java, JAR ou diretório do servidor privado;
- não usar serviço do Windows, systemd, RCON ou qualquer shell;
- não modificar `Launcher/`, `Servidor/workspace/` ou qualquer runtime privado;
- não transformar filename, presença ou metadata de provedor em identidade lógica, lado ou licença aprovada;
- não ligar ciclo de vida, leitura, comandos, backup ou configuração à API antes dos bloqueios do [roadmap](../docs/plataforma/ROADMAP.md);
- não promover `stable` nem habilitar `/atualizar-modpack` antes de aprovar cliente-base, distribuição, importação limpa e compatibilidade;
- usar apenas executável e diretório absolutos de configuração confiável, argv fixo e `shell: false`;
- manter o dashboard como demonstração até existir telemetria real autenticada.

## Validação

```powershell
cd Plataforma
npm ci
npm run check
npm audit --omit=dev
```

O relatório da Fase 2 está em [`docs/plataforma/PHASE_2_VALIDATION.md`](../docs/plataforma/PHASE_2_VALIDATION.md). Detalhes de integração, confiança e evolução estão em [`docs/plataforma/CONTRACTS.md`](../docs/plataforma/CONTRACTS.md).

Comece pela [documentação da plataforma](../docs/plataforma/README.md). Para continuar a implementação pelo terminal, siga o [plano das fases finais](../docs/plataforma/FINAL_IMPLEMENTATION_PLAN.md).

## Aplicativo desktop em desenvolvimento

O primeiro spike Windows pode ser aberto diretamente a partir do monorepo:

```powershell
cd Plataforma
npm run desktop
```

O comando compila a stack necessária e abre o painel em uma janela nativa. O estado fica fora do Git em `%LOCALAPPDATA%\VoidFall\runtime-development`. Ainda não existe instalador distribuível; consulte [Aplicativo desktop — primeiro spike executável](../docs/plataforma/PHASE_DESKTOP_SHELL.md).
