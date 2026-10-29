import { useState } from 'react'
import {
  applyMountedParticipantPlayback,
  getParticipantPlaybackSettings,
  saveParticipantPlaybackSettings,
} from '../../services/callPlayback'

export function ParticipantAudioControls({
  fp,
  nickname,
  callDeafened,
}: {
  fp: string
  nickname: string
  callDeafened: boolean
}) {
  const [settings, setSettings] = useState(() => getParticipantPlaybackSettings(fp))
  const label = nickname || fp.slice(0, 8)

  function update(patch: { volume?: number; muted?: boolean }) {
    const next = saveParticipantPlaybackSettings(fp, patch)
    setSettings(next)
    applyMountedParticipantPlayback(fp, callDeafened, next)
  }

  return (
    <details style={{ position: 'absolute', top: 8, right: 8, zIndex: 4 }}>
      <summary
        aria-label={`Controles de áudio de ${label}`}
        title={`Áudio local de ${label}`}
        style={{
          listStyle: 'none', cursor: 'pointer', userSelect: 'none',
          border: '1px solid #ffffff55', borderRadius: 6,
          background: '#111c', color: '#fff', padding: '4px 7px', fontSize: 12,
        }}
      >{settings.muted ? '🔇' : '🔊'}</summary>
      <div
        role="group"
        aria-label={`Áudio local de ${label}`}
        style={{
          position: 'absolute', top: 30, right: 0, width: 190,
          padding: 10, borderRadius: 8, background: '#202226',
          border: '1px solid #ffffff44', boxShadow: '0 4px 16px #0009', color: '#fff',
        }}
      >
        <button
          type="button"
          aria-pressed={settings.muted}
          onClick={() => update({ muted: !settings.muted })}
          style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #ffffff33', background: settings.muted ? '#a83238' : '#34373d', color: '#fff', cursor: 'pointer', textAlign: 'left' }}
        >{settings.muted ? 'Ativar áudio para mim' : 'Silenciar para mim'}</button>
        <label style={{ display: 'block', marginTop: 9, fontSize: 11 }}>
          Volume local: {settings.volume}%
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={settings.volume}
            aria-label={`Volume de ${label}`}
            onChange={(event) => update({ volume: Number(event.target.value) })}
            style={{ display: 'block', width: '100%', marginTop: 6, accentColor: '#5865f2' }}
          />
        </label>
      </div>
    </details>
  )
}
