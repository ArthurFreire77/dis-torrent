# PROMPT 2 — CHAMADAS (voz/vídeo/tela) + NAT pelo MESMO protocolo DisTorrent

> Cole o bloco "--- INÍCIO DO PROMPT ---" ... "--- FIM DO PROMPT ---" no agente.
>
> Este é o **prompt 2 de 2**. O prompt 1 (`PROMPT_CORRECOES.md`) cobre preview de
> imagem, exportação de cofre e o 4G do *motor P2P de dados*. **Este** cobre o
> subsistema de **chamadas** e a decisão de fazer a mídia WebRTC usar a mesma
> travessia de NAT do DisTorrent, em vez de depender de STUN/TURN públicos.
>
> **Regra de sequencing:** este prompt pressupõe as correções da Fase 1 do
> prompt 1 (a offer respondida antes do aceite, o `<audio>` faltando no desktop,
> as permissões de mídia). Se o agente não leu o prompt 1, leia antes — os dois
> se sobrepõem em `callManager.ts`.

---

## --- INÍCIO DO PROMPT ---

# MESTENDA parte 2: chamadas de voz/vídeo/tela e NAT unificado no protocolo DisTorrent

## 0. Duas missões, uma só entrega

**Missão A (curto prazo,Sem arquitetura):** fazer a chamada **funcionar de
verdade** — com áudio, com vídeo, e com compartilhamento de tela que não congela
nem some.

**Missão B (arquitetura, é a direção que o dono do projeto pediu):** a
travessia de NAT da **mídia** deve usar **o mesmo protocolo do DisTorrent**, e
não STUN/TURN públicos de terceiro. Hoje elas são duas redes completamente
separadas, e a segunda depende de serviço alheio:

```
DADOS (mensagens/arquivos)  → forge-core: TCP + handshake ed25519/X25519 +
                               ChaCha20Poly1305, UPnP, NAT-PMP, STUN, frame
                               Punch, DHT, relay MQTT, SOCKS5/Tor
                               (tudo casa, protocolo próprio, criptografia E2E)

MÍDIA (voz/vídeo/tela)      → RTCPeerConnection do WebView: 6 STUN públicos
                               + openrelay.metered.ca (credencial ESTÁTICA
                               hardcoded) + 2 TURN públicos + TURN configurável
                               à mão pelo usuário
                               (fora do protocolo, sem criptografia própria,
                                dependente de terceiro, cota de ~20 GB/mês)
```

Isso é um **defeito de desenho**, não só um bug: o projeto promete "sem servidor
central" e "P2P true" enquanto a mídia depende de um TURN público de terceiros
com senha fixa no código-fonte. O dono do projeto foi explícito: **o P2P/NAT
tem que usar o mesmo protocolo do DisTorrent.**

## 1. Regras inegociáveis (mesmas do prompt 1)

1. **Não gere APK, não buildar, não instalar nada.** Nada de `npm run tauri:build`,
   `cargo build --release`, nada de instalar pacote. Só código, typecheck, lint,
   testes, e relatório. O dono vai decidir quando empacotar.
2. **Comandos longos: avise antes.** `npm run build`, `cargo test`,
   `npx playwright test` travam a máquina do usuário.
3. `npx tsc -b` e `npx eslint .` são o loop rápido. Ambos passam hoje (exit 0;
   1 warning em `downloadManager.ts:10`).
4. Correção mínima e cirúrgica. `callManager.ts` tem ~2200 linhas e `engine.rs`
   ~7400: mexa nas linhas citadas, não refatore o arquivo.
5. **Nada de comentário óbvio** no código. Comentário só para *por quê* não-óbvio.
6. **Honestidade de estado é requisito.** Se a mídia não connectou, a UI diz que
   não conectou — com o motivo. Nada de "Conectado" otimista.
7. Português no relatório, inglês no código.

## 2. Onde está o código de chamada (leia antes de mexer)

```
src/services/callManager.ts        ~2200 linhas — o orquestrador
  :10        type CallKind = 'voice' | 'video' | 'screen'
  :77-78     CallState / participants[].{stream,sharing,muted,disconnected}
  :94-97     lista de 6 STUN públicos
  :100-113   comentário honesto sobre openrelay.metered.ca (flakiness, CGNAT)
  :118-133   getFallbackTurnCredential (static-auth-secret, HMAC-SHA1 local)
  :136-153   getFallbackTurnServer / getClassicTurnServer  ← credencial ESTÁTICA
             "openrelayproject"/"openrelayproject" hardcoded no repo
  :194-230   getIceServers()  ← a lista de iceServers da offer
  :302       createTunedOffer(pc)
  :341-349   supportsScreenShare()  ← só testa se getDisplayMedia EXISTE
  :351       attachRemoteTrack()    ← exige this.state (causa-raiz do áudio)
  :474-488   getLocalMedia()        ← .catch(() => null) = falha silenciosa
  :596-601   getCallsSupport()      ← devolve sempre 'full' | 'none'
  :610-644   logIceState()
  :672       private screenStream
  :716-806   bind()                ← liga os eventos
  :754-755   ev 'screen_share_offer' → onScreenShareSignal
  :824-843   ThemeShell startCall
  :844-862   ThemeShell atender
  :946-965   onScreenShareSignal   ← SÓ um flag {screen:'on'|'off'} (badge)
  :969-979   broadcastScreenSignal
  :981-1030  start()
  :1001      callInvite(targetFps[0])  ← só o 1º toque em grupo
  :1146-1219 acceptInbound()
  :1580-1600 setQuality()  (QUALITY_CONSTRAINTS só vale para a TELA)
  :1676      fallback de chamada sem estado no manager
  :1740      findVideoSender(pc)
  :1809-1840 toggleScreen()  ← parar: restaura a câmera (replaceTrack, :1824)
  :1843-1910 startScreen(): getDisplayMedia → applyConstraints → replaceTrack
  :1980-2001 wirePC()  (:1982-1988 ontrack)
  :2044-2064 createPC()
  :2076-2130 handleOffer()
  :2132-2145 handleAnswer()
  :2147-2190 handleIce() + flushPendingIce()
  :2192-2211 cleanup()
src/services/callPhases.ts          :38-73  nextCallPhase (badge de fase)
src/components/CallPhaseBadge.tsx   :18-61
src/designs/ThemeShell.tsx          :549 bind, :672 hangup, :824-862 start/atender,
                                    :1575-1576 botão tela, :2187-2249 overlay,
                                    :2218 <video> (SEM <audio>), :2228 badge
                                    COMPARTILHANDO, :2245 botão tela no overlay
src/mobile/MobileShell.tsx          :1019 <audio autoPlay> (o DESKTOP é o quebrado),
                                    :1043 botão tela, :1054-1055 badge TELA/CÂMERA
src/services/tauri.ts               :293-309 alias *_ev → *
src/services/browser.ts             :1025-1027 callOffer/callAnswer/callIce = NO-OP
src-tauri/src/lib.rs                :1831-1906 commands, :382-397 evento forge://event
src-tauri/capabilities/default.json :6 só "core:default" — sem microfone/câmera/tela
forge-core/src/protocol.rs          :248-283 CallInvite/Accept/Reject/End/Offer/Answer/Ice
forge-core/src/net/engine.rs        :3220-3247 call_invite, :3297-3303 call_signal,
                                    :3337-3351, :3357-3383 fila offline,
                                    :6608-6690 roteamento inbound, :150-165 eventos
forge-core/tests/call_signaling_e2e.rs  (veja o que cobre e o que não cobre)
```

## 3. MISSÃO A — corrigir a chamada agora

### A1. A offer é respondida ANTES do aceite → o áudio remoto é jogado fora
**Causa-raiz da "chamada muda".** `callManager.ts:2077-2082` + `:2097-2128`:
`handleOffer` segue o caminho completo de negociação (cria PC, `setRemoteDescription`,
responde) mesmo com `this.state === null`. Em `:2122` o `ontrack` (`:1982-1988`)
dispara com state nulo → `attachRemoteTrack:351/357` retorna → **a track remota do
chamador é descartada para sempre** (`ontrack` não repete). O *callee* nunca
recebe áudio. Isto é o caminho **normal**, não exceção: a offer sai em `:1023-1026`
(t=0) e o humano só aceita segundos depois.

**Correção:** se `!this.state || state.callId !== callId` → **não negociar**;
guardar a offer em `pendingOffers.set(fromFp, {callId, sdp})` e voltar. Em
`acceptInbound` (`:1146`), **depois** de criar o estado, drenar `pendingOffers` e
chamar `handleOffer` (aí `ontrack` já tem state). Guarda simétrica em `handleIce`
(ela já existe — siga o mesmo padrão).

### A2. O shell desktop não tem `<audio>` — só `<video>`
`ThemeShell.tsx:2218`. Se `p.stream` ficar `undefined` (A1), **não existe elemento
de saída de áudio**: a chamada fica muda mesmo com WebRTC `connected`. O mobile
faz certo em `MobileShell.tsx:1019`. Espelhe: `<audio autoPlay ref={el => el.srcObject = p.stream} hidden/>`
por participante remoto + `el.play().catch(...)` com aviso honesto.

### A3. `getUserMedia` falha em silêncio
`getLocalMedia:474-488` termina em `.catch(() => null)`. Sem permissão no Tauri
(`capabilities/default.json:6` só tem `core:default`), `getUserMedia` falha e a
chamada vira "só sinalização" sem mensagem nenhuma. **Trate `e.name`:
`NotAllowedError` / `NotFoundError` / `NotReadableError` → `onCallNotice` com texto
honesto. Nunca `null` mudo.**

### A4. Permissões de mídia no Tauri
`capabilities/default.json`: adicionar `microphone:allow-start`, `camera:allow-start`,
`screen:allow-start`. Validar `getUserMedia` no boot e mostrar o erro real se
falhar. (O `AndroidManifest.xml:28-33` já tem RECORD_AUDIO/CAMERA — falta o lado
Tauri.)

### A5. Frame espúrio no caminho quente
`engine.rs:3230-3245`: `CallInvite`/`CallOffer` com SDP **dummy** (`"invite:voice"`)
é enviado ao convidado antes da offer real. Só não quebra porque o `JSON.parse`
falha em `callManager.ts:2085`. Remova — o `start()` já envia a offer real.

### A6. Grupo: só o primeiro toca
`callManager.ts:1001` — `callInvite(targetFps[0])`. Em grupo os demais nunca
recebem `CallIncoming`. Itere os alvos (e trate falha individual sem derrubar os
outros).

### A7. Falha de ICE é invisível
`ThemeShell.tsx:559-563` assina só `onCallNotice`; `callManager.onIceFailed`
(`:697`) **nunca é lido** → `ICE_RELAY_MSG`/`ICE_FAILED_MSG` nunca aparecem, badge
fica "Conectando…" para sempre. Assine e mostre.

### A8. Botão "Sair" que não sai
`ThemeShell.tsx:857` + `callManager.ts:1676`: o fallback cria `activeCall` local sem
estado no CallManager → o botão Sair (`ThemeShell.tsx:2246`) chama `leave()` que
retorna na hora e **o overlay não fecha**. Corrija para sempre passar por
`callManager.leave()` / `setActiveCall(null)`.

### A9. Código morto e promessas falsas
`callManager.ts:1130-1137` e `:1292-1298`: `setRelayMode`/`onIceFailureAutoRelay`
são no-op ("relay removido"), mas `ThemeShell.tsx:855` e `isRelayOnlyCalls` (`:2211`)
ainda os usam — a **UI promete relay que não existe**. `getCallsSupport():596-601`
devolve sempre `'full' | 'none'`, então o ramo `'relay-only'` (usado em `:984`,
`:1167`, `:1212`) é inalcançável. Remova o morto e a promessa.

## 4. MISSÃO A2 — compartilhamento de tela: o que está realmente quebrado

Estado atual (verificado no código, não chute): o compartilhamento de tela
existe e a mídia **é** enviada — via `replaceTrack` no sender de vídeo da câmera
(`callManager.ts:1876-1878`) mais renegociação, com o badge só sendo um flag JSON
(`onScreenShareSignal:946-965`). Parar a tela **restaura a câmera**
(`toggleScreen:1811-1840`) — isso já está certo, não quebre.

Os problemas reais:

1. **O áudio da tela é código morto.** `callManager.ts:1888-1897`: o `atrack` só é
   adicionado `if (!asender && this.localStream)`. Em chamada real **sempre** existe
   um sender de áudio (o microfone) → o áudio da tela **nunca** é enviado. Pior:
   mesmo no caso raro de adicionar, `addTrack` **sem renegociar** não faz efeito.
   Decida: áudio de tela entra (mixado ou como track separado, com renegociação
   real e transceiver dedicado) ou fica explicitamente fora — com a UI dizendo.
2. **A tela substitui a câmera no mesmo m-line, sem layout.** O remoto vê a tela
   no mesmo tile da câmera e o badge é apenas texto
   (`MobileShell.tsx:1055` — "TELA/CÂMERA"). Não existe modo "tela em foco",
   Picture-in-Picture, nem volta automática visível. Se o produto quer "estilo
   Discord" (o título do botão em `ThemeShell.tsx:1576` diz isso), isso não é o
   que o Discord faz. Proponha e implemente um layout de tela compartilhada.
3. **`supportsScreenShare():341-349` é enganoso.** Só testa se `getDisplayMedia`
   existe. No Linux/WebKitGTK (a plataforma do dono) a API costuma existir e falhar
   ou ficar limitada; sem a capability `screen:allow-start` ela falha na chamada
   real. Faça uma checagem real de suporte (e degrade honestamente) em vez de
   prometer e depois errar.
4. **Renegociação sem fila e sem rollback.** `setQuality:1580-1600` e
   `toggleScreen` fazem `createTunedOffer` + `setLocalDescription` + `callOffer` por
   peer, com guardas `if (pc.signalingState !== 'stable') continue` e um mar de
   `.catch(() => {})`. Ajustar qualidade e ligar/desligar tela ao mesmo tempo
   colide; e o `createTunedOffer` continua fazendo offer sem `perfect negotiation`
   (impolite/polite + rollback) — você já implementou isso para a offer inicial
   (`:1980-2001` region), **reutilize o mesmo mecanismo** na renegociação.
5. **Sem degradação sob 4G.** `QUALITY_CONSTRAINTS` fixa 720p para a tela, sem
   `contentHint`, sem `setParameters`/`degradationPreference`, sem simulcast, sem
   `scaleDown` por `getStats()`. Em 4G a tela é a primeira coisa a morrer. A partir
   do A1+ICE funcionando,.linkar a qualidade ao `getStats()` (rtt/packetLoss/
   availableOutgoingBitrate).
6. **Sem `onmute`/`onunmute`/`onended` de reação** nos participantes: a UI não sabe
   quando a tela de alguém congela. `track.onended:1898` cobre só o lado local.
7. **Custo de banda em mesh.** `ThemeShell.tsx:1576` anuncia "todos semeiam": em
   grupo com N peers, N× a taxa de tela. Ou limite, ou documente, ou desenhe
   topologia de relay para mídia (amarra com a Missão B).

## 5. MISSÃO B — NAT da mídia no MESMO protocolo DisTorrent

### 5.1 O que precisa ser verdade no fim
- Nenhuma chamada depende de `openrelay.metered.ca` nem de outro TURN de
  terceiros. Remova `getClassicTurnServer()` (`:148-153`, credencial estática
  hardcoded) e `getFallbackTurnServer()` (`:136-140`) da lista padrão, e o
  comentário em `:100-113` que documenta a dependência.
- A travessia de NAT da mídia é resolvida pelos mesmos componentes que já
  resolvem a de dados: STUN do forge-core, `frame Punch`, UPnP/NAT-PMP, relay
  (`RelayBackend`), DHT e, se existir, o proxy SOCKS5/Tor.
- Criptografia: a mídia herda a proteção do protocolo (DTLS-SRTP do WebRTC por
  baixo, ou a sessão E2E do forge se o caminho for pelo motor). **Não baixe o
  nível de proteção em nenhum cenário** — inclusive nos modos proxy/Tor
  (`getCallPrivacyMode`/`models.ts` já documentam, corretamente, que o ICE do
  browser não passa pelo SOCKS5 do app).
- A UI mostra em qual degrau a mídia está: `direto (ICE)` / `punch` / `relay` /
  `falhou`, e o motivo da falha.

### 5.2 As 3 opções reais (faça um dossiê e **pergunte** antes de construir)

Não invente uma solução de 2 dias para um problema que precisa de servidor.
Escreva um dossiê comparando as três abaixo (custo, risco, o que cada uma compra,
o que cada uma quebra, o que precisa de infra) e **apresente ao dono do projeto
antes de implementar a escolhida.** A direção já está dada (protocolo próprio);
a dúvida é *como*.

> **Antes de decidir, leia `PROMPT_CORRECOES.md` §2.1 ("por que o torrent
> funciona no 4G e o DisTorrent não") e §2.2 ("o proxy").** A decisão de
> infraestrutura é a mesma nos dois prompts: relay próprio num VPS, TURN
> (coturn) no mesmo VPS, ou uma máquina do próprio dono. **Não abra duas
> decisões paralelas diferentes para dado e para mídia** — a resposta barata é
> uma só, e a mesma.

**Opção A — forge-core vira o provedor de ICE (recomendada, menor risco)**
O motor já descobre o mapeamento público e coordena o `Punch`. Faça o WebRTC
**consumir** os candidatos que o forge-core descobriu, em vez dos STUN públicos:
- `forge-core/src/net/stun.rs` (binding-only RFC 5389) + `engine.rs:4043-4057`
  passam a produzir candidatos ICE reais (host/srflx) por peer;
- o `frame Punch` (`engine.rs`, `transport.rs`) já é o canal de negociação —
  troque candidatos por ele, com verificação de conectividade e retry;
- `callManager.handleIce:2147-2190` passa a injetar candidatos de origem forge,
  além dos do WebRTC;
- **mantém** WebRTC (codecs, hardware, `getDisplayMedia`), **troca** a fonte da
  travessia.
- Ainda **precisa** de um degrau de relay para o pior caso (CGNAT duplo/simétrico).
  → combine com a Opção B no degrau final.

**Opção B — relay do próprio DisTorrent servindo de TURN (destrava o 4G)**
O `forge-core` já tem a abstração certa e o ponto de extensão é explícito:
- `forge-core/src/net/relay.rs:98` — `pub trait RelayBackend: Send + Sync`, com
  implementações em `:338` (`MqttRelay`), `:486` (`MultiRelay`), `:679`
  (`PeerRelayBackend`), `:955` (`MemRelay`) e o `RelayStream` em `:1240`;
- `engine.rs:1181` — `set_relay_backend(Arc<dyn RelayBackend>)` já existe e
  `:1230` impede que backend de teste seja sobrescrito (cuidado com isso);
- `engine.rs:1391-1401` — `peer_relay_backend_for()`: o relay peer-a-peer é
  **intermediário por um terceiro peer** e é a prova de que o conceito de relay
  próprio já está no código.
- Caminhos: (i) implementar `TurnBackend` cliente (crate `turn`/`webrtc-turn`) e
  plugar em `MultiRelay`/`active_relay_backend`; ou (ii) expor o `RelayStream`
  server-side com alocação estilo coturn a partir do `host/` (que já é servidor
  HTTP + engine), falando TURN/TCP na 443 (atravessa firewall corporate e
  operadora). Mude o WebView para `turn:<seu-host>`.
- É a **Opção A + relay**, e é o que faz 4G funcionar de verdade.

**Opção C — mídia dentro do túnel E2E do forge (DataChannel sobre o protocolo)**
Trocar o caminho de mídia por `RTCDataChannel` cujo SCTP viaja na sessão E2E do
forge (`transport.rs`: handshake ed25519 + X25519 + ChaCha20Poly1305), com
codificação de mídia no app.
- **Ganha:** um único protocolo, um único relay, criptografia do próprio app,
  funciona em Tor, controle de QoS já existente.
- **Custa:** você joga fora codec nativo, aceleração de hardware, `getDisplayMedia`
  integrado, jitter buffer, FEC, proteção contra perda, e ganha custo de CPU e
  latência. Reimplementar WebRTC dentro do app é o caminho mais longo e o que
  mais quebra.
- **Veredito honesto:** é a opção mais "pura" em termos de promessa do projeto e
  a maisCara em engenharia. Não recomendo como primeira jogada — mas **avalie
  honestamente** e apresente. Se o dono insistir (ele quer "mesmo protocolo"),
  o dossiê precisa mostrar o custo real, não esconder.

**Recomendação do agente:** A + B. Deixa o WebRTC cuidar de codec e hardware,
deixa o forge-core cuidar da travessia. A Opção C fica registrada como
"fase 4, se o dono quiser o modo sem WebRTC algum".

### 5.3 Ordem de execução da Missão B
1. **Medidor primeiro.** Antes de trocar arquitetura, instrumentar: registrar
   `iceServers` usado, `iceConnectionState`/`iceGatheringState`/`selectedCandidatePair`
   (`pc.getStats()`), e o erro real por tentativa. Sem isso, "no 4G" é opinião.
2. **Isolar TURN de terceiros** (`getIceServers:194-230`): remover openrelay do
   padrão, deixar a lista configurável, e **avisar na UI quando não há NENHUM
   degrau de relay configurado** (estado honesto, Requisito 6).
3. **Wire no Rust** (expor candidata/estado do motor para o TS): evento novo em
   `engine.rs:150-165`, ponte em `src-tauri/src/lib.rs:1831-1906` + o evento
   `forge://event` em `:382-397`, alias em `src/services/tauri.ts:293-309`.
4. **Consumir no TS** em `callManager.ts`: `bind:716-806`, `handleIce:2147-2190`,
   `logIceState:610-644`, e a UI de fase (`callPhases.ts:38-73`,
   `CallPhaseBadge.tsx:18-61`) mostrando o degrau real.
5. **Relay/TURN próprio** (Opção B) — depois que 1-4 estiverem medindo, para você
   saber se o degrau anterior já resolve.
6. **Só então** apagar a dependência de openrelay e atualizar os comentários que
   hoje admitem a limitação (`:100-113`).

## 6. Prova (obrigatória, senão é chute)

- **`npx tsc -b` + `npx eslint .` limpos.** Nada de "está quase".
- **Teste de sinalização que existe de verdade:** leia
  `forge-core/tests/call_signaling_e2e.rs` e diga o que ele cobre. Se ele roda com
  `127.0.0.1`/`MemRelay`, ele **não prova** nada de mídia — diga isso.
- **Os e2e Playwright não servem para chamada:** `src/services/browser.ts:1025-1027`
  deixa `callOffer/callAnswer/callIce` como no-op, ou seja, em modo browser **não
  existe sinalização**; `e2e/call-phases.spec.ts:77-78` (esperar "Conectado •")
  é **inalcançável**. Ou você implementa um mock de WebRTC honesto no browser, ou
  você marca essas specs como não-cobertura de mídia. **Não deixe teste verde que
  não prova nada** — foi assim que o projeto chegou aqui.
- **Teste de mídia, de verdade, documentado como passo a passo:** 2 máquinas (ou 1
  máquina + 1 celular) numa rede que **não** é a mesma (para ter NAT diferente);
  uma delas em 4G. Checklist: badge de fase chega a "conectado", áudio sai nos
  dois sentidos (falar e ouvir), vídeo aparece, tela compartilhada aparece e
  **volta para a câmera** ao parar, mute funciona, hangup limpa. Como verificar:
  `pc.getStats()` (pair selecionado, bytes, rtt) e `chrome://webrtc-internals`
  equivalente no WebView (DevTools do Tauri).
- **CGNAT simulado:** se/não existir um ambiente assim, documente como montar
  (container com NAT + servidor atrás, ou duas VMs com masquerade). Sem isso, o 4G
  continua sendo opinião.

## 7. Como reportar (direto e honesto)

Por missão e por item A1–A9 / A2.1–A2.7:
- **Corrigido** + evidência (teste, `arquivo:linha`, print, log).
- **Não corrigido** + por quê (bloqueio de infra, decisão pendente, sem hardware).
- **Não verificável aqui** — diga com todas as letras (ex.: "não tenho como testar
  4G real neste ambiente; o teste X cobre Y").
- Se a "correção" só **esconde** o sintoma (ex.: a UI passar a mostrar OFFLINE em
  vez de a mídia conectar), diga explicitamente. O dono prefere a verdade a um
  placebo — o histórico desse projeto é de feature declarada "REAL (verificado por
  testes automatizados)" no `README.md:10` que não funciona.

Para a Missão B, entregue também o **dossiê A vs B vs C** e **pergunte** antes de
implementar. Nada de construir a Opção C inteira porque "parece mais fiel ao
README" sem o dono ter assinado.

Não diga "pronto" para o que você não testou.

--- FIM DO PROMPT ---

---

## Notas para o Arthur (não vão no prompt)

- **Por que a chamada fica muda:** o `ontrack` joga a faixa de áudio fora
  (`callManager.ts:2077-2128` + `:351`) porque a oferta do chamador é respondida
  **antes** de alguém atender, e o desktop não tem `<audio>` nenhum
  (`ThemeShell.tsx:2218`). No celular tem `<audio>` (`MobileShell.tsx:1019`) — por
  isso "às vezes funciona".
- **A tela compartilha de verdade**, via `replaceTrack` na m-line da câmera
  (`callManager.ts:1876`), e volta pra câmera ao parar (`:1811-1840`) — isso já
  está certo. O que falta: **o áudio da tela nunca é enviado** (`:1888-1897`, o
  `addTrack` só roda se não existir sender de áudio, e sempre existe), não tem
  layout de "tela em foco", e a renegociação é uma corrida de `catch {}` sem fila.
- **Sua exigência faz sentido e é o defeite de desenho mais sério do projeto:**
  a mídia depende de `openrelay.metered.ca` com **senha fixa no código-fonte**
  (`callManager.ts:148-153`) e ~20 GB/mês de cota. Enquanto isso, o motor do
  DisTorrent já tem `trait RelayBackend` (`relay.rs:98`) com 4 implementações,
  `set_relay_backend` (`engine.rs:1181`) e relay peer-a-peer (`:1391`) — a
  infraestrutura de relay que você quer **já existe**, só não está conectada no
  WebRTC. Caminho recomendado: forge-core vira o provedor de candidatos ICE e o
  relay do próprio DisTorrent cobre o pior caso (Opções A+B no prompt).
  A Opção C (mídia dentro do túnel E2E) é a mais fiel à promessa do README e a mais
  cara — jogue fora codec nativo e hardware. Deixei no prompt para você decidir.
- Nada foi empacotado, nenhum APK gerado, nenhum comando longo rodado.
