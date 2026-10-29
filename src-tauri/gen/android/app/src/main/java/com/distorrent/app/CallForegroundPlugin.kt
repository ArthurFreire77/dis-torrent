package com.distorrent.app

import android.content.Intent
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * Ponte `plugin:callfg|start` / `plugin:callfg|stop` → [CallForegroundService].
 *
 * O contrato já existia no frontend (`callManager.startCallForeground`, chamado
 * no início/aceite da chamada e na entrada de canal de voz, e
 * `stopCallForeground` na saída). Faltava o lado nativo — o `invoke` falhava em
 * silêncio e a chamada morria ao minimizar no Android 14+.
 *
 * Nada aqui é oculto: o serviço mostra notificação permanente enquanto roda e
 * para quando a chamada termina.
 */
@TauriPlugin
class CallForegroundPlugin(private val activity: android.app.Activity) : Plugin(activity) {

  private var ringtone: Ringtone? = null

  @Command
  fun start(invoke: Invoke) {
    try {
      val intent = Intent(activity, CallForegroundService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        activity.startForegroundService(intent)
      } else {
        activity.startService(intent)
      }
      invoke.resolve()
    } catch (e: Throwable) {
      invoke.reject("não consegui manter a chamada em segundo plano: ${e.message ?: e.javaClass.simpleName}")
    }
  }

  /**
   * Toque de chamada recebida com o Ringtone do SISTEMA.
   *
   * Por que não WebAudio: com a tela bloqueada / app em segundo plano o WebView
   * tem os timers estrangulados (e pode estar pausado). Um `Ringtone`/MediaPlayer
   * nativo continua tocando, respeita o volume/silencioso/DND do aparelho e não
   * precisa de permissão nenhuma. É o mesmo mecanismo que o discador usa.
   *
   * Idempotente: chamar de novo só reinicia o toque (nunca empilha dois).
   */
  @Command
  fun ringStart(invoke: Invoke) {
    try {
      stopRingtone()
      val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
      val r = RingtoneManager.getRingtone(activity, uri) ?: run {
        invoke.reject("aparelho sem toque padrão configurado")
        return
      }
      r.audioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) r.isLooping = true
      r.play()
      ringtone = r
      invoke.resolve()
    } catch (e: Throwable) {
      invoke.reject("não consegui tocar o toque de chamada: ${e.message ?: e.javaClass.simpleName}")
    }
  }

  @Command
  fun ringStop(invoke: Invoke) {
    try {
      stopRingtone()
      invoke.resolve()
    } catch (e: Throwable) {
      invoke.reject("falha ao parar o toque: ${e.message ?: e.javaClass.simpleName}")
    }
  }

  private fun stopRingtone() {
    try {
      ringtone?.stop()
    } catch (_: Throwable) { }
    ringtone = null
  }

  @Command
  fun stop(invoke: Invoke) {
    try {
      // Chamada terminou: nada de toque órfão.
      stopRingtone()
      activity.stopService(Intent(activity, CallForegroundService::class.java))
      invoke.resolve()
    } catch (e: Throwable) {
      invoke.reject("falha ao encerrar o serviço de chamada: ${e.message ?: e.javaClass.simpleName}")
    }
  }
}
