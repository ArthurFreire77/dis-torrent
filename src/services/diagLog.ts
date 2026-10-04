/**
 * Log de diagnóstico do app — ring buffer em memória + prefixo comum.
 *
 * POR QUE ISTO EXISTE: o app roda dentro de um WebView Tauri. Quando algo
 * falha (voz nativa não sobe, vídeo não chega, download trava no meio), não há
 * stderr visível e o usuário só vê "conectando..." ou um card de erro. Um log
 * vivo, com timestamp e área, é a diferença entre adivinhar e saber.
 *
 * DESIGN (deliberadamente mínimo):
 * - Ring buffer fixo (`RING_CAP`): um app de horas não pode crescer sem teto.
 * - Nível `FORGE_LOG` (`error` por default) filtra o que vai para o console;
 *   o BUFFER sempre guarda tudo acima de `warn`, para o diagnóstico mostrar
 *   o que aconteceu mesmo sem reload.
 * - `exportDiagnostics()` devolve texto pronto para colar — é o que o painel
 *   de diagnóstico mostra e o que o usuário copia.
 * - Nunca lança: log não pode derrubar o caminho que ele registra.
 */

export type LogArea =
  | 'media'
  | 'call'
  | 'file'
  | 'net'
  | 'ui'
  | 'core'
  | 'boot'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogLine {
  /** epoch ms */
  t: number
  level: LogLevel
  area: LogArea
  msg: string
  /** contexto já serializado (peer/callId/chunks) */
  ctx?: Record<string, unknown>
}

const RING_CAP = 600
const PREFIX = '[forge]'

/** Ring buffer. `splice` no início é O(n) mas n=600 e só acontece acima do teto. */
const ring: LogLine[] = []

const listeners = new Set<(l: LogLine) => void>()

/** Nível mínimo que vai para o console. `FORGE_LOG=debug` abre tudo. */
function consoleLevel(): LogLevel {
  try {
    const raw = (globalThis as unknown as { localStorage?: Storage }).localStorage?.getItem('forge:loglevel')
    const fromLs = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    const env = typeof process !== 'undefined' ? String(process.env?.FORGE_LOG ?? '').trim().toLowerCase() : ''
    const v = env || fromLs
    if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v
  } catch { /* storage/indisponível — segue o default */ }
  return 'error'
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function ctxText(ctx?: Record<string, unknown>): string {
  if (!ctx) return ''
  try {
    const parts: string[] = []
    for (const [k, v] of Object.entries(ctx)) {
      if (v === undefined) continue
      parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    }
    return parts.length ? ` {${parts.join(' ')}}` : ''
  } catch { return '' }
}

function stamp(t: number): string {
  const d = new Date(t)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** Grava uma linha. Nunca lança. */
export function diag(level: LogLevel, area: LogArea, msg: string, ctx?: Record<string, unknown>): void {
  try {
    const line: LogLine = { t: Date.now(), level, area, msg, ctx }
    ring.push(line)
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP)
    for (const cb of listeners) { try { cb(line) } catch { /* listener nunca derruba o log */ } }
    if (ORDER[level] >= ORDER[consoleLevel()]) {
      const text = `${PREFIX} ${stamp(line.t)} ${level.toUpperCase().padEnd(5)} ${area}: ${msg}${ctxText(ctx)}`
      try {
        if (level === 'error') console.error(text)
        else if (level === 'warn') console.warn(text)
        else console.log(text)
      } catch { /* console pode não existir (SSR/WebView restrito) */ }
    }
  } catch { /* log nunca derruba o caminho que ele registra */ }
}

export const logDebug = (area: LogArea, msg: string, ctx?: Record<string, unknown>) => diag('debug', area, msg, ctx)
export const logInfo = (area: LogArea, msg: string, ctx?: Record<string, unknown>) => diag('info', area, msg, ctx)
export const logWarn = (area: LogArea, msg: string, ctx?: Record<string, unknown>) => diag('warn', area, msg, ctx)
export const logError = (area: LogArea, msg: string, ctx?: Record<string, unknown>) => diag('error', area, msg, ctx)

/** Snapshot do buffer (cópia). */
export function diagLines(): LogLine[] {
  try { return ring.slice() } catch { return [] }
}

/** Só as linhas de uma área (útil para "o que houve na chamada?"). */
export function diagLinesOf(area: LogArea): LogLine[] {
  try { return ring.filter((l) => l.area === area) } catch { return [] }
}

export function onDiag(cb: (l: LogLine) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function clearDiag(): void {
  try { ring.length = 0 } catch { /* ignore */ }
}

/** Texto pronto para colar no bug report / painel de diagnóstico. */
export function exportDiagnostics(): string {
  try {
    const head = [
      `${PREFIX} diagnóstico — ${new Date().toISOString()}`,
      `${PREFIX} userAgent=${safeUa()}`,
    ]
    const body = ring.map((l) => `${stamp(l.t)} ${l.level.toUpperCase().padEnd(5)} ${l.area}: ${l.msg}${ctxText(l.ctx)}`)
    return [...head, ...body].join('\n')
  } catch {
    return `${PREFIX} diagnóstico indisponível`
  }
}

function safeUa(): string {
  try {
    const u = (globalThis as unknown as { navigator?: { userAgent?: string } }).navigator?.userAgent
    return typeof u === 'string' ? u : 'desconhecido'
  } catch { return 'desconhecido' }
}

/** Copia o diagnóstico para a área de transferência (best-effort). */
export async function copyDiagnostics(): Promise<boolean> {
  try {
    const text = exportDiagnostics()
    const clip = (globalThis as unknown as { navigator?: { clipboard?: { writeText(t: string): Promise<void> } } }).navigator?.clipboard
    if (clip?.writeText) { await clip.writeText(text); return true }
  } catch { /* clipboard negado — mostra no painel */ }
  return false
}