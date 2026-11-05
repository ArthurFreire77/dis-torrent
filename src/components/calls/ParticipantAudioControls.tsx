import { useEffect, useState } from 'react'
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
  const [aberto, setAberto] = useState(false)
  const label = nickname || fp.slice(0, 8)

  useEffect(() => {
    setSettings(getParticipantPlaybackSettings(fp))
  }, [fp])

  function update(patch: { volume?: number; muted?: boolean }) {
    const next = saveParticipantPlaybackSettings(fp, patch)
    setSettings(next)
    applyMountedParticipantPlayback(fp, callDeafened, next)
  }

  const silenciado = settings.muted || callDeafened

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ position: 'absolute', top: 8, right: 8, zIndex: 6 }}
    >
      <button
        type="button"
        aria-label={`Controles de áudio de ${label}`}
        aria-expanded={aberto}
        title={`Áudio local de ${label}`}
        onClick={() => setAberto((v) => !v)}
        style={{
          cursor: 'pointer', userSelect: 'none',
          border: `1px solid ${aberto ? '#ffffffaa' : '#ffffff55'}`, borderRadius: 6,
          background: aberto ? '#000000cc' : '#111c',
          color: silenciado ? '#ff9c9c' : '#fff',
          padding: '4px 7px', fontSize: 12,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {silenciado
            ? <><path d="M11 5L6 9H2v6h4l5 4z" /><path d="M23 9l-6 6M17 9l6 6" /></>
            : <><path d="M11 5L6 9H2v6h4l5 4z" /><path d="M15.54 8.46a5 5 0 0 1 0 7.08" /></>}
        </svg>
      </button>

      {aberto && (
        <div
          role="group"
          aria-label={`Áudio local de ${label}`}
          style={{
            position: 'absolute', top: 30, right: 0, width: 200,
            padding: 10, borderRadius: 8, background: '#202226',
            border: '1px solid #ffffff44', boxShadow: '0 4px 16px #0009', color: '#fff',
          }}
        >
          <button
            type="button"
            aria-pressed={settings.muted}
            onClick={() => update({ muted: !settings.muted })}
            style={{
              width: '100%', padding: '6px 8px', borderRadius: 6,
              border: '1px solid #ffffff33',
              background: settings.muted ? '#a83238' : '#34373d',
              color: '#fff', cursor: 'pointer', textAlign: 'left', fontSize: 11.5,
            }}
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

          {callDeafened && (
            <div style={{ fontSize: 10.5, color: '#ff9c9c', marginTop: 6, lineHeight: 1.4 }}>
              Você está ensurdecido — o áudio está mudo até desativar.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
