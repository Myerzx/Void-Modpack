# Validação da Fase 2

- Data: 2026-08-03
- Resultado: aprovada
- Escopo: fundação da plataforma, sem controle real do Minecraft

## Gate executado

```powershell
cd Plataforma
npm ci
npm run check
npm audit --omit=dev
```

No encerramento da Fase 2, 33 testes cobriam contratos, criptografia, RBAC, PostgreSQL, API, worker, agente e fixtures do painel. O primeiro pacote puramente determinístico da Fase 3 elevou o gate a 36; os adaptadores isolados elevaram o total a 40, o controlador serializado a 48 e o console limitado elevou o total atual a 53 testes. Typecheck estrito e builds de todos os workspaces passaram novamente.

## Matriz

| Limite | Evidência |
| --- | --- |
| Contratos | 14 testes estruturais e semânticos; cinco schemas JSON exportados |
| Autenticação | Argon2id, tokens opacos, comparação por hash e validade de envelope |
| RBAC | deny-by-default, permissões conhecidas e separação de papéis |
| PostgreSQL | migrações, seed, idempotência, lease único e conclusão transacional |
| Control API | malformed input, rate limit, sessão, CSRF, revogação, autorização negada e auditoria |
| Agente | token de uso único, transporte autenticado, assinatura, prazo e nonce anti-replay |
| Worker | somente `system.noop`; job operacional permanece na fila |
| Panel Web | toda métrica marcada `fixture-local`; desired/observed não fingem estado real |
| UI | build estático e inspeção headless em 1440×1000 e 390×844 |

## Dependências

`npm audit --omit=dev` retorna zero vulnerabilidades. O audit completo reporta três advisories altos transitivos em `postcss`/`sharp` trazidos pelo Next 16.2.12. A versão estável corrente do Next ainda fixa essas versões. Para a Fase 2, o painel usa `output: export`: Next, PostCSS e Sharp são dependências de desenvolvimento e o artefato implantável contém somente HTML/CSS/JS estático em `out/`; não há servidor Next nem pipeline de imagem no runtime. Atualizar assim que houver versão upstream corrigida e reavaliar antes de qualquer painel dinâmico.

## Não ações confirmadas

- nenhum mundo, JAR, segredo, perfil de jogador ou configuração privada entrou no Git;
- nenhum processo Minecraft foi iniciado, parado ou inspecionado;
- nenhum arquivo de `Servidor/workspace/` ou `Launcher/workspace/` foi alterado;
- o painel não chama API nem apresenta suas fixtures como telemetria real;
- force kill, restore, console genérico e rotas operacionais continuam ausentes; o console limitado existe somente no pacote e na fixture descartável.
