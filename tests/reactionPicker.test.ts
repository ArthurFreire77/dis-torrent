// Regressão do botão "reagir" do desktop.
//
// O bug: `MessageList` registrava `document.addEventListener('click', close)`
// sem olhar o alvo. O clique que ABRIA o seletor era o mesmo que o fechava —
// React aplicava `setPicker(m.id)` e, na sequência da mesma batida, o listener
// nativo zerava. Resultado: o botão parecia morto, enquanto o botão da barra de
// hover funcionava (aquele fazia `stopPropagation`).
//
// A regra extraída aqui é a que decide "este clique fecha o popover?".

import test from 'node:test'
import assert from 'node:assert/strict'

/** Espelho da condição usada em MessageList.close. */
function shouldClosePopover(target: { closest?: (sel: string) => unknown } | null): boolean {
  if (target && typeof target.closest === 'function' && target.closest('[data-popover]')) return false
  return true
}

function fakeTarget(insidePopover: boolean) {
  return {
    closest: (sel: string) => (insidePopover && sel === '[data-popover]' ? {} : null),
  }
}

test('clique DENTRO do popover não fecha (senão o botão que abre também fecha)', () => {
  assert.equal(shouldClosePopover(fakeTarget(true)), false)
})

test('clique FORA do popover fecha', () => {
  assert.equal(shouldClosePopover(fakeTarget(false)), true)
})

test('alvo sem closest (texto, documento) não quebra o handler', () => {
  assert.equal(shouldClosePopover(null), true)
  assert.equal(shouldClosePopover({}), true)
})
