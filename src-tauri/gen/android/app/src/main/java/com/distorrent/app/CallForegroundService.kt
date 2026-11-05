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

class CallForegroundService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      createChannel()
      val notification = buildNotification()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (hasCameraPermission()) {
          types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        }
        startForeground(NOTIFICATION_ID, notification, types)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      isRunning = true
      applyAudioRouting()
    } catch (e: Throwable) {
      android.util.Log.w("distorrentCallFg", "startForeground recusado: ${e.message}")
      isRunning = false
      stopSelf()
      return START_NOT_STICKY
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    isRunning = false
    try { restoreAudioRouting() } catch (_: Throwable) { }
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

  private fun hasCameraPermission(): Boolean {
    return checkSelfPermission(android.Manifest.permission.CAMERA) ==
      android.content.pm.PackageManager.PERMISSION_GRANTED
  }

  private fun applyAudioRouting() {
    try {
      val am = getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
      am.mode = android.media.AudioManager.MODE_IN_COMMUNICATION
      audioApplied = true
    } catch (_: Throwable) {  }
  }

  private fun restoreAudioRouting() {
    if (!audioApplied) return
    audioApplied = false
    try {
      val am = getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
      am.mode = android.media.AudioManager.MODE_NORMAL
    } catch (_: Throwable) { }
  }

  private fun createChannel() {    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Chamada em andamento",
      NotificationManager.IMPORTANCE_LOW,
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
    @Volatile
    var isRunning: Boolean = false
      private set
    @Volatile
    private var audioApplied: Boolean = false
  }
}
