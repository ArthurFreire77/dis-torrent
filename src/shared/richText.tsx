import { useMemo, useState } from 'react'
import { Markdown, type MarkdownTheme, type MentionHit, DEFAULT_MARKDOWN_THEME } from './markdown'

export interface InlineCtx {
  mentionFps: Set<string>
  names: Map<string, string>
  roleNames: Map<string, string>
  serverEmojis: Map<string, string>
  myFp: string
}

export function emptyCtx(myFp = ''): InlineCtx {
  return { mentionFps: new Set(), names: new Map(), roleNames: new Map(), serverEmojis: new Set() as never, myFp }
}

export const THEME = DEFAULT_MARKDOWN_THEME

export interface RichProps {
  body: string
  ctx: InlineCtx
  color?: string
  fontSize?: number
}

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
    for (const [key, name] of ctx.names) {
      if (name === raw) return { kind: 'user', label: name, fp: key, noteIndex: 0 }
    }
    return null
  }
}

export function RichText({ body, ctx, color = THEME.text, fontSize = 14 }: RichProps) {
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
