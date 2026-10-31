package com.distorrent.app

import android.content.Intent
import android.webkit.WebView

/**
 * Activity do DisTorrent.
 *
 * ## Permissões: pedidas sob demanda, NUNCA no boot
 *
 * Versão anterior chamava `ensureStoragePermissions()` dentro de `onCreate`, e
 * isso fazia o app abrir três diálogos de permissão na primeira tela — antes
 * de o usuário pedir, escolher ou baixar qualquer coisa. Além de irritar,
 * treina o usuário a clicar em "Permitir" no susto e faz o app parecer
 * invasivo sem motivo.
 *
 * Hoje o app **não pede nada no boot**. Cada permissão é pedida no instante em
 * que ela é realmente usada:
 *
 * - **Microfone/câmera**: pelo fluxo padrão do WebView
 *   (`RustWebChromeClient.onPermissionRequest` → `permissionLauncher`), que só
 *   dispara quando a página chama `getUserMedia` — ou seja, quando o usuário
 *   aceita/atende uma chamada. Nada antes disso.
 * - **Escolher arquivo para anexar**: pelo `onShowFileChooser` do WebView, que
 *   no Android abre o seletor do sistema (SAF/Photo Picker). Esse caminho
 *   **não exige** `READ_MEDIA_*`: o usuário escolhe o arquivo explicitamente.
 * - **Salvar um arquivo baixado**: `save_file` (Rust) grava no diretório
 *   privado do app via `app_data_dir()`, com escrita atômica (`.distorrent-part` +
 *   rename). Diretório privado = **nenhuma permissão de armazenamento
 *   necessária**, em qualquer versão do Android (scoped storage).
 * - **Notificação**: `POST_NOTIFICATIONS` é pedido quando a pessoa liga os
 *   avisos (`NotificationPrompt` / Configurações), nunca no boot.
 *
 * As permissões de mídia continuam DECLARADAS no AndroidManifest porque o
 * WebView só concede `getUserMedia` se elas estiverem lá. Declarar não é
 * pedir — pedir acontece no `permissionLauncher` do `onPermissionRequest`.
 */
class MainActivity : TauriActivity() {

  /**
   * Registra os plugins nativos. Feito em `onWebViewCreate` (e não em
   * `onCreate`) porque é o ponto em que o WebView existe e o Tauri já montou o
   * plugin manager.
   *
   * Cada um resolve um problema concreto de plataforma:
   * - `downloads`: grava no Downloads REAL via MediaStore (scoped storage nega
   *   escrita direta em `/storage/emulated/0/Download`);
   * - `callfg`: serviço de chamada em primeiro plano (Android 14+ corta
   *   mic/câmera ao minimizar sem ele);
   * - `updater`: abre o instalador do sistema para o APK já verificado;
   * - `callnotif`: notificação de chamada em TELA CHEIA com Atender/Recusar (o
   *   plugin genérico não faz full-screen intent nem botões);
   * - `bgservice`: mantém o processo conectado com a tela apagada, senão o
   *   Android mata o app e nenhuma mensagem/chamada chega.
   */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)

    loadPlugin(webView, "downloads", "distorrentDownloads") { DownloadsPlugin(this) }
    loadPlugin(webView, "callfg", "distorrentCallFg") { CallForegroundPlugin(this) }
    loadPlugin(webView, "updater", "distorrentUpdater") { UpdaterPlugin(this) }
    loadPlugin(webView, "callnotif", "distorrentCallNotif") { CallNotificationPlugin(this) }
    loadPlugin(webView, "bgservice", "distorrentBgService") { BgServicePlugin(this) }
    // Mensagem com foto do remetente + estilo de conversa (ver o plugin).
    loadPlugin(webView, "msgnotif", "distorrentMsgNotif") { MessageNotificationPlugin(this) }

    // Boot a frio com "Atender"/"Recusar": a intenção chegou em `onCreate`,
    // ANTES de o WebView existir, e ninguém escutaria o evento. O plugin a
    // guarda e o frontend a busca em `plugin:callnotif|pendingAction`.
    try {
      callActionFromIntent(intent)?.let { (callId, action) ->
        CallNotificationPlugin.pendingAction = "$callId|$action"
      }
    } catch (e: Throwable) {
      android.util.Log.w("distorrentCallNotif", "ação inicial não guardada: ${e.message}")
    }
  }

  /** Registra um plugin sem deixar a falha de um derrubar o boot do app. */
  private inline fun loadPlugin(
    webView: WebView,
    name: String,
    logTag: String,
    build: () -> app.tauri.plugin.Plugin,
  ) {
    try {
      app.tauri.plugin.PluginManager.load(webView, name, build(), "{}")
    } catch (e: Throwable) {
      android.util.Log.w(logTag, "plugin $name não registrado: ${e.message}")
    }
  }

  /**
   * "Atender"/"Recusar" tocados com o app em segundo plano chegam aqui.
   *
   * O `CallActionReceiver` abre esta Activity com o `call_id` e a ação. O
   * `super` repassa a intenção a todos os plugins (`PluginManager.onNewIntent`)
   * e o `CallNotificationPlugin` publica o evento `action`, que o frontend
   * escuta com `addPluginListener('callnotif', 'action')`.
   *
   * Nada é aceito/recusado nativamente: quem sinaliza (SDP/ICE) é a página.
   */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    try {
      setIntent(intent)
    } catch (_: Throwable) { }
    callActionFromIntent(intent)?.let { (callId, action) ->
      CallNotificationPlugin.pendingAction = "$callId|$action"
    }
  }

  /** Extrai `(call_id, ação)` de uma intenção de chamada, se houver. */
  private fun callActionFromIntent(intent: Intent?): Pair<String, String>? {
    if (intent == null) return null
    val callId = intent.getStringExtra(CallNotificationPlugin.EXTRA_CALL_ID) ?: return null
    if (callId.isBlank()) return null
    val raw = intent.getStringExtra(CallActionReceiver.EXTRA_ACTION)
    val action = when (raw) {
      CallNotificationPlugin.ACTION_ACCEPT -> "accept"
      CallNotificationPlugin.ACTION_REJECT -> "reject"
      else -> "open"
    }
    return callId to action
  }

  /**
   * WebView pausado = JS congelado, mídia continua no processo do browser.
   *
   * O `WryActivity` chama `mWebView.onPause()` em `onPause`, e TODA a
   * sinalização, o roster e os watchdogs da chamada vivem em JS. Com um serviço
   * em primeiro plano ativo, o processo (e o áudio) sobrevive, mas a página para
   * de processar `call_offer`/`call_answer`/`voice_joined` — do ponto de vista
   * dos outros, o participante "entrou e sumiu".
   *
   * Por isso o WebView NÃO é pausado enquanto:
   * - há chamada ativa (`CallForegroundService`), ou
   * - o app está "conectado em segundo plano" (`BackgroundConnectionService`):
   *   é o que permite processar o `call_incoming` e os botões Atender/Recusar
   *   da notificação sem reabrir tudo do zero.
   *
   * Fora desses casos o comportamento é o de sempre (economia de bateria).
   */
  override fun onPause() {
    if (CallForegroundService.isRunning || BackgroundConnectionService.isRunning) {
      // Não chama super.onPause(): é ele que pausa o WebView.
      return
    }
    super.onPause()
  }

  // Nota (removido): existia aqui um `hasMediaPermissions()` que checava
  // READ_MEDIA_IMAGES/VIDEO/AUDIO e READ_EXTERNAL_STORAGE — permissões que o
  // manifest NÃO declara mais (foi o que fazia o Play Protect bloquear o APK).
  // Resultado: a função sempre devolvia `false` e ninguém a chamava. Código
  // morto que mentia sobre o estado do app — removido em vez de "consertado".
}
