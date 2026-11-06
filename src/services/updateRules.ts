export { formatBytes } from '../shared/bytes.ts'

export interface UpdateInfo {
  current: string
  latest: string
  asset_name: string
  asset_size: number
  download_url: string
  digest: string
  notes: string
  html_url: string
  platform: string
  label_mismatch?: boolean
  asset_version?: string
  /** Procedência comprovada por 2-de-3 no Rust (nunca pela UI). */
  verified?: boolean
  manifest_hash?: string
  security_epoch?: number
  valid_signatures?: number
  trust_epoch?: number
  commit?: string
  channel?: string
  self_integrity?: 'CONFERE' | 'DIVERGE' | 'UNAVAILABLE'
  verification_available?: boolean
  verification_note?: string
}

export interface ParsedVersion {
  nums: number[]
  pre: string
  preTokens: string[]
}

export function parseVersion(raw: string): ParsedVersion {
  const s = String(raw ?? '').trim().replace(/^v/i, '')
  const [core, ...rest] = s.split('-')
  const nums = (core ?? '')
    .split('.')
    .map((p) => {
      const m = /^\d+/.exec(p.trim())
      return m ? Number(m[0]) : 0
    })
  if (nums.length === 0) nums.push(0)
  const pre = rest.join('-').toLowerCase()
  return { nums, pre, preTokens: pre ? pre.split(/[-.]/).filter(Boolean) : [] }
}

const PRE_RANK: Record<string, number> = {
  pre: 0,
  alpha: 1,
  a: 1,
  beta: 2,
  b: 2,
  rc: 3,
  preview: 3,
}

function rankOf(tokens: string[]): number {
  for (const t of tokens) {
    const r = PRE_RANK[t]
    if (r !== undefined) return r
  }
  return 2
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i++) {
    const na = pa.nums[i] ?? 0
    const nb = pb.nums[i] ?? 0
    if (na !== nb) return na > nb ? 1 : -1
  }
  if (!pa.pre || !pb.pre) return 0
  if (pa.pre === pb.pre) return 0
  const ra = rankOf(pa.preTokens)
  const rb = rankOf(pb.preTokens)
  if (ra !== rb) return ra > rb ? 1 : -1
  const na = pa.preTokens.filter((t) => /^\d+$/.test(t)).map(Number)
  const nb = pb.preTokens.filter((t) => /^\d+$/.test(t)).map(Number)
  const n = Math.max(na.length, nb.length)
  for (let i = 0; i < n; i++) {
    const x = na[i] ?? 0
    const y = nb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

export function isNewer(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0
}

/**
 * Só exibe "atualização verificada" quando o Rust comprovou 2-de-3. Esta
 * função é pura de propósito: a UI formata, ela não decide.
 */
export function procedenciaResumo(info: {
  verified?: boolean
  valid_signatures?: number
  security_epoch?: number
}): string {
  if (!info.verified) return 'procedência NÃO comprovada'
  const s = info.valid_signatures ?? 0
  const e = info.security_epoch ?? 0
  return `${s} assinaturas válidas · época ${e}`
}

export function shortNotes(notes: string, maxLines = 6): string {
  const lines = String(notes ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
  return lines.slice(0, maxLines).join('\n')
}

export type UpdateMode = 'auto' | 'manual' | 'link'

export function updateModeFor(platform: string, assetName = ''): UpdateMode {
  if (platform === 'windows') return 'auto'
  if (platform === 'linux') {
    return /\.appimage$/i.test(assetName) ? 'auto' : 'manual'
  }
  if (platform === 'android') return 'manual'
  return 'link'
}

export type UpdateOutcome =
  | { kind: 'none' }
  | { kind: 'later'; info: UpdateInfo }
  | { kind: 'stalled'; info: UpdateInfo }
  | { kind: 'applied'; info: UpdateInfo; path: string }
  | { kind: 'error'; message: string }

export interface UpdateDeps {
  check: () => Promise<UpdateInfo>
  download: (info: UpdateInfo) => Promise<string>
  apply: (path: string) => Promise<void>
  quit: () => Promise<void>
  getFlag: (key: string) => Promise<string | null>
  setFlag: (key: string, value: string) => Promise<void>
}

export const FLAG_SKIP = 'update.skip'
export const FLAG_FAILED = 'update.failed'
export const FLAG_APPLIED = 'update.applied'
export const FAILED_TTL_MS = 6 * 60 * 60 * 1000

export function falhaExpirada(marca: string | null, nowMs = Date.now()): boolean {
  if (!marca) return true
  const i = marca.lastIndexOf('|')
  if (i < 0) return true
  const ts = Number(marca.slice(i + 1))
  if (!Number.isFinite(ts) || ts <= 0) return true
  return nowMs - ts >= FAILED_TTL_MS
}
export const REINICIAR_SINAL = 'ATUALIZADO_E_REINICIADO'

export async function runUpdateFlow(
  deps: UpdateDeps,
  opts: { autoApply: boolean },
): Promise<UpdateOutcome> {
  let info: UpdateInfo
  try {
    info = await deps.check()
  } catch (e) {
    return { kind: 'error', message: String((e as Error)?.message ?? e) }
  }

  if (!isNewer(info.current, info.latest)) return { kind: 'none' }
  if ((await deps.getFlag(FLAG_SKIP)) === info.latest) return { kind: 'none' }

  const mode = updateModeFor(info.platform, info.asset_name)
  if (mode === 'link') return { kind: 'later', info }

  const appliedFlag = await deps.getFlag(FLAG_APPLIED)
  const alreadyApplied = !!appliedFlag && appliedFlag === info.latest
  if (alreadyApplied) {
    if (compareVersions(info.current, appliedFlag) >= 0) {
      await deps.setFlag(FLAG_APPLIED, '').catch(() => {})
    } else {
      return { kind: 'stalled', info }
    }
  }
  if (appliedFlag && appliedFlag !== info.latest && compareVersions(info.current, appliedFlag) >= 0) {
    await deps.setFlag(FLAG_APPLIED, '').catch(() => {})
  }

  const failedFlag = (await deps.getFlag(FLAG_FAILED)) ?? ''
  const failedBefore = !!failedFlag && (failedFlag === info.latest || failedFlag.startsWith(`${info.latest}|`))
  if (failedBefore && !falhaExpirada(failedFlag)) return { kind: 'later', info }
  if (!opts.autoApply) return { kind: 'later', info }

  let path: string
  try {
    path = await deps.download(info)
  } catch (e) {
    return { kind: 'error', message: String((e as Error)?.message ?? e) }
  }

  await deps.setFlag(FLAG_APPLIED, info.latest).catch(() => {})

  try {
    await deps.apply(path)
  } catch (e) {
    // Seção 1: msg
    const msg = String((e as Error)?.message ?? e)
    if (msg.includes(REINICIAR_SINAL)) {
      await deps.quit().catch(() => {})
      return { kind: 'applied', info, path }
    }
    await deps.setFlag(FLAG_APPLIED, '').catch(() => {})
    await deps.setFlag(FLAG_FAILED, `${info.latest}|${Date.now()}`).catch(() => {})
    return { kind: 'error', message: msg }
  }

  return { kind: 'applied', info, path }
}
