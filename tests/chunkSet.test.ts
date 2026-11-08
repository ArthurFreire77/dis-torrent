import test from 'node:test'
import assert from 'node:assert/strict'
import { ChunkSet } from '../src/services/chunkSet.ts'

test('ChunkSet: 2 milhões de blocos custam ~2 MB e contam certo', () => {
  const s = new ChunkSet(2_000_000)
  assert.equal(s.size, 0)
  assert.equal(s.has(0), false)
  s.add(0)
  s.add(1_999_999)
  s.add(1_999_999)
  assert.equal(s.size, 2)
  assert.equal(s.has(1_999_999), true)
  assert.equal(s.has(2_000_000), false, 'fora da faixa nunca entra')
  assert.equal(s.has(-1), false)
})

test('ChunkSet.full marca tudo e não vaza bit acima do total', () => {
  const s = ChunkSet.full(10)
  assert.equal(s.size, 10)
  for (let i = 0; i < 10; i++) assert.equal(s.has(i), true)
  assert.equal(s.has(10), false)
  const incompleto = new ChunkSet(10)
  assert.equal((incompleto as unknown as { bits: Uint8Array }).bits[1], 0, 'bits acima do total ficam zerados')
})

test('ChunkSet.missing percorre só o que falta e firstMissing acha o primeiro', () => {
  const s = ChunkSet.from(1000, [0, 1, 2, 500, 998, 999])
  assert.equal(s.firstMissing(), 3)
  const faltando = [...s.missing()]
  assert.equal(faltando.length, 994)
  assert.deepEqual(faltando.slice(0, 2), [3, 4])
  assert.equal(faltando.includes(500), false)
})

test('ChunkSet.delete/clear mantêm a contagem', () => {
  const s = ChunkSet.full(5)
  s.delete(2)
  s.delete(2)
  assert.equal(s.size, 4)
  assert.equal(s.has(2), false)
  s.clear()
  assert.equal(s.size, 0)
  assert.equal(s.firstMissing(), 0)
})

test('ChunkSet completo devolve -1 (nada a pedir)', () => {
  const s = ChunkSet.full(3)
  assert.equal(s.firstMissing(), -1)
  assert.deepEqual([...s.missing()], [])
})
