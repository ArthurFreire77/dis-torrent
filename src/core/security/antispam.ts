// Anti-spam client-side — pré-checagem leve antes de enviar.
// O CORE re-decide tudo no receptor; isto só dá feedback imediato
// ("segure um pouco", "link suspeito") sem esperar a rede.
// Puro TS, sem deps — roda em desktop, Android e iOS.

export type SpamLevel = 'low' | 'medium' | 'high'
export type Trust = 'new' | 'trusted' | 'suspicious' | 'banned'

const SHORTENERS = [
  'bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
  'adf.ly', 'shorte.st', 'cutt.ly', 'rebrand.ly', 'shorturl.at',
]

const MALICIOUS = [
  'grabify.link', 'iplogger.org', 'iplogger.ru', 'blasze.tk', 'shorte.st',
  'adf.ly', 'discord-nitro-free', 'steamcommunlty', 'steancommunuty',
  'metamask-seed', 'wallet-drain',
]

export function extractDomains(text: string): string[] {
  const out: string[] = []
  for (let tok of text.toLowerCase().split(/\s+/)) {
    tok = tok.replace(/^[.,;:!?()[\]<>"']+|[.,;:!?()[\]<>"']+$/g, '')
    let host = ''
    if (tok.startsWith('http://') || tok.startsWith('https://')) {
      host = tok.split('/')[2]?.split(':')[0] ?? ''
    } else if (tok.includes('.') && tok.length < 256) {
      const h = tok.split('/')[0].split(':')[0]
      const tld = h.split('.').pop() ?? ''
      if (h.includes('.') && tld.length >= 2 && /^[a-z]+$/.test(tld)) host = h
    }
    if (host) out.push(host)
  }
  return out
}

export type LinkCheck = { kind: 'clean' } | { kind: 'shortener'; domain: string } | { kind: 'malicious'; domain: string }

export function checkLinksLocal(body: string, extraBlocked: string[] = []): LinkCheck {
  const domains = extractDomains(body)
  const mal = [...MALICIOUS, ...extraBlocked.map((d) => d.toLowerCase())]
  for (const d of domains) {
    if (mal.some((m) => d === m || d.endsWith(`.${m}`))) return { kind: 'malicious', domain: d }
  }
  for (const d of domains) {
    if (SHORTENERS.some((m) => d === m || d.endsWith(`.${m}`))) return { kind: 'shortener', domain: d }
  }
  return { kind: 'clean' }
}

/** Aviso pré-envio: retorna mensagem para a UI ou null se ok. */
export function warnBeforeSend(body: string, level: SpamLevel, extraBlocked: string[] = []): string | null {
  const link = checkLinksLocal(body, extraBlocked)
  if (link.kind === 'malicious') return `link bloqueado: ${link.domain}`
  if (link.kind === 'shortener' && level === 'high') return 'encurtadores bloqueados neste servidor'
  if (link.kind === 'shortener') return `atenção: encurtador (${link.domain}) — confira antes de enviar`
  return null
}

// ---------- rate limit local (UX; o core impõe o real) ----------

export class LocalRateGate {
  private tokens: number
  private last: number
  constructor(
    private per10s = 10,
    private burst = 5,
  ) {
    this.tokens = burst
    this.last = Date.now()
  }
  /** Retorna ms de espera se deve segurar, 0 se pode enviar. */
  check(): number {
    const now = Date.now()
    const dt = (now - this.last) / 1000
    this.tokens = Math.min(this.burst, this.tokens + dt * (this.per10s / 10))
    this.last = now
    if (this.tokens >= 1) {
      this.tokens -= 1
      return 0
    }
    return 2000
  }
}

// ---------- proof-of-work (captcha leve p/ novatos) ----------

function lzb(hexHash: string, bits: number): boolean {
  // conta bits zero à esquerda do hash hex
  let n = 0
  for (const ch of hexHash) {
    const v = parseInt(ch, 16)
    if (Number.isNaN(v)) return false
    if (v === 0) { n += 4; continue }
    n += Math.clz32(v) - 28
    break
  }
  return n >= bits
}

async function blakeHex(data: Uint8Array): Promise<string> {
  // WebCrypto não tem BLAKE3 — usa SHA-256 no cliente SÓ para o PoW
  // anti-burro (o PoW real é verificado no core com BLAKE3; o cliente
  // resolve o desafio real via solvePowChallenge com o hash do core quando
  // online; aqui é fallback honesto para modo local).
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** Resolve PoW leve (bits<=12) — usado no modo browser/local. */
export async function solvePowLocal(challengeHex: string, bits: number, maxIters = 200_000): Promise<number | null> {
  const chal = challengeHex.toLowerCase()
  const enc = new TextEncoder()
  for (let n = 0; n < maxIters; n++) {
    const buf = new Uint8Array(enc.encode(`storm/antispam/pow|${chal}|${n}`))
    const h = await blakeHex(buf)
    if (lzb(h, bits)) return n
  }
  return null
}

// ---------- rótulos de reputação p/ UI ----------

export const TRUST_LABEL: Record<Trust, string> = {
  new: 'novo',
  trusted: 'confiável',
  suspicious: 'suspeito',
  banned: 'banido',
}

export const TRUST_COLOR: Record<Trust, string> = {
  new: '#949ba4',
  trusted: '#57f287',
  suspicious: '#fee75c',
  banned: '#ed4245',
}
