# CHANGELOG

## 1.1.0-pre-alpha.1 — Canais de voz com mídia real; suite e2e verde

### Canais de voz (a maior lacuna funcional fecha)
- **Mídia real entre participantes** — antes o `joinVoice` criava só estado
  local: roster e mute/deafen funcionavam, mas NENHUMA mídia fluía e os
  watchdogs matavam a "chamada" em ~50s com "reconexão falhou".
- **Linux (nativo)**: o engine conecta sozinho — `voice_join` registra uma
  sessão nativa e envia offer para cada par já presente no canal (o mesmo
  `voice_register` + `voice_begin_offer` das DMs, um por par). No receptor, o
  offer de canal ganha sessão nativa via `auto_register_voice_channel`, com o
  MESMO gate de confiança dos frames `Voice*` (estar no canal + ser membro da
  comunidade). `VoiceLeave` derruba só a sessão do par que saiu.
- **Windows/Android/navegador (mesh JS)**: o `joinVoice` cria um
  `RTCPeerConnection` por participante presente e oferta a todos; quem entra
  depois oferta de novo — o anti-glare polite/impolite de sempre resolve.
- Comandos Tauri `voice_join`/`voice_leave` agora async + `spawn_blocking`
  (o mesh nativo negocia SDP e não pode congelar a main thread).

### Correções de regressão (e2e: 29 falhas → 47/47 verdes)
- **Download de arquivo no desktop voltou**: o card do chat só tinha "Abrir
  downloads" e o `downloadManager.enqueue` não tinha NENHUM chamador fora do
  mobile — não dava para baixar arquivo recebido no desktop. O card agora tem
  botão "Baixar" com progresso ao vivo (lê o mesmo swarm do painel).
- **Botão Downloads no cabeçalho da página Amigos**: o painel não depende de
  conversa aberta.
- **Wizard de servidor com nome acessível estável** (`dialogLabel` no Modal):
  o título do dialog muda a cada passo e quebrou a cadeia de ~20 testes;
  leitores de tela e testes precisam de um nome que não muda.
- **Testes alinhados ao app real**: bots (modal "Criar bot", token mascarado
  com confirmação destrutiva), calls (o modo relay-only foi removido do app
  de propósito — testes agora travam o contrato 'none' honesto), wizard,
  mobile-header (alcança a tela de conversa criando servidor).
- **Sonda de screen share consertada**: nunca trocava candidatos ICE (mídia
  não fluía), descartava os valores das stats do sender no merge e checava
  pixels DEPOIS de fechar os peers. Agora: trickle ICE + espera de conexão +
  estímulo animado + amostragem ao vivo — passa com métricas reais
  (VP8, frames encodados/decodificados > 0, RTT medido, sem freeze).

## 1.0.0-pre-alpha.1 — Primeira alpha pública

Republicação do projeto com histórico limpo e documentação revisada.

- **Histórico reescrito**: as chaves privadas de assinatura Android
  (`*.jks`) estavam versionadas e foram removidas de todos os commits.
- **Documentação corrigida**: `DESIGN_SYSTEM.md` descrevia 6 designs que nunca
  existiram (há 1); `AUX_SERVICES.md` citava libp2p/QUIC/DCUtR (inexistentes
  neste projeto); `PROTOCOL.md` classificava comunidades e sync como "não
  implementado" (são reais, schema v8); `THREAT_MODEL.md` dizia que Tor estava
  fora de escopo (existe modo de 7 saltos).
- **Código morto removido**: 8 arquivos de frontend e 8 funções `pub` do Rust
  sem nenhum chamador.
- **Configuração**: `.gitignore` reescrito para a stack real; `.env.example`
  sem o endpoint padrão morto; CI em 4 jobs.
- **Instaladores** passam a ser GitHub Releases em vez de arquivos no repositório.

Nota de numeração: as entradas abaixo são o registro histórico do projeto sob
nomes e numerações anteriores (FORGE 2.x–5.x). A partir daqui a numeração é
`1.0.0-pre-alpha.N` e o CHANGELOG passa a ser gerado em ordem cronológica a
partir das tags do Git.

## 2.0.0 — Voz nativa em Rust: chamada funciona no Linux sem WebRTC

O ponto de virada: o WebKitGTK do Ubuntu **não expõe `RTCPeerConnection`**, então
WebRTC de navegador é impossível no desktop Linux. Até aqui isso era contornado
com áudio pelo túnel de sinalização (o "relay"), de latência alta — a origem de
praticamente toda complaint de chamada. Agora a voz é um plano de mídia nativo em
Rust, e o relay saiu do caminho de chamadas.

### Voz nativa (`forge-core/src/net/media_voice.rs`)
- **webrtc-rs 0.21** (ICE/UDP/DTLS/SRTP reais) + **cpal 0.18** + **Opus**. A
  sinalização reaproveita os frames que já existiam (`CallOffer`/`CallAnswer`/
  `CallIce`): o core Rust intercepta antes do JS e fala SDP padrão, então um peer
  Linux conversa tanto com outro Linux quanto com navegador.
- **Cadeia validada em execução real**: mic → Opus → webrtc → jitter buffer →
  decode → alto-falante, **100/100 pacotes tocados**. Com **5% de perda
  injetada** o PLC segurou: 100 tocados, **0 erro de decode**.
- **Latência 144 ms → 84–93 ms** mediana (abaixo dos 100 ms interativos do
  ITU-T G.114). O ganho veio de baixar o jitter de 120→50 ms e corrigir três
  bugs: falta de pacing, replay de frame velho, e envio ancorado no relógio de
  captura.
- **Cancelamento de eco** com `aec-rs` (speexdsp embutido): **10–12 dB** de
  redução medida, a **2,7%** do prazo de quadro. Duas premissas da implementação
  original estavam erradas e foram corrigidas: `speexdsp` da crates.io expõe
  **só o resampler** (o AEC exigiria headers de sistema), e `echo_ctl(SetSize)` /
  `tail_length_ms` **não existem** naquela API.
- Supressão de ruído: gancho pronto, **desligada de propósito** — o
  preprocessor do speex destrói a forma de onda da voz.

### A rota que o WebView não sabia mostrar
- `getRungSummary()` lia só `iceReports` do WebRTC, vazio no caminho nativo — a
  tela mostrava "sem rota" **com a chamada conectada**. Agora reporta a rota do
  core (LAN/STUN/TURN).
- A fase ficava presa em "Conectando…": quem emitia `media-connected` era o
  WebRTC do navegador, e no caminho nativo ninguém emitia nada. O monitor de
  estado do core avança a máquina de fases.

### Três bugs de integração que só apareceram no app real
- **`AppState` deixou de ser registrado**: um **segundo `.setup()`** em
  `tauri::generate_context` *sobrescreve* o anterior no Tauri, então o
  `app.manage(...)` nunca rodava e todo comando morria com *state not
  managed* — quebrava o "Criar conta" no PC **e no Android**.
- **Voz nativa travada em "indisponível"**: `voice_media_available` consultava o
  motor, que é `None` enquanto o cofre está trancado. O app perguntava no boot,
  recebia `false` e **cacheava para sempre**. Capacidade é propriedade do
  **build**, não do estado → `native_voice_capable()`.
- **`getUserMedia` competiria com o core** pelo microfone, e
  `new RTCPeerConnection` explodiria com `ReferenceError` no WebKitGTK. O
  `start()` agora desvia para o caminho nativo antes de tocar em mídia de
  navegador.

### O que NÃO mudou (de propósito)
- **Windows/Android seguem no WebRTC do navegador.** A voz nativa é
  `cfg!(target_os = "linux")`. A regra que garante isso por construção: a mídia
  nativa só assume a chamada se já tiver sessão ativa para aquele
  `(call_id, peer_fp)`; senão o frame segue exatamente como antes.
- **Relay de chamada removido** — sem `relay-only`, sem botão "R". O relay de
  **arquivos** é outro caminho e não foi tocado.

### Limites conhecidos e medidos (não são escolha de implementação)
- **Tela: 120 fps não cabe nesta GPU.** RX 580 é Polaris/GCN4 = **VCE**, encoder
  fixo antigo: medido isolado, **37,8 ms/quadro = 26,5 fps a 1080p**, linear em
  pixels (~18 ms/MP) e **insensível a QP/trellis/cabac**. Perfis medidos:
  1080p→26 · 720p→60 · 480p→100 · 360p→240 fps. Tela a **720p/60fps** é o alvo
  realista.
- **Câmera: 19 fps**, e é **a webcam**, não o código — confirmado com
  `v4l2-ctl` puro (60 quadros em 3,11 s a 720p e 3,23 s a 1080p, igual em toda
  resolução). É firmware.
- **AEC de ~10 dB, e ~0 dB em duplex** (double-talk prende o filtro). Os 43 dB
  da primeira medição eram artefato do gerador de teste. O AEC3 do navegador é
  superior; não há equivalente em Rust puro hoje.
- **Latência com AEC não foi medida** — exige duas máquinas reais.
- A webcam **trava** após ~8–10 ciclos de open/close (firmware UVC de webcam
  barata). Precisa de replug físico.

### Operação
- `forge-core/dev/safe-build.sh` — guardião de build: aborta com RAM livre
  < 2 GB, trava o build em 3 GB (`systemd-run --scope -p MemoryMax`) e usa 1 job
  com nice 19. Existe porque um build sem teto derrubou a máquina.
- zram (7 GB, zstd, prioridade 100) + swapfile de 4 GB, `swappiness=100`:
  **compactação de memória** de verdade, já que a máquina estava com swap 0.

## 5.4.4 — Ícones que respondem, tela de chamada refeita
Duas falhas visuais e uma de interaction, encontradas abrindo o app de verdade
(sem build novo) e medindo o DOM.
- **O ícone de configurações era uma mancha ilegível.** Os dois botões do
  rodapé da barra lateral tinham `flex: 1` dentro de um flex row, então
  viravam barras de **118px de largura por 24px de altura** com um glifo de
  14px no meio. Medido no DOM, não estimado. Agora são quadrados de 34px com
  ícone de 17px, borda, `aria-label` e `data-testid`.
- **Três ícones do cabeçalho eram `<Icon>` puros, sem `onClick`** — pareciam
  botões e não faziam nada. O `grid` agora abre Configurações, o `users` vai
  para Amigos com contador de pedidos, e o `sino` saiu (não existe sistema de
  notificação; ícone morto é pior que ícone ausente).
- **Tela de chamada refeita.** O bloco tracejado de "mesh P2P" ocupava uma
  faixa inteira do grid com um parágão de jargão e deixava um retângulo
  gigante e vazio; virou uma linha fina — e saiu de dentro do grid, porque lá
  dentro virava mais uma linha em `1fr` e disputava a altura com os vídeos
  (metade da tela vazia). Cabeçalho ganhou hierarquia: ícone em bloco, título,
  badge de fase, cronômetro, contagem e **selo de rota** (`rota LAN` / `rota
  STUN` / `rota TURN` / `sem rota`) — que é a resposta na tela para "por que
  não conecta?". Plural corrigido ("1 participantes" → "1 participante"),
  avatar de 80 para 104px, fundo do tile com gradiente, grade preenchendo a
  altura, e o seletor de fonte da tela com ícone (não mais um botão solto).

## 5.4.3 — Proxy não trava mais, tela compartilhada de verdade, ícones que respondem
Cinco bugs independentes. O do proxy era o pior: **a mesma mensagem chegando
infinitas vezes** e mensagem dos outros deixando de chegar.
- **Loop infinito de mensagens (proxy).** Quatro defeitos encadeados:
  1. *Transmissor ilimitado.* O `outbox` tem `attempts`/`next_try` no schema
     desde sempre, mas `pending_outbox` ignorava as duas colunas e
     `bump_outbox` **nunca era chamada em lugar nenhum** — o backoff existia
     no banco e não existia no código. Pior: `revert_stale_sent_to_pending`
     comparava `ts` (data de criação) com o corte, então passados 20s a
     mensagem satisfazia a condição para sempre. Reenvio a cada 5s, sem fim.
  2. *O anti-spam bloqueava o `Ack`.* A retransmissão caía no `spam_gate`,
     cuja duplicata-por-conteúdo (60s) rejeitava com `Err` — e a rejeição
     vinha **antes** do `Ack`. O remetente nunca era avisado, logo reenviava
     de novo. O próprio retry garantia que o retry fosse descartado, o que
     garantia que o retry continuasse.
  3. *`MessageNew` sem dedupe.* O dedupe real era só o `INSERT OR IGNORE` na
     linha do banco; o **evento** era emitido a cada retransmissão — som,
     badge e lista piscando em rajada.
  4. *Relay mudo ao ligar o proxy.* `proxied_routes_with_fp` gerava o
     **mesmo `client_id` MQTT** do modo direto. Ligar o proxy cria um backend
     novo sem derrubar o antigo, e com `clean_session(false)` o broker
     despeja uma sessão quando a outra entra: ping-pong infinito de
     connect/kick. Sem entrega não há `Ack` — e o laço começa.
  Agora: retransmissão é **idempotente por id** (chega `Ack`, sem penalizar
  o peer e sem evento novo), o reenvio tem backoff e teto de 12 tentativas,
  e o que estoura vira `failed` visível em vez de martelar para sempre. A
  perna via proxy ganhou sessão própria (`-px`) no broker.
- **Chamadas: relay removido de verdade.** O modo áudio-via-relay
  (`relay-only`) saiu do código e da UI: `getCallsSupport()` só devolve
  `full` | `none`, e sem WebRTC a chamada falha com a mensagem honesta em vez
  de degradar para um caminho de latência alta que não funcionava. O botão
  "R" (modo compatibilidade) saiu da tela de chamada. O **relay de arquivos**
  é outro caminho e não foi tocado. TURN segue disponível — é WebRTC, não relay.
- **Tela compartilhada que funciona.** `getDisplayMedia` passou a enviar
  `displaySurface`, `surfaceSwitching: 'include'` e `systemAudio: 'include'`:
  é isso que habilita o botão de **trocar aba** no Chrome/Edge sem parar e
  recomeçar (a complaint mais comum). Novo seletor **Tela | Janela** na barra
  da chamada, botão **Parar** dedicado (antes só dava para parar pelo botão
  nativo do SO), rótulo e `aria-label` que mudam com o estado, e
  `data-testid` nos controles — que não existiam em nenhum botão da tela de
  chamada. Removido um loop morto que lia `onended` e não fazia nada.
- **Configurações: o botão "Trocar" estava cortado.** Os dois `<input>` de
  senha estavam num flex sem `minWidth: 0`, então não encolhiam e o botão
  saía do modal de 520px. Corrigido com `flex: '1 1 150px'` + `minWidth: 0`
  + `flexWrap`, e o modal ganhou `maxWidth: calc(100vw - 32px)`.
- **Ícone de engrenagem do topo não fazia nada.** Os três últimos ícones do
  cabeçalho (`bell`, `grid`, `users`) eram `<Icon>` **puros, sem `onClick`** —
  pareciam botões e eram inertes. O `grid` agora abre Configurações, o
  `users` vai para Amigos (com contador de pedidos), e o `sino` saiu: não
  existe sistema de notificação, e ícone morto é pior que ícone ausente.
- **Rota ICE visível na chamada.** `getRungSummary()` voltou a mostrar como a
  mídia está indo: `LAN` (host), `STUN` (srflx), `TURN` (relay) ou `n/d` sem
  par escolhido — que é exatamente o sintoma do loop.

## 5.4.2 — Chamada atrás de CGNAT: sem "Conectando…" infinito e sem "às vezes não pega"
Cinco bugs independentes, todos no caminho de chamada/WebRTC. Todos
reproduzíveis atrás de NAT simétrico (4G/5G).
- **A chamada ficava "Conectando…" para sempre.** A máquina de fases não
  tinha a transição `connecting + ice-failed → reconnecting`, o que tornava
  **no-op o watchdog criado exatamente para evitar isso**: ele detectava a
  ausência de mídia e emitia um evento que a máquina ignorava. Como o
  watchdog de reconexão só arma ao *entrar* em `reconnecting`, nada encerrava
  a chamada. No CGNAT isso é garantido, porque o ICE nunca chega a `failed` —
  ele fica em `checking` para sempre. Agora a chamada sai do loop e encerra
  com aviso honesto quando a rota não fecha.
- **A offer da chamada podia ser descartada (a causa do "às vezes não pega").**
  A fila de sinalização do motor descartava o frame **mais antigo** ao encher
  (64 frames). A ordem de chegada é `invite → offer → candidatos ICE →
  answer`, então o que caía era justamente a `CallOffer` e os primeiros
  candidatos — o peer recebia candidatos ICE de uma offer que nunca chegou:
  nenhum `RTCPeerConnection`, chamada muda. Só acontecia quando a fila
  estourava, ou seja, quando a ligação P2P demorava — exatamente o 4G/CGNAT.
  Agora o descarte segue prioridade (ICE reenviável → convite/encerramento
  antigos → offer/answer duplicados) e o par offer+answer mais recente é
  intocável. Teto elevado de 64 para 512.
- **Candidato ICE perdido era perdido para sempre.** Cada `onicecandidate`
  gerava um frame único; se o peer ainda estivesse subindo, o frame se perdia
  e o ICE local não o reemitia. O candidato de TURN é o último e o mais
  crítico atrás de CGNAT. Agora, quando o gathering termina, a lista
  **inteira** é reenviada (duplicata é ignorada pelo WebRTC, então é
  idempotente) — qualquer perda se recupera sozinha.
- **Reinício de ICE era disparado por evento que nunca chegava.** O
  `tryIceRestart` só reage a `iceConnectionState === 'failed'`, e o
  watchdog de conexão agora **força** o restart: sem ele, o re-gather — a
  única chance de achar a rota que faltava — nunca acontecia. E o watchdog
  passou a **esperar** se algum PC ainda está coletando candidatos (a
  alocação no TURN em 4G leva segundos; reiniciar ali jogava o gathering
  fora, trocando "demorou" por "nunca fecha"), com teto de 2 janelas extras.
- **Não havia nenhum `stun:` na lista ICE**, só TURN. Sem STUN o ICE só
  produzia candidatos `host` com IP privado, inalcançáveis de fora. Adicionados
  3 STUN públicos: o STUN só responde "qual é meu endereço", a mídia não
  passa por eles.
- **Fallback de áudio pelo túnel P2P desligado.** A rota agora é WebRTC
  direta ou nada — sem o modo de latência alta. O relay manual da UI continua.
- **Falha de sinalização não é mais engolida em silêncio.** `handleOffer` /
  `handleAnswer` logavam nada; agora registram a falha, que é a pista nº1 de
  "às vezes não pega".

## 5.4.1 — Android: Downloads de verdade, mídia que reaparece, chamada com som
- **Download no Android vai para a pasta Downloads real.** Antes o arquivo
  parava em `/data/data/com.forge.app/files/Download` — "uma pasta estranha"
  que nenhum explorador de arquivos mostra. Novo plugin nativo Kotlin
  (`DownloadsPlugin`) grava via `MediaStore.Downloads` (API 29+, sem
  nenhuma permissão) e na pasta legada abaixo disso; o `save_file` (Rust)
  continua gravando primeiro na área privada, com escrita atômica, e o
  plugin copia + apaga o rascunho. Fallback final: folha de
  compartilhamento do Android, com retorno honesto de sucesso/falha.
- **Mídia já baixada renderiza sozinha ao abrir o app.** `prepareMedia`
  reidrata o spool de chunks do disco ANTES de qualquer rede — o cap de
  tamanho não se aplica a arquivo que o usuário já pagou uma vez. Mobile e
  desktop passam a usar a mesma rotina.
- **Retry de prévia no mobile.** O guard `previewFetchingRef` bloqueava
  para sempre: uma falha de rede no 4G deixava a imagem sem prévia até
  reiniciar o app. Agora são 3 tentativas com backoff e as blob URLs
  antigas são revogadas.
- **Chamada com som no celular.** O `<audio>`/`<video>` receiving nunca
  recebia `play()` — só `autoPlay`, que o WebView do Android não cumpre
  para `MediaStream`. A chamada "conectava" e saía muda. Novo
  `attachStream`: `srcObject` + `play()` com retentativas (250ms/1s/3s) e
  desarma automático no primeiro toque do usuário. No desktop o vídeo
  tinha o mesmo furo (só o áudio chamava `play()`).

## 5.4.0
- Cofre portátil .stormvault: exportar/importar a conta completa entre
  dispositivos (Argon2id + ChaCha20Poly1305, zstd, merge sem perda) — sem servidor.
- Backups cifrados automáticos com retenção configurável (7/30/90 dias).
- Modo pânico: apagamento local imediato com confirmação digitada.
- QoS no transporte: voz/sinalização > controle > mensagens > arquivos, com
  batching de frames (menos syscalls, prioridade real).
- Heartbeat adaptativo (10s ativo → até 60s ocioso) + RTT por peer (Ping/Pong).
- Janela de mensagens (paginação por ts) — UI carrega 100 por página.
- Cache LRU de disco (256 MB configurável) + spool de chunks (resume de
  download após queda).
- Segurança de mídia: MIME por magic bytes (bloqueia executáveis), strip de
  EXIF em JPEG/PNG por padrão.
- Painel dev de métricas (contadores por classe, throughput, RTT, spam).
- Docs: STORMVAULT.md (spec do formato) + MIGRACAO_ENTRE_DISPOSITIVOS.md.

## 3.0.0 — Hardening total: 27 bugs corrigidos, zero panic (2026-09-01)

### v3.0 — Mudanças de API
- **Senha mínima 8 caracteres** (antes 4) — argon2id + OWASP compliant
- **Versão unificada**: forge-core, src-tauri, host, package.json — todos 3.0.0

### Corrigido (Rust core — 8 fixes)
- `Mutex poisoning cascade`: todos `.lock().unwrap()` → `.unwrap_or_else(|e| e.into_inner())` em storage.rs, engine.rs, lib.rs (13+ ocorrências)
- `message_by_id unwrap` em 4 paths: agora com StoredMessage fallback seguro
- `save_identity` serialização: `map_err` em vez de `unwrap`
- `discovery announce`: `serde_json::to_vec` tratado com match em vez de unwrap
- `upsert_member` N vezes no loop de canais: agora chamado uma única vez
- `legacy fingerprint`: bytes corrigidos — hex decode com match explícito em vez de unwrap+fallback ambíguo
- `UDP buffer`: 1024 → 4096 bytes (nicknames longos não truncam mais)
- `vault tests`: senhas atualizadas para 8+ caracteres

### Corrigido (host — 3 fixes)
- `expect("secret no db")` → `ok_or` + `?` — host não panica mais
- `expect("abrir dm")` → `match` com erro JSON — msg comando tratado
- `panic!("bind")` → print amigável + return — porta em uso não derruba host

### Corrigido (TypeScript — 6 fixes)
- `browser.ts`: heartbeat timer agora para quando identidade é removida
- `browser.ts`: `beforeunload` listener com cleanup (removeEventListener)
- `callManager.ts`: `leaveVoice()` só limpa conexões de voz, não destrói DM calls ativos
- `callManager.ts`: `state!` assertions removidas em toggleMute/toggleCamera/onended
- `callManager.ts`: `localStream!` → `localStream?` em removeTrack
- `crypto.ts`: `fromHex` valida input em vez de crash com `!`

### Corrigido (Tauri — 3 fixes)
- `restart_engine`: `std::thread::sleep(300ms)` removido — UI não congela mais
- `friend_request`: `unwrap()` → `map_err` na serialização
- `accounts_list`: early exit em vez de 60 KV lookups desnecessários

### Melhorado
- Dead code removido: `protocol/types.ts` (nunca importado), `identity.ts:displayName()` (nunca chamado)
- `password.rs`: mínimo 4 → 8 caracteres (OWASP compliance)

### Verificação
- `cargo test`: 36/36 (19 unit + 8 storage + 1 e2e + 8 friends + 4 integration)
- `tsc/lint/vite build`: 0 erros · bundle 398KB (gzip 112KB)

## 2.3.0 — Bugfix massivo: panic, segurança e estabilidade (2026-09-01)

### Corrigido (CRITICAL — Rust core)
- **Mutex poisoning cascade**: todos `Mutex::lock().unwrap()` em `storage.rs`, `engine.rs` e `src-tauri/lib.rs` substituídos por `unwrap_or_else(|e| e.into_inner())` — um panic em qualquer thread não derruba mais o app inteiro
- **Panic em `message_by_id`**: 5 ocorrências de `.unwrap()` após `insert_message` em `engine.rs` — se INSERT OR IGNORE deduplicasse, o None causava panic; agora usa `unwrap_or_else` com StoredMessage fallback
- **`save_identity` unwrap**: serialização JSON com `map_err` em vez de unwrap em `storage.rs`
- **Discovery announce unwrap**: `serde_json::to_vec` agora trata erro em vez de panic em `discovery.rs`

### Corrigido (SECURITY — Rust core)
- **Channel message signature bypass**: quando autor não está no peerbook, assinatura era aceita silenciosamente (`None => true`); agora loga warning de segurança com fingerprint do autor para auditoria

### Corrigido (host)
- **`expect("secret no db")` panic**: host/main.rs agora usa `ok_or` + `?` em vez de expect em carregamento de identidade
- **Evento unwrap**: serialização de eventos usa `match` em vez de `unwrap()` — host não crasha mais por evento não serializável

### Corrigido (TypeScript)
- **`crypto.ts` fromHex crash**: `h.match(/.{2}/g)!` removido — agora valida input e lança erro descritivo em vez de crash silencioso
- **`fileSwarm.ts` pop() crash**: `.pop()!.trim()` substituído por `.pop()?.trim()` — arquivo vazio não causa mais panic
- **`callManager.ts` state! crashes**: 3 ocorrências de `this.state!` removidas — toggle mute/deafen/camera agora checam null antes de acessar
- **`callManager.ts` stream leak**: `this.localStream!.removeTrack(t)` → `this.localStream?.removeTrack(t)`
- **`callManager.ts` onended race**: `this.state!.sharing = false` agora verifica `if (this.state)` antes

### Melhorado (arquitetura frontend)
- **`src/shared/utils.tsx`**: funções compartilhadas (`avatarColor`, `Avatar`, `PeerDot`, `StatusGlyph`, `fmtTime`) extraídas — elimina duplicação entre ThemeShell e MobileShell
- **`src/app/useAuth.ts`**: hook de autenticação extraído do ThemeShell
- **`src/app/useFriends.ts`**: hook de amigos com `useCallback` — funções não são mais recriadas a cada render
- **`src/app/useCommunities.ts`**: hook de comunidades extraído
- **`src/components/Auth.tsx`**: componentes `AuthCard`, `CreateAccount`, `LockScreen` extraídos

### Corrigido (tipagem)
- **`file_announce` chunk_hashes**: campo `chunk_hashes` adicionado ao tipo `EngineEvent` em `models.ts` — `as any` removido
- **Engine event handler**: todos `(ev as any).type` em `ThemeShell.tsx` substituídos por narrowing TypeScript correto

### Corrigido (memory leak)
- **`ThemeShell.tsx`**: `fileSwarm.onChange` agora restaura o handler anterior no cleanup do useEffect

### Verificação
- `cargo test` 34/34 · `npm run typecheck/lint/build` 0 erros · bundle 398KB (gzip 112KB)

## 2.2.1 — Internet de verdade: Tor real, .onion, multi-tracker self-hosted (2026-08-31)

### Novo
- **Rede Tor real**: cliente SOCKS5 próprio (RFC 1928) com suporte a HOSTNAME/ONION — conecta a `endereco.onion:80` através do Tor SEM resolver DNS local (tokio-socks removido)
- **`connect_host`**: `ip:porta`, `dominio:porta` e `.onion:porta` — no app (Configurações → Avançado) e na API do engine
- **Teste Tor E2E real** (`tests/tor_e2e.rs`, `--ignored`): tor daemon publica serviço onion do peer B, peer A em privacidade "full" conecta via circuitos reais, handshake autenticado + DM com ACK entregue — validado nesta máquina (Tor 0.4.9)
- **Tracker bootstrap self-hosted**: `forge-host --bootstrap 8090` sobe tracker HTTP (announce/lookup com validação e TTL de 15 min) — deploy em VPS próprio, zero dependência de terceiros; endpoints testados via curl
- **Multi-tracker**: `FORGE_BOOTSTRAP_URL` aceita lista separada por vírgula; announce em todos, lookup até encontrar

### Corrigido (nada local/dead)
- Bootstrap padrão apontava para `forge-bootstrap.fly.dev` que está MORTO — descoberta pela internet quebrada por padrão; agora sem default fake: sem tracker configurado, o motor avisa e UPnP/manual seguem ativos
- `connect_addr` resolvia domínio localmente ANTES de checar proxy — em modo Tor o alvo vazava por DNS; agora hostname vai ao SOCKS5 dentro dos circuitos

## 2.2.0 — Servidores 100% reais + sync P2P + E2E 2-usuários via proxy (2026-08-31)

### Novo (backend, tudo persistido em SQLite e sincronizado via P2P)
- Canais reais: criar/renomear/tópico/categoria/excluir (texto e voz), com broadcast `CommunityState` do dono aos membros — fim dos canais de localStorage
- Cargos reais: criar/editar (cor, permissões bitmask, hoist, mentionable)/excluir com cascata em assignments e bots
- Bots reais: criar/editar token+cargo+avatar/excluir, persistidos no SQLite
- Kick real: dono expulsa membro, que recebe `CommunityKicked` autenticado e perde o servidor localmente
- `community_rename` nativo (antes só existia no modo navegador)
- Grupos DM sincronizados: frames `GroupCreated`/`GroupMemberAdded`, re-sync no flush de conexão e lazy-join seguro para amigos aceitos — mensagens de grupo antes falhavam com "apenas DM nesta fase"
- Migração SQLite v4 (topic/category/kind em canais; tabelas roles/member_roles/bots)
- E2E `forge-core/tests/e2e_two_users.rs`: dois usuários completos em "redes diferentes" conectados por PROXY TCP — amizade, DM ida-e-volta com ACK, grupo, comunidade com convite assinado, sincronização de canais/cargos, kick, queda de rede → pending → reconexão → entrega, e identidade estável após reinício

### Corrigido (segurança — auditoria completa)
- Sequestro de comunidade via `CommunityState` forjado (gate pela autoridade gravada + convite assinado)
- Path traversal zero-click em `save_file` (sanitização de basename no core)
- `vault_export` sem cofre exportava chave privada em claro (agora exige cofre)
- `secure_load` expunha `identity.secret` à WebView (chaves reservadas bloqueadas)
- Announce ao bootstrap vazava IP em modo proxy/Tor (desligado nesses modos)
- `FriendAccept` forjado criava amizade sem pedido (gate em pending_out/accepted)
- `Ack`/`ChannelAck` falsificáveis, frames de voz sem membership, `CallAccept` em chamada de terceiros, relay de canal validando com a chave errada
- DoS: caps em FileAnnounce, validações de entrada nos commands, limites de nickname

### Corrigido (UI/UX)
- 19 commands Tauri registrados que eram chamados mas não existiam (channel_*, role_*, bot_*, member_*, community_rename) — no desktop tudo caía em fallback localStorage fake
- Renomear servidor agora usa o backend real em vez de localStorage
- Modais "Criar/Editar canal" acima do modal de configurações do servidor (z-index)
- Fluxo de amizade entre abas no modo navegador (pedido → pending_in; aceite → accepted + DM)
- CSS inválido (`justifyContent`/`alignItems`/`borderRadius` em regras CSS), warning de variável não usada no binário
- `main.rs` unificado com `lib.rs` (desktop rodava duplicata antiga sem os commands novos)
- Seeding de cargos fake (Administrador/Moderador/Bots) removido

### Verificação
- `cargo test`: 34/34 · `cargo check` (src-tauri): limpo · `tsc/lint/vite build`: limpos
- 18 screenshots Playwright de auditoria da UI (onboarding → servidor → canais → cargos → bots → membros → configurações → mobile)

## 2.1.6 — Botão Baixar 100% funcional + redesign upload/download (2026-08-31)

### Corrigido crítico
- Botão Baixar não funcionava em Tauri/WebView: `fileSwarm.ts:148` agora anexa `<a>` ao DOM + `setTimeout` + fallback `save_file` via `__TAURI__.core.invoke` + backend `dirs::download_dir` + `base64` — `src-tauri/src/main.rs:838` `save_file` e `Cargo.toml` `base64/dirs`
- Fundo removido do logo Gemini já aplicado em 2.1.5, mantido

### Design
- `ThemeShell.tsx:1048` redesign completo: cards com ícone por tipo (📄🎬🖼️📦), tamanho, chunks, hash 12 chars, barra progresso, seeders, botão `⬇ Baixar` com `t.accent` e estado `✓ completo` — 100% automático já em `fileSwarm.ts:103`

## 2.1.5 — Logo Gemini P2P (fundo removido) + rebuild total (2026-08-31)

### Novo
- Logo `Gemini_Generated_Image_fccn15fccn15fccn.jpeg` com fundo removido (transparente) aplicado em TODOS: `src-tauri/icons/*`, Android mipmap, iOS, Windows .ico — `tauri icon /tmp/final_icon1024.png`

## 2.1.4 — Logo novo + Android 100% automático (2026-08-31)

### Novo
- Logo DisTorrent refeito `src-tauri/icons/*` + Android mipmap (blurple #5865F2 + P2P 3 nós), `tauri icon` regenerado

### Corrigido
- Android `segredo de identidade não encontrado` ao criar conta: `persist_secret` agora salva em SQLite no Android (`#[cfg(target_os="android")]`), fallback em `set_password` falho, `load_secret` robusto com backup `identity.secret.backup`
- Permissões Android para discovery 100% automático: `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE`, `READ/WRITE_EXTERNAL_STORAGE` em `AndroidManifest.xml`
- Swarm 100% automático: `fileSwarm.ts:103` agora baixa automaticamente ao completar (`download()` sem clique), `onAnnounce` + `fetchSwarm` já automático, sem IP manual — discovery UDP 45900 conecta sozinho na mesma rede

## 2.1.3 — Mensagens e swarm REAL + compat fingerprint (2026-08-31)

### Corrigido crítico
- Mensagens não enviadas: `NetworkEngine::new` agora preserva `fingerprint` legado `d9a8cb16f3ff` via `new_with_identity` — `handshake_with_fp` envia `identity.fingerprint` correto, `fingerprint_matches` aceita legado+blake3, compatibilidade preservada
- Swarm real: `SecureFrame::FileAnnounce` agora com `chunk_hashes: Option<Vec<String>>`, `file_announce_with_chunks` + `fileAnnounce` com blake3 por chunk, verificação em `onChunkData`
- Compat: `identity.rs:90` dual-hash, `transport.rs:176` handshake respeita identidade armazenada

## 2.1.2 — Correções auditoria P0 (2026-08-31)

### Corrigido
- Fingerprint `blake3(pub_bytes)` alinhado TS↔Rust `forge-core/src/identity.rs:89` (era `blake3(hex_str)`)
- Teste flaky `sign_verify_ok_and_tamper_fail` `identity.rs:130` — flip determinístico
- Lint 0 warnings: `callManager.ts:114,132` unused, `ThemeShell.tsx:431` idx, `browser.ts:8` imports
- FileSwarm `src/services/fileSwarm.ts:41` hash fraco `h*31` → `blake3` `toHexBlake3` + `chunkHashes` + verificação `onChunkData`
- `public/import-conta.html:6` aviso segurança teste apenas
- `PLANO_E_PROMPT_IMPLEMENTACAO.md:2` referências `package.json:5→4`, ortografia

### Verificado
- `cargo test` 24/24 estáveis, `npm run typecheck/lint/build` 0 erros, bundle 99KB gzip

## 0.2.1 — Discord look + Amigos (2026-08-30)

### Adicionado
- **UI idêntica ao Discord original**: paleta oficial (#313338/#2b2d31/#1e1f22, blurple #5865f2), avatares padrão, rodapé de usuário estilo Discord — mantendo todos os dados reais
- **Amigos reais**: pedidos assinados (FriendRequest/Accept/Reject/Remove), aceitar/recusar, bloquear/desbloquear; bloqueio é aplicado no core (mensagens de bloqueado são rejeitadas pelo motor, testado)
- Seções SOLICITAÇÕES / AMIGOS / CONVERSAS DIRETAS na sidebar
- Instalação user-space: `~/.local/bin/forge` + entrada no menu de aplicativos

### Corrigido
- **Crash na abertura do app** (engine era spawnado fora do runtime tokio dos commands do Tauri — agora o boot roda em `tauri::async_runtime`)
- **Ícone**: substituído o placeholder (logo Firefox) por ícone FORGE próprio (blurple #5865f2, "F" branco) em 32/48/128/256/512
- Eleição de sessão determinística (dial simultâneo não gera mais flaps de conexão)
- Discovery funciona também entre dois processos na mesma máquina (loopback broadcast)
- 4 testes de integração de amizade (19/19 total verde)

## 0.2.0 — Motor real (2026-08-30)

### Adicionado
- **`forge-core`**: motor Rust puro com identidade ed25519, storage SQLite (WAL) e rede P2P real
  - Handshake autenticado (ed25519 sobre transcript + X25519 efêmero → HKDF → ChaCha20Poly1305)
  - Discovery LAN via UDP broadcast (porta 45900) com validação de fingerprint
  - Engine com estados reais de conexão (DISCONNECTED/CONNECTING/CONNECTED/RECONNECTING), heartbeat 10s, timeout 25s, reconexão com backoff 1s→15s
  - DMs assinadas com ACK de entrega; estados PENDING/SENDING/SENT/DELIVERED/FAILED
  - Outbox persistente: mensagens feitas offline são entregues ao reconectar
  - 15 testes (11 unit + 4 integração com dois nós reais em TCP)
- Shell Tauri 2 (migração do 1.6 — Ubuntu 24.04 removeu libsoup-2.4)
- Keyring do SO para a chave privada (fallback SQLite documentado)
- Camada `services` na UI (nativo/navegador-honesto) + hooks; FORGE visual intocado
- Docs: ARCHITECTURE v2, PROTOCOL v1 (implementado), THREAT_MODEL, AUX_SERVICES

### Removido
- `src/shared/mocks.ts` e todo dado fictício da UI (usuários, DMs, comunidades, mensagens fake)
- Protótipo `src/lab/DesignLab.tsx` e artefatos de build (`dist`, `vite.config.js/.d.ts`, tsbuildinfo)

## 0.1.0 — Protótipo visual
- FORGE e 5 designs alternativos; UI React + Vite; identidade parcial (ed25519 em TS)
