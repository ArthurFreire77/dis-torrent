import { useState } from 'react'
import type { NetworkState } from '../services/models'
import { avatarColor } from './theme'
import { effectClass, effectStyle } from './profileStyle'

export function Avatar({ name, fp, size = 40, avatarB64, accent, ring, effect, emoji }: {
  name: string
  fp: string
  size?: number
  avatarB64?: string
  accent?: string
  ring?: string
  /** Aura do perfil (`glow`, `pulse`, `rainbow`, `sparkle`). */
  effect?: string
  /** Emoji no lugar da inicial (avatar de bot, ex.: `🎵`). */
  emoji?: string
}) {
  const [err, setErr] = useState(false)
  const border = accent ? `2px solid ${accent}` : ring ? `2px solid ${ring}` : undefined
  const aura = effectClass(effect)
  const inner = avatarB64 && !err
    ? (
      <img src={`data:image/jpeg;base64,${avatarB64}`} onError={() => setErr(true)} alt={name}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border }} />
    )
    : (() => {
      const initial = emoji || (name || fp || '?').trim().charAt(0).toUpperCase() || '?'
      return (
        <span style={{
          width: size, height: size, borderRadius: '50%', background: accent || avatarColor(fp),
          color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 800, fontSize: emoji ? size * 0.52 : size * 0.42, flexShrink: 0, overflow: 'hidden',
          border, boxShadow: accent && !ring ? `0 0 0 2px ${accent}55` : undefined,
        }}>{initial}</span>
      )
    })()

  if (!aura) return inner
  return (
    <span
      className={`${aura} pfx-wrap`}
      data-pfx={effect ?? ''}
      style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, ...effectStyle(effect, accent ?? '') }}
    >
      {inner}
    </span>
  )
}

export const stateColor: Record<NetworkState, string> = {
  CONNECTED: '#23a559',
  CONNECTING: '#f0b232',
  RECONNECTING: '#f0b232',
  DISCONNECTED: '#80848e',
}

export function PeerDot({ s, ring }: { s: NetworkState; ring?: string }) {
  return (
    <span style={{
      position: 'absolute', right: -2, bottom: -2, width: 12, height: 12,
      background: stateColor[s], border: `3px solid ${ring ?? 'var(--sidebar)'}`, borderRadius: '50%',
    }} />
  )
}
