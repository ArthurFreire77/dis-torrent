package com.distorrent.app

import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@TauriPlugin
class DownloadsPlugin(private val activity: android.app.Activity) : Plugin(activity) {

  @Command
  fun save(invoke: Invoke, path: String, name: String) {
    try {
      val safe = sanitize(name)
      if (safe.isEmpty()) {
        invoke.reject("nome de arquivo inválido")
        return
      }
      val ext = safe.substringAfterLast('.', "").lowercase()
      if (ext in BLOCKED_EXT) {
        invoke.reject("extensão de executável/script bloqueada: .$ext")
        return
      }
      val src = try { File(path).canonicalFile } catch (_: Throwable) { File(path) }
      if (!src.exists() || !src.isFile) {
        invoke.reject("arquivo de origem não encontrado: ${src.name}")
        return
      }
      if (!isInsideApp(src)) {
        invoke.reject("caminho de origem fora da área do app")
        return
      }
      if (src.length() > 220_000_000L) {
        invoke.reject("arquivo grande demais para mover para Downloads (máx ~200MB)")
        return
      }
      val dest =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          saveViaMediaStore(safe, src, invoke)
        } else {
          saveLegacy(safe, src, invoke)
        }
      try { if (!src.delete()) src.deleteOnExit() } catch (_: Throwable) { }
      invoke.resolve(JSObject().apply { put("path", dest) })
    } catch (e: Throwable) {
      invoke.reject("não consegui salvar em Downloads: ${e.message ?: e.javaClass.simpleName}")
    }
  }

  private fun saveViaMediaStore(name: String, src: File, invoke: Invoke): String {
    val resolver = activity.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.Downloads.DISPLAY_NAME, name)
      put(MediaStore.Downloads.MIME_TYPE, guessMime(name))
      put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
      put(MediaStore.Downloads.IS_PENDING, 1)
    }
    val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    val uri = resolver.insert(collection, values)
      ?: throw IllegalStateException("o Android recusou a criação do arquivo em Downloads")

    try {
      resolver.openOutputStream(uri)?.use { out -> src.inputStream().use { it.copyTo(out) } }
        ?: throw IllegalStateException("não consegui abrir o arquivo para escrita")
      values.clear()
      values.put(MediaStore.Downloads.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
      return "${Environment.DIRECTORY_DOWNLOADS}/$name"
    } catch (e: Throwable) {
      try { resolver.delete(uri, null, null) } catch (_: Throwable) { }
      throw e
    }
  }

  private fun saveLegacy(name: String, src: File, invoke: Invoke): String {
    val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
    if (!dir.exists()) dir.mkdirs()
    val dest = File(dir, name)
    src.copyTo(dest, overwrite = true)
    return dest.absolutePath
  }

  private fun sanitize(raw: String): String {
    val base = raw.substringAfterLast('/').substringAfterLast('\\')
    val cleaned = base.replace(Regex("[\\x00-\\x1f]"), "").trim()
    if (cleaned.isEmpty() || cleaned == "." || cleaned == ".." || cleaned.startsWith(".")) return ""
    return if (cleaned.length > 180) cleaned.take(180) else cleaned
  }

  private fun isInsideApp(f: File): Boolean {
    return try {
      val p = f.canonicalPath
      val roots = listOf(
        activity.filesDir,
        activity.cacheDir,
        activity.noBackupFilesDir,
        activity.getExternalFilesDir(null),
      )
      roots.filterNotNull().any { root ->
        val r = root.canonicalPath
        p == r || p.startsWith(r + File.separator)
      }
    } catch (_: Throwable) {
      false
    }
  }

  private companion object {
    val BLOCKED_EXT = setOf(
      "exe", "msi", "msp", "bat", "cmd", "com", "scr", "pif", "cpl",
      "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta",
      "jar", "apk", "dex", "sh", "bash", "py", "rb", "pl", "lnk", "reg",
      "dll", "so", "dylib", "app", "dmg", "pkg", "deb", "rpm", "elf",
    )
  }

  private fun guessMime(name: String): String {
    val ext = name.substringAfterLast('.', "").lowercase()
    return when (ext) {
      "jpg", "jpeg" -> "image/jpeg"
      "png" -> "image/png"
      "gif" -> "image/gif"
      "webp" -> "image/webp"
      "heic" -> "image/heic"
      "mp4" -> "video/mp4"
      "webm" -> "video/webm"
      "mkv" -> "video/x-matroska"
      "mp3" -> "audio/mpeg"
      "ogg" -> "audio/ogg"
      "wav" -> "audio/wav"
      "pdf" -> "application/pdf"
      "zip" -> "application/zip"
      "txt" -> "text/plain"
      else -> "application/octet-stream"
    }
  }
}
