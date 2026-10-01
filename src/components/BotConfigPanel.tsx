import { useState } from 'react'
import { services } from '../services'
import type { BotView, ChannelMeta } from '../services/models'
import {
  parseBotConfig,
  renderTemplate,
  renderBotReply,
  type BotCommandDef,
} from '../services/botCommands'

const t = {
  sidebar: '#2b2d31',
  input: '#1e1f22',
  border: '#26272b',
  panel: '#2b2d31',
  accent: '#5865f2',
  green: '#23a559',
  yellow: '#f0b232',
  red: '#f23f42',
  text: '#dbdee1',
  heading: '#f2f3f5',
  muted: '#949ba4',
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

function secondaryBtn(): React.CSSProperties {
  return {
    background: t.input,
    border: `1px solid ${t.border}`,
    borderRadius: 8,
    color: t.text,
    fontSize: 12,
    fontWeight: 700,
    padding: '7px 12px',
    cursor: 'pointer',
  }
}

const FALLBACK_PREFIX = '!'
const MAX_COMMANDS = 16

function blankCommand(): BotCommandDef {
  return { name: '', method: 'GET', url: '' }
}

function copyBestEffort(text: string): void {
  try {
    void navigator.clipboard?.writeText(text)?.catch(() => {})
  } catch {
    /* clipboard indisponível */
  }
}

export default function BotConfigPanel({ communityId, bot, channels, onSaved, onClose }: {
  communityId: string
  bot: BotView
  channels: ChannelMeta[]
  onSaved: () => void
  onClose: () => void
}) {
  const initial = parseBotConfig(bot.config ?? null)
  const [prefix, setPrefix] = useState(initial?.prefix ?? FALLBACK_PREFIX)
  const [commands, setCommands] = useState<BotCommandDef[]>(() =>
    (initial?.commands ?? []).map((c) => ({ ...c })),
  )
  const [scope, setScope] = useState<string[]>(initial?.channels ?? [])
  const [webhookUrl, setWebhookUrl] = useState(initial?.webhook?.url ?? '')
  const [token, setToken] = useState(bot.token)
  const [tokenNotice, setTokenNotice] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(commands.length > 0 ? 0 : null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [testOut, setTestOut] = useState<string | null>(null)
  const [testBusy, setTestBusy] = useState(false)

  function updateCommand(i: number, patch: Partial<BotCommandDef>) {
    setCommands((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }

  function toggleScope(id: string) {
    setScope((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]))
  }

  /** Comandos efetivos: ignora linhas totalmente em branco. */
  function effectiveCommands(): BotCommandDef[] {
    return commands.filter((c) => c.name.trim() || c.url.trim())
  }

  async function regenToken() {
    setError(null)
    setTokenNotice(null)
    setBusy(true)
    try {
      const next = await services.botRegenToken(communityId, bot.id)
      setToken(next)
      setTokenNotice('token antigo foi invalidado')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'não foi possível gerar um novo token')
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    setError(null)
    const effective = effectiveCommands()
    for (const c of effective) {
      if (!c.name.trim()) {
        setError('todo comando precisa de um nome')
        return
      }
      if (!/^https?:\/\//i.test(c.url.trim())) {
        setError(`comando "${c.name.trim()}" precisa de uma url http/https válida`)
        return
      }
    }
    const payload = {
      prefix,
      commands: effective.map((c) => ({
        name: c.name,
        method: c.method,
        url: c.url,
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
    if (!parsed) {
      setError('configuração inválida — revise prefixo, comandos e canais')
      return
    }
    if (parsed.commands.length !== effective.length) {
      setError('algum comando foi descartado — revise nomes e urls http/https')
      return
    }
    setBusy(true)
    try {
      await services.botUpdate(communityId, bot.id, { config: json })
      onSaved()
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'não foi possível salvar a configuração')
    } finally {
      setBusy(false)
    }
  }

  async function testFirst() {
    setError(null)
    setTestOut(null)
    const cmd = effectiveCommands()[0]
    if (!cmd) {
      setError('nenhum comando para testar — adicione um primeiro')
      return
    }
    if (!/^https?:\/\//i.test(cmd.url.trim())) {
      setError('o primeiro comando precisa de uma url http/https válida')
      return
    }
    setTestBusy(true)
    try {
      const url = renderTemplate(cmd.url, { args: ['teste'] })
      const res = await services.httpFetch(url, cmd.method, cmd.headers ?? {}, cmd.body ?? null, 10000)
      const reply = renderBotReply(cmd, ['teste'], res.body)
      const shown = (reply ?? '(sem resposta — verifique responsePath/template)').slice(0, 300)
      setTestOut(`Resposta: ${shown}`)
    } catch (e: unknown) {
      setTestOut(`Resposta: falhou — ${e instanceof Error ? e.message : 'erro de rede'}`)
    } finally {
      setTestBusy(false)
    }
  }

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
        aria-label={`Configurar ${bot.name}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: t.panel,
          border: `1px solid ${t.border}`,
          borderRadius: 12,
          padding: 22,
          width: 560,
          maxHeight: '80vh',
          overflowY: 'auto',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ color: t.heading, fontWeight: 900, fontSize: 16 }}>{`Configurar ${bot.name}`}</div>
          <button
            type="button"
            aria-label="Fechar configuração do bot"
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: t.muted, fontSize: 16, cursor: 'pointer', padding: 4 }}
          >
            ✕
          </button>
        </div>

        <label style={labelStyle()}>TOKEN</label>
        <div
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            color: t.text,
            wordBreak: 'break-all',
            background: t.input,
            border: `1px solid ${t.border}`,
            borderRadius: 8,
            padding: '10px 12px',
          }}
        >
          {token.length > 16 ? `${token.slice(0, 16)}…` : token || '(sem token)'}
        </div>
        {tokenNotice && <div style={{ fontSize: 11, color: t.yellow, marginTop: 6 }}>{tokenNotice}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={() => copyBestEffort(token)} style={secondaryBtn()}>
            Copiar token
          </button>
          <button
            type="button"
            title="Gerar novo token"
            aria-label="Gerar novo token"
            disabled={busy}
            onClick={() => void regenToken()}
            style={secondaryBtn()}
          >
            Gerar novo token
          </button>
        </div>

        <div style={{ marginTop: 16 }}>
          <label style={labelStyle()}>PREFIXO</label>
          <input
            value={prefix}
            maxLength={4}
            onChange={(e) => setPrefix(e.target.value.slice(0, 4))}
            style={{ ...inputStyle(), width: 90, textAlign: 'center' }}
            aria-label="prefixo do bot"
          />
        </div>

        <div style={{ marginTop: 16 }}>
          <label style={labelStyle()}>COMANDOS</label>
          <div style={{ fontSize: 11, color: t.muted, marginBottom: 8 }}>
            {'Placeholders: {{args}} {{arg0}} {{query}} {{value}} {{json.campo}}'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {commands.map((cmd, i) => (
              <div key={i} style={{ background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 10, padding: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    value={cmd.name}
                    onChange={(e) => updateCommand(i, { name: e.target.value })}
                    placeholder="nome"
                    style={{ ...inputStyle(), flex: 1 }}
                    aria-label={`nome do comando ${i + 1}`}
                  />
                  <select
                    value={cmd.method}
                    onChange={(e) => updateCommand(i, { method: e.target.value === 'POST' ? 'POST' : 'GET' })}
                    style={{ ...inputStyle(), width: 90 }}
                    aria-label={`método do comando ${i + 1}`}
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === i ? null : i)}
                    style={{ background: 'transparent', border: 'none', color: t.muted, cursor: 'pointer', fontSize: 13, padding: 4 }}
                    aria-label={expanded === i ? `recolher comando ${i + 1}` : `expandir comando ${i + 1}`}
                  >
                    {expanded === i ? '▾' : '▸'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCommands((prev) => prev.filter((_, idx) => idx !== i))}
                    style={{ background: 'transparent', border: 'none', color: t.muted, cursor: 'pointer', fontSize: 13, padding: 4 }}
                    aria-label={`remover comando ${cmd.name || i + 1}`}
                  >
                    ✕
                  </button>
                </div>
                {(expanded === i || !cmd.url) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                    <input
                      value={cmd.url}
                      onChange={(e) => updateCommand(i, { url: e.target.value })}
                      placeholder="https://api.exemplo.com/{{query}}"
                      style={inputStyle()}
                      aria-label={`url do comando ${i + 1}`}
                    />
                    {cmd.method === 'POST' && (
                      <textarea
                        value={cmd.body ?? ''}
                        onChange={(e) => updateCommand(i, { body: e.target.value })}
                        placeholder='{"q":"{{query}}"}'
                        rows={2}
                        style={{ ...inputStyle(), resize: 'vertical', fontFamily: 'JetBrains Mono, monospace' }}
                        aria-label={`corpo post do comando ${i + 1}`}
                      />
                    )}
                    <input
                      value={cmd.responsePath ?? ''}
                      onChange={(e) => updateCommand(i, { responsePath: e.target.value || undefined })}
                      placeholder="data.temp"
                      style={inputStyle()}
                      aria-label={`responsePath do comando ${i + 1}`}
                    />
                    <input
                      value={cmd.template ?? ''}
                      onChange={(e) => updateCommand(i, { template: e.target.value || undefined })}
                      placeholder="{{value}}°C"
                      style={inputStyle()}
                      aria-label={`template de resposta do comando ${i + 1}`}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            disabled={commands.length >= MAX_COMMANDS}
            onClick={() => {
              setCommands((prev) => [...prev, blankCommand()])
              setExpanded(commands.length)
            }}
            style={{ ...secondaryBtn(), marginTop: 8 }}
          >
            + Adicionar comando
          </button>
        </div>

        <div style={{ marginTop: 16 }}>
          <label style={labelStyle()}>ESCOPOS</label>
          <div style={{ fontSize: 11, color: t.muted, marginBottom: 8 }}>
            nenhum canal marcado = age em todos os canais
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {channels.map((ch) => (
              <label key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: t.text, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={scope.includes(ch.id)}
                  onChange={() => toggleScope(ch.id)}
                />
                {ch.name}
              </label>
            ))}
            {channels.length === 0 && (
              <div style={{ fontSize: 12, color: t.muted }}>nenhum canal neste servidor</div>
            )}
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <label style={labelStyle()}>URL DO WEBHOOK (OPCIONAL)</label>
          <input
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://meu-servidor.exemplo/hook"
            style={inputStyle()}
            aria-label="url do webhook"
          />
        </div>

        {error && <div style={{ fontSize: 12, color: '#ff9c9c', marginTop: 12 }}>{error}</div>}
        {testOut && (
          <div
            style={{
              background: t.input,
              border: `1px solid ${t.border}`,
              borderRadius: 8,
              padding: '10px 12px',
              marginTop: 12,
              fontSize: 12,
              color: t.text,
              wordBreak: 'break-word',
            }}
          >
            {testOut}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button
            type="button"
            title="Testar comando"
            aria-label="Testar comando"
            disabled={testBusy}
            onClick={() => void testFirst()}
            style={secondaryBtn()}
          >
            {testBusy ? 'Testando…' : 'Testar'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            style={{
              background: t.green,
              border: 'none',
              borderRadius: 8,
              color: '#fff',
              fontSize: 13,
              fontWeight: 800,
              padding: '9px 18px',
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  )
}
