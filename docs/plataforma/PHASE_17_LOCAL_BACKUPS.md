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

`backup.restore` não é concedida nem anunciada no desktop. O serviço atual restaura bytes para um diretório novo e isolado, porém o handler legado usa o controlador do servidor ativo para o boot de verificação. Isso não prova que a cópia restaurada abre. Habilitar essa capability produziria uma confirmação enganosa e poderia iniciar o mundo errado.

O próximo recorte de restore precisa:

1. compor um runtime descartável apontado para a cópia isolada;
2. iniciar essa cópia sem tocar no mundo ativo;
3. registrar boot, parada e verificação do conteúdo esperado;
4. pedir confirmação destrutiva separada antes de qualquer troca atômica;
5. manter rollback do mundo substituído.

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
