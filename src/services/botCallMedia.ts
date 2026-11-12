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
  const abriu = await callManager
    .setBotMusicEnabled(true, nome, `bot:${botId}`)
    .catch(() => false)
  if (abriu) iniciarConsumoDeAudio(communityId, botId)
  return abriu
}

/** O bot sai da call (fim do plugin ou `!parar`). */
export async function sairDaCall(): Promise<void> {
  pararConsumoDeAudio()
  await callManager.setBotMusicEnabled(false).catch(() => {})
}

/**
 * Toca um bloco de áudio já decodificado na track do bot.
 * `sampleRate` do buffer precisa ser 48 kHz (o mesmo da track).
 *
 * `quando` é o instante no relógio do AudioContext. Sem ele cada buffer começa
 * em `currentTime` e os frames de um mesmo lote tocam EMPILHADOS — o áudio de
 * 360 ms virava um estalo de 20 ms a cada ciclo (o "cortando").
 */
export function tocarNoBot(buffer: AudioBuffer, quando?: number): boolean {
  const { ctx, destination } = callManager.botMusicSink()
  if (!ctx || !destination) return false
  try {
    const fonte = ctx.createBufferSource()
    fonte.buffer = buffer
    fonte.connect(destination)
    fonte.start(quando && quando > ctx.currentTime ? quando : undefined)
    return true
  } catch {
    return false
  }
}

// ─── Laço de consumo do PCM ──────────────────────────────────────────────

let lacoAudio: ReturnType<typeof setInterval> | null = null
let botAtual: { communityId: string; botId: string } | null = null
/** Instante em que o próximo frame deve começar (agenda em série). */
let proximoInicio = 0

/** base64 → Float32Array (PCM i16 little-endian). */
function pcmB64ParaFloat(b64: string): Float32Array<ArrayBuffer> | null {
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const n = Math.floor(bytes.length / 2)
    // Buffer próprio: `copyToChannel` exige ArrayBuffer, não SharedArrayBuffer.
    const out = new Float32Array(new ArrayBuffer(n * 4))
    const dv = new DataView(bytes.buffer)
    for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768
    return out
  } catch {
    return null
  }
}

/**
 * Junta os frames em um AudioBuffer e toca, **em série**.
 *
 * Cada frame é 20 ms de PCM. Agendar todos em `currentTime` fazia um tocar por
 * cima do outro: só o último era ouvido. Aqui o próximo começa onde o anterior
 * terminou; se a fila atrasou (o app ficou 450 ms sem puxar), o cursor volta
 * para `currentTime` para não acumular atraso — melhor um corte curto do que
 * o áudio ficar minutos atrás do chat.
 */
function tocarLote(frames: string[]): number {
  const { ctx } = callManager.botMusicSink()
  if (!ctx) return 0
  if (proximoInicio < ctx.currentTime) proximoInicio = ctx.currentTime
  let tocados = 0
  for (const b64 of frames) {
    const amostras = pcmB64ParaFloat(b64)
    if (!amostras || amostras.length === 0) continue
    try {
      const buffer = ctx.createBuffer(1, amostras.length, 48_000)
      buffer.copyToChannel(amostras, 0)
      if (tocarNoBot(buffer, proximoInicio)) {
        proximoInicio += buffer.duration
        tocados++
      }
    } catch {}
  }
  return tocados
}

/**
 * Puxa o PCM do bot e toca na track do participante.
 *
 * O intervalo (200 ms) é MENOR que o áudio puxado por ciclo (25 frames =
 * 500 ms) de propósito: assim a fila nunca esvazia entre um ciclo e outro, que
 * era a outra metade do "cortando" — 450 ms de puxada para 500 ms de áudio
 * deixava uma janela sem som a cada volta.
 */
export function iniciarConsumoDeAudio(communityId: string, botId: string): void {
  botAtual = { communityId, botId }
  proximoInicio = 0
  if (lacoAudio) return
  lacoAudio = setInterval(() => {
    void (async () => {
      if (!botAtual) return
      if (!services.botAudioDrain) return
      try {
        const frames = await services.botAudioDrain(botAtual.communityId, botAtual.botId, 25)
        if (!Array.isArray(frames) || frames.length === 0) return
        tocarLote(frames)
      } catch {}
    })()
  }, 200)
}

export function pararConsumoDeAudio(): void {
  botAtual = null
  proximoInicio = 0
  if (lacoAudio) {
    clearInterval(lacoAudio)
    lacoAudio = null
  }
}
