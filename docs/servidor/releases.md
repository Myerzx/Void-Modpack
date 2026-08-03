# Releases do servidor

## Artefatos previstos

Uma release aprovada deve ser reconstruída, não copiada do workspace bruto. O conjunto mínimo é:

- manifesto do servidor com hashes, origem, licença e lado de cada dependência;
- overrides estritamente necessários e sanitizados;
- configuração pública de referência;
- scripts de instalação/inicialização sem credenciais;
- changelog e matriz de compatibilidade com o cliente;
- checksums do artefato final.

Mundo, operadores, whitelist, bans, caches, logs, crash reports, backups, mapas, seed, endereços, credenciais, bibliotecas geradas e painel local não pertencem ao pacote público.

## Gates obrigatórios

- [ ] P0 de segurança resolvidos e segredo histórico rotacionado.
- [ ] Cliente canônico definido e compatibilidade certificada.
- [ ] Dependências classificadas como cliente, servidor ou ambos.
- [ ] Origem, versão, hash e permissão de distribuição verificadas.
- [ ] Patches, stubs, scripts, datapacks e mídia com autoria/licença documentadas.
- [ ] Instalação reconstruída em diretório vazio.
- [ ] Boot com mundo novo e boot com cópia de teste do mundo existente.
- [ ] Conexão, login, desconexão e reconexão do cliente aprovado.
- [ ] Sistemas customizados críticos exercitados.
- [ ] Restart intencional e recuperação de falha validados.
- [ ] Backup restaurado com sucesso em ambiente isolado.
- [ ] Nenhum segredo, dado pessoal, caminho local ou binário não aprovado no artefato.

## Versionamento

O servidor e o cliente devem ter versões próprias, ligadas por uma matriz explícita. Uma release só pode declarar compatibilidade com combinações que passaram pelos testes acima. Alterações de mods, Forge, datapacks, KubeJS, configurações de rede ou dados persistentes exigem nova avaliação.
