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

## Verificação

Execute:

```powershell
& .\Servidor\tools\Test-ServerDocumentation.ps1
```

O teste rejeita arquivos privados conhecidos, binários, caminhos locais, senha RCON, seed e endereço preenchidos no escopo público.
