# Operação do servidor

## Requisitos conhecidos

- Java 17 de 64 bits;
- Forge 1.20.1-47.4.4;
- heap máximo historicamente configurado em 8 GB;
- armazenamento rápido e folga para mundo, backup temporário e restauração;
- cliente cuja lista de mods e configurações tenha sido certificada para a mesma release.

O valor de memória é evidência do ambiente auditado, não dimensionamento universal. Meça pausa de GC, uso real, número de jogadores, distância de visão e geração de chunks antes de ajustar.

## Ciclo operacional recomendado

### Inicialização

1. Confirmar Java, Forge, EULA, configuração privada e espaço livre.
2. Confirmar que não há outro processo usando o mundo ou a porta do servidor.
3. Iniciar em console observável, arquivando logs fora do artefato Git.
4. Aguardar a mensagem de conclusão e executar o smoke test de conexão.

### Parada

1. Avisar os jogadores.
2. Salvar o mundo e emitir a parada normal pelo console.
3. Aguardar o processo terminar antes de copiar ou compactar o mundo.
4. Confirmar que o supervisor não interpretou a parada como falha.

O script Windows encontrado reinicia o processo em loop após qualquer saída. Para produção, substitua esse comportamento por um supervisor que diferencie parada intencional, falha e limite de tentativas. O script Unix observado executa apenas uma vez.

### Backup e restauração

1. Fazer backup consistente com o processo parado ou com uma ferramenta que coordene flush e snapshot.
2. Incluir o mundo completo, configurações privadas necessárias e metadados de versão; excluir logs, caches e bibliotecas reconstruíveis.
3. Gerar checksum, registrar data, versão e política de retenção.
4. Restaurar periodicamente em diretório isolado e validar boot, dimensões, inventários e dados de mods.

## Evidência atual

O último log analisado contém boot concluído em 55,355 segundos. Existem 16 crash reports históricos; portanto, essa evidência não substitui boot de mundo novo, restart controlado, conexão de cliente, backup e restauração em ambiente limpo.
