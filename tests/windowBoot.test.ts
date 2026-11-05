// A janela nasce escondida (para não "piscar" no boot do autostart) e só o
// `app_ui_ready` a mostra. Se alguém tirar um dos dois lados, o app abre
// invisível — o pior desfecho. Este teste trava o contrato.
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
  // Se veio do login E a pessoa pediu bandeja, fica escondido; qualquer outro
  // caso mostra — nunca deixa a janela fantasma.
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

test('o autostart continua passando --minimized', () => {
  assert.match(lib, /"--minimized"/, 'é o sinal que distingue login de abertura manual')
})
