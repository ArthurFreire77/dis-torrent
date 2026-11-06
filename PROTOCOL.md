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
O enum completo é bem maior (arquivos, chamadas, comunidades, presença, bots —
ver `distorrent-core/src/protocol.rs`); os que carregam conteúdo de conversa são
`Msg(MessageEnvelope)` e `ChannelMsg { .. }`.

## Protocolo v5 — autenticidade de build

`transport::PROTO_V = 5` é o `proto_v` anunciado no `Hello`/`HelloAck` e entra
no `build_id`. A camada de atestação exige `ATTEST_PROTO_V = 5`.

Quatro frames novos em `SecureFrame` (classe de prioridade 1, junto de
mensagens pequenas — volume baixo de propósito, para não competir com chat nem
com sinalização de voz):

| Frame | Campos | Papel |
|---|---|---|
| `BuildChallenge` | `nonce_hex: String`, `transcript_hash: String`, `policy: String` (`#[serde(default)]`) | pergunta de atestação |
| `BuildAttestResponse` | `attestation_hex: String` | resposta: JSON de `BuildAttestation` em hex |
| `BuildManifestPush` | `manifest_hex: String` | manifesto assinado oferecido por peer |
| `UpdateHint` | `version: String`, `manifest_hash: String` | aviso de atualização |

`policy` no desafio é informativo; o receptor o ignora (`..`). A política
**dele** é que vale para a quarentena.

### Sequência

```
A ── BuildChallenge{nonce32, blake3(transcript), policy} ──▶ B
A ◀─ BuildAttestResponse{attestation_hex} ───────────────── B
```

- O desafio é enviado quando o peer fica ONLINE, **só** se o `proto_v` dele é
  `>= 5`. Peer antigo não é desafiado e fica `NAO_VERIFICADO`.
- O `transcript_hash` é `hex(blake3(transcript))` do handshake daquela conexão
  (`HandshakeResult.transcript_hash`). O receptor confere contra o **seu**
  valor da mesma sessão antes de responder — um peer não pode desafiar em nome
  de outra sessão.
- O emissor guarda o nonce por peer e **consome** ao processar a resposta. Uma
  segunda resposta exige novo desafio.
- Se o peer receber um `BuildChallenge` e não tiver transcript registrado para
  aquele peer, ignora (sem resposta e sem erro de sessão).

### Binding da resposta

```
payload = BLAKE3(
  "distorrent/v1|build-attestation|"
  || transcript_hash (ASCII hex)
  || nonce (32 bytes)
  || u32 BE len(fp) || fp
  || claim canônica
)
sig = Ed25519(identidade do peer)
```

`claim` (ordem fixa, todos com prefixo u32 BE de comprimento + UTF-8):
`version`, `manifest_hash`, `build_id`, `commit`, `channel`, `self_integrity`,
`hardware.mechanism`, depois `protocol_version` (u32 BE) e `security_epoch`
(u64 BE).

`BuildAttestation` carrega `claim`, `nonce[32]`, `transcript_hash`,
`manifest_hex` (wire hex do manifesto assinado, ou vazio) e `sig`.

O receptor verifica, nesta ordem: nonce esperado → transcript desta sessão →
assinatura do peer autenticado → `manifest` decodificado na forma canônica →
`verify_manifest` com as **chaves locais** → claim == manifesto verificado
(`version`, `manifest_hash`, `commit`, `channel`, `security_epoch`) → `DIVERGE`
declarado derruba o estado. `hardware.proof_available` é recalculado
localmente, não lido da claim.

### Quarentena

Quando o veredito + política resulta em bloqueio, o peer entra em quarentena. O
laço de leitura descarta **todo** frame que não seja da lista mínima, **sem
derrubar a sessão**:

```
permitidos: Ping, Pong, Bye,
            BuildChallenge, BuildAttestResponse, BuildManifestPush, UpdateHint
```

Ou seja: mensagem, arquivo, chamada, presença e estado de comunidade não
passam. O link continua vivo para o peer descobrir que precisa atualizar.

### Compatibilidade

- Peer `proto_v < 5`: não recebe desafio, não manda atestação, permanece
  `NAO_VERIFICADO`. Nada quebra — os frames antigos continuam idênticos.
- Peer `proto_v >= 5` sem chaves de confiança no receptor: a verificação fica
  **indisponível** (`verification_available = false`) e a política **não**
  bloqueia por `NAO_VERIFICADO`. Bloquear em massa por falta de chave seria
  transformar configuração ausente em negação de serviço.
- `BuildManifestPush` de peer é sempre re-verificado com as chaves locais; o
  resultado (`Ok(true/false)`) não fecha a sessão.

### Limites da camada

| Item | Default |
|---|---|
| desafio/resposta por peer | 10/10 s, burst 6 |
| push de manifesto por peer | 4/10 s, burst 2 |
| falhas de atestação por peer | 3/10 s, burst 2 |
| verificações simultâneas (global) | 16 |
| `attestation_hex` | 256 KiB de **hex** (128 KiB de bytes) |
| `manifest_hex` | 128 KiB de hex (2 × 64 KiB de bytes) |

Uma resposta com veredito negativo consome uma unidade do bucket de falhas
(`attest_failure_budget` consulta sem consumir, `note_attest_failure` consome).
Esgotado o bucket, as respostas seguintes são descartadas **antes** da
verificação criptográfica.

Env: `DISTORRENT_LIMIT_ATTEST_10S`, `_ATTEST_BURST`, `_ATTEST_FAIL_10S`,
`_ATTEST_FAIL_BURST`, `_MANIFEST_PUSH_10S`, `_MANIFEST_PUSH_BURST`,
`_ATTEST_CONC`.

Spec completa, incluindo formato do manifesto e contagem de assinaturas
(2 de 3 por padrão), em [`docs/RELEASE_TRUST.md`](docs/RELEASE_TRUST.md).

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
