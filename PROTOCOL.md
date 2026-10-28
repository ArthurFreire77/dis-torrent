# PROTOCOL — DisTorrent (implementado)

Transporte e entidades REAIS. Este documento descreve o que roda — não o que é desejado.

## Transporte
- **Frames TCP**: `u32 BE len + bytes`; limite 1 MiB por frame.
- **Discovery LAN**: UDP broadcast `255.255.255.255:45900` a cada 2s com `Announcement{proto:"distorrent/v1", fp, pubkey, nickname, tcp_port, ts}`. Receptor valida `fp == blake3(pubkey)[..12hex]`.
- **Handshake** (A=iniciador, B=respondente):
  1. `A→B Hello{fp,pub,nick,na[16],ephA[32],port}`
  2. `B→A HelloAck{fp,pub,nick,nb[16],ephB[32], sig_B=sign(transcript)}`
  3. `A→B HelloOk{ sig_A=sign(transcript) }`
  - `transcript = blake3("distorrent/v1|hs|" fpA|ephA|na| fpB|ephB|nb)`
  - Verificações: fp↔pubkey vinculado; assinatura ed25519 sobre transcript → anti-MITM + anti-replay (nonces frescos).
- **Sessão**: `key = HKDF-SHA256(ikm=X25519(ephA,ephB), salt=na||nb, info="distorrent/v1/session-chacha20poly1305")`.
  Frames AEAD: nonce 12B = `dir(1) || counter(8 BE) || zeros(3)`, `dir` 0=emissor iniciador / 1=respondente, AAD=`"distorrent/frame"`.
- **Heartbeat**: Ping a cada 10s; silêncio > 25s → peer OFFLINE → reconexão com backoff exponencial 1s→15s.

## Frames de sessão (`SecureFrame`, cifrados)
```
Msg(MessageEnvelope) | Ack{msg_id} | Ping{ts} | Pong{ts} | Bye
```

## MessageEnvelope (assinado)
```
{ id, conv_id, author_fp, body, ts, sig }
id  = blake3(author_fp|conv_id|ts|body|rand)[hex]
sig = ed25519.sign(blake3("distorrent/v1|msg|" id|conv_id|author_fp|body|ts_be))
```
Receptor valida SEMPRE: `author_fp == peer da conexão`, `verify(sig, pubkey do PeerBook)`, `conv_id == DM determinística do par`.

## IDs determinísticos
- **DM id** = `blake3("distorrent/v1|dm|" min(fp1,fp2) "|" max(fp1,fp2))[..24hex]` — ambos os lados derivam o mesmo id sem coordenação.
- **Fingerprint** = `blake3(pubkey)[..12]` hex.

## Estados
- Conexão (por peer e agregado): `DISCONNECTED | CONNECTING | CONNECTED | RECONNECTING`
- Mensagem (out): `pending → sending → sent → delivered` (ou `failed`); (in): `ok`
- Outbox: mensagens `pending` são reenviadas ao reconectar (até ACK); dedupe por `id` no receptor.

## Limites de rede (net/`netlimit.rs`) — taxa ≠ tamanho

Todo caminho de entrada tem rate limit em dois andares: **throttle** (token
bucket apertado — excedente descartado, sessão preservada; o protocolo
reenvia) e **kill** (token bucket 5x mais largo — flooding/bug encerra a
sessão). Frames e BYTES são limitados INDEPENDENTEMENTE por peer; há tetos
globais (accepts, frames, sessões online) e de concorrência (handshakes
inbound, dials outbound). Defaults reconfiguráveis por env `DISTORRENT_LIMIT_*`;
snapshot no diagnóstico via comando `net_limits`. Tabela completa em
[`THREAT_MODEL.md`](THREAT_MODEL.md).

Privacidade em `proxy`/`full` (Tor): dial **fail-closed** (sem fallback direto
quando o SOCKS5 falha), inbound direto **recusado**, discovery UDP/mDNS/UPnP
**off na fonte**, punch upgrade **off** — e trocar o modo derruba sessões
diretas vivas na hora. Testado em `tests/privacy_fail_closed.rs` (4 casos
E2E) e nos unit tests de `netlimit.rs`.

## Storage (SQLite — schema v8)

`distorrent-core/src/storage.rs`. Tabelas por versão de migration:

| v | Adiciona |
|---|---|
| 1 | `kv`, `peers`, `conversations`, `messages`, `outbox` |
| 2 | identidade local (apelido, segredo) |
| 3 | contatos e mensagens com anexos/metadados |
| 4 | `communities`, `channels`, `community_members`, `bots` |
| 5 | `server_rules`, `audit_log`, `reputation`, `reports` |
| 6 | wizard de criação de servidor (categorias, cargos, bots) |
| 7 | `thread_id` (threads) |
| 8 | mute global de conta |

`MessageEnvelope` é append-only e verificável fora de banda (a assinatura é do
autor e o receptor revalida sempre).

## Comunidades, canais e convites (implementado)

Não é roadmap — está no core, com migration, comando Tauri e teste:

- **Comunidades** — `Community{community_id, owner_fp, …}` em `social.rs`; canais
  com categoria e posição; criação via wizard (`channels.rs`, `community_meta.rs`).
- **Convites** — token assinado pelo dono com expiração e número de usos
  (`distorrent/v1|invite|community|member|exp`); nenhum segredo permanente em URL.
- **Permissões** — validadas no core (`moderation.rs`), nunca na UI. Kick, ban,
  mute e shadow-ban com registro em `audit_log`.
- **Cargos e bots** — persistidos e sincronizados do dono para os membros, com
  fallback explícito para `localStorage` no modo navegador.
