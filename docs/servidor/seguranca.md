# Segurança do servidor

## Estado encontrado

A auditoria encontrou autenticação online desabilitada, whitelist e enforcement desabilitados, RCON habilitado e uma senha RCON configurada. Também existe seed configurada e há operadores e usuários em cache. Nenhum valor sensível ou identidade foi copiado para a documentação.

Essa combinação é crítica se o servidor for alcançável por uma rede não confiável: em modo offline, o servidor não valida identidades com os serviços oficiais; sem whitelist, qualquer identidade aceita pela camada de rede pode tentar entrar; RCON acrescenta uma superfície administrativa de alto impacto.

## Baseline antes de publicar

1. Parar o servidor e criar um backup restaurável do mundo e das configurações privadas.
2. Rotacionar a credencial RCON que existia no material bruto.
3. Manter `enable-rcon=false`, salvo necessidade operacional comprovada. Se habilitado, restringir a porta por firewall/rede privada e nunca versionar a senha.
4. Usar `online-mode=true`, `white-list=true` e `enforce-whitelist=true` para uma implantação direta.
5. Caso exista proxy autenticador, documentar sua topologia, validar encaminhamento seguro e impedir acesso direto ao backend antes de considerar modo offline.
6. Revisar operadores pelo princípio do menor privilégio e reconstruir whitelist e bans no ambiente de implantação.
7. Não publicar `server.properties`, arquivos de acesso, caches, seed, endereços, logs ou backups reais.

O arquivo `Servidor/templates/server.properties.example` é uma referência segura, não um substituto para revisão de firewall, proxy, portas, autenticação e política de acesso do ambiente real.

### Emenda de 2026-08-06 — o item 4 foi substituído por decisão de produto

O [ADR-009](../plataforma/DECISIONS/ADR-009-autenticacao-minecraft-e-topologia.md) decidiu que **`online-mode` permanece `false`**, porque o servidor deve aceitar jogadores sem conta oficial. O item 4 acima continua registrado como a recomendação que a auditoria fez com a informação que tinha; ele não é mais o caminho escolhido.

O achado crítico **não** foi dispensado. O que a decisão remove é a ausência de autenticação, não o modo offline:

- uma camada de autenticação passa a ser obrigatória, integrada ao VoidFall ou por mod aprovado pelo Gate G4, e nenhum jogador obtém privilégio antes de autenticar;
- os UUIDs offline existentes valem como identidades locais legadas e **nunca** como prova de propriedade de conta;
- os 7 operadores encontrados perdem privilégio até reivindicarem novamente sua identidade, e `ops.json` deixa de ser fonte de autoridade para o VoidFall;
- em modo offline a whitelist filtra **nomes**, não identidades: ela permanece útil como redução de superfície e não conta como controle de acesso;
- se o registro será livre ou por convite continua em aberto, e um servidor sem conta oficial com registro livre aceita, na prática, qualquer pessoa que alcance a porta.

Os itens 1, 2, 3, 6 e 7 permanecem válidos como estão. O item 5 deixa de se aplicar: proxy foi avaliado e descartado para Forge 1.20.1 no próprio ADR.

## Verificação

Execute:

```powershell
& .\Servidor\tools\Test-ServerDocumentation.ps1
```

O teste rejeita arquivos privados conhecidos, binários, caminhos locais, senha RCON, seed e endereço preenchidos no escopo público.
