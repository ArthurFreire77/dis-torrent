package com.forge.app

import android.content.Intent
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * Plugin que inicia/para o [CallForegroundService] (foreground service de chamada).
 *
 * Contrato com o frontend:
 *   plugin:callfg|start  -> inicia o service + notificação persistente
 *   plugin:callfg|stop   -> stopForeground + stopSelf
 *
 * Registrado em MainActivity.onWebViewCreate, igual ao DownloadsPlugin.
 */
@TauriPlugin
class CallForegroundPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    @Command
    fun start(invoke: Invoke) {
        try {
            val intent = Intent(activity, CallForegroundService::class.java)
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }
            invoke.resolve(JSObject().apply { put("ok", true) })
        } catch (e: Throwable) {
            invoke.reject("não consegui iniciar o foreground service: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        try {
            val intent = Intent(activity, CallForegroundService::class.java)
            activity.stopService(intent)
            invoke.resolve(JSObject().apply { put("ok", true) })
        } catch (e: Throwable) {
            invoke.reject("não consegui parar o foreground service: ${e.message ?: e.javaClass.simpleName}")
        }
    }
}
```

Now push.<|end|><|start|>start<|channel|>assistant to=shell<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="command">
git -C E:\Programas\dis-torrent add -A; git -C E:\Programas\dis-torrent commit -m "fix: adiciona CallForegroundPlugin.kt (faltava no commit anterior)" && git -C E:\Programas\dis-torrent push origin main