import { services } from './index'
import { blake3 } from '@noble/hashes/blake3.js'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import {
  CHUNK, MAX_CHUNKS, FILE_MARKER, FILE_PREFIX,
  validateAnnounce, chunkCountFor, expectedChunkSize, formatFileSize,
  mimeFor, isImageName, isVideoName, isMediaName, mediaAutoFetchCap,
  spoolKey, chunkKey, swarmProgress, safeFileName, type FileMsgMeta,
} from './fileRules'
import { encodeFileMeta, parseFileBody } from './fileBody'
import { isTauriRuntime, isAndroidRuntime, isTauriAndroid } from '../shared/runtime.ts'
import { bytesToBase64, base64ToBytes } from '../shared/base64.ts'
import { sleep } from '../shared/async.ts'

export {
  CHUNK, MAX_CHUNKS, FILE_MARKER, FILE_PREFIX,
  validateAnnounce, chunkCountFor, expectedChunkSize, formatFileSize,
  mimeFor, isImageName, isVideoName, isMediaName, mediaAutoFetchCap,
  spoolKey, chunkKey, swarmProgress, safeFileName,
}
export type { FileMsgMeta }

export const MAX_FILE_SIZE = (() => {
  const meta = import.meta as unknown as { env?: Record<string, string> }
  const n = Number(meta.env?.VITE_DISTORRENT_MAX_FILE_MB)
  const mb = Number.isFinite(n) && n > 0 ? n : 51200
  return mb * 1024 * 1024
})()
export const MAX_FILE_MB_LABEL = Math.round(MAX_FILE_SIZE / (1024 * 1024)) >= 1024
  ? `${(MAX_FILE_SIZE / (1024 * 1024 * 1024)).toFixed(MAX_FILE_SIZE % (1024 * 1024 * 1024) === 0 ? 0 : 1)} GB`
  : `${Math.round(MAX_FILE_SIZE / (1024 * 1024))} MB`

const MAX_IN_FLIGHT = 24
const CHUNK_TIMEOUT_MS = 5000
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 8000
const MAX_CHUNK_ATTEMPTS = 8
const MAX_RETRY_CYCLES = 6
const SEEDER_IDLE_MS = 90_000

export { encodeFileMeta as encodeFileBody, parseFileBody }

function toHexBlake3(b: Uint8Array): string {
  return Array.from(blake3(b)).map(x=>x.toString(16).padStart(2,'0')).join('')
}

export interface SwarmFile {
  file_id: string
  name: string
  size: number
  chunks: number
  hash: string
  chunkHashes?: string[]
  have: Set<number>
  data: Map<number, Uint8Array>
  seeders: Set<string>
  owner_fp: string
  lastSeen: Map<string, number>
  completed?: boolean
  /** Blocos que esgotaram as tentativas. A UI precisa saber para não mentir. */
  failedChunks?: Set<number>
}

function b64(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
}
function fromB64(s: string): Uint8Array {
  return base64ToBytes(s)
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  if (typeof e === 'string') return e
  try { return JSON.stringify(e) } catch { return String(e) }
}

function isTauri(): boolean {
  return isTauriRuntime()
}

export function isAndroid(): boolean {
  return isAndroidRuntime()
}

export function isTauriAndroidRuntime(): boolean {
  return isTauriAndroid()
}

function baseNameOf(p: string): string {
  try {
    const b = String(p ?? '').split(/[\\/]/).pop() ?? ''
    return b || String(p ?? '')
  } catch { return String(p ?? '') }
}

interface FileShareNavigator {
  share?: (data: { files: File[]; title?: string }) => Promise<void>
  canShare?: (data: { files: File[] }) => boolean
}

async function shareOrFalse(blob: Blob, name: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined') return false
    const nav = navigator as Navigator & FileShareNavigator
    if (typeof nav.share !== 'function') return false
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' })
    if (typeof nav.canShare === 'function' && !nav.canShare({ files: [file] })) return false
    await nav.share({ files: [file], title: name })
    return true
  } catch { return false }
}

async function saveToPublicDownloads(privatePath: string, name: string): Promise<string> {
  const pub = await tauriInvoke<string>('save_public_copy', { path: privatePath, name })
  const trimmed = typeof pub === 'string' ? pub.trim() : ''
  if (!trimmed) throw new Error('o Android devolveu caminho vazio ao salvar em Downloads')
  return trimmed
}

export class FileSwarm {
  files = new Map<string, SwarmFile>()
  onChange?: () => void
  lastError: string | null = null

  private pendingReq = new Set<string>()
  private reqPeer = new Map<string, string>()
  private attempts = new Map<string, number>()
  private badPeers = new Map<string, Set<string>>()
  private chunkTimers = new Map<string, number>()
  private retryTimer = new Map<string, number>()
  private fetching = new Map<string, Promise<unknown>>()
  private retryAttempts = new Map<string, number>()
  private rr = new Map<string, number>()
  private saving = new Set<string>()
  private seededAsSeeder = new Set<string>()
  private pausedFiles = new Set<string>()
  private hydratedFiles = new Set<string>()

  async shareFile(file: File): Promise<SwarmFile> {
    if (file.size === 0) throw new Error('arquivo vazio')
    const sizeErr = validateAnnounce(file.size, Math.max(1, Math.ceil(file.size / CHUNK)))
    if (sizeErr) throw new Error(sizeErr)
    const buf = new Uint8Array(await file.arrayBuffer())
    const chunks = Math.max(1, Math.ceil(buf.length / CHUNK))
    const safeName = file.name.split(/[\\/]/).pop()?.trim() || 'arquivo'
    const file_id = `file-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`
    const hash = toHexBlake3(buf.length ? buf : new Uint8Array([0])).slice(0, 32)
    const chunkHashes = Array.from({ length: chunks }, (_, i) => toHexBlake3(buf.slice(i * CHUNK, (i + 1) * CHUNK)).slice(0, 32))
    const sf: SwarmFile = {
      file_id,
      name: safeName,
      size: buf.length,
      chunks,
      hash,
      chunkHashes,
      have: new Set(Array.from({ length: chunks }, (_, i) => i)),
      data: new Map(),
      seeders: new Set(),
      owner_fp: 'me',
      lastSeen: new Map(),
    }
    for (let i = 0; i < chunks; i++) {
      sf.data.set(i, buf.slice(i * CHUNK, (i + 1) * CHUNK))
    }
    this.files.set(file_id, sf)
    try {
      await services.fileAnnounce(file_id, safeName, buf.length, chunks, hash, chunkHashes)
    } catch {
      await services.fileAnnounce(file_id, safeName, buf.length, chunks, hash).catch(() => {  })
    }
    try { localStorage.setItem(`distorrent:filemeta:${file_id}`, JSON.stringify({ name: safeName, size: buf.length, chunks, hash, chunkHashes })) } catch {  }
    this.onChange?.()
    return sf
  }

  onAnnounce(file_id: string, name: string, size: number, chunks: number, hash: string, from_fp: string, chunkHashes?: string[]): boolean {
    this.lastError = null
    const verr = validateAnnounce(size, chunks)
    if (verr) {
      this.lastError = verr
      try { console.warn('[fileSwarm] anúncio rejeitado:', verr, file_id) } catch {  }
      return false
    }
    const existing = this.files.get(file_id)
    if (existing) {
      if (existing.size !== size || existing.chunks !== chunks) {
        this.lastError = 'anúncio divergente para o mesmo file_id — ignorado'
        return false
      }
      existing.seeders.add(from_fp)
      existing.lastSeen.set(from_fp, Date.now())
      if (!existing.chunkHashes && this.validChunkHashes(chunkHashes, chunks)) existing.chunkHashes = chunkHashes
      this.onChange?.()
      return true
    }
    const safeName = (name || 'arquivo').split(/[\\/]/).pop()?.trim().slice(0, 200) || 'arquivo'
    if (!safeName || safeName.startsWith('.')) {
      this.lastError = 'nome de arquivo inválido'
      return false
    }
    let ch = this.validChunkHashes(chunkHashes, chunks) ? chunkHashes : undefined
    if (!ch) {
      try {
        const raw = localStorage.getItem(`distorrent:file:chunk_hashes:${file_id}`)
        if (raw) { const parsed = JSON.parse(raw); if (this.validChunkHashes(parsed, chunks)) ch = parsed } 
      } catch {  }
    }
    if (!ch) {
      try {
        const j = localStorage.getItem(`distorrent:filemeta:${file_id}`)
        if (j) { const o = JSON.parse(j); if (this.validChunkHashes(o?.chunkHashes, chunks)) ch = o.chunkHashes }
      } catch {  }
    }
    const sf: SwarmFile = { file_id, name: safeName, size, chunks, hash, chunkHashes: ch, have: new Set(), data: new Map(), seeders: new Set([from_fp]), owner_fp: from_fp, lastSeen: new Map([[from_fp, Date.now()]]) }
    this.files.set(file_id, sf)
    try { localStorage.setItem(`distorrent:filemeta:${file_id}`, JSON.stringify({ name: safeName, size, chunks, hash, chunkHashes: ch })) } catch {  }
    this.onChange?.()
    return true
  }

  private validChunkHashes(ch: unknown, chunks: number): ch is string[] {
    return Array.isArray(ch) && ch.length === chunks && ch.every((h) => typeof h === 'string' && h.length > 0)
  }

  onChunkData(file_id: string, index: number, b64data: string, from_fp: string) {
    const sf = this.files.get(file_id)
    if (!sf) return
    if (!Number.isInteger(index) || index < 0 || index >= sf.chunks) {
      this.failChunk(sf, index, from_fp, `chunk ${index} fora da faixa (0..${sf.chunks - 1}) — descartado`)
      return
    }
    const k = this.key(file_id, index)
    if (sf.have.has(index)) { this.clearChunkReq(k); return }
    this.clearChunkReq(k)
    let bytes: Uint8Array
    try { bytes = fromB64(b64data) } catch {
      this.failChunk(sf, index, from_fp, `chunk ${index} chegou corrompido (base64) — pedindo a outro peer`)
      return
    }
    if (bytes.length === 0 && sf.size > 0) {
      this.failChunk(sf, index, from_fp, `chunk ${index} chegou vazio — pedindo a outro peer`)
      return
    }
    const esperado = index === sf.chunks - 1 ? sf.size - index * CHUNK : CHUNK
    if (esperado > 0 && bytes.length !== esperado) {
      this.failChunk(sf, index, from_fp, `chunk ${index} com tamanho ${bytes.length} (esperado ${esperado}) — pedindo a outro peer`)
      return
    }
    if (sf.chunkHashes?.[index]) {
      const got = toHexBlake3(bytes).slice(0, 32)
      if (got !== sf.chunkHashes[index]) {
        this.failChunk(sf, index, from_fp, `chunk ${index} corrompido — pedindo a outro peer`)
        return
      }
    }
    sf.data.set(index, bytes)
    sf.have.add(index)
    sf.seeders.add(from_fp)
    sf.lastSeen.set(from_fp, Date.now())
    if (services.kind === 'native') {
      void services.cachePut(spoolKey(file_id, index), b64data).catch(() => {  })
    }
    this.badPeers.delete(k)
    this.attempts.delete(k)
    this.retryAttempts.set(file_id, 0)
    this.lastError = null
    this.onChange?.()
    if (sf.have.size === sf.chunks) {
      this.clearRetry(file_id)
      this.clearFileTimers(file_id)
      if (!this.seededAsSeeder.has(file_id)) {
        this.seededAsSeeder.add(file_id)
        void services.fileAnnounce(sf.file_id, sf.name, sf.size, sf.chunks, sf.hash, sf.chunkHashes).catch(() => {})
      }
    } else {
      void this.fetchSwarm(sf)
    }
  }

  async ensureHydrated(sf: SwarmFile): Promise<number> {
    if (services.kind !== 'native') return 0
    if (this.hydratedFiles.has(sf.file_id)) return 0
    this.hydratedFiles.add(sf.file_id)
    let back = 0
    const missing: number[] = []
    for (let i = 0; i < sf.chunks; i++) if (!sf.have.has(i)) missing.push(i)
    for (let w = 0; w < missing.length; w += 8) {
      const wave = missing.slice(w, w + 8)
      const results = await Promise.all(wave.map(async (i) => {
        try {
          const hit = await services.cacheGet(spoolKey(sf.file_id, i))
          if (!hit) return false
          const bytes = fromB64(hit)
          if (bytes.length === 0 && sf.size > 0) return false
          if (sf.chunkHashes?.[i]) {
            if (toHexBlake3(bytes).slice(0, 32) !== sf.chunkHashes[i]) return false
          }
          sf.data.set(i, bytes)
          sf.have.add(i)
          return true
        } catch { return false  }
      }))
      back += results.filter(Boolean).length
    }
    if (back > 0) this.onChange?.()
    return back
  }

  async prepareMedia(sf: SwarmFile, onProgress?: (pct: number) => void, timeoutMs = 120_000): Promise<void> {
    if (sf.have.size === sf.chunks && sf.chunks > 0) { onProgress?.(100); return }
    await this.ensureHydrated(sf)
    if (sf.have.size === sf.chunks && sf.chunks > 0) { onProgress?.(100); return }
    if (sf.size > mediaAutoFetchCap(sf.name)) {
      throw new Error(`mídia de ${Math.round(sf.size / (1024 * 1024))}MB acima do automático — toque em Baixar`)
    }
    await this.fetchOnly(sf.file_id, onProgress, timeoutMs)
  }

  async fetchSwarm(sf: SwarmFile): Promise<void> {
    const file_id = sf.file_id
    if (this.pausedFiles.has(file_id)) return
    const anterior = this.fetching.get(file_id) ?? Promise.resolve()
    const atual = anterior.then(() => this.fetchSwarmInner(sf)).catch(() => {})
    this.fetching.set(file_id, atual)
    try { await atual } finally { if (this.fetching.get(file_id) === atual) this.fetching.delete(file_id) }
  }

  private async fetchSwarmInner(sf: SwarmFile): Promise<void> {
    const file_id = sf.file_id
    if (this.pausedFiles.has(file_id)) return
    await this.ensureHydrated(sf)
    const missing = Array.from({ length: sf.chunks }, (_, i) => i).filter(i => !sf.have.has(i))
    if (missing.length === 0) { this.clearRetry(file_id); return }

    this.pruneSeeders(sf)
    const seeders = [...sf.seeders]
    if (seeders.length === 0) {
      this.lastError = 'sem peers com o arquivo no swarm — aguardando um seeder ficar online'
      this.scheduleRetry(sf)
      return
    }

    const eligible = missing.filter((i) => (this.attempts.get(this.key(file_id, i)) ?? 0) < MAX_CHUNK_ATTEMPTS)
    if (eligible.length === 0) {
      const ciclos = (this.retryAttempts.get(sf.file_id) ?? 0)
      if (ciclos >= MAX_RETRY_CYCLES) {
        const presos = missing.filter((i) => (this.attempts.get(this.key(file_id, i)) ?? 0) >= MAX_CHUNK_ATTEMPTS)
        sf.failedChunks = new Set(presos)
        this.lastError = `sem progresso após ${MAX_RETRY_CYCLES} ciclos — ${presos.length} bloco(s) sem resposta. Verifique se quem tem o arquivo está online.`
        return
      }
      this.lastError = 'sem progresso após várias tentativas — reiniciando a rodada de retry'
      this.attempts.clear()
      sf.failedChunks = undefined
      this.scheduleRetry(sf)
      return
    }
    sf.failedChunks = undefined

    let inFlight = 0
    for (const k of this.pendingReq) if (k.startsWith(`${file_id}:`)) inFlight++
    const dynamicCap = Math.min(MAX_IN_FLIGHT, Math.max(8, seeders.length * 8))
    let budget = dynamicCap - inFlight
    if (budget <= 0) return

    for (const idx of eligible) {
      if (budget <= 0) break
      const k = this.key(file_id, idx)
      if (this.pendingReq.has(k)) continue
      const peer = this.pickPeer(sf, k)
      if (!peer) break
      this.requestChunk(sf, idx, peer)
      budget--
    }
  }

  private pickPeer(sf: SwarmFile, k: string): string | null {
    const all = [...sf.seeders]
    if (all.length === 0) return null
    const bad = this.badPeers.get(k)
    const good = bad ? all.filter((p) => !bad.has(p)) : all
    const pool = good.length > 0 ? good : all
    if (good.length === 0) this.badPeers.delete(k)
    const cur = this.rr.get(sf.file_id) ?? 0
    this.rr.set(sf.file_id, cur + 1)
    return pool[cur % pool.length]
  }

  pruneSeeders(sf: SwarmFile, idleMs = SEEDER_IDLE_MS): number {
    const now = Date.now()
    let removed = 0
    for (const fp of [...sf.seeders]) {
      if (sf.have.size === sf.chunks) continue
      const seen = sf.lastSeen.get(fp) ?? 0
      if (seen === 0) { sf.lastSeen.set(fp, now); continue }
      if (now - seen > idleMs) { sf.seeders.delete(fp); sf.lastSeen.delete(fp); removed++ }
    }
    if (removed > 0) this.onChange?.()
    return removed
  }

  private requestChunk(sf: SwarmFile, index: number, peer: string) {
    const k = this.key(sf.file_id, index)
    if (this.pendingReq.has(k)) return
    this.pendingReq.add(k)
    this.reqPeer.set(k, peer)
    const timer = window.setTimeout(() => {
      this.failChunk(sf, index, peer, `chunk ${index}: tempo esgotado (${CHUNK_TIMEOUT_MS / 1000}s) — tentando outro peer`)
    }, CHUNK_TIMEOUT_MS)
    const prev = this.chunkTimers.get(k)
    if (prev !== undefined) window.clearTimeout(prev)
    this.chunkTimers.set(k, timer)
    services.fileRequestChunk(sf.file_id, index, peer).catch((e) => {
      this.failChunk(sf, index, peer, `chunk ${index}: falha ao pedir (${describeError(e)})`)
    })
  }

  private clearChunkReq(k: string) {
    this.pendingReq.delete(k)
    this.reqPeer.delete(k)
    const t = this.chunkTimers.get(k)
    if (t !== undefined) { window.clearTimeout(t); this.chunkTimers.delete(k) }
  }

  private failChunk(sf: SwarmFile, index: number, peer: string, msg: string) {
    const k = this.key(sf.file_id, index)
    if (sf.have.has(index)) return
    this.clearChunkReq(k)
    this.markBad(k, peer)
    this.bumpAttempt(k)
    this.lastError = msg
    this.scheduleRetry(sf)
  }

  private markBad(k: string, peer: string) {
    let s = this.badPeers.get(k)
    if (!s) { s = new Set(); this.badPeers.set(k, s) }
    s.add(peer)
  }

  private bumpAttempt(k: string) {
    this.attempts.set(k, (this.attempts.get(k) ?? 0) + 1)
  }

  private key(file_id: string, index: number): string {
    return `${file_id}:${index}`
  }

  private scheduleRetry(sf: SwarmFile) {
    const id = sf.file_id
    if (this.pausedFiles.has(id)) return
    if (this.retryTimer.has(id)) return
    const n = this.retryAttempts.get(id) ?? 0
    const delay = Math.min(RETRY_BASE_MS * 2 ** Math.min(n, 3), RETRY_MAX_MS)
    this.retryAttempts.set(id, n + 1)
    const t = window.setTimeout(() => {
      this.retryTimer.delete(id)
      void this.fetchSwarm(sf)
    }, delay)
    this.retryTimer.set(id, t)
  }

  private clearRetry(file_id: string) {
    const t = this.retryTimer.get(file_id)
    if (t !== undefined) { clearTimeout(t); this.retryTimer.delete(file_id) }
    this.retryAttempts.delete(file_id)
  }

  pauseFile(file_id: string) {
    this.pausedFiles.add(file_id)
    this.clearRetry(file_id)
    this.clearFileTimers(file_id)
  }

  resumeFile(file_id: string) {
    this.pausedFiles.delete(file_id)
    const sf = this.files.get(file_id)
    if (sf && sf.have.size !== sf.chunks) {
      this.resetAttempts(file_id)
      void this.fetchSwarm(sf)
    }
  }

  private resetAttempts(file_id: string) {
    const prefix = `${file_id}:`
    for (const k of [...this.attempts.keys()]) if (k.startsWith(prefix)) this.attempts.delete(k)
  }

  /**
   * Reinicia a busca deste arquivo de verdade: tentativas, ciclos, peers ruins
   * e a marca de "blocos presos". Sem isto, "tentar de novo" reencontrava o
   * estado esgotado e não fazia nada (beco sem saída).
   */
  resetForRetry(file_id: string): void {
    this.resetAttempts(file_id)
    this.clearRetry(file_id)
    const prefix = `${file_id}:`
    for (const k of [...this.badPeers.keys()]) if (k.startsWith(prefix)) this.badPeers.delete(k)
    const sf = this.files.get(file_id)
    if (sf) {
      sf.failedChunks = undefined
    }
  }

  private clearFileTimers(file_id: string) {
    for (const k of [...this.pendingReq]) {
      if (k.startsWith(`${file_id}:`)) this.clearChunkReq(k)
    }
    for (const k of [...this.chunkTimers.keys()]) {
      if (k.startsWith(`${file_id}:`)) {
        const t = this.chunkTimers.get(k)
        if (t !== undefined) clearTimeout(t)
        this.chunkTimers.delete(k)
      }
    }
  }

  onChunkRequest(file_id: string, index: number, from_fp: string) {
    const sf = this.files.get(file_id)
    if (!sf || !sf.have.has(index)) return
    const data = sf.data.get(index)
    if (!data) {
      void this.ensureDataLoaded(sf)
        .then(() => {
          const d = sf.data.get(index)
          if (d) services.fileSendChunk(from_fp, file_id, index, b64(d)).catch(() => {  })
        })
        .catch(() => {  })
      return
    }
    sf.lastSeen.set(from_fp, Date.now())
    services.fileSendChunk(from_fp, file_id, index, b64(data)).catch(() => {  })
  }

  assembleAndDownload(sf: SwarmFile): Blob {
    if (sf.have.size !== sf.chunks) throw new Error(`arquivo incompleto: ${sf.have.size}/${sf.chunks} chunks`)
    const ordered = Array.from({ length: sf.chunks }, (_, i) => sf.data.get(i))
    if (ordered.some(c => !c)) throw new Error('chunk faltando na montagem')
    const total = ordered.reduce((a, b) => a + (b as Uint8Array).length, 0)
    if (sf.size !== 0 && total !== sf.size) {
      throw new Error(`tamanho montado (${total}) diverge do anunciado (${sf.size})`)
    }
    const out = new Uint8Array(total)
    let off = 0
    for (const c of ordered as Uint8Array[]) { out.set(c, off); off += c.length }
    return new Blob([out], { type: mimeFor(sf.name) })
  }

  progress(sf: SwarmFile): number {
    return sf.chunks === 0 ? 0 : Math.round((sf.have.size / sf.chunks) * 100)
  }

  blobFor(file_id: string): Blob | null {
    const sf = this.files.get(file_id)
    if (!sf || sf.chunks === 0 || sf.have.size !== sf.chunks) return null
    try { return this.assembleAndDownload(sf) } catch { return null }
  }

  async ensureBlobFor(file_id: string): Promise<Blob | null> {
    const sf = this.files.get(file_id)
    if (!sf || sf.chunks === 0 || sf.have.size !== sf.chunks) return null
    await this.ensureDataLoaded(sf)
    return this.blobFor(file_id)
  }

  async fetchOnly(file_id: string, onProgress?: (pct: number) => void, timeoutMs = 60000): Promise<void> {
    const sf = this.files.get(file_id)
    if (!sf) throw new Error('arquivo não encontrado (anúncio ainda não chegou?)')
    this.lastError = null
    if (sf.have.size === sf.chunks) { onProgress?.(100); return }
    this.resetAttempts(file_id)
    await this.fetchSwarm(sf)
    const start = Date.now()
    let tick = 0
    while (sf.have.size !== sf.chunks) {
      onProgress?.(this.progress(sf))
      if (Date.now() - start > timeoutMs) {
        this.lastError = `timeout na prévia (${sf.have.size}/${sf.chunks} chunks) — tente novamente`
        throw new Error(this.lastError)
      }
      await sleep(350)
      tick++
      if (tick % 6 === 0) await this.fetchSwarm(sf)
    }
    onProgress?.(100)
  }

  markDownloaded(file_id: string): void {
    const sf = this.files.get(file_id)
    if (!sf) return
    this.clearRetry(file_id)
    this.clearFileTimers(file_id)
    sf.completed = true
    sf.data.clear()
    this.hydratedFiles.delete(file_id)
    this.onChange?.()
  }

  /**
   * Descarta tudo o que foi baixado deste arquivo.
   *
   * Usado quando o hash do arquivo não bate: sem isto o retry reencontrava
   * `have.size === chunks`, finalizava com os MESMOS bytes e falhava de novo,
   * num laço infinito (a mensagem antiga prometia "rebaixar" e nada rebaixava).
   */
  invalidateChunks(file_id: string): void {
    const sf = this.files.get(file_id)
    this.resetForRetry(file_id)
    this.clearFileTimers(file_id)
    if (!sf) return
    sf.have.clear()
    sf.data.clear()
    sf.completed = false
    this.hydratedFiles.delete(file_id)
    this.onChange?.()
  }

  async ensureDataLoaded(sf: SwarmFile): Promise<number> {
    if (services.kind !== 'native') return 0
    const faltando = [...sf.have].filter((i) => !sf.data.has(i))
    if (faltando.length === 0) return 0
    let back = 0
    for (let w = 0; w < faltando.length; w += 8) {
      const wave = faltando.slice(w, w + 8)
      const results = await Promise.all(wave.map(async (i) => {
        try {
          const hit = await services.cacheGet(spoolKey(sf.file_id, i))
          if (!hit) return false
          const bytes = fromB64(hit)
          if (sf.chunkHashes?.[i] && toHexBlake3(bytes).slice(0, 32) !== sf.chunkHashes[i]) return false
          sf.data.set(i, bytes)
          return true
        } catch { return false }
      }))
      back += results.filter(Boolean).length
    }
    return back
  }

  releaseChunks(file_id: string): void {
    const sf = this.files.get(file_id)
    if (!sf) return
    this.clearRetry(file_id)
    this.clearFileTimers(file_id)
    sf.data.clear()
    sf.have.clear()
    if (services.kind === 'native') {
      for (let i = 0; i < sf.chunks; i++) {
        void services.cacheDelete(spoolKey(file_id, i)).catch(() => {  })
      }
    }
    this.hydratedFiles.delete(file_id)
    const prefix = `${file_id}:`
    for (const k of [...this.attempts.keys()]) if (k.startsWith(prefix)) this.attempts.delete(k)
    for (const k of [...this.badPeers.keys()]) if (k.startsWith(prefix)) this.badPeers.delete(k)
    for (const k of [...this.reqPeer.keys()]) if (k.startsWith(prefix)) this.reqPeer.delete(k)
    this.onChange?.()
  }

  remove(file_id: string) {
    const sf = this.files.get(file_id)
    this.files.delete(file_id)
    this.pausedFiles.delete(file_id)
    this.hydratedFiles.delete(file_id)
    if (sf && services.kind === 'native') {
      for (let i = 0; i < sf.chunks; i++) {
        void services.cacheDelete(spoolKey(file_id, i)).catch(() => {  })
      }
    }
    this.clearRetry(file_id)
    this.clearFileTimers(file_id)
    const prefix = `${file_id}:`
    for (const k of [...this.attempts.keys()]) if (k.startsWith(prefix)) this.attempts.delete(k)
    for (const k of [...this.badPeers.keys()]) if (k.startsWith(prefix)) this.badPeers.delete(k)
    for (const k of [...this.reqPeer.keys()]) if (k.startsWith(prefix)) this.reqPeer.delete(k)
    this.rr.delete(file_id)
    this.saving.delete(file_id)
    try { localStorage.removeItem(`distorrent:filemeta:${file_id}`) } catch {  }
    this.onChange?.()
  }

  async fetchAndDownload(file_id: string, onProgress?: (pct: number) => void, timeoutMs = 60000): Promise<string | null> {
    const sf = this.files.get(file_id)
    if (!sf) throw new Error('arquivo não encontrado (anúncio ainda não chegou?)')
    this.lastError = null
    if (sf.have.size !== sf.chunks) {
      this.resetAttempts(file_id)
      await this.fetchSwarm(sf)
      const start = Date.now()
      let tick = 0
      while (sf.have.size !== sf.chunks) {
        onProgress?.(this.progress(sf))
        if (Date.now() - start > timeoutMs) {
          this.lastError = `ainda faltam ${sf.chunks - sf.have.size} chunks (${this.progress(sf)}%) — o swarm continua em segundo plano, tente de novo`
          throw new Error(this.lastError)
        }
        await sleep(350)
        tick++
        if (tick % 6 === 0) await this.fetchSwarm(sf)
      }
    }
    onProgress?.(100)
    return this.download(sf)
  }

  async download(sf: SwarmFile): Promise<string | null> {
    if (sf.have.size !== sf.chunks) throw new Error(`ainda faltam ${sf.chunks - sf.have.size} chunks — não dá para salvar`)
    if (this.saving.has(sf.file_id)) throw new Error('salvamento já em andamento para este arquivo')
    await this.ensureDataLoaded(sf)
    const blob = this.assembleAndDownload(sf)
    const safeName = baseNameOf(sf.name) || 'arquivo'
    this.saving.add(sf.file_id)
    try {
      if (isTauri()) {
        try {
          const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          let savedPath = safeName
          for (let i = 0; i < sf.chunks; i++) {
            const c = sf.data.get(i)
            if (!c) throw new Error(`chunk ${i} sumiu antes do salvamento`)
            const ultimo = i === sf.chunks - 1
            savedPath = await tauriInvoke<string>('save_file_stream', {
              jobId, name: safeName, dataB64: b64(c), flush: ultimo, totalBytes: sf.size,
              expectBlake3: ultimo ? sf.hash : null,
            })
          }
          if (typeof savedPath !== 'string' || !savedPath.trim()) savedPath = safeName
          if (isAndroid()) {
            try {
              return await saveToPublicDownloads(savedPath, baseNameOf(savedPath) || safeName)
            } catch (e) {
              const intentOk = await shareOrFalse(blob, baseNameOf(savedPath) || safeName)
              if (intentOk) return `Download/${baseNameOf(savedPath) || safeName} (compartilhado)`
              const err = new Error(
                `não foi possível gravar em Downloads do celular: ${describeError(e)} — o arquivo continua no app, e os ${sf.chunks} chunks seguem baixados`,
              )
              ;(err as Error & { cause?: unknown }).cause = e
              throw err
            }
          }
          return savedPath
        } catch (e) {
          const raw = describeError(e)
          if (isAndroid()) {
            const err = new Error(`não foi possível salvar via save_file: ${raw} — os ${sf.chunks} chunks seguem baixados, tente de novo`)
            ;(err as Error & { cause?: unknown }).cause = e
            throw err
          }
          console.warn('[fileSwarm] save_file falhou, caindo para download do navegador:', raw)
        }
      }
      try {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = safeName
        a.rel = 'noopener'
        a.style.display = 'none'
        document.body.appendChild(a)
        a.click()
        setTimeout(() => {
          try { document.body.removeChild(a) } catch {  }
          URL.revokeObjectURL(url)
        }, 1200)
        return safeName
      } catch (e) {
        const err = new Error(`download travou no navegador: ${describeError(e)} — o arquivo continua montado, tente de novo`)
        ;(err as Error & { cause?: unknown }).cause = e
        throw err
      }
    } finally {
      this.saving.delete(sf.file_id)
    }
  }
}

export const fileSwarm = new FileSwarm()
