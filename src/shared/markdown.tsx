/**
 * Renderizador de markdown no dialeto EXATO do Discord.
 *
 * Por que um parser próprio e não uma lib: o Discord não usa CommonMark. A
 * sintaxe dele éZsingular — `__sublinhado__` (não negrito), `*itálico*`,
 * `**negrito**`, `~~tachado~~`, `# H1`, `-# subtexto`, `||spoiler||`,
 * `/spoiler` e bloco ```. Uma lib genérica erraria metade disso, e o projeto
 * é local-first: não queremos adicionar dependência por um parser de 200 linhas.
 *
 * Parser em duas passagens: PRIMEIRO um scanner de blocos (linha a linha →
 * code block, heading, lista, citação), DEPOIS um scanner inline por linha.
 * Isso é o que permite que `` `code` `` dentro de um bullet não quebre o
 * bullet, e que um ``` abra/feche corretamente mesmo cercado de texto.
 *
 * Segurança: NUNCA produzimos `dangerouslySetInnerHTML`. Saída é árvore React,
 * então React escapa tudo — não existe XSS possível aqui por construção, e
 * `sanitize.ts` (usado nos bots) continua sendo a barreira do texto que vem do
 * motor. URLs passam por `safeUrl()` que só aceita http/https/mailto.
 */

import { Fragment, useState, type ReactNode } from 'react'

// ---------------------------------------------------------------------------
// URL segura — bloqueia javascript:, data:, vbscript: e friends.
// ---------------------------------------------------------------------------

const SAFE_PROTO = /^(https?:|mailto:)/i

export function safeUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  // Strip de whitespace/control chars que o navegador ignora ao resolver o
  // esquema ("java\tscript:" continua sendo javascript: no motor).
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/[\u0000-\u0020\s]/g, '')
  if (!SAFE_PROTO.test(stripped)) return null
  return s
}

/** Detecta URL "pelada" no meio de texto (como o Discord faz ao colar). */
export function findBareUrl(text: string): string | null {
  const m = text.match(/(?:https?:\/\/|www\.)[^\s<>"']{2,}/i)
  if (!m) return null
  const raw = m[0]
  return raw.startsWith('www.') ? `https://${raw}` : raw
}

// ---------------------------------------------------------------------------
// Núcleos
// ---------------------------------------------------------------------------

interface InlineCtx {
  /** Resolve menção @fp para nome/cargo — fornecido pelo shell. */
  resolveMention: (token: string) => MentionHit | null
  /** Resolves emoji customizado :nome: do servidor. */
  resolveEmoji: (name: string) => string | null
  onMentionClick?: (hit: MentionHit) => void
  /** Spoilers revelados são controlados pelo chamador (persistência). */
  revealedSpoilers: Set<string>
  onRevealSpoiler: (key: string) => void
  /** Contador único por render — evita colisão de chave entre spoilers. */
  spoilerSeq: { n: number }
}

export interface MentionHit {
  kind: 'everyone' | 'here' | 'role' | 'user'
  /** Rótulo exibido (display name do usuário / nome do cargo). */
  label: string
  /** Cor do cargo quando aplicável. */
  color?: string
  /** fp do usuário, para abrir o perfil. */
  fp?: string
  /** Índice de NOTE de para qual mensagem a menção rola. */
  noteIndex: number
}

/** Uma linha classificada pelo scanner de blocos. */
type Block =
  | { t: 'code'; lang: string; lines: string[] }
  | { t: 'text'; lines: string[] }

function classifyBlocks(src: string): Block[] {
  const lines = src.split('\n')
  const out: Block[] = []
  let i = 0
  let textBuf: string[] = []

  const flush = () => {
    if (textBuf.length) {
      out.push({ t: 'text', lines: textBuf })
      textBuf = []
    }
  }

  while (i < lines.length) {
    const line = lines[i]
    // Code fence: ``` ou ```lang (o Discord só aceita fence de 3+)
    const fence = line.match(/^\s*(`{3,})([^`]*)$/)
    if (fence) {
      flush()
      const marker = fence[1]
      const lang = fence[2].trim().slice(0, 32)
      const body: string[] = []
      i++
      while (i < lines.length) {
        const close = lines[i].match(/^\s*(`{3,})\s*$/)
        // Só fecha com o MESMO tamanho de fence (``` dentro de ```` é conteúdo).
        if (close && close[1].length >= marker.length) { i++; break }
        body.push(lines[i])
        i++
      }
      out.push({ t: 'code', lang, lines: body })
      continue
    }
    textBuf.push(line)
    i++
  }
  flush()
  return out
}

// ---------------------------------------------------------------------------
// Scanner inline
// ---------------------------------------------------------------------------

/** Um token inline. `raw` = texto literal (React escapa sozinho). */
type Token =
  | { t: 'text'; raw: string }
  | { t: 'bold'; children: Token[] }
  | { t: 'italic'; children: Token[] }
  | { t: 'under'; children: Token[] }
  | { t: 'strike'; children: Token[] }
  | { t: 'code'; raw: string }
  | { t: 'spoiler'; children: Token[] }
  | { t: 'link'; label: string; href: string }
  | { t: 'bare'; href: string; label: string }
  | { t: 'mention'; hit: MentionHit }
  | { t: 'emoji'; ch: string }
  | { t: 'br' }

/**
 * Casa um par de delimitadores e devolve os tokens internos.
 * Devolve null se não houver fechamento válido — aí o texto é literal, que é
 * exatamente o comportamento do Discord (`*sem fechamento*` fica com asterisco).
 */
function tryDelimited(
  src: string,
  start: number,
  open: string,
  close: string,
  make: (children: Token[]) => Token,
): { node: Token; next: number } | null {
  // Delimitador precisa ter conteúdo logo depois (Discord ignora `****`).
  if (!src.startsWith(open, start)) return null
  const contentStart = start + open.length
  if (contentStart >= src.length) return null
  if (src[contentStart] === ' ' && open.length > 1) return null

  let depth = 0
  for (let i = contentStart; i < src.length; i++) {
    if (src.startsWith(open, i) && !src.startsWith(close, i)) depth++
    if (src.startsWith(close, i)) {
      if (depth === 0) {
        const inner = src.slice(contentStart, i)
        if (inner.length === 0) return null
        if (src[i + close.length] === ' ' && close.length > 1) return null
        return { node: make(parseInline(inner, null, 0)), next: i + close.length }
      }
      depth--
    }
  }
  return null
}

function parseInline(src: string, ctx: InlineCtx | null, depth: number): Token[] {
  const out: Token[] = []
  let buf = ''
  const flush = () => {
    if (buf) { out.push({ t: 'text', raw: buf }); buf = '' }
  }
  // Spoilers não aninham (igual Discord) — PROFUNDIDADE 1.
  const effDepth = Math.min(depth, 1)

  for (let i = 0; i < src.length; ) {
    const ch = src[i]

    // --- escape \  --------------------------------------------------
    if (ch === '\\' && i + 1 < src.length) {
      const n = src[i + 1]
      if ('*_~`>#-|:\\'.includes(n)) {
        buf += n
        i += 2
        continue
      }
    }

    // --- código inline  ---------------------------------------------
    if (ch === '`') {
      const ticks = src.slice(i).match(/^(`+)/)?.[1] ?? '`'
      const closeIdx = src.indexOf(ticks, i + ticks.length)
      if (closeIdx > 0) {
        const inner = src.slice(i + ticks.length, closeIdx)
        if (!inner.includes('\n')) {
          flush()
          out.push({ t: 'code', raw: inner })
          i = closeIdx + ticks.length
          continue
        }
      }
    }

    // --- spoiler  ||...||  e  /spoiler  -------------------------------
    if (effDepth === 0) {
      if (src.startsWith('||', i)) {
        const end = src.indexOf('||', i + 2)
        if (end > 0) {
          flush()
          const key = `sp${ctx ? ctx.spoilerSeq.n++ : 0}_${end}`
          out.push({
            t: 'spoiler',
            children: parseInline(src.slice(i + 2, end), ctx, 1),
            // `key` carregado no nó para o shell revelar.
          } as Token & { key?: string })
          ;(out[out.length - 1] as Token & { key?: string }).key = key
          i = end + 2
          continue
        }
      }
      if (src.startsWith('/spoiler', i)) {
        const end = src.indexOf('\n', i + 8)
        const stop = end === -1 ? src.length : end
        const inner = src.slice(i + 8, stop).replace(/^\s+/, '')
        flush()
        out.push({ t: 'spoiler', children: parseInline(inner, ctx, 1) })
        i = stop
        continue
      }
    }

    // --- link mascarada  [texto](url)  --------------------------------
    if (ch === '[') {
      const close = src.indexOf('](', i)
      if (close > i) {
        const labelRaw = src.slice(i + 1, close)
        const end = src.indexOf(')', close + 2)
        if (end > 0) {
          const hrefRaw = src.slice(close + 2, end)
          const href = safeUrl(hrefRaw)
          if (href) {
            flush()
            out.push({ t: 'link', label: labelRaw || href, href })
            i = end + 1
            continue
          }
        }
      }
    }

    // --- URL pelada  --------------------------------------------------
    if ((ch === 'h' && src.startsWith('http', i)) || (ch === 'w' && src.startsWith('www.', i))) {
      const m = src.slice(i).match(/^(https?:\/\/|www\.)[^\s<>()"'`]+/i)
      if (m) {
        const href = safeUrl(m[0].startsWith('www.') ? `https://${m[0]}` : m[0])
        if (href) {
          flush()
          // Corta pontuação final que costuma estar fora do link.
          const trimmed = href.replace(/[.,;:!?]+$/, '')
          out.push({ t: 'bare', href: trimmed, label: trimmed.replace(/^https?:\/\//, '') })
          i += trimmed.length
          continue
        }
      }
    }

    // --- menções  @everyone @here @role @user  ------------------------
    if (ch === '@' && ctx) {
      const rest = src.slice(i + 1)
      if (/^(everyone|here|channel)\b/i.test(rest)) {
        const kindTok = rest.match(/^(everyone|here|channel)/i)![1].toLowerCase()
        const hit = ctx.resolveMention(kindTok)
        if (hit) {
          flush()
          out.push({ t: 'mention', hit })
          i += 1 + kindTok.length
          continue
        }
      }
      // @Cargo (com espaço) ou @user (sem espaço, até whitespace/fim)
      const m = rest.match(/^([^\s@:,;!?()[\]{}<>"'`|]{1,64})/)
      if (m) {
        const hit = ctx.resolveMention(m[1])
        if (hit) {
          flush()
          out.push({ t: 'mention', hit })
          i += 1 + m[1].length
          continue
        }
      }
    }

    // --- emoji customizado  :nome:  -----------------------------------
    if (ch === ':' && ctx) {
      const m = src.slice(i + 1).match(/^([A-Za-z0-9_]{2,32}):/)
      if (m) {
        const glyph = ctx.resolveEmoji(m[1])
        if (glyph) {
          flush()
          out.push({ t: 'emoji', ch: glyph })
          i += 1 + m[1].length + 1
          continue
        }
      }
    }

    // --- ênfase ----------------------------------------------------------
    // Ordem importa: primeiro o par (negrito/sublinhado), depois o simples
    // (itálico). Sem isso `**a**` seria lido como itálico de `*` + resto.
    if (ch === '_' || ch === '*') {
      const isDbl = src[i + 1] === ch
      const pair = ch + ch
      let hit: { node: Token; next: number } | null = null

      if (isDbl) {
        hit =
          ch === '_'
            ? tryDelimited(src, i, pair, pair, (c) => ({ t: 'under', children: c }))
            : tryDelimited(src, i, pair, pair, (c) => ({ t: 'bold', children: c }))
      }
      if (!hit) {
        // `**x**` com o fechamento tolerado como `*x*` (markdown legado).
        hit = isDbl ? tryDelimited(src, i, pair, ch, (c) => ({ t: 'bold', children: c })) : null
      }
      if (!hit) {
        hit = tryDelimited(src, i, ch, ch, (c) => ({ t: 'italic', children: c }))
      }
      if (hit) {
        flush()
        out.push(hit.node)
        i = hit.next
        continue
      }
    }

    // --- tachado  ~~...~~ ---------------------------------------------
    if (ch === '~' && src.startsWith('~~', i)) {
      const s = tryDelimited(src, i, '~~', '~~', (c) => ({ t: 'strike', children: c }))
      if (s) {
        flush()
        out.push(s.node)
        i = s.next
        continue
      }
    }

    // --- emoji literal ------------------------------------------------
    if (ch === ':' || /\p{Extended_Pictographic}/u.test(ch)) {
      const m = src.slice(i).match(/^\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/u)
      if (m && m[0].length > 0 && m[0] !== ch) {
        flush()
        out.push({ t: 'emoji', ch: m[0] })
        i += m[0].length
        continue
      }
      if (m && m[0].length === 1 && ch.match(/\p{Extended_Pictographic}/u)) {
        // emoji simples — deixa no buffer como texto (renderiza igual)
      }
    }

    if (ch === '\n') {
      flush()
      out.push({ t: 'br' })
      i++
      continue
    }

    buf += ch
    i++
  }
  flush()
  return out
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface MarkdownTheme {
  text: string
  heading: string
  muted: string
  accent: string
  link: string
  codeBg: string
  codeFg: string
  spoilerBg: string
  mentionBg: string
  border: string
  quoteBar: string
  font: string
  mono: string
  /** fundo do cabeçalho do bloco de código (linguagem + copiar) */
  codeHead?: string
}

export const DEFAULT_MARKDOWN_THEME: MarkdownTheme = {
  text: '#dbdee1',
  heading: '#f2f3f5',
  muted: '#949ba4',
  accent: '#5865f2',
  link: '#00a8fc',
  codeBg: '#2b2d31',
  codeHead: '#2b2d31',
  codeFg: '#e3e5e8',
  spoilerBg: '#232428',
  mentionBg: 'rgba(88,101,242,0.18)',
  border: '#404249',
  quoteBar: '#4e5058',
  font: 'Inter, system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
}

function renderTokens(
  toks: Token[],
  ctx: InlineCtx,
  th: MarkdownTheme,
  keyPrefix: string,
  opts: { inQuote?: boolean; headingLevel?: number; inCode?: boolean } = {},
): ReactNode[] {
  return toks.map((tk, i) => {
    const k = `${keyPrefix}.${i}`
    switch (tk.t) {
      case 'text':
        return <Fragment key={k}>{tk.raw}</Fragment>
      case 'br':
        return <br key={k} />
      case 'bold':
        return <strong key={k} style={{ fontWeight: 700 }}>{renderTokens(tk.children, ctx, th, k, opts)}</strong>
      case 'italic':
        return <em key={k} style={{ fontStyle: 'italic' }}>{renderTokens(tk.children, ctx, th, k, opts)}</em>
      case 'under':
        return <span key={k} style={{ textDecoration: 'underline' }}>{renderTokens(tk.children, ctx, th, k, opts)}</span>
      case 'strike':
        return <span key={k} style={{ textDecoration: 'line-through' }}>{renderTokens(tk.children, ctx, th, k, opts)}</span>
      case 'code':
        return (
          <code
            key={k}
            style={{
              background: th.codeBg,
              border: `1px solid ${th.border}`,
              borderRadius: 3,
              padding: '1px 3px',
              fontFamily: th.mono,
              fontSize: '0.85em',
              color: th.codeFg,
              whiteSpace: 'pre-wrap',
            }}
          >
            {tk.raw}
          </code>
        )
      case 'spoiler': {
        const key = (tk as Token & { key?: string }).key ?? `sp${i}`
        const revealed = ctx.revealedSpoilers.has(key)
        return (
          <span
            key={k}
            role="button"
            tabIndex={0}
            aria-label={revealed ? 'Spoiler revelado' : 'Spoiler — clique para revelar'}
            onClick={revealed ? undefined : () => ctx.onRevealSpoiler(key)}
            onKeyDown={(e) => {
              if (revealed) return
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.onRevealSpoiler(key) }
            }}
            style={{
              background: revealed ? 'transparent' : th.spoilerBg,
              borderRadius: 3,
              cursor: revealed ? 'default' : 'pointer',
              color: revealed ? undefined : 'transparent',
              textShadow: revealed ? 'none' : '0 0 9px currentColor',
              userSelect: revealed ? 'auto' : 'none',
            }}
          >
            {renderTokens(tk.children, ctx, th, k, opts)}
          </span>
        )
      }
      case 'link':
        return (
          <a
            key={k}
            href={tk.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            style={{ color: th.link, textDecoration: 'none' }}
            onClick={(e) => e.stopPropagation()}
          >
            {tk.label}
          </a>
        )
      case 'bare':
        return (
          <a
            key={k}
            href={tk.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            style={{ color: th.link, textDecoration: 'none' }}
            onClick={(e) => e.stopPropagation()}
          >
            {tk.label}
          </a>
        )
      case 'emoji':
        return (
          <span key={k} style={{ fontSize: '1.35em', verticalAlign: '-0.15em', lineHeight: 1 }} role="img" aria-label="emoji">
            {tk.ch}
          </span>
        )
      case 'mention': {
        const h = tk.hit
        const color = h.kind === 'role' && h.color ? h.color : th.accent
        return (
          <span
            key={k}
            role="button"
            tabIndex={0}
            data-note={h.noteIndex}
            onClick={(e) => { e.stopPropagation(); ctx.onMentionClick?.(h) }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); ctx.onMentionClick?.(h) } }}
            style={{
              background: th.mentionBg,
              color,
              fontWeight: 500,
              borderRadius: 3,
              padding: '0 2px',
              cursor: h.kind === 'user' ? 'pointer' : 'default',
            }}
          >
            @{h.label}
          </span>
        )
      }
      default:
        return null
    }
  })
}

/** Remove prefixo de lista/citação e devolve nível + texto. */
function listInfo(line: string): { indent: number; marker: string; text: string } | null {
  const m = line.match(/^(\s*)(?:([-*])\s+|(\d+)\.\s+)(.*)$/)
  if (!m) return null
  return {
    indent: Math.floor(m[1].replace(/\t/g, '  ').length / 2),
    marker: m[2] ? '•' : `${m[3]}.`,
    text: m[4],
  }
}


/** Bloco de código: cabeçalho com linguagem e botão copiar (igual Discord). */
function CodeBlock({ lang, code, th }: { lang: string; code: string; th: MarkdownTheme }) {
  const [copied, setCopied] = useState(false)
  return (
    <div
      style={{
        margin: '6px 0', borderRadius: 6, overflow: 'hidden',
        border: `1px solid ${th.border}`, background: '#1e1f22',
      }}
    >
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '3px 8px', background: th.codeHead ?? th.codeBg,
          fontSize: 10.5, color: th.muted, fontFamily: th.mono,
        }}
      >
        <span>{lang || 'texto'}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1400) }
            try {
              const w = navigator.clipboard
              if (w?.writeText) { void w.writeText(code).then(done, () => {}) } else done()
            } catch { /* clipboard bloqueado */ }
          }}
          style={{
            background: 'transparent', border: 'none', color: th.muted,
            cursor: 'pointer', fontSize: 10.5, fontWeight: 700, padding: '2px 4px',
          }}
        >{copied ? 'copiado ✓' : 'copiar'}</button>
      </div>
      <pre
        style={{
          margin: 0, padding: '8px 10px', overflowX: 'auto',
          fontFamily: th.mono, fontSize: 12.5, lineHeight: 1.45, color: th.codeFg,
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  )
}

function renderBlock(
  b: Block,
  ctx: InlineCtx,
  th: MarkdownTheme,
  key: string,
): ReactNode {
  if (b.t === 'code') {
    return <CodeBlock key={key} lang={b.lang} code={b.lines.join('\n')} th={th} />
  }

  // Linha de texto: classifica heading / subtexto / citação / lista.
  const nodes: ReactNode[] = []
  let listRun: Array<{ indent: number; marker: string; text: string }> = []

  const flushList = (listKey: string) => {
    if (!listRun.length) return
    // Aninha por nível de indent: itens com indent maior que o do pai viram
    // filhos, recursivamente. Índices são posicionais (não-usados como chave de
    // identidade) porque indent pode repetir em listas separadas.
    const renderItems = (items: typeof listRun, depth: number): ReactNode => (
      <ul key={`${listKey}.u${depth}`} style={{ margin: '2px 0', paddingLeft: 20, listStyle: 'none' }}>
        {items.map((it, i) => {
          const start = items.indexOf(it)
          const kids: typeof listRun = []
          for (let j = start + 1; j < items.length; j++) {
            if (items[j].indent > it.indent) kids.push(items[j])
            else break
          }
          const myKids = kids.filter((k) => k.indent === it.indent + 1)
          return (
            <li key={`${listKey}.l${depth}.${i}`} style={{ margin: '1px 0' }}>
              <span style={{ marginRight: 7, color: th.muted, fontSize: 12 }}>{it.marker}</span>
              <span>{renderTokens(parseInline(it.text, ctx, 0), ctx, th, `${listKey}.t${depth}.${i}`)}</span>
              {myKids.length > 0 && renderItems(myKids, depth + 1)}
            </li>
          )
        })}
      </ul>
    )
    nodes.push(renderItems(listRun, 0))
    listRun = []
  }

  b.lines.forEach((line, li) => {
    const k = `${key}.l${li}`

    // Linha vazia = respiro de 1 linha (não collapse tudo).
    if (line.trim() === '') {
      flushList(`${k}.lst`)
      nodes.push(<div key={k} style={{ height: 8 }} />)
      return
    }

    // Citação: `> ` ou `>>> `
    const q = line.match(/^(\s*)(>+)\s?(.*)$/)
    if (q) {
      flushList(`${k}.lst`)
      const nested = q[2].length - 1
      nodes.push(
        <div
          key={k}
          style={{
            borderLeft: `4px solid ${th.quoteBar}`,
            paddingLeft: 10,
            margin: '2px 0',
            color: th.muted,
            ...(nested > 0 ? { marginLeft: nested * 12 } : {}),
          }}
        >
          {renderTokens(parseInline(q[3], ctx, 0), ctx, th, k, { inQuote: true })}
        </div>,
      )
      return
    }

    // Heading H1/H2/H3
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      flushList(`${k}.lst`)
      const lvl = h[1].length
      const size = lvl === 1 ? 22 : lvl === 2 ? 17 : 15
      nodes.push(
        <div
          key={k}
          style={{
            fontSize: size,
            fontWeight: 700,
            lineHeight: 1.3,
            color: th.heading,
            margin: `${lvl === 1 ? 8 : 4}px 0 2px`,
          }}
        >
          {renderTokens(parseInline(h[2], ctx, 0), ctx, th, k)}
        </div>,
      )
      return
    }

    // Subtexto: `-# texto`
    const sub = line.match(/^\s*-#\s?(.*)$/)
    if (sub) {
      flushList(`${k}.lst`)
      nodes.push(
        <div key={k} style={{ fontSize: 12, color: th.muted, margin: '2px 0', fontWeight: 400 }}>
          {renderTokens(parseInline(sub[1], ctx, 0), ctx, th, k)}
        </div>,
      )
      return
    }

    // Lista (bulleted / numerada)
    const li2 = listInfo(line)
    if (li2) {
      listRun.push(li2 as unknown as { indent: number; marker: string; text: string })
      return
    }
    flushList(`${k}.lst`)

    nodes.push(
      <div key={k} style={{ margin: '1px 0' }}>
        {renderTokens(parseInline(line, ctx, 0), ctx, th, k)}
      </div>,
    )
  })
  flushList(`${key}.lstEnd`)

  return <div key={key}>{nodes}</div>
}


// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export interface MarkdownProps {
  body: string
  theme?: Partial<MarkdownTheme>
  resolveMention?: (token: string) => MentionHit | null
  resolveEmoji?: (name: string) => string | null
  onMentionClick?: (hit: MentionHit) => void
  revealedSpoilers?: Set<string>
  onRevealSpoiler?: (key: string) => void
  /** Rótulo usado no aria-label quando há spoiler escondido. */
  className?: string
  style?: React.CSSProperties
}

export function Markdown(props: MarkdownProps) {
  const th: MarkdownTheme = { ...DEFAULT_MARKDOWN_THEME, ...(props.theme ?? {}) }
  const ctx: InlineCtx = {
    resolveMention: props.resolveMention ?? (() => null),
    resolveEmoji: props.resolveEmoji ?? (() => null),
    onMentionClick: props.onMentionClick,
    revealedSpoilers: props.revealedSpoilers ?? EMPTY_SET,
    onRevealSpoiler: props.onRevealSpoiler ?? (() => {}),
    spoilerSeq: { n: 0 },
  }
  const blocks = classifyBlocks(props.body)
  return (
    <div
      className={props.className}
      style={{
        fontFamily: th.font,
        fontSize: 14,
        lineHeight: 1.375,
        color: th.text,
        wordBreak: 'break-word',
        overflowWrap: 'anywhere',
        ...(props.style ?? {}),
      }}
    >
      {blocks.map((b, i) => renderBlock(b, ctx, th, `b${i}`))}
    </div>
  )
}

const EMPTY_SET = new Set<string>()

/** Texto puro sem formatação — usado em resumos de notificação/preview. */
export function stripMarkdown(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\|\|([\s\S]*?)\|\|/g, '$1')
    .replace(/\/spoiler\s*/g, '')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)')
    .replace(/[*_~>#|-]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Extração para o composer: menções e formatação
// ---------------------------------------------------------------------------

export interface MentionCandidate {
  kind: 'user' | 'role' | 'everyone' | 'here' | 'channel'
  /** Texto que o composer insere. */
  insert: string
  label: string
  color?: string
  fp?: string
  channelId?: string
}

export interface SlashCommand {
  name: string
  summary: string
  /**(args) => Promise<string> — a resposta vai como mensagem do autor. */
  run: (args: string) => Promise<string>
  /** Escopo: 'chat' (DM/canal), 'server' (só em servidor), 'mod' (só mod). */
  scope?: 'chat' | 'server' | 'mod'
}

/** Emoji CRU que o composer entende: sequência completa (com ZWJ/modificadores). */
const ZWJ_TAIL = '(?:\\uFE0F|\\u200D\\p{Extended_Pictographic}|[\\u{1F3FB}-\\u{1F3FF}])*'

/**
 * Detecta o token de autocompletar sob o cursor.
 * Devolve `{ kind:'mention'|'slash'|'emoji', query, start, end }`.
 */
export function activeToken(
  text: string,
  caret: number,
): { kind: 'mention' | 'slash' | 'emoji'; query: string; start: number; end: number } | null {
  const upto = text.slice(0, caret)
  // @
  const at = upto.lastIndexOf('@')
  if (at >= 0) {
    const after = upto.slice(at + 1)
    if (!/[\s\n]/.test(after) && !after.includes('```') && after.length <= 64) {
      return { kind: 'mention', query: after, start: at, end: caret }
    }
  }
  // / só no início da linha (comando), como no Discord
  const slashLine = upto.split('\n').pop() ?? ''
  if (slashLine.startsWith('/') && !/\s/.test(slashLine)) {
    return { kind: 'slash', query: slashLine.slice(1), start: caret - slashLine.length, end: caret }
  }
  // :emoji:
  const colon = upto.lastIndexOf(':')
  if (colon >= 0) {
    const after = upto.slice(colon + 1)
    if (/^[A-Za-z0-9_]{0,32}$/.test(after)) {
      return { kind: 'emoji', query: after, start: colon, end: caret }
    }
  }
  return null
}

/** Aplica Surrounding/prefixo de formatação, como o Discord faz nos botões. */
export function applyFormat(
  text: string,
  start: number,
  end: number,
  mode: 'bold' | 'italic' | 'under' | 'strike' | 'code' | 'spoiler' | 'quote',
): { text: string; caret: number } {
  const sel = text.slice(start, end)
  const mark: Record<string, string> = {
    bold: '**', italic: '*', under: '__', strike: '~~', code: '`', spoiler: '||', quote: '> ',
  }
  const m = mark[mode]
  if (mode === 'quote') {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1
    return { text: text.slice(0, lineStart) + '> ' + text.slice(lineStart), caret: end + 2 }
  }
  // Se já está envolvido, desembrulha (toggle).
  const before = text.slice(Math.max(0, start - m.length), start)
  const after = text.slice(end, end + m.length)
  if (before === m && after === m) {
    return {
      text: text.slice(0, start - m.length) + sel + text.slice(end + m.length),
      caret: start - m.length,
    }
  }
  const next = text.slice(0, start) + m + sel + m + text.slice(end)
  return { text: next, caret: start + m.length + sel.length + m.length }
}

export const _internals = { classifyBlocks, parseInline, listInfo, ZWJ_TAIL }
