# DisTorrent

**Comunicação P2P descentralizada, local-first e cifrada fim-a-fim.**

Sem servidor central. Sem cadastro. Sem e-mail. Sem telefone. A identidade é um
par de chaves ed25519 que vive no seu dispositivo — não existe conta para criar
nem senha para esquecer.

```
┌─ React 18 + TypeScript ──────────────────────────────────────┐
│  UI desktop (ThemeShell) + mobile (MobileShell), markdown     │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌─ Tauri 2 ────────────────────────────────────────────────────┐
│  commands IPC · keyring do SO · cofre com senha (Argon2id)  │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌─ forge-core (Rust puro, sem UI) ─────────────────────────────┐
│  identidade · protocolo · SQLite · DHT · relay · STUN/TUN    │
│  tunnel virtual · voz nativa (Linux) · criptografia         │
└──────────────────────────────────────────────────────────────┘
```

---

## O que é real (verificado por testes automatizados)

- **Identidade local estável** — par ed25519 gerado no primeiro uso; fingerprint
  = `blake3(pubkey)[..12]`, **imutável**, sobrevive a reinícios, exportação e
  troca de dispositivo. Chave privada no keyring do SO, ou em cofre com senha
  (Argon2id + ChaCha20Poly1305).
- **P2P direto pela internet** — TCP autenticado (transcript ed25519 + X25519
  efêmero + HKDF-SHA256 → ChaCha20Poly1305), UPnP/NAT-PMP automático, STUN +
  hole punching, DHT (mainline) e relay próprio. LAN via UDP broadcast + mDNS.
- **Mensagens diretas e em grupo** — ACK criptográfico de entrega, outbox
  persistente (pendente → enviado → entregue), paginação por janela, sincronização
  de grupo na reconexão.
- **Amigos** — pedido → aceite → recusa → remover → bloquear, tudo em frames
  assinados. Offline fica enfileirado e sai ao reconectar.
- **Servidores (comunidades)** — criar/entrar por convite assinado com expiração;
  canais de texto e voz; categorias; cargos com permissões; bots com token; kick.
  Persistido em SQLite (schema v8) e sincronizado do dono para os membros.
- **Chamadas de voz e vídeo** — WebRTC. No Linux há um plano de mídia nativo em
  Rust (`webrtc-rs` + Opus + cpal + AEC) porque o WebKitGTK não expõe
  `RTCPeerConnection`. SDP e ICE trickle são padrão, então um peer Linux conversa
  com um peer Windows/Android/macOS sem tradutor.
- **Compartilhamento de tela** — multi-monitor, com captura nativa no Linux
  (X11/portal) e `getDisplayMedia` no navegador nas outras plataformas.
- **Arquivos em swarm** — chunks de 256 KB, hash blake3, todos os peers semeiam.
- **Privacidade com 4 modos reais** — sem segurança / Seguro (E2E) / Seguro +
  (SOCKS5, desliga announce e discovery) / Tor (7 saltos).
- **Estados verdadeiros** — `CONECTADO / CONECTANDO / RECONECTANDO / OFFLINE` e
  `pendente → enviando → enviado → entregue`. Nada de texto fixo ou spinner eterno.

O modo navegador (`npm run dev`) é **honestamente sem rede P2P**: identidade
ed25519 e mensagens entre abas via `BroadcastChannel`, mas o estado de rede mostra
`DISCONNECTED` de verdade. Para a rede P2P real, use o app nativo.

---

## Requisitos

| Ferramenta | Versão | Para quê |
|---|---|---|
| **Node.js** | 20+ | build do frontend, Vite, testes |
| **Rust** | 1.77+ | `forge-core`, `src-tauri`, `host` |
| **Linux** | Ubuntu 24.04+ (recomendado) | WebKitGTK 4.1 |
| **Android SDK + NDK** | opcional | só para build Android |

Dependências de sistema no Linux (Debian/Ubuntu):

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  libasound2-dev pkg-config cmake build-essential
```

No macOS: `xcode-select --install`. No Windows: Rust via `rustup` e as
dependências do WebView2 (o instalador NSIS as baixa).

---

## Instalação

```bash
git clone <url-do-repo> distorrent
cd distorrent
npm install
```

Não existe `.env` obrigatório — o app roda 100% em LAN e offline sem nenhum.

---

## Executar

### Modo navegador (desenvolvimento de UI)

```bash
npm run dev        # http://localhost:5173
```

Sem rede P2P — por desenho, para não simular o que não existe.

### App nativo (motor P2P real)

```bash
npm run tauri:dev      # Linux / Windows / macOS
```

### Builds

```bash
npm run build          # typecheck + bundle do frontend em dist/
npm run tauri:build    # .deb + .AppImage (Linux), .msi/.exe (Windows)
```

Saída em `src-tauri/target/release/bundle/`. Instaladores **não** são versionados
— publique como GitHub Release.

### Descoberta pela internet

Na mesma rede nada disso é necessário: UDP broadcast e mDNS já acham os peers.
Para redes diferentes existem quatro caminhos, todos **automáticos**:

1. **UPnP / NAT-PMP** — o app abre a porta no roteador sozinho
2. **STUN + hole punching** — descobre o IP público e atravessa NAT comum
3. **DHT (mainline)** — acha peers que nunca se viram, sem servidor próprio
4. **Relay** — fallback quando o hole punching falha (vê IPs e volume, nunca
   conteúdo, porque o tráfego já está cifrado E2E)

O tracker HTTP (`FORGE_BOOTSTRAP_URL`) é **opcional e auto-hospedável** — sem
ele, announce e lookup por tracker ficam desligados e nada acima para de funcionar.

### Community Host (tracker bootstrap, opcional)

```bash
npm run host -- --bootstrap 8090
FORGE_BOOTSTRAP_URL=http://seu-vps:8090 npm run tauri:dev
```

### Android

Requer o SDK Android e o NDK. O linker do Rust para cross-compilar é específico
de cada máquina, então existe um template:

```bash
cp .cargo/config.toml.example .cargo/config.toml
# edite os caminhos do NDK no .cargo/config.toml
npx tauri android init      # só na primeira vez
npx tauri android build --apk --target aarch64
```

Para assinar, exporte as credenciais do **seu** keystore (nunca versione):

```bash
export TAURI_ANDROID_KEYSTORE_PATH="$HOME/caminho/para/seu-keystore.jks"
export TAURI_ANDROID_KEYSTORE_PASSWORD='sua-senha'
export TAURI_ANDROID_KEY_ALIAS='alias'
export TAURI_ANDROID_KEY_PASSWORD='sua-senha'
```

> `.gitignore` bloqueia `*.jks`, `*.keystore` e `android-keystore/`. Se você não
> tem um, gere com `keytool` e guarde fora do repositório.

---

## Variáveis de ambiente

Todas opcionais. Veja [`.env.example`](.env.example) com comentários.

| Variável | Padrão | Efeito |
|---|---|---|
| `FORGE_BOOTSTRAP_URL` | *(vazio)* | Tracker HTTP. Aceita lista separada por vírgula |
| `FORGE_PROXY_ADDR` | `127.0.0.1:1080` | SOCKS5 para o modo "Seguro +" |
| `FORGE_TOR_ADDR` | `127.0.0.1:9050` | SOCKS5 do Tor para o modo "Tor" |
| `FORGE_PORT` | aleatória | Porta TCP de escuta |
| `FORGE_DISCOVERY_BROADCASTS` | — | Broadcasts extras de discovery (VPN/ZeroTier) |
| `FORGE_NO_RELAY` / `FORGE_NO_TUNNEL` / `FORGE_NO_ANNOUNCE` / `FORGE_NO_DHT` | `0` | Kill-switches de feature |
| `FORGE_NO_NATIVE_VOICE` | `0` | Força o WebRTC do navegador no lugar da voz nativa |
| `RUST_LOG` | `info` | Filtro de log |

---

## Testes

```bash
npm run typecheck        # tsc
npm run lint             # eslint
npm run test:unit        # node:test
npm run build            # typecheck + vite build
npm run test:rust        # forge-core: 33 suítes, 150 testes unitários
npm run test:rust:clippy # clippy com -D warnings
npm run test:e2e         # Playwright (17 specs)
```

`test:rust` roda o crate inteiro, incluindo E2E de 2 usuários completos através de
um proxy TCP simulando redes distintas: amizade, DM, grupo, comunidade com convite
assinado, canais, cargos, kick, queda de rede e reconexão.

Os testes multi-engine que dependem de portas distintas às vezes colidem em
`51413` quando o binário roda em paralelo — é uma limitação conhecida do design
de teste, não do produto.

CI (`.github/workflows/ci.yml`) roda web + `forge-core` + `host` + build do
`.deb` em cada push.

---

## Estrutura

```
.
├── src/                  Frontend React (ThemeShell desktop + MobileShell)
│   ├── services/         Acesso a dados: browser (BroadcastChannel) | tauri (invoke)
│   ├── designs/          Shell desktop
│   ├── mobile/           Shell mobile
│   ├── components/       social/ · server/ · vault/ · dev/
│   ├── app/              Hooks que ligam UI ↔ services
│   ├── core/             crypto, sanitização, nomes, storage driver
│   └── shared/           UI compartilhada, markdown, ícones
│
├── forge-core/           MOTOR RUST PURO (sem UI, sem Tauri)
│   ├── src/              identity, protocol, storage, vault, stormvault,
│   │                     names, antispam, moderation, social, metrics, cache
│   │   └── net/          engine, transport, discovery, mdns, stun, natpmp,
│   │                     dht, relay, peer_relay, vtunnel, socks5, media_*
│   └── tests/            33 suítes de integração e E2E
│
├── src-tauri/            Casca Tauri 2 (commands IPC, keyring, cofre)
│   ├── gen/android/      Scaffold Android (gerado por `tauri android init`)
│   └── capabilities/     Permissões do frontend
│
├── host/                 Community Host headless (tracker bootstrap)
├── aec-probe/            Sonde do cancelamento de eco
│
├── tests/                Testes unitários (node:test)
├── e2e/                  Testes Playwright
├── docs/                 Specs da camada de segurança, StormVault, AEC
│
├── .cargo/               config.toml.example (o config.toml é local)
├── ARCHITECTURE.md       Camadas e decisões que não devem ser revertidas
├── PROTOCOL.md           Frames, handshake, sessão
├── THREAT_MODEL.md       Ameaças e limitações honestas
├── SECURITY.md           Política de reporte e escopo
├── EXECUTAR.md           Guia de instalação detalhado
└── CHANGELOG.md          Histórico de versões
```

Aproximadamente 29 mil linhas de TypeScript e 33 mil de Rust.

---

## Segurança e limitações honestas

E2E por design nas conversas. Não há senha nem e-mail — pseudonimidade por chave.
O que **não** está resolvido, documentado em [`THREAT_MODEL.md`](THREAT_MODEL.md):

- O IP é visível ao peer com quem você conversa.
- O modo Tor protege o transporte, mas não cobre WebRTC/STUN — uma chamada
  faz STUN direto para o servidor de STUN, potencialmente associado ao IP real.
  Para chamada com Tor, é preciso TURN via Tor.
- Sem fallback de áudio pelo túnel P2P: se o ICE não fechar atrás de CGNAT
  simétrico duplo, a chamada **encerra com aviso** em vez de degradar para um
  caminho pior. Dois peers assim só fecham via TURN.
- Sem assinatura de código para Windows/macOS e sem chave de distribuição
  verificável — o `.deb`/`.AppImage` não têm assinatura.

Reporte vulnerabilidades: [`SECURITY.md`](SECURITY.md).

---

## Como contribuir

1. Fork + branch (`feat/...` ou `fix/...`).
2. Antes do PR:
   ```bash
   npm run typecheck && npm run lint && npm run test:unit && npm run build
   npm run test:rust && npm run test:rust:clippy
   ```
3. Descreva o que é **real** no que você fez, e o que ainda não é.

As regras do projeto (critério "REAL", design congelado, autorização no core,
crypto só de biblioteca) estão em [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## Licença

[MIT](LICENSE).