import { useEffect, useState } from 'react'
import { Ic } from '../../shared/icons'
import { services } from '../../services'
import { filterLiveVoiceRows, type VoiceRow } from '../../services/voicePresence'

export interface VoicePeerRow {
  fp: string
  muted: boolean
  deafened: boolean
}

export function useChannelVoicePeers(
  communityId: string,
  channelId: string,
  enabled = true,
  myFp = '',
): VoicePeerRow[] {
  const [rows, setRows] = useState<VoicePeerRow[]>([])
  const [online, setOnline] = useState<Set<string> | null>(null)

  useEffect(() => {
    let alive = true
    const lerOnline = () => {
      services.peersList()
        .then((ps) => {
          if (!alive) return
          const vivos = new Set<string>()
          for (const p of ps ?? []) if (p?.fp && p.state === 'CONNECTED') vivos.add(p.fp)
          setOnline(vivos)
        })
        .catch(() => {  })
    }
    lerOnline()
    const t = window.setInterval(lerOnline, 10_000)
    const un = services.subscribe((ev) => {
      if (ev.type === 'peer_online' || ev.type === 'peer_offline' || ev.type === 'state_changed') lerOnline()
    })
    return () => { alive = false; window.clearInterval(t); un() }
  }, [])

  useEffect(() => {
    if (!enabled) { setRows((cur) => (cur.length === 0 ? cur : [])); return }
    let alive = true
    const load = () => {
      services
        .voiceStates(communityId, channelId)
        .then((v) => {
          if (!alive) return
          const cru: VoiceRow[] = (v as Array<[string, boolean, boolean]>).map(([fp, muted, deafened]) => ({
            fp,
            muted,
            deafened,
          }))
          const next = filterLiveVoiceRows(cru, {
            myFp,
            onlineFps: online ?? new Set<string>(),
            filtrar: online !== null,
          })
          setRows((cur) =>
            cur.length === next.length &&
            cur.every((r, i) => r.fp === next[i].fp && r.muted === next[i].muted && r.deafened === next[i].deafened)
              ? cur
              : next,
          )
        })
        .catch(() => {  })
    }
    load()
    const t = window.setInterval(load, 15_000)
    const un = services.subscribe((ev) => {
      if (
        ev.type === 'voice_joined' ||
        ev.type === 'voice_left' ||
        ev.type === 'voice_state_changed' ||
        ev.type === 'peer_offline'
      ) {
        load()
      }
    })
    return () => { alive = false; window.clearInterval(t); un() }
  }, [communityId, channelId, enabled, myFp, online])
  return rows
}

export function ChannelVoicePeers({
  communityId,
  channelId,
  myFp,
  isCurrent,
  nameOf,
  palette,
}: {
  communityId: string
  channelId: string
  myFp: string
  isCurrent: boolean
  nameOf: (fp: string) => string
  palette: { muted: string; text: string; heading: string; green: string; red: string }
}) {
  const rows = useChannelVoicePeers(communityId, channelId, true, myFp)
  if (rows.length === 0) return null
  return (
    <div
      style={{
        paddingLeft: 26,
        paddingBottom: 3,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        minWidth: 0,
      }}
    >
      {rows.map((r) => {
        const eu = r.fp === myFp
        const nome = eu ? 'você' : nameOf(r.fp) || r.fp.slice(0, 8)
        return (
          <span
            key={r.fp}
            title={r.deafened ? `${nome} — surdo` : r.muted ? `${nome} — microfone mudo` : nome}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              minWidth: 0,
              fontSize: 11,
              fontWeight: 600,
              color: r.muted || r.deafened ? palette.muted : palette.text,
              lineHeight: 1.4,
            }}
          >
            <span style={{ display: 'flex', flexShrink: 0, color: r.muted || r.deafened ? palette.red : palette.green }}>
              <Ic name={r.deafened ? 'volumeX' : r.muted ? 'micOff' : 'mic'} size={10} />
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {nome}
            </span>
            {eu && (
              <span style={{ fontSize: 9, color: palette.muted, flexShrink: 0 }}>
                {isCurrent ? '(na chamada)' : ''}
              </span>
            )}
          </span>
        )
      })}
    </div>
  )
}
