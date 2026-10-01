import { useEffect, useState } from 'react'
import { Icon, Icons } from '../shared/icons'
import { services } from '../services'
import { PERMS, PERM_LABELS } from '../services/models'

const t = {
  sidebar: '#2b2d31',
  input: '#1e1f22',
  hover: '#35373c',
  selected: '#404249',
  border: '#26272b',
  panel: '#2b2d31',
  accent: '#5865f2',
  accentHover: '#4752c4',
  green: '#23a559',
  yellow: '#f0b232',
  red: '#f23f42',
  text: '#dbdee1',
  heading: '#f2f3f5',
  muted: '#949ba4',
}

type ChannelKind = 'text' | 'voice' | 'video'

interface WizardChannel {
  name: string
  kind: ChannelKind
  category: string
}

interface RolePreset {
  key: string
  name: string
  color: string
  permissions: number
  hoist: boolean
  mentionable: boolean
  enabled: boolean
}

interface Template {
  id: string
  label: string
  desc: string
  channels: { name: string; kind: ChannelKind }[]
}

const TEMPLATES: Template[] = [
  { id: 'own', label: 'Criar meu próprio', desc: 'Comece do zero, do seu jeito', channels: [{ name: 'geral', kind: 'text' }] },
  { id: 'games', label: 'Jogos', desc: 'Partidas, clipes e papo solto', channels: [{ name: 'geral', kind: 'text' }, { name: 'partidas', kind: 'voice' }, { name: 'clipes', kind: 'text' }] },
  { id: 'school', label: 'Clube escolar', desc: 'Aulas, avisos e trabalhos', channels: [{ name: 'geral', kind: 'text' }, { name: 'avisos', kind: 'text' }, { name: 'reuniao', kind: 'voice' }] },
  { id: 'study', label: 'Grupo de estudos', desc: 'Materiais, dúvidas e resumos', channels: [{ name: 'geral', kind: 'text' }, { name: 'materiais', kind: 'text' }, { name: 'estudos', kind: 'voice' }, { name: 'sala de vídeo', kind: 'video' }] },
  { id: 'friends', label: 'Amigos', desc: 'Só vocês, sem complicação', channels: [{ name: 'geral', kind: 'text' }] },
]

const ICON_CHOICES = ['🚀', '🎮', '📚', '🎵', '⚽', '💻', '🎨', '🍕']

const STEP_LABELS = ['Identidade', 'Canais', 'Cargos', 'Regras']

function categoryFor(kind: ChannelKind): string {
  if (kind === 'voice') return 'CANAIS DE VOZ'
  if (kind === 'video') return 'CANAIS DE VÍDEO'
  return 'CANAIS DE TEXTO'
}

function initialRoles(): RolePreset[] {
  return [
    {
      key: 'admin',
      name: 'Admin',
      color: '#f23f42',
      permissions: PERMS.ADMINISTRATOR | PERMS.MANAGE_CHANNELS | PERMS.MANAGE_ROLES
        | PERMS.KICK_MEMBERS | PERMS.BAN_MEMBERS | PERMS.MANAGE_BOT,
      hoist: true,
      mentionable: false,
      enabled: true,
    },
    {
      key: 'mod',
      name: 'Moderador',
      color: '#f0b232',
      permissions: PERMS.KICK_MEMBERS | PERMS.MANAGE_CHANNELS | PERMS.SEND_MESSAGES
        | PERMS.VIEW_CHANNEL | PERMS.MENTION_EVERYONE,
      hoist: true,
      mentionable: false,
      enabled: true,
    },
    {
      key: 'member',
      name: 'Membro',
      color: '#57f287',
      permissions: PERMS.SEND_MESSAGES | PERMS.VIEW_CHANNEL | PERMS.EMBED_LINKS,
      hoist: false,
      mentionable: false,
      enabled: false,
    },
  ]
}

function inputStyle(): React.CSSProperties {
  return {
    background: t.input,
    border: `1px solid ${t.border}`,
    borderRadius: 8,
    padding: '10px 12px',
    color: t.text,
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
    width: '100%',
  }
}

function labelStyle(): React.CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
    color: t.muted,
    marginBottom: 6,
    display: 'block',
  }
}

function primaryBtn(disabled?: boolean): React.CSSProperties {
  return {
    background: disabled ? t.selected : t.accent,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontWeight: 800,
    fontSize: 13,
    padding: '9px 16px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  }
}

function secondaryBtn(): React.CSSProperties {
  return {
    background: t.input,
    border: `1px solid ${t.border}`,
    borderRadius: 8,
    color: t.text,
    fontSize: 13,
    fontWeight: 700,
    padding: '9px 16px',
    cursor: 'pointer',
  }
}

export default function CreateServerWizard({ open, onClose, onCreated }: {
  open: boolean
  onClose: () => void
  onCreated: (communityId: string) => void
}) {
  const [step, setStep] = useState(0)
  const [templateId, setTemplateId] = useState('own')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [iconEmoji, setIconEmoji] = useState('')
  const [channels, setChannels] = useState<WizardChannel[]>([
    { name: 'geral', kind: 'text', category: 'CANAIS DE TEXTO' },
  ])
  const [roles, setRoles] = useState<RolePreset[]>(initialRoles)
  const [expandedRole, setExpandedRole] = useState<string | null>(null)
  const [rulesText, setRulesText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inviteLink, setInviteLink] = useState('')
  const [createdId, setCreatedId] = useState('')

  useEffect(() => {
    if (!open) return
    setStep(0)
    setTemplateId('own')
    setName('')
    setDescription('')
    setIconEmoji('')
    setChannels([{ name: 'geral', kind: 'text', category: 'CANAIS DE TEXTO' }])
    setRoles(initialRoles())
    setExpandedRole(null)
    setRulesText('')
    setBusy(false)
    setError(null)
    setInviteLink('')
    setCreatedId('')
  }, [open ])

  if (!open) return null

  function chooseTemplate(tpl: Template) {
    setTemplateId(tpl.id)
    setName(tpl.id === 'own' ? '' : tpl.label)
    setChannels(tpl.channels.map((c) => ({ name: c.name, kind: c.kind, category: categoryFor(c.kind) })))
    setStep(1)
  }

  function updateChannel(i: number, patch: Partial<WizardChannel>) {
    setChannels((prev) => prev.map((c, idx) => {
      if (idx !== i) return c
      const next = { ...c, ...patch }
      if (patch.kind) next.category = categoryFor(patch.kind)
      return next
    }))
  }

  function togglePerm(roleKey: string, bit: number) {
    setRoles((prev) => prev.map((r) => {
      if (r.key !== roleKey) return r
      const has = (r.permissions & bit) !== 0
      return { ...r, permissions: has ? r.permissions & ~bit : r.permissions | bit }
    }))
  }

  async function createServer() {
    setError(null)
    setBusy(true)
    try {
      const channelsMeta = channels.map((c) => ({
        name: c.name,
        kind: c.kind,
        category: c.kind === 'voice' ? 'CANAIS DE VOZ' : c.kind === 'video' ? 'CANAIS DE VÍDEO' : 'CANAIS DE TEXTO',
      }))
      const id = await services.createCommunity(name.trim(), channels.map((c) => c.name), {
        description,
        icon: iconEmoji,
        category: templateId,
        rulesText: rulesText || undefined,
        channelsMeta,
        roles: roles
          .filter((r) => r.enabled)
          .map((r) => ({
            name: r.name,
            color: r.color,
            permissions: r.permissions,
            hoist: r.hoist,
            mentionable: r.mentionable,
          })),
      })
      const me = await services.identityGet()
      const token = await services.makeInvite(id, me?.fingerprint ?? '000000000000')
      setCreatedId(id)
      const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : ''
      setInviteLink(`${origin}/invite/${token}`)
      setStep(4)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'não foi possível criar o servidor')
    } finally {
      setBusy(false)
    }
  }

  function copyInvite() {
    try {
      void navigator.clipboard?.writeText(inviteLink)?.catch(() => {})
    } catch {
      /* clipboard indisponível */
    }
  }

  const stepperIndex = Math.min(step, 3)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Criar servidor"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: t.panel,
          border: `1px solid ${t.border}`,
          borderRadius: 16,
          padding: 22,
          width: 560,
          maxHeight: '85vh',
          overflowY: 'auto',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ color: t.heading, fontWeight: 900, fontSize: 16 }}>Criar servidor</div>
          <button
            type="button"
            aria-label="Fechar criação de servidor"
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: t.muted, fontSize: 16, cursor: 'pointer', padding: 4 }}
          >
            ✕
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 18 }}>
          {STEP_LABELS.map((label, i) => (
            <div key={label} style={{ flex: 1, textAlign: 'center' }}>
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  margin: '0 auto 4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 800,
                  background: (step === 4 || i <= stepperIndex) ? t.accent : t.input,
                  color: '#fff',
                  border: `1px solid ${t.border}`,
                }}
              >
                {i + 1}
              </div>
              <div style={{ fontSize: 10, color: t.muted }}>{label}</div>
            </div>
          ))}
        </div>

        {step === 0 && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
              {TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => chooseTemplate(tpl)}
                  style={{
                    background: t.sidebar,
                    border: `2px solid ${templateId === tpl.id && step === 0 ? t.accent : t.border}`,
                    borderRadius: 10,
                    padding: 12,
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: t.text,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = t.accent }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = templateId === tpl.id ? t.accent : t.border }}
                >
                  <div style={{ color: t.heading, fontWeight: 800, fontSize: 13 }}>{tpl.label}</div>
                  <div style={{ color: t.muted, fontSize: 11, marginTop: 4 }}>{tpl.desc}</div>
                </button>
              ))}
            </div>
            <label style={labelStyle()}>NOME DO SERVIDOR</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ex.: cantinho dos amigos"
              style={inputStyle()}
            />
            <div style={{ marginTop: 12 }}>
              <label style={labelStyle()}>DESCRIÇÃO (OPCIONAL)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="do que é este servidor?"
                style={{ ...inputStyle(), resize: 'vertical' }}
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={labelStyle()}>ÍCONE</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {ICON_CHOICES.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-label={`ícone ${emoji}`}
                    onClick={() => setIconEmoji(iconEmoji === emoji ? '' : emoji)}
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      fontSize: 18,
                      background: t.sidebar,
                      border: iconEmoji === emoji ? `3px solid ${t.heading}` : `1px solid ${t.border}`,
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    {emoji}
                  </button>
                ))}
                <button type="button" onClick={() => setIconEmoji('')} style={secondaryBtn()}>
                  (sem ícone)
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
              <button
                type="button"
                disabled={!name.trim()}
                onClick={() => setStep(1)}
                style={primaryBtn(!name.trim())}
              >
                Continuar
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div>
            <label style={labelStyle()}>CANAIS</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {channels.map((c, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: t.muted, display: 'flex' }}>
                    {c.kind === 'text' && <Icon d={Icons.hash} size={16} />}
                    {c.kind === 'voice' && <Icon d={Icons.speaker} size={16} />}
                    {c.kind === 'video' && <Icon d={Icons.video} size={16} />}
                  </span>
                  <input
                    value={c.name}
                    onChange={(e) => updateChannel(i, { name: e.target.value.toLowerCase().replace(/\s+/g, '-') })}
                    style={{ ...inputStyle(), flex: 1 }}
                    aria-label={`nome do canal ${i + 1}`}
                  />
                  <select
                    value={c.kind}
                    onChange={(e) => updateChannel(i, { kind: e.target.value as ChannelKind })}
                    style={{ ...inputStyle(), width: 110 }}
                    aria-label={`tipo do canal ${i + 1}`}
                  >
                    <option value="text">Texto</option>
                    <option value="voice">Voz</option>
                    <option value="video">Vídeo</option>
                  </select>
                  <button
                    type="button"
                    aria-label={`remover canal ${c.name}`}
                    disabled={channels.length <= 1}
                    onClick={() => setChannels((prev) => prev.filter((_, idx) => idx !== i))}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: t.muted,
                      cursor: channels.length <= 1 ? 'not-allowed' : 'pointer',
                      fontSize: 14,
                      padding: 4,
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setChannels((prev) => [...prev, { name: 'novo-canal', kind: 'text', category: 'CANAIS DE TEXTO' }])}
              style={{ ...secondaryBtn(), marginTop: 10 }}
            >
              + Adicionar canal
            </button>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18 }}>
              <button type="button" onClick={() => setStep(0)} style={secondaryBtn()}>← Voltar</button>
              <button
                type="button"
                disabled={channels.length === 0}
                onClick={() => setStep(2)}
                style={primaryBtn(channels.length === 0)}
              >
                Continuar
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <label style={labelStyle()}>CARGOS</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {roles.map((r) => (
                <div key={r.key} style={{ background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 10, padding: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={() => setRoles((prev) => prev.map((p) => (p.key === r.key ? { ...p, enabled: !p.enabled } : p)))}
                      aria-label={`incluir cargo ${r.name}`}
                    />
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: r.color }} />
                    <input
                      value={r.name}
                      onChange={(e) => setRoles((prev) => prev.map((p) => (p.key === r.key ? { ...p, name: e.target.value } : p)))}
                      style={{ ...inputStyle(), flex: 1 }}
                      aria-label="nome do cargo"
                    />
                    <button
                      type="button"
                      onClick={() => setExpandedRole(expandedRole === r.key ? null : r.key)}
                      style={{ background: 'transparent', border: 'none', color: t.muted, cursor: 'pointer', padding: 4 }}
                      aria-label={`detalhes do cargo ${r.name}`}
                    >
                      <Icon d={Icons.chevron} size={14} />
                    </button>
                  </div>
                  {expandedRole === r.key && (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {(Object.keys(PERMS) as (keyof typeof PERMS)[]).map((key) => {
                        const bit = PERMS[key]
                        const label = (PERM_LABELS as Record<number, string>)[bit] ?? key
                        return (
                          <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: t.text, cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={(r.permissions & bit) !== 0}
                              onChange={() => togglePerm(r.key, bit)}
                            />
                            {label}
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18 }}>
              <button type="button" onClick={() => setStep(1)} style={secondaryBtn()}>← Voltar</button>
              <button type="button" onClick={() => setStep(3)} style={primaryBtn()}>Continuar</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <label style={labelStyle()}>REGRAS DO SERVIDOR (OPCIONAL)</label>
            <textarea
              value={rulesText}
              onChange={(e) => setRulesText(e.target.value)}
              rows={4}
              placeholder="ex.: sem flood, sem spam, respeite todo mundo"
              style={{ ...inputStyle(), resize: 'vertical' }}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
              <div style={{ background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: t.muted, marginBottom: 6 }}>
                  {`${iconEmoji ? `${iconEmoji} ` : ''}${name || '(sem nome)'}`}
                </div>
                <div style={{ fontSize: 12, color: t.text }}>
                  {`${channels.length} ${channels.length === 1 ? 'canal' : 'canais'}`}
                </div>
                <div style={{ fontSize: 11, color: t.muted, marginTop: 4 }}>
                  {channels.map((c) => `${c.kind === 'voice' ? 'voz' : c.kind === 'video' ? 'vídeo' : 'texto'}: ${c.name}`).join(' • ')}
                </div>
              </div>
              <div style={{ background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: t.muted, marginBottom: 6 }}>
                  CARGOS
                </div>
                {roles.filter((r) => r.enabled).length === 0 && (
                  <div style={{ fontSize: 12, color: t.muted }}>nenhum cargo</div>
                )}
                {roles.filter((r) => r.enabled).map((r) => (
                  <div key={r.key} style={{ fontSize: 12, color: r.color, fontWeight: 700 }}>
                    {r.name}
                  </div>
                ))}
              </div>
            </div>
            {error && <div style={{ fontSize: 12, color: '#ff9c9c', marginTop: 10 }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18 }}>
              <button type="button" disabled={busy} onClick={() => setStep(2)} style={secondaryBtn()}>← Voltar</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void createServer()}
                style={{ ...primaryBtn(busy), background: t.green }}
              >
                {busy ? 'Criando…' : 'Criar servidor'}
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 56 }}>
              {iconEmoji || (name.trim() ? name.trim()[0]?.toUpperCase() : '?')}
            </div>
            <div style={{ color: t.heading, fontWeight: 900, fontSize: 18, marginTop: 8 }}>
              Servidor criado!
            </div>
            <div style={{ color: t.muted, fontSize: 12, marginTop: 4 }}>
              convide gente com este link
            </div>
            <div
              style={{
                background: t.input,
                border: `1px solid ${t.border}`,
                borderRadius: 8,
                padding: '10px 12px',
                marginTop: 12,
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 12,
                color: t.text,
                wordBreak: 'break-all',
              }}
            >
              {inviteLink || 'gerando link…'}
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
              <button type="button" onClick={copyInvite} style={secondaryBtn()}>
                Copiar link
              </button>
              <button
                type="button"
                onClick={() => { onCreated(createdId); onClose() }}
                style={primaryBtn()}
              >
                Concluir
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
