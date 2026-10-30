package com.distorrent.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * Serviço em primeiro plano que mantém o app VIVO com a tela apagada.
 *
 * ## O problema real
 *
 * O motor P2P roda dentro do processo do app. Quando o usuário sai da tela, o
 * Android congela o WebView e, sem nada em primeiro plano, **mata o processo**
 * em poucos minutos (Doze/App Standby). Consequência: nenhuma mensagem nem
 * chamada chegava com o app fechado — "a notificação do Android não aparece,
 * só funciona com o aplicativo aberto".
 *
 * ## O que este serviço faz (e o que NÃO faz)
 *
 * - Mantém o processo vivo com tipo **`remoteMessaging`** (o tipo de FGS que o
 *   Android define para mensageria; não é `dataSync`, que tem teto de horas por
 *   dia no Android 15).
 * - Mostra uma notificação **permanente e silenciosa** dizendo que o app está
 *   conectado. É o preço honesto de continuar recebendo — igual a qualquer
 *   mensageiro. Nada de processo escondido.
 * - NÃO abre microfone nem câmera (esses têm serviço próprio,
 *   [CallForegroundService], criado só durante a chamada).
 *
 * ## Quando liga/desliga
 *
 * Ligado pelo frontend (`plugin:bgservice|start`) quando as notificações do
 * sistema estão ativas E o app é nativo (`appState.initAppState`), desligado
 * em `plugin:bgservice|stop` ao desativar. Também sobe no boot do app se a
 * preferência persistida (`bg.service.wanted`) estiver marcada — o Android só
 * respeita `START_STICKY` depois que o serviço existiu uma vez.
 */
class BackgroundConnectionService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      createChannel()
      val notif = buildNotification()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        // Android 14+: o TIPO declarado no `startForeground` precisa existir no
        // manifesto, senão SecurityException.
        startForeground(NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
      } else {
        startForeground(NOTIFICATION_ID, notif)
      }
      isRunning = true
    } catch (e: Throwable) {
      // Honesto: sem permissão/tipo o serviço não sobe. O app continua
      // funcionando em primeiro plano; só perde o recebimento com ele fechado.
      android.util.Log.w("distorrentBgService", "startForeground recusado: ${e.message}")
      isRunning = false
      stopSelf()
      return START_NOT_STICKY
    }
    // START_STICKY: se o sistema matar por memória, ele recria o serviço — é o
    // que mantém o recebimento vivo num aparelho apertado.
    return START_STICKY
  }

  override fun onDestroy() {
    isRunning = false
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        stopForeground(STOP_FOREGROUND_REMOVE)
      } else {
        @Suppress("DEPRECATION")
        stopForeground(true)
      }
    } catch (_: Throwable) { }
    super.onDestroy()
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
    val ch = NotificationChannel(
      CHANNEL_ID,
      "Conectado em segundo plano",
      NotificationManager.IMPORTANCE_MIN, // silencioso: é estado, não aviso
    ).apply {
      description = "Mantém o DisTorrent recebendo mensagens e chamadas com o app fechado"
      setShowBadge(false)
      lockscreenVisibility = Notification.VISIBILITY_SECRET
    }
    mgr.createNotificationChannel(ch)
  }

  private fun buildNotification(): Notification {
    val open = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val piFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }
    val pi = PendingIntent.getActivity(this, 0, open, piFlags)
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return builder
      .setContentTitle("DisTorrent conectado")
      .setContentText("Recebendo mensagens e chamadas")
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setContentIntent(pi)
      .setCategory(Notification.CATEGORY_SERVICE)
      .build()
  }

  companion object {
    const val CHANNEL_ID = "distorrent_bg"
    const val NOTIFICATION_ID = 4712
    @Volatile
    var isRunning: Boolean = false
      private set
  }
}

/**
 * Ponte `plugin:bgservice|start` / `|stop` → [BackgroundConnectionService].
 *
 * Devolve o estado REAL (`{ rodando: true/false }`) em vez de fingir sucesso:
 * em ROM que recusa o tipo `remoteMessaging`, a UI precisa saber que o
 * recebimento com o app fechado não está garantido.
 */
@TauriPlugin
class BgServicePlugin(private val activity: android.app.Activity) : Plugin(activity) {

  @Command
  fun start(invoke: Invoke) {
    try {
      val intent = Intent(activity, BackgroundConnectionService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        activity.startForegroundService(intent)
      } else {
        activity.startService(intent)
      }
      // Persiste a escolha: no boot seguinte o serviço sobe sozinho (o Android
      // só respeita `START_STICKY` depois que o serviço existiu uma vez).
      activity.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
        .edit().putBoolean(KEY_WANTED, true).apply()
      invoke.resolve(stateObject())
    } catch (e: Throwable) {
      invoke.reject("não consegui manter o app conectado: ${e.message ?: e.javaClass.simpleName}")
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    try {
      activity.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
        .edit().putBoolean(KEY_WANTED, false).apply()
      activity.stopService(Intent(activity, BackgroundConnectionService::class.java))
      invoke.resolve(stateObject())
    } catch (e: Throwable) {
      invoke.reject("falha ao parar o serviço: ${e.message ?: e.javaClass.simpleName}")
    }
  }

  @Command
  fun state(invoke: Invoke) {
    try {
      invoke.resolve(stateObject())
    } catch (e: Throwable) {
      invoke.reject("falha ao consultar o serviço: ${e.message}")
    }
  }

  private fun stateObject(): app.tauri.plugin.JSObject {
    val out = app.tauri.plugin.JSObject()
    out.put("rodando", BackgroundConnectionService.isRunning)
    return out
  }

  companion object {
    const val PREFS = "distorrent_bg"
    const val KEY_WANTED = "wanted"
  }
}
