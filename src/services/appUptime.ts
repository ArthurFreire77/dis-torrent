// Regra de SAÍDA do app (pura, sem DOM) — testável em Node.
//
// O dono pediu: nos primeiros minutos de uso, o botão do canto NÃO pode
// encerrar o app de verdade ("Sair do app"), porque fechar logo ao abrir
// derruba a conexão P2P antes de ela estabilizar e o usuário some sem aviso.
// Mandar para segundo plano ("Minimizar — continuar recebendo") continua
// liberado: aí o app segue vivo e recebendo.

/** Tempo mínimo de processo vivo antes de permitir encerrar o app. */
export const QUIT_LOCK_MS = 15 * 60 * 1000

/** Por quanto tempo (a partir do boot) encerrar continua bloqueado. */
export function quitLockRemaining(nowMs: number, startedAtMs: number): number {
  const resta = QUIT_LOCK_MS - (nowMs - startedAtMs)
  return resta > 0 ? resta : 0
}

/** Posso encerrar o app agora? */
export function canQuitNow(nowMs: number, startedAtMs: number): boolean {
  return quitLockRemaining(nowMs, startedAtMs) === 0
}

/** Texto do tempo restante: "12m 34s" / "45s" (nunca inventa). */
export function formatQuitLock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const min = Math.floor(total / 60)
  const sec = total % 60
  if (min <= 0) return `${sec}s`
  return `${min}m ${String(sec).padStart(2, '0')}s`
}

/**
 * Instante em que ESTE processo começou, lido do `sessionStorage`.
 *
 * `sessionStorage` (e não `localStorage`) porque a marca vale por execução:
 * reabrir o app depois de fechar de verdade começa uma janela nova. Se o
 * storage não existir/estiver bloqueado, usa o instante recebido.
 */
export function resolveSessionStart(nowMs: number, storage?: Storage | null): number {
  const s = storage ?? null
  if (!s) return nowMs
  try {
    const raw = s.getItem('distorrent:app:started_at')
    const parsed = raw ? Number(raw) : NaN
    // Marca no FUTURO (relógio mudou) ou inválida: recomeça daqui.
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > nowMs) {
      s.setItem('distorrent:app:started_at', String(nowMs))
      return nowMs
    }
    return parsed
  } catch {
    return nowMs
  }
}
