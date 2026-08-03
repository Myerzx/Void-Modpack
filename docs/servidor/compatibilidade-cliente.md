# Compatibilidade do cliente

## Comparação por nome exato de JAR

| Conjunto | JARs ativos | Iguais aos 181 do servidor | Só no servidor | Só no cliente |
| --- | ---: | ---: | ---: | ---: |
| Cliente embutido na exportação privada | 220 | 178 | 3 | 42 |
| Launcher atualmente publicado no repositório | 23 | 11 | 170 | 12 |

O inventário completo está em [`inventario/compatibilidade-cliente.csv`](inventario/compatibilidade-cliente.csv).

## Conclusão

O conteúdo atual de `Launcher/` não é um cliente compatível com este servidor e não deve ser divulgado como tal. O cliente embutido no material privado é muito mais próximo, mas também não pode ser promovido diretamente: ele contém metadados de launcher, estado local e arquivos cuja distribuição ainda precisa ser resolvida.

A comparação usa nome exato de arquivo. Ela detecta divergência objetiva, mas não garante compatibilidade binária, lado correto, mesma configuração, mesma ordem de datapacks, protocolo de rede ou comportamento em jogo.

## Caminho para compatibilidade

1. Decidir qual identidade de produto prevalece: o launcher VoidFall já documentado ou o servidor The Casket of Reveries.
2. Criar um manifesto canônico compartilhado com versão de Minecraft, Forge, arquivo, hash, origem, licença, lado e obrigatoriedade.
3. Separar mods `client`, `server` e `both`; não copiar os 220 JARs para o servidor.
4. Promover apenas configurações e resource packs necessários, removendo contas, servidores salvos e caminhos locais.
5. Gerar pacotes independentes para cliente e servidor a partir do mesmo catálogo aprovado.
6. Testar importação em launchers suportados, boot limpo e conexão real na mesma versão.

Até esses passos terminarem, a release do servidor permanece bloqueada.
