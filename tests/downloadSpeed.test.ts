import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SPEED_PRESETS,
  batchDelayMs,
  inFlightForLimit,
  labelForLimit,
} from '../src/services/downloadSpeed.ts'

test('sem teto: janela máxima, nenhuma pausa artificial', () => {
  assert.equal(inFlightForLimit(0), 64)
  assert.equal(batchDelayMs(0, 16), 0)
  assert.match(labelForLimit(0), /sem teto/)
})

test('teto de 5 MB/s não deixa 64 blocos em voo', () => {
  const janela = inFlightForLimit(5)
  assert.ok(janela >= 4, 'piso de 4 para não virar 1 bloco por vez')
  assert.ok(janela < 64, 'com teto a janela precisa ser menor')
})

test('teto maior abre mais janela, mas nunca acima de 64', () => {
  assert.ok(inFlightForLimit(10) >= inFlightForLimit(5))
  assert.ok(inFlightForLimit(100) <= 64)
  for (const mbps of SPEED_PRESETS) {
    const n = inFlightForLimit(mbps)
    assert.ok(Number.isInteger(n) && n >= 4 && n <= 64, `janela inválida para ${mbps}`)
  }
})

test('pausa entre lotes respeita o teto e tem teto de 500 ms', () => {
  // 16 blocos = 4 MB. A 5 MB/s isso leva ~800 ms, mas o teto de espera é 500.
  assert.ok(batchDelayMs(5, 16) <= 500)
  assert.ok(batchDelayMs(5, 4) > 0)
  assert.equal(batchDelayMs(5, 0), 0)
  assert.equal(batchDelayMs(0, 16), 0)
})

test('rótulo é legível', () => {
  assert.equal(labelForLimit(20), '20 MB/s')
  assert.match(labelForLimit(0), /rede inteira/)
})
