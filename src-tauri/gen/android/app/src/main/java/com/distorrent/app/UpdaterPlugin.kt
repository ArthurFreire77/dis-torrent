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
      if (!file.name.lowercase().endsWith(".apk")) {
        invoke.reject("o arquivo não é um APK: ${file.name}")
        return
      }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        !activity.packageManager.canRequestPackageInstalls()
      ) {
        try {
          val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
            data = Uri.parse("package:${activity.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          activity.startActivity(settings)
        } catch (_: Throwable) {  }
        invoke.reject(
          "autorize \"instalar apps desconhecidos\" para o DisTorrent e toque em atualizar de novo",
        )
        return
      }

      val authority = "${activity.packageName}.fileprovider"
      val uri = try {
        FileProvider.getUriForFile(activity, authority, file)
      } catch (e: Throwable) {
        // Caminho fora dos roots do FileProvider: o installApk recebia um
        // arquivo que o provider não conhece e a atualização morria com
        // IllegalArgumentException sem dizer nada de útil.
        invoke.reject(
          "o APK foi baixado em $path, fora da pasta que o instalador pode ler — " +
            "baixe de novo pelo cartão de atualização (${e.message ?: e.javaClass.simpleName})",
        )
        return
      }
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
      // Sem app que trate ACTION_VIEW o usuário não vê nada acontecer. O
      // PackageInstaller é o caminho nativo do sistema e sempre existe.
      try {
        val packageUri = Uri.fromFile(File(path))
        val instalar = Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
          data = packageUri
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
          putExtra(Intent.EXTRA_RETURN_RESULT, false)
        }
        val resolver = activity.packageManager.resolveActivity(instalar, 0)
        if (resolver != null) {
          activity.startActivity(instalar)
          val out = JSObject()
          out.put("aberto", true)
          invoke.resolve(out)
          return
        }
      } catch (_: Throwable) {  }
      invoke.reject(
        "não consegui abrir o instalador: ${e.message ?: e.javaClass.simpleName}",
      )
    }
  }

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
