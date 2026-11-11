// Entrada de mídia de bots na chamada.
//
// POR QUE este arquivo existe: o bot roda como processo externo e a call é
// WebRTC da WebView — o processo não alcança os peers. A ponte avisa "este bot
// quer entrar com áudio" e é AQUI que o app aceita: cria uma track de áudio
// própria, liga aos peers e trata o bot como participante.
//
// O app não sabe o que é "música": ele aceita qualquer participante que traga
// áudio. Quem monta o som é o bot.
import { callManager } from './callManager'
import { services } from './index'

/** Bot que pediu para entrar na call. */
export interface BotCallRequest {
  communityId: string
  botId: string
}

let consultando = false
let emAndamento = false

/**
 * Procura pedidos pendentes e abre a track do bot.
 * Chamado periodicamente pelo runtime; nunca lança.
 */
export async function processarPedidosDeCall(): Promise<void> {
  if (consultando || emAndamento) return
  if (!services.botCallTake) return
  consultando = true
  try {
    const pedidos = await services.botCallTake()
    if (!Array.isArray(pedidos) || pedidos.length === 0) return
    emAndamento = true
    try {
      for (const [communityId, botId] of pedidos) {
        await entryDoBot(communityId, botId)
      }
    } finally {
      emAndamento = false
    }
  } catch {
    // Sem ponte/plataforma: silêncio é o comportamento certo.
  } finally {
    consultando = false
  }
}

/** Abre a track do bot na call atual e o registra como participante. */
async function entryDoBot(communityId: string, botId: string): Promise<boolean> {
  let nome = 'Bot'
  try {
    const bots = await services.botsList(communityId)
    const bot = bots.find((b) => b.id === botId)
    if (bot?.name) nome = bot.name
  } catch {}

  // `setBotMusicEnabled` cria a m-line separada e entra no roster. O frontend
  // entrega o áudio decodificado no destino que ela devolve.
  return callManager.setBotMusicEnabled(true, nome, `bot:${botId}`).catch(() => false)
}

/** O bot sai da call (fim do plugin ou `!parar`). */
export async function sairDaCall(): Promise<void> {
  await callManager.setBotMusicEnabled(false).catch(() => {})
}

/**
 * Toca um bloco de áudio já decodificado na track do bot.
 * `sampleRate` do buffer precisa ser 48 kHz (o mesmo da track).
 */
export function tocarNoBot(buffer: AudioBuffer): boolean {
  const { ctx, destination } = callManager.botMusicSink()
  if (!ctx || !destination) return false
  try {
    const fonte = ctx.createBufferSource()
    fonte.buffer = buffer
    fonte.connect(destination)
    fonte.start()
    return true
  } catch {
    return false
  }
}
