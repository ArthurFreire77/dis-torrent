// FileSwarm — BitTorrent-like: arquivo fatiado em chunks de 256KB, todos semeiam
// Quanto mais peers têm o arquivo, mais rápido (swarm). Anúncio via FileAnnounce.
// Fixes: sem auto-download, concorrência limitada + retry/backoff, timeout por
// chunk com troca de peer, resume em memória, verificação blake3, save confiável.

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

// Regras puras (validação, tamanho de bloco, MIME, chaves) moram em
// `fileRules.ts` para poderem ser testadas sem DOM/IPC. Reexportadas aqui
// porque o resto do app já importa deste módulo.
export {
  CHUNK, MAX_CHUNKS, FILE_MARKER, FILE_PREFIX,
  validateAnnounce, chunkCountFor, expectedChunkSize, formatFileSize,
  mimeFor, isImageName, isVideoName, isMediaName, mediaAutoFetchCap,
  spoolKey, chunkKey, swarmProgress, safeFileName,
}
export type { FileMsgMeta }

export const MAX_FILE_SIZE = (() => {
  // derivado de MAX_CHUNKS para não haver duas verdades: o teto real é
  // `ceil(MAX_FILE_SIZE / CHUNK) + 1` blocos.
  const meta = import.meta as unknown as { env?: Record<string, string> }
  const n = Number(meta.env?.VITE_DISTORRENT_MAX_FILE_MB)
  const mb = Number.isFinite(n) && n > 0 ? n : 51200
  return mb * 1024 * 1024
})()
export const MAX_FILE_MB_LABEL = Math.round(MAX_FILE_SIZE / (1024 * 1024)) >= 1024
  ? `${(MAX_FILE_SIZE / (1024 * 1024 * 1024)).toFixed(MAX_FILE_SIZE % (1024 * 1024 * 1024) === 0 ? 0 : 1)} GB`
  : `${Math.round(MAX_FILE_SIZE / (1024 * 1024))} MB`


/**
 * Teto de tamanho por arquivo. Configuravel por DISTORRENT_MAX_FILE_MB (bundle nao
 * tem terminal: exporte antes de subir o app, ou use um launcher).
 *
 * PADRAO: 50 GB. O teto nao e' arbitrario — e' a validacao anti-DoS: sem ele, um
 * peer anuncia "size: 5000 GB" num frame de 200 bytes e o motor tenta alocar o
 * buffer inteiro. `validateAnnounce` roda no envio local E no anuncio remoto,
 * entao o teto protege dos dois lados. Com 50 GB um filme/backup grande passa;
 * o disco e' protegido pelo espaco livre antes de gravar, e a memoria pelo
 * teto de um LOTE (32 MB), nunca pelo tamanho total.
 */

// Swarm: não inundar o peer. Teto de chunks em voo por arquivo (relay-friendly),

// com concorrência ADAPTATIVA em fetchSwarm (8 por seeder, máx. este teto) e
// timeout por chunk para re-pedir de outro seeder.
const MAX_IN_FLIGHT = 24
const CHUNK_TIMEOUT_MS = 5000
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 8000
// Teto de tentativas por chunk: impede retry infinito em background.
const MAX_CHUNK_ATTEMPTS = 8
// Teto de ciclos de retry por arquivo (cada ciclo = 8 tentativas por chunk).
// Evita re-agendar para sempre quando nao ha seeder vivo algum.
const MAX_RETRY_CYCLES = 6
// Seeder que não se manifesta por este tempo sai do swarm (anúncio/chunk).
// 90s = cobre 2 ciclos de handshake/relay ruins sem descartar peer só lento.
const SEEDER_IDLE_MS = 90_000

// Validação anti-DoS compartilhada (envio local e anúncio remoto).
// Retorna a mensagem de erro ou null se válido.

// Corpo de mensagem que carrega um arquivo: legível por humanos + metadados
// embutidos para renderizar o cartão com botão Baixar em qualquer shell.
// Implementado em `fileBody.ts` (puro, testável sem IPC); reexportado aqui
// porque o resto do app importa deste módulo.
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
  /**
   * Última vez que cada seeder se manifestou (anúncio ou chunk entregue).
   *
   * Antes `seeders` só crescia: um peer que fechava o app continuava na lista
   * para sempre, era escolhido em round-robin e queimava as 8 tentativas de
   * cada chunk — o download ficava em 0% sem nunca virar erro. Agora a lista é
   * podada por inatividade (ver `pruneSeeders`).
   */
  lastSeen: Map<string, number>
  /** Já recebemos o arquivo inteiro de alguma sessão anterior? (persistido) */
  completed?: boolean
}

function b64(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
}
function fromB64(s: string): Uint8Array {
  return base64ToBytes(s)
}

/** Mensagem curta e honesta (pt-BR) a partir de qualquer erro sem vazar stack. */
function describeError(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  if (typeof e === 'string') return e
  try { return JSON.stringify(e) } catch { return String(e) }
}

function isTauri(): boolean {
  return isTauriRuntime()
}

/** Android via UA — no WebView Tauri o anchor-blob NÃO dispara download. */
export function isAndroid(): boolean {
  return isAndroidRuntime()
}

/** Tauri rodando no Android: único caminho confiável é o `save_file` nativo. */
export function isTauriAndroidRuntime(): boolean {
  return isTauriAndroid()
}

function baseNameOf(p: string): string {
  try {
    const b = String(p ?? '').split(/[\\/]/).pop() ?? ''
    return b || String(p ?? '')
  } catch { return String(p ?? '') }
}

// Forma mínima de `navigator.share` para evitar `any` (lib DOM varia por versão).
interface FileShareNavigator {
  share?: (data: { files: File[]; title?: string }) => Promise<void>
  canShare?: (data: { files: File[] }) => boolean
}

/**
 * `navigator.share` realmente abriu a folha de compartilhamento? O WebView
 * engole o erro (usuário cancelar e "sem suporte" são a mesma coisa). Para o
 * caminho do Android isso importa: "compartilhei e você escolheu onde" ≠
 * "não consegui te entregar nada" — e o segundo caso precisa virar erro
 * honesto em vez de um "salvo" que ninguém acha.
 */
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

/**
 * Android: move o arquivo do diretório privado do app para a pasta
 * **Downloads de verdade** (MediaStore, API 29+ — sem permissão; pasta
 * legada abaixo disso). Sem isto o arquivo parava em
 * /data/data/com.distorrent.app/files/… — "uma pasta estranha" que nenhum
 * explorador de arquivos mostra.
 *
 * O Rust já gravou o arquivo com escrita atômica; aqui é só cópia local
 * (o plugin apaga o rascunho). Devolve o caminho público pro toast.
 */
async function saveToPublicDownloads(privatePath: string, name: string): Promise<string> {
  // A chamada é do RUST (`save_public_copy`), não de `plugin:downloads|save`.
  // O WebView não pode invocar o plugin: a capability só declara `core:default`
  // e o Tauri recusa com "not allowed by ACL" — era o erro que aparecia em TODO
  // download no Android ("não foi possível salvar via save_file ... not allowed
  // by ACL"). O handle do plugin vive no processo nativo, onde o ACL do WebView
  // não se aplica.
  const pub = await tauriInvoke<string>('save_public_copy', { path: privatePath, name })
  const trimmed = typeof pub === 'string' ? pub.trim() : ''
  if (!trimmed) throw new Error('o Android devolveu caminho vazio ao salvar em Downloads')
  return trimmed
}


export class FileSwarm {
  files = new Map<string, SwarmFile>()
  onChange?: () => void
  lastError: string | null = null

  // Requisições em voo: chave `${file_id}:${index}` -> evita pedir o mesmo chunk 2x.
  private pendingReq = new Set<string>()
  // Peer escolhido para cada chunk em voo (para trocar de peer no timeout).
  private reqPeer = new Map<string, string>()
  // Tentativas por chunk (backoff e diagnóstico).
  private attempts = new Map<string, number>()
  // Peers que falharam/corromperam um chunk específico — evita reincidência imediata.
  private badPeers = new Map<string, Set<string>>()
  // 1 timer de timeout por chunk (sem órfãos acumulando em swarm grande).
  private chunkTimers = new Map<string, number>()
  // 1 timer de re-kick por arquivo, com backoff exponencial.
  private retryTimer = new Map<string, number>()
  // Serializa fetchSwarm por arquivo — ver o comentário em fetchSwarm.
  private fetching = new Map<string, Promise<unknown>>()
  private retryAttempts = new Map<string, number>()
  // Cursor round-robin por arquivo para distribuir pedidos entre seeders.
  private rr = new Map<string, number>()
  // Guarda de salvamento concorrente por arquivo (evita 2 saves simultâneos).
  private saving = new Set<string>()
  // Arquivos que já reanunciamos como SEMEADORES (vira swarm: mais peers = mais rápido).
  private seededAsSeeder = new Set<string>()
  // Arquivos PAUSADOS pela fila de downloads: fetchSwarm não faz novos
  // pedidos de chunk (os que estão em voo ainda podem chegar — dados nunca
  // se perdem). O resume limpa a flag e dá re-kick.
  private pausedFiles = new Set<string>()
  // Arquivos já reidratados do cache em disco nesta sessão (spool de chunks).
  // Garante 1 reidratação por arquivo — fetchSwarm é chamado em loop.
  private hydratedFiles = new Set<string>()

  async shareFile(file: File): Promise<SwarmFile> {
    if (file.size === 0) throw new Error('arquivo vazio')
    const sizeErr = validateAnnounce(file.size, Math.max(1, Math.ceil(file.size / CHUNK)))
    if (sizeErr) throw new Error(sizeErr)
    const buf = new Uint8Array(await file.arrayBuffer())
    const chunks = Math.max(1, Math.ceil(buf.length / CHUNK))
    // nome seguro: basename apenas, sem path traversal
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
    // anuncia para swarm — todos peers online recebem e podem servir (com chunk_hashes blake3)
    try {
      await services.fileAnnounce(file_id, safeName, buf.length, chunks, hash, chunkHashes)
    } catch {
      // core antigo sem chunk_hashes: tenta anúncio básico (integridade por chunk fica opcional)
      await services.fileAnnounce(file_id, safeName, buf.length, chunks, hash).catch(() => { /* best-effort */ })
    }
    try { localStorage.setItem(`distorrent:filemeta:${file_id}`, JSON.stringify({ name: safeName, size: buf.length, chunks, hash, chunkHashes })) } catch { /* silent */ }
    this.onChange?.()
    return sf
  }

  // Quando recebe FileAnnounce, registra o arquivo e os seeders. NÃO baixa
  // automaticamente: o download só começa no gesto do usuário ("Baixar") ou,
  // para imagens, via `fetchOnly` chamado pela UI de prévia.
  // Aceita chunkHashes opcional para verificação de cada chunk.
  onAnnounce(file_id: string, name: string, size: number, chunks: number, hash: string, from_fp: string, chunkHashes?: string[]): boolean {
    this.lastError = null
    const verr = validateAnnounce(size, chunks)
    if (verr) {
      this.lastError = verr
      try { console.warn('[fileSwarm] anúncio rejeitado:', verr, file_id) } catch { /* ignore */ }
      return false
    }
    const existing = this.files.get(file_id)
    if (existing) {
      // Um peer só entra como seeder se o anúncio dele for COERENTE com o que
      // já conhecemos. Antes era `existing.seeders.add(from_fp)` cego: qualquer
      // peer que reenviasse o mesmo `file_id` com outro tamanho virava seeder
      // de um arquivo que não tem.
      if (existing.size !== size || existing.chunks !== chunks) {
        this.lastError = 'anúncio divergente para o mesmo file_id — ignorado'
        return false
      }
      existing.seeders.add(from_fp)
      existing.lastSeen.set(from_fp, Date.now())
      // preenche chunkHashes se o primeiro anúncio não tinha e agora chegou
      if (!existing.chunkHashes && this.validChunkHashes(chunkHashes, chunks)) existing.chunkHashes = chunkHashes
      this.onChange?.()
      return true
    }
    // sanitiza nome recebido
    const safeName = (name || 'arquivo').split(/[\\/]/).pop()?.trim().slice(0, 200) || 'arquivo'
    if (!safeName || safeName.startsWith('.')) {
      this.lastError = 'nome de arquivo inválido'
      return false
    }
    // tenta recuperar chunkHashes do storage kv se não veio no evento (Tauri legado)
    let ch = this.validChunkHashes(chunkHashes, chunks) ? chunkHashes : undefined
    if (!ch) {
      try {
        const raw = localStorage.getItem(`distorrent:file:chunk_hashes:${file_id}`)
        if (raw) { const parsed = JSON.parse(raw); if (this.validChunkHashes(parsed, chunks)) ch = parsed } 
      } catch { /* ignore */ }
    }
    // fallback localStorage meta
    if (!ch) {
      try {
        const j = localStorage.getItem(`distorrent:filemeta:${file_id}`)
        if (j) { const o = JSON.parse(j); if (this.validChunkHashes(o?.chunkHashes, chunks)) ch = o.chunkHashes }
      } catch { /* ignore */ }
    }
    const sf: SwarmFile = { file_id, name: safeName, size, chunks, hash, chunkHashes: ch, have: new Set(), data: new Map(), seeders: new Set([from_fp]), owner_fp: from_fp, lastSeen: new Map([[from_fp, Date.now()]]) }
    this.files.set(file_id, sf)
    try { localStorage.setItem(`distorrent:filemeta:${file_id}`, JSON.stringify({ name: safeName, size, chunks, hash, chunkHashes: ch })) } catch { /* silent */ }
    this.onChange?.()
    // NUNCA inicia download aqui (objetivo: arquivos não baixam sozinhos).
    return true
  }

  /** chunkHashes só é aceito se for array de strings com o tamanho exato. */
  private validChunkHashes(ch: unknown, chunks: number): ch is string[] {
    return Array.isArray(ch) && ch.length === chunks && ch.every((h) => typeof h === 'string' && h.length > 0)
  }

  onChunkData(file_id: string, index: number, b64data: string, from_fp: string) {
    const sf = this.files.get(file_id)
    if (!sf) return
    // ÍNDICE fora da faixa: antes ia direto para `have`, e `have.size` passava
    // de `chunks` — o progresso mostrava >100% e `assembleAndDownload` estourava
    // no fim do download. Um peer responde um índice que o arquivo não tem.
    if (!Number.isInteger(index) || index < 0 || index >= sf.chunks) {
      this.failChunk(sf, index, from_fp, `chunk ${index} fora da faixa (0..${sf.chunks - 1}) — descartado`)
      return
    }
    const k = this.key(file_id, index)
    // já temos este chunk (retransmissão/duplicado): só limpa a requisição pendente
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
    // TAMANHO do bloco: todo bloco é CHUNK, exceto o último (o resto). Sem esta
    // checagem um peer manda 3 bytes no índice 5 e o arquivo final sai com o
    // tamanho errado — o hash só acusaria depois de baixar tudo de novo.
    const esperado = index === sf.chunks - 1 ? sf.size - index * CHUNK : CHUNK
    if (esperado > 0 && bytes.length !== esperado) {
      this.failChunk(sf, index, from_fp, `chunk ${index} com tamanho ${bytes.length} (esperado ${esperado}) — pedindo a outro peer`)
      return
    }
    // verifica integridade blake3 se tivermos hash do chunk
    if (sf.chunkHashes?.[index]) {
      const got = toHexBlake3(bytes).slice(0, 32)
      if (got !== sf.chunkHashes[index]) {
        // corrompido: marca o peer e libera o chunk para outro seeder
        this.failChunk(sf, index, from_fp, `chunk ${index} corrompido — pedindo a outro peer`)
        return
      }
    }
    sf.data.set(index, bytes)
    sf.have.add(index)
    sf.seeders.add(from_fp)
    sf.lastSeen.set(from_fp, Date.now())
    // SPOOL EM DISCO (5.4): chunk validado vai ao cache LRU — se o app cair
    // ou a página recarregar, o progresso é reidratado sem rebaixar do swarm.
    // Só no nativo (localStorage do browser não aguenta arquivos grandes).
    if (services.kind === 'native') {
      void services.cachePut(spoolKey(file_id, index), b64data).catch(() => { /* best-effort */ })
    }
    // progresso: limpa histórico de falha deste chunk e reinicia backoff do arquivo
    this.badPeers.delete(k)
    this.attempts.delete(k)
    this.retryAttempts.set(file_id, 0)
    this.lastError = null
    this.onChange?.()
    if (sf.have.size === sf.chunks) {
      // completo: NÃO salva NEM baixa sozinho — usuário decide no gesto.
      this.clearRetry(file_id)
      this.clearFileTimers(file_id)
      // VIRA SEMEADOR: reanuncia no swarm p/ os demais baixarem de você também.
      // Quanto mais peers com o arquivo, mais rápido e mais distribuído (torrent).
      if (!this.seededAsSeeder.has(file_id)) {
        this.seededAsSeeder.add(file_id)
        void services.fileAnnounce(sf.file_id, sf.name, sf.size, sf.chunks, sf.hash, sf.chunkHashes).catch(() => {})
      }
    } else {
      void this.fetchSwarm(sf)
    }
  }

  /**
   * Agenda/continua o download respeitando concorrência limitada.
   * Só pede chunks que faltam e que não estão em voo; escolhe seeder por
   * round-robin evitando peers que já falharam naquele chunk.
   */
  /**
   * Reidrata chunks do spool em disco (1x por arquivo nesta sessão).
   * Retorna quantos chunks voltaram sem precisar da rede. Cada chunk é
   * revalidado pelo hash (quando conhecido) — cache corrompido não entra.
   */
  async ensureHydrated(sf: SwarmFile): Promise<number> {
    if (services.kind !== 'native') return 0
    if (this.hydratedFiles.has(sf.file_id)) return 0
    this.hydratedFiles.add(sf.file_id)
    let back = 0
    const missing: number[] = []
    for (let i = 0; i < sf.chunks; i++) if (!sf.have.has(i)) missing.push(i)
    // lotes paralelos de 8 IPCs (800 chunks = 100 rodadas, não 800 seriais)
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
        } catch { return false /* chunk inválido no cache — baixa da rede */ }
      }))
      back += results.filter(Boolean).length
    }
    if (back > 0) this.onChange?.()
    return back
  }

  /**
   * Deixa a mídia pronta para RENDERIZAR no chat (baixa, mas NÃO salva em
   * Downloads). Ordem de escolha:
   *
   * 1. já está em memória → nada a fazer;
   * 2. reidrata do spool em disco → o usuário JÁ tinha baixado isso numa
   *    sessão anterior, então o custo é zero e o cap de tamanho NÃO se
   *    aplica (seria exigir a segunda vez o que ele já pagou);
   * 3. baixa da rede, respeitando o cap de tamanho.
   *
   * É o passo 2 que faltava: ao abrir o app os chunks vivem no disco, não na
   * memória, e `blobFor` devolvia null — então a imagem só aparecia se
   *-network desse volume, o que é diferente de "está baixado aqui".
   */
  async prepareMedia(sf: SwarmFile, onProgress?: (pct: number) => void, timeoutMs = 120_000): Promise<void> {
    if (sf.have.size === sf.chunks && sf.chunks > 0) { onProgress?.(100); return }
    // 1) memória → disco: se o spool completar, nem chega na rede.
    await this.ensureHydrated(sf)
    if (sf.have.size === sf.chunks && sf.chunks > 0) { onProgress?.(100); return }
    // 2) teto de tráfego: acima disso o usuário clica em Baixar.
    if (sf.size > mediaAutoFetchCap(sf.name)) {
      throw new Error(`mídia de ${Math.round(sf.size / (1024 * 1024))}MB acima do automático — toque em Baixar`)
    }
    // 3) rede. `fetchOnly` já reidrata e re-kicka sozinho.
    await this.fetchOnly(sf.file_id, onProgress, timeoutMs)
  }

  async fetchSwarm(sf: SwarmFile): Promise<void> {
    const file_id = sf.file_id
    // pausado pela fila: não faz novos pedidos (chunks em voo ainda entram).
    if (this.pausedFiles.has(file_id)) return
    // TRAVA POR ARQUIVO. `fetchSwarm` era chamado de `onChunkData` a CADA chunk
    // que chegava (24+ concorrentes num burst) e do poll do downloadManager a
    // cada 400 ms. Todas faziam `await this.ensureHydrated(sf)` ANTES de
    // computar `inFlight`/`budget` — e como sao todas awaited sobre o mesmo
    // `inFlight` obsoleto, todas passavam do teto de MAX_IN_FLIGHT. Cada uma
    // alocava 341 KB de base64 na heap + 1 IPC + 1 SecureFrame de 341 KB numa
    // fila sem backpressure (engine.rs) -> latencia > 5 s -> cascata de timeouts.
    // Serializar por arquivo resolve: a 2a chamada ve o `inFlight` ja atualizado.
    const anterior = this.fetching.get(file_id) ?? Promise.resolve()
    const atual = anterior.then(() => this.fetchSwarmInner(sf)).catch(() => {})
    this.fetching.set(file_id, atual)
    try { await atual } finally { if (this.fetching.get(file_id) === atual) this.fetching.delete(file_id) }
  }

  private async fetchSwarmInner(sf: SwarmFile): Promise<void> {
    const file_id = sf.file_id
    if (this.pausedFiles.has(file_id)) return
    // resume em disco antes de pedir à rede (1x por arquivo por sessão)
    await this.ensureHydrated(sf)
    const missing = Array.from({ length: sf.chunks }, (_, i) => i).filter(i => !sf.have.has(i))
    if (missing.length === 0) { this.clearRetry(file_id); return }

    // Poda ANTES de decidir: se todos os seeders conhecidos sumiram, o correto
    // é "sem peers" (estado honesto, acionável), não uma tempestade de timeouts.
    this.pruneSeeders(sf)
    const seeders = [...sf.seeders]
    if (seeders.length === 0) {
      this.lastError = 'sem peers com o arquivo no swarm — aguardando um seeder ficar online'
      this.scheduleRetry(sf)
      return
    }

    // chunks que ainda não esgotaram as tentativas (evita loop infinito em background)
    const eligible = missing.filter((i) => (this.attempts.get(this.key(file_id, i)) ?? 0) < MAX_CHUNK_ATTEMPTS)
    if (eligible.length === 0) {
      this.lastError = 'sem progresso após várias tentativas — todos os chunks deste arquivo esgotaram o retry. Toque em Baixar de novo.'
      // DAVA CONGELADO EM UM PORCENTUAL. Este return era seguido de NENHUM
      // scheduleRetry: quando o ULTIMO chunk faltando esgotava as 8 tentativas,
      // o arquivo ficava parado em 99% para sempre — so saia com um novo gesto
      // do usuario em "Baixar". Agenda de novo com backoff maior para o
      // swarm tentar outra vez sozinho.
      // Backoff ja e' limitado por 2^n (RETRY_MAX_MS). Um teto de ciclos evita
      // que o arquivo fique re-agendando eternamente sem nenhum seeder vivo.
      const ciclos = (this.retryAttempts.get(sf.file_id) ?? 0)
      if (ciclos >= MAX_RETRY_CYCLES) {
        this.lastError = `sem progresso apos ${MAX_RETRY_CYCLES} ciclos de retry — nenhum seeder respondeu. Verifique se quem tem o arquivo esta online, ou pause e retome.`
        return
      }
      this.attempts.clear()
      this.scheduleRetry(sf)
      return
    }

    // concorrência ADAPTATIVA: mais chunks em voo quando há mais seeders
    // (quanto mais peers, mais rápido — igual torrent), com teto e piso.
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

  /** Escolhe um seeder disponível para o chunk, evitando os que falharam nele. */
  private pickPeer(sf: SwarmFile, k: string): string | null {
    const all = [...sf.seeders]
    if (all.length === 0) return null
    const bad = this.badPeers.get(k)
    const good = bad ? all.filter((p) => !bad.has(p)) : all
    const pool = good.length > 0 ? good : all
    // se todos falharam, tenta de novo em ordem rotativa (peers são voláteis)
    if (good.length === 0) this.badPeers.delete(k)
    const cur = this.rr.get(sf.file_id) ?? 0
    this.rr.set(sf.file_id, cur + 1)
    return pool[cur % pool.length]
  }

  /**
   * Remove do swarm quem não se manifesta há `SEEDER_IDLE_MS`.
   *
   * `seeders` só crescia: um peer que fechou o app continuava sendo escolhido,
   * estourava os 5 s de timeout e queimava tentativa de chunk. Como o
   * `downloadManager` nunca via `seeders.size === 0`, o download ficava em 0%
   * para sempre em vez de virar "sem peers" — um estado honesto que o usuário
   * pode resolver (pedir para o outro lado abrir o app / retomar).
   *
   * Chamado antes de cada decisão de "sem seeder" e no tique periódico.
   * Retorna quantos foram podados.
   */
  pruneSeeders(sf: SwarmFile, idleMs = SEEDER_IDLE_MS): number {
    const now = Date.now()
    let removed = 0
    for (const fp of [...sf.seeders]) {
      // O próprio autor do arquivo (owner) não é podado por tempo: ele pode
      // estar apenas sem mandar chunk, e o pedido é justamente para ele.
      if (sf.have.size === sf.chunks) continue
      const seen = sf.lastSeen.get(fp) ?? 0
      if (seen === 0) { sf.lastSeen.set(fp, now); continue }
      if (now - seen > idleMs) { sf.seeders.delete(fp); sf.lastSeen.delete(fp); removed++ }
    }
    if (removed > 0) this.onChange?.()
    return removed
  }

  /** Dispara o pedido de 1 chunk com timeout; libera o slot ao resolver/falhar. */
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

  /** Remove a marca de requisição (pending + peer + timer) de um chunk. */
  private clearChunkReq(k: string) {
    this.pendingReq.delete(k)
    this.reqPeer.delete(k)
    const t = this.chunkTimers.get(k)
    if (t !== undefined) { window.clearTimeout(t); this.chunkTimers.delete(k) }
  }

  /** Falha de um chunk: libera slot, marca peer ruim, incrementa tentativa e re-agenda. */
  private failChunk(sf: SwarmFile, index: number, peer: string, msg: string) {
    const k = this.key(sf.file_id, index)
    if (sf.have.has(index)) return // já temos este chunk (corrida com chegada tardia)
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

  /** Re-kick do arquivo com backoff exponencial (cap em RETRY_MAX_MS). */
  private scheduleRetry(sf: SwarmFile) {
    const id = sf.file_id
    if (this.pausedFiles.has(id)) return // pausado: o resume dá o re-kick
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

  /** Pausa o fetch de um arquivo: cancela timers/retries em andamento e
   *  impede novos pedidos (fetchSwarm vira no-op). Chunks em voo continuam
   *  sendo aceitos — o progresso baixado nunca se perde. */
  pauseFile(file_id: string) {
    this.pausedFiles.add(file_id)
    this.clearRetry(file_id)
    this.clearFileTimers(file_id)
  }

  /** Retoma: limpa a flag de pausa e dá re-kick imediato no swarm. */
  resumeFile(file_id: string) {
    this.pausedFiles.delete(file_id)
    const sf = this.files.get(file_id)
    if (sf && sf.have.size !== sf.chunks) {
      this.resetAttempts(file_id)
      void this.fetchSwarm(sf)
    }
  }

  /** Zera o contador de tentativas (novo gesto do usuário dá nova chance). */
  private resetAttempts(file_id: string) {
    const prefix = `${file_id}:`
    for (const k of [...this.attempts.keys()]) if (k.startsWith(prefix)) this.attempts.delete(k)
  }

  /** Limpa timers e pending de todos os chunks de um arquivo. */
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

  // holder responde a pedido
  onChunkRequest(file_id: string, index: number, from_fp: string) {
    const sf = this.files.get(file_id)
    if (!sf || !sf.have.has(index)) return
    const data = sf.data.get(index)
    if (!data) {
      // Temos no bitfield mas não na RAM (arquivo já salvo, bytes no spool).
      // Recarrega e responde — antes este `return` silencioso fazia o peer
      // parecer online-e-seeder enquanto o pedinte esperava 5 s por chunk.
      void this.ensureDataLoaded(sf)
        .then(() => {
          const d = sf.data.get(index)
          if (d) services.fileSendChunk(from_fp, file_id, index, b64(d)).catch(() => { /* ignore */ })
        })
        .catch(() => { /* ignore */ })
      return
    }
    sf.lastSeen.set(from_fp, Date.now())
    services.fileSendChunk(from_fp, file_id, index, b64(data)).catch(() => { /* ignore */ })
  }

  assembleAndDownload(sf: SwarmFile): Blob {
    if (sf.have.size !== sf.chunks) throw new Error(`arquivo incompleto: ${sf.have.size}/${sf.chunks} chunks`)
    const ordered = Array.from({ length: sf.chunks }, (_, i) => sf.data.get(i))
    if (ordered.some(c => !c)) throw new Error('chunk faltando na montagem')
    const total = ordered.reduce((a, b) => a + (b as Uint8Array).length, 0)
    if (sf.size !== 0 && total !== sf.size) {
      // Antes tolerava até um chunk de diferença — o que deixava passar um
      // arquivo truncado. O tamanho tem que bater EXATO (o último bloco é
      // `size - (chunks-1)*CHUNK`).
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

  /**
   * Blob montado (só leitura, NÃO salva) — null enquanto o arquivo não estiver
   * completo OU os bytes não estiverem acessíveis (nem RAM nem spool).
   * Use `ensureBlobFor` quando puder esperar o spool.
   */
  blobFor(file_id: string): Blob | null {
    const sf = this.files.get(file_id)
    if (!sf || sf.chunks === 0 || sf.have.size !== sf.chunks) return null
    try { return this.assembleAndDownload(sf) } catch { return null }
  }

  /**
   * Igual a `blobFor`, mas reidrata do spool quando o bitfield diz "completo" e
   * a RAM foi liberada (`markDownloaded`). É o que mantém a pré-visualização
   * funcionando depois de salvar o arquivo, sem baixar tudo de novo.
   */
  async ensureBlobFor(file_id: string): Promise<Blob | null> {
    const sf = this.files.get(file_id)
    if (!sf || sf.chunks === 0 || sf.have.size !== sf.chunks) return null
    await this.ensureDataLoaded(sf)
    return this.blobFor(file_id)
  }

  /**
   * Baixa (junta os chunks) SEM salvar em disco — usado para RENDERIZAR prévia
   * de imagem. Diferente de `fetchAndDownload`, não grava em Downloads.
   */
  async fetchOnly(file_id: string, onProgress?: (pct: number) => void, timeoutMs = 60000): Promise<void> {
    const sf = this.files.get(file_id)
    if (!sf) throw new Error('arquivo não encontrado (anúncio ainda não chegou?)')
    this.lastError = null
    // já completo (resume/seeding): nada a baixar, e nunca salva aqui.
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
      if (tick % 6 === 0) await this.fetchSwarm(sf) // re-kick de segurança (~2s)
    }
    onProgress?.(100)
  }

  // Remove arquivo local (cancela download / limpa, inclusive o spool em disco)
  /**
   * Solta SÓ os chunks (RAM + spool em disco), mantendo metadado e registro.
   *
   * `remove()` apaga o arquivo inteiro, mas ele NUNCA era chamado pela UI —
   * então `files` crescia a sessão toda guarda o `Map<data>` completo (200 MB
   * por arquivo) e o `restoreLocalFiles` re-registrava tudo a cada boot. Este
   * caminho é o "depois de salvar/falhar, o arquivo não precisa mais estar na
   * RAM": o metadado continua, então um re-download funciona normal.
   */
  /**
   * Marca o arquivo como JÁ SALVO, sem "desmarcar" o download.
   *
   * `releaseChunks` (usado antes aqui) limpava `have`/`data` e apagava o spool:
   * o card do desktop recalcula `done`/`pct` de `sf.have.size`, então depois de
   * salvar com sucesso ele VOLTAVA para "Baixar (0%)" e um segundo save
   * lançava "ainda faltam N chunks". Além disso o peer continuava anunciado
   * como seeder mas respondia `return` silencioso a todo pedido de chunk.
   *
   * Agora: mantém o bitfield (o arquivo ESTÁ completo e continua sendo servido),
   * solta só os bytes da RAM e PRESERVA o spool em disco. Se precisar dos bytes
   * de novo (servir um peer, montar a prévia), `ensureHydrated` os traz do
   * spool sem rede.
   */
  markDownloaded(file_id: string): void {
    const sf = this.files.get(file_id)
    if (!sf) return
    this.clearRetry(file_id)
    this.clearFileTimers(file_id)
    sf.completed = true
    // RAM liberada; o bitfield fica (progresso 100%, seeding continua válido).
    sf.data.clear()
    // garante que `ensureHydrated` possa repor os bytes a partir do spool
    this.hydratedFiles.delete(file_id)
    this.onChange?.()
  }

  /**
   * Traz do spool em disco os chunks cujo BITFIELD já diz "temos" mas que não
   * estão na RAM (caso do arquivo já salvo: `markDownloaded` solta os bytes).
   *
   * Sem isto, depois de salvar o peer continuava anunciado no swarm mas
   * respondia `return` silencioso a todo `FileChunkRequest` — e quem baixava
   * dele queimava 5 s de timeout por chunk.
   */
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
    // Nada em voo: chunk chegando agora preencheria de novo sem ninguém pedir.
    this.clearRetry(file_id)
    this.clearFileTimers(file_id)
    sf.data.clear()
    sf.have.clear()
    if (services.kind === 'native') {
      for (let i = 0; i < sf.chunks; i++) {
        void services.cacheDelete(spoolKey(file_id, i)).catch(() => { /* best-effort */ })
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
        void services.cacheDelete(spoolKey(file_id, i)).catch(() => { /* best-effort */ })
      }
    }
    this.clearRetry(file_id)
    this.clearFileTimers(file_id)
    // limpa estado de falha dos chunks deste arquivo (evita vazamento de Map)
    const prefix = `${file_id}:`
    for (const k of [...this.attempts.keys()]) if (k.startsWith(prefix)) this.attempts.delete(k)
    for (const k of [...this.badPeers.keys()]) if (k.startsWith(prefix)) this.badPeers.delete(k)
    for (const k of [...this.reqPeer.keys()]) if (k.startsWith(prefix)) this.reqPeer.delete(k)
    this.rr.delete(file_id)
    this.saving.delete(file_id)
    try { localStorage.removeItem(`distorrent:filemeta:${file_id}`) } catch { /* ignore */ }
    this.onChange?.()
  }

  // Clique em Baixar: garante os chunks (reaproveita fetchSwarm) com progresso e salva.
  // Tauri → save_file nativo (retorna o caminho salvo p/ toast "salvo em Downloads: <nome>");
  // browser → download via blob/âncora (ver download()). Se o save falhar, os chunks
  // permanecem em memória — o usuário pode tentar de novo sem rebaixar.
  async fetchAndDownload(file_id: string, onProgress?: (pct: number) => void, timeoutMs = 60000): Promise<string | null> {
    const sf = this.files.get(file_id)
    if (!sf) throw new Error('arquivo não encontrado (anúncio ainda não chegou?)')
    this.lastError = null
    // resume: se já está completo (inclusive semeando), pula direto para o save.
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
        if (tick % 6 === 0) await this.fetchSwarm(sf) // re-kick de segurança (~2s)
      }
    }
    onProgress?.(100)
    return this.download(sf)
  }

  /**
   * Salva o arquivo montado e retorna onde foi parar para a UI exibir
   * `salvo em Downloads: <nome>`.
   * - Tauri (desktop + Android): `save_file` nativo com nome único; no Android
   *   tenta ainda compartilhar via intent (`navigator.share`) se a API permitir.
   * - Browser: anchor blob (exige gesto de click; não funciona no WebView Android).
   * Em falha de save, os chunks NÃO são descartados (progresso preservado).
   */
  async download(sf: SwarmFile): Promise<string | null> {
    if (sf.have.size !== sf.chunks) throw new Error(`ainda faltam ${sf.chunks - sf.have.size} chunks — não dá para salvar`)
    if (this.saving.has(sf.file_id)) throw new Error('salvamento já em andamento para este arquivo')
    // Arquivo já salvo/semeado: os bytes podem estar só no spool em disco.
    // Recarrega antes de montar (sem rede — `ensureDataLoaded` lê o cache).
    await this.ensureDataLoaded(sf)
    const blob = this.assembleAndDownload(sf)
    // nome seguro: basename apenas (evita path traversal no backend)
    const safeName = baseNameOf(sf.name) || 'arquivo'
    this.saving.add(sf.file_id)
    try {
      // Tauri nativo: salva em Downloads via backend (não depende de gesto de download)
      if (isTauri()) {
        try {
          // UM chunk por chamada, e NÃO um lote concatenado.
          //
          // BUG REAL (todo download "concluía" sem arquivo, no Windows e no
          // Android): antes isto juntava 16 chunks com `parts.join('')`. Cada
          // bloco tem 262144 bytes (262144 % 3 == 1), então o base64 de cada um
          // termina em `==`; concatenar põe padding NO MEIO da string e o
          // `save_file_stream` recusava tudo com `InvalidByte(61, offset)`.
          // Um chunk por chamada mantém a string sempre bem formada.
          //
          // Continua com memória limitada: o frontend segura no máximo 1 bloco
          // em base64 (~341 KB) por vez, e o Rust faz append no .part.
          const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          let savedPath = safeName
          for (let i = 0; i < sf.chunks; i++) {
            const c = sf.data.get(i)
            if (!c) throw new Error(`chunk ${i} sumiu antes do salvamento`)
            const ultimo = i === sf.chunks - 1
            savedPath = await tauriInvoke<string>('save_file_stream', {
              jobId, name: safeName, dataB64: b64(c), flush: ultimo, totalBytes: sf.size,
            })
          }
          if (typeof savedPath !== 'string' || !savedPath.trim()) savedPath = safeName
          // Android: o Rust só escreve na área PRIVADA (scoped storage nega
          // /sdcard/Download). O plugin Kotlin copia para o Downloads real.
          if (isAndroid()) {
            try {
              return await saveToPublicDownloads(savedPath, baseNameOf(savedPath) || safeName)
            } catch (e) {
              // Sem o plugin (build antigo, R8, classe fora): o intent ainda
              // entrega o arquivo ao usuário. Falha nos dois = erro honesto,
              // nunca um "salvo" que ninguém acha.
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
          // WebView Android NÃO dispara download por anchor — cair para anchor aqui
          // só silenciaria o erro e o usuário continuaria sem arquivo. Erro honesto
          // com o estágio (resolve_dir/mkdir/write/decode) em vez de fallback mudo.
          if (isAndroid()) {
            const err = new Error(`não foi possível salvar via save_file: ${raw} — os ${sf.chunks} chunks seguem baixados, tente de novo`)
            ;(err as Error & { cause?: unknown }).cause = e
            throw err
          }
          // Desktop: fallback para download anchor abaixo se invoke falhar
          console.warn('[fileSwarm] save_file falhou, caindo para download do navegador:', raw)
        }
      }
      // Navegador: anchor com user gesture (só funciona em click; no WebView
      // Tauri-Android este caminho é inalcançável — ver branch isAndroid acima).
      try {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = safeName
        a.rel = 'noopener'
        a.style.display = 'none'
        document.body.appendChild(a)
        // precisa estar em microtask do click para não ser bloqueado
        a.click()
        setTimeout(() => {
          try { document.body.removeChild(a) } catch { /* ignore */ }
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
