import { fileSwarm } from './fileSwarm'
import { sleep } from '../shared/async.ts'
import {
  type DownloadItem, type DownloadMeta,
  computeProgress, deserializeQueue, nextDownloadStatus, rehydrateStatus,
  serializeQueue, verifyFileIntegrity,
} from './downloadQueue'

const LS_KEY = 'distorrent:downloads:v1'
const SPEED_WINDOW_MS = 2000
const NO_SEEDER_FAIL_MS = 30_000
const ANNOUNCE_WAIT_MS = 30_000
/**
 * Tempo sem nenhum bloco novo, com blocos já marcados como presos, até virar
 * `failed`. Antes não existia teto: o item ficava "Baixando 0%" para sempre.
 */
const STALL_FAIL_MS = 45_000
const PERSIST_INTERVAL_MS = 1000

function now(): number { return Date.now() }

export interface DownloadManagerEvents {
  onChange?: (items: DownloadItem[]) => void
  onDone?: (item: DownloadItem) => void
}

class DownloadManager {
  private items = new Map<string, DownloadItem>()
  private running = new Set<string>()
  private finalizing = new Set<string>()
  private pausedFps = new Set<string>()
  private cancelled = new Set<string>()
  private speedWin = new Map<string, { bytes: number; at: number }>()
  private lastPersist = 0
  private listeners = new Set<(items: DownloadItem[]) => void>()
  private doneListeners = new Set<(item: DownloadItem) => void>()

  load(): DownloadItem[] {
    let raw: string | null = null
    try { raw = localStorage.getItem(LS_KEY) } catch {  }
    for (const it of deserializeQueue(raw)) {
      const status = rehydrateStatus(it.status)
      this.items.set(it.file_id, { ...it, status, speedBps: 0 })
    }
    const pendentes = [...this.items.values()].filter((i) => i.status === 'queued')
    if (pendentes.length > 0) {
      setTimeout(() => {
        for (const it of pendentes) {
          if (this.items.get(it.file_id)?.status === 'queued') this.kick(it.file_id)
        }
      }, 1500)
    }
    this.emit()
    return this.list()
  }

  list(): DownloadItem[] {
    return [...this.items.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  get(fileId: string): DownloadItem | undefined {
    return this.items.get(fileId)
  }

  subscribe(cb: (items: DownloadItem[]) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  onDone(cb: (item: DownloadItem) => void): () => void {
    this.doneListeners.add(cb)
    return () => { this.doneListeners.delete(cb) }
  }

  enqueue(meta: DownloadMeta): DownloadItem {
    const existing = this.items.get(meta.file_id)
    if (existing) {
      if (existing.status === 'completed') return existing
      if (existing.status === 'cancelled' || existing.status === 'failed') {
        this.resetToQueued(existing)
      }
      if (this.wantsTransfer(existing.status) && !this.running.has(meta.file_id)) {
        this.pausedFps.delete(meta.file_id)
        this.cancelled.delete(meta.file_id)
        fileSwarm.resetForRetry(meta.file_id)
        this.setStatus(existing, 'start')
        this.kick(meta.file_id)
      }
      return existing
    }
    const item: DownloadItem = {
      ...meta,
      id: meta.file_id,
      status: 'queued',
      progress: 0,
      have: 0,
      speedBps: 0,
      startedAt: now(),
      updatedAt: now(),
    }
    this.items.set(meta.file_id, item)
    this.persist()
    this.emit()
    this.kick(meta.file_id)
    return item
  }

  pause(fileId: string): void {
    const it = this.items.get(fileId)
    if (!it) return
    if (nextDownloadStatus(it.status, 'pause') !== it.status) {
      this.setStatus(it, 'pause')
      this.pausedFps.add(fileId)
      fileSwarm.pauseFile(fileId)
      it.speedBps = 0
    }
  }

  resume(fileId: string): void {
    const it = this.items.get(fileId)
    if (!it) return
    if (nextDownloadStatus(it.status, 'resume') !== it.status) {
      this.setStatus(it, 'resume')
      this.pausedFps.delete(fileId)
      this.cancelled.delete(fileId)
      fileSwarm.resumeFile(fileId)
      this.kick(fileId)
    }
  }

  cancel(fileId: string): void {
    const it = this.items.get(fileId)
    if (!it) return
    if (nextDownloadStatus(it.status, 'cancel') !== it.status) {
      this.setStatus(it, 'cancel')
      this.pausedFps.add(fileId)
      this.cancelled.add(fileId)
      fileSwarm.pauseFile(fileId)
      it.speedBps = 0
    }
  }

  retry(fileId: string): void {
    const it = this.items.get(fileId)
    if (!it) return
    if (nextDownloadStatus(it.status, 'retry') !== it.status) {
      this.setStatus(it, 'retry')
      this.pausedFps.delete(fileId)
      this.cancelled.delete(fileId)
      fileSwarm.resetForRetry(fileId)
      fileSwarm.resumeFile(fileId)
      this.kick(fileId)
    } else if (!this.running.has(fileId) && this.wantsTransfer(it.status)) {
      // `retry` com status `downloading` era no-op; força a retomada.
      fileSwarm.resetForRetry(fileId)
      this.kick(fileId)
    }
  }

  remove(fileId: string): void {
    this.items.delete(fileId)
    this.pausedFps.delete(fileId)
    this.cancelled.delete(fileId)
    this.persist()
    this.emit()
  }

  clearFinished(): void {
    const done: string[] = []
    for (const [fid, it] of [...this.items.entries()]) {
      if (it.status === 'completed' || it.status === 'failed' || it.status === 'cancelled') {
        this.items.delete(fid)
        done.push(fid)
      }
    }
    for (const fid of done) {
      try { fileSwarm.releaseChunks(fid) } catch {  }
    }
    this.persist()
    this.emit()
  }

  releaseIfRemoved(fileId: string): void {
    if (this.items.has(fileId)) return
    try { fileSwarm.releaseChunks(fileId) } catch {  }
  }

  activeCount(): number {
    let n = 0
    for (const it of this.items.values()) {
      if (it.status === 'queued' || it.status === 'downloading' || it.status === 'verifying' || it.status === 'saving') n++
    }
    return n
  }

  private setStatus(it: DownloadItem, ev: Parameters<typeof nextDownloadStatus>[1], error?: string) {
    const next = nextDownloadStatus(it.status, ev)
    if (next !== it.status || error !== undefined) {
      it.status = next
      it.error = error
      it.updatedAt = now()
      this.persist()
      this.emit()
    }
  }

  private resetToQueued(it: DownloadItem) {
    it.status = 'queued'
    it.error = undefined
    it.speedBps = 0
    it.updatedAt = now()
    this.pausedFps.delete(it.file_id)
    this.cancelled.delete(it.file_id)
    fileSwarm.resumeFile(it.file_id)
    this.persist()
    this.emit()
    this.kick(it.file_id)
  }

  private emit() {
    const items = this.list()
    for (const cb of this.listeners) { try { cb(items) } catch {  } }
  }

  private persist() {
    const t = now()
    if (t - this.lastPersist < PERSIST_INTERVAL_MS && this.lastPersist !== 0) return
    this.lastPersist = t
    try { localStorage.setItem(LS_KEY, serializeQueue(this.list())) } catch {  }
  }

  private kick(fileId: string) {
    if (this.running.has(fileId)) return
    this.running.add(fileId)
    void this.runLoop(fileId).finally(() => { this.running.delete(fileId) })
  }

  /** Status em que o download deveria estar progredindo (tem laço vivo). */
  private wantsTransfer(status: DownloadItem['status']): boolean {
    return status === 'queued' || status === 'downloading' || status === 'verifying' || status === 'saving'
  }

  private async runLoop(fileId: string): Promise<void> {
    const item = this.items.get(fileId)
    if (!item) return
    if (this.pausedFps.has(fileId)) return
    this.setStatus(item, 'start')

    let lastHave = -1
    let lastProgressAt = now()
    let noSeederSince: number | null = null
    const waitStartedAt = now()
    try {
      for (;;) {
        if (this.pausedFps.has(fileId) || this.cancelled.has(fileId)) return
        const it = this.items.get(fileId)
        if (!it) return
        const sf = fileSwarm.files.get(fileId)
        if (!sf) {
          if (now() - waitStartedAt > ANNOUNCE_WAIT_MS) {
            this.setStatus(it, 'fail', 'o anúncio deste arquivo não chegou — o remetente pode estar offline; toque em retomar')
            return
          }
          await sleep(400)
          continue
        }
        if (it.status === 'completed' || it.status === 'cancelled' || it.status === 'failed' || it.status === 'paused') return

        if (sf.have.size === sf.chunks) {
          void this.finalize(fileId, sf)
          return
        }

        void fileSwarm.fetchSwarm(sf).catch(() => {  })

        const have = sf.have.size
        if (have !== lastHave) {
          lastHave = have
          lastProgressAt = now()
          noSeederSince = null
          const itNow = this.items.get(fileId)
          if (itNow && itNow.status === 'downloading') {
            itNow.have = have
            itNow.progress = computeProgress(have, sf.chunks)
            itNow.updatedAt = now()
            this.emit()
          }
        }

        if (sf.failedChunks && sf.failedChunks.size > 0 && now() - lastProgressAt > STALL_FAIL_MS) {
          const st = this.items.get(fileId)
          if (st && (st.status === 'downloading' || st.status === 'queued')) {
            this.setStatus(
              st,
              'fail',
              fileSwarm.lastError ?? `${sf.failedChunks.size} bloco(s) não chegaram — toque em tentar de novo`,
            )
          }
          return
        }
        const win = this.speedWin.get(fileId) ?? { bytes: 0, at: now() }
        const deltaBytes = Math.max(0, (have - win.bytes)) * 256 * 1024
        const dt = now() - win.at
        if (dt >= SPEED_WINDOW_MS) {
          const it2 = this.items.get(fileId)
          if (it2) {
            it2.speedBps = Math.round((deltaBytes / dt) * 1000)
            it2.have = have
            it2.progress = computeProgress(have, sf.chunks)
            it2.updatedAt = now()
          }
          this.speedWin.set(fileId, { bytes: have, at: now() })
          this.persist()
          this.emit()
        }

        fileSwarm.pruneSeeders(sf)
        if (sf.seeders.size === 0 && have < sf.chunks) {
          if (noSeederSince === null) noSeederSince = now()
          else if (now() - noSeederSince > NO_SEEDER_FAIL_MS && now() - lastProgressAt > NO_SEEDER_FAIL_MS) {
            const it3 = this.items.get(fileId)
            if (it3 && (it3.status === 'downloading' || it3.status === 'queued')) {
              this.setStatus(it3, 'fail', 'sem peers com o arquivo no swarm — toque em retomar quando um seeder conectar')
            }
            return
          }
        } else {
          noSeederSince = null
        }

        await sleep(400)
      }
    } catch (e: any) {
      const it = this.items.get(fileId)
      if (it) this.setStatus(it, 'fail', String(e?.message ?? e))
    }
  }

  private async finalize(fileId: string, sf: import('./fileSwarm').SwarmFile): Promise<void> {
    if (this.finalizing.has(fileId)) return
    this.finalizing.add(fileId)
    try { await this.finalizeInner(fileId, sf) } finally { this.finalizing.delete(fileId) }
  }

  private async finalizeInner(fileId: string, sf: import('./fileSwarm').SwarmFile): Promise<void> {
    const it = this.items.get(fileId)
    if (!it) return
    this.setStatus(it, 'chunks-complete')
    try {
      const blob = fileSwarm.assembleAndDownload(sf)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (!verifyFileIntegrity(bytes, sf.hash)) {
        fileSwarm.invalidateChunks(fileId)
        this.setStatus(
          it,
          'verify-fail',
          'integridade divergente (hash blake3) — os blocos foram descartados; baixe de novo',
        )
        return
      }
      this.setStatus(it, 'verify-ok')
      const savedPath = await fileSwarm.download(sf)
      const cur = this.items.get(fileId)
      if (!cur) return
      this.setStatus(cur, 'save-ok')
      cur.savedPath = savedPath ?? cur.name
      cur.progress = 100
      cur.have = sf.chunks
      cur.speedBps = 0
      cur.updatedAt = now()
      this.persist()
      this.emit()
      this.notifyDone(cur)
      try { fileSwarm.markDownloaded(fileId) } catch {  }
    } catch (e: any) {
      const cur = this.items.get(fileId)
      if (cur) this.setStatus(cur, 'save-fail', String(e?.message ?? e))
    }
  }

  private notifyDone(item: DownloadItem) {
    for (const cb of this.doneListeners) { try { cb(item) } catch {  } }
    try {
      const N: any = typeof Notification !== 'undefined' ? Notification : null
      if (N) {
        if (N.permission === 'granted') {
          new N('Download concluído', { body: `${item.name} salvo${item.savedPath ? ` em ${item.savedPath}` : ''}` })
        } else if (N.permission === 'default' && typeof document !== 'undefined') {
          void N.requestPermission?.().then((p: string) => {
            if (p === 'granted') new N('Download concluído', { body: `${item.name} salvo` })
          }).catch(() => {})
        }
      }
    } catch {  }
    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('distorrent:download_done', { detail: { file_id: item.file_id, name: item.name, savedPath: item.savedPath } }))
      }
    } catch {  }
  }
}

export const downloadManager = new DownloadManager()
try {
  if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => { try { downloadManager.load() } catch {  } })
  }
} catch {  }
