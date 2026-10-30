---
name: DisTorrent
description: Use when working in the DisTorrent codebase (E:\Programas\dis-torrent) — P2P messenger with React/TS front-end, Rust core (distorrent-core) and Tauri 2 shell. Covers the code map, build/verify commands on this Windows machine, the voice-call architecture, the release/auto-update pipeline and the non-negotiable rules (local build, honest state, no API invention). Load before editing voice/call, media, network, Android or release code.
---

# Skill: distorrent

Guia operacional do projeto **DisTorrent** neste computador. Ele complementa
`AGENTS.md` (local, gitignored, com os caminhos e o backlog). Aqui está o que é
estável e o mapa do código; leia `AGENTS.md` para o histórico de correções.

## Regras de ouro (não negociáveis)

1. **Build é LOCAL.** Nunca disparar GitHub Actions para gerar binário.
2. **Honestidade sobre teste.** Build verde não prova áudio/vídeo/tela. Se não
   há como validar (sem dispositivo), diga — nunca afirme que rodou.
3. **Não invente API.** Antes de usar um método de `rtc`/`webrtc`/Tauri, confira
   o fonte no registry (`%USERPROFILE%\.cargo\registry\src\...`) ou nos `node_modules`.
4. **Comentários e mensagens de erro em pt-BR**, explicando o PORQUÊ e o bug que
   o trecho evita. O código é cheio desse padrão — siga.
5. **Erro honesto > estado falso.** Botão/status que promete o que a plataforma
   não tem é bug (ex.: verde "Conectado" sem track de mídia).
6. **Uma alavanca por ajuste.** Ex.: resolução de tela é aplicada NA CAPTURA,
   não também no encoder.
7. **Não quebre a interop** WebRTC browser ↔ mídia nativa Linux (SDP/ICE cru do
   Rust vs JSON do browser em `src/services/callWire.ts`; `max-bundle` + m-lines
   `recvonly` artificiais).

## Comandos (Windows, Node portátil — `npm` não está no PATH)

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:TEMP\node24\node-v24.22.1-win-x64;$env:PATH"
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run typecheck   # tsc -b
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run lint        # eslint .
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run test:unit   # node --test tests/index.ts
& "$env:TEMP\node24\node-v24.22.1-win-x64\npm.cmd" run build       # tsc -b && vite build
```

- Use `npm.cmd`, **nunca** `npm.ps1` (ExecutionPolicy bloqueia).
- `&&` não funciona no PowerShell: use `;` ou comandos separados.
- `pwsh` **não** está instalado: use `powershell -NoProfile -ExecutionPolicy Bypass`.

### ARMADILHA GRANDE: o Windows não compila o código Linux

`media_voice.rs`, `media_video.rs` e `media_dsp.rs` são
`#[cfg(target_os = "linux")]`. Um `cargo check` no Windows **não vê** esses
arquivos — erros de compilação passam e só aparecem no CI (já quebrou o build
duas vezes). Para verificar de verdade, use o **WSL**:

```powershell
wsl -e bash -lc "cd /mnt/e/Programas/dis-torrent/distorrent-core && cargo check --lib && cargo test --lib && cargo clippy --all-targets && cargo fmt --check"
wsl -e bash -lc "cd /mnt/e/Programas/dis-torrent/src-tauri && cargo check --lib && cargo fmt --check"
```

O WSL tem ALSA/GStreamer/glib instalados, então **tudo** compila e os testes de
mídia rodam (188 testes, contra 162 no Windows). Use isso antes de commitar
qualquer mudança em `media_*` ou em `voice_gate`.

### Android

```powershell
$env:ANDROID_HOME = "C:\Users\lucas\AppData\Local\Android\Sdk"
$env:NDK_HOME = "$env:ANDROID_HOME\ndk\27.0.12077973"
$env:JAVA_HOME = "C:\Users\lucas\jdk-17.0.13+11"
# 1) checar o alvo (pega erro em bloco cfg(android) do updater/background)
cargo check --target aarch64-linux-android --lib   # em src-tauri
# 2) .so + hard link (symlink falha sem Developer Mode) + Gradle
cargo build --target aarch64-linux-android --release
```

Depois: `mklink /H` do `libdistorrent_lib.so` para
`gen/android/app/src/main/jniLibs/arm64-v8a/` e
`gradlew.bat assembleDebug -x rustBuild*Debug`.

### Empacotar o Windows

```powershell
npm run tauri build -- --no-bundle          # gera distorent-cli.exe
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-installer.ps1 -SkipBuild
```

O `.exe` do app é `distorrent.exe` (copiado de `distorent-cli.exe`). Confira
`ProductVersion` **antes** de publicar — já saiu release com binário antigo.
Scan obrigatório: `MpCmdRun.exe -Scan -ScanType 3 -File <exe> -DisableRemediation`.

## Mapa do código

| Arquivo | Responsabilidade |
|---|---|
| `src/services/callManager.ts` | Núcleo das chamadas: PCs por peer, ICE, offer/answer, watchdogs, monitor nativo, roster |
| `src/services/callParticipants.ts` | Roster puro (add/remove/estado/apelido) — testável em Node |
| `src/services/callPhases.ts` / `callTiles.ts` / `callPlayback.ts` | Máquina de fases pura, quadrados da UI, volume por participante |
| `src/services/callWire.ts` | Formato no fio: JSON do browser vs SDP/candidato CRU do Rust |
| `src/services/screenShare.ts` | Constraints de captura, degraus de qualidade, backend nativo |
| `src/services/updateRules.ts` | Regras PURAS do auto-update (comparação de versão, fluxo) |
| `src/services/updater.ts` | Orquestração do auto-update sobre o `services` nativo |
| `src/components/UpdateGate.tsx` | Overlay de atualização no boot dos dois shells |
| `src/designs/ThemeShell.tsx` / `src/mobile/MobileShell.tsx` | UI desktop/mobile; troca em 768px |
| `distorrent-core/src/net/engine.rs` | Motor P2P: frames, presença, voz de canal, ticks |
| `distorrent-core/src/net/media_voice.rs` | Voz nativa (Linux): cpal, Opus, jitter, PLC, vídeo |
| `distorrent-core/src/net/voice_gate.rs` | Offer/ICE retidos até o aceite + drainer de sinais |
| `distorrent-core/src/storage.rs` | SQLite: mensagens, `voice_states`, kv |
| `src-tauri/src/lib.rs` | ~190 comandos Tauri, allowlist de permissões do WebView |
| `src-tauri/src/updater.rs` | Checagem/download/execução do instalador (hash SHA-256) |
| `src-tauri/gen/android/...` | `MainActivity.kt`, `CallForegroundService.kt`, plugins |

## Arquitetura da voz (o que quebra e onde olhar)

Dois caminhos de mídia:

- **Linux desktop**: mídia NATIVA em Rust (o WebKitGTK do Ubuntu não expõe
  `RTCPeerConnection`). `media_voice.rs` captura (cpal), encoda (Opus/GStreamer)
  e envia RTP por par. O core absorve `CallOffer/Answer/Ice` e o JS não vê.
- **Windows / Android / macOS**: WebRTC da WebView. Cada peer tem uma
  `RTCPeerConnection`; o roster vem do core por eventos + SQLite.

Pontos que já causaram os bugs relatados de "conectado mas não aparece":

1. **Roster assimétrico** — `VoiceJoin` ia uma vez e só para quem já estava
   `Online` (envio para peer sem link é no-op silencioso). Há re-anúncio a cada
   15 s, flush na sessão nova e anúncio reverso. Não remova.
2. **Roster mutado in-place** — o manager faz `push`/`splice` e emite
   `{...state}`. Os shells memoízam `useMemo(..., [participants])`; sem clonar o
   array em `onUpdate`, os tiles e os `<audio>` ficam congelados. **Nunca** emitir
   o mesmo array.
3. **Agregado é o PIOR par** — `aggregate_stats` decide o estado pelo pior peer.
   Quem consome precisa de `peers_connected` antes de chamar `leave()`.
4. **`Disconnected` do ICE** não é "connected": rota morta com `packets_out`
   subindo é a mentira clássica.
5. **`voice_states` é persistente** — limpar no boot (meu fp) e no `PeerOffline`.

## Auto-update (GitHub Releases)

- **Tela de boot própria** (`src/components/UpdateBootScreen.tsx`): aparece
  SEMPRE na inicialização e diz o que está acontecendo (procurando / já é a
  mais nova / baixando / instalando / sem conexão). Teto de 12 s para rede ruim
  não travar; 3 retentativas com backoff no boot e rechecagem a cada 6 h.
- `update_check` lê `/releases/latest`, escolhe o asset da plataforma e devolve
  os metadados. A decisão de versão é pura em `updateRules.ts`
  (`1.1.11 > 1.1.10`; comparar como string inverteria e criaria loop).
- `update_download` só aceita URL sob `github.com/ArthurFreire77/dis-torrent/releases/download/`,
  extensão por plataforma e confere o `digest` SHA-256 antes de gravar.
- `update_apply`: Windows executa o Inno com `/SILENT /CLOSEAPPLICATIONS
  /RESTARTAPPLICATIONS` (instala e reabre); Linux abre o instalador; **Android
  chama `plugin:updater|installApk`** (Kotlin) que entrega o APK ao instalador
  do sistema por `content://` (FileProvider + `REQUEST_INSTALL_PACKAGES`).
  O toque de confirmação é obrigatório e não dá para contornar fora da loja.
- Falha de rede **não** bloqueia o boot; instalador que falha é marcado em
  `update.failed` para não reiniciar em loop.

## Abrir junto com o Windows

`background.rs::init` liga o autostart no **primeiro** boot (plugin oficial
`tauri-plugin-autostart`) e grava `ui.autostart_decided` quando o usuário mexe
no checkbox em `SystemNotificationSettings` — depois disso nada é automático.
Publicar uma release nova NÃO precisa mexer nisso.

## Publicar (quando o workflow falhar)

Se o job `Release` quebrar, publique à mão com a credencial do git:

```powershell
$cred = "protocol=https`nhost=github.com`n`n" | git credential fill
# POST /repos/<owner>/<repo>/releases  (tag limpa, prerelease=false)
# POST https://uploads.github.com/.../releases/<id>/assets?name=<arquivo>
```

Confira depois em `GET /releases/latest` que o asset está lá **com `digest`** —
sem `digest` o app se recusa a executar o instalador (por segurança).

## Release

Tag limpa (`v1.1.10`), nome com sufixo (`DisTorrent 1.1.10-pre-alpha`),
`prerelease: false` para aparecer como Latest. Instalador Windows é **Inno
Setup** (`installer/distorent.iss`), nunca NSIS (falso positivo do Defender).
Ver `AGENTS.md` §9 antes de publicar — inclusive o teste com MOTW.

## Verificação antes de entregar

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .opencode/skills/distorrent/run-verify.ps1
```

(`pwsh` NÃO está instalado nesta máquina — use `powershell`. O aviso de
`NativeCommandError` que aparece no meio é o PowerShell tratando o **stderr** do
cargo como erro; o resultado real é o resumo `OK/FALHOU` no fim.)

Ele roda typecheck + lint + unit + `cargo check`/`test`/`fmt --check` nos dois
crates e imprime o resumo. Se algo falhar, **não** commite: conserte ou reporte.

## Commit

Formato `tipo(escopo): resumo no imperativo` + corpo em pt-BR com o PORQUÊ.
Um assunto por commit, `git add` por caminho (nunca `-A`), sem `AGENTS.md`,
binários ou `target/`.
