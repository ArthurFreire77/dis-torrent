// A barra "está compartilhando sua tela" do WebView2/Chromium.
//
// Relato com print: a janela de aviso aparece em cima da UI, cobre a barra de
// tarefas e cria uma SEGUNDA entrada na barra de tarefas. Causa raiz (medida em
// Chromium 156, com getDisplayMedia ativo): o critério antigo era o NOME DA
// CLASSE `ScreenCaptureNotificationUIViews` — que é o nome do widget no fonte do
// Chromium, não a classe Win32 (a real é `Chrome_WidgetWin_*`) — e o filtro era
// pelo PID do app, embora a janela nasça no `msedgewebview2.exe`. Resultado: a
// barra nunca foi escondida em versão nenhuma. O que a identifica é a FORMA
// (faixa 472x70), ser TOPMOST, não ter legenda e pertencer à árvore de processos
// do app.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sharebar = readFileSync('src-tauri/src/sharebar.rs', 'utf8')
const manager = readFileSync('src/services/callManager.ts', 'utf8')
const runtime = readFileSync('src/shared/runtime.ts', 'utf8')

test('identifica a janela por forma/estilo, não pelo nome do widget', () => {
  assert.match(sharebar, /CLASS_PREFIX: &str = "Chrome_WidgetWin_"/)
  assert.match(sharebar, /fn e_barra\(/, 'predicado puro (testável sem Win32)')
  assert.match(sharebar, /WS_EX_TOPMOST/, 'a barra é TOPMOST')
  assert.match(sharebar, /WS_CAPTION/, 'e não tem legenda')
  assert.match(sharebar, /BAR_MIN_ASPECT/, 'faixa fina e larga')
  // A string do widget não pode voltar a ser o critério.
  assert.doesNotMatch(sharebar, /!= BAR_CLASS/)
})

test('acha a barra no processo do WebView2 sem dependência extra', () => {
  // A barra nasce no `msedgewebview2.exe`, não no PID do app. O nome do
  // executável vem de `QueryFullProcessImageNameW`, que já está em
  // `Win32_System_Threading` — a feature que o app já usava.
  assert.match(sharebar, /QueryFullProcessImageNameW/)
  assert.match(sharebar, /EXE_CHROMIUM/)
  assert.match(sharebar, /fn e_nosso/)
  // Nada de varrer a tabela de processos 4x por segundo (`ToolHelp` exigiria
  // uma feature nova no Cargo.toml).
  assert.doesNotMatch(sharebar, /CreateToolhelp32Snapshot/, 'sem feature ToolHelp')
  assert.doesNotMatch(sharebar, /EnumChildWindows/, 'varredura de filhas é código morto')
})

test('o Cargo.toml não ganhou nenhuma dependência nem feature', () => {
  // A correção só pode usar o que o app já compilava. `ToolHelp`, `Gdi` e
  // `LibraryLoader` já foram adicionados por engano e saíram.
  const toml = readFileSync('src-tauri/Cargo.toml', 'utf8')
  const linha = toml.match(/^windows-sys = .*$/m)?.[0] ?? ''
  assert.match(linha, /"Win32_Foundation"/)
  assert.match(linha, /"Win32_UI_WindowsAndMessaging"/)
  assert.match(linha, /"Win32_System_Threading"/)
  for (const extra of ['ToolHelp', 'Graphics_Gdi', 'LibraryLoader', 'dev-dependencies']) {
    assert.ok(!toml.includes(extra), `não pode existir ${extra} no Cargo.toml`)
  }
})

test('vigia continuamente enquanto o share durar', () => {
  assert.match(sharebar, /pub fn watch_share_bar/)
  assert.match(sharebar, /pub fn unwatch_share_bar/)
  assert.match(sharebar, /static ATIVO: AtomicBool/)
})

test('o app liga o vigia no início e desliga no fim do share', () => {
  assert.match(manager, /services\.shareBarWatch\?\.\(true\)/)
  assert.match(manager, /services\.shareBarWatch\?\.\(false\)/)
  assert.match(runtime, /export function isWindowsRuntime/)
  assert.match(manager, /if \(!isWindowsRuntime\(\)\) return/)
})

test('nenhum comando registrado duas vezes no generate_handler', () => {
  // Um comando repetido no `generate_handler!` registra o mesmo nome duas
  // vezes; `hide_share_bar` já esteve duplicado e passou despercebido.
  const lib = readFileSync('src-tauri/src/lib.rs', 'utf8')
  const bloco = lib.slice(lib.indexOf('generate_handler!['))
  const nomes = [...bloco.matchAll(/^\s{8,}([a-z_][a-zA-Z0-9_:]*),\s*$/gm)].map((m) => m[1])
  const repetidos = nomes.filter((n, i) => nomes.indexOf(n) !== i)
  assert.deepEqual(repetidos, [], `comandos duplicados: ${repetidos.join(', ')}`)
})
