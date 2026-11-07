import type { ChannelMeta } from '../../services/models.ts'
import { validateNameLocal } from '../../core/security/names.ts'
import { CATEGORIAS_PADRAO, validateChannelName } from './channelRules.ts'
import type { IconName } from '../../shared/icons'
import { PERMS } from '../../services/models.ts'

export type ChannelKind = 'text' | 'voice' | 'video'

export interface WizardChannel {
  name: string
  kind: ChannelKind
  category: string
}

export interface RolePreset {
  key: string
  name: string
  color: string
  permissions: number
  hoist: boolean
  mentionable: boolean
  enabled: boolean
  why: string
}

export interface IconCategory {
  id: IconName
  label: string
  desc: string
}

export const LIMITE_NOME = 64
export const LIMITE_REGRAS = 2000

export const PASSO_REGRAS = 4
export const PASSO_CONCLUIDO = 5

export const STEP_LABELS = ['Identidade', 'Canais', 'Cargos', 'Bots', 'Regras'] as const

export const KIND_ICON: Record<ChannelKind, IconName> = {
  text: 'hash',
  voice: 'speaker',
  video: 'video',
}
export const KIND_LABEL: Record<ChannelKind, string> = {
  text: 'Texto',
  voice: 'Voz',
  video: 'Vídeo',
}

export const KIND_OPCOES = (Object.keys(KIND_LABEL) as ChannelKind[]).map((k) => ({
  value: k,
  label: KIND_LABEL[k],
}))

export const ICON_CATEGORIES: IconCategory[] = [
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

export const MODELOS: {
  id: string
  label: string
  desc: string
  icon: IconName
  tint: string
  description: string
  channels: { name: string; kind: ChannelKind }[]
}[] = [
  {
    id: 'jogos',
    label: 'Jogos',
    desc: 'Partidas, torneios e sala de jogo',
    icon: 'crown',
    tint: '#f0b232',
    description: 'Para marcar partida, combinar horário e conversar durante o jogo.',
    channels: [
      { name: 'geral', kind: 'text' },
      { name: 'partidas', kind: 'text' },
      { name: 'sala-de-jogo', kind: 'voice' },
    ],
  },
  {
    id: 'amigos',
    label: 'Amigos',
    desc: 'Bate-papo e encontros do grupo',
    icon: 'users',
    tint: '#eb459e',
    description: 'Espaço para conversar, combinar o que fazer e manter todo mundo por perto.',
    channels: [
      { name: 'geral', kind: 'text' },
      { name: 'memes', kind: 'text' },
      { name: 'encontros', kind: 'voice' },
    ],
  },
  {
    id: 'estudo',
    label: 'Grupo de estudos',
    desc: 'Aulas, avisos e materiais',
    icon: 'code',
    tint: '#23a559',
    description: 'Grupo de estudos: avisos de aula, materiais compartilhados e dúvidas.',
    channels: [
      { name: 'geral', kind: 'text' },
      { name: 'avisos', kind: 'text' },
      { name: 'materiais', kind: 'text' },
      { name: 'sala-de-estudo', kind: 'voice' },
    ],
  },
  {
    id: 'escola',
    label: 'Clube escolar',
    desc: 'Turma, projetos e atividades',
    icon: 'folder',
    tint: '#5865f2',
    description: 'Clube da escola: avisos da turma, projetos e encontros.',
    channels: [
      { name: 'geral', kind: 'text' },
      { name: 'projetos', kind: 'text' },
      { name: 'encontros', kind: 'voice' },
    ],
  },
]

export function categoryFor(kind: ChannelKind): string {
  if (kind === 'voice') return CATEGORIAS_PADRAO[1]
  if (kind === 'video') return CATEGORIAS_PADRAO[2]
  return CATEGORIAS_PADRAO[0]
}

export function initialChannels(): WizardChannel[] {
  return [{ name: 'geral', kind: 'text', category: categoryFor('text') }]
}

export function novoBotWizardModel(): { name: string; roleId: string | null; template: 'vazio' | 'clima' } {
  return { name: 'Bot', roleId: null, template: 'vazio' }
}

export function initialRoles(): RolePreset[] {
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

export function slugChannel(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function channelsAsMeta(channels: WizardChannel[]): ChannelMeta[] {
  return channels.map((c, i) => ({
    id: String(i),
    name: c.name,
    category: c.category,
    position: i,
    kind: c.kind,
  }))
}

export function channelErrorsOf(channels: WizardChannel[]): (string | null)[] {
  const meta = channelsAsMeta(channels)
  return channels.map((c, i) => validateChannelName(c.name, meta, String(i)))
}

export interface NameCheck {
  error: string | null
  warning: string | null
  normalized: string
}

export function checkServerName(raw: string, existing: string[] = []): NameCheck {
  const trimmed = raw.trim()
  if (!trimmed) return { error: null, warning: null, normalized: '' }
  if (/\s{2,}/.test(trimmed)) {
    return { error: 'Espaço duplo no meio do nome. Um espaço só já basta.', warning: null, normalized: trimmed }
  }
  const check = validateNameLocal('server', trimmed, existing)
  if (!check.ok) {
    return { error: check.errors[0] ?? 'nome inválido', warning: null, normalized: check.normalized }
  }
  return {
    error: null,
    warning: pareceNomeDePessoa(trimmed) ? AVISO_NOME_PESSOA : null,
    normalized: check.normalized,
  }
}

export const AVISO_NOME_PESSOA =
  'Isso parece o nome de uma pessoa. Se for, considere um tema: é mais fácil achar o servidor depois e o nome não fica ambíguo no rail.'

export function pareceNomeDePessoa(nome: string): boolean {
  if (/\s/.test(nome)) return false
  if (/\d/.test(nome)) return false
  if (nome.length < 3 || nome.length > 14) return false
  return /^[A-ZÀ-Ý][a-zà-ÿ]+$/.test(nome)
}

export function nomeVazio(v: string): boolean {
  return v.trim().length < 2
}
