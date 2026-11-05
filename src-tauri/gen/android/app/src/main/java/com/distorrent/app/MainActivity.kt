package com.distorrent.app

import android.content.Intent
import android.webkit.WebView

class MainActivity : TauriActivity() {

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)

    loadPlugin(webView, "downloads", "distorrentDownloads") { DownloadsPlugin(this) }
    loadPlugin(webView, "callfg", "distorrentCallFg") { CallForegroundPlugin(this) }
    loadPlugin(webView, "updater", "distorrentUpdater") { UpdaterPlugin(this) }
    loadPlugin(webView, "callnotif", "distorrentCallNotif") { CallNotificationPlugin(this) }
    loadPlugin(webView, "bgservice", "distorrentBgService") { BgServicePlugin(this) }
    loadPlugin(webView, "msgnotif", "distorrentMsgNotif") { MessageNotificationPlugin(this) }

    try {
      callActionFromIntent(intent)?.let { (callId, action) ->
        CallNotificationPlugin.pendingAction = "$callId|$action"
      }
    } catch (e: Throwable) {
      android.util.Log.w("distorrentCallNotif", "ação inicial não guardada: ${e.message}")
    }
  }

  private inline fun loadPlugin(
    webView: WebView,
    name: String,
    logTag: String,
    build: () -> app.tauri.plugin.Plugin,
  ) {
    try {
      app.tauri.plugin.PluginManager.load(webView, name, build(), "{}")
    } catch (e: Throwable) {
      android.util.Log.w(logTag, "plugin $name não registrado: ${e.message}")
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    try {
      setIntent(intent)
    } catch (_: Throwable) { }
    callActionFromIntent(intent)?.let { (callId, action) ->
      CallNotificationPlugin.pendingAction = "$callId|$action"
    }
  }

  private fun callActionFromIntent(intent: Intent?): Pair<String, String>? {
    if (intent == null) return null
    val callId = intent.getStringExtra(CallNotificationPlugin.EXTRA_CALL_ID) ?: return null
    if (callId.isBlank()) return null
    val raw = intent.getStringExtra(CallActionReceiver.EXTRA_ACTION)
    val action = when (raw) {
      CallNotificationPlugin.ACTION_ACCEPT -> "accept"
      CallNotificationPlugin.ACTION_REJECT -> "reject"
      else -> "open"
    }
    return callId to action
  }

  override fun onPause() {
    if (CallForegroundService.isRunning || BackgroundConnectionService.isRunning) {
      return
    }
    super.onPause()
  }

}
