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

/**
 * Serviço em primeiro plano de CHAMADA (Android 14+).
 *
 * ## Por que existe
 *
 * O frontend já chamava `plugin:callfg|start` em `callManager.startCallForeground`
 * (início da chamada, aceite, entrada em canal de voz), mas o plugin Kotlin
 * tinha sido removido porque a versão anterior não compilava — ou seja, o
 * WebView pedia um serviço que não existia e o `invoke` falhava em silêncio.
 *
 * Sem um foreground service, o Android 14+ **corta microfone e câmera** assim
 * que o app sai da tela ("while-in-use permissions") e pode matar o processo
 * da chamada. Com ele, a chamada continua com o app em segundo plano, e o
 * usuário vê uma notificação permanente (é o preço honesto de manter o mic
 * aberto — nada de esconder isso).
 *
 * ## O que NÃO faz
 *
 * - Não é serviço de mensagens: o motor P2P vive no processo do app; um FGS
 *   `dataSync` permanente para "ficar online" seria justamente o tipo de uso
 *   que o Android restringe (e que a Play policy proíbe sem necessidade).
 * - Não pede permissão de runtime: mic/câmera são pedidos pelo WebView no
 *   momento da chamada; aqui só declaramos o TIPO do serviço em uso.
 */
class CallForegroundService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    createChannel()
    val notification = buildNotification()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Throwable) {
      // Sem permissão de mic declarada/ concedida o Android recusa o tipo —
      // melhor parar do que ficar num estado que promete algo que não existe.
      android.util.Log.w("distorrentCallFg", "startForeground recusado: ${e.message}")
      stopSelf()
      return START_NOT_STICKY
    }
    // START_NOT_STICKY: se o processo morrer, NÃO ressuscita um serviço de
    // chamada fantasma (não existe chamada para manter). Quem chamar de novo
    // inicia de novo.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
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
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Chamada em andamento",
      NotificationManager.IMPORTANCE_LOW, // sem som: é estado, não aviso
    ).apply {
      description = "Mostra que o microfone está em uso por uma chamada do DisTorrent"
      setShowBadge(false)
    }
    mgr.createNotificationChannel(channel)
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
      .setContentTitle("DisTorrent — em chamada")
      .setContentText("Microfone em uso. Toque para voltar à chamada.")
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setContentIntent(pi)
      .setCategory(Notification.CATEGORY_CALL)
      .build()
  }

  companion object {
    const val CHANNEL_ID = "distorrent_call"
    const val NOTIFICATION_ID = 4711
  }
}
