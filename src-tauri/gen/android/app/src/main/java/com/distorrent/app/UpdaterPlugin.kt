package com.distorrent.app

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

/**
 * Ponte `plugin:updater|installApk` — instala o APK que o Rust baixou.
 *
 * ## Por que este plugin existe
 *
 * O auto-update já baixa o `.apk`, confere o SHA-256 e grava em
 * `data_dir/updates/`. No Windows o instalador roda sozinho. No Android isso
 * era impossível **daqui**, então a UI só abria o link da release — o usuário
 * tinha que baixar de novo e instalar à mão, o que contradiz o pedido de
 * "atualizar sozinho".
 *
 * O que o Android permite (e é o máximo honesto):
 *  1. o app baixa e verifica o APK (já feito no Rust);
 *  2. o app **abre o instalador do sistema** com esse arquivo
 *     (`ACTION_VIEW` + `application/vnd.android.package-archive`);
 *  3. o usuário confirma — o Android **não permite** instalar sem toque por
 *     app comum, fora do Play/ADB. Quem promete "instalação silenciosa" fora de
 *     loja está mentindo (só `INSTALL_PACKAGES`, permissão de sistema, permite).
 *
 * O clique no instalador é o único passo manual, e é intencional do sistema.
 *
 * ## Requisitos que este arquivo cobre
 *
 *  - `REQUEST_INSTALL_PACKAGES` no manifesto;
 *  - `FileProvider` declarado no manifesto com `res/xml/file_paths.xml` —
 *    desde o Android 7 (`N`) `file://` entre apps lança
 *    `FileUriExposedException`; o APK precisa sair por `content://`;
 *  - Android 8+ (`O`): `canRequestPackageInstalls()`; se o app não tem
 *    permissão, o `intent` não aparece e o usuário acha que travou. Abrimos a
 *    tela de permissão específica e devolvemos erro explicando o que fazer;
 *  - o arquivo TEM de estar dentro de um diretório coberto pelo FileProvider.
 */
@TauriPlugin
class UpdaterPlugin(private val activity: android.app.Activity) : Plugin(activity) {

  @Command
  fun installApk(invoke: Invoke, path: String) {
    try {
      if (path.isBlank()) {
        invoke.reject("caminho do APK vazio")
        return
      }
      val file = File(path)
      if (!file.isFile || file.length() == 0L) {
        invoke.reject("APK não encontrado em $path (o download falhou?)")
        return
      }
      // Só instala APK: a chamada vem do nosso Rust, mas um caminho errado
      // virando `ACTION_VIEW` de outro tipo de arquivo seria um vetor bobo.
      if (!file.name.lowercase().endsWith(".apk")) {
        invoke.reject("o arquivo não é um APK: ${file.name}")
        return
      }

      // Android 8+: sem "instalar apps desconhecidos" ligado, o instalador nem
      // abre. Abrimos a tela certa e explicamos, em vez de falhar em silêncio.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        !activity.packageManager.canRequestPackageInstalls()
      ) {
        try {
          val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
            data = Uri.parse("package:${activity.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          activity.startActivity(settings)
        } catch (_: Throwable) { /* ROM sem essa tela: o erro abaixo explica */ }
        invoke.reject(
          "autorize \"instalar apps desconhecidos\" para o DisTorrent e toque em atualizar de novo",
        )
        return
      }

      val authority = "${activity.packageName}.fileprovider"
      val uri = FileProvider.getUriForFile(activity, authority, file)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      activity.startActivity(intent)

      val out = JSObject()
      out.put("aberto", true)
      invoke.resolve(out)
    } catch (e: Throwable) {
      invoke.reject(
        "não consegui abrir o instalador: ${e.message ?: e.javaClass.simpleName}",
      )
    }
  }

  /**
   * Diz se o aparelho permite instalar APK por este app.
   *
   * A UI usa isto para mostrar a instrução ANTES do download (em vez de deixar
   * o usuário baixar 40 MB para descobrir que falta um toggle).
   */
  @Command
  fun canInstall(invoke: Invoke) {
    try {
      val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        activity.packageManager.canRequestPackageInstalls()
      } else {
        true
      }
      val out = JSObject()
      out.put("permitido", ok)
      invoke.resolve(out)
    } catch (e: Throwable) {
      invoke.reject("falha ao consultar permissão de instalação: ${e.message}")
    }
  }
}
