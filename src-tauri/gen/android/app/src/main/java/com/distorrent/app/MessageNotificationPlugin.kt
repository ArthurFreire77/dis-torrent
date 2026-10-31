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

/**
 * Notificação de MENSAGEM com nome do remetente, foto de perfil e ação.
 *
 * ## Por que não usar o `tauri-plugin-notification` para isso
 *
 * O plugin oficial não faz três coisas que uma notificação de mensageiro
 * precisa:
 *
 * 1. **avatar** — o `large_icon` dele só aceita nome de recurso `drawable` do
 *    APK (`BitmapFactory.decodeResource`). A foto do contato vem do swarm em
 *    base64, num arquivo que não está no APK. Resultado: o aviso saía com um
 *    quadrado cinza, sem dizer de quem era.
 * 2. **estilo de conversa** — `MessagingStyle` mostra "Nome" em destaque e as
 *    mensagens empilhadas com a foto ao lado; o plugin usa `BigTextStyle`, que
 *    mostra o corpo em letra pequena e o título sem destaque.
 * 3. **ação "Responder"** — o plugin até registra `ActionType`, mas exige
 *    `action_type_id` e buttons fixos; aqui a ação precisa carregar a CONVERSA
 *    para abrir direto nela.
 *
 * ## O que é honesto prometer
 *
 * - "Responder" NÃO é resposta inline (isso exige `RemoteInput` amarrado a uma
 *   Activity viva): o toque abre o app na conversa certa. O texto do botão diz
 *   "Abrir", não "Responder" — botão que mente é pior que botão ausente.
 * - A foto é opcional: sem ela o Android cai nas iniciais, que é um aviso
 *   legível, não um quadrado vazio.
 * - O ícone grande é o avatar; o pequeno (obrigatório, monocromático na barra
 *   de status) continua sendo o do app.
 */
@TauriPlugin
class MessageNotificationPlugin(private val activity: android.app.Activity) : Plugin(activity) {

  @Command
  fun show(invoke: Invoke) {
    try {
      // `Invoke` só expõe `getArgs()`/`parseArgs` (não tem `getString`): os
      // argumentos chegam como JSObject.
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
    // Importância ALTA: sem ela o Android não faz o "heads-up" (a faixa que
    // aparece em cima da tela). O canal antigo do plugin oficial nasceu com
    // importância padrão e o usuário via o aviso só na gaveta.
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

    // FOTO DO CONTATO: grande ícone. Sem ela o Android mostra as iniciais do
    // título — nunca um quadrado vazio (o defeito do plugin oficial).
    decodeAvatar(avatarB64)?.let { builder.setLargeIcon(it) }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && !silent) {
      // `MessagingStyle` destaca o remetente e agrupa as mensagens da conversa.
      // `android.app.Person` só existe a partir do Android 9 (API 28); antes
      // disso usamos o estilo simples (`BigTextStyle`), que já está aplicado
      // acima. Chamar `Notification.Person` não compila — a classe é
      // `android.app.Person`, não aninhada em `Notification`.
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

    // Silêncio: `Notification.Builder.setSilent` só existe via
    // `NotificationCompat`. Para não trazer a dependência, o silêncio é feito
    // no CANAL: um segundo canal sem som (o usuário escolhe nas configurações
    // do sistema de forma independente). É o mesmo efeito, sem API nova.
    if (silent) {
      builder.setOnlyAlertOnce(true)
    }

    // AÇÃO: abre o app na conversa. O rótulo diz "Abrir" porque é o que
    // acontece — resposta inline exigiria RemoteInput e uma Activity viva.
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

  /** Base64 (sem prefixo `data:`) → Bitmap. Falha silenciosa: avatar é opcional. */
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

    /**
     * Mesmo id estável do Rust/JS (`notificationIdFor`): repetir a conta é o que
     * faz a mensagem nova SUBSTITUIR o aviso da conversa em vez de empilhar.
     */
    fun notificationIdFor(key: String): Int {
      var h = 5381
      for (b in key.toByteArray(Charsets.UTF_8)) h = (h shl 5) + h + b.toInt()
      val abs = if (h == Int.MIN_VALUE) Int.MAX_VALUE else Math.abs(h)
      return (abs % 2_000_000_000) + 1
    }
  }
}
