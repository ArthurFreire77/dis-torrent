/**
 * Adaptador de compatibilidade para o parser único de markdown.
 *
 * HISTÓRICO: existiam TRÊS implementações do dialeto Discord (esta,
 * `Social.parseDiscord` e `shared/markdown.tsx`). Isso significava que um
 * spoiler funcionava no desktop e não no celular. Agora há UM parser
 * (`markdown.tsx`) e este arquivo só traduz o formato de contexto antigo
 * (`InlineCtx`) para o novo (`MentionHit`), preservando a API pública que
 * `MobileShell`/`MobileMessage` já usam.
 *
 * O parser canônico vive em `./markdown` — NÃO duplique a lógica aqui.
 */

import { useMemo, useState } from 'react'
import { Markdown, type MarkdownTheme, type MentionHit, DEFAULT_MARKDOWN_THEME } from './markdown'

/** Contexto legado (maps de menção/emoji). Mantido por compatibilidade. */
export interface InlineCtx {
  /** fingerprints que menções @user devem destacar */
  mentionFps: Set<string>
  /** nome exibido por fingerprint (para casar @apelido) */
  names: Map<string, string>
  /** cargos do servidor: apelido -> cor (menção colorida) */
  roleNames: Map<string, string>
  serverEmojis: Map<string, string>
  myFp: string
}

export function emptyCtx(myFp = ''): InlineCtx {
  return { mentionFps: new Set(), names: new Map(), roleNames: new Map(), serverEmojis: new Set() as never, myFp }
}

/** Cores do tema mobile — mantidas em paridade com o `THEME` original. */
export const THEME = DEFAULT_MARKDOWN_THEME

export interface RichProps {
  body: string
  ctx: InlineCtx
  color?: string
  fontSize?: number
}

/**
 * Resolve um token de menção contra o contexto legado.
 * Ordem: @everyone/@here → cargo (com espaço) → usuário por apelido/fp.
 */
function makeResolver(ctx: InlineCtx) {
  return (token: string): MentionHit | null => {
    const raw = token.trim()
    const lower = raw.toLowerCase()
    if (lower === 'everyone') return { kind: 'everyone', label: 'everyone', noteIndex: 0 }
    if (lower === 'here') return { kind: 'here', label: 'here', noteIndex: 0 }
    if (ctx.roleNames.has(raw)) {
      return { kind: 'role', label: raw, color: ctx.roleNames.get(raw), noteIndex: 0 }
    }
    const fp = ctx.mentionFps.has(raw) ? raw : null
    if (fp) return { kind: 'user', label: ctx.names.get(fp) ?? raw, fp, noteIndex: 0 }
    // Fallback por apelido: '@Zero' onde o fp é o id completo.
    for (const [key, name] of ctx.names) {
      if (name === raw) return { kind: 'user', label: name, fp: key, noteIndex: 0 }
    }
    return null
  }
}

export function RichText({ body, ctx, color = THEME.text, fontSize = 14 }: RichProps) {
  // Spoilers revelados por PRIMEIRA aparição do trecho (não por índice global):
  // a chave estável evita que revelar um spoiler de outra linha desfaça este.
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const theme = useMemo<MarkdownTheme>(
    () => ({ ...DEFAULT_MARKDOWN_THEME, text: color, fontSize }),
    [color, fontSize],
  )
  const resolveMention = useMemo(() => makeResolver(ctx), [ctx])
  const resolveEmoji = useMemo(() => (name: string) => ctx.serverEmojis.get(name) ?? null, [ctx.serverEmojis])
  const revealedSet = useMemo(() => new Set(Object.keys(revealed).filter((k) => revealed[k])), [revealed])

  return (
    <Markdown
      body={body}
      theme={theme}
      resolveMention={resolveMention}
      resolveEmoji={resolveEmoji}
      revealedSpoilers={revealedSet}
      onRevealSpoiler={(k) => setRevealed((s) => ({ ...s, [k]: true }))}
      style={{ fontSize }}
    />
  )
}
