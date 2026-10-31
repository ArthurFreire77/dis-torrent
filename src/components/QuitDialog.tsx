// Fechar o DisTorrent.
//
// O botão inferior esquerdo fazia LOGOUT (`setPhase('lock')`), derrubando a
// sessão por engano. O dono pediu que ele SAIA do app de verdade — inclusive
// quando o app está em segundo plano (bandeja/serviço), que continuaria vivo
// sem isso. "Sair da conta" fica no perfil, onde é o lugar certo.
import { Button } from '../shared/ui'

export interface QuitDialogProps {
  /** Encerra o processo (bandeja, foreground service, motor). */
  onQuit: () => Promise<void>
  /** Minimiza sem encerrar (opcional). */
  onMinimize: () => Promise<void>
  onClose: () => void
  /** No navegador não há processo para encerrar. */
  canQuit: boolean
}

export function QuitDialog({ onQuit, onMinimize, onClose, canQuit }: QuitDialogProps) {
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          {canQuit ? (
            <Button variant="danger" onClick={() => { void onQuit() }}>
              Sair do app
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
