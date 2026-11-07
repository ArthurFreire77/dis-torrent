import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const ler = (p: string) => readFileSync(p, 'utf8')
const conf = JSON.parse(ler('src-tauri/tauri.conf.json'))
const lib = [
  ler('src-tauri/src/lib.rs'),
  ...readdirSync('src-tauri/src')
    .filter((f) => f.startsWith('commands_') && f.endsWith('.rs'))
    .map((f) => ler(`src-tauri/src/${f}`)),
].join('\n')
const app = ler('src/App.tsx')
const tela = ler('src/routes/BotsApp.tsx')
const modelos = ler('src/services/models.ts')
const tauri = ler('src/services/tauri.ts')

const janelas: any[] = conf.app.windows
const principal = janelas.find((w) => (w.label ?? 'main') === 'main')
const bots = janelas.find((w) => w.label === 'bots')

test('a janela principal continua intacta e a de bots é a segunda', () => {
  assert.equal(janelas.length, 2, 'só pode haver main + bots')
  assert.ok(principal, 'a janela main precisa continuar lá')
  assert.equal(principal.visible, false, 'main nasce escondida (app_ui_ready mostra)')
  assert.equal(principal.width, 1280)
  assert.equal(principal.height, 800)
  assert.ok(bots, 'a janela "bots" precisa existir no tauri.conf.json')
})

test('a janela de bots é sob demanda, escondida e carrega a marca ?bots=1', () => {
  assert.equal(bots.create, false, 'create:false evita um webview extra no boot')
  assert.equal(bots.visible, false, 'mostrar depois de construir evita flash branco')
  assert.match(String(bots.url), /index\.html\?bots=1/, 'a URL é o contrato com App.tsx')
  assert.ok(Number(bots.minWidth) >= 600, 'a tela de bots precisa de largura útil')
})

test('open_bots_window existe, foca a janela aberta e é só desktop', () => {
  const i = lib.indexOf('fn open_bots_window')
  assert.ok(i > 0, 'o comando precisa existir')
  const antes = lib.slice(Math.max(0, i - 200), i)
  assert.match(antes, /#\[cfg\(desktop\)\]/, 'sem o gate o build Android quebra')
  const corpo = lib.slice(i, i + 1400)
  assert.match(corpo, /get_webview_window\("bots"\)/, 'sem isso cada clique cria outra janela')
  assert.match(corpo, /set_focus\(\)/, 'janela existente precisa vir para a frente')
  assert.match(corpo, /WebviewWindowBuilder::from_config/, 'usa a config declarada, não uma URL hardcoded')
})

test('o caminho mobile devolve erro honesto em vez de fingir que abriu', () => {
  const i = lib.indexOf('#[cfg(not(desktop))]')
  assert.ok(i > 0, 'precisa haver o ramo não-desktop')
  const corpo = lib.slice(i, i + 500)
  assert.match(corpo, /fn open_bots_window/)
  assert.match(corpo, /Err\(/, 'Ok aqui prometeria uma janela que não existe no celular')
  assert.match(corpo, /janela separada/, 'a mensagem precisa dizer por quê')
})

test('o comando está registrado no generate_handler', () => {
  assert.match(lib, /open_bots_window,/, 'comando fora do generate_handler falha em silêncio')
})

test('/bots existe no App.tsx com lazy e o mesmo ShellFallback', () => {
  assert.match(app, /lazy\(\(\) => import\('\.\/routes\/BotsApp'\)\)/, 'a tela precisa baixar sob demanda')
  assert.match(app, /path="\/bots"/, 'a rota precisa existir')
  const trecho = app.slice(app.indexOf('path="/bots"'), app.indexOf('path="/bots"') + 400)
  assert.match(trecho, /ShellFallback/, 'suspense sem fallback pisca tela branca')
  assert.match(trecho, /BotsApp/, 'a rota precisa renderizar a tela')
})

test('a janela de bots lê ?bots=1 e não duplica presença/notificações', () => {
  assert.match(app, /get\('bots'\) === '1'/, 'o sinal precisa bater com a URL do Rust')
  assert.match(app, /if \(MODO_JANELA_BOTS\) return/, 'a segunda webview não pode iniciar o app inteiro')
  assert.match(app, /MODO_JANELA_BOTS \? undefined : installExternalLinkHandler\(\)/)
})

test('o serviço expõe openBotsWindow e chama o comando certo', () => {
  assert.match(modelos, /openBotsWindow\?\(\): Promise<void>/, 'opcional: no navegador não existe')
  assert.match(tauri, /invoke<void>\('open_bots_window'\)/, 'nome do invoke tem de bater com o Rust')
})

test('a tela é honesta: filtra servidores do dono e não usa window.open', () => {
  assert.match(tela, /services\.identityGet\(\)/)
  assert.match(tela, /c\.owner_fp === id\.fingerprint/, 'só o dono opera bots')
  assert.match(tela, /services\.botsList/)
  assert.match(tela, /botBridgeStart === 'function'/, 'sem ponte a tela avisa em vez de oferecer o botão')
  assert.match(tela, /isAndroidRuntime\(\)/, 'o Android precisa de mensagem própria')
  assert.doesNotMatch(tela, /window\.open/, 'nada de aba de navegador/segunda webview pela UI')
  assert.doesNotMatch(tela, /<style/, 'o CSP do Tauri anula <style>; use style= e DynamicStyles')
  assert.match(tela, /DynamicStyles/, 'hover/focus precisam do adoptedStyleSheets')
})
