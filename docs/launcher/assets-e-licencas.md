# Ativos, texturas e licenças

## Matriz auditada

| Ativo | Estado no perfil | Decisão inicial |
|---|---|---|
| Better Leaves 9.4 | Habilitado; licença MIT declarada dentro do ZIP | Referenciar pelo project/file ID; não duplicar o ZIP no Git |
| Excalibur V1.20 | Habilitado; project/file ID disponível | Referenciar pelo manifesto; revisar licença antes de publicação pública |
| Complementary Reimagined 5.5.1 | Arquivo presente, mas Oculus desabilitado | Opcional; não declarar funcional |
| Complementary Unbound 5.5.1 | Arquivo presente, mas Oculus desabilitado | Opcional; não declarar funcional |
| `resources.zip` / CtE Resources | 167 MB; origem/licença não comprovadas | Quarentena no perfil bruto |
| `epicfight_custom_armors.zip` | Local, sem project ID e ligado a armaduras desabilitadas | Não distribuir até revisão |
| `mapa-...zip` | Apenas encapsula cópias de Excalibur/Better Leaves | Excluir como duplicata |
| FancyMenu `config/fancymenu/assets` | Interface VoidFall e áudio local | Mantido na fonte; confirmar autoria/licença antes do GitHub público |

## Regras

1. Preferir project/file IDs a binários versionados.
2. Registrar URL oficial e licença para qualquer override de terceiros.
3. Não usar Git LFS como substituto de permissão de redistribuição.
4. Assets autorais devem ter arquivo de licença e créditos antes da primeira release pública.
5. O validador deve falhar para arquivos acima de 95 MB, dando margem ao limite do GitHub.

