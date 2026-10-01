// Sanitização de texto — espelho TS de forge-core/src/names.rs.
// Puro, sem dependências, seguro em WebView Android/iOS e desktop.
// O CORE (Rust) re-valida tudo — isto é só feedback instantâneo na UI.

/** Normaliza NFC + remove controles/invisíveis + limita + colapsa espaços. */
export function sanitizeText(input: string, maxChars: number): string {
  let s: string
  try {
    s = input.normalize('NFC')
  } catch {
    s = input
  }
  const invisible = new Set([
    '\u200B', '\u200C', '\u200D', '\uFEFF', '\u00AD',
    '\u202A', '\u202B', '\u202C', '\u202D', '\u202E',
    '\u2066', '\u2067', '\u2068', '\u2069',
  ])
  let out = ''
  let count = 0
  for (const c of s) {
    if (count >= maxChars) break
    const code = c.codePointAt(0) ?? 0
    // controles (exceto \n e \t) e invisíveis caem fora
    if (c !== '\n' && c !== '\t' && (code < 0x20 || (code >= 0x7f && code <= 0x9f))) continue
    if (invisible.has(c)) continue
    out += c
    count++
  }
  // colapsa espaços, no máximo 2 quebras seguidas
  const lines = out.split('\n')
  const cleaned = lines
    .map((l) => l.replace(/[ \t]+/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned
}

/** Escapa para HTML — nomes vindos da rede nunca entram crus no DOM. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/`/g, '&#x60;')
}
