package com.distorrent.app

import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.Signature
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
import java.security.MessageDigest

@TauriPlugin
class UpdaterPlugin(private val activity: android.app.Activity) : Plugin(activity) {

  /// Certificado do app instalado (SHA-256 do signer).
  private fun assinaturaInstalada(): String? {
    return try {
      val pm = activity.packageManager
      val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        pm.getPackageInfo(activity.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
      } else {
        @Suppress("DEPRECATION")
        pm.getPackageInfo(activity.packageName, PackageManager.GET_SIGNATURES)
      }
      val signers: Array<Signature>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        info.signingInfo?.apkContentsSigners
      } else {
        @Suppress("DEPRECATION")
        info.signatures
      }
      val sig = signers?.firstOrNull() ?: return null
      val md = MessageDigest.getInstance("SHA-256")
      md.update(sig.toByteArray())
      md.digest().joinToString("") { "%02x".format(it) }
    } catch (_: Throwable) {
      null
    }
  }

  /// Certificado de um APK lido do arquivo (fora do pacote instalado).
  private fun assinaturaDoApk(file: File): String? {
    return try {
      val pm = activity.packageManager
      val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        PackageManager.GET_SIGNING_CERTIFICATES
      } else {
        @Suppress("DEPRECATION")
        PackageManager.GET_SIGNATURES
      }
      val info = pm.getPackageArchiveInfo(file.absolutePath, flags) ?: return null
      val signers: Array<Signature>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        info.signingInfo?.apkContentsSigners
      } else {
        @Suppress("DEPRECATION")
        info.signatures
      }
      val sig = signers?.firstOrNull() ?: return null
      val md = MessageDigest.getInstance("SHA-256")
      md.update(sig.toByteArray())
      md.digest().joinToString("") { "%02x".format(it) }
    } catch (_: Throwable) {
      null
    }
  }

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

      val atual = assinaturaInstalada()
      val novo = assinaturaDoApk(file)
      if (atual == null || novo == null || atual != novo) {
        invoke.reject(
          "o APK não foi assinado com a mesma chave do DisTorrent instalado — " +
            "atualização recusada (baixe o APK oficial da release)",
        )
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
