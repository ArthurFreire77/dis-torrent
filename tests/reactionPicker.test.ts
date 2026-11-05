import test from 'node:test'
import assert from 'node:assert/strict'

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
