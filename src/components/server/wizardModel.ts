// Dados e regras PURAS do assistente de criação de servidor.
//
// POR QUE FORA DO COMPONENTE: o wizard tinha 1191 linhas e misturava catálogo,
// validação, criação e sete blocos de JSX. Aqui ficam só as decisões (o que é um
// nome válido, quais canais o modelo traz, qual categoria um tipo de canal usa),
// sem React e sem `services` — assim dá para testar em `node --test` e a tela
// não precisa ser montada para provar que a regra está certa.
//
// REGRA QUE MUDOU (bug real): o limite do nome era `60` hardcoded aqui e
// `64` no core (`names.rs`), com a checagem local inventando as próprias
// mensagens. O resultado era servidor recusado pelo core depois de o wizard
// dizer que estava tudo certo. Agora a validação é UMA: a do core.

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
  /** Uma linha explicando o que o cargo FAZ. É o que o resumo mostra. */
  why: string
}

export interface IconCategory {
  id: IconName
  label: string
  desc: string
}

/** Limite do nome do servidor — o MESMO do core (`names::POLICY[Server]`). */
export const LIMITE_NOME = 64
export const LIMITE_REGRAS = 2000

export const PASSO_REGRAS = 3
export const PASSO_CONCLUIDO = 4

export const STEP_LABELS = ['Identidade', 'Canais', 'Cargos', 'Regras'] as const

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

/**
 * Categorias de ícone. Substituem os oito emoji: cada uma tem nome e diz o que
 * costuma ser um servidor daquele tipo, que é a informação que o emoji tentava
 * dar de jeito.
 */
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

/**
 * Modelos que PRÉ-PREENCHEM descrição, ícone e canais. Não pulam passo: a pessoa
 * pode ignorar e escrever tudo à mão. O modelo só oferece um ponto de partida
 * coerente — e nunca sobrescreve o nome, que é a única coisa que ela escreveu.
 */
export const MODELOS: {
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

export function categoryFor(kind: ChannelKind): string {
  if (kind === 'voice') return CATEGORIAS_PADRAO[1]
  if (kind === 'video') return CATEGORIAS_PADRAO[2]
  return CATEGORIAS_PADRAO[0]
}

export function initialChannels(): WizardChannel[] {
  return [{ name: 'geral', kind: 'text', category: categoryFor('text') }]
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

/** Canais como `ChannelMeta` — o que `validateChannelName` espera. */
export function channelsAsMeta(channels: WizardChannel[]): ChannelMeta[] {
  return channels.map((c, i) => ({
    id: String(i),
    name: c.name,
    category: c.category,
    position: i,
    kind: c.kind,
  }))
}

/** Erro por canal, no mesmo índice. `null` = válido. */
export function channelErrorsOf(channels: WizardChannel[]): (string | null)[] {
  const meta = channelsAsMeta(channels)
  return channels.map((c, i) => validateChannelName(c.name, meta, String(i)))
}

export interface NameCheck {
  error: string | null
  warning: string | null
  /** Nome já normalizado pelo core (o que será gravado). */
  normalized: string
}

/**
 * Validação do nome do servidor em tempo real.
 *
 * Delega para `validateNameLocal` — o MESMO espelho do core que o resto do app
 * usa (`user`/`server`/`channel`, skeletons anti-homoglifo, reservados e nomes
 * bloqueados). Antes o wizard tinha um `checkName` próprio com limite 60 e sem
 * nenhuma dessas regras: o core recusava depois e o erro aparecia como falha
 * genérica.
 *
 * O aviso "isso parece nome de pessoa" continua aqui porque é conselho de
 * produto, não regra de validação — o core não tem como saber.
 */
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

/**
 * Heurística de "nome de pessoa": UMA palavra, sem dígito, capitalizada,
 * comprimento de nome de gente. Deliberadamente rasa — o custo de um falso
 * positivo é um aviso que a pessoa ignora; o custo de um falso negativo é o
 * servidor chamado "Arthur" para sempre.
 */
export function pareceNomeDePessoa(nome: string): boolean {
  if (/\s/.test(nome)) return false
  if (/\d/.test(nome)) return false
  if (nome.length < 3 || nome.length > 14) return false
  return /^[A-ZÀ-Ý][a-zà-ÿ]+$/.test(nome)
}

export function nomeVazio(v: string): boolean {
  return v.trim().length < 2
}
