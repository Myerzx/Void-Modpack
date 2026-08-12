# Fase 17 — backup local operacional

Status: criação de backup de mundo concluída em 2026-08-11; restore do mundo ativo continua bloqueado.

## O que ficou operacional

O aplicativo desktop provisiona um repositório privado por `ServerInstance` dentro do diretório de estado do VoidFall. O painel `/backups` consulta o catálogo real, exige `backups.create`, envia CSRF e cria uma operação durável `backup.create`; o agente reivindica o job e usa o mesmo lock `minecraft-exclusive` de processo e configuração.

A origem não vem do painel nem do job. O bootstrap local lê `level-name` de `server.properties`, resolve o mundo dentro da raiz vinculada e recusa path absoluto, escape da raiz, arquivo ausente, symlink/junction ou valor ambíguo. Nesta fatia, a única modalidade oferecida pela interface é `world`.

Cada instância recebe duas chaves aleatórias de 256 bits, persistidas fora do repositório de snapshots e fora do Git:

- HMAC-SHA256 sela o manifesto;
- AES-256-GCM cifra cada arquivo em repouso;
- os contratos e o catálogo expõem somente os IDs das chaves;
- logs, operações e jobs não carregam path nem material secreto.

Os limites locais reservam 8 GiB livres depois da cópia, aceitam no máximo 7 snapshots e 64 GiB no total. A política conserva ao menos os 2 mais novos e só torna os demais elegíveis após 30 dias. Falta uma tela de gestão de retenção; quando a quota ou a reserva de disco não comportar outra cópia, o preflight recusa antes de gravá-la.

## Restore permanece separado

`backup.restore` não é concedida nem anunciada no desktop. Restaurar sobre o mundo ativo destrói tudo o que aconteceu desde a cópia, então continua sendo pedido, permissão, tipo de operação e capability próprios, e nada nesta fatia o habilita.

Os cinco pré-requisitos registrados para o restore eram:

1. compor um runtime descartável apontado para a cópia isolada;
2. iniciar essa cópia sem tocar no mundo ativo;
3. registrar boot, parada e verificação do conteúdo esperado;
4. pedir confirmação destrutiva separada antes de qualquer troca atômica;
5. manter rollback do mundo substituído.

Os itens 1 a 3 foram implementados como o ensaio não destrutivo descrito abaixo. Os itens 4 e 5 continuam deliberadamente ausentes.

## Ensaio de recuperação — `backup.verify-restore`

Um ensaio restaura para uma raiz privada nova, monta o runtime Forge em volta dessa cópia, inicia na loopback e encerra. Ele é uma capability separada de `backup.restore` de propósito: autorizar um ensaio de recuperação não pode conceder silenciosamente o poder de trocar dados vivos. O pedido não possui `acknowledgesDataLoss` porque não tem autoridade para substituir mundo nenhum.

O que a migration `0032` acrescenta é um tipo de operação e uma capability próprios, mantendo a regra existente de que toda operação de backup nomeia o snapshot a que se refere.

Limites que o ensaio preserva:

- a workspace vinculada é lida, nunca escrita, e o diretório restaurado é o cwd da JVM;
- o mundo ativo é excluído da cópia de runtime por caminho, não por convenção de nome;
- `server.properties` e `eula.txt` do servidor real não são copiados; o ensaio gera os seus com `server-ip=127.0.0.1`, `max-players=0`, whitelist obrigatória, RCON e query desligados;
- a raiz restaurada não pode ser, conter ou estar contida na workspace;
- symlink, junction, traversal e colisão de destino são recusados por segmento durante a cópia;
- o espaço livre é conferido antes de copiar, com reserva de 2 GiB além do tamanho inventariado.

A rota exige `backups.restore`, CSRF e uma observação de processo atual em `offline`; o handler reconfere o snapshot no agente, porque a retenção pode tê-lo removido entre a decisão da rota e a execução.

### O ensaio real ainda não foi comprovado

A implementação está completa e coberta por testes, mas **nenhum ensaio real chegou ao fim**. A tentativa de 2026-08-11 às 23:31 deixou o volume isolado vazio.

A causa não é incidental. O transporte limita qualquer lease a `MAXIMUM_LEASE_MS`, hoje 900 s de trabalho mais 30 s de margem, e não existe renovação: o supervisor reivindica a lease e aguarda o handler até o fim. Um ensaio precisa de uma cópia multi-GB somada a um boot do Forge, que já foi observado em 723 s. Isso não cabe em 930 s.

O `minecraft-exclusive` que a operação adquire já reserva 3.600 s. O lock e a lease discordam sobre quanto a operação pode durar, e é a lease que vence. O timeout padrão de boot de 600 s pertence ao mesmo problema: ele é coerente com o teto atual da lease, não independente dele.

Enquanto isso não for resolvido, o ensaio termina como `lease-expired` e o restore continua sem prova de recuperação.

## Smoke real de 2026-08-11

Com o Forge desligado, o fluxo painel → API → job → agente criou `world-20260812t002047689` a partir do mundo vinculado:

- estado final `available`;
- 7.642 arquivos;
- 8,7 GiB exibidos no painel;
- AES-256-GCM registrado no catálogo;
- SHA-256 do manifesto `812e17c1927d33489d8db9223d13b557b2d15aa50a1a5c4586cad62d23d342c1`;
- nenhum processo Java iniciado;
- reinício do aplicativo reencontrou o snapshot disponível;
- pacote Windows empacotado passou o smoke externo de persistência e encerramento.

Esse resultado comprova criação, selo, cifra, promoção e persistência do catálogo. Ele ainda não certifica restauração, boot da cópia, troca do mundo ativo nem cópia externa do host.
