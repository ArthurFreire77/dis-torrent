import { useEffect, useState } from 'react'
import { services } from '../../services'
import type { RetentionSettings } from '../../services/models'

const DIAS = [7, 30, 90, 180, 0] as const

function rotuloDias(d: number): string {
  return d === 0 ? 'Nunca' : `${d} dias`
}

export function MessageRetentionSettings({
  inputBg,
  borderColor,
  text,
  muted,
  accent,
}: {
  inputBg: string
  borderColor: string
  text: string
  muted: string
  accent: string
}) {
  const [cfg, setCfg] = useState<RetentionSettings>({ days: 30, servers: true, groups: true, dms: false })
  const [carregado, setCarregado] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    services
      .retentionGet()
      .then((r) => {
        if (!vivo) return
        setCfg(r)
        setCarregado(true)
      })
      .catch((e: unknown) => {
        if (!vivo) return
        setErro(String((e as Error)?.message ?? e))
        setCarregado(true)
      })
    return () => {
      vivo = false
    }
  }, [])

  const salvar = (patch: Partial<RetentionSettings>) => {
    const proximo = { ...cfg, ...patch }
    setCfg(proximo)
    setErro(null)
    setAviso(null)
    services
      .retentionSet(proximo.days, proximo.servers, proximo.groups, proximo.dms)
      .then((aplicado) => {
        setCfg(aplicado)
        const escopo = [
          aplicado.servers ? 'servidores' : null,
          aplicado.groups ? 'grupos' : null,
          aplicado.dms ? 'conversas individuais' : null,
        ].filter(Boolean) as string[]
        setAviso(
          aplicado.days === 0
            ? 'Limpeza automática desligada.'
            : escopo.length === 0
              ? 'Nenhum tipo de conversa selecionado — nada será apagado.'
              : `Mantendo ${rotuloDias(aplicado.days)} em ${escopo.join(', ')}.`,
        )
      })
      .catch((e: unknown) => setErro(String((e as Error)?.message ?? e)))
  }

  const head: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: 1,
    color: muted,
    marginBottom: 8,
  }
  const card: React.CSSProperties = {
    background: inputBg,
    border: `1px solid ${borderColor}`,
    borderRadius: 10,
    padding: '12px 14px',
    marginBottom: 12,
  }

  const tipos: Array<{ id: keyof Pick<RetentionSettings, 'servers' | 'groups' | 'dms'>; titulo: string; desc: string }> = [
    { id: 'servers', titulo: 'Servidores', desc: 'Canais de servidor e comunidades' },
    { id: 'groups', titulo: 'Grupos', desc: 'Conversas em grupo' },
    { id: 'dms', titulo: 'Conversas individuais', desc: 'Mensagens diretas com amigos' },
  ]

  return (
    <div data-testid="retention-settings">
      <div style={head}>LIMPEZA AUTOMÁTICA DO HISTÓRICO</div>
      <div style={card}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {DIAS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => salvar({ days: d })}
              aria-pressed={cfg.days === d}
              disabled={!carregado}
              style={{
                flex: '1 1 62px',
                background: cfg.days === d ? `${accent}22` : 'transparent',
                border: `1px solid ${cfg.days === d ? accent : borderColor}`,
                color: cfg.days === d ? accent : text,
                borderRadius: 8,
                padding: '9px 8px',
                fontSize: 12,
                fontWeight: 800,
                cursor: carregado ? 'pointer' : 'default',
              }}
            >
              {rotuloDias(d)}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {tipos.map((t) => (
            <label
              key={t.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                background: cfg[t.id] ? `${accent}14` : 'transparent',
                border: `1px solid ${cfg[t.id] ? `${accent}66` : borderColor}`,
                borderRadius: 8,
                padding: '9px 11px',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={cfg[t.id]}
                disabled={!carregado}
                onChange={(e) => salvar({ [t.id]: e.target.checked } as Partial<RetentionSettings>)}
                style={{ accentColor: accent, width: 16, height: 16, flexShrink: 0 }}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 800, color: text }}>{t.titulo}</span>
                <span style={{ display: 'block', fontSize: 11, color: muted, marginTop: 2 }}>{t.desc}</span>
              </span>
            </label>
          ))}
        </div>

        <div style={{ fontSize: 11, color: muted, marginTop: 10, lineHeight: 1.55 }}>
          A limpeza apaga <strong style={{ color: text }}>só para você</strong>: nada é enviado aos outros
          participantes e o histórico deles não muda. Mensagens apagadas não voltam quando a conexão é
          restabelecida.
        </div>

        {aviso && (
          <div role="status" style={{ fontSize: 11, color: accent, marginTop: 8 }}>
            {aviso}
          </div>
        )}
        {erro && (
          <div role="alert" style={{ fontSize: 11, color: '#ff9c9c', marginTop: 8 }}>
            {erro}
          </div>
        )}
      </div>
    </div>
  )
}

export default MessageRetentionSettings
