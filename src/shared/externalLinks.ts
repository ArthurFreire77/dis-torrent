// Links externos: o que é "de fora" do app e como abrir sem criar aba interna.
//
// POR QUE EXISTE: dentro do WebView (Windows/Android) um `<a target="_blank">`
// NÃO abre o navegador — o engine cria uma janela interna apontando para o
// endereço. Com `http://tauri.localhost` (o esquema interno do Tauri) ou com um
// esquema custom (`distorrent://`) essa janela nasce morta, com
// `ECONNREFUSED: Unable to connect`, e o usuário fica com uma "aba" preta por
// cima do app. Quem abre endereço de fora é o SISTEMA OPERACIONAL.
//
// Módulo puro (sem DOM/Tauri) para rodar em node:test; quem instala o
// interceptador é o `installExternalLinkHandler`.

/** Esquemas que o SO sabe abrir (o mesmo allowlist do `open_external` no Rust). */
const EXTERNAL_SCHEMES = ['http:', 'https:', 'mailto:', 'distorrent:']

/**
 * Endereço é de FORA do app? (deve ser entregue ao SO, não a uma janela interna)
 *
 * Regras:
 * - esquema fora do allowlist (`file:`, `javascript:`, `data:`) → `false`: não é
 *   para abrir em lugar nenhum, é conteúdo que não deve sair do app;
 * - mesmo host/porta da página → `false`: navegação interna (router);
 * - resto → `true`.
 */
export function isExternalUrl(href: string, appOrigin: string): boolean {
  const raw = (href ?? '').trim()
  if (!raw) return false
  if (raw.startsWith('#') || raw.startsWith('/') || raw.startsWith('?')) return false
  let url: URL
  try {
    // Base só para caminhos relativos que escaparam dos testes acima.
    url = new URL(raw, appOrigin || 'http://localhost')
  } catch {
    return false
  }
  // `javascript:`/`data:`/`file:` e afins não são "externos": são proibidos.
  if (!EXTERNAL_SCHEMES.includes(url.protocol)) return false
  // `distorrent://` nunca é interno, mesmo que o host coincida.
  if (url.protocol === 'distorrent:') return true
  let origem = ''
  try {
    origem = new URL(appOrigin).origin
  } catch {
    return true
  }
  return url.origin !== origem
}

/**
 * Esquema próprio do app (`distorrent://`): NÃO é endereço de navegador. Dentro
 * do WebView ele abria uma janela interna e morria em `ECONNREFUSED`.
 */
export function isDeepLinkUrl(href: string): boolean {
  try {
    const p = new URL((href ?? '').trim()).protocol
    return p !== 'http:' && p !== 'https:'
  } catch {
    return false
  }
}

/**
 * Endereço é aceitável para entrega ao SO? (defesa em profundidade: o Rust
 * repete esta allowlist, e o frontend não promete abrir o que o backend recusa)
 */
export function canOpenExternally(href: string): boolean {
  try {
    return EXTERNAL_SCHEMES.includes(new URL((href ?? '').trim()).protocol)
  } catch {
    return false
  }
}
