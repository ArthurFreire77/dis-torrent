// Moderação (bans/timeouts) e eventos do servidor.
//
// Extraído de `Social.tsx` (que tinha 1508 linhas e 27 exports) por
// `scripts/split-social.mjs`. O conteúdo é o MESMO — a divisão é só de
// responsabilidade: um arquivo por assunto, para achar e revisar sem rolar
// 1,5 mil linhas. `Social.tsx` continua reexportando tudo, então nenhum
// importador precisou mudar.

import React, { useEffect, useState } from 'react'
import type { BanView, ChannelMeta, EventView } from '../../services/models'
import { T, fmtClock, fmtDay } from './socialTheme'
import { Avatar, Modal, btnDanger, btnGhost, btnPrimary, inputStyle } from './socialPrimitives'
import { services } from '../../services'

// ============================== MODERAÇÃO ==============================

export function ModerationPanel({ communityId, members, isOwner, onClose, onToast }: {
  communityId: string
  members: [string, string, string][]
  isOwner: boolean
  onClose: () => void
  onToast: (s: string) => void
}) {
  const [bans, setBans] = useState<BanView[]>([])
  const [timeouts, setTimeouts] = useState<BanView[]>([])
  const [tab, setTab] = useState<'membros' | 'banidos' | 'silenciados'>('membros')
  const [target, setTarget] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [dur, setDur] = useState(60)

  const reload = () => {
    services.banList(communityId).then(setBans).catch(() => setBans([]))
    services.timeoutList(communityId).then(setTimeouts).catch(() => setTimeouts([]))
  }
  useEffect(reload, [communityId])

  async function act(kind: 'ban' | 'timeout' | 'kick') {
    if (!target) return
    try {
      if (kind === 'kick') {
        await services.moderate(communityId, 'ban', target, reason || 'expulso')
        onToast(`${target.slice(0, 8)} expulso`)
      } else if (kind === 'ban') {
        await services.ban(communityId, target, 0, reason)
        onToast(`${target.slice(0, 8)} banido`)
      } else {
        await services.timeout(communityId, target, Date.now() + dur * 60_000, reason)
        onToast(`${target.slice(0, 8)} silenciado por ${dur} min`)
      }
      setTarget(null); setReason(''); reload()
    } catch (e: any) { onToast(String(e?.message ?? e)) }
  }

  if (!isOwner) {
    return <Modal title="Moderação" onClose={onClose}><div style={{ fontSize: 13, color: T.muted }}>Apenas o dono do servidor pode banir/silenciar.</div></Modal>
  }
  return (
    <Modal title="Moderação do servidor" onClose={onClose} width={640}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {(['membros', 'banidos', 'silenciados'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...btnGhost, padding: '6px 12px', background: tab === t ? T.accent : T.input, color: tab === t ? '#fff' : T.muted, border: 'none' }}>{t}</button>
        ))}
      </div>
      {tab === 'membros' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {members.map(([fp, nick]) => (
            <div key={fp} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 9px', background: T.input, borderRadius: 7 }}>
              <Avatar name={nick || fp} fp={fp} size={28} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: T.heading }}>{nick || fp.slice(0, 12)}</div>
                <div style={{ fontSize: 10, color: T.muted, fontFamily: 'JetBrains Mono' }}>{fp.slice(0, 16)}</div>
              </div>
              <button onClick={() => { setTarget(fp); setReason('') }} style={{ ...btnGhost, padding: '5px 10px', fontSize: 11 }}>Moderar</button>
            </div>
          ))}
        </div>
      )}
      {tab === 'banidos' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {bans.length === 0 && <div style={{ fontSize: 12, color: T.muted, textAlign: 'center', padding: 16 }}>ninguém banido</div>}
          {bans.map(b => (
            <div key={b.fp} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 9px', background: T.input, borderRadius: 7 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5, color: T.text, fontFamily: 'JetBrains Mono' }}>{b.fp.slice(0, 16)}</div>
                <div style={{ fontSize: 10, color: T.muted }}>{b.reason || 'sem motivo'} · {b.until_ms > 0 ? `até ${fmtDay(b.until_ms)}` : 'permanente'}</div>
              </div>
              <button onClick={async () => { await services.unban(communityId, b.fp); reload() }} style={{ ...btnGhost, padding: '5px 10px', fontSize: 11 }}>Desbanir</button>
            </div>
          ))}
        </div>
      )}
      {tab === 'silenciados' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {timeouts.length === 0 && <div style={{ fontSize: 12, color: T.muted, textAlign: 'center', padding: 16 }}>ninguém silenciado</div>}
          {timeouts.map(b => (
            <div key={b.fp} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 9px', background: T.input, borderRadius: 7 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5, color: T.text, fontFamily: 'JetBrains Mono' }}>{b.fp.slice(0, 16)}</div>
                <div style={{ fontSize: 10, color: T.muted }}>até {fmtClock(b.until_ms)} · {b.reason || 'sem motivo'}</div>
              </div>
              <button onClick={async () => { await services.timeout(communityId, b.fp, 0, ''); reload() }} style={{ ...btnGhost, padding: '5px 10px', fontSize: 11 }}>Remover</button>
            </div>
          ))}
        </div>
      )}
      {target && (
        <div style={{ marginTop: 14, padding: 12, background: T.input, borderRadius: 8, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 12, color: T.heading, marginBottom: 8 }}>Moderar {target.slice(0, 12)}</div>
          <input value={reason} onChange={e => setReason(e.target.value)} placeholder="motivo" style={{ ...inputStyle, marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: T.muted }}>silenciar por</span>
            <select value={dur} onChange={e => setDur(Number(e.target.value))} style={{ background: T.input, color: T.text, border: `1px solid ${T.border}`, borderRadius: 5, padding: '4px 6px', fontSize: 11 }}>
              {[1, 5, 10, 60, 360, 1440].map(m => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => act('timeout')} style={{ ...btnGhost, fontSize: 11, padding: '6px 10px' }}>⏱ Silenciar</button>
            <button onClick={() => act('kick')} style={{ ...btnGhost, fontSize: 11, padding: '6px 10px' }}>👢 Expulsar</button>
            <button onClick={() => act('ban')} style={{ ...btnDanger, fontSize: 11, padding: '6px 10px' }}>🔨 Banir</button>
            <button onClick={() => setTarget(null)} style={{ ...btnGhost, fontSize: 11, padding: '6px 10px' }}>Cancelar</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ============================== EVENTOS ==============================

export function EventPanel({ communityId, channels, onClose, onToast }: {
  communityId: string
  channels: ChannelMeta[]
  onClose: () => void
  onToast: (s: string) => void
}) {
  const [events, setEvents] = useState<EventView[]>([])
  const [name, setName] = useState('')
  const [where, setWhere] = useState('')
  const [desc, setDesc] = useState('')
  const [inHours, setInHours] = useState(24)
  const [channelId, setChannelId] = useState('')
  useEffect(() => { services.eventList(communityId).then(setEvents).catch(() => setEvents([])) }, [communityId])

  async function create() {
    if (!name.trim()) return
    try {
      await services.eventUpsert({
        id: `ev-${Date.now().toString(36)}`, community_id: communityId, name: name.trim(),
        description: desc, location: where || 'aqui', starts_at: Date.now() + inHours * 3600_000,
        ends_at: Date.now() + (inHours + 2) * 3600_000, channel_id: channelId, entity_fp: '',
        status: 'scheduled', interested: [],
      })
      setName(''); setDesc(''); setWhere('')
      services.eventList(communityId).then(setEvents)
      onToast('evento agendado')
    } catch (e: any) { onToast(String(e?.message ?? e)) }
  }

  return (
    <Modal title="Eventos agendados" onClose={onClose} width={560}>
      <div style={{ background: T.input, borderRadius: 8, padding: 12, marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: T.muted, textTransform: 'uppercase', marginBottom: 8 }}>Novo evento</div>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="nome do evento" style={{ ...inputStyle, marginBottom: 6 }} />
        <input value={where} onChange={e => setWhere(e.target.value)} placeholder="onde (link, sala, local)" style={{ ...inputStyle, marginBottom: 6 }} />
        <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="descrição" style={{ ...inputStyle, minHeight: 50, marginBottom: 6, resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 6 }}>
          <select value={inHours} onChange={e => setInHours(Number(e.target.value))} style={{ background: T.input, color: T.text, border: `1px solid ${T.border}`, borderRadius: 5, padding: '6px 8px', fontSize: 11 }}>
            {[1, 2, 6, 24, 72, 168].map(h => <option key={h} value={h}>em {h < 24 ? `${h}h` : `${h / 24}d`}</option>)}
          </select>
          <select value={channelId} onChange={e => setChannelId(e.target.value)} style={{ flex: 1, background: T.input, color: T.text, border: `1px solid ${T.border}`, borderRadius: 5, padding: '6px 8px', fontSize: 11 }}>
            <option value="">sem canal</option>
            {channels.filter(c => c.kind === 'voice').map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
          <button onClick={create} style={{ ...btnPrimary, padding: '7px 14px', fontSize: 12 }}>Criar</button>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {events.length === 0 && <div style={{ fontSize: 12, color: T.muted, textAlign: 'center', padding: 12 }}>nenhum evento agendado</div>}
        {events.map(e => (
          <div key={e.id} style={{ background: T.sidebar, border: `1px solid ${T.border}`, borderLeft: `3px solid ${T.pink}`, borderRadius: 8, padding: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, color: T.heading }}>{e.name}</div>
              <span style={{ fontSize: 10, color: T.pink, fontWeight: 800, textTransform: 'uppercase' }}>{e.status}</span>
            </div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 3 }}>
              {fmtDay(e.starts_at)} {fmtClock(e.starts_at)} · {e.location} · {e.interested.length} interessado(s)
            </div>
            {e.description && <div style={{ fontSize: 12, color: T.text, marginTop: 5 }}>{e.description}</div>}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button onClick={async () => { await services.eventInterest(communityId, e.id); services.eventList(communityId).then(setEvents) }}
                style={{ ...btnGhost, padding: '5px 10px', fontSize: 11 }}>{e.interested.length > 0 ? 'Tenho interesse' : 'Interesse'}</button>
              <button onClick={async () => { await services.eventDelete(communityId, e.id); services.eventList(communityId).then(setEvents) }}
                style={{ ...btnDanger, padding: '5px 10px', fontSize: 11 }}>Excluir</button>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}

