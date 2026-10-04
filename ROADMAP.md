# ROADMAP

Cada fase só é marcada como FEITA quando testada/executável de verdade (não "a UI existe").

- [x] **Design FORGE congelado** (UI aprovada; tokens em `DESIGN_SYSTEM.md`)
- [x] **F2 — Identidade real** (ed25519 + fingerprint blake3; keyring do SO; onboarding)
- [x] **F3 — Storage real** (SQLite WAL bundled; repos no core; UI nunca acessa storage)
- [x] **F4 — P2P real LAN** (discovery UDP + handshake autenticado + sessão cifrada + heartbeat/reconnect)
- [x] **F5 — Mensagens reais DM** (assinadas, ACK de entrega, outbox pós-reconexão, estados SENDING/SENT/DELIVERED/PENDING)
- [ ] **F6 — Instaladores por CI** (GitHub Actions: deb/rpm/AppImage, msi, dmg; logs + crash handling)
- [ ] **F7 — Community Host headless** (binário `host/` usando forge-core: init/start/status/invite/peers/backup)
- [ ] **F8 — Comunidades reais** (Community ID, owner, canais, categorias; schema v2)
- [ ] **F9 — Permissões no core** (owner/admin/mod/member; toda operação validada pelo motor, nunca pela UI)
- [ ] **F10 — Convites** (token assinado com expiração e revogação; sem segredo permanente em URL)
- [ ] **F11 — Amigos/bloqueio** (solicitação assinada; lista real)
- [ ] **F12 — Sincronização** (vector clock por log append-only assinado; "descobrir o que perdeu" ao voltar)
- [ ] **F13 — Replicação** (Host + réplicas; autoridade do dono; resolução de conflito documentada)
- [ ] **F14 — Internet P2P** (rendezvous/DHT + hole-punching; ver AUX_SERVICES.md)
- [ ] **F15 — Voz/vídeo P2P** (WebRTC; mute/deaf/volume/screen share; TURN opcional)
- [ ] **F16 — Android** (Tauri 2 mobile; notificações, permissões, background, reconexão)
- [ ] **F17 — Distribuição** (GitHub Releases com binários; site oficial depois)
