// Painel de configuração de bot — 3 abas, validação por campo.
//
// O que mudou em relação à versão anterior (um formulário único de 560px com
// tudo empilhado):
//   • token mascarado por padrão, com olho/copiar/gerar-novo e confirmação
//     destrutiva explícita — o token nunca aparece inteiro por padrão nem vai
//     para o log;
//   • prefixo, avatar, cargo e status online na aba Credenciais;
//   • comandos REST viraram lista recolhível "N de 16", com teste POR comando
//     (antes só testava o primeiro da lista) e erro no campo, não num banner;
//   • escopos agrupados por categoria + webhook opcional na terceira aba;
//   • rodapé fixo com Cancelar/Salvar sempre visível;
//   • zero emoji: o avatar é inicial colorida derivada do id do bot.
//
// Este arquivo injeta um `<style>` próprio porque estado de hover /
// focus-visible / active não se expressa em `style` inline. Tudo que é
// clicável tem os quatro estados, e o modal cabe em 360px sem overflow
// horizontal (maxWidth 100%, rodapé e grade com flexWrap).

import { useEffect, useMemo, useRef, useState } from 'react'
import { services } from '../services'
import type { BotView, ChannelMeta, RoleView } from '../services/models'
import {
  parseBotConfig,
  renderTemplate,
  renderBotReply,
  type BotCommandDef,
} from '../services/botCommands'
import { groupByCategory } from '../app/channels'
import {
  Button,
  Card,
  EmptyState,
  IconButton,
  Modal,
  Notice,
  Select,
  TextArea,
  TextField,
  WIDTHS,
  helpStyle,
  ui,
} from '../shared/ui'
import { Ic, type IconName } from '../shared/icons'
import { Tooltip } from '../shared/Tooltip'

const FALLBACK_PREFIX = '!'
const MAX_COMMANDS = 16

// ---------- helpers ----------

let seq = 0
function nextUid(): string {
  seq += 1
  return `cmd-${seq}`
}

/** Linha de comando com id estável: remover a linha 1 não bagunça a linha 2. */
interface CmdRow extends BotCommandDef {
  uid: string
}

/** Avatar = inicial colorida derivada do id. Zero emoji, zero `BOT_AVATARS`. */
function avatarHue(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h % 360
}

function avatarColor(seed: string): string {
  return `hsl(${avatarHue(seed)}, 52%, 44%)`
}

function avatarInitial(name: string): string {
  const first = Array.from(name.trim())[0] ?? ''
  return first ? first.toUpperCase() : '?'
}

/** Mesma regra do backend (`parseBotConfig`): 1 caractere, sem espaço. */
function prefixError(prefix: string): string | null {
  if (!prefix) return 'escolha um caractere'
  if (!/^[!/.$@#%-]$/.test(prefix)) return 'use exatamente 1 caractere: ! / . $ @ # % -'
  return null
}

function urlError(url: string): string | null {
  if (!url.trim()) return 'informe a url'
  if (!/^https?:\/\/[^\s]+$/i.test(url.trim())) return 'precisa de uma url http:// ou https://'
  return null
}

function nameError(name: string): string | null {
  if (!name.trim()) return 'informe um nome (ex.: clima)'
  if (/\s/.test(name.trim())) return 'sem espaços — use hífen (ex.: bom-dia)'
  return null
}

function copyBestEffort(text: string): void {
  try {
    void navigator.clipboard?.writeText(text)?.catch(() => {})
  } catch {
    /* clipboard indisponível */
  }
}

/** Assinatura do estado editável — só para avisar "alterações não salvas". */
function signature(
  prefix: string,
  rows: CmdRow[],
  scope: string[],
  webhook: string,
  roleId: string,
  online: boolean,
): string {
  return JSON.stringify([
    prefix,
    rows.map((r) => [r.name, r.method, r.url, r.body ?? '', r.responsePath ?? '', r.template ?? '']),
    [...scope].sort(),
    webhook.trim(),
    roleId,
    online,
  ])
}

// ---------- css local (hover / focus-visible / active / disabled) ----------

const css = `
.bcp-tab{ appearance:none; background:transparent; border:1px solid transparent; border-radius:8px; color:${ui.muted}; font-size:13px; font-weight:700; padding:9px 12px; cursor:pointer; display:inline-flex; align-items:center; gap:7px; transition:background .15s, color .15s, border-color .15s }
.bcp-tab:hover:not(:disabled){ background:${ui.surfaceHover}; color:${ui.text} }
.bcp-tab:active:not(:disabled){ background:${ui.elevated} }
.bcp-tab[aria-selected="true"]{ background:rgba(88,101,242,.16); border-color:${ui.accent}; color:#fff }
.bcp-tab:focus-visible{ outline:2px solid ${ui.link}; outline-offset:2px }
.bcp-tab:disabled{ opacity:.45; cursor:not-allowed }

.bcp-row{ width:100%; display:flex; align-items:center; gap:10px; padding:10px 11px; background:${ui.surface}; border:1px solid ${ui.border}; border-radius:10px; color:${ui.text}; font-size:13px; cursor:pointer; text-align:left; transition:background .15s, border-color .15s }
.bcp-row:hover:not(:disabled){ background:${ui.surfaceHover}; border-color:${ui.borderStrong} }
.bcp-row:active:not(:disabled){ background:${ui.elevated} }
.bcp-row:focus-visible{ outline:2px solid ${ui.link}; outline-offset:2px }
.bcp-row:disabled{ opacity:.5; cursor:not-allowed }
.bcp-row[data-open="true"]{ border-color:${ui.accent}; background:${ui.surfaceHover} }
.bcp-row[data-bad="true"]{ border-color:${ui.danger} }

.bcp-check{ display:flex; align-items:center; gap:9px; padding:7px 9px; border-radius:8px; cursor:pointer; color:${ui.text}; font-size:13px; transition:background .15s }
.bcp-check:hover{ background:${ui.surfaceHover} }
.bcp-check input{ margin:0; width:16px; height:16px; flex-shrink:0; cursor:pointer; accent-color:${ui.accent} }
.bcp-check:focus-within{ box-shadow:0 0 0 2px ${ui.accent}66 }
.bcp-check[data-off="true"]{ color:${ui.muted} }

.bcp-cat{ display:flex; align-items:center; gap:7px; margin:14px 0 6px; font-size:11px; font-weight:800; letter-spacing:.6px; text-transform:uppercase; color:${ui.muted} }
.bcp-cat::after{ content:""; flex:1; height:1px; background:${ui.border} }

.bcp-chip{ display:inline-flex; align-items:center; gap:5px; padding:3px 8px; border-radius:99px; border:1px solid ${ui.border}; background:${ui.input}; color:${ui.muted}; font-size:10px; font-weight:800; letter-spacing:.4px; text-transform:uppercase; white-space:nowrap }
.bcp-chip[data-tone="ok"]{ color:#a5e5bd; background:rgba(35,165,89,.14); border-color:rgba(35,165,89,.5) }
.bcp-chip[data-tone="bad"]{ color:#ffb3b3; background:rgba(242,63,66,.14); border-color:rgba(242,63,66,.5) }
.bcp-chip[data-tone="warn"]{ color:#ffe0a3; background:rgba(240,178,50,.14); border-color:rgba(240,178,50,.5) }

.bcp-switch{ position:relative; width:46px; height:26px; flex-shrink:0; border-radius:99px; border:1px solid ${ui.borderStrong}; background:${ui.input}; cursor:pointer; padding:0; transition:background .15s, border-color .15s }
.bcp-switch::after{ content:""; position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%; background:${ui.muted}; transition:transform .15s, background .15s }
.bcp-switch[data-on="true"]{ background:rgba(35,165,89,.28); border-color:${ui.success} }
.bcp-switch[data-on="true"]::after{ transform:translateX(20px); background:${ui.success} }
.bcp-switch:hover:not(:disabled){ border-color:${ui.accent} }
.bcp-switch:active:not(:disabled)::after{ width:24px }
.bcp-switch:focus-visible{ outline:2px solid ${ui.link}; outline-offset:2px }
.bcp-switch:disabled{ opacity:.45; cursor:not-allowed }

.bcp-token{ font-family:'JetBrains Mono', monospace; font-size:13px; color:${ui.text}; word-break:break-all; background:${ui.input}; border:1px solid ${ui.border}; border-radius:${ui.radius}; padding:11px 12px; min-width:0 }

/* Hover/active por cima do Button/IconButton de ui.tsx, que fixam o background
   por style inline. O seletor é descendente e não "> button": o Tooltip insere
   um span entre o wrapper e o botão, então um seletor de filho direto nunca
   casaria com os botões só-de-ícone. */
.bcp-h-sec:hover button:not(:disabled){ background:${ui.surfaceHover} !important; border-color:${ui.borderStrong} !important }
.bcp-h-succ:hover button:not(:disabled){ background:${ui.successHover} !important }
.bcp-h-dan:hover button:not(:disabled){ background:${ui.dangerHover} !important }
.bcp-h-acc:hover button:not(:disabled){ background:${ui.accentHover} !important }
.bcp-h-ghost:hover button:not(:disabled){ background:${ui.surfaceHover} !important; color:${ui.heading} !important }
.bcp-h:active button:not(:disabled){ filter:brightness(.92) }

/* Abaixo de ~560px o título do Card e o botão de ação disputam a mesma linha e o
   título quebra uma palavra por linha. O cabeçalho do Card (primeiro div do
   section) passa a envolver e a ação desce para a linha de baixo. */
@media (max-width: 560px) {
  .bcp-panel section > div:first-child{ flex-wrap:wrap }
  /* Card fixa flex:1 / min-width:0 no titulo por style inline, entao o
     flex-basis precisa de !important para derrubar a acao para a linha de baixo. */
  .bcp-panel section > div:first-child > div{ flex-basis:100% !important }
}

.spin{ animation: spin .7s linear infinite }
@media (prefers-reduced-motion: reduce){ .spin{ animation:none } }
`

type TabId = 'credenciais' | 'comandos' | 'escopos'

const TABS: { id: TabId; label: string; icon: IconName }[] = [
  { id: 'credenciais', label: 'Credenciais', icon: 'key' },
  { id: 'comandos', label: 'Comandos', icon: 'terminal' },
  { id: 'escopos', label: 'Escopos e webhook', icon: 'plug' },
]

type TestState = { status: 'busy' | 'ok' | 'err'; text: string }

/**
 * Confirmação de ação destrutiva (gerar token novo, remover comando,
 * descartar edições). `uid: '__close__'` é o caso especial de fechar com
 * alterações não salvas — não é um comando, é o botão de fechar do painel.
 */
type Confirm =
  | { kind: 'regen'; title: string; body: string; confirmLabel: string }
  | { kind: 'remove'; uid: string; title: string; body: string; confirmLabel: string }
  | { kind: 'discard'; title: string; body: string; confirmLabel: string }
  | null

export default function BotConfigPanel({ communityId, bot, channels, onSaved, onClose }: {
  communityId: string
  bot: BotView
  channels: ChannelMeta[]
  onSaved: () => void
  onClose: () => void
}) {
  const initial = useMemo(() => parseBotConfig(bot.config ?? null), [bot.config])

  const [tab, setTab] = useState<TabId>('credenciais')
  const [prefix, setPrefix] = useState(initial?.prefix ?? FALLBACK_PREFIX)
  const [rows, setRows] = useState<CmdRow[]>(() =>
    (initial?.commands ?? []).map((c) => ({ ...c, uid: nextUid() })),
  )
  const [scope, setScope] = useState<string[]>(initial?.channels ?? [])
  const [webhookUrl, setWebhookUrl] = useState(initial?.webhook?.url ?? '')
  const [token, setToken] = useState(bot.token)
  const [roleId, setRoleId] = useState(bot.roleId ?? '')
  const [online, setOnline] = useState(bot.online)

  const [showToken, setShowToken] = useState(false)
  const [copied, setCopied] = useState(false)
  const [roles, setRoles] = useState<RoleView[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [saveAttempted, setSaveAttempted] = useState(false)
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [busy, setBusy] = useState(false)
  const [regenBusy, setRegenBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)

  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tablistRef = useRef<HTMLDivElement | null>(null)

  /**
   * Troca de aba e leva o foco junto. Sem mover o foco, a segunda pressa de
   * seta era calculada a partir do botão ainda focado (o antigo) e saltava para
   * a aba errada. A seta também deveria focar a nova aba, como todo tablist.
   */
  function goToTab(next: TabId) {
    setTab(next)
    const btn = tablistRef.current?.querySelector<HTMLButtonElement>(`#bcp-tab-${next}`)
    btn?.focus()
  }

  useEffect(() => {
    let alive = true
    services
      .rolesList(communityId)
      .then((r) => {
        if (alive && Array.isArray(r)) setRoles(r)
      })
      .catch(() => {
        /* lista de cargos é opcional: o select mostra só o cargo atual */
      })
    return () => {
      alive = false
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [communityId])

  // ---- Derivados: validação recalculada a cada tecla, nunca só no salvar ----

  /** Uma linha só conta como preenchida se o usuário começou a preenchê-la. */
  function rowUsed(r: CmdRow): boolean {
    return Boolean(r.name.trim() || r.url.trim() || r.body || r.template || r.responsePath)
  }

  function rowErrors(r: CmdRow): { name: string | null; url: string | null } {
    const mine = r.name.trim()
    const dup = mine !== '' && rows.some((o) => o.uid !== r.uid && o.name.trim() === mine)
    const n = nameError(r.name)
    return { name: n ?? (dup ? 'já existe um comando com esse nome' : null), url: urlError(r.url) }
  }

  /** O erro de uma linha só aparece depois que ela foi tocada (ou após salvar). */
  function rowShowError(uid: string): boolean {
    return saveAttempted || Boolean(touched[`${uid}:name`] || touched[`${uid}:url`])
  }

  const prefixErr = prefixError(prefix)
  const showPrefixErr = saveAttempted || Boolean(touched.prefix) || prefixErr !== null
  const hookErr = webhookUrl.trim() ? urlError(webhookUrl) : null
  const showHookErr = saveAttempted || Boolean(touched.webhook)

  const effectiveRows = useMemo(() => rows.filter(rowUsed), [rows])
  const invalidCount = rows.filter((r) => {
    const e = rowErrors(r)
    return rowUsed(r) && (e.name !== null || e.url !== null)
  }).length

  const groupedChannels = useMemo(() => groupByCategory(channels), [channels])

  // TODO(canal-duplicado): o chamador em ThemeShell.tsx:2725 monta `channels`
  // com um merge manual que devolve o mesmo canal duas vezes. A correção é
  // trocar esse merge por `mergeChannels` de src/app/channels.ts no chamador
  // (outro agente está nisso). Aqui consumimos `channels` como chega, agrupado
  // por `groupByCategory` — mascarar a duplicata aqui esconderia o bug.

  // ---- Comandos ----

  function touch(key: string) {
    setTouched((prev) => (prev[key] ? prev : { ...prev, [key]: true }))
  }

  function updateRow(uid: string, patch: Partial<BotCommandDef>) {
    setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)))
  }

  function addRow() {
    if (rows.length >= MAX_COMMANDS) return
    const uid = nextUid()
    setRows((prev) => [...prev, { uid, name: '', method: 'GET', url: '' }])
    setExpanded(uid)
  }

  function removeRow(uid: string) {
    setRows((prev) => prev.filter((r) => r.uid !== uid))
    setTests((prev) => {
      if (!(uid in prev)) return prev
      const next = { ...prev }
      delete next[uid]
      return next
    })
    setExpanded((cur) => (cur === uid ? null : cur))
  }

  function toggleScope(id: string) {
    setScope((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]))
  }

  // ---- Token ----

  function copyToken() {
    copyBestEffort(token)
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1800)
  }

  async function regenToken() {
    setConfirm(null)
    setFormError(null)
    setRegenBusy(true)
    try {
      const next = await services.botRegenToken(communityId, bot.id)
      setToken(next)
      setShowToken(true)
      setCopied(false)
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'não foi possível gerar um novo token')
    } finally {
      setRegenBusy(false)
    }
  }

  // ---- Teste POR comando (a versão antiga só testava o primeiro da lista) ----

  async function testRow(r: CmdRow) {
    const e = rowErrors(r)
    if (e.name || e.url) {
      setTests((prev) => ({
        ...prev,
        [r.uid]: { status: 'err', text: e.url ?? e.name ?? 'comando inválido' },
      }))
      return
    }
    setTests((prev) => ({ ...prev, [r.uid]: { status: 'busy', text: 'chamando a API…' } }))
    try {
      const url = renderTemplate(r.url, { args: ['teste'] })
      const res = await services.httpFetch(url, r.method, r.headers ?? {}, r.body ?? null, 10000)
      const reply = renderBotReply(r, ['teste'], res.body)
      const shown = (reply ?? '(sem resposta — verifique responsePath/template)').slice(0, 300)
      const ok = res.status >= 200 && res.status < 400
      setTests((prev) => ({
        ...prev,
        [r.uid]: { status: ok ? 'ok' : 'err', text: `HTTP ${res.status} · ${shown}` },
      }))
    } catch (err: unknown) {
      setTests((prev) => ({
        ...prev,
        [r.uid]: { status: 'err', text: err instanceof Error ? err.message : 'erro de rede' },
      }))
    }
  }

  // ---- Salvar ----

  /** Primeiro campo inválido, na ordem das abas — manda o usuário para lá. */
  function firstProblem(): { tab: TabId; msg: string } | null {
    if (prefixErr) return { tab: 'credenciais', msg: 'o prefixo precisa ser 1 caractere' }
    for (const r of rows) {
      if (!rowUsed(r)) continue
      const e = rowErrors(r)
      const what = r.name.trim() || 'sem nome'
      if (e.name) return { tab: 'comandos', msg: `comando "${what}": ${e.name}` }
      if (e.url) return { tab: 'comandos', msg: `comando "${what}": ${e.url}` }
    }
    if (hookErr) return { tab: 'escopos', msg: `webhook: ${hookErr}` }
    return null
  }

  async function save() {
    setSaveAttempted(true)
    setFormError(null)
    const problem = firstProblem()
    if (problem) {
      setTab(problem.tab)
      setFormError(problem.msg)
      return
    }
    const used = effectiveRows
    const payload = {
      prefix,
      commands: used.map((c) => ({
        name: c.name.trim(),
        method: c.method,
        url: c.url.trim(),
        headers: c.headers,
        body: c.body,
        responsePath: c.responsePath,
        template: c.template,
      })),
      channels: scope,
      webhook: webhookUrl.trim() ? { url: webhookUrl.trim() } : undefined,
    }
    const json = JSON.stringify(payload)
    const parsed = parseBotConfig(json)
    if (!parsed || parsed.commands.length !== used.length) {
      setTab('comandos')
      setFormError('algum comando foi descartado — revise nomes e urls http/https')
      return
    }
    setBusy(true)
    try {
      await services.botUpdate(communityId, bot.id, {
        config: json,
        roleId: roleId || null,
        online,
      })
      onSaved()
      onClose()
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'não foi possível salvar a configuração')
    } finally {
      setBusy(false)
    }
  }

  const isDirty =
    signature(prefix, rows, scope, webhookUrl, roleId, online) !==
    signature(
      initial?.prefix ?? FALLBACK_PREFIX,
      initial?.commands.map((c) => ({ ...c, uid: 'base' })) ?? [],
      initial?.channels ?? [],
      initial?.webhook?.url ?? '',
      bot.roleId ?? '',
      bot.online,
    )

  /** Só avisa antes de fechar/descartar se o usuário mudou alguma coisa. */
  function requestClose() {
    if (isDirty) {
      setConfirm({
        kind: 'discard',
        title: 'Descartar alterações?',
        body: 'Você mudou a configuração e não salvou. Fechar agora perde tudo o que foi editado aqui.',
        confirmLabel: 'Descartar e fechar',
      })
      return
    }
    onClose()
  }

  // ---------- render ----------

  const maskedToken = token.length > 8 ? `${token.slice(0, 8)}…${token.slice(-4)}` : token || '(sem token)'
  const roleOptions = [{ value: '', label: 'Sem cargo' }, ...roles.map((r) => ({ value: r.id, label: r.name }))]
  if (roleId && !roles.some((r) => r.id === roleId)) {
    roleOptions.push({ value: roleId, label: 'Cargo atual (fora da lista)' })
  }

  return (
    <Modal
      open
      onClose={requestClose}
      title={`Configurar ${bot.name}`}
      subtitle="Credenciais, comandos REST, escopos de canal e webhook."
      width={WIDTHS.lg}
      zIndex={95}
    >
      <style>{css}</style>

      {/* abas — fixas no topo enquanto o conteúdo rola */}
      <div
        ref={tablistRef}
        role="tablist"
        aria-label="Seções da configuração do bot"
        style={{
          position: 'sticky',
          top: -24,
          zIndex: 3,
          display: 'flex',
          flexWrap: 'wrap',
          gap: ui.xs,
          margin: `-${ui.xl}px -${ui.xl}px ${ui.lg}px`,
          padding: `0 ${ui.xl}px ${ui.md}px`,
          background: ui.bg,
          borderBottom: `1px solid ${ui.border}`,
        }}
      >
        {TABS.map((t) => {
          const selected = tab === t.id
          const badge =
            t.id === 'comandos' && rows.length > 0 ? rows.length : t.id === 'escopos' && scope.length > 0 ? scope.length : null
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`bcp-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`bcp-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              className="bcp-tab"
              onClick={() => goToTab(t.id)}
              onKeyDown={(e) => {
                const i = TABS.findIndex((x) => x.id === t.id)
                if (e.key === 'ArrowRight') goToTab(TABS[(i + 1) % TABS.length].id)
                else if (e.key === 'ArrowLeft') goToTab(TABS[(i - 1 + TABS.length) % TABS.length].id)
                else if (e.key === 'Home') goToTab(TABS[0].id)
                else if (e.key === 'End') goToTab(TABS[TABS.length - 1].id)
                else return
                e.preventDefault()
              }}
            >
              <Ic name={t.icon} size={15} />
              {t.label}
              {badge !== null && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 800,
                    padding: '1px 6px',
                    borderRadius: 99,
                    background: selected ? 'rgba(255,255,255,.2)' : ui.input,
                  }}
                >
                  {badge}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {formError && (
        <div style={{ marginBottom: ui.lg }}>
          <Notice tone="danger">{formError}</Notice>
        </div>
      )}

      {/* ---------------- ABA CREDENCIAIS ---------------- */}
      {tab === 'credenciais' && (
        <div className="bcp-panel" role="tabpanel" id="bcp-panel-credenciais" aria-labelledby="bcp-tab-credenciais">
          <Card title="Identidade" subtitle="Avatar, id e status do bot no servidor." icon="bot">
            <div style={{ display: 'flex', gap: ui.lg, alignItems: 'center', flexWrap: 'wrap' }}>
              <span
                aria-hidden="true"
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: avatarColor(bot.id || bot.name),
                  color: '#fff',
                  fontSize: 24,
                  fontWeight: 800,
                  textTransform: 'uppercase',
                  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.18)',
                }}
              >
                {avatarInitial(bot.name)}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: ui.heading }}>{bot.name}</div>
                <div style={{ ...helpStyle, marginTop: 2, wordBreak: 'break-all' }}>id {bot.id}</div>
                <span className="bcp-chip" data-tone={online ? 'ok' : 'mut'} style={{ marginTop: ui.sm }}>
                  {online ? 'online' : 'offline'}
                </span>
              </div>
            </div>
          </Card>

          <Card title="Token de acesso" subtitle="Segredo do bot. Só o dono do servidor gera outro." icon="key">
            <div style={{ display: 'flex', gap: ui.sm, alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="bcp-token" style={{ flex: '1 1 220px' }}>
                {showToken ? token || '(sem token)' : maskedToken}
              </div>
              <span className="bcp-h-ghost" style={{ display: 'inline-flex' }}>
                <Tooltip label={showToken ? 'Ocultar token' : 'Mostrar token'}>
                  <IconButton
                    icon={showToken ? 'eyeOff' : 'eye'}
                    label={showToken ? 'Ocultar token' : 'Mostrar token'}
                    onClick={() => setShowToken((v) => !v)}
                  />
                </Tooltip>
              </span>
              <span className="bcp-h-ghost" style={{ display: 'inline-flex' }}>
                <Tooltip label={copied ? 'Copiado' : 'Copiar token'}>
                  <IconButton
                    icon={copied ? 'checkDouble' : 'copy'}
                    label="Copiar token"
                    active={copied}
                    onClick={copyToken}
                  />
                </Tooltip>
              </span>
            </div>
            <div aria-live="polite" style={{ minHeight: 18, marginTop: ui.sm }}>
              {copied && (
                <span role="status" style={{ fontSize: 12, color: ui.success, fontWeight: 700 }}>
                  Copiado para a área de transferência.
                </span>
              )}
            </div>
            <div
              style={{
                marginTop: ui.md,
                paddingTop: ui.md,
                borderTop: `1px solid ${ui.border}`,
                display: 'flex',
                gap: ui.sm,
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <span className="bcp-h-dan" style={{ display: 'inline-flex' }}>
                <Button
                  variant="danger"
                  icon="refresh"
                  busy={regenBusy}
                  onClick={() =>
                    setConfirm({
                      kind: 'regen',
                      title: 'Gerar novo token?',
                      body:
                        'O token atual para de funcionar na hora, sem volta. Qualquer integração, ' +
                        'script ou webhook que use o token antigo vai começar a falhar até você ' +
                        'atualizar a credencial lá.',
                      confirmLabel: 'Gerar e invalidar o antigo',
                    })
                  }
                >
                  Gerar novo token
                </Button>
              </span>
              <span style={{ ...helpStyle, marginTop: 0, flex: '1 1 200px' }}>
                O token antigo morre assim que o novo é criado.
              </span>
            </div>
          </Card>

          <Card title="Comportamento" subtitle="Como o bot escuta e em que papel ele aparece." icon="settings">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: `0 ${ui.lg}` }}>
              <TextField
                label="Prefixo"
                value={prefix}
                maxLength={4}
                placeholder="!"
                ariaLabel="Prefixo dos comandos"
                hint="1 caractere, escrito antes do nome do comando."
                error={showPrefixErr ? prefixErr : null}
                onChange={(v) => {
                  touch('prefix')
                  setPrefix(v.slice(0, 4))
                }}
              />
              <Select
                label="Cargo do bot"
                value={roleId}
                options={roleOptions}
                ariaLabel="Cargo do bot"
                hint="Cargo que o bot usa para permissões no servidor."
                onChange={setRoleId}
              />
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: ui.md,
                paddingTop: ui.md,
                borderTop: `1px solid ${ui.border}`,
                flexWrap: 'wrap',
              }}
            >
              <button
                type="button"
                role="switch"
                aria-checked={online}
                aria-label="Bot online"
                className="bcp-switch"
                data-on={online}
                disabled={busy}
                onClick={() => setOnline((v) => !v)}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: ui.heading }}>Bot marcado como online</div>
                <div style={helpStyle}>Aparece na lista de membros como conectado.</div>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ---------------- ABA COMANDOS ---------------- */}
      {tab === 'comandos' && (
        <div className="bcp-panel" role="tabpanel" id="bcp-panel-comandos" aria-labelledby="bcp-tab-comandos">
          <Card
            title="Comandos REST"
            subtitle="Cada comando vira uma chamada HTTP quando alguém escreve o prefixo + o nome aqui no servidor."
            icon="terminal"
            action={
              <span className="bcp-h-acc" style={{ display: 'inline-flex' }}>
                <Button icon="plus" variant="primary" onClick={addRow} disabled={rows.length >= MAX_COMMANDS}>
                  Adicionar
                </Button>
              </span>
            }
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: ui.md, flexWrap: 'wrap', marginBottom: ui.md }}>
              <span className="bcp-chip" data-tone={invalidCount > 0 ? 'bad' : rows.length ? 'ok' : 'mut'} aria-live="polite">
                {rows.length} de {MAX_COMMANDS} comandos
              </span>
              {invalidCount > 0 && (
                <span style={{ fontSize: 12, color: '#ff9c9c', fontWeight: 700 }}>
                  {invalidCount} {invalidCount === 1 ? 'comando incompleto' : 'comandos incompletos'}
                </span>
              )}
              {rows.length >= MAX_COMMANDS && (
                <span style={{ ...helpStyle, marginTop: 0 }}>limite de {MAX_COMMANDS} atingido</span>
              )}
            </div>

            <div style={{ ...helpStyle, marginTop: 0, marginBottom: ui.md }}>
              Placeholders aceitos: {'{{args}} {{arg0}} {{query}} {{raw.args}} {{value}} {{json.campo}}'}
            </div>

            {rows.length === 0 ? (
              <EmptyState
                icon="terminal"
                title="Nenhum comando configurado"
                hint="Adicione o primeiro comando para o bot responder a mensagens. Sem comandos, ele só posta pelo webhook."
                action={
                  <span className="bcp-h-acc" style={{ display: 'inline-flex' }}>
                    <Button icon="plus" variant="primary" onClick={addRow}>
                      Adicionar comando
                    </Button>
                  </span>
                }
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: ui.sm }}>
                {rows.map((r, i) => {
                  const open = expanded === r.uid
                  const used = rowUsed(r)
                  const e = rowErrors(r)
                  const showErr = rowShowError(r.uid)
                  const test = tests[r.uid]
                  const label = r.name.trim() || `comando ${i + 1}`
                  return (
                    <div key={r.uid}>
                      <button
                        type="button"
                        className="bcp-row"
                        data-open={open}
                        data-bad={showErr && used && Boolean(e.name || e.url)}
                        aria-expanded={open}
                        aria-controls={`bcp-cmd-${r.uid}`}
                        onClick={() => setExpanded(open ? null : r.uid)}
                      >
                        <span style={{ color: ui.muted, display: 'inline-flex', flexShrink: 0 }}>
                          <Ic name="chevronRight" size={15} rotate={open ? 90 : 0} />
                        </span>
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontWeight: 700,
                            color: r.name.trim() ? ui.heading : ui.muted,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontFamily: 'JetBrains Mono, monospace',
                            fontSize: 13,
                          }}
                        >
                          {prefix}
                          {r.name.trim() || '…'}
                        </span>
                        <span className="bcp-chip">{r.method}</span>
                        {showErr && used && e.name && (
                          <span className="bcp-chip" data-tone="bad">
                            nome
                          </span>
                        )}
                        {showErr && used && e.url && (
                          <span className="bcp-chip" data-tone="bad">
                            url
                          </span>
                        )}
                        {!showErr && used && !e.name && !e.url && (
                          <span className="bcp-chip" data-tone="ok">
                            pronto
                          </span>
                        )}
                      </button>

                      {open && (
                        <div
                          id={`bcp-cmd-${r.uid}`}
                          style={{
                            marginTop: -1,
                            padding: `${ui.lg}px ${ui.md}px ${ui.md}px`,
                            border: `1px solid ${ui.border}`,
                            borderTop: 'none',
                            borderRadius: '0 0 10px 10px',
                            background: ui.input,
                          }}
                        >
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: `0 ${ui.lg}` }}>
                            <TextField
                              label="Nome"
                              value={r.name}
                              placeholder="clima"
                              mono
                              maxLength={32}
                              ariaLabel={`Nome do ${label}`}
                              error={showErr ? e.name : null}
                              onChange={(v) => {
                                touch(`${r.uid}:name`)
                                updateRow(r.uid, { name: v })
                              }}
                            />
                            <Select
                              label="Método"
                              value={r.method}
                              options={[
                                { value: 'GET', label: 'GET' },
                                { value: 'POST', label: 'POST' },
                              ]}
                              ariaLabel={`Método do ${label}`}
                              onChange={(v) => updateRow(r.uid, { method: v === 'POST' ? 'POST' : 'GET' })}
                            />
                          </div>

                          <TextField
                            label="URL"
                            value={r.url}
                            placeholder="https://api.exemplo.com/{{query}}"
                            mono
                            maxLength={512}
                            ariaLabel={`URL do ${label}`}
                            hint="Precisa ser http:// ou https://. Use {{query}} para a mensagem depois do comando."
                            error={showErr ? e.url : null}
                            onChange={(v) => {
                              touch(`${r.uid}:url`)
                              updateRow(r.uid, { url: v })
                            }}
                          />

                          {r.method === 'POST' && (
                            <TextArea
                              label="Corpo (POST)"
                              value={r.body ?? ''}
                              rows={2}
                              placeholder={'{"q":"{{query}}"}'}
                              ariaLabel={`Corpo do ${label}`}
                              onChange={(v) => updateRow(r.uid, { body: v })}
                            />
                          )}

                          <TextField
                            label="Caminho da resposta"
                            value={r.responsePath ?? ''}
                            placeholder="data.temp"
                            mono
                            ariaLabel={`Caminho da resposta do ${label}`}
                            hint="Caminho pontilhado no JSON. Vazio = usa o corpo inteiro."
                            onChange={(v) => updateRow(r.uid, { responsePath: v || undefined })}
                          />

                          <TextField
                            label="Template da resposta"
                            value={r.template ?? ''}
                            placeholder="{{value}}°C em {{query}}"
                            mono
                            ariaLabel={`Template de resposta do ${label}`}
                            hint="Como o bot escreve no canal. {{value}} é o que veio do caminho acima."
                            onChange={(v) => updateRow(r.uid, { template: v || undefined })}
                          />

                          <div
                            style={{
                              display: 'flex',
                              gap: ui.sm,
                              alignItems: 'center',
                              flexWrap: 'wrap',
                              paddingTop: ui.sm,
                              borderTop: `1px solid ${ui.border}`,
                            }}
                          >
                            <span className="bcp-h-sec" style={{ display: 'inline-flex' }}>
                              <Button icon="send" busy={test?.status === 'busy'} onClick={() => void testRow(r)}>
                                Testar
                              </Button>
                            </span>
                            <span className="bcp-h-ghost" style={{ display: 'inline-flex' }}>
                              <Button
                                variant="ghost"
                                icon="trash"
                                onClick={() =>
                                  setConfirm({
                                    kind: 'remove',
                                    uid: r.uid,
                                    title: `Remover ${label}?`,
                                    body: `O comando ${label} sai da lista quando você salvar. Para desfazer seria preciso digitar tudo de novo.`,
                                    confirmLabel: 'Remover comando',
                                  })
                                }
                              >
                                Remover
                              </Button>
                            </span>
                          </div>

                          <div aria-live="polite" style={{ marginTop: ui.md }}>
                            {test && (
                              <Notice
                                tone={test.status === 'ok' ? 'success' : test.status === 'busy' ? 'info' : 'danger'}
                                icon={test.status === 'busy' ? 'refresh' : test.status === 'ok' ? 'check' : 'warn'}
                              >
                                {test.status === 'busy' ? (
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: ui.sm }}>
                                    <span className="spin" style={{ display: 'inline-flex' }}>
                                      <Ic name="refresh" size={14} />
                                    </span>
                                    {test.text}
                                  </span>
                                ) : (
                                  <span style={{ wordBreak: 'break-word' }}>{test.text}</span>
                                )}
                              </Notice>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ---------------- ABA ESCOPOS E WEBHOOK ---------------- */}
      {tab === 'escopos' && (
        <div className="bcp-panel" role="tabpanel" id="bcp-panel-escopos" aria-labelledby="bcp-tab-escopos">
          <Card
            title="Canais onde o bot responde"
            subtitle="Agrupado por categoria. Nada marcado = o bot reage em todos os canais."
            icon="hash"
          >
            {scope.length === 0 ? (
              <div style={{ marginBottom: ui.lg }}>
                <Notice tone="warning" icon="info">
                  Nenhum canal marcado: o bot age em <b>todos</b> os canais deste servidor, inclusive os que
                  você criar depois. Marque os canais para limitar o alcance.
                </Notice>
              </div>
            ) : (
              <div style={{ marginBottom: ui.lg, display: 'flex', gap: ui.md, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="bcp-chip" data-tone="ok" aria-live="polite">
                  {scope.length} {scope.length === 1 ? 'canal liberado' : 'canais liberados'}
                </span>
                <span className="bcp-h-ghost" style={{ display: 'inline-flex' }}>
                  <Button variant="ghost" icon="minus" onClick={() => setScope([])}>
                    Limpar seleção
                  </Button>
                </span>
              </div>
            )}

            {channels.length === 0 ? (
              <EmptyState
                icon="hash"
                title="Nenhum canal neste servidor"
                hint="Crie um canal para poder limitar o bot a ele. Enquanto isso o escopo fica aberto para todos."
              />
            ) : (
              <div style={{ maxHeight: 300, overflowY: 'auto', paddingRight: 2 }}>
                {groupedChannels.map((g) => (
                  <div key={g.category}>
                    <div className="bcp-cat">
                      <Ic name="folder" size={13} />
                      {g.category}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 2 }}>
                      {g.channels.map((ch) => {
                        const on = scope.includes(ch.id)
                        return (
                          <label key={ch.id} className="bcp-check" data-off={!on}>
                            <input type="checkbox" checked={on} onChange={() => toggleScope(ch.id)} />
                            <span style={{ display: 'inline-flex', flexShrink: 0, color: on ? ui.text : ui.muted }}>
                              <Ic
                                name={
                                  ch.kind === 'voice'
                                    ? 'speaker'
                                    : ch.kind === 'video'
                                      ? 'video'
                                      : ch.kind === 'forum'
                                        ? 'tag'
                                        : 'hash'
                                }
                                size={14}
                              />
                            </span>
                            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {ch.name}
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Webhook de saída" subtitle="Opcional. Cada mensagem do escopo vira um POST." icon="webhook">
            <TextField
              label="URL do webhook"
              value={webhookUrl}
              placeholder="https://meu-servidor.exemplo/hook"
              mono
              maxLength={512}
              ariaLabel="URL do webhook"
              hint="Deixe em branco para desligar. Quando preenchida, precisa ser http:// ou https://."
              error={showHookErr ? hookErr : null}
              onChange={(v) => {
                touch('webhook')
                setWebhookUrl(v)
              }}
            />
            {webhookUrl.trim() && (
              <Notice tone="info">
                O token do bot <b>não</b> é enviado para o webhook — só autor, nickname, canal, corpo e data.
                Aponte para um endpoint seu.
              </Notice>
            )}
          </Card>
        </div>
      )}

      {/* ---------------- RODAPÉ FIXO ---------------- */}
      <div
        style={{
          position: 'sticky',
          bottom: -24,
          zIndex: 3,
          display: 'flex',
          gap: ui.sm,
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'flex-end',
          margin: `${ui.xl}px -${ui.xl}px -${ui.xl}px`,
          padding: `${ui.md}px ${ui.xl}px`,
          background: ui.bg,
          borderTop: `1px solid ${ui.border}`,
        }}
      >
        {isDirty && (
          <span
            style={{
              ...helpStyle,
              marginTop: 0,
              marginRight: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Ic name="info" size={13} />
            alterações não salvas
          </span>
        )}
        <span className="bcp-h-sec" style={{ display: 'inline-flex' }}>
          <Button onClick={requestClose} disabled={busy}>
            Cancelar
          </Button>
        </span>
        <span className="bcp-h-succ" style={{ display: 'inline-flex' }}>
          <Button variant="success" icon="save" busy={busy} onClick={() => void save()}>
            {busy ? 'Salvando…' : 'Salvar'}
          </Button>
        </span>
      </div>

      {/* ---------------- CONFIRMAÇÕES DESTRUTIVAS ---------------- */}
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.title ?? ''}
        width={WIDTHS.sm}
        zIndex={110}
        footer={
          <>
            <span className="bcp-h-sec" style={{ display: 'inline-flex' }}>
              <Button onClick={() => setConfirm(null)}>Voltar</Button>
            </span>
            <span className="bcp-h-dan" style={{ display: 'inline-flex' }}>
              <Button
                variant="danger"
                busy={regenBusy}
                onClick={() => {
                  if (!confirm) return
                  // O diálogo fecha em TODOS os caminhos: confirmar apagar um
                  // comando deixava o modal aberto por cima do painel.
                  if (confirm.kind === 'regen') {
                    setConfirm(null)
                    void regenToken()
                  } else if (confirm.kind === 'discard') {
                    onClose()
                  } else {
                    removeRow(confirm.uid)
                    setConfirm(null)
                  }
                }}
              >
                {confirm?.confirmLabel ?? 'Confirmar'}
              </Button>
            </span>
          </>
        }
      >
        <Notice tone={confirm?.kind === 'discard' ? 'warning' : 'danger'}>{confirm?.body ?? ''}</Notice>
      </Modal>
    </Modal>
  )
}
