# Notificações, segundo plano e presença (Windows e Android)

Este documento descreve o que foi implementado, **onde vive cada peça**, quais
limites são do sistema operacional (e não bugs) e o que foi realmente testado.

Regra que guia tudo: **conexão ≠ presença** e **nada de estado falso**. Botão que
promete o que a plataforma não tem é bug.

---

## 1. Três estados independentes

| Estado | O que significa | Onde é decidido |
|---|---|---|
| `connection` | o motor P2P fala com a rede? | `distorrent-core` → `network_status` / evento `state_changed` |
| `activity` | a janela está visível **e em foco**? | `src/services/appState.ts` (foco/blur, visibilitychange, evento nativo `distorrent://activity`) |
| `presence` | o que o usuário escolhe mostrar | `appState.ts` + preferências |

Presença efetiva (`notificationRules.derivePresence`):

- `online` + janela fora de foco → **`idle` (ausente)**;
- `online` + janela em uso → `online`;
- `dnd`, `invisible`, `offline`, `idle` escolhidos → **não mudam sozinhos**;
- preferência `presenceInBackground = 'online'` → continua `online` minimizado
  (quem está ouvindo voz e quer aparecer online).

O ícone da bandeja **nunca** mostra presença: ele mostra só o estado da REDE
(conectado / instável / sem conexão) e a contagem de não-lidas.

## 2. Windows (desktop)

| Recurso | Mecanismo real | Arquivo |
|---|---|---|
| Ícone na bandeja | `tauri` feature `tray-icon` | `src-tauri/src/background.rs` |
| Fechar (X) → bandeja | `WindowEvent::CloseRequested` + `api.prevent_close()` | `src-tauri/src/lib.rs` |
| Sair de verdade | menu da bandeja / botão nas configurações → `app_quit` | `background.rs` |
| Iniciar com o Windows | `tauri-plugin-autostart` (chave `Run` do usuário, via API) | `lib.rs` + `background.rs` |
| Toast de mensagem/chamada | `tauri-plugin-notification` (toast WinRT) | `background.rs` |
| Abrir a conversa certa no clique | `on_action` → evento `distorrent://notification-action` | `background.rs` → `notifications.ts` |

**AppUserModelID.** O toast do Windows só aparece quando o atalho do app traz
`System.AppUserModel.ID` igual ao `identifier` do `tauri.conf.json`
(`com.distorrent.app`). Por isso o instalador Inno cria os atalhos com
`AppUserModelID: "com.distorrent.app"` (`installer/distorent.iss`). Sem isso a
notificação é descartada em silêncio pelo Windows.

**Autostart sem administrador:** a chave `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
é do usuário. O plugin oficial grava por API — o app **não** executa `reg.exe`,
PowerShell ou script nenhum. Isso é deliberado (ver §5).

## 3. Android

| Recurso | Mecanismo real | Arquivo |
|---|---|---|
| Permissão de notificação | `plugin:notification|request_permission` (plugin oficial) | `NotificationPrompt.tsx` / `SystemNotificationSettings.tsx` |
| Pergunta contextual (~1 min, uma vez) | `NotificationPrompt` + `prefs.notifPromptDone` | `src/components/NotificationPrompt.tsx` |
| Notificação de mensagem/chamada | plugin oficial (NotificationManager) + canal `distorrent_messages` | `background.rs` |
| Chamada em segundo plano | `CallForegroundService` tipo `microphone` | `CallForegroundService.kt` + `CallForegroundPlugin.kt` |
| Abrir a conversa no toque | mesmo `on_action` do desktop | `background.rs` |

O contrato `plugin:callfg|start` / `|stop` **já era chamado** pelo
`callManager` (início/aceite de chamada e entrada em canal de voz). Faltava o
lado nativo: o `invoke` falhava em silêncio e o Android 14+ cortava o microfone
ao minimizar. Agora o plugin existe, o serviço usa
`foregroundServiceType="microphone"` e o serviço **para** ao terminar a chamada.

**O que NÃO existe (e é dito na UI):**

- Push notifications: não há servidor central — é P2P. Sem processo vivo e sem
  par acessível, a mensagem **não** chega. A UI não promete o contrário.
- Serviço permanente de "ficar online": um FGS `dataSync` eterno é justamente o
  uso que o Android restringe. Fora de chamada, a conexão dura enquanto o
  processo viver (e o fabricante pode encerrá-lo — a tela de configurações diz
  isso, sem prometer execução ininterrupta).
- Autostart: o Android não permite iniciar app sozinho. `autostartGet` devolve
  `false` e `autostartSet` devolve erro honesto; a opção nem aparece.

## 4. Permissões (todas com motivo técnico)

| Permissão | Por que |
|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE` | rede P2P (já existiam) |
| `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `CAMERA` | chamada de voz/vídeo, pedidas só no uso |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MICROPHONE` | manter microfone em chamada fora da tela (Android 14+) |
| `FOREGROUND_SERVICE_CAMERA` | mesmo caso, vídeo |
| `WAKE_LOCK` | não deixar a CPU dormir durante a chamada |
| `POST_NOTIFICATIONS` | mostrar mensagem/chamada (Android 13+), pedida no contexto |

Não há `READ_MEDIA_*`, `CAPTURE_VIDEO_OUTPUT`, permissão de contatos ou de
localização. Nada foi adicionado além do que o recurso usa.

## 5. Antivírus / transparência

O instalador Windows já sofreu falso positivo do Defender com o stub do NSIS
(por isso migrou para Inno Setup). Nada nesta entrega reintroduz aquele padrão:

- **sem shell**: nenhuma escrita de persistência via `reg.exe`, PowerShell, `cmd`;
- **sem processo oculto**: o app em segundo plano é visível (bandeja/notificação);
- **sem download em runtime**: sons são sintetizados no app (WebAudio) e o toast
  usa o motor do próprio sistema;
- **sem ofuscação**: código comentado no porquê, sem payload codificado;
- **plugins oficiais** (`tauri-plugin-notification`, `tauri-plugin-autostart`)
  em vez de mecanismos próprios de persistência/notificação.

## 6. Preferências (persistidas)

`src/shared/prefs.ts` (localStorage) e, para o que o shell precisa ANTES da UI
subir, o `kv` do SQLite (`ui.close_to_tray`, `ui.start_minimized`):

`notifySystem`, `notifyPreview`, `notifySounds`, `notifyCallSounds`,
`presenceInBackground`, `closeToTray`, `startMinimized`, `autostart`,
`notifPromptDone`, `myPresence` — além das já existentes
(`notifDefault`, `mutedChannels`, `mutedServers`, `channelLevel`).

A tela fica em Configurações → Notificações (`SystemNotificationSettings`).

## 7. Testes executados

Automatizados (rodados nesta máquina):

- `npm run typecheck` → 0 erros
- `npm run lint` → 0
- `npm run test:unit` → **152/152** (inclui `tests/notifications.test.ts`, 20
  casos: presença em segundo plano, id estável, dedupe com teto, nível
  silenciado/menções, prévia desligada não vaza texto, agregação de contagem)
- `npm run build` → OK
- `cargo check --tests` no `src-tauri` (Windows) → OK (só warnings pré-existentes
  do `distorrent-core`)

**Não foi possível validar nesta máquina** (limitação real, não "passou"):

- boot do Windows com autostart ligado/desligado (precisa de sessão real);
- toast do Windows com app instalado (precisa do Inno rodado + atalho com AUMID);
- chamada/mensagem com o app na bandeja entre duas instâncias;
- Android: build do APK, permissão concedida/negada, chamada com tela bloqueada,
  encerramento de processo pelo fabricante, Doze. São itens do checklist de
  dispositivo (§8).

## 8. Checklist manual (dispositivo)

Windows:

1. Instalar pelo Inno; confirmar atalhos e `AppUserModelID` no atalho.
2. Configurações → Notificações → ligar "Iniciar com o Windows"; reiniciar a
   sessão; o app deve subir (na bandeja se "iniciar minimizado" estiver ligado).
3. Desligar a opção e confirmar que NÃO sobe.
4. Fechar a janela (X) → app segue na bandeja; mandar mensagem de outro device:
   toast aparece, clique abre a conversa certa.
5. Minimizar e receber chamada: overlay/aviso aparece; aceitar e recusar.
6. Bandeja → "Sair do DisTorrent": processo encerra (conferir no Gerenciador).
7. Com a janela fechada, olhar o status do contato do lado de fora: deve
   aparecer **ausente**, não online (a menos que a preferência seja "online").

Android:

1. Primeira execução: após ~1 min, a pergunta "Ativar notificações?" aparece
   **uma** vez (não volta depois de responder).
2. Conceder → mandar mensagem de outro device com o app em segundo plano.
3. Negar → nenhuma notificação; a tela de configurações explica onde reativar.
4. Chamada com o app minimizado: notificação permanente "em chamada" e mic vivo
   (log de `packets_out` crescendo); ao encerrar, a notificação some.
5. Bloquear a tela durante a chamada; atender/recusar pela notificação.
6. Matar o app pela lista de recentes: nenhuma notificação depois (correto — não
   existe push).

## 9. Compilar e validar

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:TEMP\node24\node-v24.22.1-win-x64;$env:PATH"
npm run typecheck; npm run lint; npm run test:unit; npm run build
cd src-tauri; cargo check --tests; cargo fmt --check
```

Windows instalador (Inno, o que registra o AUMID):

```powershell
.\scripts\build-installer.ps1 -SkipBuild -Scan
```

Android (SDK + NDK + JDK 17, ver `AGENTS.md §13`):

```powershell
cd src-tauri; cargo build --target aarch64-linux-android --release
# hard link do .so para jniLibs e:
cd src-tauri\gen\android; .\gradlew.bat assembleDebug -x rustBuildArm64Debug -x rustBuildArmDebug -x rustBuildX86Debug -x rustBuildX86_64Debug -x rustBuildUniversalDebug
```

## 10. Toque de chamada (quem marca o ritmo)

O toque deixou de ser um `setInterval` da página. Com a janela escondida, o
Chromium **estrangula timers** de página oculta — o telefone tocava uma vez e
ficava mudo, justamente no cenário de segundo plano.

| Plataforma | Mecanismo | Arquivo |
|---|---|---|
| Windows/Linux | thread nativa emite `distorrent://ring` a cada 1,8 s (teto de 90 s); a página só toca o bipe ao receber | `background.rs` (`call_ring_start/stop`) + `sfx.ts` |
| Android | `Ringtone` do SISTEMA em loop (`API 28+`), via `plugin:callfg|ringStart/ringStop` — respeita volume/silencioso/DND e continua com a tela bloqueada | `CallForegroundPlugin.kt` + `sfx.ts` |
| Navegador / shell antigo | fallback `setInterval` + WebAudio (melhor que silêncio) | `sfx.ts` |

O toque para em atender, recusar, receber `call_ended`, fechar o overlay e ao
encerrar o serviço de chamada (`stopRingtone()` no `stop`).

## 11. Pendências conhecidas

- **Silenciar a notificação do meu próprio device**: hoje o aviso é filtrado por
  "só em segundo plano" + níveis de canal, não por "esta conversa está aberta em
  outra instância". Em teste com duas instâncias no MESMO perfil pode haver
  aviso redundante.
- **Windows: não existe como FECHAR um toast já exibido.** Verificado no código
  do `notify-rust` 4.18 (tabela de suporte da crate): `NotificationHandle::close`
  existe em XDG/macOS e **não** no Windows. Consequências reais: o aviso sai da
  tela pelo timeout do Windows e some do Action Center quando o usuário limpa; o
  app **descarta o mapa notificação→conversa** ao cancelar, então um clique
  atrasado não abre conversa errada. No Android o `auto_cancel` remove o aviso
  no toque.
- **Android sem processo vivo não há toque/aviso**: não existe push (arquitetura
  P2P). Se o fabricante matar o app, a chamada não chega até ele — a UI diz
  isso e não promete o contrário.
- **macOS/iOS**: o caminho `desktop` (bandeja + autostart + notificações) é
  compilado para qualquer target desktop, então macOS herda o mesmo código; não
  foi executado nem testado nesta máquina (o alvo validado é Windows). iOS não
  tem nenhum caminho implementado.
