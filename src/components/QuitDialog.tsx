// Fechar o DisTorrent: segundo plano (continua recebendo chamadas) ou sair.
//
// O botão inferior esquerdo fazia LOGOUT (`setPhase('lock')`), o que derrubava a
// sessão por engano — o dono pediu que ele feche o programa mantendo a conta.
// Ficar em segundo plano é o padrão útil: o motor segue conectado na bandeja
// (no Android, o serviço de primeiro plano continua), então chamada e mensagem
// ainda chegam.
import { Button } from '../shared/ui'

export interface QuitDialogProps {
  /** Continua rodando na bandeja/serviço. */
  onBackground: () => Promise<void>
  /** Encerra o processo de verdade. */
  onQuit: () => Promise<void>
  onClose: () => void
  /** No navegador não há processo para encerrar. */
  canQuit: boolean
}

export function QuitDialog({ onBackground, onQuit, onClose, canQuit }: QuitDialogProps) {
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        role="dialog"
        aria-label="Fechar o DisTorrent"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 420, background: '#2b2d31', border: '1px solid #26272b', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <div style={{ fontSize: 16, fontWeight: 800, color: '#fff' }}>Fechar o DisTorrent</div>
        <div style={{ fontSize: 12.5, color: '#949ba4', lineHeight: 1.6 }}>
          Você continua conectado? Sim: na bandeja, o app segue recebendo chamadas e
          mensagens sem ficar na tela. Sua conta permanece aberta nos dois casos.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          <Button variant="primary" onClick={() => { void onBackground().finally(onClose) }}>
            Continuar em segundo plano
          </Button>
          {canQuit && (
            <Button variant="danger" onClick={() => { void onQuit() }}>
              Sair do app
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        </div>
      </div>
    </div>
  )
}

export default QuitDialog
