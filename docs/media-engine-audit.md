# Auditoria do motor de mídia P2P

**Estado observado em 2026-10-08.** Este documento separa o que o código faz,
o que foi reproduzido localmente e o que ainda não foi validado.

## Fluxo atual

Cada aresta do mesh usa uma sessão `(call_id, peer_fp)` e uma PeerConnection.
O frontend cria ofertas/respostas, envia candidatos ICE pela sinalização do
DisTorrent e tenta ICE restart com orçamento limitado. O caminho nativo Rust
mantém uma sessão por peer, reutiliza-a durante renegociação e remove a sessão,
tasks, tracks e PeerConnection no hangup (`forge-core/src/net/media_voice.rs`).

| Plataforma | Captura e transporte | Recepção e reprodução |
|---|---|---|
| Linux desktop | Tauri encaminha voz ao `VoiceMedia` Rust. CPAL captura áudio uma vez no `AudioHub`; Opus e `webrtc-rs` enviam por RTP/SRTP. Câmera e tela usam GStreamer. | RTP de áudio passa pelo jitter buffer, Opus e CPAL. RTP de vídeo passa por GStreamer e vira JPEG para a UI nativa. |
| Windows desktop | O caminho Rust nativo de vídeo não está habilitado. O frontend usa `RTCPeerConnection`, `getUserMedia` e, se oferecido pelo WebView, `getDisplayMedia`. | Tracks remotas seguem os eventos WebRTC do WebView. |
| Android | Usa o caminho WebRTC do WebView; não há backend de mídia Android neste crate. Permissões, captura de tela e comportamento em background dependem do WebView/Activity. | Tracks remotas seguem os eventos WebRTC do WebView. Não foi feita validação em dispositivo Android nesta tarefa. |

No Linux, a oferta já anuncia m-lines de áudio e vídeo; ligar câmera/tela começa
a escrever samples sem adicionar transceiver no meio da chamada. Isso evita
depender de uma renegociação que não existia no caminho nativo. O codec de vídeo
nativo atual é VP8; H.264 só é escolhido quando a negociação e o encoder
disponível permitem. Áudio da tela não é uma track nativa separada.

ICE usa STUN configurável por `VOICE_STUN_URLS` e TURN por
`VOICE_TURN_URLS`/credenciais; há um TURN público padrão. O código tenta conexão
direta e permite relay, mas não foram executados testes com CGNAT, NAT simétrico,
4G/5G ou redes externas nesta máquina.

## Causas reproduzidas e correções desta alteração

1. O pipeline antigo colocava `rtppayloader` depois de um payloader de codec;
   esse elemento não existe na instalação GStreamer examinada. Também tentava
   tratar `avenc_mpeg4` como H.264, embora ele codifique MPEG-4 Part 2.
2. O appsink entregava RTP e os bytes eram enviados a
   `TrackLocalStaticSample::write_sample`. Esse método já packetiza samples
   codificados em RTP; o resultado era RTP dentro de RTP. O pipeline agora
   entrega quadros VP8/H.264 comprimidos e deixa o packetizer WebRTC criar RTP.
3. O decoder descartava pacotes RTP arbitrários em filas `leaky=downstream` de
   dois buffers. Um frame fragmentado perdia seu primeiro pacote e não podia
   ser reconstruído. O diagnóstico `GST_DEBUG=rtpvp8depay:6` mostrou
   “frame is missing the first packet”; as filas de RTP agora são limitadas e
   não descartam pacotes antes do depayloader. A fila de frames RGB do appsink
   continua descartando frames antigos, quando já completos.
4. A captura de tela vazava uma cópia da lista de monitores por frame. Agora a
   lista tem cache com prazo de validade e o lock é solto antes da captura.
5. Os pipelines GStreamer não eram levados a `NULL` quando o objeto era
   descartado. `Drop` agora encerra encoder e decoder para liberar a câmera e
   as threads de codec. A captura de tela também passou a informar FPS no caps
   RGB de entrada, corrigindo uma negociação `not-negotiated` reproduzida.

As métricas nativas agora distinguem pacotes RTP de vídeo recebidos, frames
decodificados, frames enviados e contadores de áudio. Assim, ICE conectado não
é usado como prova de que vídeo foi decodificado. O estado de vídeo sai de
`starting` para `live` apenas depois que o primeiro sample foi escrito com
sucesso no sender; a UI também espera esse estado antes de ligar o indicador de
câmera/tela.

Em chamadas de grupo, `stats_agg` agora soma contadores de todos os peers e dá
precedência a vídeo `live` sobre peers `starting`, `failed` ou `off`. Antes,
contadores e estado de vídeo vinham de uma entrada arbitrária do mapa de
sessões, então a ordem interna podia fazer a UI anunciar estado incorreto.

## Verificação local

Esta máquina estava em X11 (`XDG_SESSION_TYPE=x11`) e tinha webcam V4L2 em
`/dev/video0`, CPAL/PipeWire e plugins VP8 do GStreamer disponíveis.

- Um teste de hardware faz duas `VoiceMedia` reais negociarem SDP e ICE, envia
  vídeo e exige um JPEG decodificado no peer remoto.
- O teste de câmera executa três chamadas sequenciais no mesmo motor para
  cobrir parar e reabrir a câmera, mas a última execução isolada não recebeu
  nenhum sample do encoder (0 frames enviados). O GStreamer negociou V4L2 em
  640x480/30; `v4l2-ctl --stream-mmap=3 --stream-count=5` também expirou sem
  receber buffers. Portanto, esta máquina não forneceu fluxo de câmera durante
  a validação final e o ciclo de câmera continua sem confirmação.
- O teste de tela captura o monitor X11 real e valida o frame no peer remoto.
- O decoder foi testado inicialmente com filas leaky: RTP chegava, mas nenhum
  frame era decodificado. Depois de remover o descarte dos pacotes, dois runs
  individuais do teste de tela passaram. A suíte conjunta executada em paralelo
  falhou na câmera; os testes foram serializados. A suíte serializada passou no
  loopback de tela, mas falhou no loopback de câmera pelo motivo descrito acima.
- Validação web serial: `npm run typecheck` passou; `npm run lint` terminou sem
  erros (3 avisos: dois em `Social.tsx`, um em `callManager.ts`);
  `npm run test:unit` passou (101 testes); `npm run build` passou.
- Após o ajuste final do estado de vídeo e a agregação de peers,
  `npm run typecheck`, `cargo fmt --all -- --check` e a compilação dos alvos Rust
  passaram.
- Validação Rust serial em baixa prioridade: 153 testes unitários passaram; o
  cenário de reconexão/reinício do peer passou; os quatro cenários de relay
  adverso passaram, incluindo latência assimétrica (92 s); os 14 testes sociais
  passaram após corrigir a sincronização do fixture; os quatro testes de
  migração também passaram após preservar o `DEFAULT` de `bot_id` no fixture.
- No alvo de túnel virtual, handshake/ping e DM/chamada passaram. O teste
  sintético de `CallOffer` com 200 KB não chegou ao peer em 100 s. O benchmark
  MQTT de latência pública foi excluído da rodada final porque ficou aguardando
  brokers externos numa execução anterior; o teste MQTT E2E separado passou.
  Portanto, a suíte Rust completa ainda não teve uma execução totalmente verde.
- A câmera não forneceu buffers nesta máquina. A tela X11 foi decodificada no
  peer remoto em execuções isoladas. Os testes de câmera/tela ficam `ignored` na
  suíte padrão por exigirem hardware/display; o teste de dez nós e os testes
  exclusivos de Tor também não foram executados nesta validação final.

## Limites que continuam abertos

- **Wayland:** o `xcap` atual tenta captura pelo backend Wayland, incluindo APIs
  de screenshot/portal, em cada tick. Isso não é uma sessão persistente do
  XDG ScreenCast portal sobre PipeWire, não foi testado numa sessão Wayland e
  pode abrir caminho de permissão com semântica diferente. A integração
  ScreenCast + PipeWire e a seleção sustentada de monitor/janela continuam
  pendentes.
- **Câmera Linux:** o encoder ainda usa `/dev/video0` fixo. Seleção de device,
  troca durante a chamada e recuperação de hotplug não estão implementadas.
- **Escala mesh:** a câmera/tela abre um encoder por peer destinatário. Uma
  camada de captura/encode compartilhada com fanout RTP por peer reduziria CPU
  e evitaria repetir captura de tela em chamadas de grupo.
- **Áudio do sistema:** o compartilhamento nativo envia vídeo sem capturar áudio
  do monitor/sink. A UI não deve inferir que o modo “áudio do sistema” foi
  atendido pelo backend Linux.
- **Sinal de mídia na UI:** o painel de diagnóstico mostra contadores separados,
  mas o estado principal ainda deriva de ICE/PeerConnection. Falta um estado
  explícito por direção, como `MEDIA_CONNECTING`, `MEDIA_FLOWING`, `DEGRADED` e
  `FAILED`, ligado a progresso real de áudio/vídeo.
- **Windows e Android:** a implementação passa pelo WebView, não por dois
  motores Rust próprios. Não há teste real cross-platform nesta alteração para
  câmera, áudio, screen share, ciclo de Activity, troca de rede ou reconexão.
- **Redes externas:** não foram testados firewall, perda/atraso de pacotes,
  queda e troca de Wi-Fi, NAT simétrico nem disponibilidade do TURN público.

Esses pontos são limites de validação e implementação, não resultados
positivos presumidos. A evidência de hardware desta tarefa cobre apenas Linux
X11 local com peers Rust no mesmo host.
