import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const conf = readFileSync('src-tauri/tauri.conf.json', 'utf8')
const lib = readFileSync('src-tauri/src/lib.rs', 'utf8')
const bg = readFileSync('src-tauri/src/background.rs', 'utf8')
const main = readFileSync('src/main.tsx', 'utf8')

test('a janela nasce invisível para não piscar no boot', () => {
  assert.match(conf, /"visible":\s*false/, 'sem visible:false a janela aparece e recolhe')
})

test('o comando que mostra a janela existe, está registrado e tem rede de segurança', () => {
  assert.match(bg, /pub fn app_ui_ready/, 'o backend precisa saber quando a UI montou')
  assert.match(lib, /app_ui_ready,/, 'comando fora do generate_handler falha em silêncio')
  const i = bg.indexOf('pub fn app_ui_ready')
  const corpo = bg.slice(i, i + 1800)
  assert.match(corpo, /tray_available/, 'sem bandeja não pode ficar escondido')
  assert.match(corpo, /w\.show\(\)/, 'precisa mostrar no caminho normal')
})

test('o frontend avisa DEPOIS do primeiro frame e tenta de novo se falhar', () => {
  assert.match(main, /app_ui_ready/, 'o invoke do aviso tem de existir')
  assert.match(main, /requestAnimationFrame/, 'avisar antes do primeiro pixel pinta fundo vazio')
  assert.match(main, /tentativas < 5/, 'um único aviso perdido deixaria o app invisível')
})

test('a preferência "iniciar minimizado" vale em qualquer abertura', () => {
  // Antes só `--minimized` (autostart) escondia: abrir pelo atalho com a opção
  // ligada mostrava a janela. A regra agora é só a preferência + bandeja.
  const i = bg.indexOf('let quer_minimizado')
  const corpo = bg.slice(i, i + 900)
  assert.match(corpo, /start_minimized/, 'a decisão vem da preferência salva')
  assert.match(corpo, /deve_minimizar = quer_minimizado && tem_bandeja/, 'sem bandeja não pode ficar invisível')
  assert.doesNotMatch(corpo, /pediu_minimizado/, 'não pode voltar a exigir a flag do autostart')

  const j = bg.indexOf('pub fn app_ui_ready')
  const uiReady = bg.slice(j, j + 1800)
  assert.doesNotMatch(uiReady, /--minimized/, 'app_ui_ready não depende mais da flag')
  assert.match(uiReady, /pediu_bandeja/, 'a rede de segurança respeita a preferência')
})

test('o autostart continua passando --minimized', () => {
  assert.match(lib, /"--minimized"/, 'o plugin do autostart mantém o argumento histórico')
})
