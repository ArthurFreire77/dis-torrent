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

## Como testar (dois aparelhos)

1. Entre no mesmo canal de voz pelos dois.
2. Fale nos dois e confirme que se ouvem nos dois sentidos.
3. Ligue a câmera em um deles; o outro deve ver o vídeo (canal de vídeo).
4. Saia e entre de novo **no mesmo canal**; deve reconectar sem reiniciar o app.
5. Entrar num canal que já tem gente não pode travar o app — é o cenário que a
   1.1.36 corrige.
