// UI de segurança Storm — componentes prontos para montar no ThemeShell
// (desktop) e no MobileShell (celular). Não importados ainda pelos shells:
// a UI FORGE é congelada visualmente; montar é opt-in (ver docs/SECURITY_LAYER.md).
//
// Mobile-first: alvos de toque >= 44px, largura fluida, sem deps nativas,
// clipboard com fallback (WebView Android nem sempre libera navigator.clipboard).

import { useCallback, useEffect, useRef, useState } from 'react'
import { services } from '../../services'
import type {
  AuditEntry,
  ModerationAction,
  NameKind,
  ReputationView,
  ServerRules,
} from '../../services/models'
import { validateNameLocal, randomNameLocal, skeleton } from '../../core/security/names'
import { warnBeforeSend } from '../../core/security/antispam'
import { TRUST_COLOR, TRUST_LABEL } from '../../core/security/antispam'
import { themeColors, inputStyle, btnStyle, Avatar } from '../../shared/utils'

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fallback abaixo */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function errMsg(e: unknown): string {
  const s = String((e as { message?: unknown })?.message ?? e)
  return s.replace(/"/g, '')
}

// ---------- 1. Cadeado de conversa criptografada ----------

export function EncryptedBadge({ encrypted, compact }: { encrypted: boolean; compact?: boolean }) {
  return (
    <span
      title={encrypted ? 'Conversa criptografada fim-a-fim (X25519 + ChaCha20Poly1305)' : 'Sem criptografia'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: compact ? 11 : 12,
        color: encrypted ? '#57f287' : '#ed4245',
        userSelect: 'none',
      }}
    >
      <span aria-hidden>{encrypted ? '🔒' : '🔓'}</span>
      {!compact && <span>{encrypted ? 'criptografado' : 'aberto'}</span>}
    </span>
  )
}

// ---------- 2. Verificação de identidade (fingerprint + safety number) ----------

export function VerifyIdentity({ peerFp, peerNick }: { peerFp: string; peerNick: string }) {
  const [safety, setSafety] = useState<string | null>(null)
  const [rep, setRep] = useState<ReputationView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    setSafety(null)
    setErr(null)
    services
      .safetyNumber(peerFp)
      .then((s) => { if (alive) setSafety(s) })
      .catch((e) => { if (alive) setErr(errMsg(e)) })
    services
      .reputationGet(peerFp)
      .then((r) => { if (alive) setRep(r) })
      .catch(() => { /* reputação indisponível — ok */ })
    return () => { alive = false }
  }, [peerFp])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Avatar name={peerNick} fp={peerFp} size={44} />
        <div style={{ minWidth: 0 }}>
          <div style={{ color: themeColors.heading, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {peerNick}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <code style={{ color: themeColors.muted, fontSize: 12 }}>{peerFp}</code>
            {rep && (
              <span style={{
                fontSize: 11, color: TRUST_COLOR[rep.trust] ?? '#949ba4',
                border: `1px solid ${TRUST_COLOR[rep.trust] ?? '#949ba4'}`,
                borderRadius: 10, padding: '1px 8px',
              }}>
                {TRUST_LABEL[rep.trust] ?? rep.trust} · {rep.score}
              </span>
            )}
          </div>
        </div>
      </div>
      {err && <div style={{ color: '#ed4245', fontSize: 12 }}>verificação indisponível: {err}</div>}
      {safety && (
        <div style={{
          background: themeColors.main, border: `1px solid ${themeColors.border}`,
          borderRadius: 8, padding: 12,
        }}>
          <div style={{ fontSize: 11, color: themeColors.muted, marginBottom: 6 }}>
            Safety Number — compare por voz ou pessoalmente. Igual nos dois aparelhos = sem MITM.
          </div>
          <div style={{
            fontFamily: 'monospace', fontSize: 15, letterSpacing: 1,
            color: themeColors.heading, wordBreak: 'break-all', lineHeight: 1.8,
          }}>
            {safety}
          </div>
          <button
            style={{ ...btnStyle, marginTop: 8, minHeight: 44 }}
            onClick={async () => { setCopied(await copyText(safety)) }}
          >
            {copied ? 'copiado!' : 'copiar número'}
          </button>
        </div>
      )}
    </div>
  )
}

// ---------- 3. Campo de nome com validação em tempo real ----------

export interface NameFieldProps {
  kind: NameKind
  label: string
  existing?: string[]
  value: string
  onChange(value: string, valid: boolean): void
  autoFocus?: boolean
}

export function NameField({ kind, label, existing = [], value, onChange, autoFocus }: NameFieldProps) {
  const [errors, setErrors] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [checking, setChecking] = useState(false)
  const timer = useRef<number | null>(null)

  const runCheck = useCallback((v: string) => {
    // feedback instantâneo local; o core valida de novo no invoke
    const local = validateNameLocal(kind, v, existing)
    setErrors(local.errors)
    setSuggestions(local.suggestions)
    onChange(v, local.ok)
    // confirma com o core (regras do servidor incluídas) com debounce
    if (timer.current) window.clearTimeout(timer.current)
    setChecking(true)
    timer.current = window.setTimeout(() => {
      services
        .validateName(kind, v, existing)
        .then((r) => {
          setErrors(r.errors)
          setSuggestions(r.suggestions)
          onChange(r.normalized || v, r.ok)
        })
        .catch(() => { /* mantém resultado local */ })
        .finally(() => setChecking(false))
    }, 450)
  }, [kind, existing, onChange])

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <label style={{ fontSize: 12, color: themeColors.muted }}>{label}</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Avatar name={value || '?'} fp={skeleton(value || '?')} size={40} />
        <input
          style={{ ...inputStyle, flex: 1, minWidth: 0, minHeight: 44 }}
          value={value}
          autoFocus={autoFocus}
          maxLength={kind === 'server' ? 64 : 40}
          placeholder={kind === 'channel' ? 'avisos-gerais' : 'seu nome'}
          onChange={(e) => runCheck(e.target.value)}
        />
        <button
          title="Gerar nome aleatório"
          style={{ ...btnStyle, minHeight: 44, minWidth: 44 }}
          onClick={async () => {
            try {
              const n = await services.randomName()
              runCheck(n)
            } catch {
              runCheck(randomNameLocal())
            }
          }}
        >
          🎲
        </button>
      </div>
      {checking && <div style={{ fontSize: 11, color: themeColors.muted }}>verificando…</div>}
      {errors.length > 0 && (
        <div style={{ fontSize: 12, color: '#ed4245', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {errors.map((e, i) => <span key={i}>⚠ {e}</span>)}
        </div>
      )}
      {suggestions.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {suggestions.map((s) => (
            <button
              key={s}
              style={{ ...btnStyle, minHeight: 44, fontSize: 12 }}
              onClick={() => runCheck(s)}
            >
              usar {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- 4. Aviso pré-envio (link suspeito) ----------

export function sendWarning(body: string, spamLevel: string, blockedDomains: string[] = []): string | null {
  return warnBeforeSend(body, spamLevel === 'low' || spamLevel === 'high' ? spamLevel : 'medium', blockedDomains)
}

// ---------- 5. Botão denunciar / bloquear ----------

export function ReportButton({ targetFp, targetNick, communityId }: { targetFp: string; targetNick: string; communityId?: string }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      await services.reportUser(targetFp, communityId, reason.trim() || 'spam')
      setDone(`denúncia de ${targetNick} registrada`)
      setOpen(false)
      setReason('')
    } catch (e) {
      setDone(`falhou: ${errMsg(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button style={{ ...btnStyle, minHeight: 44 }} onClick={() => { setOpen(!open); setDone(null) }}>
        🚩 denunciar
      </button>
      {done && <div style={{ fontSize: 12, color: themeColors.muted, marginTop: 4 }}>{done}</div>}
      {open && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <input
            style={{ ...inputStyle, flex: 1, minWidth: 140, minHeight: 44 }}
            placeholder="motivo (opcional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button style={{ ...btnStyle, minHeight: 44 }} disabled={busy} onClick={submit}>
            {busy ? '…' : 'enviar'}
          </button>
        </div>
      )}
    </div>
  )
}

// ---------- 6. Painel de moderação do servidor ----------

const ACTION_LABEL: Record<ModerationAction, string> = {
  ban: 'banir',
  unban: 'desbanir',
  mute: 'silenciar',
  unmute: 'reativar',
  shadow_ban: 'shadow-ban',
  unshadow: 'tirar shadow-ban',
  delete_msg: 'apagar mensagem',
}

export function ModerationPanel({ communityId, isOwner }: { communityId: string; isOwner: boolean }) {
  const [rules, setRules] = useState<ServerRules | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState('')
  const [reason, setReason] = useState('')
  const [bannedInput, setBannedInput] = useState('')
  const [domainInput, setDomainInput] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([
        services.serverRulesGet(communityId),
        services.auditList(communityId, 50).catch(() => [] as AuditEntry[]),
      ])
      setRules(r)
      setAudit(a)
      setBannedInput(r.banned_words.join(', '))
      setDomainInput(r.blocked_domains.join(', '))
      setErr(null)
    } catch (e) {
      setErr(errMsg(e))
    }
  }, [communityId])

  useEffect(() => { refresh() }, [refresh])

  async function saveRules() {
    if (!rules) return
    setBusy(true)
    setErr(null)
    try {
      await services.serverRulesSet({
        ...rules,
        banned_words: bannedInput.split(',').map((w) => w.trim()).filter(Boolean),
        blocked_domains: domainInput.split(',').map((w) => w.trim()).filter(Boolean),
      })
      setOk('regras salvas')
      await refresh()
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function act(action: ModerationAction) {
    if (!target.trim()) {
      setErr('informe o fingerprint do alvo ou o id da mensagem')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await services.moderate(communityId, action, target.trim(), reason.trim())
      setOk(`${ACTION_LABEL[action]} aplicado`)
      setTarget('')
      setReason('')
      await refresh()
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  if (!rules) {
    return <div style={{ color: themeColors.muted, fontSize: 12 }}>{err ?? 'carregando moderação…'}</div>
  }

  const btn: React.CSSProperties = { ...btnStyle, minHeight: 44, fontSize: 12 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      {err && <div style={{ color: '#ed4245', fontSize: 12 }}>⚠ {err}</div>}
      {ok && <div style={{ color: '#57f287', fontSize: 12 }}>✓ {ok}</div>}

      <section>
        <h4 style={{ color: themeColors.heading, margin: '0 0 8px', fontSize: 13 }}>anti-spam</h4>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['low', 'medium', 'high'] as const).map((l) => (
            <button
              key={l}
              disabled={!isOwner}
              style={{
                ...btn,
                borderColor: rules.spam_level === l ? '#57f287' : undefined,
                opacity: !isOwner ? 0.6 : 1,
              }}
              onClick={() => setRules({ ...rules, spam_level: l })}
            >
              {l === 'low' ? 'baixo' : l === 'medium' ? 'médio' : 'alto'}
            </button>
          ))}
        </div>
        <label style={{ fontSize: 12, color: themeColors.muted, display: 'block', marginTop: 8 }}>
          palavras proibidas (separadas por vírgula)
        </label>
        <input
          style={{ ...inputStyle, width: '100%', minHeight: 44, marginTop: 4 }}
          value={bannedInput}
          disabled={!isOwner}
          onChange={(e) => setBannedInput(e.target.value)}
        />
        <label style={{ fontSize: 12, color: themeColors.muted, display: 'block', marginTop: 8 }}>
          domínios bloqueados (separados por vírgula)
        </label>
        <input
          style={{ ...inputStyle, width: '100%', minHeight: 44, marginTop: 4 }}
          value={domainInput}
          disabled={!isOwner}
          placeholder="evil.gg"
          onChange={(e) => setDomainInput(e.target.value)}
        />
        {isOwner && (
          <button style={{ ...btn, marginTop: 8 }} disabled={busy} onClick={saveRules}>
            {busy ? 'salvando…' : 'salvar regras'}
          </button>
        )}
        <div style={{ fontSize: 11, color: themeColors.muted, marginTop: 6 }}>
          moderadores: {rules.moderators.length} · shadow-ban: {rules.shadow_banned.length}
        </div>
      </section>

      <section>
        <h4 style={{ color: themeColors.heading, margin: '0 0 8px', fontSize: 13 }}>moderar</h4>
        <input
          style={{ ...inputStyle, width: '100%', minHeight: 44 }}
          placeholder="fingerprint do alvo (ou id da mensagem p/ apagar)"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <input
          style={{ ...inputStyle, width: '100%', minHeight: 44, marginTop: 6 }}
          placeholder="motivo (vai para a auditoria)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          {(Object.keys(ACTION_LABEL) as ModerationAction[]).map((a) => (
            <button key={a} style={btn} disabled={busy} onClick={() => act(a)}>
              {ACTION_LABEL[a]}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h4 style={{ color: themeColors.heading, margin: '0 0 8px', fontSize: 13 }}>
          auditoria ({audit.length})
        </h4>
        {audit.length === 0 && (
          <div style={{ fontSize: 12, color: themeColors.muted }}>nenhuma ação registrada</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
          {audit.map((e) => (
            <div
              key={e.id}
              style={{
                fontSize: 11, color: themeColors.muted,
                border: `1px solid ${themeColors.border}`, borderRadius: 6, padding: '6px 8px',
                wordBreak: 'break-all',
              }}
            >
              <b style={{ color: themeColors.heading }}>{e.action}</b>
              {' '}· alvo <code>{e.target_fp.slice(0, 12) || '—'}</code>
              {' '}· por <code>{e.actor_fp.slice(0, 12)}</code>
              {' '}· {new Date(e.created_at).toLocaleString()}
              {e.reason && <div>motivo: {e.reason}</div>}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
