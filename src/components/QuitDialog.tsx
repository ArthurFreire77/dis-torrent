import { useEffect, useState } from 'react'
import { Button } from '../shared/ui'
import { QUIT_LOCK_MS, canQuitNow, formatQuitLock, quitLockRemaining } from '../services/appUptime'

export interface QuitDialogProps {
  onQuit: () => Promise<void>
  onMinimize: () => Promise<void>
  onClose: () => void
  canQuit: boolean
  startedAtMs?: number
}

export function QuitDialog({ onQuit, onMinimize, onClose, canQuit, startedAtMs }: QuitDialogProps) {
  const inicio = startedAtMs ?? Date.now()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (canQuitNow(Date.now(), inicio)) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [inicio])

  const restante = quitLockRemaining(now, inicio)
  const bloqueado = restante > 0

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        role="dialog"
        aria-label="Sair do DisTorrent"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 420, background: '#2b2d31', border: '1px solid #26272b', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <div style={{ fontSize: 16, fontWeight: 800, color: '#fff' }}>Sair do DisTorrent</div>
        <div style={{ fontSize: 12.5, color: '#949ba4', lineHeight: 1.6 }}>
          Sair encerra o app por completo, inclusive o que está rodando em segundo
          plano: você para de receber chamadas e mensagens até abrir de novo.
          Sua conta continua salva.
        </div>
        {bloqueado && (
          <div
            role="status"
            style={{ fontSize: 12, color: '#f0b232', background: '#2b2416', border: '1px solid #f0b23255', borderRadius: 8, padding: '8px 10px', lineHeight: 1.5 }}
          >
            Encerrar fica liberado depois dos primeiros {Math.round(QUIT_LOCK_MS / 60000)} minutos —
            faltam <b>{formatQuitLock(restante)}</b>. Use <b>Minimizar</b> para continuar
            recebendo chamadas e mensagens.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          {canQuit ? (
            <Button variant="danger" disabled={bloqueado} onClick={() => { if (!bloqueado) void onQuit() }}>
              {bloqueado ? `Sair do app (em ${formatQuitLock(restante)})` : 'Sair do app'}
            </Button>
          ) : (
            <div style={{ fontSize: 12, color: '#f0b232' }}>
              Fechar o processo só funciona no app instalado.
            </div>
          )}
          <Button variant="secondary" onClick={() => { void onMinimize().finally(onClose) }}>
            Minimizar (continuar recebendo)
          </Button>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        </div>
      </div>
    </div>
  )
}

export default QuitDialog
