import { useEffect, useMemo, useRef, useState } from 'react'
import type { BotBridgeInfo, BotBridgeStatus, BotLogView, BotPluginStatus, BotView, ChannelMeta } from '../../services/models'
import { services } from '../../services'
import {
  BOT_ADMIN_ACTIONS,
  BOT_EVENTS,
  BOT_PERM_DEFS,
  BOT_PERM_ALL,
  parseBotConfig,
  serializeBotConfig,
  defaultBotConfig,
  commandProblem,
  normalizeBotCommandName,
  urlProblem,
  type BotCommandDef,
  type BotExec,
  type BotConfig,
} from '../../services/botCommands'
import { Button, Card, EmptyState, Notice, Select, TextArea, TextField, helpStyle, ui } from '../../shared/ui'
import { Ic, type IconName } from '../../shared/icons'

const css = `
.botp-tabs{ display:flex; flex-wrap:wrap; gap:4px; padding-bottom:10px; border-bottom:1px solid ${ui.border}; margin-bottom:14px }
.botp-tab{ appearance:none; background:transparent; border:1px solid transparent; border-radius:8px; color:${ui.muted}; font-size:12.5px; font-weight:700; padding:8px 11px; cursor:pointer; display:inline-flex; align-items:center; gap:6px }
.botp-tab:hover{ background:${ui.surfaceHover}; color:${ui.text} }
.botp-tab[aria-selected="true"]{ background:rgba(88,101,242,.16); border-color:${ui.accent}; color:#fff }
.botp-tab:focus-visible{ outline:2px solid ${ui.link}; outline-offset:2px }
.botp-row{ width:100%; display:flex; align-items:center; gap:9px; padding:9px 10px; background:${ui.surface}; border:1px solid ${ui.border}; border-radius:9px; color:${ui.text}; font-size:12.5px; cursor:pointer; text-align:left }
.botp-row:hover{ background:${ui.surfaceHover}; border-color:${ui.borderStrong} }
.botp-row[data-open="true"]{ border-color:${ui.accent}; background:${ui.surfaceHover} }
.botp-chip{ display:inline-flex; align-items:center; gap:4px; padding:2px 7px; border-radius:99px; border:1px solid ${ui.border}; background:${ui.input}; color:${ui.muted}; font-size:9.5px; font-weight:800; letter-spacing:.4px; text-transform:uppercase; white-space:nowrap }
.botp-chip[data-tone="ok"]{ color:#a5e5bd; background:rgba(35,165,89,.14); border-color:rgba(35,165,89,.5) }
.botp-chip[data-tone="bad"]{ color:#ffb3b3; background:rgba(242,63,66,.14); border-color:rgba(242,63,66,.5) }
.botp-chip[data-tone="warn"]{ color:#ffe0a3; background:rgba(240,178,50,.14); border-color:rgba(240,178,50,.5) }
.botp-console{ font-family:'JetBrains Mono',ui-monospace,monospace; font-size:11.5px; background:#15171b; border:1px solid ${ui.border}; border-radius:8px; padding:9px 10px; max-height:260px; overflow-y:auto; white-space:pre-wrap; word-break:break-word }
.botp-line{ display:flex; gap:7px; padding:1px 0 }
.botp-line[data-level="error"]{ color:#ff9c9c }
.botp-line[data-level="warn"]{ color:#ffe0a3 }
.botp-mono{ font-family:'JetBrains Mono',ui-monospace,monospace }

/* Painel: navegação lateral fixa + conteúdo com rolagem própria. Antes o
   componente era despejado solto na página, por cima da interface. */
.botp-overlay{ position:fixed; inset:0; z-index:95; background:rgba(0,0,0,.72); display:flex; align-items:center; justify-content:center; padding:16px }
.botp-shell{ width:100%; max-width:1060px; height:min(92vh,900px); display:flex; flex-direction:column; background:${ui.bg}; border:1px solid ${ui.border}; border-radius:12px; overflow:hidden; box-shadow:0 24px 64px rgba(0,0,0,.55) }
.botp-head{ display:flex; align-items:center; gap:10px; padding:14px 18px; border-bottom:1px solid ${ui.border}; flex-shrink:0 }
.botp-body{ flex:1; display:flex; min-height:0 }
.botp-nav{ width:196px; flex-shrink:0; border-right:1px solid ${ui.border}; padding:10px 8px; display:flex; flex-direction:column; gap:2px; overflow-y:auto; background:${ui.surface} }
.botp-navbtn{ appearance:none; display:flex; align-items:center; gap:9px; width:100%; padding:9px 10px; border:none; border-radius:7px; background:transparent; color:${ui.muted}; font-size:13px; font-weight:600; cursor:pointer; text-align:left; font-family:inherit }
.botp-navbtn:hover{ background:${ui.surfaceHover}; color:${ui.text} }
.botp-navbtn[aria-selected="true"]{ background:${ui.accent}; color:#fff }
.botp-navbtn .botp-navcount{ margin-left:auto; font-size:10.5px; font-weight:800; opacity:.75 }
.botp-main{ flex:1; min-width:0; overflow-y:auto; padding:18px 20px }
.botp-foot{ display:flex; align-items:center; gap:8px; padding:12px 18px; border-top:1px solid ${ui.border}; flex-shrink:0; background:${ui.surface} }
@media (max-width: 720px){
  .botp-shell{ height:96vh; max-height:96vh }
  .botp-body{ flex-direction:column }
  .botp-nav{ width:100%; flex-direction:row; overflow-x:auto; border-right:none; border-bottom:1px solid ${ui.border}; padding:8px }
  .botp-navbtn{ white-space:nowrap; width:auto }
  .botp-navbtn .botp-navcount{ margin-left:6px }
}
`

type Tab = 'comandos' | 'permissoes' | 'eventos' | 'runtime' | 'console'

export function BotPanel({
  communityId,
  bot,
  channels,
  onSaved,
  onClose,
}: {
  communityId: string
  bot: BotView
  channels: ChannelMeta[]
  onSaved: () => void
  onClose: () => void
}) {
  const initial = useMemo(() => parseBotConfig(bot.config ?? null) ?? defaultBotConfig(), [bot.config])
  const [tab, setTab] = useState<Tab>('comandos')
  const [cfg, setCfg] = useState<BotConfig>(initial)
  const [perms, setPerms] = useState<number>(bot.perms ?? 0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const [bridge, setBridge] = useState<BotBridgeInfo | null>(null)
  const [bridgeStatus, setBridgeStatus] = useState<BotBridgeStatus | null>(null)
  const [plugin, setPlugin] = useState<BotPluginStatus | null>(null)
  const [logs, setLogs] = useState<BotLogView[]>([])
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [folderDir, setFolderDir] = useState('')
  const [folderRun, setFolderRun] = useState('')
  const consoleRef = useRef<HTMLDivElement | null>(null)

  const hasNative = typeof services.botBridgeStart === 'function'

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!alive) return
      try {
        const st = await services.botBridgeStatus!(communityId, bot.id)
        if (alive && st) {
          setBridgeStatus(st)
            setBridge((prev) => prev ?? { bot_id: bot.id, community_id: communityId, url: st.url ?? '', port: st.port ?? 0, started_at: 0 })
        }
        const pl = await services.botPluginStatus!(communityId, bot.id)
        if (alive) setPlugin(pl)
        const lg = await services.botLogs!(communityId, bot.id, 120)
        if (alive) setLogs(lg)
      } catch {}
    })()
    return () => {
      alive = false
    }
  }, [communityId, bot.id])

  useEffect(() => {
    if (tab !== 'runtime' && tab !== 'console') return
    const timer = setInterval(() => {
      void (async () => {
        try {
          const st = await services.botBridgeStatus?.(communityId, bot.id)
          setBridgeStatus(st ?? null)
          const pl = await services.botPluginStatus?.(communityId, bot.id)
          setPlugin(pl ?? null)
          if (tab === 'console') {
            const lg = await services.botLogs?.(communityId, bot.id, 120)
            setLogs(lg ?? [])
          }
        } catch {}
      })()
    }, 2500)
    return () => clearInterval(timer)
  }, [tab, communityId, bot.id])

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight
  }, [logs, plugin])

  function patchCmd(index: number, patch: Partial<BotCommandDef>) {
    setCfg((prev) => ({
      ...prev,
      commands: prev.commands.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }))
  }

  function addCommand() {
    const n = cfg.commands.length + 1
    setCfg((prev) => ({
      ...prev,
      commands: [
        ...prev.commands,
        { name: `comando-${n}`, method: 'GET', url: '', exec: 'reply', reply: '', cooldownMs: 1500 },
      ],
    }))
    setExpanded(`cmd-${n}`)
  }

  function removeCommand(index: number) {
    setCfg((prev) => ({ ...prev, commands: prev.commands.filter((_, i) => i !== index) }))
  }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const json = serializeBotConfig(cfg)
      const problem = cfg.commands
        .map((c, i) => commandProblem(c, cfg.commands.filter((_, j) => j !== i)))
        .find(Boolean)
      if (problem) throw new Error(problem)
      for (const c of cfg.commands) {
        if (c.exec === 'http') {
          const p = urlProblem(c.url, cfg.blockPrivate)
          if (p) throw new Error(`/${c.name}: ${p}`)
        }
      }
      await services.botUpdate(communityId, bot.id, { config: json, perms })
      setSavedAt(Date.now())
      onSaved()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function startBridge() {
    setRuntimeBusy(true)
    setRuntimeError(null)
    try {
      if (!services.botBridgeStart) throw new Error('a ponte local só existe no app nativo')
      const info = await services.botBridgeStart(communityId, bot.id)
      setBridge(info)
      const st = await services.botBridgeStatus!(communityId, bot.id)
      setBridgeStatus(st ?? null)
    } catch (e: unknown) {
      setRuntimeError(e instanceof Error ? e.message : String(e))
    } finally {
      setRuntimeBusy(false)
    }
  }

  async function stopBridge() {
    setRuntimeBusy(true)
    setRuntimeError(null)
    try {
      await services.botPluginStop?.(communityId, bot.id)
      await services.botBridgeStop?.(communityId, bot.id)
      setBridge(null)
      setBridgeStatus(null)
      setPlugin(null)
    } catch (e: unknown) {
      setRuntimeError(e instanceof Error ? e.message : String(e))
    } finally {
      setRuntimeBusy(false)
    }
  }

  async function startPlugin() {
    if (!bridge) {
      setRuntimeError('abra a ponte local primeiro')
      return
    }
    setRuntimeBusy(true)
    setRuntimeError(null)
    try {
      if (!folderDir.trim()) throw new Error('informe a pasta do bot')
      if (!folderRun.trim()) throw new Error('informe o comando de execução (ex.: node bot.js)')
      const st = await services.botPluginStart!(communityId, bot.id, folderDir.trim(), folderRun.trim())
      setPlugin(st)
    } catch (e: unknown) {
      setRuntimeError(e instanceof Error ? e.message : String(e))
    } finally {
      setRuntimeBusy(false)
    }
  }

  async function clearLogs() {
    try {
      await services.botLogsClear?.(communityId, bot.id)
      setLogs([])
    } catch {}
  }

  const dirty = useMemo(
    () => JSON.stringify(cfg) !== JSON.stringify(initial) || perms !== (bot.perms ?? 0),
    [cfg, initial, perms, bot.perms],
  )

  const tabs: { id: Tab; label: string; icon: IconName; count?: number }[] = [
    { id: 'comandos', label: 'Comandos', icon: 'terminal', count: cfg.commands.length },
    { id: 'permissoes', label: 'Permissões', icon: 'shield' as IconName },
    { id: 'eventos', label: 'Eventos', icon: 'plug', count: cfg.events.length },
    { id: 'runtime', label: 'Ponte e plugin', icon: 'globe' },
    { id: 'console', label: 'Console', icon: 'file' },
  ]

  return (
    <div
      className="botp-overlay"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <style>{css}</style>
      <div
        className="botp-shell"
        role="dialog"
        aria-modal="true"
        aria-label={`Configurar ${bot.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="botp-head">
          <span
            aria-hidden="true"
            style={{
              width: 34,
              height: 34,
              borderRadius: '50%',
              background: `${ui.accent}33`,
              border: `2px solid ${ui.accent}`,
              color: ui.accent,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              flexShrink: 0,
            }}
          >
            {bot.avatar && bot.avatar.length <= 2 ? bot.avatar : bot.name.charAt(0).toUpperCase()}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 15, fontWeight: 800, color: ui.heading }}>{bot.name}</span>
              <span className="botp-chip">bot · #{bot.discriminator}</span>
              <span className="botp-chip" data-tone={bot.online ? 'ok' : 'mut'}>
                {bot.online ? 'online' : 'offline'}
              </span>
              {bridgeStatus?.running && (
                <span className="botp-chip" data-tone="ok">ponte {bridgeStatus.port}</span>
              )}
              {plugin?.running && (
                <span className="botp-chip" data-tone="ok">plugin {plugin.pid}</span>
              )}
              {dirty && <span className="botp-chip" data-tone="warn">não salvo</span>}
            </div>
          </div>
          <Button variant="ghost" icon="x" onClick={onClose} ariaLabel="Fechar painel do bot" />
        </div>

        <div className="botp-body">
          <nav className="botp-nav" role="tablist" aria-label="Seções do bot">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className="botp-navbtn"
                onClick={() => setTab(t.id)}
              >
                <Ic name={t.icon} size={14} />
                {t.label}
                {t.count !== undefined && t.count > 0 && (
                  <span className="botp-navcount">{t.count}</span>
                )}
              </button>
            ))}
          </nav>

          <div className="botp-main">
            {error && (
              <div style={{ marginBottom: ui.md }}>
                <Notice tone="danger">{error}</Notice>
              </div>
            )}
            {savedAt !== null && !error && (
              <div style={{ marginBottom: ui.md }}>
                <Notice tone="success">Configuração salva e validada pelo core.</Notice>
              </div>
            )}

      {tab === 'comandos' && (
        <>
          <Card
            title="Comandos"
            subtitle="Cada comando é uma resposta fixa, uma chamada HTTP, um script ou uma ação administrativa."
            icon="terminal"
            action={
              <Button icon="plus" variant="primary" onClick={addCommand}>
                Adicionar comando
              </Button>
            }
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: `0 ${ui.lg}` }}>
              <TextField
                label="Prefixo"
                value={cfg.prefix}
                maxLength={1}
                mono
                ariaLabel="Prefixo dos comandos"
                hint="1 caractere: ! / . $ @ # % -"
                onChange={(v) => setCfg((p) => ({ ...p, prefix: v.slice(0, 1) || '!' }))}
              />
              <TextField
                label="Respostas por minuto"
                value={String(cfg.maxRepliesPerMinute)}
                ariaLabel="Limite de respostas por minuto"
                hint="Rate limit do runtime (1 a 120)."
                onChange={(v) => setCfg((p) => ({ ...p, maxRepliesPerMinute: Math.max(1, Math.min(120, Number(v) || 20)) }))}
              />
            </div>

            {cfg.commands.length === 0 ? (
              <EmptyState
                icon="terminal"
                title="Nenhum comando ainda"
                hint="Crie /ajuda, /ping ou /cep para começar. Sem comandos, o bot só reage aos eventos marcados."
                action={<Button icon="plus" variant="primary" onClick={addCommand}>Criar o primeiro</Button>}
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: ui.sm }}>
                {cfg.commands.map((c, i) => {
                  const uid = `cmd-${i}`
                  const open = expanded === uid
                  const problem = commandProblem(c, cfg.commands.filter((_, j) => j !== i))
                  return (
                    <div key={uid}>
                      <button
                        type="button"
                        className="botp-row"
                        data-open={open}
                        aria-expanded={open}
                        onClick={() => setExpanded(open ? null : uid)}
                      >
                        <Ic name="chevronRight" size={14} rotate={open ? 90 : 0} />
                        <span className="botp-mono" style={{ flex: 1, minWidth: 0, fontWeight: 700, color: ui.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {cfg.prefix}
                          {c.name || '…'}
                        </span>
                        <span className="botp-chip">{c.exec ?? 'reply'}</span>
                        {c.permission ? <span className="botp-chip" data-tone="warn">{c.permission}</span> : null}
                        {problem ? <span className="botp-chip" data-tone="bad">revisar</span> : <span className="botp-chip" data-tone="ok">pronto</span>}
                      </button>

                      {open && (
                        <div style={{ marginTop: -1, padding: `${ui.lg}px ${ui.md}px ${ui.md}px`, border: `1px solid ${ui.border}`, borderTop: 'none', borderRadius: '0 0 9px 9px', background: ui.input }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: `0 ${ui.lg}` }}>
                            <TextField
                              label="Nome"
                              value={c.name}
                              mono
                              maxLength={32}
                              ariaLabel={`Nome do comando ${i + 1}`}
                              onChange={(v) => patchCmd(i, { name: normalizeBotCommandName(v) })}
                            />
                            <Select
                              label="Tipo"
                              value={c.exec ?? 'reply'}
                              ariaLabel={`Tipo do comando ${i + 1}`}
                              options={[
                                { value: 'reply', label: 'Resposta fixa' },
                                { value: 'http', label: 'Chamar API (HTTP)' },
                                { value: 'script', label: 'Script (DSL)' },
                                { value: 'admin', label: 'Ação administrativa' },
                              ]}
                              onChange={(v) => patchCmd(i, { exec: v as BotExec })}
                            />
                            <Select
                              label="Permissão exigida"
                              value={c.permission ?? ''}
                              ariaLabel={`Permissão do comando ${i + 1}`}
                              options={[
                                { value: '', label: 'Todos' },
                                { value: 'moderate', label: 'Moderador' },
                                { value: 'manage', label: 'Gerenciar' },
                                { value: 'owner', label: 'Só o dono' },
                              ]}
                              onChange={(v) => patchCmd(i, { permission: v as BotCommandDef['permission'] })}
                            />
                            <TextField
                              label="Cooldown (ms)"
                              value={String(c.cooldownMs ?? 1500)}
                              ariaLabel={`Cooldown do comando ${i + 1}`}
                              hint="Por autor, por comando."
                              onChange={(v) => patchCmd(i, { cooldownMs: Math.max(0, Number(v) || 0) })}
                            />
                          </div>

                          <TextField
                            label="Aliases (separados por vírgula)"
                            value={(c.aliases ?? []).join(', ')}
                            mono
                            ariaLabel={`Aliases do comando ${i + 1}`}
                            onChange={(v) =>
                              patchCmd(i, {
                                aliases: v.split(',').map((s) => normalizeBotCommandName(s)).filter(Boolean).slice(0, 4),
                              })
                            }
                          />

                          {(c.exec ?? 'reply') === 'reply' && (
                            <TextArea
                              label="Resposta"
                              value={c.reply ?? ''}
                              rows={3}
                              ariaLabel={`Resposta do comando ${i + 1}`}
                              hint="Placeholders: {{args}} {{arg0}} {{raw.args}} {{author}}"
                              onChange={(v) => patchCmd(i, { reply: v })}
                            />
                          )}

                          {c.exec === 'http' && (
                            <>
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: `0 ${ui.lg}` }}>
                                <Select
                                  label="Método"
                                  value={c.method}
                                  ariaLabel={`Método do comando ${i + 1}`}
                                  options={[{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }]}
                                  onChange={(v) => patchCmd(i, { method: v === 'POST' ? 'POST' : 'GET' })}
                                />
                                <TextField
                                  label="Caminho da resposta"
                                  value={c.responsePath ?? ''}
                                  mono
                                  ariaLabel={`Caminho da resposta do comando ${i + 1}`}
                                  onChange={(v) => patchCmd(i, { responsePath: v || undefined })}
                                />
                              </div>
                              <TextField
                                label="URL"
                                value={c.url}
                                mono
                                ariaLabel={`URL do comando ${i + 1}`}
                                hint="http(s). Use {{query}} para os argumentos."
                                error={c.url ? urlProblem(c.url, cfg.blockPrivate) : null}
                                onChange={(v) => patchCmd(i, { url: v })}
                              />
                              {c.method === 'POST' && (
                                <TextArea
                                  label="Corpo (POST)"
                                  value={c.body ?? ''}
                                  rows={2}
                                  ariaLabel={`Corpo do comando ${i + 1}`}
                                  onChange={(v) => patchCmd(i, { body: v || undefined })}
                                />
                              )}
                              <TextField
                                label="Template da resposta"
                                value={c.template ?? ''}
                                mono
                                ariaLabel={`Template do comando ${i + 1}`}
                                hint="{{value}} é o campo do caminho; {{json.campo}} busca direto no corpo."
                                onChange={(v) => patchCmd(i, { template: v || undefined })}
                              />
                            </>
                          )}

                          {c.exec === 'admin' && (
                            <Select
                              label="Ação"
                              value={c.admin ?? ''}
                              ariaLabel={`Ação administrativa do comando ${i + 1}`}
                              options={[
                                { value: '', label: 'Escolha a ação' },
                                ...BOT_ADMIN_ACTIONS.map((a) => ({ value: a.action, label: `/${a.action} — ${a.label}` })),
                              ]}
                              hint="A permissão da ação precisa estar concedida na aba Permissões."
                              onChange={(v) => patchCmd(i, { admin: v || undefined })}
                            />
                          )}

                          {c.exec === 'script' && (
                            <TextArea
                              label="Script (DSL)"
                              value={c.script ?? ''}
                              rows={8}
                              ariaLabel={`Script do comando ${i + 1}`}
                              hint={'Uma instrução por linha: reply "texto", let x = ..., if ... / else / end, http get "url" as res, admin ban @alvo, setvar chave = valor, stop.'}
                              onChange={(v) => patchCmd(i, { script: v })}
                            />
                          )}

                          <div style={{ display: 'flex', gap: ui.sm, alignItems: 'center', paddingTop: ui.sm, borderTop: `1px solid ${ui.border}`, flexWrap: 'wrap' }}>
                            <label style={{ ...helpStyle, marginTop: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <input
                                type="checkbox"
                                checked={c.ephemeral === true}
                                onChange={(e) => patchCmd(i, { ephemeral: e.target.checked })}
                              />
                              resposta discreta
                            </label>
                            <label style={{ ...helpStyle, marginTop: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <input
                                type="checkbox"
                                checked={c.enabled !== false}
                                onChange={(e) => patchCmd(i, { enabled: e.target.checked })}
                              />
                              ativo
                            </label>
                            <span style={{ flex: 1 }} />
                            <Button variant="ghost" icon="trash" onClick={() => removeCommand(i)}>
                              Excluir
                            </Button>
                          </div>
                          {problem && (
                            <div style={{ marginTop: ui.sm }}>
                              <Notice tone="danger">{problem}</Notice>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </Card>

          <Card title="Canais" subtitle="Nada marcado = o bot age em todos os canais." icon="hash">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 2, maxHeight: 220, overflowY: 'auto' }}>
              {channels.map((ch) => {
                const on = cfg.channels.includes(ch.id)
                return (
                  <label key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 7, cursor: 'pointer', background: on ? ui.surfaceHover : 'transparent' }}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setCfg((p) => ({
                          ...p,
                          channels: on ? p.channels.filter((id) => id !== ch.id) : [...p.channels, ch.id],
                        }))
                      }
                    />
                    <span style={{ fontSize: 12.5, color: on ? ui.text : ui.muted }}>{ch.name}</span>
                  </label>
                )
              })}
            </div>
          </Card>
        </>
      )}

      {tab === 'permissoes' && (
        <Card title="Permissões administrativas" subtitle="O bot nunca tem mais poder do que isto. O dono do servidor nunca é alvo." icon="gear">
          <div style={{ display: 'flex', flexDirection: 'column', gap: ui.sm }}>
            {BOT_PERM_DEFS.map((d) => {
              const on = (perms & d.bit) !== 0
              return (
                <label key={d.bit} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 10px', background: on ? ui.surfaceHover : ui.surface, border: `1px solid ${on ? ui.accent : ui.border}`, borderRadius: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={on}
                    style={{ marginTop: 2 }}
                    onChange={() => setPerms((p) => (on ? p & ~d.bit : p | d.bit))}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: ui.heading }}>{d.label}</span>
                    <span style={{ display: 'block', fontSize: 11.5, color: ui.muted }}>{d.hint}</span>
                    <span style={{ display: 'block', fontSize: 11, color: ui.muted, marginTop: 2, fontFamily: 'JetBrains Mono,monospace' }}>
                      {d.commands.map((c) => `/${c}`).join('  ')}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
          <div style={{ marginTop: ui.md, display: 'flex', gap: ui.sm, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="botp-chip" data-tone={perms === 0 ? 'mut' : 'ok'}>
              {perms === 0 ? 'sem poder administrativo' : `${BOT_PERM_DEFS.filter((d) => (perms & d.bit) !== 0).length} de ${BOT_PERM_DEFS.length} concedidas`}
            </span>
            <Button variant="ghost" icon="minus" onClick={() => setPerms(0)}>
              Remover todas
            </Button>
            <Button variant="ghost" icon="shield" onClick={() => setPerms(BOT_PERM_ALL)}>
              Conceder todas
            </Button>
          </div>
          <Notice tone="warning" icon="info">
            Conceder banir/silenciar permite que o bot remova membros de verdade. A validação é feita no
            core a cada ação — a interface não é a barreira.
          </Notice>
        </Card>
      )}

      {tab === 'eventos' && (
        <Card title="Eventos" subtitle="Marque o que o bot deve receber. Evento marcado chega no webhook e no script de mesmo nome." icon="plug">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 2 }}>
            {BOT_EVENTS.map((e) => {
              const on = cfg.events.includes(e.id)
              return (
                <label key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '7px 8px', borderRadius: 7, cursor: 'pointer', background: on ? ui.surfaceHover : 'transparent' }}>
                  <input
                    type="checkbox"
                    checked={on}
                    style={{ marginTop: 2 }}
                    onChange={() =>
                      setCfg((p) => ({
                        ...p,
                        events: on ? p.events.filter((x) => x !== e.id) : [...p.events, e.id],
                      }))
                    }
                  />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: on ? ui.text : ui.muted }}>{e.label}</span>
                    <span style={{ display: 'block', fontSize: 11, color: ui.muted }}>{e.hint}</span>
                  </span>
                </label>
              )
            })}
          </div>
          <TextField
            label="Webhook (opcional)"
            value={cfg.webhook?.url ?? ''}
            mono
            ariaLabel="URL do webhook"
            hint="Toda mensagem/evento do escopo vira um POST JSON. Sem token no corpo."
            error={cfg.webhook?.url ? urlProblem(cfg.webhook.url, cfg.blockPrivate) : null}
            onChange={(v) => setCfg((p) => ({ ...p, webhook: v.trim() ? { url: v.trim() } : undefined }))}
          />
          <label style={{ ...helpStyle, marginTop: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={cfg.blockPrivate}
              onChange={(e) => setCfg((p) => ({ ...p, blockPrivate: e.target.checked }))}
            />
            bloquear destinos em rede local (recomendado)
          </label>
        </Card>
      )}

      {tab === 'runtime' && (
        <>
          <Card
            title="Ponte local (127.0.0.1)"
            subtitle="O canal do bot com o servidor: ele recebe eventos e publica por aqui. Só loopback, com o token do bot."
            icon="globe"
          >
            {!hasNative ? (
              <Notice tone="warning">
                A ponte local existe apenas no app nativo (desktop). No modo navegador e no Android os
                comandos/DSL continuam funcionando, mas não há servidor local.
              </Notice>
            ) : (
              <>
                <div style={{ display: 'flex', gap: ui.sm, alignItems: 'center', flexWrap: 'wrap', marginBottom: ui.md }}>
                  <Button variant="success" icon="play" busy={runtimeBusy} onClick={() => void startBridge()}>
                    {bridgeStatus?.running ? 'Ponte ativa' : 'Abrir ponte'}
                  </Button>
                  <Button variant="danger" icon="stop" disabled={!bridgeStatus?.running} onClick={() => void stopBridge()}>
                    Fechar ponte
                  </Button>
                  {bridgeStatus?.running && (
                    <span className="botp-chip" data-tone="ok">
                      {bridgeStatus.url} · {bridgeStatus.requests} req · {bridgeStatus.events_pending} evento(s)
                    </span>
                  )}
                </div>
                {bridge && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <TextField
                      label="URL do bot (o app já entregou pronta ao plugin)"
                      value={bridge.url}
                      mono
                      readOnly
                      ariaLabel="URL da ponte"
                      onChange={() => {}}
                    />
                    <span style={{ ...helpStyle, marginTop: 0 }}>
                      O app define <b>DISTORRENT_BOT_URL</b> no processo do plugin — não existe token
                      para colar, guardar nem vazar. A URL só funciona neste PC, nesta sessão; fechar a
                      ponte invalida o segredo.
                    </span>
                  </div>
                )}
              </>
            )}
            {runtimeError && (
              <div style={{ marginTop: ui.sm }}>
                <Notice tone="danger">{runtimeError}</Notice>
              </div>
            )}
          </Card>

          <Card
            title="Código do bot (plugin)"
            subtitle="Rode o código da pasta do bot como plugin do app. Ele fala com o servidor pela ponte."
            icon="bot"
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: `0 ${ui.lg}` }}>
              <TextField
                label="Pasta do bot"
                value={folderDir}
                mono
                ariaLabel="Pasta do bot"
                placeholder="C:\\bots\\meu-bot"
                hint="Onde está o bot.json e o código."
                onChange={setFolderDir}
              />
              <TextField
                label="Comando de execução"
                value={folderRun}
                mono
                ariaLabel="Comando de execução do plugin"
                placeholder="node bot.js"
                hint="Sem shell: vira argv direto, dentro da pasta."
                onChange={setFolderRun}
              />
            </div>
            <div style={{ display: 'flex', gap: ui.sm, alignItems: 'center', flexWrap: 'wrap', marginTop: ui.sm }}>
              <Button variant="success" icon="play" busy={runtimeBusy} disabled={!bridgeStatus?.running} onClick={() => void startPlugin()}>
                Iniciar plugin
              </Button>
              <Button
                variant="danger"
                icon="stop"
                disabled={!plugin?.running}
                onClick={async () => {
                  await services.botPluginStop?.(communityId, bot.id)
                  setPlugin(await services.botPluginStatus!(communityId, bot.id))
                }}
              >
                Parar plugin
              </Button>
              {plugin && (
                <span className="botp-chip" data-tone={plugin.running ? 'ok' : 'mut'}>
                  {plugin.running ? `rodando (pid ${plugin.pid})` : `parado${plugin.exited_code !== null ? ` (código ${plugin.exited_code})` : ''}`}
                </span>
              )}
            </div>
            {plugin && plugin.lines.length > 0 && (
              <div className="botp-console" style={{ marginTop: ui.sm }}>
                {plugin.lines.slice(-60).map((l, i) => (
                  <div key={i} className="botp-line" data-level={l.level}>
                    <span style={{ color: ui.muted }}>{l.message}</span>
                  </div>
                ))}
              </div>
            )}
            <Notice tone="info" icon="info">
              O plugin roda com as permissões do seu usuário no sistema — a barreira é a API da ponte, não
              uma sandbox. Só importe código em que você confia. No Android não há execução de processo.
            </Notice>
          </Card>
        </>
      )}

      {tab === 'console' && (
        <Card
          title="Console"
          subtitle="Últimas execuções e erros deste bot, gravados no banco do servidor."
          icon="file"
          action={
            <Button variant="ghost" icon="trash" onClick={() => void clearLogs()}>
              Limpar
            </Button>
          }
        >
          {logs.length === 0 && plugin?.lines.length === 0 ? (
            <EmptyState icon="file" title="Nada no console ainda" hint="Assim que o bot executar um comando ou reagir a um evento, aparece aqui." />
          ) : (
            <div className="botp-console" ref={consoleRef}>
              {[...logs]
                .reverse()
                .map((l) => (
                  <div key={l.id} className="botp-line" data-level={l.level}>
                    <span style={{ color: ui.muted, flexShrink: 0 }}>
                      {new Date(l.created_at).toLocaleTimeString()}
                    </span>
                    <span>{l.message}</span>
                  </div>
                ))}
              {plugin?.lines.map((l, i) => (
                <div key={`p${i}`} className="botp-line" data-level={l.level}>
                  <span style={{ color: ui.muted, flexShrink: 0 }}>[plugin]</span>
                  <span>{l.message}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

            </div>
          </div>

          <div className="botp-foot">
            {dirty && (
              <span style={{ ...helpStyle, marginTop: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Ic name="info" size={13} />
                alterações não salvas
              </span>
            )}
            <span style={{ flex: 1 }} />
            <Button onClick={onClose} disabled={busy}>Fechar</Button>
            <Button variant="success" icon="save" busy={busy} onClick={() => void save()}>
              Salvar
            </Button>
          </div>
        </div>
      </div>
    )
}

/** Resumo de uma linha por bot (usado pela lista do gerenciador). */
export function botSummary(bot: BotView): { commands: number; events: number; perms: number; broken: boolean } {
  const cfg = parseBotConfig(bot.config ?? null)
  if (!cfg) return { commands: 0, events: 0, perms: bot.perms ?? 0, broken: true }
  return {
    commands: cfg.commands.length,
    events: cfg.events.length,
    perms: bot.perms ?? 0,
    broken: false,
  }
}

export { BOT_PERM_ALL }

export default BotPanel
