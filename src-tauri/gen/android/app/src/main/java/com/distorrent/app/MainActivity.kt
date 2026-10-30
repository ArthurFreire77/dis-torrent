package com.distorrent.app

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
 *
 * As permissões de mídia continuam DECLARADAS no AndroidManifest porque o
 * WebView só concede `getUserMedia` se elas estiverem lá. Declarar não é
 * pedir — pedir acontece no `permissionLauncher` do `onPermissionRequest`.
 */
class MainActivity : TauriActivity() {

  /**
   * Registra o plugin nativo de salvamento no Downloads REAL (MediaStore).
   *
   * Feito em `onWebViewCreate` (e não em onCreate) porque é o ponto em que o
   * WebView existe e o Tauri já montou o plugin manager.
   *
   * Por que existe: o `save_file` em Rust grava no diretório privado do app,
   * porque o Android 10+ (scoped storage) bloqueia escrita direta em
   * /storage/emulated/0/Download. Com este plugin o botão "Baixar" grava onde
   * o usuário realmente procura — a pasta Downloads do sistema.
   */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    try {
      app.tauri.plugin.PluginManager.load(
        webView,
        "downloads",
        DownloadsPlugin(this),
        "{}"
      )
    } catch (e: Throwable) {
      android.util.Log.w("distorrentDownloads", "plugin downloads não registrado: ${e.message}")
    }
    // Serviço de chamada em primeiro plano. O frontend já invoca
    // `plugin:callfg|start`/`|stop` (callManager) — sem este registro o invoke
    // falhava em silêncio e o Android 14+ cortava o microfone ao minimizar.
    try {
      app.tauri.plugin.PluginManager.load(
        webView,
        "callfg",
        CallForegroundPlugin(this),
        "{}"
      )
    } catch (e: Throwable) {
      android.util.Log.w("distorrentCallFg", "plugin callfg não registrado: ${e.message}")
    }
  }

  /**
   * WebView pausado = JS congelado, mídia continua no processo do browser.
   *
   * O `WryActivity` chama `mWebView.onPause()` em `onPause`, e TODA a
   * sinalização, o roster e os watchdogs da chamada vivem em JS. Com o FGS
   * ligado, o processo (e o áudio) sobrevive, mas a página para de processar
   * `call_offer`/`call_answer`/`voice_joined` — do ponto de vista dos outros,
   * o participante "entrou e sumiu". Durante uma chamada ativa NÃO pausamos o
   * WebView; fora dela o comportamento é o de sempre (economia de bateria).
   */
  override fun onPause() {
    if (CallForegroundService.isRunning) {
      // Não chama super.onPause(): é ele que pausa o WebView. O ciclo do
      // Activity (foco, visibilidade) não é usado pelo app.
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

