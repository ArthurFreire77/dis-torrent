// Agendamento dos frames do bot na track da call.
//
// POR QUE este teste existe: os frames eram todos tocados em `currentTime`, um
// por cima do outro. O áudio de 360 ms virava um estalo de 20 ms a cada ciclo —
// o relato de "está cortando o áudio". A regra é: cada frame começa onde o
// anterior terminou.
import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * Mesma aritmética de `tocarLote`: cursor em segundos, avança pela duração,
 * e volta para `agora` quando atrasou (não acumula atraso infinito).
 */
function agendar(duracoes: number[], agora: number, cursor: number): { inicios: number[]; fim: number } {
  let t = cursor < agora ? agora : cursor
  const inicios: number[] = []
  for (const d of duracoes) {
    inicios.push(Number(t.toFixed(6)))
    t += d
  }
  return { inicios, fim: Number(t.toFixed(6)) }
}

const FRAME = 0.02 // 960 amostras a 48 kHz

test('frames de um lote tocam em série, não empilhados', () => {
  const { inicios } = agendar([FRAME, FRAME, FRAME], 10, 0)
  assert.deepEqual(inicios, [10, 10.02, 10.04], 'cada frame começa onde o anterior terminou')
})

test('o lote inteiro dura o que o áudio dura', () => {
  const n = 18 // 18 frames de 20 ms = 360 ms
  const { fim } = agendar(Array(n).fill(FRAME), 5, 0)
  assert.ok(Math.abs(fim - (5 + n * FRAME)) < 1e-6, `fim ${fim}`)
})

test('cursor atrasado volta para agora em vez de acumular atraso', () => {
  // cursor ficou em 3 s, mas o relógio já está em 50 s: não tocar 47 s de nada.
  const { inicios } = agendar([FRAME, FRAME], 50, 3)
  assert.deepEqual(inicios, [50, 50.02])
})

test('cursor à frente é respeitado (fila contínua entre ciclos)', () => {
  const { inicios, fim } = agendar([FRAME], 10, 10.5)
  assert.deepEqual(inicios, [10.5], 'não volta para o passado: emenda na fila')
  assert.equal(fim, 10.52)
})

test('lote vazio não mexe no cursor', () => {
  const { inicios, fim } = agendar([], 7, 7.5)
  assert.deepEqual(inicios, [])
  assert.equal(fim, 7.5)
})
