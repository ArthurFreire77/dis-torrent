import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { sanitizeText } from '../core/security/sanitize.ts'

/**
 * Assinatura e entrega do webhook de saída do bot.
 *
 * Puro de propósito: decide header e corpo, mas não faz rede. Assim dá para
 * testar no `node --test` (o runtime que importa `services` não é importável).
 *
 * Sem assinatura, qualquer um que descobrisse a URL do criador podia postar
 * eventos falsos e o receptor não tinha como distinguir. O HMAC resolve isso e
 * o timestamp corta replay.
 */

export const WEBHOOK_SIGNATURE_HEADER = 'x-distorrent-signature'
export const WEBHOOK_TIMESTAMP_HEADER = 'x-distorrent-timestamp'
export const WEBHOOK_ID_HEADER = 'x-distorrent-delivery'

/** Janela de tolerância do timestamp no receptor (segundos). */
export const WEBHOOK_TOLERANCE_SECONDS = 300

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * HMAC-SHA256 de `timestamp + "." + corpo`.
 *
 * O timestamp entra na mensagem assinada: sem ele, um corpo capturado vale para
 * sempre e o receptor não tem como recusar replay.
 */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  const enc = new TextEncoder()
  const mac = hmac(sha256, enc.encode(secret), enc.encode(`${timestamp}.${body}`))
  return `sha256=${toHex(mac)}`
}

/** Verificação do lado do receptor, com janela de tempo. */
export function verifyWebhook(
  secret: string,
  signature: string,
  timestamp: number,
  body: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!signature.startsWith('sha256=')) return false
  const skew = Math.abs(nowSeconds - timestamp)
  if (!Number.isFinite(skew) || skew > WEBHOOK_TOLERANCE_SECONDS) return false
  const expected = signWebhook(secret, timestamp, body)
  // Comparação em tempo constante: `===` vaza o prefixo correto por timing.
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
}

export interface WebhookPayload {
  /** Nome do evento (`message_new`, `member_joined`...). */
  event: string
  /** Id estável da entrega: o receptor deduplica por ele. */
  delivery: string
  /** Timestamp da entrega em segundos (o mesmo que foi assinado). */
  timestamp: number
  data: Record<string, unknown>
}

/**
 * Monta corpo + headers. `secret` ausente = webhook sem assinatura, e o header
 * de assinatura não é enviado (melhor do que mandar um valor vazio que o
 * receptor interpretaria como "assinado").
 */
export function buildWebhook(
  event: string,
  data: Record<string, unknown>,
  secret: string | undefined,
  delivery: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({
    event,
    delivery,
    timestamp: nowSeconds,
    data: sanitizeObject(data),
  })
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [WEBHOOK_ID_HEADER]: delivery,
    [WEBHOOK_TIMESTAMP_HEADER]: String(nowSeconds),
  }
  if (secret) headers[WEBHOOK_SIGNATURE_HEADER] = signWebhook(secret, nowSeconds, body)
  return { body, headers }
}

/** Sanitiza strings dentro do payload (até 2 níveis), mantendo tipos simples. */
function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj).slice(0, 40)) {
    if (typeof v === 'string') out[k] = sanitizeText(v, 4000)
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v
    else if (Array.isArray(v)) {
      out[k] = v.slice(0, 50).map((x) => (typeof x === 'string' ? sanitizeText(x, 500) : x))
    } else if (v && typeof v === 'object') {
      const nested: Record<string, unknown> = {}
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
        if (typeof nv === 'string') nested[nk] = sanitizeText(nv, 1000)
        else if (typeof nv === 'number' || typeof nv === 'boolean' || nv === null) nested[nk] = nv
      }
      out[k] = nested
    }
  }
  return out
}
