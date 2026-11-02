// A barra "está compartilhando sua tela" do WebView2/Chromium.
//
// Relato com print: DUAS janelas de aviso em cima da UI, uma com a miniatura da
// fonte. Causa raiz (achada pelo outro agente): o critério antigo era o NOME DA
// CLASSE `ScreenCaptureNotificationUIViews` — que é o nome do widget no fonte do
// Chromium, não a classe Win32 (a real é `Chrome_WidgetWin_*`). A barra nunca foi
// escondida em versão nenhuma. O que a identifica é a FORMA (faixa fina e larga),
// ser TOPMOST, não ter legenda e pertencer à árvore de processos do app.

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

test('varre a árvore de processos (a barra nasce no msedgewebview2)', () => {
  assert.match(sharebar, /CreateToolhelp32Snapshot/, 'monta a árvore de PIDs')
  assert.match(sharebar, /pids\.contains\(&pid\)/, 'aceita processo descendente')
  assert.match(sharebar, /EnumChildWindows/, 'cobre janelas filhas/owned')
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
