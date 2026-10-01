package com.forge.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat

/**
 * Activity do FORGE / DisTorrent.
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
 *   privado do app via `app_data_dir()`, com escrita atômica (`.forge-part` +
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
  override fun onWebViewCreate(webView: android.webkit.WebView) {
    super.onWebViewCreate(webView)
    try {
      app.tauri.plugin.PluginManager.load(
        webView,
        "downloads",
        DownloadsPlugin(this),
        "{}"
      )
    } catch (e: Throwable) {
      android.util.Log.w("ForgeDownloads", "plugin downloads não registrado: ${e.message}")
    }
  }

  /**
   * Consulta (sem pedir) se as permissões de mídia já foram concedidas.
   * Usado por código nativo/diagnóstico para explicar por que `getUserMedia`
   * foi negado, sem disparar diálogo nenhum.
   */
  fun hasMediaPermissions(): Boolean {
    val needed: Array<String> = when {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> arrayOf(
        Manifest.permission.READ_MEDIA_IMAGES,
        Manifest.permission.READ_MEDIA_VIDEO,
        Manifest.permission.READ_MEDIA_AUDIO,
      )
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.M -> arrayOf(
        Manifest.permission.READ_EXTERNAL_STORAGE,
      )
      else -> return true // < API 23: declarar no Manifest basta
    }
    return needed.all {
      ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }
  }
}
