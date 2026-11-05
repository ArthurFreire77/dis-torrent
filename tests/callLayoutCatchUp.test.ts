import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const shell = readFileSync('src/designs/ThemeShell.tsx', 'utf8')
const grid = readFileSync('src/components/calls/CallTilesGrid.tsx', 'utf8')

test('threads NÃO ficam mais aninhadas na sidebar', () => {
  assert.doesNotMatch(shell, /<ThreadList/, 'a lista de threads saiu da navegação')
})

test('canal de voz ocupa o espaço central com os quadrados da chamada', () => {
  assert.match(shell, /const inThisCall = /, 'existe o estado "estou nesta chamada"')
  assert.match(shell, /<VoiceStage/, 'a chamada ocupa o centro do canal')
  assert.match(shell, /tiles=\{visibleCallTiles\}/, 'a grade de tiles vai para a tela da chamada')
})

test('os quadrados não aparecem DUAS vezes (centro + painel lateral)', () => {
  assert.match(shell, /\{painelLateralVisivel && \(/, 'o painel lateral só existe fora da tela unificada')
  assert.doesNotMatch(
    shell.slice(shell.indexOf('{painelLateralVisivel && ('), shell.indexOf('{painelLateralVisivel && (') + 8000),
    /<CallTilesGrid/,
    'o painel lateral não repete os quadrados do centro',
  )
})

test('a grade de tiles é UM componente (áudio/vídeo vivem nos tiles)', () => {
  assert.match(grid, /export default function CallTilesGrid/, 'grade reutilizável')
  assert.match(grid, /CallTileComponent/, 'usa o tile que monta <audio>/<video>')
})
