import { useEffect, useMemo, useRef, useState } from 'react'
import type { BotBridgeInfo, BotBridgeStatus, BotLogView, BotPluginStatus, BotView, ChannelMeta, RoleView } from '../../services/models'
import { services } from '../../services'
import {
  BOT_ADMIN_ACTIONS,
  BOT_CHANNEL_KINDS,
  BOT_EVENTS,
  BOT_PERM_ALL,
  BOT_PRIMITIVES,
  BOT_MODES,
  parseBotConfig,
  serializeBotConfig,
  defaultBotConfig,
  commandProblem,
  normalizeBotCommandName,
  urlProblem,
  type BotCommandDef,
  type BotExec,
  type BotConfig,
  type BotMode,
} from '../../services/botCommands'
import { copyBestEffort } from '../../shared/clipboard'
import { baixarTexto } from './botDocsDownload'
import { DynamicStyles } from '../../shared/dynamicStyles'
import { BotPermissionsTab } from './BotPermissionsTab'
import { Button, Card, EmptyState, Modal, Notice, Select, TextArea, TextField, helpStyle, ui } from '../../shared/ui'
import { Ic, type IconName } from '../../shared/icons'

import { css, chip, mono, consoleStyle, lineStyle, type Tab } from './botPanelStyles'
export type { Tab }

export function BotPanel({
  communityId,
  bot,
  channels,
  onSaved,
  onClose,
  embedded = false,
}: {
  communityId: string
  bot: BotView
  channels: ChannelMeta[]
  onSaved: () => void
  onClose: () => void
  /** Ocupa a área das configurações do servidor em vez de abrir outro modal. */
  embedded?: boolean
}) {
  const initial = useMemo(() => {
    const cfg = parseBotConfig(bot.config ?? null) ?? defaultBotConfig()
    return { ...cfg, webhookSecret: bot.webhook_secret || undefined }
  }, [bot.config, bot.webhook_secret])
  const [tab, setTab] = useState<Tab>('credenciais')
  const [cfg, setCfg] = useState<BotConfig>(initial)
  const [perms, setPerms] = useState<number>(bot.perms ?? 0)
  const [roleId, setRoleId] = useState(bot.roleId ?? '')
  const [online, setOnline] = useState(bot.online)
  const [roles, setRoles] = useState<RoleView[]>([])
  const [token, setToken] = useState(bot.token)
  const [showToken, setShowToken] = useState(false)
  const [copied, setCopied] = useState(false)
  const [regenBusy, setRegenBusy] = useState(false)
  const [confirmRegen, setConfirmRegen] = useState(false)
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
    services
      .rolesList(communityId)
      .then((r) => {
        if (alive && Array.isArray(r)) setRoles(r)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [communityId])

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
    const usados = new Set(cfg.commands.map((c) => c.name))
    let n = cfg.commands.length + 1
    while (usados.has(`comando-${n}`)) n += 1
    setCfg((prev) => ({
      ...prev,
      commands: [
        ...prev.commands,
        { name: `comando-${n}`, method: 'GET', url: '', exec: 'reply', reply: '', cooldownMs: 1500 },
      ],
    }))
    setExpanded(`cmd-${cfg.commands.length}`)
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
      await services.botUpdate(communityId, bot.id, {
        config: json,
        perms,
        roleId: roleId || null,
        online,
        webhookSecret: cfg.webhookSecret,
      })
      setSavedAt(Date.now())
      onSaved()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function regenToken() {
    setConfirmRegen(false)
    setRegenBusy(true)
    setError(null)
    try {
      const next = await services.botRegenToken(communityId, bot.id)
      setToken(next)
      setShowToken(true)
      setCopied(false)
      onSaved()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'não foi possível gerar um novo token')
    } finally {
      setRegenBusy(false)
    }
  }

  function copyToken() {
    copyBestEffort(token)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
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
    () =>
      JSON.stringify(cfg) !== JSON.stringify(initial) ||
      perms !== (bot.perms ?? 0) ||
      (roleId || '') !== (bot.roleId ?? '') ||
      online !== bot.online,
    [cfg, initial, perms, bot.perms, roleId, bot.roleId, online, bot.online],
  )

  const tabs: { id: Tab; label: string; icon: IconName; count?: number }[] = [
    { id: 'credenciais', label: 'Credenciais', icon: 'key' },
    { id: 'comandos', label: 'Comandos', icon: 'terminal', count: cfg.commands.length },
    { id: 'permissoes', label: 'Permissões', icon: 'shield' as IconName },
    { id: 'primitivas', label: 'Modo e primitivas', icon: 'gear' },
    { id: 'eventos', label: 'Eventos', icon: 'plug', count: cfg.events.length },
    { id: 'runtime', label: 'Ponte e plugin', icon: 'globe' },
    { id: 'console', label: 'Console', icon: 'file' },
  ]

  const roleOptions = [
    { value: '', label: 'Sem cargo (só o básico)' },
    ...roles.map((r) => ({ value: r.id, label: r.name })),
  ]
  if (roleId && !roles.some((r) => r.id === roleId)) {
    roleOptions.push({ value: roleId, label: 'Cargo atual (fora da lista)' })
  }
  const maskedToken =
    token.length > 12 ? `${token.slice(0, 10)}…${token.slice(-4)}` : token || '(sem token)'
  const header = (
    <div
      className="botp-head"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '14px 18px',
        borderBottom: `1px solid ${ui.border}`,
        flexShrink: 0,
      }}
    >
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
          <span style={chip()}>bot · #{bot.discriminator}</span>
          <span style={chip(online ? 'ok' : undefined)}>
            {online ? 'online' : 'offline'}
          </span>
          {bridgeStatus?.running && (
            <span style={chip('ok')}>ponte {bridgeStatus.port}</span>
          )}
          {plugin?.running && (
            <span style={chip('ok')}>plugin {plugin.pid}</span>
          )}
          {dirty && <span style={chip('warn')}>não salvo</span>}
        </div>
      </div>
      <Button variant="ghost" icon="x" onClick={onClose} ariaLabel={embedded ? 'Voltar aos bots' : 'Fechar painel do bot'} />
    </div>
  )

  return (
    <div
      className={embedded ? 'botp-embed' : 'botp-overlay'}
      onClick={embedded ? undefined : onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        width: '100%',
        minWidth: 0,
        minHeight: 0,
        height: embedded ? '100%' : undefined,
      }}
    >
      <DynamicStyles css={css} />
      <div
        className="botp-shell"
        role="region"
        aria-label={`Configurar ${bot.name}`}
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          minWidth: 0,
          height: '100%',
          background: ui.bg,
          overflow: 'hidden',
        }}
      >
        {header}

        <div
          className="botp-body"
          style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
        >
          <nav
            className="botp-nav"
            role="tablist"
            aria-label="Seções do bot"
            style={{
              display: 'flex',
              flexDirection: 'row',
              gap: 2,
              width: '100%',
              flexShrink: 0,
              overflowX: 'auto',
              overflowY: 'hidden',
              borderBottom: `1px solid ${ui.border}`,
              padding: 8,
              background: ui.bg,
            }}
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className="botp-navbtn"
                onClick={() => setTab(t.id)}
                style={{
                  appearance: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '9px 10px',
                  border: 'none',
                  borderRadius: 7,
                  background: tab === t.id ? ui.accent : 'transparent',
                  color: tab === t.id ? '#fff' : ui.muted,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'inherit',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  width: 'auto',
                }}
              >
                <Ic name={t.icon} size={14} />
                {t.label}
                {t.count !== undefined && t.count > 0 && (
                  <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 800, opacity: 0.75 }}>
                    {t.count}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div
            className="botp-main"
            style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', padding: '18px 20px' }}
          >
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

      {tab === 'credenciais' && (
        <>
          <Card title="Token de acesso" subtitle="Segredo do bot. Só o dono do servidor vê e gera outro." icon="key">
            <div style={{ display: 'flex', gap: ui.sm, alignItems: 'center', flexWrap: 'wrap' }}>
              <div
                data-bot-token
                style={{
                  ...mono,
                  flex: '1 1 240px',
                  minWidth: 0,
                  wordBreak: 'break-all',
                  background: ui.input,
                  border: `1px solid ${ui.border}`,
                  borderRadius: ui.radius,
                  padding: '10px 12px',
                  fontSize: 12.5,
                  color: ui.text,
                }}
              >
                {showToken ? token || '(sem token)' : maskedToken}
              </div>
              <Button
                icon={showToken ? 'eyeOff' : 'eye'}
                onClick={() => setShowToken((v) => !v)}
                ariaLabel={showToken ? 'Ocultar token' : 'Mostrar token'}
              >
                {showToken ? 'Ocultar' : 'Mostrar'}
              </Button>
              <Button icon={copied ? 'checkDouble' : 'copy'} onClick={copyToken} ariaLabel="Copiar token">
                {copied ? 'Copiado' : 'Copiar'}
              </Button>
            </div>
            <div style={{ marginTop: ui.md, display: 'flex', gap: ui.sm, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button variant="danger" icon="refresh" busy={regenBusy} onClick={() => setConfirmRegen(true)}>
                Gerar novo token
              </Button>
              <span style={{ ...helpStyle, marginTop: 0, flex: '1 1 200px' }}>
                Quem tem o token fala como este bot. Gerar outro invalida o atual na hora.
              </span>
            </div>
          </Card>

          <Card title="Comportamento" subtitle="Cargo que o bot usa e como ele aparece na lista de membros." icon="gear">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: `0 ${ui.lg}` }}>
              <Select
                label="Cargo do bot"
                value={roleId}
                options={roleOptions}
                ariaLabel="Cargo do bot"
                hint="As permissões do bot vêm deste cargo. Menos é mais."
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
                onClick={() => setOnline((v) => !v)}
                style={{
                  width: 46,
                  height: 26,
                  flexShrink: 0,
                  borderRadius: 99,
                  border: `1px solid ${online ? ui.success : ui.borderStrong}`,
                  background: online ? 'rgba(35,165,89,.28)' : ui.input,
                  cursor: 'pointer',
                  padding: 2,
                  display: 'flex',
                  justifyContent: online ? 'flex-end' : 'flex-start',
                }}
              >
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    background: online ? ui.success : ui.muted,
                    display: 'block',
                  }}
                />
              </button>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: ui.heading }}>Bot marcado como online</div>
                <div style={helpStyle}>Desligado, ele para de responder sem perder a config.</div>
              </div>
            </div>
          </Card>
        </>
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
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 9,
                          padding: '9px 10px',
                          background: open ? ui.surfaceHover : ui.surface,
                          border: `1px solid ${open ? ui.accent : ui.border}`,
                          borderRadius: 9,
                          color: ui.text,
                          fontSize: 12.5,
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <Ic name="chevronRight" size={14} rotate={open ? 90 : 0} />
                        <span style={{ ...mono, flex: 1, minWidth: 0, fontWeight: 700, color: ui.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {cfg.prefix}
                          {c.name || '…'}
                        </span>
                        <span style={chip()}>{c.exec ?? 'reply'}</span>
                        {c.permission ? <span style={chip('warn')}>{c.permission}</span> : null}
                        {problem ? <span style={chip('bad')}>revisar</span> : <span style={chip('ok')}>pronto</span>}
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
                            <>
                              <Select
                                label="Ação"
                                value={c.admin ?? ''}
                                ariaLabel={`Ação administrativa do comando ${i + 1}`}
                                options={[
                                  { value: '', label: 'Escolha a ação' },
                                  ...BOT_ADMIN_ACTIONS.map((a) => ({
                                    value: a.action,
                                    label: `/${a.action} — ${a.label}`,
                                  })),
                                ]}
                                hint="A permissão da ação precisa estar concedida na aba Permissões."
                                onChange={(v) => patchCmd(i, { admin: v || undefined })}
                              />
                              {(() => {
                                const def = BOT_ADMIN_ACTIONS.find((a) => a.action === c.admin)
                                if (!def?.args) return null
                                return (
                                  <div style={helpStyle}>
                                    Argumentos: <code>{def.args}</code> — o canal onde a mensagem chegou
                                    entra como contexto.
                                  </div>
                                )
                              })()}
                            </>
                          )}

                          {c.exec === 'script' && (
                            <TextArea
                              label="Script (DSL)"
                              value={c.script ?? ''}
                              rows={8}
                              ariaLabel={`Script do comando ${i + 1}`}
                              hint={'Uma instrução por linha: reply "texto", let x = ..., if ... / else / end, http get "url" as res, admin <ação> ..., getvar/setvar/incvar, stop. Placeholders: {{raw.args}}, {{author}}, {{channel}}, {{event.message_id}}.'}
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
            <div style={{ marginBottom: ui.lg }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, color: ui.muted, textTransform: 'uppercase', marginBottom: 8 }}>
                Tipos de canal
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 2 }}>
                {BOT_CHANNEL_KINDS.map((k) => {
                  const on = cfg.channelKinds.includes(k.id)
                  return (
                    <label
                      key={k.id}
                      title={k.hint}
                      style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 8px', borderRadius: 7, cursor: 'pointer', background: on ? ui.surfaceHover : 'transparent' }}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        style={{ marginTop: 2 }}
                        onChange={() =>
                          setCfg((p) => ({
                            ...p,
                            channelKinds: on
                              ? p.channelKinds.filter((x) => x !== k.id)
                              : [...p.channelKinds, k.id],
                          }))
                        }
                      />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: on ? ui.text : ui.muted }}>
                          {k.label}
                        </span>
                        <span style={{ display: 'block', fontSize: 11, color: ui.muted }}>{k.hint}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
              {cfg.channelKinds.length === 0 && (
                <div style={{ fontSize: 11.5, color: ui.muted, marginTop: 6 }}>
                  Sem tipo marcado = age em todos os tipos de canal.
                </div>
              )}
            </div>

            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, color: ui.muted, textTransform: 'uppercase', marginBottom: 8 }}>
              Canais específicos
            </div>
            {channels.length === 0 ? (
              <EmptyState
                icon="hash"
                title="Nenhum canal neste servidor"
                hint="Crie um canal para poder limitar o bot a ele. Enquanto isso o escopo fica aberto."
              />
            ) : (
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
                      <Ic
                        name={ch.kind === 'voice' ? 'speaker' : ch.kind === 'video' ? 'video' : ch.kind === 'forum' ? 'tag' : 'hash'}
                        size={13}
                      />
                      <span style={{ fontSize: 12.5, color: on ? ui.text : ui.muted }}>{ch.name}</span>
                    </label>
                  )
                })}
              </div>
            )}
          </Card>
        </>
      )}

      {tab === 'permissoes' && (
        <BotPermissionsTab perms={perms} setPerms={setPerms} />
      )}

      {tab === 'primitivas' && (
        <Card
          title="Modo e primitivas"
          subtitle="O que o bot pode ENTREGAR. Primitiva desligada nega a rota no core, não só esconde o botão."
          icon="gear"
        >
          <Select
            label="Modo de execução"
            value={cfg.mode}
            onChange={(v) => setCfg({ ...cfg, mode: v as BotMode, runtime: v === 'plugin' ? 'process' : 'none' })}
            options={BOT_MODES.map((m) => ({ value: m.id, label: m.label }))}
            hint={BOT_MODES.find((m) => m.id === cfg.mode)?.hint}
          />
          {cfg.mode === 'remote' && (
            <Notice tone="warning" icon="warn">
              No modo remoto o criador conecta de fora e a lógica sai deste PC — é o único modo que
              quebra a promessa "nada roda em nuvem". Só use sabendo disso.
            </Notice>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 8, marginTop: ui.md }}>
            {BOT_PRIMITIVES.map((p) => {
              const on = cfg.primitives[p.id]
              return (
                <label
                  key={p.id}
                  title={p.hint}
                  style={{
                    display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 9px',
                    background: on ? ui.surfaceHover : ui.surface,
                    border: `1px solid ${on ? ui.accent : ui.border}`,
                    borderRadius: 8,
                    opacity: p.implemented ? 1 : 0.55,
                    cursor: p.implemented ? 'pointer' : 'not-allowed',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!p.implemented}
                    style={{ marginTop: 2 }}
                    onChange={() => {
                      if (!p.implemented) return
                      setCfg({ ...cfg, primitives: { ...cfg.primitives, [p.id]: !on } })
                    }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: ui.heading }}>
                      {p.label}
                    </span>
                    <span style={{ display: 'block', fontSize: 11, color: ui.muted }}>
                      {p.implemented ? p.hint : `${p.hint} — ainda não existe`}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
          <div style={{ marginTop: ui.md, display: 'flex', flexDirection: 'column', gap: ui.sm }}>
            <Notice tone="info" icon="info">
              <b>Música:</b> a primitiva <code>audioFrame</code> toca no alto-falante
              <b> deste PC</b>, junto com a voz. Ela <b>não</b> transmite aos outros participantes da
              call — para isso seria preciso um track de saída por peer, que não existe. No Windows e
              no Android o áudio da chamada é da WebView e o comando devolve erro explicando.
            </Notice>
            <div style={{ display: 'flex', gap: ui.sm, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                variant="secondary"
                icon="play"
                disabled={typeof services.botAudioOpen !== 'function'}
                onClick={async () => {
                  try {
                    const abriu = await services.botAudioOpen!(communityId, bot.id)
                    setRuntimeError(null)
                    setSavedAt(Date.now())
                    void abriu
                  } catch (e: unknown) {
                    setRuntimeError(e instanceof Error ? e.message : String(e))
                  }
                }}
              >
                Abrir canal de áudio
              </Button>
              <Button
                variant="ghost"
                icon="stop"
                disabled={typeof services.botAudioClose !== 'function'}
                onClick={async () => {
                  try {
                    await services.botAudioClose?.(communityId, bot.id)
                  } catch (e: unknown) {
                    setRuntimeError(e instanceof Error ? e.message : String(e))
                  }
                }}
              >
                Parar áudio
              </Button>
              <span style={{ fontSize: 11.5, color: ui.muted }}>
                {typeof services.botAudioOpen === 'function'
                  ? 'O plugin controla o mesmo canal por /v1/audio/*.'
                  : 'Esta plataforma não oferece áudio de bot.'}
              </span>
            </div>
          </div>
          <div style={{ marginTop: ui.md, display: 'flex', flexDirection: 'column', gap: ui.sm }}>
            <TextField
              label="Domínios permitidos para HTTP"
              value={cfg.httpAllow.join(', ')}
              onChange={(v) =>
                setCfg({
                  ...cfg,
                  httpAllow: v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 256),
                })
              }
              placeholder="api.exemplo.com, cdn.exemplo.com"
              hint="Vazio = qualquer destino público. Rede privada continua bloqueada abaixo."
            />
            <TextField
              label="Segredo do webhook (HMAC)"
              mono
              value={cfg.webhookSecret ?? ''}
              onChange={(v) => setCfg({ ...cfg, webhookSecret: v.trim() || undefined })}
              placeholder="mínimo 16 caracteres"
              hint="Assina cada evento com X-Distorrent-Signature. Fica só no banco local: nunca é sincronizado para os membros nem aparece no JSON exportado."
            />
            <div style={{ display: 'flex', gap: ui.sm, flexWrap: 'wrap' }}>
              <TextField
                label="Mensagens por execução"
                value={String(cfg.maxMessagesPerExecution)}
                onChange={(v) => setCfg({ ...cfg, maxMessagesPerExecution: Math.max(1, Math.min(20, Number(v) || 20)) })}
                hint="1 a 20. Evita script que responde 200 vezes."
              />
              <TextField
                label="Retenção do console (h)"
                value={String(cfg.retentionHours)}
                onChange={(v) => setCfg({ ...cfg, retentionHours: Math.max(0, Math.min(720, Number(v) || 24)) })}
                hint="0 = não guarda. Padrão 24 h."
              />
            </div>
          </div>
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
                    <span style={chip('ok')}>
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
                <span style={chip(plugin.running ? 'ok' : undefined)}>
                  {plugin.running ? `rodando (pid ${plugin.pid})` : `parado${plugin.exited_code !== null ? ` (código ${plugin.exited_code})` : ''}`}
                </span>
              )}
            </div>
            {plugin && plugin.lines.length > 0 && (
              <div className="botp-console" style={{ ...consoleStyle, marginTop: ui.sm }}>
                {plugin.lines.slice(-60).map((l, i) => (
                  <div key={i} className="botp-line" style={lineStyle(l.level)}>
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
            <div ref={consoleRef} style={consoleStyle}>
              {[...logs]
                .reverse()
                .map((l) => (
                  <div key={l.id} style={lineStyle(l.level)}>
                    <span style={{ color: ui.muted, flexShrink: 0 }}>
                      {new Date(l.created_at).toLocaleTimeString()}
                    </span>
                    <span>{l.message}</span>
                  </div>
                ))}
              {plugin?.lines.map((l, i) => (
                <div key={`p${i}`} style={lineStyle(l.level)}>
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

          <div
            className="botp-foot"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '12px 18px',
              borderTop: `1px solid ${ui.border}`,
              flexShrink: 0,
              background: ui.surface,
            }}
          >
            {dirty && (
              <span style={{ ...helpStyle, marginTop: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Ic name="info" size={13} />
                alterações não salvas
              </span>
            )}
            <span style={{ flex: 1 }} />
            <Button
              variant="ghost"
              icon="download"
              title="Baixa um bot.json com a config e as permissões — sem token"
              onClick={() => {
                const pacote = {
                  schema: 3,
                  name: bot.name,
                  avatar: bot.avatar,
                  description: '',
                  perms,
                  config: JSON.parse(serializeBotConfig(cfg)),
                }
                baixarTexto(
                  `${bot.name.replace(/[^a-z0-9_-]+/gi, '-')}.bot.json`,
                  JSON.stringify(pacote, null, 2),
                  'application/json;charset=utf-8',
                )
              }}
            >
              Exportar
            </Button>
            <Button onClick={onClose} disabled={busy}>{embedded ? 'Voltar' : 'Fechar'}</Button>
            <Button variant="success" icon="save" busy={busy} onClick={() => void save()}>
              Salvar
            </Button>
          </div>
        </div>

      <Modal
        open={confirmRegen}
        onClose={() => setConfirmRegen(false)}
        title="Gerar novo token?"
        subtitle="O token atual para de funcionar na hora, sem volta."
        width={480}
        zIndex={embedded ? 120 : 110}
        footer={
          <>
            <span style={{ flex: 1 }} />
            <Button onClick={() => setConfirmRegen(false)}>Cancelar</Button>
            <Button variant="danger" icon="refresh" busy={regenBusy} onClick={() => void regenToken()}>
              Gerar e invalidar o antigo
            </Button>
          </>
        }
      >
        <Notice tone="warning" icon="warn">
          Qualquer integração, script ou webhook que use o token antigo vai começar a falhar até você
          atualizar a credencial lá.
        </Notice>
      </Modal>
    </div>
    )
}

/** Resumo de uma linha por bot (usado pela lista do gerenciador). */
export function botSummary(bot: BotView): { commands: number; events: number; perms: number; broken: boolean } {
  const perms = bot.perms ?? 0
  const raw = bot.config ?? ''
  if (!raw.trim()) return { commands: 0, events: 0, perms, broken: false }
  const cfg = parseBotConfig(raw)
  if (!cfg) return { commands: 0, events: 0, perms, broken: true }
  return {
    commands: cfg.commands.length,
    events: cfg.events.length,
    perms,
    broken: false,
  }
}

export { BOT_PERM_ALL }

export default BotPanel
