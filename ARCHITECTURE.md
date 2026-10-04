# ARCHITECTURE — arquitetura do motor

> **FORGE é o Design System oficial e congelado.** `src/designs/ThemeShell.tsx` + `src/shared/icons.tsx` são imutáveis visualmente (cores, tipografia, espaçamento, ícones SVG, layout). Toda a evolução do produto acontece embaixo da UI.

## 1. Estado atual — o que é REAL (verificado por testes)

| Componente | Status | Verificação |
|---|---|---|
| **Identidade ed25519** | REAL | `forge-core/src/identity.rs` — 4 unit tests |
| **Mensagens assinadas** (blake3 transcript) | REAL | `protocol.rs::MessageEnvelope::verify_with_pubkey` — anti-tamper testado |
| **Storage SQLite** (WAL, bundled) | REAL | `storage.rs` — 4 unit tests; app: `app_data_dir/forge.db` |
| **P2P: handshake autenticado** (ed25519 + X25519 efêmero + ChaCha20Poly1305) | REAL | 2 nós reais em TCP localhost — `tests/integration.rs` |
| **P2P: discovery LAN** (UDP broadcast 45900) | REAL | anúncio assinável, anti-spoof de fingerprint |
| **Estados de conexão** CONNECTED/CONNECTING/RECONNECTING/DISCONNECTED | REAL | máquina de estados por peer + agregada, heartbeat 10s, timeout 25s, backoff 1s→15s |
| **Estados de mensagem** PENDING/SENDING/SENT/DELIVERED/FAILED | REAL | ACK criptográfico real; outbox persistente reenvia após reconexão — testado |
| **Keyring do SO** para chave privada | REAL (fallback SQLite documentado) | `src-tauri/src/main.rs::persist_secret` |
| **UI FORGE ligada ao motor** | REAL | `services → hooks → ThemeShell`; `mocks.ts` DELETADO |
| App desktop instalável | REAL | `npm run tauri:build` (Tauri 2) — `.deb` + `.AppImage` no Linux, `.msi`/NSIS no Windows |
| Android | REAL | `npx tauri android build --apk`; voz nativa é só no Linux, no Android o WebRTC do navegador assume |
| Comunidades / canais / cargos / bots | REAL | `forge-core/src/social.rs` + migrations v4/v6 |
| Voz e vídeo (WebRTC + nativo Linux) | REAL | `net/media_voice.rs` (webrtc-rs + Opus + cpal + AEC) |
| iOS | NÃO é alvo | Não há build iOS neste repositório |

**Critério "REAL":** todo item acima tem teste automatizado rodando ou é verificável em execução. Nada é simulado.

## 2. Princípios (inalterados)

P2P-first, local-first, crypto-first, modular. Nenhum backend central obrigatório. Serviços auxiliares (STUN/TURN/relay/bootstrap) são explícitos, opcionais e auto-hospedáveis — ver `AUX_SERVICES.md`.

## 3. Stack definitiva (implementada)

| Domínio | Escolhido | Motivo |
|---|---|---|
| Shell desktop | **Tauri 2 (Rust)** | WebKitGTK 4.1/soup3 (compila no Ubuntu 24.04); base para mobile |
| **Motor** | **`forge-core` (crate Rust pura)** | Sem dependência de UI/Tauri → reusável pelo Community Host headless e testes |
| Transporte P2P | **tokio TCP + frames length-prefixed** | Base de toda a rede; o envelope é independente do transporte |
| Descoberta | UDP broadcast + mDNS | `net/discovery.rs` |
| Internet | UPnP/NAT-PMP, STUN, hole punching, DHT mainline, relay MQTT | `net/natpmp.rs`, `stun.rs`, `dht.rs`, `relay.rs` |
| Torne virtual | Túnel X25519 com IP `fd9d::/64` derivado do fingerprint | `net/vtunnel.rs` |
| Discovery | **UDP broadcast LAN** | Zero infraestrutura; rendezvous futuro em `AUX_SERVICES.md` |
| Sessão | **X25519 efêmero → HKDF-SHA256 → ChaCha20Poly1305** (nonce por direção) | Primitivas maduras (RustCrypto), composição documentada no threat model |
| Identidade | **ed25519-dalek 2 + blake3** | Fingerprint = `blake3(pubkey)[0..12]` hex — igual no Rust e no TS (noble) |
| Storage | **rusqlite (SQLite bundled, WAL)** | Local-first real; a UI nunca acessa direto |
| UI | React 18 + TS strict + Vite | Intocado (FORGE) |
| Android | Tauri 2 mobile (quando estável p/ nosso conjunto de features) | Capacitor descartado — não abre sockets TCP/UDP reais |

## 4. Topologia de módulos

```
├─ forge-core/            # MOTOR (Rust puro, sem UI)
│  ├─ src/identity.rs     # ed25519, fingerprint, assinatura
│  ├─ src/protocol.rs     # envelope assinado, frames, handshake transcript, session key
│  ├─ src/storage.rs      # SQLite: kv, peers, conversations, messages, outbox
│  ├─ src/net/discovery.rs# UDP broadcast LAN
│  ├─ src/net/transport.rs# TCP frames + handshake + sessão AEAD
│  ├─ src/net/engine.rs   # estado de conexão, heartbeat, reconexão, outbox, eventos
│  └─ tests/integration.rs# 2 nós reais: handshake, DM, ACK, outbox pós-reconexão
├─ src-tauri/             # CASCA (thin shell)
│  ├─ src/main.rs         # commands → engine; eventos engine → WebView; keyring
│  ├─ capabilities/       # permissões Tauri 2 (core:default)
│  └─ tauri.conf.json     # bundle deb/rpm/appimage/msi/dmg
├─ src/                   # UI (FORGE congelado)
│  ├─ services/models.ts  # contrato TS espelhando os tipos do core
│  ├─ services/tauri.ts   # invoke + listen (nativo)
│  ├─ services/browser.ts # fallback honesto: sem rede, estado = DISCONNECTED
│  ├─ app/hooks.ts        # useIdentity, useNetwork, useMessages, useEngineEvents
│  └─ designs/ThemeShell.tsx # FORGE — consome apenas hooks
└─ host/                  # (próxima fase) Community Host binário headless usando forge-core
```

**Regras de dependência (enforçadas por design):**
- UI → services → (IPC) → core. A UI **não** importa nada de rede/storage.
- `forge-core` **não** conhece Tauri/React.
- Todo comando sensível é validado no core; a UI não pode forjar estado.

## 5. Fluxo de mensagem real (implementado)

```
UI composer
  → services.messageSend(conv, body)          [invoke]
  → engine.send_dm()                          [core]
     → MessageEnvelope::new (assina com priv) 
     → SQLite insert (status=sending)
     → peer online?  SIM → frame cifrado → ACK do peer → status=delivered (SQLite + evento)
                     NÃO → outbox (status=pending) → flush automático ao conectar
  → evento MessageStatus/MessageNew → UI atualiza relógio/check/check-check
```

Receptor: decifra → valida `author_fp == peer da conexão` → valida assinatura (pubkey do PeerBook, amarrada por fingerprint no handshake) → valida conv → persiste (status=ok) → evento → UI → ACK.

## 6. Compilação desktop (Linux)

Headers de sistema necessários: `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libayatana-appindicator3-dev` (Ubuntu 24.04: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev`).
> Nesta máquina os headers foram provisoriamente extraídos para `/tmp/opencode/gtk-root` (sem sudo). Para builds locais sem instalar os pacotes:
> `export PKG_CONFIG_PATH=/tmp/opencode/gtk-root/usr/lib/x86_64-linux-gnu/pkgconfig:/tmp/opencode/gtk-root/usr/share/pkgconfig:/tmp/opencode/gtk-root/usr/lib/pkgconfig`

```bash
npm run build && npm run tauri:build   # → src-tauri/target/release/bundle/deb|appimage/rpm
```

Windows/macOS: CI cross-build via GitHub Actions (fase distribuição).

## 7. Migração Tauri 1.6 → 2 (feita)

Motivo: Ubuntu 24.04 removeu `libsoup-2.4`/`webkit2gtk-4.0` — Tauri 1.6 não compila mais em distros atuais. Tauri 2 usa webkit2gtk-4.1 (soup3), é estável e habilita Android/iOS. Mudanças: config schema v2, `capabilities/`, `@tauri-apps/api@2`, `app.path()`, `Emitter::emit`.

## 8. Em aberto

Ver [`ROADMAP.md`](ROADMAP.md) para a lista viva. Resumo do que falta:

1. Instaladores assinados no CI (hoje só o `.deb`/`.AppImage` no Linux)
2. Empacotamento Android assinado em CI (exige keystore em GitHub Secrets)
3. Sincronização com resolução de conflito entre dois donos
4. Rotas de mídia alternativas ao WebRTC (sem fallback de áudio pelo túnel)
5. UI de moderação (o core tem as regras e a auditoria; a tela não foi montada)
