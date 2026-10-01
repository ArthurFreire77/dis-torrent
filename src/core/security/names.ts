// Validação de nomes (usuário/servidor/canal) — espelho TS do CORE.
// Feedback em tempo real na UI; o Rust re-valida antes de persistir.

import { sanitizeText } from './sanitize'

export type NameKind = 'user' | 'server' | 'channel'

export interface NameCheck {
  ok: boolean
  normalized: string
  errors: string[]
  suggestions: string[]
}

const POLICY: Record<NameKind, { min: number; max: number }> = {
  user: { min: 2, max: 32 },
  server: { min: 3, max: 64 },
  channel: { min: 2, max: 40 },
}

const BLOCKED = [
  'porra', 'caralho', 'merda', 'puta', 'puto', 'viado', 'bicha', 'corno',
  'fdp', 'filhodaputa', 'otario', 'idiota', 'imbecil', 'retardado',
  'nazista', 'hitler', 'cuzao', 'buceta',
  'fuck', 'shit', 'bitch', 'whore', 'slut', 'nigger', 'nigga', 'faggot',
  'retard', 'kike', 'pedo', 'rapist',
  'free-nitro', 'steam-gift', 'airdrop-claim',
]

const RESERVED = [
  'admin', 'administrador', 'moderador', 'moderator', 'mod',
  'storm oficial', 'stormoficial', 'storm team', 'suporte', 'support',
  'dono', 'owner', 'sistema', 'system', 'bot oficial',
]

const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a',
  '5': 's', '$': 's', '7': 't', '8': 'b', '9': 'g', '€': 'e', '£': 'l',
}

/** Skeleton anti-homoglifo: minúsculas, sem diacríticos, leet resolvido. */
export function skeleton(name: string): string {
  let s: string
  try {
    s = name.normalize('NFC').toLowerCase()
  } catch {
    s = name.toLowerCase()
  }
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
  let out = ''
  for (const c of s) {
    if (LEET[c] !== undefined) {
      out += LEET[c]
      continue
    }
    // cirílico/grego visualmente idênticos ao latim
    const hom: Record<string, string> = {
      а: 'a', е: 'e', і: 'i', о: 'o', с: 'c', м: 'm', т: 't', х: 'x',
      ѕ: 's', ρ: 'p', κ: 'k', η: 'n', ο: 'o',
    }
    if (hom[c] !== undefined) {
      out += hom[c]
      continue
    }
    if (c === 'ß') { out += 'ss'; continue }
    if (c === 'æ') { out += 'ae'; continue }
    if (c === 'œ') { out += 'oe'; continue }
    if (/[\s_\-.]/.test(c)) continue
    if (/[a-z0-9]/.test(c)) { out += c; continue }
    // resto (emoji, CJK, símbolos) cai fora do skeleton
  }
  return out
}

function editDistance1(a: string, b: string): boolean {
  if (a === b) return false
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++ }
    else {
      edits++
      if (edits > 1) return false
      if (a.length === b.length) { i++; j++ }
      else if (a.length > b.length) i++
      else j++
    }
  }
  return edits + (a.length - i + (b.length - j)) === 1
}

export function suggestVariants(base: string, existing: string[]): string[] {
  const clean = skeleton(base).replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user'
  const taken = new Set(existing.map(skeleton))
  const out: string[] = []
  for (const cand of [`${clean}_01`, `${clean}_2025`, `${clean}_x`]) {
    if (!taken.has(skeleton(cand))) out.push(cand)
    if (out.length === 3) break
  }
  let n = 2
  while (out.length < 3 && n < 100) {
    const cand = `${clean}_${String(n).padStart(2, '0')}`
    if (!taken.has(skeleton(cand))) out.push(cand)
    n++
  }
  return out
}

const ADJ = ['veloz', 'bravo', 'lunar', 'solar', 'feroz', 'calmo', 'vivo', 'norte']
const NOUN = ['lobo', 'falcao', 'rio', 'monte', 'farol', 'vento', 'cacto', 'atlas']

export function randomNameLocal(): string {
  const b = new Uint8Array(2)
  try {
    crypto.getRandomValues(b)
  } catch {
    b[0] = Math.floor(Math.random() * 256)
    b[1] = Math.floor(Math.random() * 256)
  }
  const num = 10 + ((b[0] + b[1] * 7) % 89)
  return `${ADJ[b[0] % ADJ.length]}_${NOUN[b[1] % NOUN.length]}_${num}`
}

export function validateNameLocal(
  kind: NameKind,
  raw: string,
  existing: string[] = [],
  extraBanned: string[] = [],
): NameCheck {
  const { min, max } = POLICY[kind]
  const errors: string[] = []
  const collapsed = sanitizeText(raw, max + 16).split(/\s+/).join(' ')
  const normalized = collapsed.trim()
  const len = [...normalized].length
  if (!normalized) errors.push('nome vazio')
  if (len < min) errors.push(`muito curto (mínimo ${min} caracteres)`)
  if (len > max) errors.push(`muito longo (máximo ${max} caracteres)`)
  if (/[<>"'\\`]/.test(raw) || /[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069\u00AD]/.test(raw)) {
    errors.push('contém caracteres proibidos (< > " \' \\ `, invisíveis)')
  }
  if (!/^[a-zA-Z0-9 _\-.à-ÿÀ-ß]*$/.test(normalized)) {
    errors.push('use apenas letras, números, espaço, _ - .')
  }
  if (kind === 'channel' && (/[A-Z]/.test(normalized) || /\s/.test(normalized))) {
    errors.push('canal: use minúsculas e hífen (ex.: avisos-gerais)')
  }
  const skel = skeleton(normalized)
  const banned = [...BLOCKED, ...extraBanned.map((w) => w.toLowerCase())]
  const hit = banned.find((w) => w && skel.includes(skeleton(w)))
  if (hit) errors.push(`contém termo bloqueado: ${hit}`)
  if (RESERVED.some((t) => skel.includes(skeleton(t)))) {
    errors.push('nome imita cargo oficial (admin/moderador/storm)')
  }
  const existingSkel = existing.map(skeleton)
  if (existingSkel.includes(skel)) errors.push('nome já existe neste escopo')
  else if (existingSkel.some((e) => editDistance1(skel, e))) {
    errors.push('muito parecido com um nome existente (anti-spoof)')
  }
  const ok = errors.length === 0
  return { ok, normalized, errors, suggestions: ok ? [] : suggestVariants(normalized, existing) }
}
