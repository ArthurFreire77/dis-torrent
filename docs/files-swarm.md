# Arquivos e semeadura (swarm)

**Atualizado em 2026-11-02.** Descreve o que o código faz HOJE. Onde algo não
está implementado, o texto diz isso em vez de prometer.

## Resumo

Um arquivo enviado no chat não passa por servidor: o remetente divide o
conteúdo em blocos, anuncia os metadados (nome, tamanho, hash de cada bloco) e
serve os blocos direto aos peers que pedirem. Quem baixa o arquivo inteiro
também passa a servir. Isso é o "todos semeiam".

## Identidade do arquivo

| Campo | Origem | Observação |
|---|---|---|
| `file_id` | aleatório + timestamp no envio | único por envio, não por conteúdo |
| `name` | nome do arquivo (só o basename) | path traversal é removido em `shareFile` |
| `size` | bytes reais | teto validado (`validateAnnounce`) |
| `chunks` | `ceil(size / CHUNK)` | `CHUNK` = 256 KiB |
| `hash` | blake3 do arquivo inteiro (32 hex) | conferido ao final |
| `chunk_hashes` | blake3 de cada bloco | conferido por bloco; bloqueia bloco corrompido |

O anúncio é um frame `FileAnnounce` (ver `PROTOCOL.md`). Ele NÃO transfere
conteúdo, só metadados.

## Fluxo de envio

1. `fileSwarm.shareFile(file)` lê os bytes, calcula os hashes e guarda tudo em
   memória (`have` = todos os blocos).
2. `services.fileAnnounce(...)` persiste a linha em `files` e manda o
   `FileAnnounce` para os peers **online naquele instante**.
3. A mensagem na conversa leva os metadados (`encodeFileBody`), então quem
   recebe vê o cartão e escolhe baixar.

## Fluxo de download

1. Ao receber o cartão, `onAnnounce` registra o arquivo e o remetente como
   seeder — sem baixar nada sozinho (exceto prévia de imagem).
2. No gesto de baixar, `fetchSwarm` pede os blocos que faltam, em paralelo
   adaptativo (8 por seeder, com teto), alternando entre seeders.
3. Cada bloco recebido é conferido contra `chunk_hashes`; bloco inválido marca
   o peer e o bloco é pedido a outro.
4. Ao completar, `markDownloaded` libera a RAM (os bytes ficam no spool) e o
   nó se anuncia como seeder.

## Persistência da semeadura (corrigido em 1.1.36)

O anúncio original era disparado **uma vez**, para os peers online naquele
momento, e não era registrado em lugar nenhum. Consequências reais:

- quem baixava um arquivo servia só até fechar o app;
- quem estava offline no envio nunca sabia que o arquivo existia;
- o download do outro lado morria em "sem peers com o arquivo no swarm".

Agora:

| Mecanismo | Onde | Quando |
|---|---|---|
| `seeded_at` na tabela `files` (schema v9) | `storage.rs` | grava o instante do último anúncio |
| `reannounce_files()` | tique de 15 s | re-anuncia seus arquivos para os online (no máximo a cada 30 s por arquivo) |
| `flush_files_to(peer)` | peer fica `Online` | manda tudo que você tem para quem acabou de subir |

Ordem de custo: frame pequeno por arquivo, uma vez a cada 30 s por peer. Não
há reenvio de conteúdo nesses anúncios — só metadados.

## O que ainda NÃO existe

- **BitTorrent real**: não há DHT de arquivos nem troca de blocos entre
  terceiros. Quem não tem o arquivo pede ao dono/seeder, não a um "peer
  intermediário". O swarm é um conjunto de seeders diretos, não uma rede de
  troca entre baixadores.
- **Retomada após reinício pelo `file_id` antigo**: o `file_id` é novo a cada
  envio; o spool é indexado por `file_id`, então reabrir o app mantém a
  semeadura do que já foi anunciado (o core re-anuncia), mas o download
  interrompido depende do mesmo `file_id` na mensagem original.
- **Limite de banda por peer**: existe `NetLimiter` no core para a rede em
  geral, não por transferência de arquivo.

## Limites e validações

- Tamanho máximo por anúncio: ver `validateAnnounce` (frontend) e o teto de
  50 GB no core (rejeita campos gigantes ou incompatíveis).
- Bloco acima do limite é recusado em `file_send_chunk`.
- Arquivo com nome executável é bloqueado no salvamento (plugin Android) e na
  triagem de download.

## Como verificar na prática

1. Dois nós online, um envia um arquivo de ~5 MB.
2. O outro baixa. `downloadManager` deve mostrar progresso e os blocos vindo
   de quem enviou.
3. Feche o app de quem enviou **e** o de quem baixou. Reabra os dois.
4. O segundo nó deve continuar anunciado como seeder e o primeiro deve
   conseguir baixar de novo sem o original.

O passo 4 é exatamente o que a 1.1.36 corrige; antes ele falhava em silêncio.
