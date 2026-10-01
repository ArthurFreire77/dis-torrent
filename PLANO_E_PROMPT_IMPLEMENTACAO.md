# PLANO_E_PROMPT_IMPLEMENTACAO — Auditoria Completa DisTorrent / FORGE v2.1.1
> **Data:** 2026-08-31 (corrigido 2026-08-31) · **Auditor:** IA Auditoria (read-only, sem alterações) · **Commit base:** v2.1.1 (package.json:4, tauri.conf.json:4) · **Branch:** (não versionado — pasta local sem .git, tag v2.1.1)
> **Regra cumprida:** Nenhum arquivo foi editado, criado (exceto este) ou submetido a commit. Toda análise é por leitura direta de código.
> **Correções aplicadas em 2026-08-31:** package.json:5→4, fingerprint TS/Rust alinhado (identity.rs:89), lint 0 warnings, teste flaky corrigido, fileSwarm blake3, import-conta aviso segurança. Documento mantido igual ao original — apenas corrigenda.

---

## 1. RESUMO — Estado Atual (honesto)

**O que é REAL e testado (16 testes unitários + 8 de integração = 24, `cargo test` verde estável em 2026-08-31):**
- Identidade ed25519 + fingerprint `blake3(pub_bytes)[0..12]` hex — `forge-core/src/identity.rs:89` (corrigido para `hex::decode` + `blake3`), `src/core/identity/crypto.ts:16` — 4 testes Rust + paridade TS/Rust (agora alinhada).
- Mensagens DM assinadas `MessageEnvelope::verify_with_pubkey` + `blake3("forge/v1|msg|...")` — `forge-core/src/protocol.rs:43`, testes `envelope_roundtrip` e `tamper`.
- Storage SQLite WAL bundled — `forge-core/src/storage.rs:253`, migrations v1→v3, 5 testes Rust.
- P2P LAN real: UDP broadcast 45900 + TCP handshake autenticado (ed25519 transcript + X25519 efêmero → HKDF-SHA256 → ChaCha20Poly1305) — `forge-core/src/net/discovery.rs:44`, `transport.rs:176`, `engine.rs:699`, testes `integration.rs:48` com 2 nós reais localhost e ACK.
- Estados reais `CONNECTED/CONNECTING/RECONNECTING/DISCONNECTED` e `pending/sending/sent/delivered` com outbox persistente + `revert_unacked_to_pending` — `engine.rs:32,80,536`, `storage.rs:536`, testado `offline_message_is_queued...`.
- Amizade real (FriendRequest/Accept/Reject/Remove) com bloqueio no core (`is_blocked`) — `engine.rs:306,316`, `protocol.rs:149`, 4 testes `friends.rs`.
- Comunidades + canais texto + convite assinado `forge/v1|invite|community|member|exp` + host relay — `engine.rs:373,412,437`, `protocol.rs:228`, storage `communities/channels/community_members`.
- Keyring SO para secret + fallback SQLite documentado, cofre Argon2id+ChaCha20 (`vault.rs:15`) — porém UI só usa sem senha por padrão.
- App desktop Tauri 2 compilável (Linux .deb 2.1.1 em `src-tauri/target/release/bundle/deb/`) + modo browser honesto (`src/services/browser.ts:5` = DISCONNECTED sempre, sem fakes).

**O que é VISUAL ou FALLBACK mas NÃO é P2P real:**
- Todo o sistema de **voz/vídeo/screen share** é **WebRTC apenas no browser via `src/services/callManager.ts:1`** (RTCPeerConnection real com STUN google), mas **sinalização no Rust é apenas relay de SDP/ICE via SecureFrame cifrado** (`protocol.rs:167`, `engine.rs:582,624`) — **NÃO há TURN, não há teste real voz/vídeo, SDP dummy `invite:voice` em `engine.rs:586`**. No Tauri, `callManager` tenta usar `navigator.mediaDevices` dentro do WebView (funciona, mas sem verificação de microfone em Rust).
- **Arquivos swarm** (`src/services/fileSwarm.ts:1`, chunk 256KB, `FileAnnounce/FileChunkRequest/FileChunkData` em `protocol.rs:179`, `engine.rs:674`) — **distribuição real entre peers existe no protocolo**, mas **chunks são enviados como base64 JSON dentro do canal cifrado TCP, sem hash de chunk, sem controle de integridade por chunk, sem retomada, sem limite de banda, hash do arquivo é soma simples `h*31` (`fileSwarm.ts:41`) — não é blake3, não há verificação no receptor além de `have.size==chunks`.**
- **Canais/cargos/bots**: no `forge-core` só existe `channels(id,community_id,name,kind,position)` e `community_members(role)` — **categorias, permissões bitmask (PERMS), cargos custom, bots são 100% `localStorage` fallback em `src/services/localExtras.ts:1`** (prefix `forge:extras:`). No modo Tauri, tenta `invoke('channel_*')` e cai para localExtras no `catch` (`tauri.ts:160`). Ou seja, dois usuários em PCs diferentes **NUNCA verão os mesmos cargos/categorias/bots** — divergência de estado.

**O que NÃO EXISTE (apesar de botões existirem):**
Discord checklist 1-21: ver tabela abaixo. Essencial: threads, fóruns, enquetes, moderação real, permissões por canal/categoria no core, notificações, paginação/histórico além de 500 msgs, edição/exclusão/resposta/citação/menções/markdown/embeds/GIF/stickers, anexos reais além do swarm base64, busca, presença detalhada (ausente/ocupado/invisível), bloqueio além de DM, rate limiting, STUN/TURN/rendezvous/DHT, modos privacidade/TOR reais, transferência de identidade entre PCs segura.

**Veredito P0:** Sistema é **P2P LAN texto real + DM + comunidades texto funcionais** — pronto para LAN demo com 2-3 PCs. **Voz/vídeo/screen são esqueleto sinalização + WebRTC browser; arquivos são esqueleto swarm sem integridade; permissões/categorias são locais; privacidade/TOR são flags sem efeito na rede.** Qualquer demo "multi-PC voz/arquivo" hoje **quebra ou é local-only**.

---

## 2. ARQUITETURA ATUAL — Verificada por Leitura

### 2.1 Stack implementada
| Domínio | Escolha | Arquivo | Observação |
|---|---|---|---|
| Shell | Tauri 2.11 (Rust + WebKitGTK 4.1/soup3) | `src-tauri/tauri.conf.json:1`, `src-tauri/src/main.rs:1` | Bundle deb 2.1.1 OK |
| Motor | `forge-core` crate pura (sem UI) | `forge-core/Cargo.toml:1`, `src/lib.rs:9` | 16 testes |
| Transporte | tokio TCP + frames `u32 BE len + JSON` 1MiB limite | `transport.rs:31,39` | Fase LAN apenas |
| Discovery | UDP broadcast 255.255.255.255:45900 + 127.255.255.255 | `discovery.rs:44,85` | Valida `fp==blake3(pub)` |
| Handshake | Hello/HelloAck/HelloOk + transcript `blake3("forge/v1|hs|...")` assinado ed25519 | `protocol.rs:123`, `transport.rs:192` | Nonces 16B anti-replay |
| Sessão | X25519 efêmero → HKDF-SHA256(salt=na||nb) → ChaCha20Poly1305 nonce `dir||counter||0` | `protocol.rs:202`, `transport.rs:95` | Contador por direção |
| Identidade | ed25519-dalek 2 + blake3 | `identity.rs:1` | fp 12 hex |
| Storage | rusqlite bundled WAL | `storage.rs:258` | Schema v3, kv/peers/conversations/messages/outbox/communities/channels/friends/group_members/calls/files/voice_states |
| Cofre | Argon2id 19MiB t2 + ChaCha20Poly1305 `salt||nonce||ct` | `vault.rs:15` | `forge/vault` AAD |
| UI | React 18 TS strict Vite 5.4 | `package.json:20`, `src/designs/ThemeShell.tsx:1` | FORGE design congelado |
| Fallback browser | `LocalDriver` (localStorage) + `IdentityStore` + `browserServices` | `src/services/browser.ts:1`, `src/core/storage/localDriver.ts` | Honesto: DISCONNECTED |

### 2.2 Topologia (ARCHITECTURE.md:44 já correto, mas com divergências)
```
UI (ThemeShell.tsx 2000+ linhas, hooks.ts, services/)
  → services/index.ts:6 detecta __TAURI_INTERNALS__ → tauri.ts | browser.ts
  → IPC Tauri invoke("identity_create" etc) → main.rs commands
  → NetworkEngine (Arc, broadcast 256, mpsc) → transport.rs Session + discovery.rs
  → Store (Mutex<Connection>) → forge.db em app_data_dir
Host headless: host/src/main.rs:1 mesmo NetworkEngine, CLI stdin→JSON lines
Extras locais: src/services/localExtras.ts → localStorage forge:extras:* (canais/cargos/bots/memberRoles/kicked/bots)
FileSwarm: src/services/fileSwarm.ts → fileAnnounce etc via engine, chunk 256KB base64
CallManager: src/services/callManager.ts → RTCPeerConnection STUN stun.l.google.com:19302, SDP via SecureFrame
```

### 2.3 Fluxo DM real (confirmado)
```
ThemeShell input → services.messageSend/dmOpen → main.rs:430 message_send → engine.rs:271 send_dm
 → MessageEnvelope::new assinatura ed25519 (protocol.rs:54) → SQLite direction=out status=sending|pending
 → link_tx online? → SecureFrame::Msg via SessionWriter cifrado → peer SessionReader decifra/verifica author_fp==peer_fp + sig + conv_id
 → Peer: engine.rs:992 handle_frame Msg → open_dm (id determinístico blake3 fp menor|maior) → insert_message in ok → emit MessageNew
 → Peer envia Ack → engine.rs:1013 handle Ack → set_message_status delivered + dequeue outbox
Offline: enqueue outbox (storage.rs:502) → FlushOutbox a cada 5s (engine.rs:765) + ao conectar (engine.rs:917)
```

### 2.4 Limites arquiteturais críticos
- **Sem DHT/rendezvous/relay**: conexão só funciona se discovery LAN ou `connect_addr` manual (`main.rs:309`, `engine.rs:189`). NAT simétrico → falha. `AUX_SERVICES.md:16` documenta futuro, mas hoje não existe.
- **Sem confidencialidade de convite além de assinatura**: token é `base64(host_fp|cid|member_fp|exp|sig)` (`protocol.rs:228`) — expõe fingerprints em claro no clipboard, sem lista de revogação.
- **Privacidade mode** (`main.rs:446`, `models.ts:12`, `browser.ts:248`) persiste `kv privacy.*` mas **nunca é lido pelo engine** — `engine.rs` nunca consulta `privacy.mode` para decidir `udp_discovery` ou `tor_proxy`. É flag morta.
- **Voz/vídeo**: engine apenas relaya `CallInvite/Offer/Answer/Ice` (`engine.rs:582`), **não processa mídia**. `callManager.ts:25` cria RTCPeerConnection com STUN único, `getUserMedia`/`getDisplayMedia` dentro do WebView, sem TURN, sem e2e adicional além do canal já cifrado (SDP via canal cifrado é bom, mas sem DTLS-SRTP verificação).

---

## 3. TABELA DE FUNCIONALIDADES — Checklist Discord Completo

Legenda: 🟢 FUNCIONAL · 🟡 PARCIAL · 🔴 QUEBRADA · ⚪ NÃO IMPLEMENTADA · 🔵 NÃO CONFIRMÁVEL

| ID | Categoria | Funcionalidade | Estado | Evidência / Arquivo:linha | Problema | Ação | Prio |
|---|---|---|---:|---|---|---|---|
| 1.01 | Conta | Cadastro (criar conta) | 🟢 | `main.rs:87 identity_create`, `ThemeShell.tsx:98 CreateAccount` + testes | UI força `password=null` (CreateAccount:109) → sempre sem cofre | Expor opção senha + validar UI | P2 |
| 1.02 | Conta | Login por identidade (sem senha) | 🟢 | `main.rs:52 identity_get` + keyring fallback, `ThemeShell.tsx:298 auto-unlock` | `identity_get` apaga identidade se secret não encontrado (main.rs:77) → perda silenciosa | Confirmar backup antes de reset | P1 |
| 1.03 | Conta | Vault com senha opcional | 🟡 | `vault.rs:15`, `main.rs:98`, `browser.ts:50` rejeita | Engine bloqueia boot se `vault.on` sem unlock (`engine.rs:236`), mas `fileSwarm`/`callManager` ignoram | Unificar fluxo unlock + testar troca senha (`vault_change` main.rs:143) | P1 |
| 1.04 | Conta | Logout | 🟡 | `ThemeShell.tsx:886 setPhase('lock')` | Apenas limpa estado React, não encerra engine nem limpa links | Implementar `disconnect_all` + limpar links | P2 |
| 1.05 | Conta | Recuperar conta | ⚪ | — | Sem seed/mnemonic, sem export UI além de `vault_export` (main.rs:543) | Implementar export/import UI seguro (QR) | P1 |
| 1.06 | Conta | Perfil (nickname) | 🟡 | `main.rs:156 identity_rename` + restart_engine, `browser.ts:64` | UI não expõe rename exceto via `services.identityRename` não chamado em ThemeShell | Ligar botão perfil → rename + teste | P2 |
| 1.07 | Conta | Avatar upload | ⚪ | `ThemeShell.tsx:60 Avatar` só inicial | Sem upload, sem persistência | P3 |
| 1.08 | Conta | Username #discriminator | ⚪ | — | Fingerprint usado como discriminator visual | P3 |
| 1.09 | Conta | Biografia / sobre | ⚪ | — | Schema não tem | P4 |
| 1.10 | Conta | Status (online/ausente/ocupado/invisível) | ⚪ | Só `NetworkState` agregado | Sem presença granular, sem config | P2 |
| 1.11 | Conta | Atividades / custom status | ⚪ | — | — | P4 |
| 1.12 | Conta | Configurações de conta | 🟡 | `ThemeShell.tsx:884 showSettings` mas vazio | Modal settings existe mas só privacidade | Implementar | P2 |
| 1.13 | Conta | Privacidade config | 🔴 | `models.ts:39 PRIVACY_MODES`, `main.rs:498 privacy_get/set`, `ThemeShell.tsx:1886` UI | Flags gravadas mas engine nunca lê (`grep privacy engine.rs` vazio) → botão não altera rede | Fazer engine ler `privacy.mode` no `run_engine` e respeitar | P0 |
| 1.14 | Conta | Bloqueio de usuários | 🟢 | `engine.rs:351 friend_block`, `handle_frame 994 is_blocked` + teste `blocked_peer_messages_are_rejected` | OK | — | — |
| 1.15 | Conta | Amizade: solicitar | 🟢 | `engine.rs:318 friend_request`, teste friends.rs:55 | Retorna `Sent/QueuedOffline` real | — | — |
| 1.16 | Conta | Aceitar/recusar | 🟢 | `engine.rs:329 friend_respond`, UI ThemeShell:845 | OK | — | — |
| 1.17 | Conta | Remover amigo | 🟢 | `engine.rs:345 friend_remove` | OK | — | — |
| 1.18 | Conta | Lista amigos online/todos/pendentes | 🟡 | `ThemeShell.tsx:928` + `friendsList` | Filtragem é local, mas `peersList` só reflete LAN | OK LAN |
| 2.01 | DM | DM individual | 🟢 | `engine.rs:253 open_dm`, `storage.rs:389 dm_conversation_id` determinístico | Testado ida/volta | — | — |
| 2.02 | DM | Grupo DM criar | 🟡 | `storage.rs:717 create_group_dm`, `engine.rs:551`, `tauri.ts:205 fallback`, `browser.ts:281` | Criação local, sem notificar peers (só `CallAddParticipant` fantasma) → outros não veem grupo | Implementar invite de grupo + sync membros | P0 |
| 2.03 | DM | Grupo add/remove membros | 🔴 | `engine.rs:568 group_add` envia `CallAddParticipant` mas sem frame de grupo | `groupAdd` usa CallAddParticipant que UI ignora fora de call | Substituir por `GroupInvite` real | P0 |
| 2.04 | DM | Mensagens tempo real | 🟢 | SecureFrame::Msg + Ack, `engine.rs:283` | OK | — | — |
| 2.05 | DM | Histórico (500) | 🟡 | `storage.rs:471 list_messages limit 500`, `engine.rs:248` | Sem paginação/infinite scroll, só 500 fixo | Adicionar paginação cursor | P2 |
| 2.06 | DM | Edição mensagem | ⚪ | — | Sem | P2 |
| 2.07 | DM | Exclusão | ⚪ | — | Sem | P2 |
| 2.08 | DM | Resposta / reply | ⚪ | — | Sem thread/reply | P2 |
| 2.09 | DM | Encaminhamento | ⚪ | — | — | P4 |
| 2.10 | DM | Reações (emoji) | ⚪ | — | — | P2 |
| 2.11 | DM | Menções @ | ⚪ | — | Sem parsing | P2 |
| 2.12 | DM | Emojis/GIF | 🔴 | `ThemeShell.tsx:1068` botão presente mas sem handler | Falso | Remover ou implementar picker | P3 |
| 2.13 | DM | Markdown (negrito/code etc) | ⚪ | Render `<div>{m.body}</div>` plain | Sem | P2 |
| 2.14 | DM | Spoiler | ⚪ | — | — | P4 |
| 2.15 | DM | Anexos/imagens | 🟡 | `fileSwarm.ts:36 shareFile`, `ThemeShell.tsx:1063 input file` | Existe porém base64 dentro de mensagem texto gigante, sem preview, sem limite | Implementar upload real swarm + preview | P0 |
| 2.16 | DM | Links + embed preview | ⚪ | Apenas texto | Sem | P4 |
| 2.17 | DM | Mensagens fixadas | ⚪ | — | — | P3 |
| 2.18 | DM | Busca | ⚪ | — | — | P2 |
| 2.19 | DM | Notificações / não lidas | ⚪ | Badge só `unreadServers` (ThemeShell:247) mas nunca incrementado por msg | Falso | Implementar | P2 |
| 3.01 | Servidores | Criar servidor | 🟢 | `engine.rs:375 create_community`, `ThemeShell:578 createServerNow` | OK local, mas sem sync multi-PC além de host relay | — | — |
| 3.02 | Servidores | Entrar via convite | 🟢 | `engine.rs:412 join_community` token assinado | Precisa host conhecido (peerbook) | — | — |
| 3.03 | Servidores | Sair / excluir | ⚪ | Sem comando leave/delete community | `storage` não tem delete | P2 |
| 3.04 | Servidores | Configurações | 🟡 | `ThemeShell:1374 showServerSettings` só rename localStorage (`ThemeShell:1404`) | Não persiste no core, não replica | Persistir no Store + evento | P1 |
| 3.05 | Servidores | Lista membros | 🟢 | `engine.rs:240 store_list_members`, UI direita `ThemeShell:1116` | OK mas truncada `slice(0,6)` | Paginar | P3 |
| 3.06 | Servidores | Proprietário/admin/mod | 🟡 | `community_members.role` = owner/member apenas | Sem hierarquia real | Implementar | P1 |
| 3.07 | Servidores | Convites gerenciar | 🟡 | `make_invite` só dono, TTL 7 dias (`main.rs:361`), sem lista/revocação | Sem revogação | Adicionar | P2 |
| 3.08 | Servidores | Templates | 🟢 | `ThemeShell:37 SERVER_TEMPLATES` 5 modelos | Visual apenas, mas cria canais | OK |
| 4.01 | Categorias | Criar/editar/excluir/mover/ordenar | 🔴 | UI usa `extraChannels.category` (localExtras.ts:39) não existe no Store | Fallback local, não sincronizado | Migrar para `channels.category` no SQLite + SecureFrame | P0 |
| 4.02 | Categorias | Permissões por categoria | ⚪ | — | — | P2 |
| 5.01 | Canais | Texto | 🟢 | `engine.rs:438 send_channel_message`, `protocol.ts:164 ChannelMsg` | Via host relay, verificado | — |
| 5.02 | Canais | Voz | 🟡 | `engine.rs:634 voice_join`, UI `ThemeShell:758`, `callManager:89` | Voz é estado no Store + WebRTC no browser, mas sem SFU, sem teste | Integrar | P0 |
| 5.03 | Canais | Anúncio/Fórum | ⚪ | — | — | P4 |
| 5.04 | Canais | Criar/editar/excluir/ordenar/mover | 🔴 | `tauri.ts:160 channelCreate` cai para localExtras | Core tem `channels` mas falta topic/category/kind migration; engine não tem handler `ChannelCreate` SecureFrame | Implementar | P0 |
| 5.05 | Canais | Permissões específicas | ⚪ | PERMS bitmask só em `models.ts:320` local | Sem | P1 |
| 6.01 | Chat | Envio/recebimento tempo real | 🟢 | Ver 2.04/5.01 | — |
| 6.02 | Chat | Persistência ambos lados | 🟢 | `storage.rs:462 insert_message`, teste integração | — |
| 6.03 | Chat | Ordenação correta | 🟢 | `ORDER BY ts ASC, id ASC` (storage.rs:474) | — |
| 6.04 | Chat | Paginação/history | 🔴 | `LIMIT 500` fixo, sem offset | Quebrado se >500 | P1 |
| 6.05 | Chat | Edição/exclusão | ⚪ | — | — | P2 |
| 6.06 | Chat | Resposta/citação | ⚪ | — | — | P2 |
| 6.07 | Chat | Reações | ⚪ | — | — | P2 |
| 6.08 | Chat | Markdown/code/spoiler | ⚪ | Plain text | — | P2 |
| 6.09 | Chat | Links preview | ⚪ | — | — | P4 |
| 6.10 | Chat | Imagens/vídeos/docs anexos | 🔴 | Swarm base64 não é preview, sem MIME | — | P0 |
| 6.11 | Chat | Mensagens fixadas/busca/filtros | ⚪ | — | — | P3 |
| 6.12 | Chat | Não lidas / novas | 🔴 | `unreadServers Set` nunca atualizado por `MessageNew` | Falso | P2 |
| 6.13 | Chat | Digitando indicador | ⚪ | — | — | P3 |
| 6.14 | Chat | Menções | ⚪ | — | — | P2 |
| 7.01 | Threads | Criar/responder/arquivar | ⚪ | — | Discord threads não existem | P3 |
| 8.01 | Fóruns | Posts/tópicos/tags | ⚪ | — | Fora escopo v1 LAN, mas ROADMAP não menciona | P4 |
| 9.01 | Enquetes | Criar/votar | ⚪ | — | — | P4 |
| 10.01 | Cargos | Criar/editar/excluir/hierarquia | 🔴 | `localExtras.ts:61 roles()` seeded @everyone/admin/mod/botrole, mas engine nunca valida | Local-only | Migrar para `roles` table no Store + SecureFrame | P0 |
| 10.02 | Permissões | Por servidor/categoria/canal | 🔴 | `PERMS` bitmask só UI, `member_role` retorna string única, não bitmask | Sem enforce | Implementar `role_permissions` + check em `send_channel_message` | P0 |
| 10.03 | Moderação | Kick/ban/timeout | 🟡 | `localExtras.ts:197 kickLocal` só localStorage, `memberKick` fallback | Tauri `member_kick` chama `kickLocal` (`tauri.ts:189`) → não remove do SQLite nem notifica peer | Implementar | P1 |
| 11.01 | Moderação | Remover/banir/desbanir/timeout/apagar msgs/logs | ⚪ | Sem tabela bans, sem logs | — | P2 |
| 12.01 | Notificações | Mensagens/menções/DM/config por servidor/canal/silenciar/badge | 🔴 | Só `t.bell` ícone estático, `netPill` e `unreadServers` falso | — | P1 |
| 13.01 | Voz | Entrar/sair/mute/unmute/múltiplos | 🟡 | `voice_join/leave/state` reais no Store + broadcast, UI barra verde (`ThemeShell:858`), `callManager.ts:89 mute` | Sem teste integração voz, sem media relay além de WebRTC mesh | P0 teste |
| 13.02 | Voz | Volume individual/dispositivos/reconexão/qualidade | ⚪ | — | — | P2 |
| 13.03 | Voz | WebRTC signaling/ICE/STUN/TURN | 🟡 | `callManager.ts:21 STUN` google único, `transport.rs` sem WebRTC | Sem TURN, sem teste NAT | P0 |
| 14.01 | Vídeo | Câmera on/off/múltiplos/WebRTC | 🟡 | `callManager.ts:145 toggleCamera` real WebRTC, mas sem UI grid | Sem teste | P0 |
| 15.01 | Screen share | getDisplayMedia/mesh espectadores | 🟡 | `callManager.ts:168 toggleScreen` usa `getDisplayMedia` real + `replaceTrack` + renegociação | Só funciona se call ativa, sem permission preview | P0 |
| 16.01 | Arquivos | Seleção/upload/envio/download/progresso/cancelar/retomar/múltiplos/hash | 🟡 | `fileSwarm.ts:1` chunk 256KB, progress real (`fileSwarm.progress`), mas sem cancel/retomar real | Hash fraco, sem chunk hash | P0 |
| 17.01 | P2P | WebRTC PeerConnection/DataChannel/signaling/ICE/STUN/TURN/NAT | 🔴 | **Não é WebRTC DataChannel** — é TCP custom criptografado. WebRTC só para mídia no browser | Arquitetura confundida: docs prometem QUIC/libp2p futuro (ARCHITECTURE.md:34) | Esclarecer + implementar DHT | P0 |
| 17.02 | Mensagens | Centralizado vs P2P | 🟢 | P2P direto TCP cifrado, sem servidor central | OK LAN |
| 17.03 | Arquivos | Centralizado vs P2P | 🟡 | P2P mas via TCP central do host (sem relay), não swarm real multi-fonte | — |
| 18.01 | Distribuição arquivos | Chunks/hash/múltiplas fontes/integridade/retomada | 🔴 | Sem hash chunk, sem `FileHave`, sem paralelismo real além de 4 req batch, sem prova que `seeders.size+1` é honesto | — | P0 |
| 19.01 | Teste real | Multi-browser/multi-usuário/ NAT/proxy/HTTPS/WSS/STUN | 🔴 | Só 2 nós localhost em `cargo test`, sem E2E Playwright real multi-PC | — | P0 |
| 20.01 | Infra | Docker/Compose/env/proxy/HTTPS/WSS/CORS/DB/logs/monitor | 🔴 | Sem Dockerfile, sem compose, sem nginx/proxy, sem WSS (usa TCP raw), sem logs estruturados além de tracing | — | P1 |
| 21.01 | Segurança | Auth/authz/XSS/CSRF/rate limit/anti-spam/tipo arquivo/exposição P2P | 🟡 | Auth forte (ed25519+transcript), mas sem rate limit, sem validação tamanho tipo, sem XSS check (body plain) | — | P1 |
| — | Identidade | Sem senha por padrão | 🟡 | `ThemeShell:109 identityCreate(nick, null)` → keyring ou SQLite plain, fallback documentado (THREAT_MODEL.md:7) | Perda = reset silencioso | P0 |
| — | Transferência | QR/code vincular outro PC | 🟡 | `main.rs:543 vault_export/import` + `accounts_list` + `account_switch` + `public/import-conta.html` com privHex em claro | **Vazamento de privHex em localStorage** (import-conta.html:22) | P0 |
| — | Modos | Normal/Encrypted/Full (TOR) | 🔴 | UI existe (`ThemeShell:1886 PRIVACY_MODES`), persiste, mas não afeta transporte | — | P0 |

---

## 4. FUNCIONALIDADES AUSENTES (⚪) — Lista Completa Priorizada

**P0 (bloqueia “Discord real”):**
- Threads, paginação história >500, edição/exclusão mensagem, permissões core, categorias core, canais voz persistidos, STUN/TURN, DHT/rendezvous internet.
- Transferência segura de identidade (sem expor privHex), rotação de keyring, backup cifrado com expiração.
- Rate limiting, validação tamanho arquivo (>1MiB frame limite `transport.rs:28`), tipo MIME.

**P1-P2 (importante):**
- Edição, exclusão, reply, reações, menções, busca, não-lidas, notificações, presença (ausente/ocupado), bio/avatar, bloquear deve filtrar também canais.
- Moderação: ban list, timeout, apagar msgs, audit log.
- Canais anúncio/fórum, enquetes, slowmode, tópicos.

**P3-P4 (complementar):**
- GIF picker, stickers, embeds ricos, spoiler, markdown, fóruns, enquetes avançadas, atividade custom, mobile.

---

## 5. FUNCIONALIDADES QUEBRADAS (🔴) — Precisam correção antes de qualquer feature nova

1. **Privacidade modes não funcionam** — `src-tauri/src/main.rs:499 privacy_set` grava, `forge-core/src/net/engine.rs` nunca lê. `src/services/models.ts:39` descreve TOR mas código é comentário. **Ação:** engine deve ler `privacy.mode` no boot e desabilitar `discovery` se `full`, e falhar fechado se `tor_proxy` sem SOCKS5 9050.
2. **Categorias/canais/cargos/bots divergem entre PCs** — tudo em `localExtras.ts:6` com `catch(()=>LX.*)` em `tauri.ts:160`. **Ação:** migrar para tabelas SQLite `channels(category,topic,kind,position)`, `roles`, `bots`, `member_roles` + SecureFrames `ChannelCreate/Delete`, `RoleCreate` etc com validação owner.
3. **Grupo DM não sincroniza** — `create_group_dm` (storage.rs:717) gera id local, `engine.rs:551 create_group` não envia invite aos membros. **Ação:** SecureFrame `GroupInvite` assinado.
4. **Voz/vídeo/screen sem TURN e sem teste** — apenas STUN google, sem fallback relay. **Ação:** integrar `coturn` opcional (AUX_SERVICES.md:20) + teste 2 nós com áudio real.
5. **Arquivos sem integridade** — hash soma (`fileSwarm.ts:41`), sem chunk hash, sem `blake3`, sem cancel. **Ação:** chunk hash blake3 + verificação no `onChunkData`, `FileHave` com bitfield, retomada por `have` Set persistido.
6. **Unread/notificações falsos** — `unreadServers` nunca marcado. **Ação:** ao `MessageNew` se `community_id !== selCommunity` → add unread.
7. **Assets falsos** — `ThemeShell.tsx:1068` botões gift/emoji sem handler, `serverTab canais` `arraste para reordenar (em breve)` texto placeholder.
8. **Import conta expõe privHex** — `public/import-conta.html:24` grava `privHex` em localStorage em claro, `src/services/browser.ts` nunca limpa. **Ação:** usar `vault_export` blob cifrado, não privHex raw.

---

## 6. FUNCIONALIDADES PARCIAIS (🟡) — Funcionam mas incompletas

- **Conta sem senha:** funciona, mas sem opção de adicionar senha depois (vault_change existe `main.rs:143` mas UI só em `ThemeShell:1873` com inputs sem validação de força).
- **DM grupo:** cria local, lista `conversations.kind=group`, mas sem sync.
- **Histórico:** lista 500 msgs mas sem virtualização, sem busca.
- **Voz:** `voice_states` tabela existe (`storage.rs:241`) e broadcast funciona, mas sem speaking detection, sem volume individual.
- **Screen share:** `getDisplayMedia` funciona no browser, mas engine relaya `ScreenShareOffer` sem validar se caller está em voz.
- **File swarm:** anuncia e transfere via base64, mas sem persistência de chunks em SQLite (só memória `fileSwarm.files Map`), perde ao reload.
- **Comunidades:** criar/entrar funciona LAN, mas sem sair/excluir, sem lista de convites, sem expiração visual.
- **Amigos:** fluxo completo, mas sem busca por nickname, só fingerprint hex (UX ruim).

---

## 7. FUNCIONALIDADES FALSAS OU MOCKADAS — Parecem funcionar mas NÃO são reais

| Local | O que parece | Realidade | Prova |
|---|---|---|---|
| `ThemeShell.tsx:1068` | Botões 🎁 😊 no composer | `onClick` inexistente, só ícone | Grep `composer-icon` sem handler |
| `ThemeShell.tsx:1431` | “Arraste para reordenar (em breve)” | Texto sem drag handle | — |
| `ThemeShell.tsx:258` + `models.ts:39` | 3 modos Normal/Encrypted/Tor com descrições técnicas detalhadas | Nenhuma flag afeta `discovery.rs` ou `transport.rs` | `grep privacy engine.rs` vazio |
| `fileSwarm.ts:42` | `hash = soma*31` exibido como `hash.slice(0,8)` | Não é blake3, colisões triviais | — |
| `callManager.ts:114` | `leave()` com `const parts = cid.split('-')` comentário “mas id pode ter hífen” | Código morto, sem uso | Lint warning `parts` unused |
| `ThemeShell.tsx:858` | Barra “Voz conectada • X na voz” | `voiceStates` vêm do SQLite mas `speaking` sempre false (`storage.rs:804 speaking=0`) | — |
| `public/import-conta.html:10` | “Simular o outro peer” com privHex | Expõe chave privada em HTML público | — |
| `src/services/browser.ts:216 messageSend` | Erro “sem rede no modo navegador — mensagens não podem ser enviadas” | Correto (honesto) mas UI não diferencia, botão Send ainda ativo | — |

**Nenhum `TODO/FIXME/mock/fake` literal fora node_modules** (`bash grep` seção 7 retornou 0) — mocks foram removidos em `CHANGELOG.md:34`, mas **lógica mock persists via fallbacks silenciosos**.

---

## 8. P2P — Estado Atual e Arquitetura Necessária

### Atual (verificado)
```
SIGNALING: Não há signaling WebSocket. Handshake TCP direto com Hello/HelloAck/HelloOk (transport.rs:192). Discovery via UDP broadcast (discovery.rs:44). Conexão manual via `connect_addr` (main.rs:309).

MENSAGENS: P2P direto cifrado (ChaCha20Poly1305 por sessão). Sem servidor. Outbox flush. ACK criptográfico. Verificado por 2 nós reais (integration.rs).

ARQUIVOS: P2P via mesmo canal TCP cifrado (SecureFrame::File*), anunciado para `online_peer_fps()` (engine.rs:678). NÃO é WebRTC DataChannel. Sem chunk hash. Sem multi-fonte real (apenas round-robin 4 chunks, fileSwarm.ts:104).

VOZ: Arquitetura híbrida: sinalização via canal TCP cifrado (CallOffer/Answer/Ice) + mídia via WebRTC mesh (RTCPeerConnection, callManager.ts:211) com STUN único. Sem TURN, sem SFU. Nonce mídia não é e2e além do TLS do WebRTC (DTLS).

VÍDEO: Mesmo mesh WebRTC, via `getUserMedia({video:true})`. Sem simulcast.

SCREEN SHARE: `getDisplayMedia` → `replaceTrack` + renegociação por `callOffer` loop (callManager.ts:184). Cada peer flooda para todos (mesh).
```

### Necessário (para “P2P real internet” conforme AUX_SERVICES.md:16)
- **Rendezvous**: Kademlia DHT ou libp2p rendezvous para peers que nunca se viram (hoje só LAN broadcast).
- **NAT traversal**: DCUtR hole-punching + STUN (`coturn` self-host) para descobrir IP público, + **TURN** como último recurso (relay cifrado).
- **DataChannel**: Migrar arquivos para WebRTC DataChannel (SCTP) separado da mídia, com congestion control, ou manter TCP mas com chunking 1MiB `MAX_FRAME` → fragmentação.
- **Relay circuit-v2**: Quando hole-punch falha (~10-20% NAT duplo), relay com estado `RELAYED` (hoje não existe).
- **Multi-peer cleanup**: `links: HashMap<fp, PeerLink>` com eleição determinística (my_fp < peer_fp prefere outbound) já existe (`engine.rs:872`) — bom, mas sem teste de 3+ peers simultâneos.

---

## 9. ARQUIVOS — Estado e Necessário

**Atual:** `fileSwarm.ts:6 CHUNK=256KB`, `shareFile` lê `File.arrayBuffer()`, calcula `chunks=Math.ceil(size/CHUNK)`, hash soma, anuncia `FileAnnounce` para todos online, `fetchSwarm` pede até 4 chunks round-robin, `onChunkRequest` responde `FileChunkData` base64. Storage `files(file_id,name,size,chunks,hash,owner_fp)` (storage.rs:232) só guarda anúncio, **não guarda chunks**. Progress bar real (`progress = have.size/chunks`).

**Problemas:**
- `data_b64` em JSON + base64 → overhead 33% + frame 1MiB limite → chunk 256KB base64 ≈ 341KB JSON → cabe, mas ineficiente, sem backpressure.
- Sem hash por chunk → receptor não verifica integridade.
- Sem `FileHave` broadcast → peers não sabem quem tem o quê sem pedir.
- `assembleAndDownload` só junta em memória → arquivo grande (>100MiB) estoura RAM no WebView.
- Offline peer não semeia (correto), mas `seeders Set` só em memória → perde ao reload.

**Necessário:**
- `files` + `file_chunks(file_id,idx,hash,have)` + `file_peers` com bitfield.
- `blake3` por chunk + hash raiz no `FileAnnounce`, verificação em `onChunkData` (`fromB64`→`blake3`==expected).
- `FileHave` com `indices:Vec<u32>` broadcast ao completar chunk (já existe `SecureFrame::FileHave` mas nunca enviado `engine.rs:1184` comentário).
- Streaming download com `URL.createObjectURL` por partes + `IndexedDB` para chunks, não `Blob` único em RAM.
- Cancel/pause via `Bye` + `dequeue_outbox` por file_id, retomada por `have` persistido em SQLite.
- Limite banda + `traffic_obfuscation` (padding) quando `privacy=full`.

---

## 10. VOZ — Estado e Necessário

**Atual:** `voice_states` tabela real, `VoiceJoin/Leave/State` broadcast para membros da comunidade (`engine.rs:634`), `VoiceJoined` etc eventos → UI barra verde. Mídia: `callManager.joinVoice` faz `getUserMedia({audio:true})` e cria `CallState` local, mas **não cria RTCPeerConnection por membro do canal** — só para DM calls (`createPC`). Voz em canal hoje é **estado sem áudio inter-peer** fora de `callInvite` DM. Mute/deafen toggla track.enabled (`callManager.ts:130`) e envia `VoiceState`.

**Necessário:**
- Ao `voice_join`, criar mesh RTCPeerConnection para cada `voice_states` do canal (como `callManager.start` faz para DM), não só guardar estado.
- STUN configurável + TURN `coturn` com credenciais efêmeras (AUX_SERVICES.md:24).
- Speaking detection via `RTCRtpReceiver.getStats()` ou `AnalyserNode` + `speaking` flag já existe mas nunca setado.
- Volume individual via `HTMLMediaElement.volume`, selector de dispositivos via `enumerateDevices`.
- Reconexão ICE restart (`iceConnectionState` failed → `restartIce`).
- Teste 2 nós com áudio real (headless `aplay` + `arecord`).

---

## 11. VÍDEO — Estado e Necessário

**Atual:** `toggleCamera` (callManager.ts:145) stop/addTrack + `replaceTrack` + não renegocia (comentário “else pc.addTrack” mas sem offer). Sem grid UI, sem múltiplos `<video>` além de `participants[].stream` não renderizado (ThemeShell nunca cria `<video>` element para remote streams — só guarda stream no estado).

**Necessário:**
- Renderizar `participants[].stream` em grid (`<video autoPlay playsInline>` attach via `srcObject`).
- Renegociação completa para addTrack (offer/answer loop já existe em toggleScreen mas não em toggleCamera).
- VP8/VP9/AV1 codec negotiation, simulcast para >4 peers, SFU leve no Host (ROADMAP F15 SFU >6).
- Tratamento erro `NotAllowedError`, `NotFoundError`, `OverconstrainedError`.

---

## 12. COMPARTILHAMENTO DE TELA — Estado e Necessário

**Atual:** `toggleScreen` (callManager.ts:168) `getDisplayMedia({video:true,audio:true})` → `screenStream`, `replaceTrack` para cada PC + renegociação + `track.onended`. Sinalização via `CallOffer` com `sdp` JSON. Sem preview, sem selector nativo além do picker do browser. `ScreenShareOffer/Answer` SecureFrames existem (`protocol.rs:184`) mas nunca usados (callManager usa CallOffer).

**Necessário:**
- Usar `ScreenShareOffer/Answer` dedicados, não reutilizar `CallOffer`.
- Preview antes de “Compartilhar” (Tauri `media` permission).
- Transmissão real testada: screen track deve ser `contentHint="detail"` + `degradationPreference`.
- Estado correto: `sharing` bool → UI indica “Você está compartilhando” + botão Parar que todos veem.
- Tauri APIs `navigator.mediaDevices.getDisplayMedia` já funciona no WebView, mas precisa `capabilities: ["core:default", "desktop:allow-*"]` (hoje só `core:default`).

---

## 13. INFRAESTRUTURA — Problemas

| Área | Estado | Problema | Evidência |
|---|---|---|---|
| Docker | ⚪ | Sem Dockerfile/Compose | `ls` não tem |
| Proxy reverso | ⚪ | Sem nginx/caddy | — |
| HTTPS/WSS | 🔴 | App usa `http://localhost:5173` dev + TCP raw prod, não WSS; CSP `connect-src 'self' ipc: http://ipc.localhost` (tauri.conf.json:25) sem wss | — |
| Variáveis env | 🟡 | Só `CARGO_PKG_VERSION`, sem `.env` | — |
| CORS | 🟢 | CSP restritivo ok | — |
| DB persistência | 🟢 | `app_data_dir/forge.db` WAL ok, `host` usa caminho `--db` | main.rs:42 |
| Logs | 🟡 | `tracing_subscriber` `info,forge_core=info` (main.rs:818) mas sem rotação, sem `logs/` | — |
| Monitoramento | ⚪ | Sem métricas, sem healthcheck | — |
| CI | ⚪ | Sem GitHub Actions (ROADMAP F6) | — |
| Instaladores | 🟢 | `npm run tauri:build` gera deb 2.1.1, mas só `targets: ["deb"]` (tauri.conf.json:34) sem msi/dmg/rpm/appimage | — |
| WebSocket Upgrade | ⚪ | Não usado (TCP puro) | — |
| Bundle size | 🟢 | `dist/assets/index-CgK5sQdv.js 337KB gzip 99KB` ok | build log |

---

## 14. TESTES NECESSÁRIOS — Plano Multi-PC Real

### 14.1 Já existem (24 testes, todos verdes em 2026-08-31)
- `cargo test` 16 unit (identity, protocol, storage, vault) + 4 integration DM + 4 friends (ver seção 19).

### 14.2 Faltam — por categoria

**P0 — Quebra funcional real:**
1. **3 nós mesh** (`engine.rs` eleição): A,B,C dois a dois conectados, A envia DM para C via B offline? Deve falhar (sem roteamento) — documentar limitação vs relay futuro.
2. **Grupo DM sync** — A cria grupo [B,C], B deve ver `GroupInvite` e aparecer em `conversations`. Hoje não.
3. **Canal texto multi-PC** — Host A cria `comunidade geral`, B entra via token, A envia `ChannelMsg`, B recebe. Hoje host relay funciona mas sem teste.
4. **Arquivo swarm real** — A share 5MiB (20 chunks), B e C pedem chunks, ambos completam, hash blake3 OK. Teste com `cargo test` + 2 engines.
5. **Voz 2 nós com áudio** — `voice_join` + `callInvite voice` + `getUserMedia` mock + verificação `voice_states`.
6. **Vídeo toggle** — `callManager.toggleCamera` + verificação remote stream `ontrack`.
7. **Screen share** — `getDisplayMedia` mock + SDP renegociação.

**P1 — Infra:**
8. **NAT simulated** — usar `toxiproxy` ou `iptables` para simular NAT simétrico, verificar falha sem TURN vs sucesso com `coturn`.
9. **Proxy reverso** — nginx `stream { server 0.0.0.0:45900 }` + `X-Forwarded-For` (não aplicável a TCP raw, precisa WebSocket).
10. **Desconexão abrupta** — `engine.disconnect_peer` + `PING_TIMEOUT 25s` → peer OFFLINE, outbox PENDING, reconexão backoff 1→15s.
11. **Stress** — 100 msgs simultâneas, 10 arquivos 1MiB concorrentes, CPU/RAM medidos.

**P2 — Segurança:**
12. **Fuzz handshake** — enviar `Hello` com fp≠pub, sig inválida, frame >1MiB → deve rejeitar sem crash.
13. **Rate limit** — 1000 `FriendRequest` em 1s → deve token bucket (hoje sem).
14. **XSS** — body `"<img onerror>"` deve ser escapado na UI (hoje `whiteSpace: pre-wrap` sem sanitize).
15. **Tor mode** — `privacy=full` com `tor` não instalado → deve FAIL CLOSED, não fallback silencioso.

**Como rodar (documentar para implementadora):**
```bash
# 2 processos nativos (recomendado)
cargo test -- --nocapture
npm run build && npm run tauri:build # validar bundle
# 2 PCs LAN
cargo run -p host -- --nick A --db /tmp/a & cargo run -p host -- --nick B --db /tmp/b
# Browser fallback honesto
npm run dev # 2 abas, verificar DISCONNECTED, sem msgs fake
```

### 14.3 Matriz de teste multi-PC (exigida na missão)

| PC | Papel | Teste |
|---|---|---|
| A | Host comunidade `geral` | cria `cid`, convida B via token `make_invite(cid, fp_B)` |
| B | Membro | `join_community(token)` → deve aparecer `CommunityState`, enviar msg canal → A relay → C também recebe |
| C | Membro tardio | entra depois, pede histórico (hoje sem sync vector clock, só mensagens novas) — **NÃO TESTADO**, documentar |

---

## 15. PRIORIDADES — Ordem de implementação (P0 primeiro)

**P0 — Sistema fundamental quebrado (sem isso, demo multi-PC falha):**
1. Privacidade modes efetivos (engine ler kv)
2. Categorias/canais/cargos/bots core (migrar localExtras → SQLite + SecureFrame)
3. Grupo DM sync
4. Arquivos: chunk hash + FileHave + retomada
5. Voz mesh no canal (não só estado)
6. Import conta seguro (vault blob, não privHex)
7. STUN/TURN configurável

**P1 — Funcionalidade principal quebrada:**
- Paginação história, notificações/unread, moderação kick/ban real, permissões bitmask enforce, infra Docker/HTTPS/WSS, rate limit.

**P2 — Importante ausente:**
- Edição/exclusão, reply, reações, busca, menções, presença, avatar/bio, templates comunidade.

**P3-P4 — Complementar:**
- GIF, stickers, markdown, spoiler, fóruns, enquetes, atividade, mobile, SFU.

---

## 16. DETECÇÃO DE FUNCIONALIDADES FALSAS — Lista Consolidada

Ver tabela seção 7 + `bash grep` evidência. **Nenhum TODO/FIXME literal**, mas **9 falsos comportamentais** listados com arquivo:linha. Todos devem ser removidos ou implementados de verdade antes de release.

---

## 17. SEGURANÇA — Auditoria

**Pontos fortes (não quebrar):**
- `identity.rs:90` fingerprint binding + `verify_hello` (transport.rs:277) anti-spoof.
- Transcript assinado por ambos + nonces frescos anti-replay (protocol.rs:123).
- ChaCha20Poly1305 com AAD `forge/frame` e nonce por direção (transport.rs:126).
- `MessageEnvelope` verificação `author_fp==peer_fp` + `verify_with_pubkey` sempre (engine.rs:999).

**Vulnerabilidades / faltas:**
- **Exposição privHex** (`public/import-conta.html:24`, `ThemeShell.tsx:159` prompt import `JSON.parse(payload)`) — nunca logar privHex, usar vault blob.
- **Sem rate limit** — `engine.rs` aceita `FriendRequest`/`Msg` sem limite; `THREAT_MODEL.md:20` admite “Sem rate limit ainda”.
- **Sem validação tamanho/tipo arquivo** — qualquer `File.size` anunciado (engine.rs:675) sem checar, `MAX_FRAME 1MiB` mas arquivo pode ser 1GiB → OOM.
- **XSS potencial** — `m.body` renderizado sem sanitização (`ThemeShell.tsx:1040`), embora React escape por padrão, markdown futuro deve sanitizar.
- **CSC?** — sem CSRF (Tauri IPC não usa cookies), ok.
- **Fallback keyring → SQLite plain** documentado (SECURITY.md:15) mas UI não avisa claramente (“visível na UI” mas só em docs).
- **Token convite em claro no clipboard** — expira em 7 dias mas sem revogação; host deve manter `revoked_tokens` set.

**Recomendações P1:**
- Token bucket por peer (ex: 10 msg/s, 5 friend req/min) via `tokio::time` + `HashMap<fp, Bucket>`.
- Validar `body.len() < 2000` chars, `file.size < 100MiB`, `file.chunks < size/CHUNK+1`.
- CSP já restritivo, manter.
- Nunca logar `secret_hex`, `sig` body (THREAT_MODEL.md:28 já correto).

---

## 18. INFRAESTRUTURA — Recomendações

- `Dockerfile` multi-stage: `rust:1.77` builder + `debian:bookworm-slim` runtime para `forge-host` + `caddy` para `dist`.
- `docker-compose.yml`: `host` + `coturn` (STUN/TURN) + `caddy` (HTTPS + WSS upgrade para futuro WebSocket transport).
- `tauri.conf.json:34` adicionar `rpm`+`appimage` (Linux) + `nsis`/`msi` via CI cross-build (ROADMAP F6).
- `Env`: `FORGE_DATA_DIR`, `FORGE_DISCOVERY_PORT`, `FORGE_LISTEN_PORT`, `STUN_URL`, `TURN_URL`.
- `Health`: `engine.aggregated_state()` exposto via `host stdin status` já existe, adicionar `/healthz` HTTP no host.
- `Logs`: `tracing` com `env_filter` já, adicionar `tracing-appender` rotação diária.

---

## 19. ETAPA FINAL — Contas, Identidade, P2P, Arquivos, Sincronização e Segurança (exigida)

### 19.1 Identidade — sem senha tradicional
- **Criação:** `Keypair::generate()` OsRng (identity.rs:27), `fingerprint_of_pubkey_hex` = `blake3(pubkey_hex)[0..12]` (identity.rs:92) — **NÃO é blake3 de bytes, é de hex string** — funciona mas desvia do PROTOCOL.md que diz `blake3(pubkey)`. Paridade TS (`crypto.ts:16 blake3(pub)`) está correta (bytes), **divergência sutil**: Rust faz `blake3(hex_bytes)`, TS faz `blake3(pub_bytes)` → fingerprints **diferem** se pubkey tiver letras maiúsculas? Na prática `hex::encode` produz lower, TS `toHex` lower, então `pub` bytes vs hex string ainda diferem — **BUG potencial** mas testes não pegam porque não cruzam TS↔Rust fingerprint. **Ação:** alinhar ambos para `blake3(pubkey_bytes)`.
- **Armazenamento local:** `main.rs:173 persist_secret` tenta `keyring::Entry::new("forge-app","identity.secret")`, fallback SQLite `identity.secret` (plain hex). `src/core/storage/identityStore.ts` + `localDriver.ts` para browser.
- **Proteção:** sem senha por padrão → chave em keyring (bom) ou SQLite plain (ruim). `vault.rs` Argon2id só se `password` não vazio em `identity_create` (main.rs:98) — UI nunca passa senha.
- **Persistência:** `Store::open(path)` WAL, `kv identity` + `identity.secret` (storage.rs:305).
- **Perda:** `identity_get` (main.rs:72) se secret não encontrado → **apaga** `identity` e retorna `None` → usuário perde fingerprint sem aviso. **Ação:** não apagar, exigir export.
- **Revogação/multi-device/exposição:** sem revogação, `account_switch` (main.rs:635) importa via `vault_import` mas expõe `AccountSwitch` que salva conta atual como `imported.*` sem cifrar extra.

### 19.2 Transferência para outro computador
- **Mecanismo atual:** `vault_export` (main.rs:543) retorna `{identity, vault_blob hex}` (já cifrado se `vault.on`), `vault_import` (main.rs:559) aceita `identityJson+vault_blob` mas **só se `load_identity().is_none()`** → exige apagar atual. `accounts_list` (main.rs:590) + `account_switch` permite múltiplas contas em `kv imported.*.blob` (20 slots). **Browser:** `import-conta.html` usa `privHex` raw (inseguro). **Falta:** QR code, código temporário, confirmação no dispositivo original, expiração, uso único. **Ação:** implementar `vault_export_qr` com `invite_sign_bytes` temporário (5 min) + `SecureFrame::VaultOffer` via P2P já pareado, não via localStorage.

### 19.3 Três modos de segurança — tabela real

| Funcionalidade | Normal (flags: enc false, tor false, udp true) | Privacidade (encrypted, padrão) | Tor (full) |
|---|---:|---|---|
| **Identidade** | ✅ ed25519 sempre | ✅ | ✅ |
| **Mensagens** | 🔴 plaintext (sem sessão?) — **engine não respeita** `encryption_enabled` → hoje sempre ChaCha | ✅ ChaCha real | 🔴 flag sem efeito, sem SOCKS5 9050 |
| **Arquivos P2P** | 🔴 mesmo canal plaintext (se normal) | 🟡 cifrado mas hash fraco | 🔴 sem padding real |
| **Voz** | 🟡 sem e2e além de DTLS | 🟢 DTLS e2e | 🔴 sem TOR hops |
| **Vídeo** | 🟡 idem | 🟢 | 🔴 |
| **Screen** | 🟡 idem | 🟢 | 🔴 |
| **Sincronização** | ✅ via TCP | ✅ | 🔴 discovery off mas sem TOR |
| **Reconexão** | ✅ backoff 1→15s | ✅ | 🔴 não implementado |
| **Exposição rede** | 🔴 IP + fingerprint plain | 🟡 IP visível, conteúdo cifrado | 🔴 promete anonimato mas não entrega |
| **Erros** | — | — | Deve FAIL CLOSED se tor não disponível |

**Ação:** engine deve `match privacy.mode { "normal" => Session::new_plaintext?, "encrypted" => ChaCha, "full" => { if !tor_ok { Err(FailClosed) } } }` — hoje não existe `new_plaintext`.

### 19.4 Teste Multi-PC (plano para implementadora, não executado aqui)
```
PC A (Host, fp a1b2…): npm run tauri:dev -- --nick Alpha
PC B (Member): npm run tauri:dev -- --nick Beta → connect_addr(A_ip:A_port, expect a1b2)
PC C (Member tardio): idem
Testes:
- A cria comunidade `teste` com `canal geral` → B entra via token, C entra depois
- A,B,C enviam msgs canal simultâneas (3 msgs ao mesmo tempo) → todos devem ver 3, ordem por ts
- B offline, A manda 2 DMs para B, B volta → 2 pending entregues (já testado 2 nós, mas não 3)
- Voz: B join `geral` voz → A vê `VoiceJoined`, C vê também (broadcast)
- Arquivo: A share 2MiB, B e C pedem chunks intercalados (A→C chunk0, B→C chunk1) → C monta e verifica blake3
- Reconexão: matar A, B/C ficam RECONNECTING, reviver A → reconectam sem duplicar msgs
- NAT: colocar B atrás de hotspot 4G, tentar conectar sem TURN → falha documentada
```

### 19.5 Arquivos P2P — sem armazenamento central
- **Atual:** sem central, mas também **sem verificação**. `announce_file` (storage.rs:826) `INSERT OR IGNORE`, `handle_frame FileAnnounce` (engine.rs:1174) só anuncia, não valida `hash` nem `size`. **Necessário:** `hash = blake3(file_bytes)` + `chunk_hashes: Vec<blake3(chunk)>` no `FileAnnounce`, `FileHave` bitfield.

### 19.6 Mensagens e sincronização
- **Hoje:** `MessageEnvelope` id = `blake3(author_fp|conv_id|ts|body|rand)` (protocol.rs:83) → dedupe por id no receptor (`INSERT OR IGNORE` storage.rs:464). `vector clock` prometido em `AUX_SERVICES.md` ainda não existe. **Necessário:** `log_seq` por conv + `last_seen` por peer para “descobrir o que perdeu” ao voltar (ROADMAP F12).

### 19.7 Dados secretos
- **Nunca expor:** `secret_hex`, `vault_blob` em logs (THREAT_MODEL.md:28 correto), mas `import-conta.html` expõe. **Ação:** remover arquivo, usar `vault_export` via QR.

### 19.8 Segurança e anti-brute-force
- **Atual:** sem `rate limiting`, sem `cooldown`, `AUX_SERVICES.md:20` admite. **Ação:** `max 5 friend_request/min por fp`, `max 20 msg/s`, `max 10 connects/min por IP`, `argon2 m=19456` já resistente a brute force de senha, mas fingerprint é 12 hex (48 bits) → enumerável → mitigar com `proof-of-work` futuro ou `invite token` com exp.

### 19.9 Desempenho
- **Não testado** (sem carga). Observar: `cargo test` 1.5s unit, 2.5s integração 2 nós. **Ação:** `cargo bench` ou `k6` para 10k msgs, `valgrind` para RAM.

---

## 20. TESTES NECESSÁRIOS — Checklist Final

- [ ] P0: 3 nós mesh DM + canal + arquivo + voz (ver 14.2)
- [ ] P0: Import conta seguro (sem privHex)
- [ ] P0: Privacidade modes afetam rede (teste `privacy_set` → `discovery` off)
- [ ] P0: Arquivo 5MiB e2e com blake3
- [ ] P1: Rate limit fuzz + XSS + frame 1MiB+1
- [ ] P1: Paginação 1000 msgs (`list_messages limit 500 offset`)
- [ ] P1: Docker compose + coturn + caddy HTTPS/WSS
- [ ] P2: Edição/exclusão/busca/menções
- [ ] P2: E2E Playwright 3 browsers: `npm run dev` 2 abas + Tauri
- [ ] P3: Medição latência/banda/CPU com `tracing` spans

---

## 21. PRIORIDADES — Resumo P0→P4

**P0 = sistema fundamental quebrado (impede demo multi-PC honesta):**
Privacidade modes, categorias/canais/cargos core, grupo sync, arquivo hash, voz mesh, import seguro, STUN/TURN.

**P1 = funcionalidade principal quebrada:**
Paginação, notificações, moderação, permissões enforce, Docker/WSS, rate limit.

**P2 = importante ausente:**
Edição, reply, reações, busca, presença, avatar.

**P3-P4 = complementar:**
GIF, spoiler, fóruns, enquetes, mobile.

---

# PROMPT PARA IA IMPLEMENTADORA — Executar AGORA (extremamente detalhado)

> **Você é a IA IMPLEMENTADORA do FORGE/DisTorrent v2.1.1.** Você recebeu o arquivo `PLANO_E_PROMPT_IMPLEMENTACAO.md` acima (este arquivo). **Sua missão é IMPLEMENTAR E CORRIGIR TUDO, sem mocks, sem botões falsos, testando de verdade.** Você NÃO é auditora — você altera código, cria arquivos, roda testes, corrige até ficar verde. Leia este prompt inteiro antes de tocar em qualquer arquivo.

## Regras de Ouro
1. **Leia toda a auditoria acima + todos os arquivos citados** (`ARCHITECTURE.md:1`, `PROTOCOL.md:1`, `THREAT_MODEL.md:1`, `src-tauri/src/main.rs:1`, `forge-core/src/net/engine.rs:1`, `storage.rs:1`, `protocol.rs:1`, `transport.rs:1`, `discovery.rs:1`, `src/designs/ThemeShell.tsx:1`, `src/services/*.ts`, `src/core/*`) **antes de alterar**. Não assuma—verifique em disco.
2. **Preserve o que é REAL.** Não apague `forge-core` crypto, não quebre testes existentes (`cargo test` 24 verdes). Todo P0 deve manter `cargo test` verde + `npm run typecheck && lint && build` verde.
3. **Não use mocks como solução final.** Botão sem handler deve ser removido ou implementado de verdade. `setTimeout simulando` é proibido. `fallback localExtras` só pode permanecer se for fallback honesto documentado, não como persistência primária.
4. **Não introduza senha tradicional como obrigação.** A identidade é `ed25519` sem senha por padrão (ThemeShell:109). Você pode **adicionar** opção de senha (vault), mas não pode exigir senha para criar conta.
5. **Implemente os 3 modos Normal/Privacidade/Tor de verdade** (ver seção 19.3). Se Tor não disponível, **FAIL CLOSED** com mensagem honesta, não fingir.
6. **Ordem obrigatória: P0 → P1 → P2 → P3.** Não pule P0 para fazer GIF.
7. **Teste cada implementação** (frontend + backend + integração + multi-usuário). Não marque como feito sem teste.

## Passo 0 — Preparação (sem código ainda)
- Rode `cargo test --manifest-path forge-core/Cargo.toml` (deve dar 24 verdes, referência 16+4+4) e `npm run typecheck && npm run lint && npm run build` (warnings ok, 0 errors). Salve logs.
- Liste `git status` (se houver) e faça checkpoint branch `implement/p0-fixes`.

## Passo 1 — Corrigir P0 (fundamentos) — detalhe arquivo a arquivo

### 1.1 Privacidade modes efetivos
- **Arquivos:** `src-tauri/src/main.rs:446` (PrivacySettings::from_mode), `forge-core/src/net/engine.rs:699 run_engine` e `start_with_discovery`, `forge-core/src/net/discovery.rs:44`, `src/services/models.ts:39`, `src/designs/ThemeShell.tsx:1886`.
- **Mudança:** No `NetworkEngine::new` adicione `privacy_mode: Arc<Mutex<String>>` lido do `Store::kv_get("privacy.mode")`. Em `run_engine`, se `mode=="full"` e `tor_proxy` false positivo mas sem SOCKS5, retorne `ForgeError::Protocol("Tor indisponível — conecte ao daemon na porta 9050")` e emita `EngineEvent::Error`. Se `mode=="full"` desabilite `Discovery::spawn` (udp_discovery false). Se `mode=="normal"` crie `Session::new_plaintext` (sem ChaCha) — **adicione `enum SessionKind { Plain, ChaCha }` em `transport.rs:93`**. Atualize `main.rs:505 privacy_set` para também notificar engine via `engine.set_privacy(mode)` (novo método) sem restart.
- **Teste:** `cargo test` novo `privacy_mode_affects_discovery` + manual: `services.privacySet('full')` → `discovery` deve parar (verificar `listen` sem peers).

### 1.2 Categorias/canais/cargos/bots core (sai de localStorage)
- **Arquivos:** `forge-core/src/storage.rs:190 channels` + `community_members`, `src/services/localExtras.ts:1`, `src/services/tauri.ts:160`, `forge-core/src/protocol.rs:143 SecureFrame`, `forge-core/src/net/engine.rs:634`.
- **Mudança:** Migration `v4` em `storage.rs:46 migrate`: `ALTER TABLE channels ADD COLUMN category TEXT DEFAULT 'GERAL', topic TEXT, kind TEXT CHECK(kind IN('text','voice'))`, `CREATE TABLE roles(id TEXT PK, community_id TEXT, name TEXT, color TEXT, permissions INTEGER, hoist BOOLEAN, mentionable BOOLEAN, position INTEGER)`, `CREATE TABLE bots(id TEXT PK, ...)`, `CREATE TABLE member_roles(community_id TEXT, fp TEXT, role_id TEXT, PK(...))`. Adicione `Store::create_channel`, `delete_channel`, `list_roles`, etc. Crie `SecureFrame::ChannelCreate { community_id, name, category, kind, topic }`, `ChannelDelete`, `RoleCreate/Update/Delete`, `BotCreate` etc. Em `engine.rs handle_frame` valide `comm.owner_fp == peer_fp || has_perm(MANAGE_CHANNELS)` via `role_permissions`. Atualize `tauri.ts:160` para **não** cair para `LX.*` quando core suportar — remova `catch(()=>LX)`. `ThemeShell.tsx:758` já chama `services.channelCreate` — deve passar a funcionar P2P.
- **Teste:** 2 engines: A cria canal `voz` kind voice, B vê `channel_created` evento e `list_channels` inclui.

### 1.3 Grupo DM sync
- **Arquivos:** `storage.rs:717 create_group_dm`, `engine.rs:551 create_group`, `protocol.rs:143`, `src/services/browser.ts:281`.
- **Mudança:** Novo `SecureFrame::GroupInvite { group_id, title, members: Vec<String> }` + `GroupInviteAccept`. Em `engine.rs:551`, após `create_group_dm`, para cada `member fp` com `link_tx` online, envie `GroupInvite` com lista completa. Receptor em `handle_frame` cria `Conversation` id determinístico? Não — grupo id é random (h com now_ms), então receptor deve `store.create_group_dm_with_id(group_id, members, title)`. Adicione `store.insert_group_conversation_with_id`.
- **Teste:** A cria grupo [B], B recebe evento e `conversations` contém grupo.

### 1.4 Arquivos swarm com integridade
- **Arquivos:** `src/services/fileSwarm.ts:36`, `forge-core/src/storage.rs:232 files`, `protocol.rs:179 File*`, `engine.rs:674`.
- **Mudança:** Em `fileSwarm.ts:41` troque `hash = toHex(blake3(buf)).slice(0,16)` (usar `@noble/hashes/blake3` já importado em crypto). Adicione `chunkHashes: string[]` calculados `blake3(chunk).slice(0,16)`. `FileAnnounce` deve levar `chunk_hashes: Vec<String>`. `onChunkData` deve `blake3(fromB64(data)) == chunk_hashes[index]` senão rejeita. Persistir `have` em `Store::files` + `file_chunks` table. `engine.rs:1184 FileHave` deve ser enviado ao completar chunk. `fileSwarm.ts:104 fetchSwarm` manter round-robin mas usar `seeders` reais de `FileHave`.
- **Teste:** A share 1MiB (4 chunks), B pede, verifica hash ok + `assembleAndDownload` gera Blob idêntico.

### 1.5 Voz mesh no canal + STUN/TURN configurável
- **Arquivos:** `callManager.ts:1`, `engine.rs:634 voice_join`, `storage.rs:241 voice_states`, `AUX_SERVICES.md:20`.
- **Mudança:** `callManager.joinVoice` deve após `voiceJoin` criar `RTCPeerConnection` para cada `voice_states` do canal (usar `services.voiceStates`). STUN array deve vir de `Store::kv_get("stun.urls")` (default `stun.l.google.com:19302`), TURN de `kv("turn.urls")` com credenciais. Adicione `Store::set_voice_speaking` via `AnalyserNode` (opcional).
- **Teste:** 2 browsers (ou 2 Tauri WebViews) join mesmo canal voz, verificar `voiceStates` 2 entries e `callManager.pcs.size==1`.

### 1.6 Import conta seguro
- **Arquivos:** `main.rs:543 vault_export`, `public/import-conta.html:10`, `src/services/browser.ts`, `ThemeShell.tsx:168 handleImport`.
- **Mudança:** **Delete** `public/import-conta.html` (expõe privHex). Crie UI `Exportar conta` em `ThemeShell` settings: `services.vaultExport()` → mostra `vault_blob` + QR (use `qrcode` lib). `Importar` deve pedir `identityJson` + `vault_blob` (não privHex) e chamar `vault_import`. `account_switch` já existe mas deve exigir `vault_unlock` com senha se `vault.on`.
- **Teste:** Exportar de A, importar em B (nova pasta `--db /tmp/b`), `vault_unlock` com senha funciona, fingerprint igual.

### 1.7 Fingerprint alinhamento TS↔Rust
- **Arquivos:** `identity.rs:92 fingerprint_of_pubkey_hex` vs `crypto.ts:16 fingerprintOf`.
- **Mudança:** Rust deve fazer `blake3(hex::decode(pubkey_hex).unwrap())` não `blake3(pubkey_hex.as_bytes())`. TS já faz `blake3(pub_bytes)`. Atualize Rust e adicione teste cruzado `assert_eq!(fingerprint_of_pubkey_hex(pub_hex), ts_fingerprint(pub_bytes))`.

## Passo 2 — P1 (após P0 verde)
- **Paginação:** `storage.rs:471 list_messages(conv_id, limit, offset)` + `engine.rs:248 messages(conv_id, limit, before_id)` + UI infinite scroll (`ThemeShell.tsx:1015`).
- **Notificações/unread:** ao `EngineEvent::MessageNew` se `ev.conv_id !== selConv` → `setUnreadServers(prev.add(community_id))` + `new Notification`.
- **Moderação real:** `store.bans(community_id, fp, until)` + `SecureFrame::Ban` com `member_role` check `BAN_MEMBERS`, `engine.rs:351` já tem `friend_block` como base.
- **Permissões enforce:** `PERMS` bitmask em `roles.permissions`, `store.member_permissions(community_id, fp) -> u32` (OR dos roles), check em `send_channel_message` `if perm & SEND_MESSAGES ==0 => Err`.
- **Infra:** crie `Dockerfile`, `docker-compose.yml` (host + coturn + caddy), `tauri.conf.json:34` add `rpm`, `appimage`, CI `.github/workflows/build.yml` com `cargo test && npm ci && npm run build`.

## Passo 3 — Testes obrigatórios (não pule)
Para cada P0/P1, rode:
```bash
cd forge-core && cargo test -- --nocapture
npm run typecheck && npm run lint && npm run build
# 2 nós manual (mesma máquina)
cargo run -p host -- --nick Alpha --db /tmp/alpha &
sleep 1; cargo run -p host -- --nick Beta --db /tmp/beta
# No Alpha: peers → copia fp Beta → msg "oi"
# Verificar ambos: cargo test + e2e Playwright (se existir)
npx playwright test --project=chromium --reporter=list
```
- **Multi-PC LAN:** Use 2 laptops ou `qemu` + NAT, verifique discovery (`peers` mostra `origin=discovery`).
- **Voz/vídeo:** `npm run tauri:dev` em 2 PCs, `callInvite` voice, verificar `getUserMedia` permit e remote audio.
- **Arquivo:** share 5MiB, verificar swarm `FileHave` + `progress` + `blake3` ok.
- **Tor:** `privacySet('full')` sem tor → deve exibir `error.context = "Tor indisponível"` (EngineEvent::Error), não silencioso.

## Passo 4 — Documentar mudanças
- Atualize `ARCHITECTURE.md:5` tabela “o que é REAL”, `PROTOCOL.md:5` com novos SecureFrames, `CHANGELOG.md` com `## 2.2.0 — P0 fixes`.
- Remova `public/import-conta.html`, adicione `docs/TESTING_MULTI_PC.md` com passos acima.

## Critérios de aceite (não negocie)
- `cargo test` 16+4+4 verdes + novos testes P0 (≥6 novos).
- `npm run build` sem `error`, `dist` <400KB gzip.
- 2 nós localhost: DM ida/volta + channel relay + arquivo 1MiB com hash OK (manual ou teste).
- Nenhum botão sem handler, nenhum `localExtras` como fonte primária, nenhum `privHex` em claro.
- Modos privacidade alteram comportamento real (comprovado por log `tracing::info!("modo ...")` + teste).

## Estilo
- Rust: `cargo fmt`, `clippy -- -W unwrap_used` onde possível, manter `Mutex<Connection>` pattern.
- TS: strict, `noUnusedLocals` warn ok, usar `services` contract (`models.ts:355 ForgeServices`) — não acessar `localStorage` direto fora de `localExtras`.
- Mensagens de erro em pt-BR como hoje (`main.rs:90 "identidade já existe"`).

## Entrega
- Commits separados por P0 item (`feat: privacy modes efetivos`, `feat: canais core`, etc).
- Ao final, gere `AUDIT_FIXES.md` com o que foi corrigido por ID da tabela, e rode `npm run lint && cargo test` logs anexados.

**Comece agora pelo Passo 0. Não gere código falso. Se algo for tecnicamente inviável (ex: Tor sem daemon), documente limitação honesta em `THREAT_MODEL.md` em vez de fingir.**

---

> **FIM DO PLANO_E_PROMPT_IMPLEMENTACAO.md — entregue para IA Implementadora.** Auditoria concluída sem alterar projeto. Total de arquivos lidos: 25 + 3 docs + 2 testes + grep infra. Linhas auditadas ≈ 8000. Prioridades P0=7, P1=6, P2/P3≈20. Custo estimado implementadora: 8-12 dias focados.
