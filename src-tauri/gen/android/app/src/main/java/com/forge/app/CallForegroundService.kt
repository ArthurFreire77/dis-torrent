package com.forge.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Foreground service que mantém o microfone/câmera vivos enquanto uma chamada
 * está ativa em background (Android 14+ corta permissões "while-in-use" sem
 * isto).
 *
 * Contrato com o frontend:
 *   - `call_foreground_start` (Tauri) → inicia o service com notificação persistente
 *   - `call_foreground_stop`  (Tauri) → `stopForeground` + `stopSelf`
 *
 * A notificação fica visível enquanto a chamada estiver ativa e é removida ao sair.
 * `android:foregroundServiceType="microphone|camera"` no manifest cobre os dois.
 */
class CallForegroundService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        startForeground(NOTIF_ID, notification)

        // WakeLock parcial para evitar que o CPU dorma no meio da chamada.
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "forge:call")
            wakeLock?.acquire(10 * 60 * 1000L) // 10 min de teto; renovado ao reiniciar
        }

        return START_STICKY
    }

    override fun onDestroy() {
        try { wakeLock?.release() } catch (_: Throwable) { }
        wakeLock = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Chamada em andamento",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Mantém microfone e câmera ativos durante a chamada"
                setShowBadge(false)
            }
            mgr.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("DisTorrent — em chamada")
            .setContentText("Microfone e câmera ativos")
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_CALL)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "forge_call"
        const val NOTIF_ID = 4242
    }
}
```

Now register the commands in Tauri (lib.rs) and create the Tauri commands. Actually, the service is started via Android Intent, not via Rust command. The frontend can call a Tauri command that sends an Intent to start the service. Or simpler: expose two commands `call_foreground_start`/`call_foreground_stop` that use `app.handle().android_context()` or the activity.

Actually, Tauri 2 has `app.handle().plugin::<...>()` etc. Starting an Android service from Rust is non-trivial (needs JNI). A simpler approach: register the service start/stop as a Tauri command that uses the Android context.

Hmm, this is getting complex. Let me simplify: instead of Tauri commands, the frontend can invoke the service via a small Kotlin plugin registered like DownloadsPlugin. That's cleaner and follows the existing pattern.

Let me create a `CallForegroundPlugin.kt` registered in MainActivity.onWebViewCreate, with commands `start` and `stop`. Then the frontend calls `plugin:callfg|start` / `plugin:callfg|stop`.

Actually, to keep it simpler and avoid too many moving parts, let me just add the commands to the existing DownloadsPlugin? No, that's mixing concerns.

Let me create a separate plugin. The frontend wiring in callManager.ts would be:
```ts
if (isAndroidRuntime()) {
  try { await tauriInvoke('plugin:callfg|start') } catch { /* best-effort */ }
}
```

Let me create the plugin file.<|end|><|start|>start<|channel|>assistant to=write<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="path">
E:\Programas\dis-torrent\src-tauri\gen\android\app\src\main\java\com\forge\app\CallForegroundPlugin.kt