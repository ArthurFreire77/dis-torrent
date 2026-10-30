package com.distorrent.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * Notificação de CHAMADA RECEBIDA estilo WhatsApp: aparece em cima de tudo
 * (full-screen intent) com os botões **Atender** e **Recusar**.
 *
 * ## Por que este plugin existe
 *
 * O `tauri-plugin-notification` cobre mensagem, mas é genérico: não cria
 * `setFullScreenIntent`, não tem botões de ação e não marca a categoria
 * `CALL`. O resultado era o que o usuário descrevia como "a notificação do
 * Android é uma merda": o aviso ficava na gaveta, sem botão e sem aparecer na
 * tela quando o aparelho estava bloqueado.
 *
 * ## O que é possível (sem mentir)
 *
 * - `setFullScreenIntent` abre a activity por cima da tela de bloqueio **se** o
 *   usuário deu a permissão de "exibir sobre outros apps"/notificações de
 *   chamada. Em ROMs recentes o Android pode mostrar só um banner — o botão
 *   **Atender** da notificação continua funcionando nesse caso.
 * - Atender/Recusar aqui só DISPARAM a intenção para o Activity (`ACTION`
 *   `distorrent.call.accept` / `.reject`), que repassa à WebView. Quem faz a
 *   sinalização é o `callManager` — nada de aceitar chamada pelas costas do JS
 *   (o SDP/ICE precisa da página viva).
 * - É um `BroadcastReceiver` registrado no manifesto: funciona com o app em
 *   segundo plano (que é justamente quando a notificação importa).
 */
@TauriPlugin
class CallNotificationPlugin(private val activity: android.app.Activity) : Plugin(activity) {

  /**
   * Intenção tocada com o app em SEGUNDO PLANO (activity viva).
   *
   * O `PluginManager.onNewIntent` chama isto em todo plugin; aqui a ação vira o
   * evento `action`, que o frontend escuta com
   * `addPluginListener('callnotif', 'action')`.
   */
  override fun onNewIntent(intent: Intent) {
    val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: return
    if (callId.isBlank()) return
    val raw = intent.getStringExtra(CallActionReceiver.EXTRA_ACTION)
    val action = when (raw) {
      ACTION_ACCEPT -> "accept"
      ACTION_REJECT -> "reject"
      else -> "open"
    }
    try {
      val payload = JSObject()
      payload.put("call_id", callId)
      payload.put("action", action)
      trigger("action", payload)
    } catch (e: Throwable) {
      android.util.Log.w("distorrentCallNotif", "evento action não emitido: ${e.message}")
    }
  }

  @Command
  fun show(invoke: Invoke, callId: String, title: String, body: String) {
    try {
      if (callId.isBlank()) {
        invoke.reject("call_id vazio")
        return
      }
      createChannels()
      val id = notificationIdFor("call:$callId")
      val mgr = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      mgr.notify(id, buildCallNotification(callId, title, body))
      val out = JSObject()
      out.put("id", id)
      invoke.resolve(out)
    } catch (e: Throwable) {
      invoke.reject("não consegui mostrar a chamada: ${e.message ?: e.javaClass.simpleName}")
    }
  }

  @Command
  fun cancel(invoke: Invoke, callId: String) {
    try {
      val mgr = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      mgr.cancel(notificationIdFor("call:$callId"))
      invoke.resolve()
    } catch (e: Throwable) {
      invoke.reject("falha ao cancelar o aviso: ${e.message}")
    }
  }

  /**
   * Drena a ação que chegou com o app FECHADO (boot a frio).
   *
   * Devolve `{ action, call_id }` uma única vez e limpa. O frontend chama ao
   * montar o shell: sem isso, tocar em "Atender" com o processo morto só abria
   * o app e a chamada seguia tocando sem ninguém aceitar.
   */
  @Command
  fun pendingAction(invoke: Invoke) {
    try {
      val raw = pendingAction
      pendingAction = null
      val out = JSObject()
      if (raw == null) {
        out.put("action", "")
        out.put("call_id", "")
      } else {
        val i = raw.indexOf('|')
        out.put("call_id", if (i >= 0) raw.substring(0, i) else raw)
        out.put("action", if (i >= 0) raw.substring(i + 1) else "open")
      }
      invoke.resolve(out)
    } catch (e: Throwable) {
      invoke.reject("falha ao ler a ação pendente: ${e.message}")
    }
  }

  /**
   * Cria (idempotente) os canais. `distorrent_calls` tem importância MÁXIMA e
   * som de toque: sem importância alta o Android não promove a notificação e
   * o full-screen intent é ignorado.
   */
  private fun createChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (mgr.getNotificationChannel(CHANNEL_CALLS) == null) {
      val ch = NotificationChannel(
        CHANNEL_CALLS,
        "Chamadas recebidas",
        NotificationManager.IMPORTANCE_HIGH,
      ).apply {
        description = "Chamadas de voz e vídeo — aparece sobre a tela de bloqueio"
        setShowBadge(true)
        enableVibration(true)
        // Sem silenciar por padrão: chamada precisa tocar. O usuário muda isso
        // nas configurações do sistema, como em qualquer discador.
        setBypassDnd(false)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      }
      mgr.createNotificationChannel(ch)
    }
  }

  private fun buildCallNotification(callId: String, title: String, body: String): Notification {
    val open = Intent(activity, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        .or(Intent.FLAG_ACTIVITY_NEW_TASK)
      putExtra(EXTRA_CALL_ID, callId)
    }
    val piFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }
    val contentPi = PendingIntent.getActivity(
      activity, notificationIdFor("call:$callId"), open, piFlags,
    )
    // TELA CHEIA: abre o app por cima do bloqueio quando o sistema permitir.
    val fullPi = PendingIntent.getActivity(
      activity,
      notificationIdFor("callfull:$callId"),
      open,
      piFlags,
    )

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(activity, CHANNEL_CALLS)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(activity)
    }

    builder
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(applicationInfoCompatIcon())
      .setCategory(Notification.CATEGORY_CALL)
      .setPriority(Notification.PRIORITY_MAX)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      .setContentIntent(contentPi)
      .addAction(action(android.R.drawable.ic_menu_call, "Atender", callId, ACTION_ACCEPT))
      .addAction(action(android.R.drawable.ic_menu_close_clear_cancel, "Recusar", callId, ACTION_REJECT))

    // `setFullScreenIntent` só no Android 5+ (M já respeita bem; pre-M é raro).
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      builder.setFullScreenIntent(fullPi, true)
    }
    return builder.build()
  }

  private fun action(icon: Int, label: String, callId: String, action: String): Notification.Action {
    val intent = Intent(activity, CallActionReceiver::class.java).apply {
      this.action = action
      putExtra(EXTRA_CALL_ID, callId)
    }
    val piFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }
    val pi = PendingIntent.getBroadcast(activity, notificationIdFor("$action:$callId"), intent, piFlags)
    return Notification.Action.Builder(
      android.graphics.drawable.Icon.createWithResource(activity, icon),
      label,
      pi,
    ).build()
  }

  private fun applicationInfoCompatIcon(): Int = activity.applicationInfo.icon

  companion object {
    const val CHANNEL_CALLS = "distorrent_calls"
    const val EXTRA_CALL_ID = "distorrent_call_id"
    /** Ação do broadcast de "Atender" (recebida por [CallActionReceiver]). */
    const val ACTION_ACCEPT = "com.distorrent.app.CALL_ACCEPT"
    /** Ação do broadcast de "Recusar". */
    const val ACTION_REJECT = "com.distorrent.app.CALL_REJECT"

    /**
     * Ação tocada ANTES de a WebView existir (boot a frio).
     *
     * Formato `"<call_id>|<accept|reject|open>"`. O frontend drena com
     * `plugin:callnotif|pendingAction` ao montar; sem isso, atender pela
     * notificação com o app morto abria o app e não fazia nada.
     */
    @Volatile
    var pendingAction: String? = null

    /**
     * Mesmo id estável do Rust/JS (`notificationIdFor`): repetir a conta é o que
     * faz a chamada repetida SUBSTITUIR o aviso em vez de empilhar dois.
     */
    fun notificationIdFor(key: String): Int {
      var h = 5381
      for (b in key.toByteArray(Charsets.UTF_8)) {
        h = (h shl 5) + h + b.toInt()
      }
      val abs = if (h == Int.MIN_VALUE) Int.MAX_VALUE else Math.abs(h)
      return (abs % 2_000_000_000) + 1
    }
  }
}

/**
 * Recebe Atender/Recusar com o app em segundo plano e entrega a intenção ao
 * `MainActivity` (que a repassa à WebView).
 *
 * Não existe caminho "atender sem abrir o app": o WebRTC/`callManager` vive na
 * página. O receiver só traz o app à frente já com a ação escolhida.
 */
class CallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val callId = intent.getStringExtra(CallNotificationPlugin.EXTRA_CALL_ID) ?: return
    try {
      val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      mgr.cancel(CallNotificationPlugin.notificationIdFor("call:$callId"))
    } catch (_: Throwable) { }

    val open = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        .or(Intent.FLAG_ACTIVITY_NEW_TASK)
      putExtra(CallNotificationPlugin.EXTRA_CALL_ID, callId)
      putExtra(EXTRA_ACTION, intent.action)
    }
    try {
      context.startActivity(open)
    } catch (_: Throwable) { }
  }

  companion object {
    const val EXTRA_ACTION = "distorrent_call_action"
  }
}
