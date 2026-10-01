# PROMPT DE CORREÇÃO — DisTorrent (copiar e colar inteiro no outro agente)

> **Como usar:** cole o bloco inteiro a partir de "--- INÍCIO DO PROMPT ---" até
> "--- FIM DO PROMPT ---" no agente que vai fazer o trabalho. Ele contém o mapa do
> projeto, os defeitos já mapeados com `arquivo:linha`, as causas-raiz e a ordem de
> execução exigida.

---

## --- INÍCIO DO PROMPT ---

# MESTENDA: consertar o DisTorrent (app P2P) — 4-features quebradas + hardening geral

Você vai trabalhar em um projeto real e **quebrado em produção**. Não é um
exercício: o usuário testa no celular com 4G e nada funciona. Sua missão é fazer
as coisas **funcionarem de verdade**, com evidência de teste — não beautificar,
não reescrever do zero, não mascarar falha com texto "CONECTADO" na UI.

## 0. O que é o projeto

Repositório: `/home/arthur/Documentos/Discord` (projeto **DisTorrent**, versionado
como o pacote npm mas que é um app desktop/mobile).

Comunicação P2P descentralizada, sem servidor central, sem cadastro. Tauri v2
(native) + React 18 + TypeScript (frontend) + Rust (motor de rede).

Mapa de diretórios (leia antes de mexer):

```
src/                     frontend React/TS
  App.tsx                roteia: /d/forge -> ThemeShell (desktop), /m -> MobileShell
  designs/ThemeShell.tsx shell DESKTOP (onde vive 90% dos bugs)
  mobile/MobileShell.tsx shell MOBILE (implementação paralela, geralmente mais correta)
  components/
    vault/StormVaultPanel.tsx   painel de cofre (exportar/importar)
    CallPhaseBadge.tsx          badge de fases da chamada
    ConnectionDiagnostics.tsx   diagnóstico de rede (é honesto — use como referência)
  services/
    callManager.ts       WebRTC: offer/answer/ICE, mídia
    callPhases.ts        máquina de estados das fases
    fileSwarm.ts         swarm de arquivos (chunks 256KB, blake3)
    tauri.ts             invoke() do Rust
    browser.ts           stub para `npm run dev` no navegador
  core/identity/{crypto,identity}.ts   ed25519, fingerprint = blake3(pubkey)[..12]
  core/storage/*.ts                    driver de storage (local/tauri/session)
forge-core/              LIB RUST — a rede de verdade
  src/net/engine.rs      ~7400 linhas, motor: listener TCP, punch, announce, dial
  src/net/transport.rs   handshake ed25519 + X25519 + ChaCha20Poly1305
  src/net/stun.rs        STUN binding (RFC 5389) — NÃO é ICE
  src/net/relay.rs       relay via 4 brokers MQTT públicos :1883
  src/net/upnp*,natpmp.rs  mapeamento de porta
  src/net/dht.rs         DHT mainline BitTorrent (BEP-5)
  src/net/discovery.rs   UDP broadcast 45900 (só LAN)
  src/stormvault.rs      cofre portátil .stormvault (Argon2id + ChaCha20Poly1305 + zstd)
  src/storage.rs         SQLite, collect/merge do cofre
  tests/*.rs             25 suítes (a maioria roda em 127.0.0.1 — não prova rede real)
src-tauri/src/lib.rs     comandos Tauri (a ponte; ~2900 linhas)
src-tauri/capabilities/default.json   permissões (ATENÇÃO: só tem core:default)
src-tauri/tauri.conf.json             config, inclui CSP
host/                    tracker HTTP self-hosted (`--bootstrap PORTA`)
e2e/*.spec.ts            Playwright (roda em modo BROWSER, sem rede P2P real)
```

Comandos (NÃO rode `npm run build` nem `cargo test` sem avisar — são lentos e
travam a máquina; prefira `npx tsc -b` e `npx eslint .` para validação rápida):

```bash
npx tsc -b          # typecheck (atualmente passa, exit 0)
npx eslint .        # lint (atualmente: 1 warning)
cargo test -p forge-core --tests   # só quando o trabalho Rust estiver pronto
npx playwright test              # e2e, roda em modo browser
```

Estado atual verificado: `tsc -b` OK, `eslint` OK (1 warning em
`downloadManager.ts:10` — `DownloadStatus` não usado). O build completo
**não foi verificado** nesta auditoria (estourou o tempo) — então não assuma que
compila; rode você mesmo, com aviso.

## 1. Regras inegociáveis

1. **Não desligue/reinicie nada, não rode comandos longos sem avisar.** O usuário
   está na máquina; `npm run build`, `cargo build`, `cargo test` e
   `npx playwright test` travam tudo. Avise antes.
2. **Correção mínima e cirúrgica.** Não refatore o que não está quebrado.
   `engine.rs` e `lib.rs` são enormes e functioning — mexa só nas linhas citadas.
3. **Toda correção precisa de evidência.** Um teste, um log, um print de tela, ou
   uma explicação do porquê o sintoma some. Se não conseguir reproduzir o 4G nem
   a chamada real, **diga isso explicitamente** em vez de afirmar que está
   consertado.
4. **Honestidade de estado é requisito de produto.** Este app promete "estados
   verdadeiros" no README. Nunca troque um estado real por um estado otimista
   fixo. Se o motor não sobe, a UI tem que dizer que não sobe.
5. **Não escreva comentários óbvios** no código. Comentário só para explicar um
   *por quê* não-óbvio.
6. **Português** nos commits/mensagens de status, inglês no código (padrão
   existente do repo).

## 2. OS 4 BUGS REPORTADOS PELO USUÁRIO (diagnóstico já feito, com causa-raiz)

### BUG 1 — "A pré-visualização de imagens no computador não está funcionando"

**Sintoma:** no app desktop, imagens não aparecem no card da mensagem; fica
preso em "carregando prévia…" ou "prévia: arquivo não encontrado". No celular a
mesma tela funciona. Imagens que **você mesmo enviou** às vezes funcionam.

**Causa-raiz:** `MediaInlinePreview` em `src/designs/ThemeShell.tsx:80-120` é um
"useEffect de tentativa única" cujo `triedRef` (linha 83/91) é marcado **antes** do
swarm conhecer o arquivo. Somado à ordem de execução dos efeitos (o efeito do
**filho** roda antes do efeito do **pai** que registra o arquivo, linha 457), a
primeira tentativa sempre falha para imagens **recebidas**/históricas, e
`fetchOnly` lança "arquivo não encontrado (anúncio ainda não chegou?)" — sem retry.

Defeitos mapeados:

- `ThemeShell.tsx:83,91-92` — `triedRef` trava a tentativa para sempre; o early
  return devolve `undefined` no lugar do cleanup, deixando o efeito morto.
- `ThemeShell.tsx:108` + `:1510` — `onTick` é arrow function nova a cada render do
  pai; ThemeShell re-renderiza sem parar (`setFileList` a cada ~300 ms, linha
  604), o array de deps muda sempre, o cleanup roda e **`URL.revokeObjectURL(made)`
  (linha 107) revoga a URL que o `<img>` ainda está usando** → imagem quebrada
  mesmo quando ela existia. Com `loading="lazy"` (linha 113) fica pior.
- `ThemeShell.tsx:113` — `<img>` sem `onError`, sem `height`/`aspectRatio`/`objectFit`:
  falha silenciosa e o card "salta" de ~40px para 320px ao carregar.
- `ThemeShell.tsx:111` — `<video src={blob:...}>` é **bloqueado pela CSP**:
  `src-tauri/tauri.conf.json:25` define `img-src 'self' data: blob:` mas **não
  define `media-src`**, que cai em `default-src 'self'` (sem `blob:`). Vídeo
  inline nunca carrega no app empacotado. (No browser dev funciona — por isso o
  bug "some" em dev.)
- `fileSwarm.ts:628-632` — `blobFor` só monta se **todos** os chunks estiverem em
  memória; após reiniciar o app o preview depende de reidratação assíncrona do
  spool (`fetchSwarm`, linha 404) → "carregando prévia…" inconsistente.
- `fileSwarm.ts:157-158` vs `MobileShell.tsx:33` — caps divergentes (8 MB
  desktop / 12 MB mobile) para a mesma funcionalidade.
- `ThemeShell.tsx:450` — `const [, setFileList]` descarta o valor: re-renderiza a
  árvore inteira sem ganho de UI.
- Não existe **lightbox/zoom**: a prévia inline é o único ponto de exibição e não
  é clicável para ampliar. Compare com `MobileShell.tsx:184-188, 591-629`, que
  é a implementação boa.

**O que fazer:**
1. Registrar o arquivo no swarm **antes** de o preview tentar (ordenar o registro
   no pai, ou fazer o preview esperar o anúncio `file_announce`,
   `ThemeShell.tsx:679`).
2. Remover `triedRef` como trava permanente — no máximo, um retry com backoff
   curto enquanto o arquivo não aparecer.
3. `onTick` memoizado com `useCallback` no pai (`ThemeShell.tsx:1510`).
4. Revogar object URL **apenas no unmount**, nunca em re-render.
5. `onError` no `<img>` com estado de erro visível; `aspectRatio` reservado para
   não saltar layout.
6. Adicionar `media-src 'self' data: blob:` à CSP em `tauri.conf.json:25`.
7. **Reconciliar desktop e mobile**: extraia o preview para um componente
   compartilhado e use nos dois shells (elimina a divergência de caps de novo).
8. Bônus cheap e perceptível: lightbox ao clicar (o mobile pode servir de base).

---

### BUG 2 — "Não consigo conectar quando estou no celular com 4G"

**Sintoma:** em rede móvel (4G/5G), a conexão P2P nunca completa. No desktop com
Wi-Fi funciona.

**Contexto de rede que você PRECISA entender antes de codar:** operadora móvel usa
**CGNAT** (Carrier-Grade NAT). Cada assinante sai por um IP público compartilhado.
Consequências, em ordem de importância:
- **UPnP e NAT-PMP não funcionam** — o roteador da operadora não é seu.
- Sem servidor de rendezvous confiável + sem retransmissão (TURN/relay), **não há
  como dois peers atrás de CGNAT se encontrarem**. Isso não é bug, é física da
  rede. O caminho tem que ser: direto → hole punch → **relay**.

**Causa-raiz (a soma de tudo isso):** *não existe TURN nem relay de dados
próprio*, e o único caminho que poderia funcionar em CGNAT (relay via 4 brokers
MQTT públicos) é frágil e tem um bug de perda de mensagens.

#### 2.1 — POR QUE O TORRENT FUNCIONA NO 4G E O DISTORRENT NÃO
*(leia antes de mexer em qualquer coisa de rede — é o raciocínio que evita
gastar 2 dias com a solução errada)*

O dono do projeto disse: **"no torrent funciona, no DisTorrent
não"**. Isso é a pista mais valiosa do projeto. E é verdade. O torrent **passa
por CGNAT** — mas por três motivos que o DisTorrent não reproduz:

**Motivo 1 — o torrent quase sempre tem ALGUÉM alcançável do outro lado.**
Numa swarming de milhares de peers, basta um deles não estar atrás de CGNAT
(residencial com UPnP, VPS, seedbox) para os os outros irem nele. O BT ainda
tem redundância estatística: se o par A-B falha, tenta A-C, A-D. **Uma conversa
entre 2 pessoas não tem plano B.** Quando as **duas** pontas estão em 4G, não
existe terceiro para ser o alcançável. Essa é a assimetria mais importante e
não se corrige com código — corrige-se com **relay**.

**Motivo 2 — porta fixa e porta certa anunciada.**
Cliente de torrent escuta numa porta **conhecida e fixa** (6881, 51413) e anuncia
**exatamente a porta em que está escutando**. Um peer que disca essa porta
encontra um listener real.
O DisTorrent anuncia a **porta errada**, em dois lugares:
- `stun.rs:239-257` + `engine.rs:4043-4057` e `:5742-5748` — o mapeamento
  **UDP** devolvido pelo STUN é usado como alvo do furo **TCP**. São portas
  diferentes. O `Punch` aponta para o vazio.
- `dht.rs:130` — anuncia `engine.listen_port()`, a porta **interna efêmera**.
  Privada e inútil para quem está fora.

**Motivo 3 — o "abertura simultânea" do TCP atravessa CGNAT, e o DisTorrent já
implementa a parte difícil — mas estraga no detalhe.**
Quando A e B **discam um para o outro ao mesmo tempo**, cada CGNAT abre um mapeamento
de saída na conexão. O SYN que B envia de volta é aceito como tráfego de retorno
da conexão que A abriu, e o listener de A o recebe. É a técnica clássica de
"TCP simultaneous open" para P2P, e é exatamente por isso que o BT e o WebRTC
passam por CGNAT. O requisito é sutil e é o que o código quase faz:
> **A saída tem que ser feita DA MESMA porta local em que o processo escuta.**

Porque só o socket que fez saída ganha mapeamento no CGNAT; um socket que só
espera não tem mapeamento nenhum. E é isso que `forge-core/src/net/transport.rs`
**já faz**: `punch_dial` "bind na porta do listener" (o design está certo!).
Onde estraga:
1. A porta externa que o outro lado precisa conhecer sai do STUN feito em **outro
   socket** → número diferente do que o socket de furo realmente usa
   (`stun.rs:239-257`). Coerência quebrada.
2. As mensagens de **coordenação** (quem manda o `Punch`, com que porta, quando)
   passam pelo relay MQTT — e `relay.rs:403-408` **joga fora frames** desse
   inbox (bug mapeado abaixo). Sem a porta do outro lado, o furo coordenado não
   existe. **Este provavelmente é o que mata o 4G de hoje.**
3. Sem janela de retry: os dois mapeamentos do CGNAT precisam coexistir
   (o CGNAT expira mapping em ~30s–2min depending do carrier). Se A tenta em t=0 e
   B em t=40s, nunca se cruzam.
4. Sem **aceitar o inbound como vitória**: se a conexão de saída de A falha mas o
   SYN de B chegou, o jogo tem que ser considerado ganho. Código que exige
   "minha saída conectou" nunca aproveita a abertura simultânea.

**Conclusão honesta (não pula isso):** corrigindo os 4 itens do Motivo 2/3, o
4G tem chance real de funcionar **direto**, sem custo de servidor. Mas "chance
real" não é garantia: CGNAT assimétrico, filtro de porta e carrier que não
permite abertura simultânea continuam existindo. **Para conversa entre 2 pessoas
você precisa do relay como último degrau** — o Motivo 1 é a prova de que não dá
para apostar só no direto. Não venda o furo direto como solução completa; venda
como **primeiro degrau**, com o relay atrás dele.

#### 2.2 — O "proxy": o que é, quanto custa, e onde plugar no código

O dono pediu "um proxy no 4G". Ele está certo no instinto, com um ajuste: o que
falta **não é um proxy HTTP genérico** (não tem proxy HTTP que resolva
sessões P2P assimétricas), é um **relay do próprio DisTorrent** — um servidor
pequeno que aceita a sessão de um lado e repassa para o outro, usando o protocolo
que o app já fala. Bônus: a criptografia fim-a-fim entre os dois peers continua
valendo, porque o relay transporta bytes cifrados e não enxerga conteúdo.

**O que já existe no código (esta é a boa notícia):**
- `forge-core/src/net/relay.rs:98` — `pub trait RelayBackend: Send + Sync`. É a
  interface certa de "coisa que transporta frame de um peer a outro".
  Implementações existentes: `:338` `MqttRelay`, `:486` `MultiRelay`, `:679`
  `PeerRelayBackend`, `:955` `MemRelay` (testes).
- `forge-core/src/net/relay.rs:1240` — `RelayStream`: o stream de dados já
  empacotado, do outro lado do relay.
- `forge-core/src/net/engine.rs:1181` — `set_relay_backend(Arc<dyn RelayBackend>)`:
  o ponto de injeção já existe. Cuidado com a guarda de `:1230` (backend injetado
  por teste não é sobrescrito pelo `MultiRelay`).
- `forge-core/src/net/engine.rs:1391-1401` — `peer_relay_backend_for()`: relay
  via um terceiro peer. **Prova de que relay peer-a-peer já está no projeto.**
- `host/` — já é um binário de servidor (tracker HTTP com `--bootstrap PORTA`).
  É onde o relay server-side naturalmente entra.

**Três formas de conseguir o "proxy", do mais barato ao mais profissional:**

**Opção P1 — relay próprio num VPS barato (recomendado).**
Um VPS de ~US$ 4–6/mês (o mais barato que aceita tráfego) rodando o binário
`host` em um modo novo `--relay`. Uma alocação estilo coturn: o peer A pede
"aloca sessão para o fingerprint B", o relay guarda a conexão e espera B chegar;
aí empacota os dois. O cliente usa a abstração que já existe.
- Plano: um comando novo no `host` + um `RelayBackend` cliente novo
  (ligado em `set_relay_backend`, priorizado **depois** do direto, **antes** do
  MQTT público).
- Ganho: controle, sem cota de terceiro, criptografia E2E preservada, o 4G passa.
- Custo: US$ 4–6/mês + sua operação. E o relay vira **o single point of failure
  do produto** — se o relay cai, ninguém fala. Trate isso: redundância (2 VPS)
  ou aceite e documente.

**Opção P2 — TURN de verdade (coturn) no mesmo VPS, reaproveitando o motor.**
Em vez (ou além) de inventar um protocolo de relay, roda `coturn` no seu VPS e
aponta o WebView (`callManager.getIceServers:194-230`) para `turn:seu-host:3478`.
- Plano: o motor descobre o candidato (Opção A do prompt 2) e o TURN cobre o pior
  caso. Menos código novo, battle-tested.
- Ganho: resolve **também a mídia** (ver prompt 2) com uma peça só.
- Custo: o motor ainda precisa anunciar a porta certa (2.1 Motivo 2) e o relay
  MQTT continua sendo o fallback do fallback.
- É a melhor relação custo/resultado **se você já aceita rodar um servidor**.

**Opção P3 — usar VPS do próprio dono como relay.**
Você tem um servidor (`host/`, e as pastas `Aris`, `servers de maine`,
`Sistema_aula` no ambiente do dono podem indicar máquinas suas). Se algum host é
seu e fica 24/7, ele é o relay de graça e sem custo de terceiros. Verifique
antes de pagar por VPS.

**Antes de decidir, um passo obrigatório:** `grep` no ambiente do dono por
servidor/VPS já disponível (`host/`, `servers de maine/`, `Aris/`, documentação do
projeto) e **relate o que encontrou**. Se já existe uma máquina sua 24/7, o
relay é grátis e isso muda a equação inteira. **Pergunte ao dono antes de criar
custo recorrente.**

**Independentemente de qual opção o dono escolher, o relay tem que:**
- ser **opt-in e configurável** (nada de hardcodar host/senha no binário — o
  projeto já cometeu esse erro com o `openrelay.metered.ca`, ver prompt 2);
- mostrar na UI **em que degrau** a conexão está (direto / furo / relay) e o
  motivo da falha — requisito de honestidade do produto;
- **não degradar criptografia**: o relay transporta o que já está cifrado pelo
  handshake do `transport.rs` (ed25519 + X25519 + ChaCha20Poly1305). Ele nunca
  vê conteúdo. Documente isso claramente.

Defeitos mapeados (com arquivo:linha):

- **BUG GRAVE** `engine.rs:4043-4057` + `:5742-5748` + `stun.rs:239-257` — o STUN
  devolve o mapeamento **UDP**, mas esse endereço é anunciado e usado como alvo do
  furo **TCP** (`public_addr = sa.to_string()`). Atrás de CGNAT a porta TCP é outra
  → o `Punch` aponta para onde nada escuta. O hole punching **nunca** funciona em
  4G e ainda polui o anúncio.
- **BUG GRAVE** `relay.rs:403-408` — `MqttRelay::poll` faz `mem::take(&mut st.inbox)`
  **sem filtrar por tópico**. O inbox é único por perna: o poll de anúncio
  (`engine.rs:4132`, `:5660`) e o poll do relay (`engine.rs:5226`) disputam o mesmo
  buffer e **descartam os frames um do outro**. Chamado a cada 30s por amigo aceito
  e a cada `friend_request` → handshake relay e `Punch` perdem mensagens
  silenciosamente. Relia em `relay.rs:379-402`: `subscribed: Option<String>` único
  faz o poll ressUBScrever o tópico anterior a cada alternância
  `distorrent_r_*` ↔ `distorrent_a_*`.
- **BUG** `relay.rs:446-455` + `engine.rs:3950-3964` — o único caminho viável em
  CGNAT depende de 4 brokers MQTT públicos anônimos em **:1883**, sem TLS, sem
  auth, QoS0 + `clean_session` ⇒ **frame publicado com o assinante offline é
  perdido para sempre**. Operadora que bloqueia/throttle 1883 = morte. E
  `FORGE_BOOTSTRAP_URL` é **vazio por padrão** ⇒ o bootstrap HTTP está inativo.
- `dht.rs:130` — anuncia `engine.listen_port()`, a porta **TCP interna efêmera**,
  no infohash. `get_peers` devolve endereços privados/inerentes → dial direto
  condenado.
- `transport.rs:485-506` — `udp_punch_probe` é decorativo: manda 3 datagramas para
  a porta **TCP** do peer; **não existe socket UDP escutando em lugar nenhum**. O
  comentário "abre pinhole UDP" é falso.
- `src-tauri/src/lib.rs:2873-2884` — `run_mobile()` **não** seta `FORGE_DHT=1`
  (só `run()` desktop liga). DHT desligada no Android.
- `engine.rs:870-872` — `map.retain(|_,_|true)` é no-op: `peer_diag` cresce sem
  limite (o próprio comentário admite). Vazamento de memória.
- **UI enganosa** `ThemeShell.tsx:995` e `MobileShell.tsx:686`:
  `online = state==='CONNECTED' || (listening && state==='DISCONNECTED')` → pilha
  **verde "ONLINE"** sempre que o listener está bound, com **0 peers alcançáveis**.
  `src/services/browser.ts:465` ainda devolve `state:'CONNECTED'` hardcoded.

**Os testes não pegam nada disso:** `punch_e2e.rs:46` usa
`set_public_addr("127.0.0.1:{port}")` + `MemRelay` — prova a mecânica, não NAT, e
*mascara* o bug do STUN-UDP-em-porta-TCP (em loopback o endpoint errado
"funciona"). `relay_e2e.rs`, `direct_norelay_traffic.rs`, `e2e_two_users.rs`,
`ten_nodes_stress.rs` são todos `MemRelay` + `127.0.0.1`: nenhum byte sai da
máquina. `relay_mqtt_e2e.rs` é o único com rede real, mas roda
`FORGE_NO_ANNOUNCE=1` da **mesma LAN** — não reproduz CGNAT. `dht_bit_e2e.rs:32` e
`dht_connectivity.rs:4` são `#[ignore]`.

**O que fazer, em ordem:**

1. **Corrigir o `MqttRelay` agora** (barato, altíssimo impacto): inbox por tópico
   (`HashMap<String, Vec<String>>`) + `subscribed: HashSet<String>`. Isso sozinho
   mata a maior parte das falhas silenciosas.
2. **Robustez do relay:** QoS1 + `clean_session(false)` + `client_id` estável por
   identidade, e espelho de rede em **HTTPS/WebSocket** (443) em vez de só 1883.
   Sempre incluir um broker próprio como perna primária.
3. **TURN / relay de dados próprio** — o degrau que resolve 4G de verdade. O
   `relay.rs` já tem a abstração `RelayBackend`/`RelayStream`: implemente um
   `TurnBackend` (crate `turn`/`webrtc-turn`) ou um `RelayStream` server-side com
   alocação estilo coturn e plugue em `MultiRelay`/`active_relay_backend`. É uma
   mudança cirúrgica, **não mexe no protocolo**. O `host/` já tem servidor HTTP +
   engine: dá para estender ele. Ordem de preferência de rota:
   `ICE-lite → hole punch → relay`.
4. **Parar de anunciar endpoint falso:** não usar a porta UDP do STUN como alvo de
   furo TCP. Ou o transporte de dados migra para UDP+DTLS com ICE de verdade
   (binding requests STUN entre peers trocados via frame `Punch`, com verificação
   de conectividade e retries), ou — solução mínima — só anuncie porta confirmada
   por UPnP/`ext_port` e nunca publique endpoint TCP não confirmado.
5. **DHT:** anunciar o endpoint **externo** real, não `listen_port()`; ligar
   `FORGE_DHT` também no `run_mobile()`.
6. **UI honesta:** separar "nó no ar" de "peers alcançáveis". A pilha verde deve
   exigir ≥1 peer `Online` real. Fazer o `ConnectionDiagnostics` mostrar **em qual
   degrau da cadeia de fallback** o motor está e **por que** o próximo não engatou.
7. **Teste que realmente prova 4G:** construa um teste de CGNAT simulado (ou
   documente como rodar): dois peers atrás de NATs que não aceitam mapping, com
   relay obrigatório, medindo taxa de entrega e tempo até `Online`. Enquanto
   isso não existir, ninguém vai saber se o 4G voltou.

---

### BUG 3 — "Chamadas não funcionam"

**Sintoma:** a chamada não estabelece. Na prática o usuário vê "chamando…" para
sempre, ou a chamada "conecta" mas fica **muda**.

**Causa-raiz:** a offer do chamador é respondida **antes** do convidado aceitar, e
o `ontrack` disparado nesse momento é jogado fora porque exige estado de chamada
existente. O WebRTC pode até chegar a `connected` (badge verde), mas **não há
`MediaStream` remoto → nenhum elemento toca → chamada muda**. Agravador que produz
a mesma percepção: falta de `<audio>` no shell desktop e `getUserMedia` falhando em
silêncio por falta de permissão.

Defeitos mapeados:

- `callManager.ts:2077-2082` + `:2097-2128` — **`handleOffer` negocia mesmo com
  `this.state === null`** (ou seja, antes do aceite). Em `:2122` o `ontrack`
  (`:1982-1988`) dispara com state nulo → `attachRemoteTrack:357` retorna → a track
  remota do chamador é **descartada para sempre** (`ontrack` não repete). O
  *callee* nunca recebe áudio. Isto é o caminho **normal**, não exceção: a offer
  sai em `:1023-1026` (t=0) e o humano só aceita segundos depois.
- `ThemeShell.tsx:2218` — o shell desktop tem **só `<video>`**, sem `<audio>`. Se
  `p.stream` ficar `undefined` (bug acima) não existe elemento de saída de áudio.
  `MobileShell.tsx:1019` faz certo (`<audio autoPlay>`) — **desktop é o quebrado**.
- `src-tauri/capabilities/default.json:6` — só `core:default`. **Sem
  `microphone:allow-start` / `camera:allow-start`** e sem handler de permissão do
  webview: `getUserMedia` falha e `getLocalMedia:486` (`.catch(() => null)`) devolve
  `null` **em silêncio** → chamada só-sinalização morre sem mensagem. O
  `AndroidManifest.xml:28-33` tem RECORD_AUDIO/CAMERA, mas a capability do Tauri
  falta.
- `callManager.ts:1157-1163` / `:1176-1182` + `:1971-1977` — a offer inicial não
  tem tracks do answerer (`localStream` é null nesse instante); a correção depende
  de renegociação (`:1975`) que só dispara se `signalingState==='stable'`. Frágil,
  e o `catch {}` de `:2129`/`:2144` engole a falha.
- `engine.rs:3230-3245` — `CallOffer` com SDP **dummy** (`"invite:voice"`) é enviado
  ao convidado antes da offer real. Só não quebra porque o `JSON.parse` falha em
  `callManager.ts:2085`. Frame espúrio no caminho quente — remova.
- `callManager.ts:1001` — `callInvite(targetFps[0])` toca o telefone só do **1º
  alvo**; em grupo os demais nunca recebem `CallIncoming`.
- `ThemeShell.tsx:559-563` — só `onCallNotice` é assinado;
  `callManager.onIceFailed` (`:697`) **nunca é lido** → `ICE_RELAY_MSG`/
  `ICE_FAILED_MSG` nunca aparecem, badge fica "Conectando…" para sempre.
- `ThemeShell.tsx:857` + `callManager.ts:1676` — o fallback cria `activeCall` local
  sem estado no CallManager ⇒ o botão "Sair" (`:2246`) chama `leave()` que retorna
  na hora: **o overlay não fecha**.
- `callManager.ts:1130-1137` / `:1292-1298` — `setRelayMode`/
  `onIceFailureAutoRelay` são no-op ("relay removido"), mas `ThemeShell.tsx:855` e
  `isRelayOnlyCalls` (`:2211`) ainda os usam: a **UI promete relay que não existe**.
- `callManager.getCallsSupport():596-601` devolve sempre `'full'` ou `'none'` — o
  ramo `'relay-only'` (usado em `:984`, `:1167`, `:1212`) é código morto.
- `getIceServers():194-230` usa 6 STUN + TURN configurável + 2 TURN públicos, e o
  **próprio comentário em `callManager.ts:100-103` diz que as credenciais classic
  foram desativadas** → sem TURN próprio, CGNAT/NAT simétrico não tem rota, e o
  motor P2P do forge-core **não faz hole punch para o ICE do WebView**.
- `src/services/browser.ts:1025-1027` — `callOffer/callAnswer/callIce` são **no-op**
  ⇒ no modo browser (todo o e2e Playwright!) **não existe sinalização WebRTC**.
  Por isso `e2e/call-phases.spec.ts:77-78` (esperar "Conectado •") é
  **inalcançável** nesse modo. A suíte `calls.spec.ts` / `calls2.spec.ts` /
  `call-phases.spec.ts` está dando falsa confiança.

**O que fazer:**

1. `handleOffer`: se `!this.state || state.callId !== callId` → **não negociar**;
   guardar a offer pendente (`pendingOffers.set(fromFp, sdp)`) e voltar. Em
   `acceptInbound` (`:1146`), após criar o estado, drenar `pendingOffers` chamando
   `handleOffer` (aí o `ontrack` já tem state). Guarda simétrica em `handleIce`
   (já existe). **Esta é a correção que faz a chamada ter áudio.**
2. Shell desktop: montar `<audio autoPlay ref={el => el.srcObject = p.stream} hidden/>`
   por participante remoto, junto do `<video>` em `ThemeShell.tsx:2218`, e chamar
   `el.play().catch(...)`. Espelhar `MobileShell.tsx:1019`.
3. `getLocalMedia`: capturar `e.name` e, em `NotAllowedError` / `NotFoundError` /
   `NotReadableError`, emitir `onCallNotice` com mensagem honesta. **Nunca
   `null` silencioso.**
4. `capabilities/default.json`: adicionar as permissões de mídia do Tauri v2
   (`microphone:allow-start`, `camera:allow-start`, `screen:allow-start`) e
   validar `getUserMedia` no boot, mostrando o erro real.
5. `engine.rs:3239-3245`: remover o `CallOffer` dummy (o `start()` já envia a
   offer real).
6. Assinar `callManager.onIceFailed` no `ThemeShell` (junto de `:559`) para
   exibir `ICE_RELAY_MSG`/`ICE_FAILED_MSG`; corrigir o fallback de `:857` para
   sempre passar por `callManager.leave()`/`setActiveCall(null)`.
7. Remover/limpar o código morto e as promessas de relay que não existem
   (`setRelayMode`, `isRelayOnlyCalls`, ramo `'relay-only'`).
8. **Teste de chamada de verdade:** os e2e rodam em modo browser onde nada
   funciona. Escreva um teste no `forge-core` (`tests/call_signaling_e2e.rs` já
   existe — veja o que ele cobre) que valide offer/answer/ICE ponta a ponta, e
   um teste manual documentado para a mídia real (2 máquinas ou 1 + celular). Sem
   isso, ninguém sabe se a chamada voltou.

---

### BUG 4 — "Exportar cofre não funciona"

**Sintoma:** o botão de exportar cofre falha. Em contas criadas **com senha**,
sempre. Contas sem senha (criadas via `CreateAccount`) funcionam — por isso o
sintoma parece intermitente.

**Causa-raiz:** `identity_get` (`src-tauri/src/lib.rs:85-92`) **encurta o login**:
devolve a identidade de uma conta protegida por senha **sem pedir a senha e sem
bootar o engine** quando `vault.on=="1"` e o blob é válido. A UI confia no retorno
e entra no app "desbloqueada" (`ThemeShell.tsx:471-474`, `MobileShell.tsx:487-488`,
`useAuth.ts:21-25`) → `state.engine == None`. Daí `export_secret` cai no ramo
`Err("app bloqueado — desbloqueie com sua senha antes de exportar")`, e **não existe
LockScreen alcançável** (o `vaultUnlock('')` de `ThemeShell.tsx:480` só roda se
`identityGet()` retornar null). O botão Exportar **sempre** falha.

Fluxo (para você não se perder):
- UI export: `src/components/vault/StormVaultPanel.tsx:43-56` `doExport()` →
  `src/services/tauri.ts:260-263` → `invoke('stormvault_export', {password, includeSecret, maxMessages:null})`
- Rust: `lib.rs:2314-2355` → `export_secret` (`:2296-2309`) →
  `forge_core::stormvault::collect` (`forge-core/src/storage.rs:2268-2469`) →
  `seal_with_password` (`stormvault.rs:198-215`; Argon2id m=19456/t=2/p=1
  `:466-475` + ChaCha20Poly1305, header como AAD `:225-294`) → escrita em
  `~/Downloads/distorrent-cofre-<fp>-<ms>.stormvault` (`lib.rs:2337-2346`,
  `export_base_dir:2358-2373`, `resolve_downloads_dir:2185-2236`,
  `unique_download_path:2240`)
- UI import: `StormVaultPanel.tsx:58-78` + `<input type=file>` `:181-198`
  (FileReader→base64) → `lib.rs:2378-2402` → `stormvault.rs:408-426`
  `import_with_password` → `import_merge_only:429-462` → `storage.rs:2493+`
- Docs: `docs/STORMVAULT.md` (spec do formato), `docs/MIGRACAO_ENTRE_DISPOSITIVOS.md`

Outros defeitos:

- `lib.rs:85-92` — causa-raiz acima.
- `lib.rs:2296-2309`, `lib.rs:2425-2426` — com (1), o **backup automático** também
  quebra (`stormvault_backup_now` → `engine()` → "motor não iniciado").
- `lib.rs:2392-2396` — import numa conta existente exige `engine()`: falha pelo
  mesmo motivo.
- **Import é inalcançável em device limpo:** o painel só renderiza com identidade
  presente (`ThemeShell.tsx:2387`, `MobileShell.tsx:1369`). Em device novo a UI é
  `CreateAccount` — não há Configurações. O único import na LockScreen
  (`Auth.tsx:132-145`, `ThemeShell.tsx:2364-2373`) usa o formato JSON/`vault_blob`
  **antigo**, não `.stormvault`. O fluxo de `MIGRACAO_ENTRE_DISPOSITIVOS.md` §3 é
  **impossível**.
- `StormVaultPanel.tsx:67-72` — após `identity_installed` não há `reload()`/refresh:
  a tela continua em "criar conta" e o engine não sobe (`stormvault.rs:408-420`
  grava no banco, mas `lib.rs` não seta `unlocked` nem boota).
- `lib.rs:2314` / `:2379` / `:2425` — comandos **síncronos**: collect + serde +
  zstd + Argon2 + escrita rodam na **main thread** do Tauri v2. Com 200k mensagens
  são segundos/dezenas de segundos de congelamento (ANR no Android): a UI parece
  morta.
- `lib.rs:2346` — `fs::write` **não atômico** (o `save_file:2159-2177` faz
  tmp+rename). Crash no meio = cofre corrompido com o nome final, e o retry gera
  "cofre (1)".
- `lib.rs:2358-2373` + `StormVaultPanel.tsx:163-246` — no Android grava em
  `app_data_dir/Download` (**storage privado**) e não há `navigator.share`/
  MediaStore (ao contrário de `fileSwarm.ts:737`). O `.stormvault` fica
  **inalcançável pelo usuário**, contradizendo a doc ("Downloads").
- `StormVaultPanel.tsx:192` — `readAsDataURL` → base64 (+33%) dentro do IPC JSON;
  combinado com o cap de 512 MB (`lib.rs:2388`) o import trava/falha. Sem
  `reader.onerror` → **erro engolido**, nenhum feedback ao usuário.
- `StormVaultPanel.tsx:149-161` — em `npm run dev` (browser) export/import **não
  existem** (só o aviso; `browser.ts:1203-1209` rejeita tudo). Se você testar
  assim, vai concluir que está quebrado sem estar.
- `capabilities/default.json:6` — sem plugin `dialog`/`fs`: sem diálogo de
  "salvar como", destino fixo e silencioso.
- `stormvault.rs:466-475` — `kdf_params` do header **nunca é lido** (params
  hardcoded): cofre de versão futura com m/t/p diferentes abriria errado.
- `stormvault.rs:199` vs `StormVaultPanel.tsx:168` — `chars().count() < 8` (Rust)
  vs `length < 8` (UTF-16): senha com emoji/astral passa no botão e é **rejeitada
  no Rust**.

**O que fazer:**

1. `lib.rs:89-92`: quando `vault_on && has_valid_blob`, **não** devolver a
   identidade — devolver `Ok(None)` (ou `locked: true`) para a UI cair no
   LockScreen e chamar `vault_unlock`; ou no mínimo só fazer
   `boot_engine_with_secret` **depois** do unlock. Isso conserta export, backup e
   import de uma vez.
2. `StormVaultPanel.tsx:58-78`: após `identity_installed`, recarregar/refrescar.
3. Mostrar o painel de **import também quando não há identidade** (device limpo),
   decidindo com `services.identityGet()`/`vaultStatus`.
4. `lib.rs:2314`/`:2379`/`:2425`: virar `async fn` + `spawn_blocking` (ou
   `#[tauri::command(async)]`) para não travar a main thread.
5. `lib.rs:2346`: escrever em `.tmp` + `rename` (igual `save_file:2162-2177`).
6. `StormVaultPanel.tsx:192`: `await f.arrayBuffer()` → invoke em base64 em
   chunks, ou um comando Rust que leia o caminho via dialog; adicionar
   `reader.onerror` com mensagem ao usuário.
7. Android: em `export_base_dir`, devolver o caminho **visível** e chamar
   `navigator.share`/MediaStore como em `fileSwarm.ts:737`.
8. `stormvault.rs`: ler `kdf_params` do header; alinhar a validação de senha
   (8 caracteres) entre Rust e TS contando pontos de código, não UTF-16.

## 3. Other problemas além dos 4 (achados na mesma auditoria)

Você não vai resolver tudo de uma vez. Mas **estes também são bugs** e devem
entrar no plano:

1. `ThemeShell.tsx:995` / `MobileShell.tsx:686` / `browser.ts:465` — estado de
   conexão **otimista e hardcoded** (ver BUG 2.6). Quebra a promessa do README
   ("estados verdadeiros").
2. `engine.rs:870-872` — `map.retain(|_,_|true)` é no-op; `peer_diag` cresce sem
   limite. Vazamento de memória real em app de longa duração.
3. `src-tauri/capabilities/default.json` — só `core:default`. Faltam permissões de
   mídia (BUG 3.4), `dialog` e `fs` (cofre e downloads). Isso derruba
   funcionalidades inteiras de forma silenciosa.
4. `fileSwarm.ts:157-158` vs `MobileShell.tsx:33` — caps de mídia divergentes
   (8 MB / 12 MB) para a mesma feature.
5. `e2e/*.spec.ts` — 12 suítes Playwright rodam em **modo browser**, onde
   `callOffer/callAnswer/callIce` são no-op (`browser.ts:1025-1027`) e não há rede
   P2P. Ou seja, a suíte dá **falsa confiança**: `call-phases.spec.ts:77-78` espera
   um estado inalcançável. Ou você implementa mocks honestos que simulam WebRTC
   no browser, ou você marca essas specs como não-cobertura de mídia. Não deixe
   teste verde que não prova nada.
6. `forge-core/tests/*` — 25 suítes, quase todas em `MemRelay` + `127.0.0.1`.
   `dht_bit_e2e.rs:32` e `dht_connectivity.rs:4` são `#[ignore]`. Falta um teste
   de CGNAT simulado (ver BUG 2.7).
7. `src/services/downloadManager.ts:10` — `DownloadStatus` importado e não usado
   (único warning do eslint). Ruído.
8. `ThemeShell.tsx:450` — `const [, setFileList]` descarta valor; re-renderiza a
   árvore inteira a cada ~300ms durante download.
9. Docs desatualizados: `README.md:56-57` diz "Conexão pela internet é
   automática (UPnP + bootstrap pelo fingerprint)" — **isso é falso em 4G** e o
   usuário takeaway como verdade. Corrija o README para dizer a verdade sobre
   CGNAT e o que exige relay/TURN. `docs/MIGRACAO_ENTRE_DISPOSITIVOS.md` §3
   descreve um fluxo hoje impossível (ver BUG 4.5).

## 4. Ordem de execução exigida

**Fase 0 — Não quebre o que funciona (obrigatório)**
- Baseline: `npx tsc -b` e `npx eslint .` (hoje ambos passam, exit 0). Anote.
- Commite/paritee o estado atual antes de mexer, para poder voltar.

**Fase 1 — Correções de causa-raiz, alta confiança, baixo risco**
(orderem porque uma destrava a outra)
1. BUG 3.1 (`handleOffer` antes do aceite) + BUG 3.2 (`<audio>` no desktop) +
   BUG 3.4 (permissões de mídia) → **a chamada passa a ter áudio.**
2. BUG 4.1 (`identity_get` curto-circuita o lock) → **export/backup/import
   destravam.**
3. BUG 1.1–1.4 (ordem do registro, retry, `useCallback`, revoke) + BUG 1.6
   (`media-src` na CSP) → **preview de imagem funciona no desktop.**
4. BUG 2.1 (inbox do `MqttRelay` por tópico) → **para de perder frames em
   silêncio.** Barato, altíssimo impacto.

**Fase 2 — Robustez e honestidade**
- BUG 2.2 (QoS1 + WSS), BUG 2.5 (DHT endpoint externo + `FORGE_DHT` no mobile),
  BUG 2.6 + seção 3.1 (estado de conexão honesto), 3.2 (vazamento de memória),
  3.7 (warning), 3.9 (README/documentos verdadeiros).
- BUG 2.3/2.4 (TURN/relay próprio, ICE real) — é trabalho de arquitetura, não
  patch. Faça um **dossiê de decisão** (opções, custo, risco, o que cada uma
  compra) e **pergunte ao usuário** antes de construir. Não invente uma solução de
  2 dias para um problema que precisa de servidor.

**Fase 3 — Prova**
- BUG 2.7 (teste de CGNAT simulado), BUG 3.8 (teste de chamada real), 3.5
  (decidir o futuro da suíte Playwright).
- Documente como reproduzir 4G e chamada de verdade (passo a passo, incluindo o
  que precisa de 2 dispositivos).

## 5. Como reportar

Ao final de cada fase, reporte de forma **direta e honesta**:
- O que foi **corrigido** + evidência (teste, log, print, `arquivo:linha`).
- O que **não** foi corrigido e **por quê** (bloqueio de arquitetura, decisão
  pendente, falta de hardware).
- O que **não pôde ser verificado** (ex.: "não tenho como testar 4G de verdade aqui;
  o teste simulado X cobre Y").
- Se alguma "correção" na verdade apenas **esconde** o sintoma (ex.: deixar a UI
  mostrar OFFLINE em vez de consertar a conexão), diga isso com todas as letras. O
  usuário prefere saber a verdade a receber um placebo.

Não diga "pronto" para algo que você não testou. Este projeto já tem histórico de
feature declarada "REAL (verificado por testes automatizados)" no `README.md:10`
que o usuário informa não funcionar — **o README é suspeito, não a palavra do
usuário**. Confie no teste real.

--- FIM DO PROMPT ---

---

## Notas para o Arthur (não vão no prompt)

- **"No torrent funciona e aqui não" é a pista certa, e a resposta está na seção
  2.1.** O torrent passa por CGNAT porque (a) na swarming sempre tem *algum* peer
  alcançável do outro lado, e o BT ainda tenta o próximo se um par falha; (b)
  anuncia a porta **em que está escutando**, e o DisTorrent anuncia a porta UDP do
  STUN como alvo TCP e a porta interna efêmera no DHT; (c) ele discamos um para o
  outro ao mesmo tempo da mesma porta local, e o seu motor **já faz isso**
  (`punch_dial` no `transport.rs` binds na porta do listener) — mas o número da
  porta que ele anuncia vem de outro socket, e as mensagens de coordenação são
  **descartadas** pelo bug do `MqttRelay` (`relay.rs:403-408`).
  Detalhe que fecha a conta: com **duas** pessoas no 4G não existe terceiro peer
  alcançável, então o direto tem chance mas não é garantia. Por isso relay.
- **Sobre o proxy que você pediu:** o que resolve não é proxy HTTP, é um **relay
  do próprio DisTorrent** — e a boa notícia é que ele já está quase todo escrito:
  `trait RelayBackend` (`relay.rs:98`), `RelayStream` (`:1240`),
  `set_relay_backend` (`engine.rs:1181`) e até relay via terceiro peer
  (`engine.rs:1391`). Falta o lado servidor, que cabe no binário `host/` que você
  já tem. Ver as opções P1/P2/P3 na seção 2.2 — **antes de pagar VPS, verifique
  se você já tem uma máquina sua 24/7** (tem `host/`, `servers de maine/`, `Aris/`
  no ambiente), porque isso muda a conta inteira.
- **A causa-raiz do "não conecta no 4G" não é um bug único — é arquitetura.**
  Não existe TURN nem relay de dados próprio. O único caminho possível em CGNAT
  hoje são 4 brokers MQTT públicos em :1883, sem TLS, sem retenção de mensagem, e
  com um bug que **joga fora frames** (`relay.rs:403-408`). Se você quiser 4G de
  verdade, precisa de um servidor. A decisão é sua e dela.
- **"Exportar cofre" tem um bug de uma linha de altura**
  (`lib.rs:85-92`): o app pula a tela de unlock, entra "desbloqueado" sem engine,
  e aí Exportar sempre dá "app bloqueado". É o conserto mais barato da lista.
- **A chamada "não funciona" porque alguém atende o telefone antes de atender.**
  O `ontrack` joga a faixa de áudio fora (`callManager.ts:2077-2128` + `:357`), e
  o desktop não tem `<audio>` nenhum (`ThemeShell.tsx:2218`). O celular tem —
  por isso no celular "às vezes funciona".
- **Os testes atuais não provam nada de rede.** 25 suítes Rust rodam em
  `127.0.0.1` com relay em memória; os 12 e2e Playwright rodam em modo browser
  onde WebRTC é no-op. Verde no CI ≠ funciona no 4G.
- `npx tsc -b` e `npx eslint .` passam hoje (0 erros, 1 warning). `npm run build`
  não foi verificado — estourou o tempo e não quis travar a máquina.
