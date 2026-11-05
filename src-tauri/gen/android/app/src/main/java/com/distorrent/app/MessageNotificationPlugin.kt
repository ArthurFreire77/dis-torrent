package com.distorrent.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin
class MessageNotificationPlugin(private val activity: android.app.Activity) : Plugin(activity) {

  @Command
  fun show(invoke: Invoke) {
    try {
      val args = invoke.getArgs()
      val convId = args.getString("conversation") ?: ""
      val title = args.getString("title") ?: "DisTorrent"
      val body = args.getString("body") ?: ""
      val avatarB64 = args.getString("avatarB64") ?: ""
      val silent = try { args.getBoolean("silent") ?: false } catch (_: Throwable) { false }
      createChannels()
      val mgr = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val id = notificationIdFor("conv:$convId")
      mgr.notify(id, build(title, body, convId, avatarB64, silent))
      invoke.resolve()
    } catch (e: Throwable) {
      invoke.reject("não consegui mostrar o aviso: ${e.message ?: e.javaClass.simpleName}")
    }
  }

  @Command
  fun cancel(invoke: Invoke) {
    try {
      val args = invoke.getArgs()
      val convId = args.getString("conversation") ?: ""
      val mgr = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      mgr.cancel(notificationIdFor("conv:$convId"))
      invoke.resolve()
    } catch (e: Throwable) {
      invoke.reject("falha ao cancelar o aviso: ${e.message}")
    }
  }

  private fun createChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
      val ch = NotificationChannel(
        CHANNEL_ID,
        "Mensagens",
        NotificationManager.IMPORTANCE_HIGH,
      ).apply {
        description = "Novas mensagens recebidas"
        setShowBadge(true)
        lockscreenVisibility = Notification.VISIBILITY_PRIVATE
      }
      mgr.createNotificationChannel(ch)
    }
  }

  private fun build(
    title: String,
    body: String,
    convId: String,
    avatarB64: String,
    silent: Boolean,
  ): Notification {
    val open = Intent(activity, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        .or(Intent.FLAG_ACTIVITY_NEW_TASK)
      putExtra(EXTRA_CONVERSATION, convId)
    }
    val piFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }
    val id = notificationIdFor("conv:$convId")
    val contentPi = PendingIntent.getActivity(activity, id, open, piFlags)

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(activity, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(activity)
    }

    builder
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(activity.applicationInfo.icon)
      .setContentIntent(contentPi)
      .setAutoCancel(true)
      .setCategory(Notification.CATEGORY_MESSAGE)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setOnlyAlertOnce(true)
      .setStyle(Notification.BigTextStyle().bigText(body))

    decodeAvatar(avatarB64)?.let { builder.setLargeIcon(it) }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && !silent) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        val icon = decodeAvatar(avatarB64)?.let { android.graphics.drawable.Icon.createWithBitmap(it) }
        val person = android.app.Person.Builder()
          .setName(title)
          .apply { if (icon != null) setIcon(icon) }
          .build()
        builder.setStyle(
          Notification.MessagingStyle(person)
            .setConversationTitle(title)
            .addMessage(body, System.currentTimeMillis(), person),
        )
      }
    }

    if (silent) {
      builder.setOnlyAlertOnce(true)
    }

    val reply = Intent(activity, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        .or(Intent.FLAG_ACTIVITY_NEW_TASK)
      putExtra(EXTRA_CONVERSATION, convId)
    }
    val replyPi = PendingIntent.getActivity(activity, id + 1, reply, piFlags)
    builder.addAction(
      Notification.Action.Builder(
        android.graphics.drawable.Icon.createWithResource(activity, android.R.drawable.ic_menu_send),
        "Abrir conversa",
        replyPi,
      ).build(),
    )

    return builder.build()
  }

  private fun decodeAvatar(b64: String): Bitmap? {
    if (b64.isEmpty()) return null
    return try {
      val bytes = Base64.decode(b64.substringAfterLast(','), Base64.DEFAULT)
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    } catch (_: Throwable) {
      null
    }
  }

  companion object {
    const val CHANNEL_ID = "distorrent_msg_v2"
    const val EXTRA_CONVERSATION = "distorrent_conversation"

    fun notificationIdFor(key: String): Int {
      var h = 5381
      for (b in key.toByteArray(Charsets.UTF_8)) h = (h shl 5) + h + b.toInt()
      val abs = if (h == Int.MIN_VALUE) Int.MAX_VALUE else Math.abs(h)
      return (abs % 2_000_000_000) + 1
    }
  }
}
// Seção 1: fim
