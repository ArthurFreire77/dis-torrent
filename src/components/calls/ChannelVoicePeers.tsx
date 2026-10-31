// QUEM ESTÁ NO CANAL DE VOZ — lista compacta abaixo do canal.
//
// ## Por que existe
//
// Só quem já estava na chamada via a barra de voz com os participantes. Quem
// abria o servidor depois não tinha como saber que havia gente no canal: o
// canal parecia vazio, então ninguém entrava — e uma chamada com uma pessoa
// dentro ficava invisível para os outros.
//
// Como no Discord, a linha do canal de voz mostra:
//   - os nomes de quem está na chamada (com o ícone de mic);
//   - silenciado/surdo por pessoa;
//   - a própria pessoa aparece como "você".
//
// Tocar no canal ENTRA na chamada (o handler fica no `chan-row`, este componente
// é só leitura e não intercepta clique).

import { useEffect, useState } from 'react'
import { Ic } from '../../shared/icons'
import { services } from '../../services'

export interface VoicePeerRow {
  fp: string
  muted: boolean
  deafened: boolean
}

/**
 * Lê os participantes de um canal de voz.
 *
 * A fonte é o MOTOR (`voiceStates`), não o roster local: é o mesmo dado que a
 * barra de voz usa, então quem aparece aqui é quem realmente está conectado.
 * O poll é de 15 s + evento, para não martelar o SQLite numa lista de canais.
 */
export function useChannelVoicePeers(communityId: string, channelId: string): VoicePeerRow[] {
  const [rows, setRows] = useState<VoicePeerRow[]>([])
  useEffect(() => {
    let alive = true
    const load = () => {
      services
        .voiceStates(communityId, channelId)
        .then((v) => {
          if (!alive) return
          const next = (v as Array<[string, boolean, boolean]>).map(([fp, muted, deafened]) => ({
            fp,
            muted,
            deafened,
          }))
          // Evita re-render quando nada mudou (a lista de canais inteira
          // re-renderiza junto, e são N canais × 15 s).
          setRows((cur) =>
            cur.length === next.length &&
            cur.every((r, i) => r.fp === next[i].fp && r.muted === next[i].muted && r.deafened === next[i].deafened)
              ? cur
              : next,
          )
        })
        .catch(() => { /* sem motor ainda (cofre trancado) */ })
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
  }, [communityId, channelId])
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
  /** Estou NESTE canal? (muda a cor e o texto) */
  isCurrent: boolean
  nameOf: (fp: string) => string
  palette: { muted: string; text: string; heading: string; green: string; red: string }
}) {
  const rows = useChannelVoicePeers(communityId, channelId)
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
