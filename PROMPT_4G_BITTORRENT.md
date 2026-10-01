# MESTENDA: consertar a conexão P2P em 4G no DisTorrent — BitTorrent de verdade

> **Como usar:** cole o bloco de "--- INÍCIO DO PROMPT ---" até
> "--- FIM DO PROMPT ---" no agente que vai executar. Ele contém o mapa do
> projeto, o diagnóstico verificado com `arquivo:linha`, a ordem de execução e
> o critério de verdade.

---

## --- INÍCIO DO PROMPT ---

# TAREFA: fazer a comunicação P2P funcionar em 4G usando a mecânica real do BitTorrent

O usuário testa em **celular com 4G** e **não conecta**. Em Wi-Fi/Wi-Fi funciona.
Ele pediu explicitamente: *"tent[a] usar o bit torrent sei lá"*.

Não é bug de configuração. É arquitetura. Este documento é o dossiê completo,
verificado linha a linha no código, do **por que o 4G não funciona**, do **por
que a DHT BitTorrent que já existe não salva**, e **o que construir** para que
funcione de verdade.

## 0. O projeto

Repositório: `/home/arthur/Documentos/Discord` (**DisTorrent** v5.3.11).
Tauri v2 (Android arm64 + desktop) + React/TS + motor de rede em Rust.

```
forge-core/src/net/
  engine.rs      7408 linhas — motor: listener TCP, STUN, UPnP, NAT-PMP,
                 announce, hole punch, relay manager, command_loop, handle_frame
  transport.rs   1132 — handshake ed25519 + X25519 + ChaCha20Poly1305
                 (Session = AsyncRead/AsyncWrite genéricos sobre TcpStream)
  dht.rs          153 — DHT mainline BitTorrent (crate `mainline` 2.x) + PEX
  stun.rs         422 — cliente STUN binding RFC 5389 (MAPPED/XOR-MAPPED-ADDRESS)
  natpmp.rs       189 — NAT-PMP RFC 6886 (melhor esforço)
  relay.rs       1560 — RelayBackend: MqttRelay (4 brokers públicos :1883)
                 + MultiRelay + peer_relay.rs (intermediário peer-a-peer)
  discovery.rs    140 — UDP broadcast 45900 + mDNS (só LAN)
  mdns.rs         193 — DNS-SD `_distorrent._tcp.local.`
src-tauri/src/lib.rs   ponte Tauri; `run()` = desktop (liga DHT),
                       `run_mobile()` = Android (NÃO liga DHT — BUG 3.1)
host/src/main.rs        forge-host: tracker HTTP self-hosted (--bootstrap PORTA)
```

Comandos de validação (rápidos, rodam sem travar a máquina):

```bash
npx tsc -b                    # hoje: exit 0
npx eslint .                  # hoje: exit 0, 1 warning
cd forge-core && cargo test   # LENTO — avise antes de rodar
```

Testes de rede real (precisam de internet, ~10s cada) — estes são os que valem:

```bash
cd forge-core
FORGE_DHT=1 cargo test --test dht_connectivity -- --ignored --nocapture
FORGE_DHT=1 cargo test --test dht_bit_e2e     -- --ignored --nocapture
```
**Verificado agora por mim:** ambos passam. A DHT está viva e alcança a rede
mainline (`DHT: 20 peers em 1.6s`; rendezvous entre dois motores reais entrega
o endpoint do outro em ~10.6s). **A rede BitTorrent funciona. O que não funciona
é o que o app faz com o resultado dela.** Leia isso de novo antes de codedar:
o problema NÃO é a DHT, é o que acontece depois dela.

## 1. Por que 4G não conecta — a física, sem nameof

Operadora móvel usa **CGNAT** (Carrier-Grade NAT, RFC 6598, faixa
100.64.0.0/10). Cada assinante sai por um IP público **compartilhado com
milhares de outros assinantes**. Consequências, em ordem de gravidade:

1. **UPnP não existe** — o gateway que responde SSDP é do fabricante da
   operadora, não seu, e não abre porta. `nat_map_port` (`engine.rs:3763`)
   sempre cai em `Err` aqui.
2. **NAT-PMP idem** — `natpmp.rs` fala com o gateway padrão; atrás do CGNAT o
   gateway é a CPE da operadora que não responde RFC 6886.
3. **O seu "IP externo" via UPnP é o IP do CGNAT compartilhado.** Mesmo que
   abrir fosse possível, o inbound é para o bloco inteiro da operadora.
4. **Não existe porta externa real para o seu TCP.** É este o ponto que quebra
   o motor inteiro hoje (ver BUG 1).
5. **Torrent funciona em 4G porque NÃO depende de inbound TCP.** BitTorrent
   usa **µTP sobre UDP** e faz **hole punching UDP** — dois peers atrás de
   CGNAT enviam pacotes um para o outro em horário marcado; o CGNAT, ao ver
   tráfego saindo para o endereço do outro assinante, **abre o pinhole de
   volta**. O NAT é permissivo *para quem já saiu*. TCP não tem essa
   propriedade: o `SYN` de entrada para uma porta que o CGNAT nunca mapeou é
   descartado antes de qualquer estado de conexão. **Este é o coração do
   problema: o app usa TCP e tenta furar um buraco que TCP não fura em CGNAT.**

Regra de ouro do BitTorrent que o app ignora: **o transporte de dados é UDP, e o
endpoint anunciado no DHT é o endpoint UDP, o mesmo que o DHT usa.** O app
anuncia um endpoint **TCP** num DHT **UDP** e tenta conectar por TCP.

## 2. Diagnóstico verificado (arquivo:linha) — cada item foi lido no código

### BUG 1 (GRAVE, causa-raiz do 4G) — o STUN devolve porta **UDP** e o app usa como alvo de furo **TCP**

- `forge-core/src/net/stun.rs:244` — `UdpSocket::bind(bind)` numa porta
  efêmera, envia Binding Request, e devolve o `XOR-MAPPED-ADDRESS` que é o
  mapeamento **UDP**. O próprio cabeçalho do arquivo (`stun.rs:10-13`) admite:
  *"STUN sobre UDP revela o mapeamento UDP do NAT"*.
- `forge-core/src/net/engine.rs:4043-4057` — esse endereço UDP vira `announced`,
  e em `engine.rs:4100-4103` é gravado em `engine.public_addr`.
- `forge-core/src/net/engine.rs:5737-5748` — `spawn_punch_upgrade` lê
  `public_addr` (ou consulta STUN de novo) e coloca em `SecureFrame::Punch { endpoint }`.
- `forge-core/src/net/engine.rs:5859-5877` → `transport.rs:456-477` —
  `punch_dial` faz `TcpSocket::connect(remote)`: **um TCP connect para a porta
  que o NAT mapeou para UDP**.

Consequência: sob CGNAT, o `Punch` aponta para uma porta TCP onde nada escuta.
O hole punching **nunca** tem sucesso em 4G — e ainda polui o anúncio MQTT com
um endpoint falso. **Isto sozinha já mataria o 4G mesmo se o resto estivesse
perfeito.**

### BUG 2 (GRAVE) — a DHT anuncia a porta **TCP interna efêmera**

- `forge-core/src/net/dht.rs:129-131`:
  ```rust
  let port = engine.listen_port();          // porta TCP INTERNA efêmera
  let r = ...bit_dht_announce(own, port)
  ```
- `engine.rs:3922-3923` — `listen_port` é a porta do `TcpListener` ligado em
  `0.0.0.0:0` (`engine.rs:3915-3921`). É efêmera e interna.
- `mainline-2/src/dht.rs:191-209` — `announce_peer(ih, Some(port))` publica
  exatamente essa porta, junto com o IP público que o nó remoto vê. Os nós
  passam a devolver `ip_cgnat:porta_interna`.

Consequência: `get_peers` devolve endereços que **nunca** respondem. Mesmo o
`dht_bit_e2e` passando (ele só verifica que o endpoint *chegou*, não que o
dial funciona — o próprio comentário em `tests/dht_bit_e2e.rs:8-9` admite:
*"em double-CGNAT nem o BitTorrent conecta sem relay/punch"*).

### BUG 3 (GRAVE) — **não existe transporte UDP de dados.** Nenhum.

Verificado por varredura: os únicos `UdpSocket::bind` em `forge-core/src/net/`
são `discovery.rs:50` (broadcast LAN), `natpmp.rs:35,134` (controle),
`stun.rs:244` (consulta), `transport.rs:491` (probe). **Nenhum socket UDP
escuta, aceita e transporta dados de sessão.**

- `forge-core/src/net/transport.rs:205-210` — `Session` é
  `Box<dyn AsyncRead> + Box<dyn AsyncWrite>` sobre **TcpStream**
  (`transport.rs:563-564`, `693-694`). A abstração já está correta
  (genérica!) — falta **uma implementação UDP** para alimentar.
- `forge-core/src/net/transport.rs:485-506` — `udp_punch_probe` manda 3
  datagramas `"FORGE-PUNCH1"` para a porta **TCP** do peer. **Não há socket UDP
  escutando em lugar nenhum** que os receba. O comentário
  (*"abre um pinhole UDP"*) é **falso**: um datagrama UDP enviado **para** o
  mapeamento do outro peer abre pinhole **no NAT do remetente**, e o
  receptor precisa de um socket UDP na mesma porta para responder. Não há.
- `grep -rn "utp|µTP|quic" forge-core/src` → só um comentário em
  `engine.rs:5819`. Zero implementação.

**Isto é a lacuna que separa "P2P que só funciona na LAN" de "P2P que funciona
em 4G".** Sem transporte UDP não há BitTorrent — nem de verdade, nem de
mentira.

### BUG 4 (GRAVE) — `MqttRelay::poll` rouba mensagens entre tópicos

- `forge-core/src/net/relay.rs:228-236` — `MqttState` tem **um** `inbox: Vec<String>`
  e **um** `subscribed: Option<String>` para a perna inteira.
- `relay.rs:403-404` — `let out = std::mem::take(&mut st.inbox);` **sem filtrar
  por tópico**.
- Consequência: existem dois tópicos vivos ao mesmo tempo —
  `relay_topic(fp) = distorrent_r_<fp>` (plano de dados, `relay.rs:39-41`) e
  `announce_topic(fp) = distorrent_a_<fp>` (descoberta, `relay.rs:46-48`).
  O poll do relay (`engine.rs:5226`) e o poll do anúncio
  (`engine.rs:4132`, `engine.rs:5660`) disputam o **mesmo buffer** e
  **descartam os frames um do outro**. `subscribed: Option<String>` único
  (`relay.rs:379-402`) ainda força resubscribe a cada alternância de tópico.
- Isto mata silenciosamente handshakes relay e `Punch` — exatamente os frames
  que o 4G depende. **Barato de consertar, altíssimo impacto.**

### BUG 5 — QoS0 + `clean_session(true)` = frame perdido para sempre

- `relay.rs:355-364` — `publish(..., QoS::AtMostOnce, ...)`.
- `relay.rs:267` — `opts.set_clean_session(true)`.
- `relay.rs:243` — `client_id` **aleatório** por boot
  (`forge-{host}-{rand}`), então o broker não retém nada entre sessões.

Publicar com assinante offline = **mensagem descartada pelo broker, sem
retenção**. No 4G o celular dorme, o app é congelado pelo Android, a conexão
morre — e o frame que ia destravar a conexão é perdido. Somado ao BUG 4, é a
combinação que produz "às vezes funciona, às vezes não", sem padrão.

### BUG 6 — `FORGE_DHT` **não** é ligado no Android

- `src-tauri/src/lib.rs:2872-2883`:
  ```rust
  #[cfg_attr(mobile, tauri::mobile_entry_point)]
  pub fn run_mobile() { main(); }        // ← NÃO seta FORGE_DHT

  pub fn run() {
      std::env::set_var("FORGE_DHT", "1");   // ← só desktop
      main();
  }
  ```
- `forge-core/src/net/dht.rs:67-86` — `bit_dht_enabled()` exige `FORGE_DHT=1`.

**No APK Android a DHT BitTorrent está DESLIGADA.** O usuário pediu
"bit torrent" e no celular ele nem está rodando. Corrigir isto é uma linha.

### BUG 7 — Sem relay em 4G quando a direta morre

- `engine.rs:4160-4173` e `4219-4224` — o relay é ligado, mas só como
  *fallback*; e ele depende de 4 brokers MQTT públicos **anônimos em :1883**
  (`relay.rs:449-456`), sem TLS, sem auth, sem retenção (BUG 5), com o BUG 4.
- `FORGE_BOOTSTRAP_URL` (tracker HTTP self-hosted) é **vazio por padrão**
  (`engine.rs:3950-3955`). E o valor de exemplo no `.env.example:11`
  (`https://forge-bootstrap.fly.dev`) está **morto — NXDOMAIN** (verificado).
- `AUX_SERVICES.md:24` promete **TURN** como último recurso. Não existe em
  lugar nenhum do `forge-core` (verificado: `grep turn|coturn` em
  `forge-core/src` → zero). Só existe em `src/services/callManager.ts:116-149`
  para o WebRTC do navegador, com um TURN público cujo segredo está
  hardcoded no app (`callManager.ts:117`).

### BUG 8 — Vazamento de memória no diagnóstico

- `forge-core/src/net/engine.rs:865-873`:
  ```rust
  if map.len() > 512 {
      map.retain(|_, _| true);   // no-op: predicate constante true
  }
  ```
  O comentário admite (*"no-op future"*). `peer_diag` cresce sem limite em app
  de longa duração. Correção de uma linha: reter os 512 mais recentes por
  `last_seen`.

### BUG 9 — A UI mente sobre estar conectado

- `src/designs/ThemeShell.tsx:995` e `src/mobile/MobileShell.tsx:686`:
  ```ts
  const online = state === 'CONNECTED' || (listening && state === 'DISCONNECTED')
  ```
  → pilha **verde "ONLINE"** com 0 peers alcançáveis, só porque o listener
  está bound. No celular com 4G isso é **exatamente o sintoma que o usuário
  relata**: "parece que tu se conecta de qualquer maneira".
- `src/services/browser.ts:465` — devolve `state:'CONNECTED'` hardcoded.
- `README.md:56-57` afirma *"Conexão pela internet é automática (UPnP +
  bootstrap pelo fingerprint)"* — **falso em 4G**. O README é suspeito, não a
  palavra do usuário.

## 3. O que construir — a ordem que faz 4G funcionar

### Fase 1 — Correções cirúrgicas (baratas, destravam o resto). Faça primeiro.

1. **BUG 6**: `run_mobile()` seta `FORGE_DHT=1`. Uma linha. Sem isso nada de
   BitTorrent no celular.
2. **BUG 4**: `MqttState.inbox` vira `HashMap<String, Vec<String>>` (por
   tópico) e `subscribed: Option<String>` vira `HashSet<String>`. Só devolve o
   que é do tópico pedido. **Não quebre a `RelayBackend` trait** — só a
   implementação interna do `MqttRelay`.
3. **BUG 5**: `QoS::AtLeastOnce` no publish do relay + `set_clean_session(false)`
   + `client_id` **estável por identidade** (`forge-{fingerprint[:12]}`, não
   rand). Isso dá retenção no broker: frame publicado com assinante offline é
   entregue quando ele volta.
4. **BUG 2**: `dht.rs:129` para de anunciar `engine.listen_port()`. Passe o
   **endpoint externo real** (resultado do STUN, ver Fase 2) e cache-o. Se não
   houver endpoint externo conhecido, **não anuncie** — anunciar porta interna
   é pior que não anunciar (gera dials ischemados que poluem o diagnóstico).
5. **BUG 8**: `retain` de verdade, mantendo os 512 mais recentes.
6. **BUG 9**: pilha verde só com ≥1 peer `Online` real. Separe "nó no ar" de
   "peers alcançáveis" no texto e no `ConnectionDiagnostics`.

**Entrega da Fase 1**: `cargo test` verde + `dht_bit_e2e` verde + honestidade
de UI. Não avance sem isso.

### Fase 2 — Transporte UDP de dados (o degrau que realmente leva ao 4G)

Esta é a peça que não existe e que separa "não conecta" de "conecta".

**Por que UDP e não só "melhorar o TCP":** em CGNAT, inbound TCP para porta não
mapeada é descartado pelo equipamento **antes** de o SO do peer ver qualquer
coisa. Nenhum ajuste de timeout, NAT-PMP ou SYN timing resolve. O que resolve é
o UDP hole punching: o pinhole é aberto pelo **tráfego de saída** que o NAT já
vê, e a resposta chega porque o NAT é "permite o que foi initiator".

**Escopo (não é reescrever tudo — a abstração já está pronta):**

- `transport.rs:205-210` — `Session { read: Box<dyn AsyncRead>, write: Box<dyn AsyncWrite> }`.
  Crie `struct UdpSession { sock: Arc<UdpSocket>, peer: SocketAddr, ... }` que
  implemente `AsyncRead`/`AsyncWrite` (buffer de saída acumulado, socket
  compartilhado entre read e write — `Arc<UdpSocket>` + mpsc interno, ou
  `try_clone`). Handshake, HKDF, ChaCha20Poly1305, nonce, AAD, transcript
  **são reusados sem alteração** — é a mesma sessão criptográfica, só muda o
  carrier. **Não mexa no protocolo.**
- Quadro: `[u16 len][payload]` dentro de cada datagrama (o framing de stream
  TCP de `write_frame`/`read_frame` em `transport.rs:71-95` é reaproveitado
  como framing de datagrama). Datagrama perdido = sessão cai no heartbeat
  (`PROTOCOL.md:16`) e reconecta — aceitável e **o outbox já é append-only e
  reenvia** (`PROTOCOL.md:38`), então a semântica de entrega é preservada.
- **µTP é desnecessário.** µTP existe para *controle de congestionamento* em
  cima de UDP no BitTorrent clássico. Aqui o tráfego é chat — poucos KB, sem
  bulk transfer síncrono. Datagrama + reenvio por outbox/ACK já basta e é
  ordens de grandeza mais simples. Se quiser ALGO parecido depois, é otimização,
  não pré-requisito. **Não deixe o µTP bloquear a entrega.**
- **Servidor UDP escutando** — isto mata o BUG 3 e faz o `udp_punch_probe`
  (`transport.rs:485`) virar verdade em vez de decorativo.
- **Punho coordenado:** o frame `Punch` já existe no protocolo
  (`protocol.rs:180`) com `endpoint`, `at_ms`, `nonce`, e o loop agressivo de
  reenvio já está em `spawn_punch_upgrade` (`engine.rs:5692-5787`). O que
  muda: `endpoint` passa a ser **o endpoint UDP real** (mesmo socket do DHT), e
  o `punch_dial` passa a ser **UDP send dos dois lados no instante `at_ms`**.

### Fase 3 — Torne o announce coerente com o transporte UDP

Um endpoint, uma identidade, um socket:

1. **Um único socket UDP** serve DHT (`mainline`) + dados de sessão + resposta
   ao `udp_punch_probe`. É exatamente o que o BitTorrent faz: **uma porta para
   DHT e para µTP**. Hoje `mainline` abre o seu próprio socket em 6881 ou
   efêmero (`mainline-2/src/rpc/socket.rs:41-45`) e o app não tem socket nenhum
   para dados.
2. `stun_external_addr()` (`stun.rs:239-257`) passa a ser consultado **sobre
   esse socket** (não um socket descartável novo), e o resultado é o
   **único** endpoint anunciado: DHT, MQTT, `Punch` e tracker HTTP.
3. Reancuncie a **cada troca de rede** e a cada ~60s, como torrent faz.
4. Só anuncie endpoint **externo confirmado** (STUN ok, ou porta externa
   mapeada por UPnP/NAT-PMP). Nunca anuncie a interna. Nunca anuncie UDP
   como se fosse TCP (BUG 1).

**Essa é a mudança conceitual central: hoje o app anuncia três endpoints que
nunca concordam entre si (DHT = TCP interno, MQTT = UDP do STUN, `Punch` = UDP
do STUN usado como TCP). Make them one.**

### Fase 4 — Relay como último degrau (e honesto)

- Ordem de fallback, explícita e **diagnosticável**:
  `LAN (UDP+mDNS) → direta via DHT/anúncio → hole punch UDP → relay`.
- O relay MQTT existe e funciona; consertado pelos BUGs 4 e 5 ele é aceitável
  como degrau 4. Mas **não é TURN**: não aloca portas, não faz furo, não tem
  QoS de mídia. Não o venda como tal.
- `AUX_SERVICES.md:24` promete TURN. Ou implemente, ou **corrija o doc** para
  dizer a verdade. Promessa que não existe é pior que ausência.
- Se o usuário quiser 4G **sem** nenhum servidor de terceiros, isso é decisão
  dele, não sua: com CGNAT e **sem UDP hole punching e sem relay**, não há
  caminho. Diga isso com todas as letras.

## 4. Prova — sem evidência não é consertado

O README diz *"O que é REAL (verificado por testes automatizados)"*
(`README.md:10`). **Não acredite no README** — o usuário testou em 4G e não
funciona. Testes que hoje **não provam** nada de rede real:

- `tests/punch_e2e.rs` usa `set_public_addr("127.0.0.1:{port}")` + `MemRelay`.
  Prova a mecânica do `Punch`, **não** NAT. E em loopback o endpoint errado do
  BUG 1 "funciona" — **o teste mascara o bug**.
- `tests/relay_e2e.rs`, `direct_norelay_traffic.rs`, `e2e_two_users.rs`,
  `ten_nodes_stress.rs` — `MemRelay` + `127.0.0.1`. **Nenhum byte sai da
  máquina.**
- `tests/relay_mqtt_e2e.rs` — rede real, mas `FORGE_NO_ANNOUNCE=1` **da mesma
  LAN**. Não reproduz CGNAT.
- `tests/dht_bit_e2e.rs` e `dht_connectivity.rs` — `#[ignore]`, rede real.
  **Estes dois passaram comigo agora** e provam que a DHT está viva. Não
  provam que o dial funciona.

**Exija, antes de dizer que terminou:**

1. **Teste de CGNAT simulado** — dois peers atrás de NATs que **recusam
   qualquer mapping** (sem UPnP, sem NAT-PMP), relay desligado. O único
   caminho que pode fechar sessão é o hole punch UDP. Medir tempo até `Online`
   e taxa de entrega de DM. **Este é o teste que prova 4G.**
2. **Teste de inconsistência de porta** — force `ext_port != port_interna` e
   verifique que o endpoint anunciado é o **externo**. Falha se announcing a
   interna (BUG 2).
3. **Teste do inbox por tópico** — dois tópicos, N publishes em cada, prove que
   `poll(t1)` devolve **só** t1 e `poll(t2)` **só** t2 (BUG 4).
4. **Guarde-os rodando por padrão** (`cargo test`, sem `--ignored`). Se um teste
   de rede real for lento, marque `#[ignore]` mas **com o motivo escrito** e
   liste-o no README como "exige internet".
5. **Manual, com 2 dispositivos:** documento passo a passo como reproduzir
   4G (celular no modo avião + 4G, app nos dois, ou tethered). Se você não pode
   testar 4G de verdade, **diga isso explicitamente** em vez de afirmar que
   está consertado.

## 5. Regras inegociáveis

1. **Correção mínima e cirúrgica.** `engine.rs` e `lib.rs` são enormes e
   functioning. Não refatore o que não está quebrado. O handshake
   criptográfico **não se toca** — o mesmo AEAD em TCP e UDP é o que mantém a
   propriedade E2E.
2. **Nunca anuncie endpoint não confirmado.** É a regra que, sozinha, impede a
   maior classe de dials inúteis e deixa o diagnóstico honesto.
3. **Honestidade de estado é requisito de produto.** O README promete "estados
   verdadeiros". Nunca troque um estado real por um otimista fixo. Se o motor
   não sobe, a UI tem que dizer que não sobe.
4. **Não escreva comentários óbvios.** Comentário só para explicar um *por
   quê* não-óbvio. (O próprio repo já peca: `engine.rs:872` tem um no-op com
   comentário dizendo que é no-op.)
5. **Toda correção precisa de evidência:** teste, log, print, ou explicação
   mechanism-level de por que o sintoma some. Se não conseguir reproduzir o
   4G, **diga**.
6. **Português** nas mensagens de status, inglês no código (padrão do repo).
7. **Avise antes de rodar** `npm run build`, `cargo build`, `cargo test`,
   `npx playwright test`. O usuário está na máquina.

## 6. Como reportar

A cada fase, direto e sem enfeite:

- O que foi **corrigido** + evidência (`arquivo:linha`, teste, log).
- O que **não** foi corrigido e **por quê** (bloqueio de arquitetura, decisão
  pendente, falta de hardware).
- O que **não pôde ser verificado** ("não tenho como testar 4G real aqui; o
  teste simulado X cobre Y").
- Se alguma "correção" apenas **esconde** o sintoma (ex.: deixar a UI mostrar
  OFFLINE em vez de consertar a conexão), diga com todas as letras. O usuário
  prefere a verdade a um placebo.

Não diga "pronto" para o que não testou. Este projeto já tem histórico de
feature declarada "REAL (verificado por testes automatizados)" que o usuário
informa não funcionar.

--- FIM DO PROMPT ---

---

## Notas para o Arthur (não vão no prompt)

- **Verifiquei nesta sessão, com execução real:** `tsc -b` exit 0;
  `dht_connectivity` (20 peers em 1.6s) e `dht_bit_e2e` (rendezvous em 10.6s)
  passam; os 4 brokers MQTT em `:1883` estão alcançáveis **desta** máquina;
  `forge-bootstrap.fly.dev` (o tracker do `.env.example`) está **NXDOMAIN**.
- **A DHT BitTorrent não é o problema.** Ela funciona. O problema é que o app
  anuncia a porta **TCP interna** nela (`dht.rs:129`) e **não tem transporte UDP
  nenhum**. BitTorrent funciona em 4G por causa de UDP hole punching; o app é
  TCP-only e nunca vai furar CGNAT assim.
- **O conserto de maior impacto por linha é BUG 4** (inbox do `MqttRelay` por
  tópico). O de maior impacto conceitual é a Fase 2 (transporte UDP).
- **Decisão sua, não do agente:** se você quer 4G com zero servidor de terceiros
  e sem relay, o caminho é UDP hole punching (Fases 1–3) e funciona na maioria
  dos CGNATs, mas **não é garantido** — NAT simétrico duplo ainda falha, e aí
  só relay salva. Ninguém pode prometer o quê. Se quiser garantia, precisa de
  um TURN seu (VPS barato resolve).
