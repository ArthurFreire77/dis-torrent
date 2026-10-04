# EXECUTAR — DisTorrent

Guia direto para instalar dependências e rodar. Requisitos gerais: **Node 20+** e **Rust 1.77+**.

```bash
npm install          # dependências do frontend
cargo fetch          # (opcional, pré-baixa crates do motor)
```

## 1) Navegador (dev, sem rede P2P — honesto)
```bash
npm run dev          # http://localhost:5173
```
Modo navegador: identidade ed25519 real, mensagens locais entre abas (BroadcastChannel).
O indicador de rede mostra o estado verdadeiro; não há peers falsos.

## 2) App nativo desktop (motor P2P real)

Linux (Ubuntu 24.04+):
```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev libayatana-appindicator3-dev
npm run tauri:dev    # janela nativa com engine TCP + discovery LAN + UPnP + bootstrap
```

Windows/macOS: `npm run tauri:dev` (mesmos comandos; WebView2 no Windows é
embutido pelo instalador NSIS).

## 3) Dois usuários conversando de verdade

**Mesma rede (LAN):** rode o app nativo em 2 máquinas. Em segundos os peers
aparecem em “NA REDE AGORA” (UDP broadcast) e conectam sozinhos. Adicione pelo
fingerprint (Amigos → Adicionar) e converse.

**Redes diferentes (internet):** quatro caminhos, todos automáticos:
1. **UPnP** — o app abre a porta no roteador sozinho (igual torrent);
2. **Tracker bootstrap** — anuncia `ip:porta` e encontra amigos pelo fingerprint;
3. **Rede Tor** — em privacidade "Tor — 7 nós", o app conecta a serviços
   `.onion` (peer publicando um onion service fica alcançável sem IP público
   e sem abrir porta no roteador). Teste real incluso:
   `cd forge-core && cargo test --test tor_e2e -- --ignored --nocapture`;
4. **Manual** — Configurações → Avançado → `ip:porta`, `dominio:porta` ou
   `endereco.onion:80`.

## 3b) LAN virtual estilo Radmin VPN (ZeroTier/Tailscale) — sem VPS

Integração EXTERNA de Radmin/ZeroTier/Tailscale (túnel virtual do SO): cria
uma LAN virtual pela internet — o túnel deles atravessa o CGNAT por você e o
DisTorrent vê os peers como rede local (descoberta + TCP direto, sem hole
punch). Verdade honesta: esses apps usam os servidores deles para o
rendezvous — alguém sempre paga a conta (no Radmin, o produto pago sustenta
o grátis). Radmin é só Windows; no Linux/Android use ZeroTier ou Tailscale.

## 3c) Túnel virtual EMBUTIDO (sem VPS, sem app externo)

Desde a v5.3.x o motor tem um túnel virtual próprio por peer (X25519 efêmero
assinado por ed25519 + datagramas ChaCha20Poly1305 com anti-replay; IP
virtual determinístico `fd9d::<64 bits do blake3(fp)>` — sem servidor de
alocação nos dois lados). O handshake viaja pela SINALIZAÇÃO já existente
(relay/MQTT ou TCP direto). Comportamento:

1. **Sem Tor falhando 3 vezes:** nada muda — direto/relay seguem iguais.
2. **Tor com 3 timeouts seguidos** (`privacy=full`): o motor CAI para o túnel
   (handshake via relay) — `TunnelUp` com IP virtual sobe sem o Tor.
3. **DM, amizade e sinalização de chamada (CallInvite/Accept/Offer/ICE)**
   viajam PELO túnel quando o peer só é alcançável via relay: frames de
   controle levitam cripto de sessão de túnel (não pacote cego de perna),
   com replay-window e fragmentação de at. Frames grandes remontam.
4. **Rekey** por volume (256MB) ou idade (24h) e por `tunnel_rotate()`; ping
   com RTT honesto (`tunnel_ping` → `TunnelPong`).
5. Diagnóstico por peer (`peer_diag`) mostra `tunnel_up`, `virtual_ip` e os
   contadores `tunnel_rx_frames`/`tunnel_tx_frames`. Kill-switch:
   `FORGE_NO_TUNNEL=1` derruba tudo sem afetar direto/relay.

E2E: `cd forge-core && cargo test --test vtunnel_e2e -- --nocapture` — dois
peers só-relay sobem o túnel, trocam ping com RTT, e DM + sinalização de
chamada + frame de 200KB passam INTEIROS pela sessão do túnel.

Passo a passo (ZeroTier, grátis, Linux + Android):
1. Instale o ZeroTier nos dois aparelhos e entre na mesma rede
   (`zerotier-cli join <id>` no PC, app ZeroTier no celular).
2. Autorize os dois membros no painel https://my.zerotier.com.
3. Anote os IPs virtuais (ex. `10.147.0.10` e `10.147.0.11`).
4. No PC, exponha o broadcast da descoberta para a subnet virtual:
   `FORGE_DISCOVERY_BROADCASTS=10.147.0.255:45900 npm run tauri:dev`
   (o broadcast limitado não sai pela rota padrão até o adaptador virtual —
   sem isso os peers não se acham sozinhos).
5. Se a descoberta não achar em ~10s: Configurações → Avançado →
   adicione `10.147.0.11:51413` (IP virtual do outro + porta fixa) — o TCP
   vai direto pelo túnel, sem NAT no caminho.

Tailscale (100.x.y.z) não repassa broadcast: pule o passo 4 e use o passo 5
direto com o IP do outro aparelho.

**Tracker bootstrap self-hosted (1 comando, zero dependência de terceiros):**
```bash
npm run host -- --bootstrap 8090        # no seu VPS público
# nos clientes:
FORGE_BOOTSTRAP_URL=http://seu-vps:8090 npm run tauri:dev
```
Aceita lista de trackers (resiliência): `FORGE_BOOTSTRAP_URL=http://a:8090,http://b:8090`.
Sem tracker configurado, announce/descovery por tracker ficam desligados —
UPnP e endereço manual continuam funcionando.

Prova automatizada (roda em qualquer CI, sem GUI): dois usuários completos
através de um **proxy TCP** simulando redes distintas — amizade, DM, grupo,
comunidade com convite assinado, canais, cargos, kick, queda de rede e
reconexão:
```bash
cd forge-core && cargo test --test e2e_two_users -- --nocapture
```

## 4) Testes completos
```bash
npm run test:rust      # 33 suites: crypto, storage, protocolo, amigos,
                       # canais/cargos/bots e E2E 2-usuários via proxy
npm run typecheck && npm run lint && npm run build
```

## 5) Instaladores
```bash
npm run tauri:build   # → src-tauri/target/release/bundle/ (deb/appimage/msi/nsis/dmg)
```
Instaladores não são versionados no repositório (`.gitignore` bloqueia `*.deb`,
`*.AppImage`, `*.apk`) — gere sempre com o comando acima e publique como GitHub Release.

## 6) Configuração opcional
Veja `.env.example`: bootstrap self-hosted, proxy SOCKS5/Tor (modos
“Seguro +” e “Tor — 7 nós” desligam announce e descoberta LAN automaticamente;
o **relay e o diagnóstico continuam funcionando roteados pelo SOCKS5** — sem
abrir porta e sem vazar o IP real) e nível de log.

## 7) Estrutura
```
forge-core/   motor Rust puro: identidade ed25519, SQLite, rede P2P (TCP
              autenticado + sessão ChaCha20Poly1305), amigos, comunidades,
              canais, cargos, bots, grupos, chamadas (sinalização), arquivos
src-tauri/    casca Tauri 2 (commands IPC, keyring, cofre com senha)
src/          UI React (ThemeShell desktop + MobileShell)
host/         Community Host headless (fase seguinte, usa forge-core)
docs/         arquitetura, protocolo, ameaças e screenshots de auditoria
```
