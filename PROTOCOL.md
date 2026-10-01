# PROTOCOL — FORGE v1 (implementado)

Transporte e entidades REAIS. Este documento descreve o que roda — não o que é desejado.

## Transporte
- **Frames TCP**: `u32 BE len + bytes`; limite 1 MiB por frame.
- **Discovery LAN**: UDP broadcast `255.255.255.255:45900` a cada 2s com `Announcement{proto:"forge/v1", fp, pubkey, nickname, tcp_port, ts}`. Receptor valida `fp == blake3(pubkey)[..12hex]`.
- **Handshake** (A=iniciador, B=respondente):
  1. `A→B Hello{fp,pub,nick,na[16],ephA[32],port}`
  2. `B→A HelloAck{fp,pub,nick,nb[16],ephB[32], sig_B=sign(transcript)}`
  3. `A→B HelloOk{ sig_A=sign(transcript) }`
  - `transcript = blake3("forge/v1|hs|" fpA|ephA|na| fpB|ephB|nb)`
  - Verificações: fp↔pubkey vinculado; assinatura ed25519 sobre transcript → anti-MITM + anti-replay (nonces frescos).
- **Sessão**: `key = HKDF-SHA256(ikm=X25519(ephA,ephB), salt=na||nb, info="forge/v1/session-chacha20poly1305")`.
  Frames AEAD: nonce 12B = `dir(1) || counter(8 BE) || zeros(3)`, `dir` 0=emissor iniciador / 1=respondente, AAD=`"forge/frame"`.
- **Heartbeat**: Ping a cada 10s; silêncio > 25s → peer OFFLINE → reconexão com backoff exponencial 1s→15s.

## Frames de sessão (`SecureFrame`, cifrados)
```
Msg(MessageEnvelope) | Ack{msg_id} | Ping{ts} | Pong{ts} | Bye
```

## MessageEnvelope (assinado)
```
{ id, conv_id, author_fp, body, ts, sig }
id  = blake3(author_fp|conv_id|ts|body|rand)[hex]
sig = ed25519.sign(blake3("forge/v1|msg|" id|conv_id|author_fp|body|ts_be))
```
Receptor valida SEMPRE: `author_fp == peer da conexão`, `verify(sig, pubkey do PeerBook)`, `conv_id == DM determinística do par`.

## IDs determinísticos
- **DM id** = `blake3("forge/v1|dm|" min(fp1,fp2) "|" max(fp1,fp2))[..24hex]` — ambos os lados derivam o mesmo id sem coordenação.
- **Fingerprint** = `blake3(pubkey)[..12]` hex.

## Estados
- Conexão (por peer e agregado): `DISCONNECTED | CONNECTING | CONNECTED | RECONNECTING`
- Mensagem (out): `pending → sending → sent → delivered` (ou `failed`); (in): `ok`
- Outbox: mensagens `pending` são reenviadas ao reconectar (até ACK); dedupe por `id` no receptor.

## Storage (SQLite — schema v1)
`kv, peers, conversations, messages, outbox` — ver `forge-core/src/storage.rs`. Append-only para mensagens.

## Fases seguintes (desenho, não implementado)
- Comunidades: `Community{community_id, owner_fp, ...}`, canais/categorias; mensagens de canal assinadas pelo autor e autorizadas pelo host (permissões no core).
- Convites: token assinado pelo dono `{community_id, exp, uses}` — sem segredo permanente em URL.
- Sync: vector clock por log; `MessageEnvelope` já é append-only e verificável fora de banda.
