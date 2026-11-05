export const QUIT_LOCK_MS = 15 * 60 * 1000

export function quitLockRemaining(nowMs: number, startedAtMs: number): number {
  const resta = QUIT_LOCK_MS - (nowMs - startedAtMs)
  return resta > 0 ? resta : 0
}

export function canQuitNow(nowMs: number, startedAtMs: number): boolean {
  return quitLockRemaining(nowMs, startedAtMs) === 0
}

export function formatQuitLock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const min = Math.floor(total / 60)
  const sec = total % 60
  if (min <= 0) return `${sec}s`
  return `${min}m ${String(sec).padStart(2, '0')}s`
}

export function resolveSessionStart(nowMs: number, storage?: Storage | null): number {
  const s = storage ?? null
  if (!s) return nowMs
  try {
    const raw = s.getItem('distorrent:app:started_at')
    const parsed = raw ? Number(raw) : NaN
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > nowMs) {
      s.setItem('distorrent:app:started_at', String(nowMs))
      return nowMs
    }
    return parsed
  } catch {
    return nowMs
  }
}
