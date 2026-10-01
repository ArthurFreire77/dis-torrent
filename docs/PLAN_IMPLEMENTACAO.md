# Plano de Implementação Completo — Fases 0-21

> Ordem revisada para desbloquear UI mockada primeiro (Design Lab) sem bloquear core P2P.

## FASE 0 — Pesquisa e Arquitetura (1 semana)
Objetivo: validar stack e congelar contratos.
- Tarefas: pesquisa Discord (done), comparativo Tauri/Electron/Flutter/RN, POC libp2p hole-punch, POC SQLite + OPFS, definir tokens.
- Tecnologias: Tauri 2, Vite, libp2p-rs
- Agentes: @arch + @researcher
- Critério: ARCHITECTURE.md aprovado + POC de WebRTC via libp2p funcionando em LAN

## FASE 1 — Fundação do Projeto (1 semana) [PARALELIZÁVEL com F2]
- Monorepo pnpm, app Vite TS strict, eslint/biome, vitest, playwright, cargo workspace core/desktop/host
- Design Lab router + 6 shells vazios + theme provider + mocks (amigos, msgs, comunidades)
- Critério: `pnpm dev` abre Lab e navega entre 6 designs vazios; `pnpm build` + `cargo check` verdes

## FASE 2 — Identidade Criptográfica
- ed25519 keypair, fingerprint blake3, keystore (keyring), mnemonic backup, nickname#short
- Dependência: F1
- Risco: perda de chave → mitigar com export cifrado

## FASE 3 — Armazenamento Local
- SQLite migrations, repos, wa-sqlite+OPFS para web, sync local com Zustand persist
- Paralelizável com F2

## FASE 4 — Protocolo (contratos)
- Tipos TS + Rust: Message, Channel, Community, Invite, Member, Role. Assinatura + vector clock. Sem rede ainda.

## FASE 5 — Comunicação P2P (maior risco)
- libp2p swarm, Kademlia DHT, mDNS, QUIC, WebRTC DCUtR, relay circuit-v2, STUN/TURN self-host
- Teste: 2 nodes atrás de NAT simulado trocam msg

## FASE 6 — Amigos e DMs (primeira feature E2E real)
- Add via fingerprint/QR, solicitação, bloqueio, DM 1:1 E2E (Noise_XX), lista, presença via gossip
- Depende F2-F5

## FASE 7 — Comunidades
- Criar/entrar via convite assinado, metadados, ícone, categorias

## FASE 8 — Canais
- Texto/voz, permissões por overwrite, tópicos, slowmode, welcome

## FASE 9 — Cargos e Permissões
- Role hierarquia, hoist, cor, bitwise Perms, UI de toggles, audit log

## FASE 10 — Sincronização
- Log append-only por canal, pull/push incremental, CRDT LWW

## FASE 11 — Community Host
- Binário Rust daemon, `host --create`, relay, API LAN, systemd service

## FASE 12 — Replicação
- Réplicas secundárias, eleição simples, reconciliação

## FASE 13 — Voz
- Signaling P2P, WebRTC Opus, mute/deaf, speaking ring, SFU leve no Host para >6

## FASE 14 — Vídeo
- VP8/VP9/AV1, tiles, grid, screen share hook

## FASE 15 — Compartilhamento de Tela
- xdg-portal / ScreenCaptureKit / WGC, permissão + preview

## FASE 16 — Notificações
- Desktop tray + OS notification, Android FCM/relé P2P, menções, badge

## FASE 17 — Android
- Capacitor wrapper, foreground service voz, push, share intent

## FASE 18 — Linux/Windows/macOS Polish
- Tauri updater, autostart, deep link `p2p://`, instaladores (.deb/.msi/.dmg)

## FASE 19 — Segurança (contínuo, hardening final)
- Auditoria, fuzz protocol, E2E audit, replay/injection, rate limit

## FASE 20 — Testes
- Unit 80%+, e2e Playwright (DM, canal, voz mock), NAT chaos test, load 10k msgs virtualized

## FASE 21 — Distribuição
- CI/CD, assinatura, site, docs, release beta

---

### Estratégia de Paralelização
- Trilhas: A) Core (F2-F5) B) UI (F1+Designs) C) Host (F11) podem rodar em paralelo após F0.
- F6-F10 sequenciais; F13-F15 paralelas após F5.

### Bloqueios críticos
- F5 bloqueia tudo de rede; mitigar com mocks de transporte em F6.
- Tauri Mobile α bloqueia F17 → fallback Capacitor.
