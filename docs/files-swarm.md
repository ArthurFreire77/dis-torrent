# Arquivos e semeadura (swarm)

**Atualizado em 2026-11-07.** Descreve o que o código faz HOJE. Onde algo não
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
| `chunk_hashes` | blake3 de cada bloco | conferido por bloco; **omitido acima de 4096 blocos** (o frame tem teto de 1 MB) |

O anúncio é um frame `FileAnnounce` (ver `PROTOCOL.md`). Ele NÃO transfere
conteúdo, só metadados.

## Fluxo de envio

1. `fileSwarm.shareFile(file)` lê os bytes, calcula os hashes e guarda tudo em
   memória (`have` = todos os blocos) — **até 64 MB**.
2. Acima de 64 MB o arquivo **não entra na memória**: o hash é calculado em
   streaming (`File.slice`) e cada bloco é lido do arquivo original no momento
   do pedido (`sourceFiles`), e o caminho é registrado em `seed.meta.<file_id>`
   (`seed_register`) para sobreviver a fechar e reabrir o app.
3. `services.fileAnnounce(...)` persiste a linha em `files` e manda o
   `FileAnnounce` para os peers **online naquele instante**.
4. A mensagem na conversa leva os metadados (`encodeFileBody`), então quem
   recebe vê o cartão e escolhe baixar.

## Fluxo de download

1. Ao receber o cartão, `onAnnounce` registra o arquivo e o remetente como
   seeder — sem baixar nada sozinho (exceto prévia de mídia dentro do limite).
2. No gesto de baixar, `fetchSwarm` pede os blocos que faltam, em paralelo
   adaptativo (8 por seeder, com teto), alternando entre seeders.
3. Cada bloco recebido é conferido contra `chunk_hashes`; bloco inválido marca
   o peer e o bloco é pedido a outro.
4. **Até 64 MB**, os blocos ficam na memória (`data`). **Acima de 64 MB**, cada
   bloco vai direto para o spool em disco (`spool_put`), um arquivo `.blk` por
   bloco, e a memória guarda apenas o bitmap (`ChunkSet`, ~2 MB para 2 milhões
   de blocos).
5. Ao completar, o Rust monta o arquivo final (`spool_finish`), confere o hash
   inteiro em streaming e move para a pasta escolhida.
6. `markDownloaded` libera a RAM e o nó se anuncia como seeder.

### Arquivo grande pergunta onde salvar

Acima de **512 MB**, `startDownload` abre o modal "Onde salvar?" com a pasta
atual e o espaço livre. Cancelar **não baixa nada** (o erro é explícito). A
pasta escolhida é gravada (`download_dir_set`) e vale para os próximos
downloads; se ela sumir (pen drive), o app volta para Downloads.

## Cache de prévias (7 dias, só mídia pequena)

| Tipo | Teto do cache | Observação |
|---|---|---|
| imagem | **7 MB** | acima disso a prévia não é baixada sozinha |
| vídeo | **250 MB** | idem |
| outro arquivo | 0 | nunca entra no cache sem o usuário mandar baixar |

Chave: `swarm:<file_id>:<index>`. O `DiskLru` (`distorrent-core/src/cache.rs`)
aplica TTL de **7 dias** (configurável de 1 a 30) **e** teto de tamanho; o que
expira sai primeiro. O TTL é renovado a cada leitura (LRU).

## Persistência da semeadura

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
| `seed.meta.<file_id>` (caminho no disco) | `seed_files.rs` | reabre a semeadura no boot, sem copiar o arquivo |

## Retomada após fechar o app

- **Quem baixa**: o spool fica em `<app_data>/spool/<hash do file_id>/`, com o
  bitmap `.bits`. Ao reabrir, `ensureHydrated` lê o bitmap e continua do bloco
  que faltou. O download em andamento aparece na fila (status `queued`) e
  reinicia sozinho.
- **Quem semeia**: `restoreSeeds()` (`seed_list`) re-registra os caminhos
  salvos e re-anuncia; cada bloco é lido do disco na hora do pedido.
- Spools e caminhos com mais de **7 dias** são apagados (`spool_gc`), assim como
  entradas cujo arquivo sumiu (`seed_list` valida tamanho e existência).

## O que ainda NÃO existe

- **BitTorrent real**: não há DHT de arquivos nem troca de blocos entre
  terceiros. Quem não tem o arquivo pede ao dono/seeder, não a um "peer
  intermediário". O swarm é um conjunto de seeders diretos, não uma rede de
  troca entre baixadores.
- **Limite de banda por transferência**: existe `NetLimiter` no core para a
  rede em geral, não por arquivo.

## Limites e validações

- Tamanho máximo por anúncio: **500 GiB** (`MAX_ANNOUNCED_FILE_BYTES` no core e
  `VITE_DISTORRENT_MAX_FILE_MB`, padrão 512000, no frontend). Blocos máximos:
  2.200.000.
- Bloco acima do limite é recusado em `file_send_chunk` (512 KiB).
- Arquivo com nome executável é bloqueado no salvamento (`spool_finish` e
  `save_file_stream`) e na triagem por magic bytes.
- O hash final é conferido em **streaming** no `spool_finish`; o anunciado pode
  vir truncado em 32 hex e a comparação é por prefixo.

## Como verificar na prática

1. Dois nós online, um envia um arquivo de ~5 MB.
2. O outro baixa. `downloadManager` deve mostrar progresso e os blocos vindo
   de quem enviou.
3. Feche o app de quem enviou **e** o de quem baixou. Reabra os dois.
4. O segundo nó deve continuar anunciado como seeder e o primeiro deve
   conseguir baixar de novo sem o original.
5. Arquivo de 1 GB: o modal "Onde salvar?" aparece; cancelar não baixa; fechar
   o app no meio e reabrir retoma do bloco onde parou (conferir `spool_stats`).

