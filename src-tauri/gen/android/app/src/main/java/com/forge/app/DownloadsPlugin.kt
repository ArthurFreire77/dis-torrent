package com.forge.app

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

/**
 * Salvamento no Downloads REAL do Android (MediaStore).
 *
 * ## Por que este plugin existe
 *
 * O `save_file` (Rust) grava no diretório privado do app
 * (`app_data_dir()/Download`), porque o Android 10+ (scoped storage) **nega**
 * escrita direta em `/storage/emulated/0/Download`. O usuário apertava
 * "Baixar" e o arquivo sumia numa pasta estranha — sem aparecer em Downloads,
 * nem no gerenciador de arquivos. Parecia que o download não tinha acontecido.
 *
 * A forma suportada de gravar no Downloads compartilhado é o **MediaStore**,
 * que é o caminho que o próprio app de Arquivos do Android usa. Não exige
 * permissão de armazenamento no Android 10+, e o arquivo aparece na hora em
 * "Downloads" e em qualquer app que leia mídia.
 *
 * ## Contrato com o frontend (`fileSwarm.ts`)
 *
 * `plugin:downloads|save(path, name) -> { path }`
 *  - `path`: caminho do arquivo já gravado pelo Rust na área privada;
 *  - `name`: nome final sugerido (sanitizado aqui — nunca confiar no peer);
 *  - devolve o caminho legível para a UI mostrar ao usuário.
 */
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
      val src = File(path)
      if (!src.exists()) {
        invoke.reject("arquivo de origem não encontrado: ${src.name}")
        return
      }
      // Teto: o swarm limita a ~200MB. Acima disso é bug/ataque — não alocar.
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
      // A origem privada já foi copiada: pode ir. Se a cópia falhar, `save*`
      // lançou antes e a origem continua (o Rust ainda tem o arquivo).
      try { if (!src.delete()) src.deleteOnExit() } catch (_: Throwable) { }
      invoke.resolve(JSObject().apply { put("path", dest) })
    } catch (e: Throwable) {
      invoke.reject("não consegui salvar em Downloads: ${e.message ?: e.javaClass.simpleName}")
    }
  }

  /** Android 10+ (API 29+): MediaStore — caminho suportado, sem permissão. */
  private fun saveViaMediaStore(name: String, src: File, invoke: Invoke): String {
    val resolver = activity.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.Downloads.DISPLAY_NAME, name)
      put(MediaStore.Downloads.MIME_TYPE, guessMime(name))
      put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
      // IS_PENDING esconde o arquivo enquanto escreve: se o app morrer no
      // meio, o usuário não fica com um arquivo truncado com nome definitivo.
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
      // Não deixa lixo: se a escrita falhou, apaga a entrada pendente.
      try { resolver.delete(uri, null, null) } catch (_: Throwable) { }
      throw e
    }
  }

  /** Android 9 e anteriores: escrita direta na pasta pública (sem permissão). */
  private fun saveLegacy(name: String, src: File, invoke: Invoke): String {
    val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
    if (!dir.exists()) dir.mkdirs()
    val dest = File(dir, name)
    src.copyTo(dest, overwrite = true)
    return dest.absolutePath
  }

  /** Nome seguro: basename, sem separadores, sem ".." (defesa contra traversal). */
  private fun sanitize(raw: String): String {
    val base = raw.substringAfterLast('/').substringAfterLast('\\')
    val cleaned = base.replace(Regex("[\\x00-\\x1f]"), "").trim()
    if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") return ""
    return if (cleaned.length > 180) cleaned.take(180) else cleaned
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
