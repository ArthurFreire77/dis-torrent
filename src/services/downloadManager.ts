// DownloadManager — fila de downloads gerenciada sobre o FileSwarm.
// Responsável por: progresso com velocidade, pause/resume/cancel/retry
// reais (não solta mais pedidos de chunk quando pausado), validação de
// integridade blake3 do arquivo MONTADO antes de salvar, notificação de
// conclusão e persistência da fila no localStorage (sobrevive a restart).
// A regra de estados vive em downloadQueue.ts (pura e testada).

import { fileSwarm } from './fileSwarm'
import {
  type DownloadItem, type DownloadMeta,
  computeProgress, deserializeQueue, nextDownloadStatus, rehydrateStatus,
  serializeQueue, verifyFileIntegrity,
} from './downloadQueue'

const LS_KEY = 'forge:downloads:v1'
/** Janela de amostragem da velocidade (ms). */
const SPEED_WINDOW_MS = 2000
/** Sem seeder e sem progresso por este tempo → failed honesto (retry manual). */
const NO_SEEDER_FAIL_MS = 30_000
/** Persistir progresso no máximo 1x/s (evita churn de localStorage). */
const PERSIST_INTERVAL_MS = 1000

function now(): number { return Date.now() }

export interface DownloadManagerEvents {
  /** Item mudou (status/progresso) — UI re-renderiza. */
  onChange?: (items: DownloadItem[]) => void
  /** Download completou (toast/notificação). */
  onDone?: (item: DownloadItem) => void
}

class DownloadManager {
  /** fileId → item da fila. */
  private items = new Map<string, DownloadItem>()
  private running = new Set<string>()
  // `kick` remove o id de `running` no `.finally` ENQUANTO o `finalize` ainda
  // roda (é `void this.finalize(...)` + return). O proximo poll de `onChunk`
  // — ou um resume/retry/load do usuario — entrava de novo e iniciava um
  // SEGUNDO finalize concorrente: duas montagens, dois base64, dois save_file.
  // O segundo batia no guard `saving` do fileSwarm, lanceava, e o item ia para
  // `failed` mesmo com o primeiro tendo dado certo. Este set fecha a corrida.
  private finalizing = new Set<string>()
  private pausedFps = new Set<string>()
  private cancelled = new Set<string>()
  /** fileId → {bytes, at} da janela de velocidade. */
  private speedWin = new Map<string, { bytes: number; at: number }>()
  private lastPersist = 0
  private listeners = new Set<(items: DownloadItem[]) => void>()
  private doneListeners = new Set<(item: DownloadItem) => void>()

  /** Carrega fila persistida e retoma itens que estavam no meio. */
  load(): DownloadItem[] {
    let raw: string | null = null
    try { raw = localStorage.getItem(LS_KEY) } catch { /* ignore */ }
    for (const it of deserializeQueue(raw)) {
      const status = rehydrateStatus(it.status)
      this.items.set(it.file_id, { ...it, status, speedBps: 0 })
      if (status === 'queued') this.kick(it.file_id)
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

  /** Coloca (ou reativa) um arquivo na fila. Retorna o item atual. */
  enqueue(meta: DownloadMeta): DownloadItem {
    const existing = this.items.get(meta.file_id)
    if (existing) {
      if (existing.status === 'completed') return existing
      if (existing.status === 'cancelled' || existing.status === 'failed') {
        // re-enfileirar é um NOVO ciclo de vida (a máquina guarda terminais
        // para ações do usuário); resetamos direto e o laço recomeça.
        this.resetToQueued(existing)
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
      fileSwarm.resumeFile(fileId)
      this.kick(fileId)
    }
  }

  /** Remove o item da fila (dados no swarm seguem — dá pra re-adicionar). */
  remove(fileId: string): void {
    this.items.delete(fileId)
    this.pausedFps.delete(fileId)
    this.cancelled.delete(fileId)
    this.persist()
    this.emit()
  }

  /**
   * Remove da fila tudo que já acabou (completed/failed/cancelled).
   *
   * Solta também os CHUNKS do swarm: `fileSwarm.files` guardava cada arquivo
   * com o `Map<data>` inteiro em RAM (até 200 MB por arquivo) e o
   * `forge:filemeta:*` no localStorage crescia para sempre — e como
   * `restoreLocalFiles()` re-registrava tudo a cada boot, o cache LRU do spool
   * sofria churn de evicção constante. Só libera os chunks; o item continua
   * re-adicionável (o metadado fica, para o re-download).
   */
  clearFinished(): void {
    const done: string[] = []
    for (const [fid, it] of [...this.items.entries()]) {
      if (it.status === 'completed' || it.status === 'failed' || it.status === 'cancelled') {
        this.items.delete(fid)
        done.push(fid)
      }
    }
    for (const fid of done) {
      try { fileSwarm.releaseChunks(fid) } catch { /* best-effort */ }
    }
    this.persist()
    this.emit()
  }

  /** Solta os chunks de um item removido da fila (RAM e spool em disco). */
  releaseIfRemoved(fileId: string): void {
    if (this.items.has(fileId)) return
    try { fileSwarm.releaseChunks(fileId) } catch { /* best-effort */ }
  }

  activeCount(): number {
    let n = 0
    for (const it of this.items.values()) {
      if (it.status === 'queued' || it.status === 'downloading' || it.status === 'verifying' || it.status === 'saving') n++
    }
    return n
  }

  // ── internos ────────────────────────────────────────────────────────────

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

  /** Re-enqueue: novo ciclo de vida para item failed/cancelled. */
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
    for (const cb of this.listeners) { try { cb(items) } catch { /* listener nunca derruba */ } }
  }

  private persist() {
    const t = now()
    if (t - this.lastPersist < PERSIST_INTERVAL_MS && this.lastPersist !== 0) return
    this.lastPersist = t
    try { localStorage.setItem(LS_KEY, serializeQueue(this.list())) } catch { /* quota — fila segue em memória */ }
  }

  private kick(fileId: string) {
    if (this.running.has(fileId)) return
    this.running.add(fileId)
    void this.runLoop(fileId).finally(() => { this.running.delete(fileId) })
  }

  /**
   * Laço por arquivo: pede chunks via swarm, mede progresso/velocidade,
   * verifica integridade no fim e salva. Sai limpo em pause/cancel; o
   * swarm NÃO faz mais pedidos (fileSwarm.pauseFile) e o progresso fica
   * preservado para o resume.
   */
  private async runLoop(fileId: string): Promise<void> {
    const item = this.items.get(fileId)
    if (!item) return
    if (this.pausedFps.has(fileId)) return
    this.setStatus(item, 'start')

    let lastHave = -1
    let lastProgressAt = now()
    let noSeederSince: number | null = null
    try {
      for (;;) {
        if (this.pausedFps.has(fileId) || this.cancelled.has(fileId)) return
        const it = this.items.get(fileId)
        if (!it) return
        const sf = fileSwarm.files.get(fileId)
        if (!sf) {
          this.setStatus(it, 'fail', 'anúncio do arquivo ainda não chegou — tente de novo em instantes')
          return
        }
        if (it.status === 'completed' || it.status === 'cancelled' || it.status === 'failed' || it.status === 'paused') return

        if (sf.have.size === sf.chunks) {
          void this.finalize(fileId, sf)
          return
        }

        // pede os chunks que faltam (o swarm limita concorrência e faz retry)
        void fileSwarm.fetchSwarm(sf).catch(() => { /* retry interno do swarm */ })

        // mede progresso + velocidade
        const have = sf.have.size
        if (have !== lastHave) {
          lastHave = have
          lastProgressAt = now()
          noSeederSince = null
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

        // sem seeder + sem progresso por muito tempo → failed honesto
        if (sf.seeders.size === 0 && have < sf.chunks) {
          if (noSeederSince === null) noSeederSince = now()
          else if (now() - noSeederSince > NO_SEEDER_FAIL_MS && now() - lastProgressAt > NO_SEEDER_FAIL_MS) {
            const it3 = this.items.get(fileId)
            if (it3 && it3.status === 'downloading') {
              this.setStatus(it3, 'fail', 'sem peers com o arquivo no swarm — toque em retomar quando um seeder conectar')
            }
            return
          }
        }

        await sleep(400)
      }
    } catch (e: any) {
      const it = this.items.get(fileId)
      if (it) this.setStatus(it, 'fail', String(e?.message ?? e))
    }
  }

  /** Verificação blake3 do arquivo montado + salvamento + notificação. */
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
        this.setStatus(it, 'verify-fail', 'integridade divergente (hash blake3) — o swarm rebaixa os chunks ruins no retry')
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
      // Arquivo já está em disco: os chunks em RAM não servem mais para nada.
      // Sem isto, `files` guardava o `Map<data>` inteiro (200 MB por arquivo)
      // pelo resto da sessão, e `restoreLocalFiles` o re-registrava a cada boot.
      try { fileSwarm.releaseChunks(fileId) } catch { /* best-effort */ }
    } catch (e: any) {
      const cur = this.items.get(fileId)
      if (cur) this.setStatus(cur, 'save-fail', String(e?.message ?? e))
    }
  }

  /** Notifica conclusão: listeners da UI + Notification do SO quando disponível. */
  private notifyDone(item: DownloadItem) {
    for (const cb of this.doneListeners) { try { cb(item) } catch { /* ignore */ } }
    try {
      const N: any = typeof Notification !== 'undefined' ? Notification : null
      if (N) {
        if (N.permission === 'granted') {
          new N('Download concluído', { body: `${item.name} salvo${item.savedPath ? ` em ${item.savedPath}` : ''}` })
        } else if (N.permission === 'default' && typeof document !== 'undefined') {
          // pede permissão uma vez (gesto de download conta como interação)
          void N.requestPermission?.().then((p: string) => {
            if (p === 'granted') new N('Download concluído', { body: `${item.name} salvo` })
          }).catch(() => {})
        }
      }
    } catch { /* notificação é best-effort — nunca derruba o save */ }
    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('forge:download_done', { detail: { file_id: item.file_id, name: item.name, savedPath: item.savedPath } }))
      }
    } catch { /* ignore */ }
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

export const downloadManager = new DownloadManager()
try {
  if (typeof window !== 'undefined') {
    // a fila revive junto com o app (identidade ainda nem precisa existir)
    window.addEventListener('DOMContentLoaded', () => { try { downloadManager.load() } catch { /* ignore */ } })
  }
} catch { /* SSR/none — ignore */ }
