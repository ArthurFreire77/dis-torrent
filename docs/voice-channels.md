# Canais de chamada (voz e vídeo)

**Atualizado em 2026-11-02.** O que o código faz hoje, incluindo o que não
funciona em cada plataforma.

## Um caminho só

Canal de **voz** e canal de **vídeo** entram pela mesma função:
`CallManager.joinVoice(communityId, channelId)`. A diferença é o `kind` que vai
no estado:

- `voice` → áudio apenas; câmera ligada depois pelo botão da chamada;
- `video` → câmera tentada na entrada (`getUserMedia` com vídeo), com fallback
  para só áudio se a câmera falhar.

Ver `src/app/channels.ts` (`isCallableChannel`) e `src/services/callManager.ts`
(`joinVoice`).

## O que acontece ao entrar

1. `detectNativeVoice(true)` decide o caminho de mídia (ver tabela abaixo).
2. `services.voiceJoin(cid, ch)` anuncia a presença: grava em `voice_states` e
   manda `VoiceJoin` para os membros com sessão online.
3. O roster é semeado a partir de `voiceStates` (fonte de verdade), não da
   lista de membros — quem não está no canal não vira quadrado.
4. Cada peer recebe um `RTCPeerConnection` (ou uma sessão nativa no Linux) e a
   malha é montada em estrela completa: cada um fala com todos.

## Quem oferece a mídia

Regra do par: **o fingerprint maior oferece**. Isso evita offer contra offer
quando dois entram no mesmo instante. Vale para os três gatilhos: o seu
`voice_join`, o `VoiceJoin` que você recebe e o `VoiceState` que você recebe.

Exceção: em `enterRoom` (entrar numa sala de grupo já no ar) **os dois lados
oferecem**. A offer do host pode se perder no caminho e, sem isso, a sala fica
em "Conectando…" esperando para sempre; o glare continua resolvido por
polite/impolite (`callRepair.ts`).

## Quem aparece na chamada

`call_participant_added` é **aviso de roster**, não convite. Só entra no roster
quem provou presença por mídia (`markJoined`, no `onTrack`/answer) ou já estava
lá. Antes o anfitrião de um grupo pré-semeava os convidados com esse frame e
**quem nunca aceitou aparecia na chamada** — o "entrou o Carso e apareceu o
Felipe também".

## Quanto tempo a chamada dura

| Situação | Regra | Onde |
|---|---|---|
| Canal de servidor (`voice-*`) | dura até o último sair; sozinho espera | `isCollectiveRoom` (`voice-` sempre coletivo) |
| Grupo (qualquer tamanho) | dura até o último sair | `isCollectiveRoom({ group: true })` |
| DM 1:1 | encerra quando o outro sai | `leaveOutcome` |

Grupo de **duas** pessoas caía na regra de 1:1 (um participante no roster) e
quem saía encerrava a chamada para o outro. O shell agora passa
`{ group: true }` no `callManager.start` e a sala sobrevive.

## Câmera: ligar e inverter

Um caminho só, `trocarFeedDeCamera`, usado pelo botão de inverter, pelo seletor
de aparelho em Ajustes e pelo pedido da câmera:

- **Windows**: solta a câmera antiga antes de abrir a nova (webcam é exclusiva —
  abrir as duas dá `NotReadableError`).
- **Celular**: abre a nova antes de soltar a antiga (frontal e traseira são
  devices distintos) e a troca é **ao vivo**, sem reiniciar a chamada.
- `getLocalMedia({ video: {} })` deixa a preferência inteira (device,
  `facingMode`, qualidade, fps) ser mesclada. Montar as constraints à mão
  esquecia o `facingMode` e a imagem não mudava.
- Se a nova falha, a preferência **volta antes** de reabrir a anterior — senão
  o retry pedia de novo a câmera que acabou de falhar.
- No Android/iOS o botão de inverter **não depende de `enumerateDevices`**
  (`shouldShowCameraFlip`): antes da permissão o WebView devolve um único
  `videoinput` e o botão simplesmente não existia.

## Por que a câmera aparecia no "amigo" e não no servidor

Cada par WebRTC recebe `audio` e `video  recvonly` de propósito (a chamada de
voz precisa RECEBER vídeo de quem liga a câmera). Ao entrar com câmera já
ligada, `attachLocalStreamToPC` fazia `pc.addTrack(video)` e criava uma
**segunda** m-line de vídeo — que muitos endpoints ignoram. Agora a track reusa
a m-line existente (`replaceTrack` + `sendrecv`), e a renegociação insiste 3×
(`enviarOfferComRetry`) porque numa sala de servidor há vários pares
disputando a mesma fila.

## Caminho de mídia por plataforma

| Plataforma | Captura/encode | Observação |
|---|---|---|
| Windows / macOS | WebRTC da WebView (WebView2 / WKWebView) | `RTCPeerConnection` do engine |
| Android | WebView, se expuser WebRTC | sem captura de tela; câmera/mic dependem do WebView |
| Linux desktop | nativa em Rust (`media_voice.rs`) | WebKitGTK do Ubuntu não tem `RTCPeerConnection` |

No Linux, `create_offer` **bloqueia** esperando SDP + ICE. Desde a 1.1.36 isso
roda em `spawn_blocking`, fora da task que lê a sessão do peer. Antes bloqueava
a leitura e, com vários peers entrando, travava a interface inteira.

## Semeadura da malha

"Nem todo mundo se ouve" era o sintoma clássico. O que existe hoje:

| Mecanismo | Arquivo | Efeito |
|---|---|---|
| Re-anúncio a cada 15 s (`reannounce_voice_channels`) | `engine.rs` | `VoiceJoin` + `VoiceState` para quem já está online |
| `flush_voice_state_to(peer)` | `engine.rs` | manda o estado para quem acabou de subir |
| `announceSelfToRoom` | `callManager.ts` | apresenta o novo aos demais ao entrar |
| `startMeshRepair` | `callManager.ts` | repara pares que ficaram de fora |
| `attachMissingLocalTracks` | `callManager.ts` | anexa trilha que subiu depois da oferta |

## Limites honestos

- **Mesh completo**: com N pessoas, cada uma envia N-1 fluxos. Acima de ~6
  participantes a banda e a CPU degradam. Não há SFU.
- **Android em segundo plano**: sem foreground service a chamada cai; ver o
  item A do `AGENTS.md`.
- **Wayland**: captura de tela depende do portal; sem ele a mensagem é honesta
  e a chamada de voz continua.
- **Áudio do sistema**: indisponível no caminho nativo Linux e no Android.

## Diagnóstico

`CallDiagnostics` mostra, por peer: estado ICE, rota (LAN/STUN/TURN), RTT,
jitter, perda, FPS e codec. "Conectado" sem trilha de mídia é reportado como
conectado-sem-mídia, não como sucesso.

## Salas anunciadas (grupo/DM)

O anúncio (`SecureFrame::CallRoom`) é o que faz o botão **Entrar** aparecer na
conversa. Regras que agora valem e têm teste:

- **Sair tira você da lista**, mesmo sem ser o host. Antes `leave_room` saía
  cedo quando `host_fp != eu`, então a própria entrada ficava viva para sempre
  — o "saio da chamada e continua aparecendo Entrar".
- **Se o host sai, o comando passa** para quem ficou (`Rooms::remove_member`).
  Sem isso ninguém renova o TTL de 35 s e a sala morre com gente dentro.
- **Último sair fecha** a sala (evento `closed` + frame `closed`).
- `closed` é aceito do host **ou de quem está na lista**: os dois lados podem
  ter aberto a mesma sala se achando host, e recusar o fechamento do outro
  deixava a sala fantasma.

## Recibos de leitura (grupo e canal)

`messages.status` é **agregado**: o primeiro membro que lê marcava `read` para
todos. Agora existe `read_receipts(msg_id, fp, read_at)`:

- `SecureFrame::Read` grava o recibo de **um** membro;
- a mensagem só vira `status='read'` (e o duplo check azul) quando **todos** os
  outros membros esperados já têm recibo (`messages_read_by_all`);
- a UI lê `message_receipts` (Tauri) e o `⋯` da mensagem mostra **quem
  visualizou** com horário, quem ainda não e o que não chegou de recibo.

## Como testar (dois aparelhos)

1. Entre no mesmo canal de voz pelos dois.
2. Fale nos dois e confirme que se ouvem nos dois sentidos.
3. Ligue a câmera em um deles; o outro deve ver o vídeo (canal de vídeo).
4. Saia e entre de novo **no mesmo canal**; deve reconectar sem reiniciar o app.
5. Entrar num canal que já tem gente não pode travar o app — é o cenário que a
   1.1.36 corrige.
