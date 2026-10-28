# CHANGELOG

## [1.1.7-pre-alpha] — 2026-10-28

### Correção crítica: o app Android fechava sozinho ao abrir

**Sintoma.** Instalar o APK da 1.1.6, abrir o app → "o DisTorrent parou de funcionar"
(às vezes nem chegava a desenhar a tela).

**Causa raiz.** O APK publicado tinha **2,49 MB** e, abrindo o `.apk` como zip, não
existia **nenhum** `lib/*/libdistorrent_lib.so` e nem os assets do frontend. O
`System.loadLibrary("distorrent_lib")` do Tauri falhava com `UnsatisfiedLinkError` na
criação da Activity → o Android encerra o processo imediatamente. Não era crash de
Kotlin, nem R8, nem permissão: era um APK sem a biblioteca nativa (e sem a UI).
Mesma coisa nos releases anteriores: a 1.1.5 e a 1.1.4 tinham 20 MB, a 1.1.6 caiu
para 2,49 MB — regressão de empacotamento, não de código.

**O que foi corrigido.**

- `build.gradle.kts` (Android) não tem mais caminho absoluto de máquina nem senhas
  em texto puro: a assinatura de release lê `keystore.properties` (gitignored) ou
  as variáveis `DISTORRENT_KEYSTORE_PATH` / `DISTORRENT_KEYSTORE_PASSWORD` /
  `DISTORRENT_KEY_ALIAS` / `DISTORRENT_KEY_PASSWORD`. Sem keystore o release sai
  **não assinado** em vez de falhar no meio do build.
- Novo `scripts/verify-apk.ps1`: recusa APK sem `lib/arm64-v8a/libdistorrent_lib.so`,
  sem assets do frontend, sem assinatura ou com tamanho suspeito. É a trava que
  impede publicar outro APK oco — roda no build local e no CI.
- Novo `build-android.ps1`: build completo e verificável (frontend + Rust arm64 +
  gradle release + verificação), em vez do passo manual de hard link do `.so`.
- `downloads_plugin()` (Rust) deixou de ser **fatal** no `setup`: se o plugin
  Kotlin não registrar, o app abre e a UI avisa que não deu para salvar em
  Downloads. Antes qualquer falha ali matava o boot inteiro.
- `MainActivity.hasMediaPermissions()` removido: checava `READ_MEDIA_*` que o
  manifest não declara (sempre `false`, sem chamador).

### Instalador Windows: Inno Setup no lugar do NSIS

**Sintoma.** O `.exe` publicado era bloqueado no download: o Edge marcava como
"não confirmado" e o Defender colocava o arquivo em quarentena com
`Program:Win32/Contebrew.A!ml` (heurística `!ml`, não é vírus).

**Causa raiz.** O gatilho era o **stub do instalador NSIS** do Tauri, não o app:

- o binário puro (`distorrent.exe`, 24 MB) passa limpo **até** baixado com
  Mark-of-the-Web;
- trocar a compressão do NSIS (LZMA → zlib) **não resolveu** — o arquivo novo
  (8,13 MB) foi detectado do mesmo jeito, inclusive depois de baixado;
- o scan local do arquivo recém-buildado dava "no threats" porque ele ainda não
  tinha a marca de "veio da internet" — foi por isso que a checagem anterior
  aprovou um instalador que todo mundo recebia bloqueado.

**Correção.** O instalador Windows agora é gerado em **Inno Setup**
([`installer/distorent.iss`](installer/distorent.iss) por
[`scripts/build-installer.ps1`](scripts/build-installer.ps1)): motor de setup
diferente, com atalhos no Menu Iniciar e na Área de Trabalho, entrada em
Aplicativos, desinstalador e instalação por usuário sem UAC. O script avisa e
oferece o download quando o WebView2 não está presente (sem ele a janela abre em
branco).

**Verificação (arquivo publicado, não o local):** baixado pela URL da release →
7.578.486 bytes, `sha256 7388723c…` → `Zone.Identifier` aplicado →
`MpCmdRun -Scan`: **"found no threats"**, arquivo preservado e hash inalterado.
Instalação silenciosa testada em diretório temporário: instalou
`distorrent.exe` (versão `1.1.7-pre-alpha`), criou desinstalador e removeu tudo no
uninstall.

### Também nesta release (outro trabalho no mesmo diretório)

- Privacidade: o endereço de proxy agora é **por modo** (`privacy.proxy_addr` ×
  `privacy.tor_addr`) — antes escolher "Tor" trazia e gravava o default do
  SOCKS5 (1080) no lugar do 9050 do Tor. A UI mostra agora o `proxy_effective`
  real (relay saindo por proxy/Tor) em vez do modo solicitado.

### Build e CI (por que o release 1.1.7 falhou no GitHub Actions)

O run 40613653917 falhou em duas frentes; as duas eram de empacotamento, não de
código do app. Linux (`.deb`/`.AppImage`) passou.

- **Windows (`npm ci`):** `@tauri-apps/cli-linux-x64-gnu` estava em `dependencies`
  (binário Linux-only, sem `optional`). O npm tenta instalar dependência direta
  que não bate com a plataforma e aborta com `EBADPLATFORM` — no Windows o job
  morria antes de compilar qualquer coisa. Removido: o binário da CLI continua
  vindo como dependência **opcional** de `@tauri-apps/cli` em cada plataforma
  (o lockfile preserva as variantes Linux de `esbuild`/`rollup`/`cli`).
- **Android (Gradle):** `tauri android init` reescreve o
  `buildSrc/.../BuildTask.kt` para o template novo (que declara
  `@Input var projectDir`) mas **não** reescreve o `RustPlugin.kt`, que no repo
  ainda era o antigo e nunca preenchia esse campo. O Gradle então aborta com
  `property 'projectDir' doesn't have a configured value` e nenhum APK é gerado.
  Agora `BuildTask.kt` e `RustPlugin.kt` estão **ambos** no template atual
  (`register` + `projectDir = project.projectDir.path`) e versionados juntos, e o
  workflow **não roda mais `android init`** — o `tauri android build` já recria
  sozinho os arquivos gerados (`tauri.settings.gradle`, `tauri.properties`,
  `tauri.build.gradle.kts`).
- `scripts/verify-apk.ps1`: a checagem de assinatura morria com
  `NativeCommandError` — o `apksigner` imprime um WARNING no stderr e, com
  `$ErrorActionPreference = "Stop"`, o PowerShell tratava isso como falha antes de
  ler o exit code. Agora o stderr é capturado e a decisão é pelo exit code.
- `build-android.ps1`: passou a compilar só `assembleArm64Release` (as outras
  flavors saíam sem a `.so` = APK que instala e morre no boot; era o defeito da
  1.1.6) e gera os arquivos do CLI com `init` **apenas quando faltam** (clone
  limpo), sem sobrescrever o que é versionado.

### Instalador Windows acusado como vírus (falso positivo do Defender)

**Sintoma.** Baixar o `.exe` da 1.1.7 → o Chrome marca o download como "não
confirmado" e o Windows Defender coloca o arquivo em quarentena
(`Program:Win32/Contebrew.A!ml`, `DidThreatExecute: False`).

**Diagnóstico.** Não é código malicioso nem assinatura de vírus: é heurística de
machine learning (`!ml`) sobre o **instalador NSIS**. Os `.exe` das 1.1.5 e 1.1.6
passam limpos, o binário do app (`distorrent.exe`, 24 MB) passa limpo **até com
Mark-of-the-Web**, mas o pacote NSIS é acusado. Trocar a compressão para `zlib`
não resolveu: o scan local dizia "no threats", porém o download (com MOTW) e a
proteção em tempo real continuavam detectando — o problema é o formato NSIS em
si, não a compressão.

**Correção.** O Windows passa a receber o **executável portátil**
(`DisTorrent_1.1.7-pre-alpha_x64.exe`, 22,79 MB) — o próprio binário do app
renomeado, sem instalador. Ele passa limpo no teste completo: baixado pela URL
pública, com `Zone.Identifier` (MOTW) aplicado, continua no disco e
`MpCmdRun -Scan` → "found no threats".

A regra que fica: **testar como usuário** (baixar de verdade + aplicar MOTW +
escanear) antes de anexar, e nunca publicar binário que o Defender acuse, mesmo
sendo falso positivo. O instalador MSI também passa limpo, mas não foi o
escolhido para a release; assinar continua sendo o único jeito de acabar de vez
com os avisos de reputação do SmartScreen.

### Binários

- Android: APK **release assinado** (mesma chave `CN=DisTorrent, OU=Dev` das
  versões anteriores, instala por cima sem desinstalar), com a `.so` arm64 e os
  assets dentro — verificado item por item antes de publicar.
- Windows: `DisTorrent_1.1.7-pre-alpha_x64_setup.exe` (**Inno Setup**), gerado
  localmente — NSIS foi abandonado por causa do falso positivo do Defender.
- Linux: `.deb` + `.AppImage` gerados no WSL/Ubuntu (`npm run tauri build --
  --bundles deb,appimage`).
- O CI não assina APK (não tem o keystore): o job Android valida o conteúdo do
  `app-arm64-release-unsigned.apk` e a release não anexa APK sem assinatura.

## [1.1.6-pre-alpha] — 2026-10-27

### Release de correção (build local)

- Bump de versão 1.1.5-pre-alpha → 1.1.6-pre-alpha.
- Build Windows (.exe) gerado localmente (5.84 MB).
- Build Android (.apk release assinado) gerado localmente (2.49 MB).
- Rust instalado localmente (rustc 1.99.1, cargo 1.99.1, rustfmt, clippy).
- Android SDK/NDK configurados (NDK 27.0.12077973, JDK 17).
- AGENTS.md atualizado com comandos de build local e aprendizados.

## [1.1.5-pre-alpha] — 2026-10-27

### Release de correção (pós-auditoria)

- Bump de versão 1.1.4-pre-alpha → 1.1.5.
- Chamadas: câmera religa na mesma chamada, PT/codec de vídeo, ICE `closed` não conta como recuperado, fallback de áudio quando câmera é negada, troca de canal de voz, barra "Voz conectada" derivada do estado real.
- Compartilhamento de tela: monitores não escondidos, sem escala dupla, FPS `auto` sem teto, recaptura segura, senders de áudio reusados, caminho nativo Linux honesto.
- Android/Tauri: `save_file_stream` com magic bytes + extensão + job_id + tamanho; `plugin:downloads|save` com caminho restrito; `profile_set`/`messages_around` corrigidos; manifest sem `CAPTURE_VIDEO_OUTPUT` e `allowBackup=false`.
- Mídia nativa Linux: `vtl.stop()` removido (câmera religa), envio escolhe VP8→H264 com erro explícito, `spawn_send_loop` com retry, `aggregate_stats` sem double-count.
- Testes: 114/114 unit (7 novos de tela), `typecheck`/`lint`/`build` verdes.

### Binários

Os instaladores (Windows .exe/.msi, Linux .AppImage/.deb, Android .apk) **não são gerados neste repositório** — exigem toolchain Rust + Android SDK em máquina dedicada ou via CI. Ver `AGENTS.md` (gitignored, local) para o backlog e o plano de release.

## [Não lançado] — 2026-10-27

### Chamadas (vídeo/áudio) — bugs corrigidos

- **Câmera só ligava uma vez por chamada (Linux nativo):** a task de envio
  terminava com `vtl.stop()` na track criada em `build_session`; desligar e
  religar caía em "a track local ficou sem ssrc". A track agora pertence à
  sessão e só morre no hangup. O dispositivo (v4l2/GStreamer) continua sendo
  fechado no stop.
- **PT/codec de vídeo trocado:** o envio pegava o PRIMEIRO codec de vídeo do
  SDP (VP9/AV1 no Chrome moderno) e escrevia VP8 sob aquele payload type.
  Agora prefere VP8, depois H264, recusa com erro explícito quando o par não
  aceita nenhum dos dois, e `VideoCodec::supported_from_mime` não colapsa mais
  VP9/AV1 em VP8.
- **Áudio unilateral silencioso:** `spawn_send_loop` saía sem mensagem quando
  `get_parameters`/PT/SSRC não estavam prontos. Passa a tentar por ~10 s e
  marca a sessão como `failed` com motivo (a UI mostra erro em vez de
  "conectado" mudo).
- **Câmera em chamada de voz (WebView):** a transceiver criada `recvonly` era
  reutilizada sem mudar de direção, então o vídeo nunca saía. Agora vira
  `sendrecv` + renegociação; `cameraOn` deriva de track viva; permissão negada
  cai para áudio puro em vez de deixar a chamada muda; erro de câmera aparece
  na UI; dois cliques não abrem dois `getUserMedia`.
- **ICE `closed` contava como "recuperado":** fechar o PC de um peer derrubado
  marcava a chamada como conectada e desligava o relay (todo mundo mudo).
  Só `connected`/`completed` recuperam.
- **Troca de canal de voz:** entrar em outro canal agora sai do anterior
  (antes os PCs e o microfone antigo ficavam vivos).
- **`voice_join` duplicado:** o shell chamava `services.voiceJoin` depois de
  `callManager.joinVoice`, que já anuncia ao core — duas sessões nativas.
- **Barra "Voz conectada" fantasma e atalho de mute morto:** a barra deriva do
  estado real da chamada e o atalho usa `callManager.toggleMute()`.
- **Tiles de voz vazios:** `<video>` só é renderizado com trilha de vídeo; o
  `<audio>` remoto existe sempre (antes sumia junto com o vídeo).

### Compartilhamento de tela — bugs corrigidos

- **Monitores escondidos:** `monitorTypeSurfaces:'exclude'` no modo padrão
  removia os monitores do seletor do Chromium (e com eles o áudio do sistema).
  Só `window` exclui monitores.
- **Escala dupla:** a resolução já era aplicada na captura e o encoder dividia
  de novo (720p saía ~640×360, 480p ~214×120). `scaleResolutionDownBy: 1` e
  `degradationPreference: 'maintain-resolution'` (texto legível).
- **"FPS automático" era teto de 60 escondido:** `fpsOf` devolve `null` em
  `auto`; nenhuma constraint de frameRate é imposta.
- **Recaptura derrubava o share:** o stream novo é capturado ANTES de parar o
  antigo; cancelar o seletor do sistema não corta mais a tela de todos.
- **Áudio da tela acumulava m-lines:** senders são reusados entre ciclos e
  limpos no stop (menos SDP, sem áudio duplicado).
- **Caminho nativo Linux honesto:** backend detectado (`display-media` /
  `native` / `none`); no nativo só a tela inteira é oferecida, áudio do sistema
  é recusado com aviso e `window`/`monitor` falham explicitamente em vez de
  enviar o desktop inteiro fingindo ser uma janela.
- **Frames remotos presos:** parar o share limpa `videoUrl`/`videoSeq` (o tile
  não congela mais no último quadro).

### Android / Tauri

- **`save_file_stream` (caminho real de download) não filtrava conteúdo:**
  agora valida `job_id`, aplica a mesma lista de extensões bloqueadas e os
  magic bytes do primeiro lote do `save_file`, e recusa arquivo maior que o
  tamanho anunciado (lote e acumulado).
- **`plugin:downloads|save` aceitava qualquer caminho e apagava a origem:**
  exige caminho canônico dentro de `filesDir`/`cacheDir`/`noBackupFilesDir`/
  `getExternalFilesDir` e bloqueia extensões executáveis.
- **`profile_set`:** `rename_all = "snake_case"` — o frontend envia
  `display_name`/`avatar_b64`/`banner_b64` e o Tauri 2 esperava camelCase
  (`missing required key displayName`).
- **`messages_around`:** a query listava 9 colunas e o mapper lia `get(9)`; o
  `flatten()` descartava todas as linhas em silêncio ("pular para mensagem"
  sempre vazio). `limit` agora tem clamp.
- **Manifest Android:** removida `CAPTURE_VIDEO_OUTPUT` (nível `signature`,
  não habilitava `getDisplayMedia` e só prometia capacidade falsa);
  `allowBackup="false"` (mensagens/cofre não vão para backup de nuvem/ADB).

### Testes

- `distorrent-core/tests/media_voice_*.rs`: gate `#![cfg(target_os = "linux")]`
  (dois alvos não compilavam no Windows e derrubavam `cargo test`/`clippy
  --all-targets`).
- `aggregate_stats`: pior peer não é mais contado duas vezes (teste novo).
- `tests/screenShareFixes.test.ts`: 7 regressões de tela (monitores,
  `restrictOwnAudio`, escala única, FPS auto, resolução sob perda, backend
  nativo, backend ausente).

## [1.1.4-pre-alpha] — 2026-10-11

### Câmera e tela no Linux

- **Câmera**: ordem de tentativa era raw-first — YUYV 720p@30 (55 MB/s)
  não cabe no USB2, queimando 1.5s+ por combinação à toa. MJPG primeiro
  (cabe e é universal em UVC), taxas reduzidas para `[pedida, 30, 15]`,
  primeira combinação do device com janela de 3s (firmware frio) e teto de
  6 falhas por device com diagnóstico honesto ("sem resposta — tente
  desplugar e plugar de novo"). Varredura num device morto: 60s+ → ~20s.
- **Tela**: `ximagesrc` sem prova de frame virava tela preta anunciada como
  ativa. Mesma prova da câmera (1.5s); sem quadro, cai no `appsrc` (xcap).
- **Relay MQTT (4G)**: backoff exponencial na reconexão (o storm de ~3/s
  por perna rendia ban de IP), erro honesto com o motivo da recusa e
  `DISTORRENT_MQTT_BROKERS` para broker próprio.
- **Voz**: teste de microfone nativo (WebKitGTK não tem getUserMedia) +
  nome real do device; botão de câmera no mobile; menu de tela só no clique.

## [1.1.3-pre-alpha] — 2026-10-11

### Tela cinza no .deb Linux — causa raiz e blindagem

- **Causa raiz (não era o app)**: `~/.cache/fontconfig` compartilhado
  reescrito pelo `fc-cache` 2.18 do Linuxbrew num formato que o fontconfig
  2.15 do sistema não entende (cache das WOFF OpenDyslexic). O
  `WebKitWebProcess` entrava em loop infinito a 100% de CPU antes do
  primeiro paint — janela cinza, `about:blank` nunca comitava, zero output
  no console. Chromium nunca foi afetado.
- **Blindagem no código**: o app agora usa `FONTCONFIG_FILE` próprio
  (`src-tauri/fontconfig/distorrent-fonts.conf`, mesmas fontes/regras do sistema
  via `/etc/fonts/conf.d`) com `<cachedir>` só em
  `~/.cache/distorrent-fontconfig`. Cache compartilhado envenenado nunca mais
  trava o app — verificado com o arquivo venenoso presente.
- **Diagnóstico no Linux**: console JS espelhado no stdout
  (`enable_write_console_messages_to_stdout`) e `useHttpsScheme: false`.

## [Não lançado]

### Chamadas e vídeo — qualidade e estabilidade (medido, não estimado)

Instrumento novo: `cargo run --example media_probe` (distorrent-core/examples) abre
os dispositivos REAIS e imprime o que aconteceu — microfone (cpal), câmera
(v4l2src), tela (xcap) e os encoders. Todos os números abaixo são dele.

- **Tela nativa (Linux) 0.5 fps → 29.2 fps a 1280x720**: a captura usava o
  `xcap`, que faz `XGetImage` sem MIT-SHM e converte 2M pixels em Rust, e
  depois reduzia com `image::resize(Triangle)` (1 fps MEDIDO, só o resize).
  Agora o X11 usa `ximagesrc` dentro do pipeline GStreamer — captura, converte
  e escala em C. O caminho appsrc/xcap continua como fallback (Wayland sem
  portal) e recebe RGBA na resolução do monitor: quem reduz é o `videoscale`.
- **Câmera nativa: 640x480 → 1280x720** no mesmo fps (19–20 fps). O teto é o
  dispositivo: `v4l2src` puro entrega 19 fps nesta webcam (anuncia 30, mas o
  driver/firmware não sustenta — limbos de exposição/ USB). Antes o pipeline
  exigia `framerate=30/1` exato e morria com `not-negotiated` em qualquer
  webcam que não fizesse exatamente 30.
- **Câmera robusta**: `new_camera` varre `/dev/video*` (video0 era hardcoded),
  tenta 720p→480p e 30→20→15→10 fps, MJPG com `jpegdec` quando o raw não
  negoceia, e só aceita um pipeline que **entregue um quadro** (montar em
  Playing não provava nada — morria no preroll).
- **Áudio: AGC com noise gate no microfone**. MEDIDO: o device padrão está com
  o volume do sistema em 31% e entrega pico de -33 dBFS — o par ouvia
  sussurro. O caminho do navegador tem `autoGainControl`; o nativo não tinha
  nada. Alvo -6 dBFS, teto 12x, abaixo de -48 dBFS é silêncio (sem gate o AGC
  transformava ruído de fundo em uivo). 4 testes de regressão.
- **Opus 32 → 48 kbps** (voip médio → fullband mono).
- **VP8 capaz**: `cpu-used=-8 threads=4 lag-in-frames=0 error-resilient=
  default+partitions keyframe-max-dist=60` — `partitions` deixa o quadro ser
  decodificado em pedaços, que é o que salva a imagem quando pacote RTP se
  perde em P2P. Bitrate 800/1500 → 2500 (câmera) e 3500 kbps (tela).
- **Loop de envio de vídeo: ~15 fps fixos → 30 fps**. Dois gargalos: o SSRC era
  buscado com `await` a cada quadro (~20 ms de ida/volta) e o passo era um
  `sleep` de 33 ms inteiro, somando o custo do frame. Agora o SSRC é lido uma
  vez e o sono é adaptativo — dorme só o que falta do intervalo.
- **Preview remoto na UI: 150 ms → 40 ms** (6.6 → 25 fps). O encoder entrega 29
  e a UI era o gargalo visual: o vídeo do Linux chegava como slideshow.
- **Mesh de canal de voz não formava (race)**: a mídia nativa só nascia se quem
  entrava no canal visse os outros no `list_voice_states` local. Quem estava no
  canal recebendo o `VoiceJoin` só gravava estado e **não abria mídia** — nos
  dois entravam juntos, NENHUM lado oferecia e o canal ficava mudo até
  reiniciar o app. Regra do par (fingerprint maior oferece) nos três pontos:
  `voice_join`, `VoiceJoin` recebido e `VoiceState`.
- **Tela (navegador)**: `getDisplayMedia` pedia sem framerate — o WebView
  escolhia 15-24 fps. Agora `frameRate: { min: 30, ideal: 60 }`, com retry que
  derrota o `min` se o aparelho não sustentar (OverconstrainedError).
- **Câmera (navegador)**: `OverconstrainedError` agora DEGRADA
  (720p/60 → 720p/15 → 480p/15 → 480p/30 → só voz) em vez de matar a câmera.
- **Compartilhar tela sem participante conectado**: o guard `pcs.size === 0`
  lançava erro. Removido — a captura é preparada e semeada quando os PCs
  nascem (`attachLocalStreamToPC` já faz isso).


### Ciclo de chamada (chamar → aceitar → sair → chamar de novo)

Dois bugs REAIS encontrados por teste novo
(`call_cycle_repeats_cleanly_round_after_round`, `rejected_call_leaves_nothing_
held_behind` em distorrent-core/tests/integration.rs — 2 engines, chamada de verdade):

- **Quem recebia o fim continuava dentro da chamada**: `handle_frame(CallEnd)`
  fazia `leave_call(call_id, peer_fp)` — removia só PAR que desligou. Em 1:1 o
  convidado ficava em `call_participants` DEPOIS do fim, e o registro fantasma
  fazia a chamada seguinte nascer achando que ainda havia uma em andamento.
  **Esse é o "tem que reiniciar o app para chamar alguém".** Agora: remove o par
  e, se não sobrou mais ninguém além de mim, `end_call` (em grupo quem fica
  continua com os outros — remover a chamada inteira derrubaria B quando C
  falasse).
- **Sair de CANAL DE VOZ não encerrava a mídia**: `leave()` só limpava estado
  local quando o callId começava com `voice-` — nunca chamava `voiceLeave`. A
  sessão nativa (webrtc-rs + cpal + ximagesrc) continuava viva: o áudio do canal
  seguia saindo depois de "desligar" e entrar de novo no mesmo canal montava o
  mesh por cima da sessão morta. Agora deriva comunidade/canal (via `convId`,
  que é o channel_id) e chama `voiceLeave`.
- **Rede de segurança do encoder**: `cleanup()` e `leave()` agora pedem
  `voice_video_stop` para cada par quando a chamada era nativa — se algum
  caminho chegou ali sem `voice_leave`/`call_end`, o `ximagesrc`/`v4l2src`
  segurava o device e a chamada SEGUINTE herra "device busy" sem explicação.
- **`bind()` vazava listener**: sobrescrever `engineOff` sem descartar o
  anterior significava que um segundo `bind` (remount do shell) dobrava o
  processamento de cada evento de chamada — offers duplicadas, PCs duplos.


### Varredura completa do fluxo (auditoria → 2 críticos + 4 graves corrigidos)

- 🔴 **`nativeVoiceSince = 0` derrubava a chamada nativa a qualquer
  `connecting`**: o sentinela era `0`, então `Date.now() - 0` dava ~1,7 × 10¹² e
  o watchdog de 45 s estourava INSTANTANEAMENTE. Depois da primeira conexão
  boa, qualquer `connecting` posterior — ICE restart, troca de Wi-Fi para 4G
  (`media_voice.rs:1238`/`1257` escrevem esse estado) — chamava `leave()` em
  menos de 700 ms em vez de deixar o restart trabalhar. Agora o sentinela é
  `-1` e `waited` só conta quando a chamada está realmente pendente de mídia.
- 🔴 **O watchdog nativo não existia quando o core não tinha sessão**:
  `voiceMediaStats` devolve `null` sem sessão (offer perdida, SDP recusado) e o
  `if (!s) return` engolia o teste de 45 s — overlay "Conectando…" **para
  sempre** no caminho nativo. Agora o timeout vale igual sem sessão, com
  mensagem própria ("a oferta não virou sessão").
- 🟠 **Trocar câmera ↔ tela no nativo era no-op silencioso**: `video_start`
  devolvia o codec sem olhar a fonte pedida. Com a tela no ar, clicar em
  "ligar câmera" não fazia nada — e nenhum erro aparecia; o botão de câmera
  ficava morto. Agora fonte diferente ⇒ purga a task atual e reabre.
- 🟠 **O accept era avisado ao peer ANTES de validar local**: o shell chamava
  `services.callAccept` (o frame já ia pro fio) e só depois `acceptInbound`,
  que podia lançar. Resultado: o chamador conectava sozinho e quem atendeu
  ficava sem chamada. Novo `callManager.canAccept(callId)` consultado antes
  nos dois shells.
- 🟠 **Aceitar duas vezes — ou aceitar um toque já encerrado — criava chamada
  fantasma**: sem guard de duplo clique, o segundo accept caía em
  `state === null`, criava zumbi de 20 s + 30 s (e **eterno** no nativo, pelo
  crítico 2). Registro de `endedCalls` + `accepting` barra os dois casos.
- 🟠 **`aggregate_stats` usava o estado de um par arbitrário do `HashMap`**: num
  mesh de 3, um par atrás de NAT simétrico (`failed`) derrubava a chamada dos
  outros dois que estavam `connected`; e com um par `connected` e outro
  `connecting`, o `media-connected` nunca disparava (dava sorte). Agora o
  **pior** caso decide o estado agregado — 3 testes novos.
- 🟡 **Entrar em canal de voz com DM ativa fazia órfãos**: `joinVoice` não
  tinha a guarda que `start()`/`acceptInbound()` têm — sobrescrevia estado e
  `localStream` sem fechar os PCs da DM, sem `callEnd` e sem parar os tracks
  (microfone preso). Guarda adicionada.
- 🟡 **Watchdogs sem comparação de `callId`**: `connect`/`reconnect` só
  olhavam a fase. Um timer de chamada morta chamaria `leave()` na chamada nova.
  Agora capturam o `callId` no start e comparam no corpo.
- 🟡 **`nativeRoute` nunca era zerada**: global de módulo, mostrava a rota da
  chamada anterior para sempre (nativa → navegador). Zerada no `cleanup()`.

### Limite conhecido e honesto
- **60 fps não é sustentado na captura de tela X11** desta máquina: teto medido
  de ~29-34 fps com `ximagesrc`, independente dos parâmetros do encoder
  (testado `cpu-used` -8/-4/0 a 480p e 720p). No Windows/Android o `ideal: 60`
  fica pedido e o Chromium entrega o que o hardware aguentar.
- **Android**: o WebView do sistema **não expõe** `getDisplayMedia`
  (`api.MediaDevices.getDisplayMedia` inexistente). Capturar tela lá exige
  `MediaProjection` nativo (plugin Rust+Java), não é configuração.

## [1.1.2-pre-alpha] — 2026-10-08

### Perfil, preferências e interface
- **Perfil P2P completo**: banner 160px, avatar 88px com anel, selos ed25519/presença/servidor, abas Sobre/Servidor/P2P, edição inline com preview ao vivo, troca de capa/avatar por toque, anotação privada por usuário, cópia de fingerprint
- **Aparência**: tema escuro/claro funcional, fonte 85–125% com prévia, densidade confortável/compacta persistida por conversa
- **Notificações**: padrão global + silenciar servidor/canal (todas/menções/nada), tudo local via localStorage
- **Áudio**: lista microfones, toggles eco/ruído/ganho aplicados no AUDIO_CONSTRAINTS, teste de mic com medidor ao vivo
- **Rascunhos por conversa**: desktop + mobile — trocar canal/DM não perde texto
- **Ctrl+K quick-switcher**: prefixos `#` canal, `@` conversa, `*` servidor, prioriza início
- **Esc global**: fecha busca/fixadas/paleta/inbox/salvos
- **Reação alterna no clique** (bug real corrigido), hover mostra quem reagiu
- **Compartilhamento de tela**: dropdown único com "Tela inteira", "Janela/Aba", "Configurações avançadas"; botão "Parar" quando compartilhando
- **Pastas de servidor**: criar/mover/renomear/apagar via botão direito na rail
- **Mute no menu do canal** (desktop) e mobile
- **Boas-vindas/AuthCard**: proposta P2P em 3 cards SVG, splash no index.html + noscript + OG
- **Limpeza**: ~15 estados/props mortas removidos, imports limpos, emojis de UI → SVG
- **Lint zerado** (era 24), typecheck limpo, 106 testes, build 4s

### Chamadas e vídeo

### O bug "só consegue chamar uma vez" (causa-raiz, 3 partes)
- **`callEnd` era no-op no driver navegador** (browser.ts): as outras abas
  nunca ficavam sabendo que a chamada acabou — o overlay do outro lado ficava
  preso em "Conectado" para sempre e bloqueava qualquer ligação seguinte com
  "já existe uma chamada em andamento". Agora `callAccept`/`callReject`/
  `callEnd` emitem os MESMOS eventos que o engine nativo emite
  (`call_accepted`/`call_rejected`/`call_ended`).
- **A offer negociava antes do aceite**: quem ligava enviava a offer ~2s
  depois do invite, e o `handleOffer` do recebedor criava PC e respondia
  IMEDIATAMENTE — a mídia conectava (e o áudio de quem ligava chegava) com o
  telefone ainda tocando. O lado nativo já retém (voice_gate.rs); o espelho
  do navegador agora também: `acceptedCalls` registra o aceite e a offer
  fica retida até o clique em "Aceitar". O `promoteOnSignal` deixou de
  promover o ring (`incoming`) para `connecting`.
- **Self-echo da sinalização no modo navegador**: o BroadcastChannel devolve
  TUDO para a própria aba que emitiu — a offer ecoada promovia a fase de quem
  ligava (badge mentia "Conectando…" no lugar de "Chamando…") e o
  `call_incoming` ecoado tocava o telefone de QUEM LIGOU (overlay de ring
  sobreposto interceptando os cliques). Sinalização própria e self-ring agora
  são filtrados (no callManager e nos dois shells).
- **e2e novo** (`call-rejoin.spec.ts`): chamar → conectar → sair → chamar de
  novo, nas duas direções — o ciclo que quebrava, agora travado por teste.

### Vídeo nativo (Linux) — a ponte que faltava
- O core JÁ codificava câmera (v4l2) e tela (xcap) via GStreamer na mesma
  PeerConnection webrtc-rs da voz — mas NADA disso era exposto à UI: os
  botões chamavam getUserMedia/getDisplayMedia (inexistentes no WebKitGTK)
  e a capacidade inteira ficava morta. Novos comandos Tauri
  `voice_video_start`/`voice_video_stop`/`voice_video_frame` + services JS +
  caminho nativo no `callManager` (câmera/tela por par, estados honestos do
  core em `voice_media_stats`).
- **Vídeo RECEBIDO no Linux**: o decoder GStreamer já produz o frame mais
  recente em JPEG; agora a UI faz polling (`voice_video_frame` com
  `since_seq` para não reenviar) e desenha o tile do participante com
  `<img>` (desktop + mobile).
- **Transporte de vídeo corrigido**: o encoder entrega quadros comprimidos ao
  WebRTC para packetização RTP; o caminho anterior podia encapsular RTP duas
  vezes. O decoder mantém pacotes RTP até remontar o frame, evitando descartar
  fragmentos necessários.
- **Captura e estado de mídia**: pipelines GStreamer encerram ao liberar a
  sessão, monitores são armazenados em cache durante captura, e métricas de
  vídeo separam pacotes RTP recebidos de frames decodificados. Em chamadas de
  grupo, os contadores agregam todos os peers; a UI só marca vídeo como ativo
  após o primeiro frame enviado.

### Áudio nativo (Linux): o envio não morre mais aos 30s
- `spawn_send_loop` tinha `wait_connected(30s)` que DESISTIA em silêncio:
  com TURN lento/CGNAT (ou ICE restart que recupera a rota depois) a rota
  fechava após os 30s e este lado virava "só recebe" até o fim da chamada,
  sem erro nenhum. Agora o loop espera enquanto a sessão viver (log honesto
  aos 30s; quem decide "nunca conectou" são os watchdogs da UI). O mesmo
  teto saiu do envio de vídeo nativo.

### Permissões de mídia do WebView (tela no Windows)
- `on_permission_request` global no Tauri: sem handler, o WebView2 NEGA o
  pedido de captura de tela do `getDisplayMedia` por padrão (o picker nem
  abre) e o WebKitGTK nega tudo (Default = Deny). Agora mic/câmera/tela são
  Allow — o `getDisplayMedia` do Windows abre o seletor nativo de
  tela/janela/app (o caminho JS de tela que já existia passa a funcionar).

### Câmera que não abre em celular
- `frameRate.min` era 24: câmera frontal fraca de Android não entrega 24fps
  e o getUserMedia falhava com OverconstrainedError (câmera que NEM ABRIA).
  Piso agora é 15 (ideal continua 60).

### Paridade Discord
- Popup do próprio perfil ganha **"Editar perfil"** → editor completo
  (avatar/banner/About me/status/accent) — antes só era alcançável clicando
  no avatar de uma mensagem sua.

### Validação
- E2E completo: 49 passaram e 2 foram ignorados. A auditoria de mídia registra
  os testes de hardware disponíveis e os limites de validação por plataforma.

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
nomes e numerações anteriores (DisTorrent 2.x–5.x). A partir daqui a numeração é
`1.0.0-pre-alpha.N` e o CHANGELOG passa a ser gerado em ordem cronológica a
partir das tags do Git.

## 2.0.0 — Voz nativa em Rust: chamada funciona no Linux sem WebRTC

O ponto de virada: o WebKitGTK do Ubuntu **não expõe `RTCPeerConnection`**, então
WebRTC de navegador é impossível no desktop Linux. Até aqui isso era contornado
com áudio pelo túnel de sinalização (o "relay"), de latência alta — a origem de
praticamente toda complaint de chamada. Agora a voz é um plano de mídia nativo em
Rust, e o relay saiu do caminho de chamadas.

### Voz nativa (`distorrent-core/src/net/media_voice.rs`)
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
- `distorrent-core/dev/safe-build.sh` — guardião de build: aborta com RAM livre
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
- **Versão unificada**: distorrent-core, src-tauri, host, package.json — todos 3.0.0

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
- **Tracker bootstrap self-hosted**: `distorrent-host --bootstrap 8090` sobe tracker HTTP (announce/lookup com validação e TTL de 15 min) — deploy em VPS próprio, zero dependência de terceiros; endpoints testados via curl
- **Multi-tracker**: `DISTORRENT_BOOTSTRAP_URL` aceita lista separada por vírgula; announce em todos, lookup até encontrar

### Corrigido (nada local/dead)
- Bootstrap padrão apontava para `distorrent-bootstrap.fly.dev` que está MORTO — descoberta pela internet quebrada por padrão; agora sem default fake: sem tracker configurado, o motor avisa e UPnP/manual seguem ativos
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
- E2E `distorrent-core/tests/e2e_two_users.rs`: dois usuários completos em "redes diferentes" conectados por PROXY TCP — amizade, DM ida-e-volta com ACK, grupo, comunidade com convite assinado, sincronização de canais/cargos, kick, queda de rede → pending → reconexão → entrega, e identidade estável após reinício

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
- Fingerprint `blake3(pub_bytes)` alinhado TS↔Rust `distorrent-core/src/identity.rs:89` (era `blake3(hex_str)`)
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
- Instalação user-space: `~/.local/bin/distorrent` + entrada no menu de aplicativos

### Corrigido
- **Crash na abertura do app** (engine era spawnado fora do runtime tokio dos commands do Tauri — agora o boot roda em `tauri::async_runtime`)
- **Ícone**: substituído o placeholder (logo Firefox) por ícone DisTorrent próprio (blurple #5865f2, "F" branco) em 32/48/128/256/512
- Eleição de sessão determinística (dial simultâneo não gera mais flaps de conexão)
- Discovery funciona também entre dois processos na mesma máquina (loopback broadcast)
- 4 testes de integração de amizade (19/19 total verde)

## 0.2.0 — Motor real (2026-08-30)

### Adicionado
- **`distorrent-core`**: motor Rust puro com identidade ed25519, storage SQLite (WAL) e rede P2P real
  - Handshake autenticado (ed25519 sobre transcript + X25519 efêmero → HKDF → ChaCha20Poly1305)
  - Discovery LAN via UDP broadcast (porta 45900) com validação de fingerprint
  - Engine com estados reais de conexão (DISCONNECTED/CONNECTING/CONNECTED/RECONNECTING), heartbeat 10s, timeout 25s, reconexão com backoff 1s→15s
  - DMs assinadas com ACK de entrega; estados PENDING/SENDING/SENT/DELIVERED/FAILED
  - Outbox persistente: mensagens feitas offline são entregues ao reconectar
  - 15 testes (11 unit + 4 integração com dois nós reais em TCP)
- Shell Tauri 2 (migração do 1.6 — Ubuntu 24.04 removeu libsoup-2.4)
- Keyring do SO para a chave privada (fallback SQLite documentado)
- Camada `services` na UI (nativo/navegador-honesto) + hooks; DisTorrent visual intocado
- Docs: ARCHITECTURE v2, PROTOCOL v1 (implementado), THREAT_MODEL, AUX_SERVICES

### Removido
- `src/shared/mocks.ts` e todo dado fictício da UI (usuários, DMs, comunidades, mensagens fake)
- Protótipo `src/lab/DesignLab.tsx` e artefatos de build (`dist`, `vite.config.js/.d.ts`, tsbuildinfo)

## 0.1.0 — Protótipo visual
- DisTorrent e 5 designs alternativos; UI React + Vite; identidade parcial (ed25519 em TS)
