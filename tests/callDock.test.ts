import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FIXED_CHROME_PX,
  MAIN_MIN_WIDTH_PX,
  PANEL_MIN_WIDTH_PX,
  callPanelWidth,
  resolveCallDock,
} from '../src/services/voiceLayout.ts'

const CHROME_SEM_MEMBROS = FIXED_CHROME_PX
// Servidor aberto = rail (72) + lista de canais (260) + lista de membros (240).
const CHROME_COM_MEMBROS = 572

test('sem chamada ativa não reserva espaço nenhum', () => {
  const d = resolveCallDock({ hasActiveCall: false, inThisCall: false, panelSize: 'normal', widthPx: 1280 })
  assert.equal(d.panelVisible, false)
  assert.equal(d.mainInsetPx, 0)
})

test('quem já está na chamada vê o palco, não o painel', () => {
  const d = resolveCallDock({ hasActiveCall: true, inThisCall: true, panelSize: 'normal', widthPx: 1280 })
  assert.equal(d.panelVisible, false)
  assert.equal(d.mainInsetPx, 0)
})

test('o composer nunca fica com uma letra por linha', () => {
  // O bug relatado: 546px viravam 85px, e em 1100px viravam 0.
  const d = resolveCallDock({
    hasActiveCall: true,
    inThisCall: false,
    panelSize: 'normal',
    chromePx: CHROME_SEM_MEMBROS,
    widthPx: 1280,
  })
  const coluna = 1280 - CHROME_SEM_MEMBROS - d.mainInsetPx
  assert.ok(coluna >= MAIN_MIN_WIDTH_PX, `coluna de ${coluna}px`)
  assert.ok(d.mainInsetPx >= PANEL_MIN_WIDTH_PX, 'o painel precisa de largura útil')
})

test('com o servidor aberto (lista de membros) o painel sobrepõe em vez de esmagar', () => {
  // Em 1440px com chrome de 572px sobram 868px; o painel expandido queria 720.
  const d = resolveCallDock({
    hasActiveCall: true,
    inThisCall: false,
    panelSize: 'expanded',
    chromePx: CHROME_COM_MEMBROS,
    widthPx: 1440,
  })
  assert.equal(d.panelVisible, true)
  const coluna = 1440 - CHROME_COM_MEMBROS - d.mainInsetPx
  if (d.sideBySide) {
    assert.ok(coluna >= MAIN_MIN_WIDTH_PX, `coluna de ${coluna}px`)
  } else {
    assert.equal(d.mainInsetPx, 0)
  }
})

test('a coluna nunca fica abaixo do mínimo, em nenhuma combinação', () => {
  for (const chrome of [CHROME_SEM_MEMBROS, CHROME_COM_MEMBROS, 200, 0]) {
    for (let w = 640; w <= 2560; w += 40) {
      for (const size of ['compact', 'normal', 'expanded']) {
        const d = resolveCallDock({
          hasActiveCall: true,
          inThisCall: false,
          panelSize: size,
          chromePx: chrome,
          widthPx: w,
        })
        if (d.sideBySide) {
          const coluna = w - (chrome || FIXED_CHROME_PX) - d.mainInsetPx
          assert.ok(coluna >= MAIN_MIN_WIDTH_PX, `${w}px/${size}/chrome ${chrome}: coluna de ${coluna}px`)
        } else {
          assert.equal(d.mainInsetPx, 0, 'sobrepor não reserva margem')
        }
      }
    }
  }
})

test('painel expandido nunca passa de metade da janela', () => {
  assert.ok(callPanelWidth('expanded', 1280) <= 1280 * 0.56)
  assert.equal(callPanelWidth('compact', 900), 300)
  assert.ok(callPanelWidth('normal', 900) >= 320)
})

test('largura desconhecida não quebra o cálculo', () => {
  const d = resolveCallDock({ hasActiveCall: true, inThisCall: false, panelSize: 'normal', widthPx: NaN })
  assert.equal(d.panelVisible, true)
  assert.ok(d.mainInsetPx >= 0)
})
