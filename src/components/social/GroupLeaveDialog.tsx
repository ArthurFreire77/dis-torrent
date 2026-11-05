import { useState } from 'react'
import { Button } from '../../shared/ui'

export interface GroupLeaveDialogProps {
  title: string
  isOwner: boolean
  onClose: () => void
  onLeave: () => Promise<void>
  onDeleteAll: () => Promise<void>
  onDeleteLocal: () => Promise<void>
}

export function GroupLeaveDialog({
  title,
  isOwner,
  onClose,
  onLeave,
  onDeleteAll,
  onDeleteLocal,
}: GroupLeaveDialogProps) {
  const [erro, setErro] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)

  async function run(fn: () => Promise<void>) {
    setErro(null)
    setOcupado(true)
    try {
      await fn()
      onClose()
    } catch (e) {
      setErro(String((e as Error)?.message ?? e))
    } finally {
      setOcupado(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        role="dialog"
        aria-label={isOwner ? 'Apagar grupo' : 'Sair do grupo'}
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 420, background: '#2b2d31', border: '1px solid #26272b', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <div style={{ fontSize: 16, fontWeight: 800, color: '#fff' }}>
          {isOwner ? `Apagar "${title}"?` : `Sair de "${title}"?`}
        </div>
        <div style={{ fontSize: 12.5, color: '#949ba4', lineHeight: 1.6 }}>
          {isOwner
            ? 'Você criou este grupo. Escolha se ele some para todos os membros ou só desta máquina.'
            : 'Você deixa de ver as mensagens deste grupo. Os outros membros continuam nele.'}
        </div>
        {erro && <div style={{ fontSize: 12, color: '#ff9c9c' }}>{erro}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          {isOwner ? (
            <>
              <Button variant="danger" busy={ocupado} onClick={() => void run(onDeleteAll)}>
                Apagar para todos
              </Button>
              <Button busy={ocupado} onClick={() => void run(onDeleteLocal)}>
                Apagar só para mim
              </Button>
            </>
          ) : (
            <Button variant="danger" busy={ocupado} onClick={() => void run(onLeave)}>
              Sair do grupo
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </div>
    </div>
  )
}

export default GroupLeaveDialog
