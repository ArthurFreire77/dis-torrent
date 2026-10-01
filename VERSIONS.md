# VERSIONS — DisTorrent / FORGE

## v3.0.0 (2026-09-01) — Hardening total

### Correções incluídas
- 27 bugs corrigidos: 8 Rust core, 3 host, 6 TypeScript, 3 Tauri, 4 segurança, 3 código morto
- Senha mínima 4 → 8 caracteres (OWASP)
- Versão unificada em 3.0.0 (forge-core + src-tauri + host + npm)
- 36/36 testes passando

### Breaking changes
- **Senha mínima 8 caracteres**: senhas com 4-7 caracteres são rejeitadas ao criar cofre

### Como instalar/atualizar

#### App desktop (Tauri)
```bash
cd /home/arthur/Documentos/Discord
git pull
cargo test                    # 36 testes devem passar
npm install                   # dependências JS
npm run build                 # build production
npm run tauri:build           # gerar .deb/.AppImage
# Gerado em: src-tauri/target/release/bundle/
```

#### Modo navegador (dev)
```bash
cd /home/arthur/Documentos/Discord
npm install
npm run dev                   # http://localhost:5173
# Funciona em abas diferentes no mesmo navegador (BroadcastChannel)
```

#### Host headless (tracker bootstrap)
```bash
cd /home/arthur/Documentos/Discord/host
cargo build --release
./target/release/forge-host --bootstrap 8090
# Porta em uso? Use outra: ./target/release/forge-host --bootstrap 8091
```

#### Android
```bash
cd /home/arthur/Documentos/Discord
npm install
npx cap sync android
npx cap open android           # abre no Android Studio
```

### Testes
```bash
# Rust core (36 testes)
cd forge-core && cargo test

# TypeScript (lint + typecheck + build)
npm run lint && npm run typecheck && npm run build

# Tor E2E (requer tor daemon rodando)
cd forge-core && cargo test --test tor_e2e -- --ignored
```

### Notas de upgrade
- Senhas com 4-7 caracteres precisam ser redefinidas (upgrade de segurança)
- Nenhuma migração SQLite necessária
- Settings de privacidade/identidade preservados
- Tokens de convite preservados

---

## Histórico de versões

| Versão | Data | Resumo |
|--------|------|--------|
| 3.0.0 | 2026-09-01 | 27 bugs fixados, zero panic, senha 8+ chars |
| 2.3.0 | 2026-09-01 | Bugfix massivo: panic, segurança, memory leaks |
| 2.2.1 | 2026-08-31 | Tor real, .onion, multi-tracker |
| 2.2.0 | 2026-08-31 | Servidores reais + sync P2P + E2E |
| 2.1.6 | 2026-08-31 | Botão Baixar funcional |
| 0.2.0 | 2026-08-30 | Motor real (forge-core) |
| 0.1.0 | — | Protótipo visual |

---

## Arquitetura

```
forge-core/src/          Rust puro (zero deps UI)
├── identity.rs          ed25519 keypair + fingerprint
├── protocol.rs          SecureFrame, handshake, sessão
├── storage.rs           SQLite WAL (identity, messages, channels, roles, bots)
├── vault.rs             Argon2id + ChaCha20Poly1305
└── net/
    ├── engine.rs        NetworkEngine (2000+ linhas)
    ├── transport.rs     TCP + AEAD session
    ├── discovery.rs     UDP broadcast LAN (45900)
    └── socks5.rs        SOCKS5 client (Tor/proxy)

src-tauri/src/           Bridge Tauri 2
└── lib.rs               Commands IPC → forge-core

src/                     React + TypeScript
├── services/
│   ├── browser.ts       Modo navegador (BroadcastChannel)
│   ├── tauri.ts         Modo nativo (invoke IPC)
│   ├── fileSwarm.ts     BitTorrent-like swarm
│   └── callManager.ts   WebRTC mesh P2P
├── designs/ThemeShell.tsx    UI desktop
├── mobile/MobileShell.tsx    UI mobile
├── shared/utils.tsx          Funções compartilhadas
├── app/use*.ts               Hooks customizados
└── components/Auth.tsx       Login/cadastro

host/                    Host headless (tracker + comunidade)
```
