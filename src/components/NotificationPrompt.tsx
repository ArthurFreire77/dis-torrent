import { useEffect, useState } from 'react'
import { getPrefs, setPrefs } from '../shared/prefs'
import { services } from '../services'
import { notificationPermission, requestNotificationPermission } from '../services/notifications'

/**
 * Pergunta contextual, UMA vez, depois de ~1 minuto de uso.
 *
 * Por que 1 minuto: pedir notificação na primeira tela é o padrão que treina o
 * usuário a negar no susto. Depois de um minuto ele já viu o app funcionando e
 * entende o que ganha.
 *
 * Por que nunca repete: a resposta fica em `prefs.notifPromptDone`. Quem quiser
 * mudar depois usa Configurações → Notificações (lá está o botão real).
 *
 * No Android 13+ o texto é o pedido de permissão; no desktop (onde o SO não
 * pede permissão) a pergunta é sobre continuar recebendo com a janela fechada.
 */
export function NotificationPrompt() {
  const [open, setOpen] = useState(false)
  const [needsPermission, setNeedsPermission] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (services.kind !== 'native') return
    if (getPrefs().notifPromptDone) return
    let alive = true
    const timer = setTimeout(() => {
      void (async () => {
        const p = await notificationPermission()
        if (!alive) return
        // Já concedida e ligada = nada a perguntar.
        if (p === 'granted' && getPrefs().notifySystem) return
        setNeedsPermission(p !== 'granted')
        setOpen(true)
      })()
    }, 60_000)
    return () => { alive = false; clearTimeout(timer) }
  }, [])

  if (!open) return null

  const close = () => {
    setPrefs({ notifPromptDone: true })
    setOpen(false)
  }

  async function activate() {
    setBusy(true)
    try {
      if (needsPermission) {
        const p = await requestNotificationPermission()
        if (p !== 'granted') {
          // Negou no diálogo do sistema: respeitamos e não insistimos.
          close()
          return
        }
      }
      setPrefs({ notifySystem: true })
      close()
    } finally { setBusy(false) }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="notif-prompt-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div style={{
        width: '100%', maxWidth: 380, background: '#1c1f24', color: '#e8eaed',
        border: '1px solid #33383f', borderRadius: 16, padding: 20,
        boxShadow: '0 24px 64px rgba(0,0,0,.5)',
      }}>
        <h2 id="notif-prompt-title" style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 800 }}>
          Ativar notificações?
        </h2>
        <p style={{ margin: '0 0 16px', fontSize: 13, lineHeight: 1.55, color: '#a9b0ba' }}>
          Receba avisos de novas mensagens e chamadas mesmo quando o DisTorrent não estiver aberto.
          {!needsPermission && ' O app continua na bandeja do sistema; você sai quando quiser.'}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => { setPrefs({ notifPromptDone: true }); setOpen(false) }}
            style={{
              flex: 1, background: 'transparent', color: '#a9b0ba', border: '1px solid #33383f',
              borderRadius: 10, padding: '11px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
            }}
          >
            Agora não
          </button>
          <button
            onClick={() => void activate()}
            disabled={busy}
            style={{
              flex: 1, background: '#5865f2', color: '#fff', border: 'none',
              borderRadius: 10, padding: '11px 12px', fontSize: 13, fontWeight: 800,
              cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1,
            }}
          >
            Ativar notificações
          </button>
        </div>
      </div>
    </div>
  )
}
