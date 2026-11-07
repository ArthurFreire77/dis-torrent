import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BotView, ChannelMeta, CommunityView, Identity, RoleView } from '../services/models'
import { services } from '../services'
import { BotManager } from '../components/server/BotManager'
import BotPanel from '../components/server/BotPanel'
import { isAndroidRuntime, isTauriRuntime } from '../shared/runtime.ts'
import { DynamicStyles } from '../shared/dynamicStyles'
import { Button, EmptyState, Notice, Select, helpStyle, ui } from '../shared/ui'
import { Ic } from '../shared/icons'

const css = `
.bots-scroll::-webkit-scrollbar{ width:10px }
.bots-scroll::-webkit-scrollbar-thumb{ background:${ui.borderStrong}; border-radius:5px }
.bots-scroll:focus-visible{ outline:2px solid ${ui.link}; outline-offset:-2px }
`

type JanelaEstado = { tone: 'info' | 'warning' | 'success' | 'danger'; texto: string } | null

/**
 * Tela inteira de bots, servida tanto pela rota `/bots` do app quanto pela
 * janela secundária. O cabeçalho diz o estado REAL: é melhor admitir que a
 * ponte não existe naquela plataforma do que oferecer um botão que falha.
 */
export default function BotsApp() {
  const [me, setMe] = useState<Identity | null>(null)
  const [comunidades, setComunidades] = useState<CommunityView[]>([])
  const [selId, setSelId] = useState('')
  const [bots, setBots] = useState<BotView[]>([])
  const [roles, setRoles] = useState<RoleView[]>([])
  const [channels, setChannels] = useState<ChannelMeta[]>([])
  const [configBotId, setConfigBotId] = useState<string | null>(null)
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [janela, setJanela] = useState<JanelaEstado>(null)
  const [abrindoJanela, setAbrindoJanela] = useState(false)

  const android = isAndroidRuntime()
  const nativo = isTauriRuntime()
  const temPonte = typeof services.botBridgeStart === 'function'
  const podeAbrirJanela = nativo && !android && typeof services.openBotsWindow === 'function'

  useEffect(() => {
    let vivo = true
    void (async () => {
      try {
        const [id, todas] = await Promise.all([services.identityGet(), services.communitiesList()])
        if (!vivo) return
        setMe(id)
        const minhas = (todas ?? []).filter((c) => !!id && c.owner_fp === id.fingerprint)
        setComunidades(minhas)
        setSelId((atual) => (atual && minhas.some((c) => c.id === atual) ? atual : minhas[0]?.id ?? ''))
      } catch (e: unknown) {
        if (vivo) setErro(e instanceof Error ? e.message : String(e))
      } finally {
        if (vivo) setCarregando(false)
      }
    })()
    return () => {
      vivo = false
    }
  }, [])

  const carregarServidor = useCallback(async (cid: string) => {
    if (!cid) {
      setBots([])
      setRoles([])
      setChannels([])
      return
    }
    const [b, r, ch] = await Promise.all([
      services.botsList(cid).catch(() => [] as BotView[]),
      services.rolesList(cid).catch(() => [] as RoleView[]),
      services.channelList(cid).catch(() => [] as ChannelMeta[]),
    ])
    setBots(Array.isArray(b) ? b : [])
    setRoles(Array.isArray(r) ? r : [])
    setChannels(Array.isArray(ch) ? ch : [])
  }, [])

  useEffect(() => {
    if (!selId) return
    setConfigBotId(null)
    void carregarServidor(selId).catch((e: unknown) => setErro(String(e)))
  }, [selId, carregarServidor])

  const botEmEdicao = useMemo(
    () => (configBotId ? bots.find((b) => b.id === configBotId) ?? null : null),
    [bots, configBotId],
  )

  const online = bots.filter((b) => b.online).length
  const servidor = comunidades.find((c) => c.id === selId) ?? null

  async function abrirJanela() {
    if (!services.openBotsWindow) return
    setAbrindoJanela(true)
    setJanela(null)
    try {
      await services.openBotsWindow()
      setJanela({
        tone: 'success',
        texto: 'Janela de bots aberta. Se já estava aberta, ela só veio para a frente.',
      })
    } catch (e: unknown) {
      setJanela({
        tone: 'danger',
        texto: `não consegui abrir a janela: ${e instanceof Error ? e.message : String(e)}`,
      })
    } finally {
      setAbrindoJanela(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: ui.bg,
        color: ui.text,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <DynamicStyles css={css} />

      <header
        style={{
          padding: '18px 22px 14px',
          borderBottom: `1px solid ${ui.border}`,
          background: ui.surface,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span
            aria-hidden="true"
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: `${ui.accent}33`,
              border: `1px solid ${ui.accent}`,
              color: ui.accent,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Ic name="bot" size={20} />
          </span>
          <div style={{ flex: '1 1 240px', minWidth: 0 }}>
            <div style={{ fontSize: 19, fontWeight: 800, color: ui.heading }}>Bots</div>
            <div style={{ fontSize: 12.5, color: ui.muted, marginTop: 2 }}>
              Fora das configurações do servidor: aqui você vê todos os seus bots, o estado real da
              ponte local e pode manter esta tela numa janela própria.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button
              variant="secondary"
              icon="externalLink"
              disabled={!podeAbrirJanela || abrindoJanela}
              busy={abrindoJanela}
              title={
                podeAbrirJanela
                  ? 'Abre (ou traz para a frente) a janela de bots'
                  : 'Esta plataforma não oferece janelas separadas'
              }
              onClick={() => void abrirJanela()}
            >
              Abrir em janela
            </Button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
          <Chip rotulo={`${bots.length} bot${bots.length === 1 ? '' : 's'}`} />
          <Chip rotulo={`${online} online`} tone={online > 0 ? 'ok' : undefined} />
          <Chip
            rotulo={temPonte ? 'ponte local disponível' : 'ponte local indisponível'}
            tone={temPonte ? 'ok' : 'warn'}
          />
          <Chip
            rotulo={podeAbrirJanela ? 'janela própria disponível' : 'janela própria indisponível'}
            tone={podeAbrirJanela ? 'ok' : 'warn'}
          />
          {!nativo && <Chip rotulo="modo navegador" tone="warn" />}
        </div>
      </header>

      <main
        className="bots-scroll"
        tabIndex={-1}
        aria-label="Bots do servidor"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '18px 22px 24px',
          gap: 16,
          overflowY: 'auto',
        }}
      >
        {janela && (
          <Notice tone={janela.tone} icon={janela.tone === 'success' ? 'check' : 'info'}>
            {janela.texto}
          </Notice>
        )}

        {erro && (
          <Notice tone="danger" icon="warn">
            {erro}
          </Notice>
        )}

        {!temPonte && (
          <Notice tone="warning" icon="info">
            {android
              ? 'No Android a ponte local (127.0.0.1) não existe: não há processo do bot para abrir. ' +
                'Os comandos e scripts continuam funcionando dentro do app, mas o plugin local não roda.'
              : 'Esta plataforma não oferece a ponte local (127.0.0.1). Só o app nativo de desktop ' +
                'consegue abrir o processo do bot; no navegador a tela serve para configurar, não para rodar.'}
          </Notice>
        )}

        {!podeAbrirJanela && (
          <Notice tone="info" icon="info">
            {android
              ? 'A tela de bots no celular usa a interface do app — não existe janela separada no Android.'
              : 'A janela separada só existe no app de desktop. Esta rota continua funcionando normalmente.'}
          </Notice>
        )}

        {carregando ? (
          <div style={{ fontSize: 13, color: ui.muted }}>carregando seus servidores…</div>
        ) : comunidades.length === 0 ? (
          <EmptyState
            icon="server"
            title="Nenhum servidor seu"
            hint={
              me
                ? 'Só o dono do servidor opera bots. Crie um servidor ou peça a transferência de posse para poder configurá-los aqui.'
                : 'Não encontrei uma identidade neste perfil. Abra o app normalmente para criar ou desbloquear a sua.'
            }
          />
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', maxWidth: 860 }}>
              <div style={{ flex: '1 1 260px', minWidth: 200 }}>
                <Select
                  label="Servidor"
                  value={selId}
                  ariaLabel="Servidor dono dos bots"
                  options={comunidades.map((c) => ({ value: c.id, label: c.name }))}
                  hint={`${comunidades.length} servidor(es) em que você é dono. Bots de outros servidores não aparecem aqui.`}
                  onChange={setSelId}
                />
              </div>
              <div style={{ paddingBottom: ui.lg, fontSize: 11.5, color: ui.muted, maxWidth: 320 }}>
                {servidor?.is_public ? 'Servidor público' : 'Servidor por convite'}
                {servidor ? ` · ${servidor.channels.length} canal(is)` : ''}
              </div>
            </div>

            {botEmEdicao ? (
              <div style={{ display: 'flex', flex: 1, minHeight: 0, maxWidth: 980 }}>
                <BotPanel
                  embedded
                  communityId={selId}
                  bot={botEmEdicao}
                  channels={channels}
                  onSaved={() => void carregarServidor(selId)}
                  onClose={() => setConfigBotId(null)}
                />
              </div>
            ) : (
              <BotManager
                bots={bots}
                roles={roles}
                ehDono
                onCreate={async (d) => {
                  await services.botCreate(selId, d)
                  await carregarServidor(selId)
                }}
                onUpdate={async (id, patch) => {
                  await services.botUpdate(selId, id, patch)
                  await carregarServidor(selId)
                }}
                onDelete={async (id) => {
                  await services.botDelete(selId, id)
                  await carregarServidor(selId)
                }}
                onConfigure={setConfigBotId}
                onImportFolder={
                  services.botFolderRead
                    ? async (dir) => {
                        const info = await services.botFolderRead!(dir)
                        const id = await services.botCreate(selId, {
                          name: info.name,
                          avatar: info.avatar,
                        })
                        await services.botUpdate(selId, id, { config: info.config })
                        await carregarServidor(selId)
                        return info.name
                      }
                    : undefined
                }
              />
            )}

            <div style={{ ...helpStyle, maxWidth: 860, marginTop: 0 }}>
              A ponte local e o plugin rodam no seu PC, com as permissões do seu usuário. Nada disso é
              iniciado sozinho: só pelo botão dentro do bot.
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function Chip({ rotulo, tone }: { rotulo: string; tone?: 'ok' | 'warn' }) {
  const cor = tone === 'ok' ? ui.success : tone === 'warn' ? ui.warning : ui.muted
  const fundo = tone === 'ok' ? 'rgba(35,165,89,.14)' : tone === 'warn' ? 'rgba(240,178,50,.14)' : ui.input
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: 99,
        border: `1px solid ${tone ? cor : ui.border}`,
        background: fundo,
        color: tone ? cor : ui.muted,
        fontSize: 11,
        fontWeight: 700,
        whiteSpace: 'nowrap',
      }}
    >
      {rotulo}
    </span>
  )
}
