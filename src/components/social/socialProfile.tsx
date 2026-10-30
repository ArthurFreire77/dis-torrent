// Modal de perfil (apelido, avatar, capa, status).
//
// Extraído de `Social.tsx` (que tinha 1508 linhas e 27 exports) por
// `scripts/split-social.mjs`. O conteúdo é o MESMO — a divisão é só de
// responsabilidade: um arquivo por assunto, para achar e revisar sem rolar
// 1,5 mil linhas. `Social.tsx` continua reexportando tudo, então nenhum
// importador precisou mudar.

import React, { useEffect, useState } from 'react'
import type { PresenceStatus, PresenceView, ProfileView } from '../../services/models'
import { Ic, type IconName } from '../../shared/icons'
import { compressAvatar, compressBanner } from '../../shared/avatar'
import { PRESENCE_COLOR, PRESENCE_LABEL, T } from './socialTheme'
import {
  Avatar, Field, Modal, PresenceDot, ProfileNote, StatusPicker,
  btnGhost, btnPrimary, inputStyle, secHead,
} from './socialPrimitives'
import { services } from '../../services'

// ============================== PERFIL ==============================

export function ProfileModal({ fp, nickname, myFp, onClose, onMessage, communityId, communityName, onRenamed, onSaved }: {
  fp: string
  nickname: string
  myFp: string
  onClose: () => void
  onMessage?: (fp: string) => void
  communityId?: string
  communityName?: string
  onRenamed?: () => void
  /**
   * Chamado com o perfil EFETIVAMENTE PERSISTIDO assim que o salvamento dá
   * certo. Sem isto o modal era uma ilha de estado: gravava no SQLite, mas o
   * avatar do canto inferior esquerdo (e o nome em toda a UI) só mudavam no
   * próximo poll de 15 s — e nunca, se esse poll falhasse.
   */
  onSaved?: (p: ProfileView) => void
}) {
  const [profile, setProfile] = useState<ProfileView | null>(null)
  const [presence, setPresence] = useState<PresenceView | null>(null)
  const isMe = fp === myFp
  const [editing, setEditing] = useState(false)
  const [tab, setTab] = useState<'sobre' | 'servidor' | 'p2p'>('sobre')
  const [displayName, setDisplayName] = useState('')
  const [about, setAbout] = useState('')
  const [accent, setAccent] = useState('#5865f2')
  const [avatar, setAvatar] = useState('')
  const [banner, setBanner] = useState('')
  const [status, setStatus] = useState<PresenceStatus>('online')
  const [custom, setCustom] = useState('')
  const [customEmoji, setCustomEmoji] = useState('')
  const [memberSince, setMemberSince] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const canNick = !!communityId && isMe
  const [nick, setNick] = useState(nickname)
  const [nickBusy, setNickBusy] = useState(false)

  useEffect(() => {
    if (!communityId) return
    let alive = true
    services.nicknameGet(communityId, fp)
      .then(n => { if (alive && n) setNick(n) })
      .catch(() => {})
    return () => { alive = false }
  }, [communityId, fp])

  useEffect(() => {
    let alive = true
    Promise.all([services.profileGet(fp), services.presenceGet(fp)])
      .then(([p, pr]) => {
        if (!alive) return
        setProfile(p); setPresence(pr)
        setDisplayName(p.display_name || nickname)
        setAbout(p.about)
        setAccent(p.accent || '#5865f2')
        setAvatar(p.avatar_b64); setBanner(p.banner_b64)
        setStatus(pr.status === 'offline' ? 'online' : pr.status)
        setCustom(pr.custom)
        setCustomEmoji((pr as { custom_emoji?: string }).custom_emoji ?? '')
      })
      .catch(() => { if (alive) setProfile({ fp, display_name: nickname, about: '', avatar_b64: '', banner_b64: '', accent: '', updated_at: 0 }) })
    if (isMe) {
      services.identityGet()
        .then(id => { if (alive && id && typeof id.created_at === 'number' && id.created_at > 0) setMemberSince(id.created_at) })
        .catch(() => {})
    }
    return () => { alive = false }
  }, [fp, nickname])

  const readAvatar = (f: File): Promise<string> => compressAvatar(f)
  const readBanner = (f: File): Promise<string> => compressBanner(f)

  async function save() {
    setBusy(true); setErr(null)
    try {
      const p = await services.profileSet({ display_name: displayName, about, avatar_b64: avatar, banner_b64: banner, accent })
      // Estado local = o que o core PERSISTIU (com rev/content_hash), não o
      // patch digitado. É o mesmo objeto que os outros componentes recebem.
      setProfile(p)
      setAvatar(p.avatar_b64)
      setBanner(p.banner_b64)
      onSaved?.(p)
      // Presença é independente: se falhar, o perfil JÁ foi salvo — o erro
      // precisa dizer isso em vez de parecer que nada foi gravado.
      try {
        await services.presenceSet(status, custom, customEmoji)
        setPresence({ fp, status, custom, custom_emoji: customEmoji, updated_at: Date.now() })
      } catch (pe: any) {
        setErr(`perfil salvo, mas o status não foi publicado: ${String(pe?.message ?? pe)}`)
        setEditing(false)
        return
      }
      setEditing(false)
    } catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  async function copyFp() {
    try { await navigator.clipboard?.writeText(fp) } catch { /* clipboard indisponível */ }
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  const previewing = editing && isMe
  const name = previewing ? (displayName || nickname || fp) : (profile?.display_name || nickname || fp)
  const shownStatus = previewing ? status : (presence?.status ?? 'offline')
  const shownCustom = previewing ? custom : (presence?.custom ?? '')
  const shownEmoji = previewing ? customEmoji : ((presence as { custom_emoji?: string } | null)?.custom_emoji ?? '')
  const shownAbout = previewing ? about : (profile?.about ?? '')
  const shownAccent = previewing ? accent : (profile?.accent || T.accent)
  const shownAvatar = previewing ? (avatar || profile?.avatar_b64) : profile?.avatar_b64
  const bannerUrl = (previewing ? banner : (profile?.banner_b64 ?? banner))
    ? `url(data:image/jpeg;base64,${previewing ? banner : profile?.banner_b64})`
    : `linear-gradient(135deg, ${shownAccent} 0%, #1e1f22 130%)`
  const tabs = [{ id: 'sobre', label: 'Sobre' }, ...(communityId ? [{ id: 'servidor', label: 'Servidor' }] : []), { id: 'p2p', label: 'P2P' }] as const
  const activeTab = tab === 'servidor' && !communityId ? 'sobre' : tab
  return (
    <Modal title={isMe ? 'Meu perfil' : 'Perfil'} onClose={onClose} width={460}>
      <div style={{ margin: '-20px -20px 0', height: 160, backgroundImage: bannerUrl, backgroundSize: 'cover', backgroundPosition: 'center', position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 40%, rgba(0,0,0,.45))' }} />
        {editing && isMe && (
          <label style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(0,0,0,.65)', color: '#fff', fontSize: 12, fontWeight: 700, padding: '7px 12px', borderRadius: 8, cursor: 'pointer' }}>
            Trocar capa
            <input type="file" accept="image/*" aria-label="Escolher banner" hidden onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { setErr(null); setBanner(await readBanner(f)) } catch (err: any) { setErr(String(err?.message ?? err)) } }} />
          </label>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginTop: -44, marginBottom: 4, position: 'relative' }}>
        <div style={{ position: 'relative' }}>
          <label style={{ display: 'block', cursor: editing && isMe ? 'pointer' : 'default' }} title={editing && isMe ? 'Trocar avatar' : undefined}>
            <span style={{ display: 'block', borderRadius: '50%', border: '6px solid #313338', lineHeight: 0, boxShadow: `0 0 0 2px ${shownAccent}` }}>
              <Avatar name={name} fp={fp} size={88} avatarB64={shownAvatar} />
            </span>
            {editing && isMe && (
              <input type="file" accept="image/*" aria-label="Escolher avatar" hidden onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { setErr(null); setAvatar(await readAvatar(f)) } catch (err: any) { setErr(String(err?.message ?? err)) } }} />
            )}
          </label>
          <span style={{ position: 'absolute', bottom: 8, right: 8 }}>
            <PresenceDot status={shownStatus} size={22} ring="#313338" />
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 0, paddingBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: shownAccent, flexShrink: 0 }} />
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, color: T.muted }}>PERFIL</span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 900, color: T.heading, lineHeight: 1.15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
          <div style={{ fontSize: 12, color: T.muted }}>@{fp.slice(0, 8)} · {PRESENCE_LABEL[shownStatus]}</div>
        </div>
        {editing && isMe && (
          <input type="color" value={accent} aria-label="Cor de destaque" title="Cor de destaque" onChange={e => setAccent(e.target.value)} style={{ width: 38, height: 30, background: T.input, border: `1px solid ${T.border}`, borderRadius: 8, cursor: 'pointer', flexShrink: 0 }} />
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 800, background: 'rgba(35,165,89,.15)', color: '#57f287', border: '1px solid rgba(35,165,89,.4)', padding: '3px 8px', borderRadius: 99 }}><Ic name="check" size={12} stroke={2.4} />ed25519 verificada</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 800, background: T.input, color: PRESENCE_COLOR[shownStatus], border: `1px solid ${T.border}`, padding: '3px 8px', borderRadius: 99 }}>
          {statusIconName(shownEmoji) ? <Ic name={statusIconName(shownEmoji)!} size={12} stroke={2} /> : null}{shownCustom || PRESENCE_LABEL[shownStatus]}</span>
        {communityName && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 800, background: T.input, color: T.muted, border: `1px solid ${T.border}`, padding: '3px 8px', borderRadius: 99 }}><Ic name="hash" size={12} />{communityName}</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {!isMe && onMessage && (
          <button onClick={() => { onMessage(fp); onClose() }} style={{ ...btnPrimary, flex: 1 }}>Mensagem</button>
        )}
        <button onClick={copyFp} style={{ ...btnGhost, flex: 1 }}>{copied ? 'Copiado!' : 'Copiar ID'}</button>
        {isMe && !editing && (
          <button onClick={() => setEditing(true)} style={{ ...btnPrimary, flex: 1 }}>Editar perfil</button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4, background: T.input, borderRadius: 8, padding: 4, marginBottom: 12 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id as typeof tab)}
            style={{ flex: 1, background: activeTab === t.id ? T.accent : 'transparent', color: activeTab === t.id ? '#fff' : T.muted, border: 'none', borderRadius: 6, padding: '7px 0', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>{t.label}</button>
        ))}
      </div>
      {activeTab === 'sobre' && !editing && (
        <div style={{ background: T.input, borderRadius: 10, padding: '12px 14px' }}>
          <div style={secHead}>SOBRE MIM</div>
          <div style={{ fontSize: 13, color: shownAbout ? T.text : T.muted, whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{shownAbout || 'Nada por aqui ainda.'}</div>
          <div style={secHead}>MEMBRO DESDE</div>
          <div style={{ fontSize: 13, color: T.text }}>{memberSince ? new Date(memberSince).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }) : (isMe ? '—' : 'visível só no próprio aparelho')}</div>
          <div style={secHead}>COR DO PERFIL</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 22, height: 22, borderRadius: 6, background: shownAccent, border: `1px solid ${T.border}` }} />
            <span style={{ fontSize: 12, color: T.muted, fontFamily: 'JetBrains Mono' }}>{shownAccent}</span>
          </div>
          {!isMe && !editing && <ProfileNote fp={fp} />}
        </div>
      )}
      {activeTab === 'servidor' && communityId && !editing && (
        <div style={{ background: T.input, borderRadius: 10, padding: '12px 14px' }}>
          <div style={secHead}>NESTE SERVIDOR{communityName ? ` — ${communityName}` : ''}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={nick} onChange={e => setNick(e.target.value)} disabled={!canNick} maxLength={32}
              placeholder={canNick ? 'Seu apelido aqui…' : 'sem permissão'} style={{ ...inputStyle, flex: 1, opacity: canNick ? 1 : 0.5 }} />
            <button
              onClick={async () => {
                if (!canNick || !nick.trim()) return
                setNickBusy(true); setErr(null)
                try { await services.nicknameSet(communityId, fp, nick.trim()); onRenamed?.() }
                catch (e: any) { setErr(String(e?.message ?? e)) } finally { setNickBusy(false) }
              }}
              disabled={!canNick || nickBusy} style={{ ...btnPrimary, opacity: canNick && !nickBusy ? 1 : 0.5 }}>{nickBusy ? '…' : 'Salvar'}</button>
          </div>
          <div style={{ fontSize: 11, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>Apelido vale só aqui. Seu perfil global continua igual.</div>
        </div>
      )}
      {activeTab === 'p2p' && !editing && (
        <div style={{ background: T.input, borderRadius: 10, padding: '12px 14px' }}>
          <div style={secHead}>IDENTIDADE P2P</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ flex: 1, fontSize: 11, color: T.text, fontFamily: 'JetBrains Mono', wordBreak: 'break-all', lineHeight: 1.6 }}>{fp}</span>
            <button onClick={copyFp} style={{ ...btnGhost, padding: '6px 10px', fontSize: 11, flexShrink: 0 }}>{copied ? 'OK!' : 'Copiar'}</button>
          </div>
          <div style={secHead}>CONEXÃO</div>
          <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.6 }}>
            Rota negociada sozinha entre aparelhos (direta ou via relay quando há NAT restritivo). Conteúdo sempre cifrado fim-a-fim — relay enxerga no máximo metadados de transporte.
          </div>
          <div style={secHead}>SINCRONIZAÇÃO</div>
          <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.6 }}>
            Avatar e capa viajam comprimidos pelo swarm e ficam em cache nos peers. Sem servidor guardando nada.
          </div>
        </div>
      )}
      {editing && isMe && (
        <>
          <Field label="Nome de exibição">
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} style={inputStyle} maxLength={48} placeholder="Como quer aparecer" />
          </Field>
          <Field label="Sobre mim" hint={`${about.length}/400`}>
            <textarea value={about} onChange={e => setAbout(e.target.value)} style={{ ...inputStyle, minHeight: 64, resize: 'vertical' }} maxLength={400} placeholder="Conte um pouco sobre você" />
          </Field>
          <Field label="Presença">
            <StatusPicker value={status} onChange={setStatus} />
          </Field>
          <Field label="Status personalizado" hint={`${custom.length}/128`}>
            <input value={custom} onChange={e => setCustom(e.target.value)} style={inputStyle} maxLength={128} placeholder="O que está fazendo agora?" />
          </Field>
          <Field label="Ícone do status">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {STATUS_ICONS.map(s => (
                <button key={s.id} type="button" onClick={() => setCustomEmoji(customEmoji === s.id ? '' : s.id)} title={s.label} aria-label={s.label} aria-pressed={customEmoji === s.id}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 38, height: 38, background: customEmoji === s.id ? `${T.accent}33` : 'transparent', border: `1px solid ${customEmoji === s.id ? T.accent : T.border}`, borderRadius: 8, color: customEmoji === s.id ? '#fff' : T.muted, cursor: 'pointer' }}><Ic name={s.icon} size={18} /></button>
              ))}
              {customEmoji && !statusIconName(customEmoji) && <span style={{ fontSize: 11, color: T.muted }}>Ícone antigo: {customEmoji}</span>}
              {customEmoji && <button type="button" onClick={() => setCustomEmoji('')} style={{ ...btnGhost, padding: '4px 10px', fontSize: 11 }}>Limpar</button>}
            </div>
          </Field>
          <div style={{ fontSize: 11, color: T.muted, marginBottom: 12, lineHeight: 1.5 }}>Dica: toque na capa ou no avatar lá em cima para trocar a imagem. Tudo é comprimido no aparelho antes de ir ao P2P.</div>
          {err && <div style={{ color: '#ff9c9c', fontSize: 12, marginBottom: 10 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} style={btnGhost}>Cancelar</button>
            <button onClick={save} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>{busy ? 'Salvando…' : 'Salvar'}</button>
          </div>
        </>
      )}
    </Modal>
  )
}


// ---------------------------------------------------------------------------
// Helpers que o recorte por faixa deixou fora (linhas 13-26 e 431 do original:
// `STATUS_ICONS`/`statusIconName` e `secHead`). Ficam aqui porque só o modal de
// perfil os usa.

const STATUS_ICONS: { id: string; icon: IconName; label: string }[] = [
  { id: 'game', icon: 'grid', label: 'Jogando' },
  { id: 'code', icon: 'terminal', label: 'Codando' },
  { id: 'music', icon: 'headphones', label: 'Ouvindo música' },
  { id: 'study', icon: 'file', label: 'Estudando' },
  { id: 'live', icon: 'video', label: 'Em chamada' },
  { id: 'chat', icon: 'smile', label: 'Conversando' },
  { id: 'work', icon: 'monitor', label: 'Trabalhando' },
  { id: 'hype', icon: 'sparkle', label: 'Hype' },
]

function statusIconName(id: string): IconName | null {
  return STATUS_ICONS.find(s => s.id === id)?.icon ?? null
}
