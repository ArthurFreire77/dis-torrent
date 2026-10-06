// Assistente de criação de servidor.
//
// Este arquivo foi reescrito do zero. A versão anterior tinha quatro problemas
// que não eram de estilo, eram de produto:
//
//   1. Largura de 560px: o passo de identidade (nome, descrição, ícone) era a
//      decisão mais importante do fluxo e cabia num vão de 560 que espremia
//      tudo. Agora são WIDTHS.wizard (940) com conteúdo em 1fr e resumo em 280.
//   2. Os "ícones" eram emoji (rocket, gamepad...). Emoji como ícone de interface
//      é a regra que a casa já quebrou em `icons.tsx`: o ícone é SVG, o emoji é
//      conteúdo de mensagem. Além disso o emoji não carregava informação — oito
//      figurinhas sem rótulo. Agora são categorias COM NOME e descrição do que
//      costuma ser um servidor assim.
//   3. Cinco passos com o mais importante (identidade) sendo o mais raso: o
//      nome era validado com `trim().length >= 2` e nada mais.
//   4. Os botões de navegação eram texto puro, sem ícone, sem estado de foco.
//
// O que NÃO mudou, deliberadamente: o contrato `onCreated(id: string)`. O
// chamador em `ThemeShell.tsx` faz `setSelCommunity(id)`, então o callback
// recebe o id como string. Passar `{ id, name, token }` quebraria o shell.
//
// Regras estruturais deste arquivo:
//   - zero emoji (ícone de UI é sempre `Ic` de `shared/icons`);
//   - cada passo é um `role="group"` com `aria-label` do passo, para que o
//     leitor de tela anuncie a troca de contexto;
//   - o botão Continuar fica desabilitado quando o passo é inválido, mas a
//     pendência é escrita na tela. Botão morto sem explicação é pior que erro.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Ic, type IconName } from '../shared/icons'
import { Tooltip } from '../shared/Tooltip'
import { LocalLink } from '../shared/LocalLink'
import {
  Button,
  IconButton,
  Modal,
  Notice,
  Select,
  TextArea,
  TextField,
  WIDTHS,
  ui,
} from '../shared/ui'
import { CATEGORIAS_PADRAO, validateChannelName } from './server/ChannelManager'
import { services } from '../services'
import type { ChannelMeta } from '../services/models'
import { PERMS, PERM_LABELS } from '../services/models'

// ---------- css local ----------
//
// `hover`, `focus-visible` e `@media` não se expressam em `style` inline —
// precisam de seletor. O mesmo caminho que `BotConfigPanel` usa.

const css = `
.csw-cols{ display:grid; grid-template-columns:minmax(0,1fr) 280px; gap:${ui.xl}px; align-items:start }
.csw-side{ position:sticky; top:0; min-width:0 }
.csw-main{ min-width:0 }

/* passo 1 — modelos e categorias de ícone */
.csw-models{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:${ui.sm}px }
.csw-model{ appearance:none; text-align:left; cursor:pointer; background:${ui.surface}; border:1px solid ${ui.border}; border-radius:10px; padding:11px 12px; color:${ui.text}; display:flex; flex-direction:column; gap:4px; transition:background .15s, border-color .15s }
.csw-model:hover:not(:disabled){ background:${ui.surfaceHover}; border-color:${ui.borderStrong} }
.csw-model:active:not(:disabled){ background:${ui.elevated} }
.csw-model:focus-visible{ outline:2px solid ${ui.link}; outline-offset:2px }
.csw-model[aria-pressed="true"]{ border-color:${ui.accent}; background:rgba(88,101,242,.14) }
.csw-model-t{ font-size:13px; font-weight:800; color:${ui.heading} }
.csw-model-d{ font-size:11px; color:${ui.muted}; line-height:1.4 }

.csw-cats{ display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:${ui.sm}px }
.csw-cat{ appearance:none; text-align:left; cursor:pointer; background:${ui.surface}; border:1px solid ${ui.border}; border-radius:10px; padding:10px 11px; color:${ui.text}; display:flex; gap:9px; align-items:flex-start; transition:background .15s, border-color .15s }
.csw-cat:hover:not(:disabled){ background:${ui.surfaceHover}; border-color:${ui.borderStrong} }
.csw-cat:active:not(:disabled){ background:${ui.elevated} }
.csw-cat:focus-visible{ outline:2px solid ${ui.link}; outline-offset:2px }
.csw-cat[aria-pressed="true"]{ border-color:${ui.accent}; background:rgba(88,101,242,.14) }
.csw-cat-ic{ width:28px; height:28px; border-radius:8px; display:flex; align-items:center; justify-content:center; background:${ui.input}; color:${ui.muted}; flex-shrink:0 }
.csw-cat[aria-pressed="true"] .csw-cat-ic{ background:rgba(88,101,242,.24); color:#fff }
.csw-cat-t{ font-size:12px; font-weight:800; color:${ui.heading}; line-height:1.3 }
.csw-cat-d{ font-size:11px; color:${ui.muted}; line-height:1.4; margin-top:2px }

/* passo 2 — canais */
.csw-chan{ display:grid; grid-template-columns:22px minmax(0,1fr) 116px 148px 32px; gap:${ui.sm}px; align-items:start; background:${ui.surface}; border:1px solid ${ui.border}; border-radius:10px; padding:9px 10px }
.csw-chan[data-bad="true"]{ border-color:${ui.danger} }
.csw-chan-ic{ color:${ui.muted}; display:flex; justify-content:center; padding-top:9px }
.csw-chan > div > div:last-child{ margin-bottom:0 !important }

/* passo 3 — cargos */
.csw-role{ background:${ui.surface}; border:1px solid ${ui.border}; border-radius:10px; padding:10px 11px }
.csw-role[data-on="false"]{ opacity:.62 }
.csw-role-top{ display:flex; align-items:center; gap:9px }
.csw-role-dot{ width:11px; height:11px; border-radius:50%; flex-shrink:0 }
.csw-role-why{ font-size:11px; color:${ui.muted}; line-height:1.5; margin-top:7px }
.csw-check{ display:flex; align-items:center; gap:8px; font-size:12px; color:${ui.text}; cursor:pointer; padding:5px 7px; border-radius:6px; transition:background .15s }
.csw-check:hover{ background:${ui.surfaceHover} }
.csw-check input{ margin:0; width:15px; height:15px; flex-shrink:0; cursor:pointer; accent-color:${ui.accent} }
.csw-check:focus-within{ box-shadow:0 0 0 2px ${ui.accent}66 }
.csw-perms{ display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:2px; margin-top:8px; padding-top:8px; border-top:1px solid ${ui.border} }

/* barra de passos */
.csw-seg{ appearance:none; cursor:pointer; background:transparent; border:0; padding:0; display:flex; flex-direction:column; gap:6px; min-width:0; text-align:left; font:inherit }
.csw-seg-bar{ height:4px; border-radius:99px; background:${ui.input}; transition:background .18s; width:100% }
.csw-seg:hover:not(:disabled) .csw-seg-bar{ background:${ui.borderStrong} }
.csw-seg[data-state="done"] .csw-seg-bar{ background:${ui.success} }
.csw-seg[data-state="now"] .csw-seg-bar{ background:${ui.accent} }
.csw-seg:focus-visible{ outline:2px solid ${ui.link}; outline-offset:3px; border-radius:4px }
.csw-seg:disabled{ cursor:default }
.csw-seg-l{ display:flex; align-items:center; gap:5px; font-size:11px; font-weight:700; color:${ui.muted}; min-width:0 }
.csw-seg[data-state="now"] .csw-seg-l{ color:${ui.heading} }
.csw-seg-n{ width:16px; height:16px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:9px; font-weight:800; flex-shrink:0; background:${ui.input}; color:${ui.muted} }
.csw-seg[data-state="done"] .csw-seg-n{ background:rgba(35,165,89,.22); color:#a5e5bd }
.csw-seg[data-state="now"] .csw-seg-n{ background:var(--csw-accent, ${ui.accent}); color:#fff }
.csw-seg-t{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap }

/* texto utilitário */
.csw-cap{ font-size:11px; font-weight:800; letter-spacing:.6px; text-transform:uppercase; color:${ui.muted}; margin:0 0 ${ui.sm}px }
.csw-falta{ font-size:12px; color:#ffe0a3; line-height:1.5; display:flex; gap:7px; align-items:flex-start }
.csw-prev{ display:flex; align-items:center; gap:${ui.md}px; background:${ui.surface}; border:1px solid ${ui.border}; border-radius:10px; padding:11px 12px; margin-bottom:${ui.lg}px }
.csw-prev-ic{ width:40px; height:40px; border-radius:12px; flex-shrink:0; display:flex; align-items:center; justify-content:center; background:rgba(88,101,242,.2); color:#fff }
.csw-prev-n{ font-size:14px; font-weight:800; color:${ui.heading}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.csw-prev-d{ font-size:11px; color:${ui.muted}; line-height:1.4; margin-top:2px }
.csw-count{ font-size:11px; color:${ui.muted}; text-align:right; margin-top:6px; font-variant-numeric:tabular-nums }
.csw-done{ display:flex; flex-direction:column; align-items:center; text-align:center; gap:${ui.md}px; padding:${ui.md}px 0 ${ui.lg}px }
.csw-done-ic{ width:64px; height:64px; border-radius:20px; display:flex; align-items:center; justify-content:center; background:rgba(35,165,89,.18); color:#a5e5bd }
.csw-side-box{ background:${ui.surface}; border:1px solid ${ui.border}; border-radius:10px; padding:12px 13px; margin-bottom:${ui.md}px }
.csw-side-t{ font-size:10px; font-weight:800; letter-spacing:.6px; text-transform:uppercase; color:${ui.muted}; margin-bottom:8px; display:flex; align-items:center; gap:6px }
.csw-tag{ display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:700; border-radius:99px; padding:3px 9px; background:${ui.input}; border:1px solid ${ui.border}; color:${ui.text} }
.csw-list{ display:flex; flex-direction:column; gap:4px }
.csw-li{ display:flex; align-items:center; gap:7px; font-size:12px; color:${ui.text}; min-width:0 }
.csw-li span{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.csw-li-i{ color:${ui.muted}; flex-shrink:0; display:flex }

/* Abaixo de 860px a coluna de 280px rouba a largura do conteúdo: o resumo desce
   para baixo (order:2) em vez de sumir, porque é ele que mostra a contagem de
   canais e cargos que a pessoa está criando. */
@media (max-width: 860px) {
  .csw-cols{ grid-template-columns:minmax(0,1fr); gap:${ui.lg}px }
  .csw-side{ position:static; order:2 }
  .csw-models{ grid-template-columns:minmax(0,1fr) }
}
/* 360px: 4 colunas de canal não cabem em ~300px úteis. O tipo e a categoria
   descem para a linha de baixo, o nome fica com o espaço que sobrar. */
@media (max-width: 560px) {
  .csw-chan{ grid-template-columns:22px minmax(0,1fr) 32px }
  .csw-chan-ic{ grid-row:1 }
  .csw-chan-name{ grid-column:2 / 4 }
  .csw-chan-kind{ grid-column:1 / 2 }
  .csw-chan-cat{ grid-column:1 / 3 }
  .csw-chan-del{ grid-column:3; grid-row:1 }
  .csw-cats{ grid-template-columns:minmax(0,1fr) }
  .csw-perms{ grid-template-columns:minmax(0,1fr) }
  .csw-seg-t{ display:none }
}
`

// ---------- dados ----------

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
  /** Uma linha explicando o que o cargo FAZ. É o que o resumo mostra. */
  why: string
}

interface IconCategory {
  id: IconName
  label: string
  desc: string
}

/**
 * Categorias de ícone. Substituem os oito emoji: cada uma tem nome e diz o que
 * costuma ser um servidor daquele tipo, que é a informação que o emoji tentava
 * dar de jeito.
 */
const ICON_CATEGORIES: IconCategory[] = [
  { id: 'server', label: 'Servidor', desc: 'Sem tema definido. Serve para qualquer coisa.' },
  { id: 'users', label: 'Comunidade', desc: 'Grupos de pessoas, eventos e bate-papo.' },
  { id: 'terminal', label: 'Tecnologia', desc: 'Infraestrutura, deploys, logs e suporte.' },
  { id: 'code', label: 'Desenvolvimento', desc: 'Código, projetos, revisão e bugs.' },
  { id: 'sparkle', label: 'Criativo', desc: 'Arte, música, escrita e ideias.' },
  { id: 'crown', label: 'Jogos', desc: 'Partidas, torneios e sala de jogo.' },
  { id: 'plug', label: 'Integrações', desc: 'Bots, webhooks e automação.' },
  { id: 'shield', label: 'Privado', desc: 'Equipe restrita, staff e moderação.' },
  { id: 'globe', label: 'Público', desc: 'Comunidade aberta, vários idiomas.' },
  { id: 'mic', label: 'Áudio', desc: 'Gravação, música, podcast e locução.' },
]

/**
 * Três modelos que PRÉ-PREENCHEM descrição, ícone e canais. Não pule de passo:
 * a pessoa pode ignorar e escrever tudo à mão. O que o modelo faz é oferecer um
 * ponto de partida que já é coerente.
 */
const MODELOS: {
  id: string
  label: string
  desc: string
  icon: IconName
  description: string
  channels: { name: string; kind: ChannelKind }[]
}[] = [
  {
    id: 'comunidade',
    label: 'Comunidade',
    desc: 'Bate-papo, eventos e gente nova',
    icon: 'users',
    description: 'Espaço para conversar, combinar o que fazer e manter todo mundo por perto.',
    channels: [
      { name: 'geral', kind: 'text' },
      { name: 'apresentacoes', kind: 'text' },
      { name: 'encontros', kind: 'voice' },
    ],
  },
  {
    id: 'estudo',
    label: 'Estudo',
    desc: 'Aulas, avisos e materiais',
    icon: 'code',
    description: 'Grupo de estudos: avisos de aula, materiais compartilhados e dúvidas.',
    channels: [
      { name: 'geral', kind: 'text' },
      { name: 'avisos', kind: 'text' },
      { name: 'materiais', kind: 'text' },
      { name: 'sala-de-estudo', kind: 'voice' },
    ],
  },
  {
    id: 'trabalho',
    label: 'Trabalho',
    desc: 'Projetos, tarefas e reunião',
    icon: 'terminal',
    description: 'Equipe de trabalho: andamento de projetos, tarefas abertas e reunião rápida.',
    channels: [
      { name: 'geral', kind: 'text' },
      { name: 'projetos', kind: 'text' },
      { name: 'tarefas', kind: 'text' },
      { name: 'reuniao', kind: 'voice' },
    ],
  },
]

const STEP_LABELS = ['Identidade', 'Canais', 'Cargos', 'Regras'] as const
const PASSO_REGRAS = 3
const PASSO_CONCLUIDO = 4

const LIMITE_NOME = 60
const LIMITE_REGRAS = 2000

const KIND_ICON: Record<ChannelKind, IconName> = { text: 'hash', voice: 'speaker', video: 'video' }
const KIND_LABEL: Record<ChannelKind, string> = { text: 'Texto', voice: 'Voz', video: 'Vídeo' }

const KIND_OPCOES = (Object.keys(KIND_LABEL) as ChannelKind[]).map((k) => ({
  value: k,
  label: KIND_LABEL[k],
}))

function categoryFor(kind: ChannelKind): string {
  if (kind === 'voice') return CATEGORIAS_PADRAO[1]
  if (kind === 'video') return CATEGORIAS_PADRAO[2]
  return CATEGORIAS_PADRAO[0]
}

function initialRoles(): RolePreset[] {
  return [
    {
      key: 'membro',
      name: 'Membro',
      color: '#57f287',
      permissions: PERMS.SEND_MESSAGES | PERMS.VIEW_CHANNEL | PERMS.EMBED_LINKS,
      hoist: false,
      mentionable: false,
      enabled: true,
      why: 'Padrão de quem acabou de entrar: conversa, vê os canais e compartilha links.',
    },
    {
      key: 'moderador',
      name: 'Moderador',
      color: '#f0b232',
      permissions:
        PERMS.KICK_MEMBERS | PERMS.MANAGE_CHANNELS | PERMS.SEND_MESSAGES
        | PERMS.VIEW_CHANNEL | PERMS.MENTION_EVERYONE,
      hoist: true,
      mentionable: false,
      enabled: true,
      why: 'Cuida do dia a dia: expulsa quem atrapalha, organiza canais e anuncia.',
    },
    {
      key: 'admin',
      name: 'Administrador',
      color: '#f23f42',
      permissions:
        PERMS.ADMINISTRATOR | PERMS.MANAGE_CHANNELS | PERMS.MANAGE_ROLES
        | PERMS.KICK_MEMBERS | PERMS.BAN_MEMBERS | PERMS.MANAGE_BOT,
      hoist: true,
      mentionable: false,
      enabled: true,
      why: 'Poder total: cria cargos, bane, gerencia canais e controla os bots.',
    },
  ]
}

function initialChannels(): WizardChannel[] {
  return [{ name: 'geral', kind: 'text', category: categoryFor('text') }]
}

function slugChannel(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ---------- validação ----------

interface NameCheck {
  error: string | null
  warning: string | null
}

/**
 * Validação de verdade do nome, em tempo real.
 *
 * Três coisas, não uma: existence, tamanho ebounded e uma checagem de "isso
 * parece nome de pessoa". A terceira é a que mais importa aqui: o erro de
 * criação mais comum não é nome inválido, é a pessoa colar o próprio nome e o
 * servidor ficarACHADO no rail. O aviso não bloqueia — é conselho, não regra.
 */
function checkName(raw: string): NameCheck {
  const n = raw.trim()
  if (!n) return { error: null, warning: null }
  if (/\s{2,}/.test(n)) {
    return { error: 'Espaço duplo no meio do nome. Um espaço só já basta.', warning: null }
  }
  if (n.length < 2) {
    return { error: 'Muito curto. Use pelo menos 2 caracteres.', warning: null }
  }
  if (n.length > LIMITE_NOME) {
    return { error: `Máximo de ${LIMITE_NOME} caracteres. Agora são ${n.length}.`, warning: null }
  }
  return { error: null, warning: pareceNomeDePessoa(n) ? AVISO_NOME_PESSOA : null }
}

const AVISO_NOME_PESSOA =
  'Isso parece o nome de uma pessoa. Se for, considere um tema: é mais fácil achar o servidor depois e o nome não fica ambíguo no rail.'

/**
 * Heurística de "nome de pessoa": UMA palavra, sem dígito, capitalizada,
 * comprimento de nome de gente. Deliberadamente rasa — o custo de um falso
 * positivo é um aviso que a pessoa ignora; o custo de um falso negativo é o
 * servidor chamado "Arthur" para sempre.
 */
function pareceNomeDePessoa(nome: string): boolean {
  if (/\s/.test(nome)) return false
  if (/\d/.test(nome)) return false
  if (nome.length < 3 || nome.length > 14) return false
  return /^[A-ZÀ-Ý][a-zà-ÿ]+$/.test(nome)
}

function nomeVazio(v: string): boolean {
  return v.trim().length < 2
}

// ---------- peças pequenas ----------

function StepCap({ children }: { children: ReactNode }) {
  return <div className="csw-cap">{children}</div>
}

/** Rótulo + dica de uma linha, usado nos blocos do resumo lateral. */
function SideBox({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <div className="csw-side-box">
      <div className="csw-side-t">
        <Ic name={icon} size={12} />
        {title}
      </div>
      {children}
    </div>
  )
}

// ---------- componente ----------

export default function CreateServerWizard({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  /** Id do servidor criado, como string — é o que o shell consome. */
  onCreated: (communityId: string) => void
}) {
  const [step, setStep] = useState(0)
  /** Maior passo já alcançado. O stepper só volta para <= este. */
  const [visited, setVisited] = useState(0)
  const [modeloId, setModeloId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [iconId, setIconId] = useState<IconName>('server')
  const [channels, setChannels] = useState<WizardChannel[]>(initialChannels)
  const [roles, setRoles] = useState<RolePreset[]>(initialRoles)
  const [expandedRole, setExpandedRole] = useState<string | null>(null)
  const [rulesText, setRulesText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inviteUrl, setInviteUrl] = useState('')
  const [createdId, setCreatedId] = useState('')

  const mainRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    setStep(0)
    setVisited(0)
    setModeloId(null)
    setName('')
    setDescription('')
    setIconId('server')
    setChannels(initialChannels())
    setRoles(initialRoles())
    setExpandedRole(null)
    setRulesText('')
    setBusy(false)
    setError(null)
    setInviteUrl('')
    setCreatedId('')
  }, [open])

  // Trocar de passo volta o scroll ao topo. Sem isso, ir do passo 1 (alto) para
  // o passo 3 (curto) deixa a pessoa no meio do vazio.
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [step])

  const goTo = useCallback((next: number) => {
    if (next < 0) return
    setStep(next)
    setVisited((v) => (next > v ? next : v))
  }, [])

  const nomeCheck = useMemo(() => checkName(name), [name])

  /** Canais como `ChannelMeta` — o que `validateChannelName` espera. */
  const channelsAsMeta = useMemo<ChannelMeta[]>(
    () =>
      channels.map((c, i) => ({
        id: String(i),
        name: c.name,
        category: c.category,
        position: i,
        kind: c.kind,
      })),
    [channels],
  )

  /** Erro por canal, no mesmo índice. `null` = válido. */
  const channelErrors = useMemo(
    () =>
      channels.map((c, i) => validateChannelName(c.name, channelsAsMeta, String(i))),
    [channels, channelsAsMeta],
  )

  const canaisTexto = channels.filter((c) => c.kind === 'text').length
  const canaisVoz = channels.filter((c) => c.kind === 'voice' || c.kind === 'video').length
  const cargosAtivos = roles.filter((r) => r.enabled)

  /**
   * O que impede de seguir. Não é só um booleano: a lista é o que aparece na
   * tela. Botão desabilitado sem dizer o porquê obriga a pessoa a adivinhar.
   */
  const pendencias = useMemo((): string[] => {
    if (step === 0) {
      if (nomeVazio(name)) return ['Escreva um nome com pelo menos 2 caracteres.']
      if (nomeCheck.error) return [nomeCheck.error]
      return []
    }
    if (step === 1) {
      const out: string[] = []
      channelErrors.forEach((e, i) => {
        if (e) out.push(`Canal ${i + 1}: ${e}`)
      })
      if (canaisTexto === 0) out.push('Adicione pelo menos um canal de texto — é por ele que o servidor começa.')
      return out
    }
    return []
  }, [step, name, nomeCheck.error, channelErrors, canaisTexto])

  const bloqueado = pendencias.length > 0
  const concluido = step === PASSO_CONCLUIDO

  // ---------- modelos ----------

  /**
   * Modelo pré-preenche descrição, ícone e canais. NÃO mexe no nome: o nome é a
   * única coisa que a pessoa necessariamente escreveu sozinha, e sobrescrever o
   * texto que ela digitou é o pior que um botão de "atalho" pode fazer.
   */
  function aplicarModelo(id: string) {
    const m = MODELOS.find((x) => x.id === id)
    if (!m) return
    if (modeloId === id) {
      setModeloId(null)
      return
    }
    setModeloId(id)
    setIconId(m.icon)
    setDescription(m.description)
    setChannels(m.channels.map((c) => ({ name: c.name, kind: c.kind, category: categoryFor(c.kind) })))
  }

  function updateChannel(i: number, patch: Partial<WizardChannel>) {
    setChannels((prev) =>
      prev.map((c, idx) => {
        if (idx !== i) return c
        const next = { ...c, ...patch }
        if (patch.kind) next.category = categoryFor(patch.kind)
        return next
      }),
    )
  }

  function addChannel() {
    setChannels((prev) => {
      const n = prev.length + 1
      return [
        ...prev,
        { name: `canal-${n}`, kind: 'text' as ChannelKind, category: categoryFor('text') },
      ]
    })
  }

  function removeChannel(i: number) {
    setChannels((prev) => prev.filter((_, idx) => idx !== i))
  }

  function toggleRole(key: string) {
    setRoles((prev) =>
      prev.map((r) => (r.key === key ? { ...r, enabled: !r.enabled } : r)),
    )
  }

  function togglePerm(roleKey: string, bit: number) {
    setRoles((prev) =>
      prev.map((r) => {
        if (r.key !== roleKey) return r
        const has = (r.permissions & bit) !== 0
        return { ...r, permissions: has ? r.permissions & ~bit : r.permissions | bit }
      }),
    )
  }

  // ---------- criação ----------

  async function createServer() {
    setError(null)
    if (nomeVazio(name)) {
      setStep(0)
      return
    }
    setBusy(true)
    try {
      const validos = channels
        .map((c, i) => ({ c, err: channelErrors[i] }))
        .filter((x) => !x.err)
        .map(({ c }) => c)

      const id = await services.createCommunity(
        name.trim(),
        validos.map((c) => c.name),
        {
          description: description.trim() || undefined,
          // O backend guarda `icon` como texto livre e exibe a inicial do nome
          // quando está vazio. Mandamos o NOME do ícone, não um emoji: é o que
          // identifica a categoria escolhida e sobrevive a uma troca de fonte.
          icon: iconId,
          category: modeloId ?? undefined,
          rulesText: rulesText.trim() || undefined,
          channelsMeta: validos.map((c) => ({ name: c.name, kind: c.kind, category: c.category })),
          roles: cargosAtivos.map((r) => ({
            name: r.name.trim() || r.key,
            color: r.color,
            permissions: r.permissions,
            hoist: r.hoist,
            mentionable: r.mentionable,
          })),
        },
      )
      const me = await services.identityGet()
      const token = await services.makeInvite(id, me?.fingerprint ?? '000000000000')
      setCreatedId(id)
      setInviteUrl(`${window.location.origin}/invite/${token}`)
      setStep(PASSO_CONCLUIDO)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'não foi possível criar o servidor')
    } finally {
      setBusy(false)
    }
  }

  // ---------- rodapé ----------

  const footer = (
    <div style={{ width: '100%' }}>
      {step < PASSO_CONCLUIDO && pendencias.length > 0 && (
        <div
          className="csw-falta"
          style={{ marginBottom: ui.md }}
          // `status` e não `alert`: isto é Orientação de preenchimento, não
          // erro. Um alert dispara a leitura imediata a cada tecla digitada.
          role="status"
        >
          <span style={{ flexShrink: 0, marginTop: 1 }}>
            <Ic name="info" size={14} />
          </span>
          <span>
            <strong style={{ color: ui.heading }}>Falta:</strong> {pendencias.join(' ')}
          </span>
        </div>
      )}
      <div style={{ display: 'flex', gap: ui.sm, flexWrap: 'wrap', alignItems: 'center' }}>
        {step > 0 && !concluido && (
          <Button icon="chevronLeft" onClick={() => goTo(step - 1)} disabled={busy}>
            Voltar
          </Button>
        )}
        <div style={{ flex: 1 }} />
        {concluido ? (
          <>
            <Button
              variant="primary"
              icon="check"
              onClick={() => {
                onCreated(createdId)
                onClose()
              }}
            >
              Concluir
            </Button>
          </>
        ) : step === PASSO_REGRAS ? (
          <Button
            variant="success"
            icon="check"
            busy={busy}
            disabled={bloqueado}
            onClick={() => void createServer()}
          >
            {busy ? 'Criando servidor' : 'Criar servidor'}
          </Button>
        ) : (
          <Button
            variant="primary"
            icon="chevronRight"
            disabled={bloqueado}
            onClick={() => goTo(step + 1)}
            title={bloqueado ? pendencias[0] : undefined}
          >
            Continuar
          </Button>
        )}
      </div>
    </div>
  )

  // ---------- conteúdo do passo ----------

  // Contagem de canais válidos, usada no texto final (evita "3 canais" quando
  // um deles está com nome inválido e não vai ser criado).
  const validosCount = channels.length - channelErrors.filter((e) => e !== null).length


  const conteudo = ((): ReactNode => {
    if (step === 0) {
      return (
        <>
          <StepCap>Comece por um modelo (opcional)</StepCap>
          <div className="csw-models" style={{ marginBottom: ui.xl }}>
            {MODELOS.map((m) => (
              <button
                key={m.id}
                type="button"
                className="csw-model"
                aria-pressed={modeloId === m.id}
                onClick={() => aplicarModelo(m.id)}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ color: ui.muted, display: 'flex' }}>
                    <Ic name={m.icon} size={15} />
                  </span>
                  <span className="csw-model-t">{m.label}</span>
                </span>
                <span className="csw-model-d">{m.desc}</span>
              </button>
            ))}
          </div>
          {modeloId && (
            <div style={{ marginBottom: ui.lg }}>
              <Notice tone="info" icon="info">
                O modelo preencheu a descrição, o ícone e os canais abaixo. Pode trocar
                qualquer um deles — inclusive escolher outro modelo.
              </Notice>
            </div>
          )}

          <TextField
            label="Nome do servidor"
            value={name}
            onChange={setName}
            maxLength={LIMITE_NOME + 20}
            placeholder="ex.: Prefeitura de Vila Nova"
            ariaLabel="Nome do servidor"
            error={nomeCheck.error}
            hint={`${name.trim().length}/${LIMITE_NOME} caracteres. Esse é o nome que a pessoa vê no rail.`}
          />
          {nomeCheck.warning && !nomeCheck.error && (
            <div style={{ marginTop: -ui.sm, marginBottom: ui.lg }}>
              <Notice tone="warning" icon="info">
                {nomeCheck.warning}
              </Notice>
            </div>
          )}

          <TextArea
            label="Descrição (opcional)"
            value={description}
            onChange={setDescription}
            rows={2}
            placeholder="do que é este servidor, em uma frase"
            ariaLabel="Descrição do servidor"
            hint="Aparece para quem está pensando em entrar. Uma linha basta."
          />

          <StepCap>Ícone</StepCap>
          <div className="csw-cats" style={{ marginBottom: ui.sm }}>
            {ICON_CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                className="csw-cat"
                aria-pressed={iconId === c.id}
                onClick={() => setIconId(c.id)}
              >
                <span className="csw-cat-ic">
                  <Ic name={c.id} size={16} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="csw-cat-t">{c.label}</span>
                  <span className="csw-cat-d">{c.desc}</span>
                </span>
              </button>
            ))}
          </div>
          <div style={{ ...{ fontSize: 12, color: ui.muted, lineHeight: 1.5 } }}>
            Escolhido: <strong style={{ color: ui.text }}>{ICON_CATEGORIES.find((c) => c.id === iconId)?.label}</strong>
          </div>
        </>
      )
    }

    if (step === 1) {
      return (
        <>
          <Notice tone="info" icon="hash">
            Um servidor precisa de pelo menos um canal de texto. Você sempre pode criar
            mais depois — em Configurações do servidor, quantos quiser.
          </Notice>
          <div style={{ height: ui.lg }} />
          <StepCap>{channels.length} {channels.length === 1 ? 'canal' : 'canais'}</StepCap>
          <div style={{ display: 'flex', flexDirection: 'column', gap: ui.sm }}>
            {channels.map((c, i) => (
              <div key={i} className="csw-chan" data-bad={channelErrors[i] !== null}>
                <span className="csw-chan-ic">
                  <Ic name={KIND_ICON[c.kind]} size={16} />
                </span>
                <div className="csw-chan-name">
                  <TextField
                    value={c.name}
                    onChange={(v) => updateChannel(i, { name: slugChannel(v) })}
                    placeholder="nome-do-canal"
                    ariaLabel={`Nome do canal ${i + 1}`}
                    error={channelErrors[i]}
                    hint="letras minúsculas, números e hífen"
                  />
                </div>
                <div className="csw-chan-kind">
                  <Select
                    value={c.kind}
                    onChange={(v) => updateChannel(i, { kind: v as ChannelKind })}
                    options={KIND_OPCOES}
                    ariaLabel={`Tipo do canal ${i + 1}`}
                  />
                </div>
                <div className="csw-chan-cat">
                  <Select
                    value={c.category}
                    onChange={(v) => updateChannel(i, { category: v })}
                    options={CATEGORIAS_PADRAO.map((c) => ({ value: c, label: c }))}
                    ariaLabel={`Categoria do canal ${i + 1}`}
                  />
                </div>
                <div className="csw-chan-del" style={{ paddingTop: 4 }}>
                  <Tooltip label={channels.length <= 1 ? 'O servidor precisa de um canal' : `Remover ${c.name}`}>
                    <span>
                      <IconButton
                        icon="trash"
                        label={`Remover canal ${c.name || i + 1}`}
                        onClick={() => removeChannel(i)}
                        disabled={channels.length <= 1}
                      />
                    </span>
                  </Tooltip>
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: ui.md }}>
            <Button icon="plus" onClick={addChannel}>
              Adicionar canal
            </Button>
          </div>
        </>
      )
    }

    if (step === 2) {
      return (
        <>
          <Notice tone="info" icon="shield">
            Os três cargos abaixo vêm prontos e marcados. Desmarque o que não quiser, ou
            renomeie. Permissões finer-grained ficam no botão de seta de cada cargo.
          </Notice>
          <div style={{ height: ui.lg }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: ui.sm }}>
            {roles.map((r) => {
              const aberto = expandedRole === r.key
              return (
                <div key={r.key} className="csw-role" data-on={r.enabled}>
                  <div className="csw-role-top">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={() => toggleRole(r.key)}
                      aria-label={`Criar cargo ${r.name}`}
                      style={{ margin: 0, width: 16, height: 16, cursor: 'pointer', accentColor: ui.accent }}
                    />
                    <span className="csw-role-dot" style={{ background: r.color }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <TextField
                        value={r.name}
                        onChange={(v) =>
                          setRoles((prev) =>
                            prev.map((p) => (p.key === r.key ? { ...p, name: v } : p)),
                          )
                        }
                        ariaLabel={`Nome do cargo ${r.name}`}
                      />
                    </div>
                    <Tooltip label={aberto ? 'Fechar permissões' : 'Ajustar permissões deste cargo'}>
                      <span>
                        <IconButton
                          icon={aberto ? 'chevronDown' : 'chevronRight'}
                          label={`Permissões do cargo ${r.name}`}
                          active={aberto}
                          onClick={() => setExpandedRole(aberto ? null : r.key)}
                        />
                      </span>
                    </Tooltip>
                  </div>
                  <div className="csw-role-why">{r.why}</div>
                  {aberto && (
                    <div className="csw-perms">
                      {(Object.keys(PERMS) as (keyof typeof PERMS)[]).map((key) => {
                        const bit = PERMS[key]
                        const pl = (PERM_LABELS as Record<number, string>)[bit] ?? key
                        return (
                          <label key={key} className="csw-check">
                            <input
                              type="checkbox"
                              checked={(r.permissions & bit) !== 0}
                              onChange={() => togglePerm(r.key, bit)}
                            />
                            {pl}
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {cargosAtivos.length === 0 && (
            <div style={{ marginTop: ui.md }}>
              <Notice tone="warning" icon="warn">
                Nenhum cargo marcado. O servidor funciona assim mesmo — todo mundo entra
                com o mesmo nível, e você pode criar cargos depois.
              </Notice>
            </div>
          )}
        </>
      )
    }

    if (step === PASSO_REGRAS) {
      return (
        <>
          <Notice tone="info" icon="file">
            Regras são opcionais. Pode deixar em branco e criar o servidor do mesmo jeito —
            o campo só aparece para quem entra depois.
          </Notice>
          <div style={{ height: ui.lg }} />
          <TextArea
            label="Regras do servidor (opcional)"
            value={rulesText}
            onChange={setRulesText}
            rows={7}
            maxLength={LIMITE_REGRAS}
            placeholder={'1. Respeite todo mundo.\n2. Nada de spam nem link quebrado.\n3. Duvida? Pergunta no canal geral.'}
            ariaLabel="Regras do servidor"
            hint="Uma regra por linha. Elas aparecem para quem está pensando em entrar."
          />
          <div className="csw-count">
            {rulesText.length}/{LIMITE_REGRAS}
          </div>
          {error && (
            <div style={{ marginTop: ui.lg }}>
              <Notice tone="danger" icon="warn">
                {error}
              </Notice>
            </div>
          )}
        </>
      )
    }

    // Passo concluído
    return (
      <>
        <div className="csw-done">
          <span className="csw-done-ic">
            <Ic name="check" size={30} />
          </span>
          <div style={{ fontSize: 19, fontWeight: 900, color: ui.heading }}>Servidor criado</div>
          <div style={{ fontSize: 13, color: ui.muted, maxWidth: 460, lineHeight: 1.55 }}>
            {name.trim()} está no seu rail, com {validosCount} {validosCount === 1 ? 'canal' : 'canais'} e{' '}
            {cargosAtivos.length} {cargosAtivos.length === 1 ? 'cargo' : 'cargos'}. Para
            alguém entrar, mande o convite abaixo.
          </div>
        </div>
        <LocalLink
          url={inviteUrl}
          label="Convite"
          context="Dois endereços porque são para lugares diferentes: localhost só abre neste computador. Para mandar para o celular, use o endereço de rede."
        />
        <div style={{ marginTop: ui.lg }}>
          <Notice tone="warning" icon="warn">
            O endereço de rede só alcança o celular se os dois estiverem na mesma rede
            Wi-Fi. Fora disso, não há como entrar pelo link — o app é de rede local.
          </Notice>
        </div>
      </>
    )
  })()

  const titulo =
    step === 0 ? 'O que é este servidor?'
      : step === 1 ? 'Canais'
        : step === 2 ? 'Cargos'
          : step === 3 ? 'Regras'
            : 'Servidor criado'

  const subtitulo =
    step === 0 ? 'Nome, descrição e o que ele é. O resto do fluxo sai daqui.'
      : step === 1 ? 'O que a pessoa vê quando entra.'
        : step === 2 ? 'Quem pode fazer o quê. Pode deixar como está.'
          : step === 3 ? 'Opcional. Pode pular.'
            : undefined

  return (
    <>
      <style>{css}</style>
      <Modal
        open={open}
        onClose={busy ? () => {} : onClose}
        title={titulo}
        subtitle={subtitulo}
        width={WIDTHS.wizard}
        labelId="csw-title"
        dialogLabel="Criar servidor"
        footer={footer}
      >
        {/* Indicador de passos: 4 segmentos. Clicar só volta para passo já
            alcançado — pular direto para cargos deixaria canais vazios. */}
        <nav
          aria-label="Etapas da criação"
          style={{ display: 'flex', gap: 6, marginBottom: ui.xl }}
        >
          {STEP_LABELS.map((label, i) => {
            const state = step === PASSO_CONCLUIDO || i < step ? 'done' : i === step ? 'now' : 'todo'
            const podeIr = i <= visited && step !== PASSO_CONCLUIDO && !busy
            return (
              <button
                key={label}
                type="button"
                className="csw-seg"
                data-state={state}
                disabled={!podeIr}
                aria-current={i === step ? 'step' : undefined}
                aria-label={`Etapa ${i + 1}: ${label}${state === 'done' ? ', concluída' : state === 'now' ? ', atual' : ''}`}
                onClick={() => goTo(i)}
              >
                <span className="csw-seg-bar" />
                <span className="csw-seg-l">
                  <span className="csw-seg-n">
                    {state === 'done' ? <Ic name="check" size={9} stroke={3} /> : i + 1}
                  </span>
                  <span className="csw-seg-t">{label}</span>
                </span>
              </button>
            )
          })}
        </nav>

        <div className="csw-cols" ref={mainRef}>
          {/* Conteúdo do passo. `role="group"` + `aria-label` para que o leitor
              de tela anuncie a troca de contexto, não só a troca de texto. */}
          <div
            className="csw-main"
            role="group"
            aria-label={concluido ? `Servidor criado: ${titulo}` : `Passo ${step + 1} de 4: ${titulo}`}
          >
            {conteudo}
          </div>

          {!concluido && (
            <aside className="csw-side" aria-label="Resumo do servidor">
              <div className="csw-prev">
                <span className="csw-prev-ic">
                  <Ic name={iconId} size={20} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="csw-prev-n" style={{ display: 'block' }}>
                    {name.trim() || 'Sem nome ainda'}
                  </span>
                  <span className="csw-prev-d" style={{ display: 'block' }}>
                    {description.trim() || 'Sem descrição'}
                  </span>
                </span>
              </div>

              <SideBox icon="hash" title="Canais">
                <div className="csw-list">
                  {channels.length === 0 && <div style={{ fontSize: 12, color: ui.muted }}>nenhum</div>}
                  {channels.map((c, i) => (
                    <div key={i} className="csw-li">
                      <span className="csw-li-i">
                        <Ic name={KIND_ICON[c.kind]} size={13} />
                      </span>
                      <span style={{ color: channelErrors[i] ? '#ff9c9c' : undefined }}>
                        {c.name || '(sem nome)'}
                      </span>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className="csw-tag">
                    {canaisTexto} {canaisTexto === 1 ? 'texto' : 'texto'}
                  </span>
                  {canaisVoz > 0 && <span className="csw-tag">{canaisVoz} voz</span>}
                </div>
              </SideBox>

              <SideBox icon="shield" title="Cargos">
                {cargosAtivos.length === 0 ? (
                  <div style={{ fontSize: 12, color: ui.muted }}>nenhum cargo marcado</div>
                ) : (
                  <div className="csw-list">
                    {cargosAtivos.map((r) => (
                      <div key={r.key} className="csw-li">
                        <span className="csw-role-dot" style={{ background: r.color }} />
                        <span>{r.name.trim() || r.key}</span>
                      </div>
                    ))}
                  </div>
                )}
              </SideBox>

              <SideBox icon="file" title="Regras">
                {rulesText.trim() ? (
                  <div style={{ fontSize: 12, color: ui.text, lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 88, overflowY: 'auto' }}>
                    {rulesText.trim()}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: ui.muted }}>nenhuma — opcional</div>
                )}
              </SideBox>
            </aside>
          )}
        </div>
      </Modal>
    </>
  )
}
