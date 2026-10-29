import { useEffect, useState } from 'react'
import { Icon, Icons } from '../../shared/icons'
import { setPrefs, usePrefs } from '../../shared/prefs'
import type { PresencaEmSegundoPlano } from '../../shared/prefs'
import { services } from '../../services'
import { notificationPermission, requestNotificationPermission, testNotificationSound } from '../../services/notifications'

/**
 * Notificações DO SISTEMA e segundo plano.
 *
 * Tudo aqui é ligado a algo real:
 *  • "Notificações do sistema" chama `notification_show` (plugin oficial do
 *    Tauri) — no Windows é toast nativo, no Android é NotificationManager.
 *  • "Iniciar com o Windows" grava a chave Run do USUÁRIO via plugin oficial
 *    (nada de script/reg.exe) e só aparece no desktop.
 *  • "Fechar para a bandeja" é lido pelo Rust no evento de fechar a janela.
 *  • O que a plataforma não suporta NÃO aparece (nada de botão morto).
 */
export function SystemNotificationSettings({ T, inputBg, borderColor, text, muted }: {
  T: Record<string, string>
  inputBg: string
  borderColor: string
  text: string
  muted: string
}) {
  const prefs = usePrefs()
  const native = services.kind === 'native'
  const [permission, setPermission] = useState<string>('unknown')
  const [autostart, setAutostart] = useState(false)
  const [tray, setTray] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const isAndroid = (() => {
    try { return /android/i.test(navigator.userAgent ?? '') } catch { return false }
  })()
  const desktop = native && !isAndroid

  useEffect(() => {
    if (!native) return
    void notificationPermission().then(setPermission)
    void services.backgroundPrefs()
      .then((p) => {
        setTray(p.tray)
        setAutostart(p.autostart)
        setPermission(p.notification_permission)
        setPrefs({ autostart: p.autostart })
      })
      .catch(() => { /* shell antigo: seção fica oculta */ })
  }, [native])

  const head: React.CSSProperties = { fontSize: 10, fontWeight: 800, letterSpacing: 1, color: muted, marginBottom: 8, marginTop: 4 }
  const row: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
    background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10,
    padding: '10px 12px', marginBottom: 8, cursor: 'pointer', color: text,
  }

  async function toggleSystem() {
    if (!native) return
    if (prefs.notifySystem) { setPrefs({ notifySystem: false }); return }
    setBusy('system')
    setNote(null)
    try {
      let p = await notificationPermission()
      // Android 13+: a permissão só é pedida de fato quando o usuário pede.
      if (p !== 'granted') p = await requestNotificationPermission()
      setPermission(p)
      if (p === 'granted' || !isAndroid) {
        setPrefs({ notifySystem: true })
      } else {
        setNote('O sistema negou as notificações. Ative em Configurações → Apps → DisTorrent → Notificações.')
      }
    } finally { setBusy(null) }
  }

  async function toggleAutostart() {
    setBusy('autostart')
    setNote(null)
    try {
      const on = await services.autostartSet(!autostart)
      setAutostart(on)
      setPrefs({ autostart: on })
      if (on !== !autostart) setNote('O sistema não permitiu alterar a inicialização automática.')
    } catch (e) {
      setNote(String((e as Error)?.message ?? e))
    } finally { setBusy(null) }
  }

  if (!native) {
    return (
      <div style={{ ...row, cursor: 'default', fontSize: 11, color: muted, lineHeight: 1.5 }}>
        <span style={{ display: 'flex', flexShrink: 0 }}><Icon d={Icons.bell} size={14} /></span>
        No navegador não existem notificações do sistema nem bandeja — só o app instalado (Windows/Android) tem isso.
      </div>
    )
  }

  return (
    <div>
      <div style={head}>AVISOS DO SISTEMA</div>
      <button
        onClick={() => void toggleSystem()}
        aria-pressed={prefs.notifySystem}
        disabled={busy === 'system'}
        style={row}
      >
        <span style={{ display: 'flex', flexShrink: 0, color: prefs.notifySystem ? T.accent : muted }}>
          <Icon d={Icons.bell} size={15} />
        </span>
        <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>
          Notificações do sistema
          <span style={{ display: 'block', fontWeight: 400, fontSize: 11, color: muted, marginTop: 2 }}>
            {permission === 'denied'
              ? 'negadas no sistema — ative em Configurações do aparelho'
              : 'avisos de mensagens e chamadas com o app fora da tela'}
          </span>
        </span>
        <span style={{ fontSize: 11, fontWeight: 800, color: prefs.notifySystem ? T.accent : muted }}>
          {prefs.notifySystem ? 'ON' : 'OFF'}
        </span>
      </button>

      <button
        onClick={() => setPrefs({ notifyPreview: !prefs.notifyPreview })}
        aria-pressed={prefs.notifyPreview}
        style={row}
      >
        <span style={{ display: 'flex', flexShrink: 0, color: muted }}><Icon d={Icons.eye} size={15} /></span>
        <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>
          Mostrar prévia do texto
          <span style={{ display: 'block', fontWeight: 400, fontSize: 11, color: muted, marginTop: 2 }}>
            desligado = o aviso diz só “Nova mensagem”
          </span>
        </span>
        <span style={{ fontSize: 11, fontWeight: 800, color: prefs.notifyPreview ? T.accent : muted }}>
          {prefs.notifyPreview ? 'ON' : 'OFF'}
        </span>
      </button>

      <button onClick={() => setPrefs({ notifySounds: !prefs.notifySounds })} aria-pressed={prefs.notifySounds} style={row}>
        <span style={{ display: 'flex', flexShrink: 0, color: muted }}><Icon d={Icons.bell} size={15} /></span>
        <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>
          Som de mensagem
          <span style={{ display: 'block', fontWeight: 400, fontSize: 11, color: muted, marginTop: 2 }}>
            respeita o silencioso do aparelho
          </span>
        </span>
        <span style={{ fontSize: 11, fontWeight: 800, color: prefs.notifySounds ? T.accent : muted }}>
          {prefs.notifySounds ? 'ON' : 'OFF'}
        </span>
      </button>

      <button onClick={() => setPrefs({ notifyCallSounds: !prefs.notifyCallSounds })} aria-pressed={prefs.notifyCallSounds} style={row}>
        <span style={{ display: 'flex', flexShrink: 0, color: muted }}><Icon d={Icons.bell} size={15} /></span>
        <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>Som de chamada</span>
        <span style={{ fontSize: 11, fontWeight: 800, color: prefs.notifyCallSounds ? T.accent : muted }}>
          {prefs.notifyCallSounds ? 'ON' : 'OFF'}
        </span>
      </button>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => testNotificationSound()}
          style={{ flex: 1, background: 'transparent', border: `1px solid ${borderColor}`, color: muted, borderRadius: 8, padding: '8px 10px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}
        >
          Testar aviso
        </button>
      </div>

      <div style={head}>SEGUNDO PLANO</div>
      <label htmlFor="presence-bg" style={{ display: 'block', fontSize: 11, fontWeight: 700, color: muted, marginBottom: 6 }}>
        MINHA PRESENÇA COM A JANELA FECHADA
      </label>
      <select
        id="presence-bg"
        value={prefs.presenceInBackground}
        onChange={(e) => setPrefs({ presenceInBackground: e.target.value as PresencaEmSegundoPlano })}
        style={{ width: '100%', background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '10px 12px', color: text, fontSize: 12, marginBottom: 8 }}
      >
        <option value="away">Ausente — conexão continua, mas não pareço online</option>
        <option value="online">Online — continuo online mesmo minimizado</option>
      </select>
      <div style={{ fontSize: 11, color: muted, marginBottom: 12, lineHeight: 1.5 }}>
        A conexão P2P continua ativa nos dois casos; o que muda é o que os contatos veem.
      </div>

      {desktop && (
        <>
          <button onClick={() => { const v = !prefs.closeToTray; setPrefs({ closeToTray: v }); void services.backgroundPrefsSet({ closeToTray: v }).catch(() => {}) }} aria-pressed={prefs.closeToTray} style={row}>
            <span style={{ display: 'flex', flexShrink: 0, color: muted }}><Icon d={Icons.chevronRight} size={15} /></span>
            <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>
              Fechar a janela vai para a bandeja
              <span style={{ display: 'block', fontWeight: 400, fontSize: 11, color: muted, marginTop: 2 }}>
                {tray ? 'o app continua recebendo mensagens e chamadas' : 'bandeja indisponível neste sistema'}
              </span>
            </span>
            <span style={{ fontSize: 11, fontWeight: 800, color: prefs.closeToTray ? T.accent : muted }}>
              {prefs.closeToTray ? 'ON' : 'OFF'}
            </span>
          </button>

          <button onClick={() => { const v = !prefs.startMinimized; setPrefs({ startMinimized: v }); void services.backgroundPrefsSet({ startMinimized: v }).catch(() => {}) }} aria-pressed={prefs.startMinimized} style={row}>
            <span style={{ display: 'flex', flexShrink: 0, color: muted }}><Icon d={Icons.chevronRight} size={15} /></span>
            <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>Iniciar minimizado na bandeja</span>
            <span style={{ fontSize: 11, fontWeight: 800, color: prefs.startMinimized ? T.accent : muted }}>
              {prefs.startMinimized ? 'ON' : 'OFF'}
            </span>
          </button>

          <button onClick={() => void toggleAutostart()} aria-pressed={autostart} disabled={busy === 'autostart'} style={row}>
            <span style={{ display: 'flex', flexShrink: 0, color: muted }}><Icon d={Icons.chevronRight} size={15} /></span>
            <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>
              Iniciar automaticamente com o Windows
              <span style={{ display: 'block', fontWeight: 400, fontSize: 11, color: muted, marginTop: 2 }}>
                {autostart ? 'registrado no login do usuário (sem administrador)' : 'não inicia sozinho'}
              </span>
            </span>
            <span style={{ fontSize: 11, fontWeight: 800, color: autostart ? T.accent : muted }}>
              {autostart ? 'ON' : 'OFF'}
            </span>
          </button>

          <button
            onClick={() => { void services.appQuit() }}
            style={{ ...row, borderColor: T.red, color: '#ff9c9c' }}
          >
            <span style={{ display: 'flex', flexShrink: 0 }}><Icon d={Icons.x} size={15} /></span>
            <span style={{ flex: 1, fontSize: 12, fontWeight: 800 }}>Sair do DisTorrent</span>
            <span style={{ fontSize: 10, color: muted }}>encerra a conexão</span>
          </button>
        </>
      )}

      {isAndroid && (
        <div style={{ ...row, cursor: 'default', fontSize: 11, color: muted, lineHeight: 1.5 }}>
          <span style={{ display: 'flex', flexShrink: 0 }}><Icon d={Icons.lock} size={14} /></span>
          <span>
            O Android pode encerrar o app em segundo plano (economia de bateria do fabricante). Avisos chegam
            enquanto o processo estiver vivo; em chamada, o serviço em primeiro plano mantém o microfone ativo.
          </span>
        </div>
      )}

      {note && <div role="status" style={{ fontSize: 11, color: T.yellow, lineHeight: 1.5, marginTop: 4 }}>{note}</div>}
    </div>
  )
}
