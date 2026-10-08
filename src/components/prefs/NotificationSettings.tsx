import { useState } from 'react'
import { Icon, Icons } from '../../shared/icons'
import {
  levelFor, setLevel, setPrefs, toggleMuteChannel, toggleMuteServer, usePrefs,
  type NotifLevel,
} from '../../shared/prefs'

const LEVELS: { id: NotifLevel; label: string; desc: string }[] = [
  { id: 'all', label: 'Todas', desc: 'tudo que chega' },
  { id: 'mentions', label: 'Menções', desc: 'só quando te marcam' },
  { id: 'none', label: 'Nada', desc: 'silencia tudo' },
]

export function NotificationSettings({ servers, channelsOf, T, inputBg, borderColor, text, muted }: {
  servers: { id: string; name: string }[]
  channelsOf: (serverId: string) => { id: string; name: string }[]
  T: Record<string, string>
  inputBg: string
  borderColor: string
  text: string
  muted: string
}) {
  const prefs = usePrefs()
  const [open, setOpen] = useState<string | null>(null)
  const head: React.CSSProperties = { fontSize: 10, fontWeight: 800, letterSpacing: 1, color: muted, marginBottom: 8 }
  const row: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
    background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10,
    padding: '10px 12px', marginBottom: 8, cursor: 'pointer', color: text,
  }
  return (
    <div>
      <div style={head}>PADRÃO PARA NOVOS CANAIS</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {LEVELS.map(l => (
          <button
            key={l.id}
            onClick={() => usePrefsSetDefault(l.id)}
            aria-pressed={prefs.notifDefault === l.id}
            title={l.desc}
            style={{
              flex: 1, background: prefs.notifDefault === l.id ? `${T.accent}22` : inputBg,
              border: `1px solid ${prefs.notifDefault === l.id ? T.accent : borderColor}`,
              borderRadius: 8, padding: '8px 4px', cursor: 'pointer', color: text,
            }}
          >
            <span style={{ display: 'block', fontSize: 12, fontWeight: 800 }}>{l.label}</span>
            <span style={{ display: 'block', fontSize: 10, color: muted, marginTop: 2 }}>{l.desc}</span>
          </button>
        ))}
      </div>
      <div style={head}>SERVIDORES · {servers.length}</div>
      {servers.length === 0 && <div style={{ fontSize: 12, color: muted, marginBottom: 16 }}>Nenhum servidor ainda.</div>}
      {servers.map(s => {
        const isMuted = prefs.mutedServers.includes(s.id)
        const chans = channelsOf(s.id)
        const expanded = open === s.id
        return (
          <div key={s.id} style={{ marginBottom: 8, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px' }}>
              <button onClick={() => setOpen(expanded ? null : s.id)} aria-expanded={expanded} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', cursor: 'pointer', color: text, textAlign: 'left', padding: 0 }}>
                <span style={{ color: muted, display: 'flex', transform: expanded ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }}>
                  <Icon d={Icons.chevronRight} size={14} />
                </span>
                <span style={{ fontSize: 13, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                <span style={{ fontSize: 10, color: muted }}>{chans.length} canais</span>
              </button>
              <button
                onClick={() => toggleMuteServer(s.id)}
                aria-pressed={isMuted}
                title={isMuted ? 'Ativar notificações' : 'Silenciar servidor'}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, background: isMuted ? `${T.red}22` : 'transparent',
                  border: `1px solid ${isMuted ? T.red : borderColor}`, borderRadius: 8, padding: '6px 10px',
                  cursor: 'pointer', color: isMuted ? '#ff9c9c' : muted, fontSize: 11, fontWeight: 800,
                }}
              >
                <Icon d={isMuted ? Icons.eyeOff : Icons.bell} size={13} />{isMuted ? 'Silenciado' : 'Silenciar'}
              </button>
            </div>
            {expanded && (
              <div style={{ borderTop: `1px solid ${borderColor}`, padding: '8px 12px 10px' }}>
                {chans.map(c => {
                  const lv = levelFor(c.id, s.id)
                  const chMuted = prefs.mutedChannels.includes(c.id)
                  return (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: `1px solid ${borderColor}` }}>
                      <span style={{ color: muted, display: 'flex' }}><Icon d={Icons.hash} size={13} /></span>
                      <span style={{ flex: 1, fontSize: 12, color: text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                      <select
                        value={lv}
                        onChange={e => setLevel(c.id, e.target.value as NotifLevel)}
                        aria-label={`Notificações de ${c.name}`}
                        style={{ background: T.input ?? inputBg, border: `1px solid ${borderColor}`, borderRadius: 6, color: text, fontSize: 11, padding: '5px 6px' }}
                      >
                        {LEVELS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
                      </select>
                      <button
                        onClick={() => toggleMuteChannel(c.id)}
                        aria-pressed={chMuted}
                        title={chMuted ? 'Ativar' : 'Silenciar canal'}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: chMuted ? '#ff9c9c' : muted, display: 'flex', padding: 4 }}
                      >
                        <Icon d={chMuted ? Icons.eyeOff : Icons.bell} size={14} />
                      </button>
                    </div>
                  )
                })}
                {chans.length === 0 && <div style={{ fontSize: 11, color: muted, padding: '4px 0' }}>Sem canais.</div>}
              </div>
            )}
          </div>
        )
      })}
      <div style={{ ...row, cursor: 'default', fontSize: 11, color: muted, lineHeight: 1.5 }}>
        <span style={{ display: 'flex', flexShrink: 0 }}><Icon d={Icons.lock} size={14} /></span>
        Silenciar é local: só vale neste aparelho, nada vai para a rede.
      </div>
    </div>
  )
}

function usePrefsSetDefault(level: NotifLevel) {
  setPrefs({ notifDefault: level })
}
