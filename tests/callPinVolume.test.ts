// Fixar e volume precisam FUNCIONAR (relato do dono com prints do Meet).
//
// "e o fixar deve ser funcional e volume também deve ser tudo bem funcional".
// Dois bugs reais:
// - o card fixado continuava do mesmo tamanho dos outros (a grade do palco
//   ignorava `pinnedId` e a ordem);
// - o controle de volume era um `<details>` nativo que FECHAVA ao arrastar o
//   slider, porque o tile remonta a cada evento da chamada.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sortTilesForPin, type CallTile } from '../src/services/callTiles.ts'

const grid = readFileSync('src/components/calls/CallTilesGrid.tsx', 'utf8')
const controls = readFileSync('src/components/calls/ParticipantAudioControls.tsx', 'utf8')
const tile = readFileSync('src/components/calls/CallTile.tsx', 'utf8')

function t(id: string): CallTile {
  return {
    id, kind: 'participant', fp: id, nickname: id, label: id,
    isLocal: false, sharing: false, muted: false, speaking: false,
    disconnected: false, cameraOn: false, localPreviewUnavailable: false,
  }
}

test('fixar coloca o card escolhido em primeiro', () => {
  const tiles = [t('a'), t('b'), t('c')]
  const ordenado = sortTilesForPin(tiles, 'b')
  assert.equal(ordenado[0]!.id, 'b', 'o fixado vem primeiro (a grade depende disso)')
  assert.deepEqual(ordenado.map((x) => x.id), ['b', 'a', 'c'], 'os outros mantêm a ordem')
})

test('sem fixar a ordem não muda', () => {
  const tiles = [t('a'), t('b')]
  assert.deepEqual(sortTilesForPin(tiles, null).map((x) => x.id), ['a', 'b'])
})

test('id inexistente não reordena nada', () => {
  const tiles = [t('a'), t('b')]
  assert.deepEqual(sortTilesForPin(tiles, 'zzz').map((x) => x.id), ['a', 'b'])
})

test('o palco dá ao fixado a linha INTEIRA (card grande)', () => {
  // Sem `gridColumn: 1 / -1` o fixado ficava do mesmo tamanho dos demais e o
  // botão de fixar parecia não fazer nada.
  assert.match(grid, /const temFixado = !!pinnedId/)
  assert.match(grid, /gridColumn: `1 \/ -1`/)
  assert.match(grid, /tiles\[0\]\?\.id === pinnedId/, 'depende da ordem do shell')
})

test('fixado só vale com mais de um card (sozinho já ocupa tudo)', () => {
  assert.match(grid, /tiles\.length > 1/)
})

test('todos os cards têm a MESMA altura (retângulos iguais)', () => {
  // Print do dono: cards de tamanhos diferentes, tortos.
  assert.match(grid, /gridAutoRows: `\$\{alturaCard\}px`/, 'altura única para as linhas')
  // `justifyContent: 'center'` numa grade de colunas 1fr encolhia as colunas.
  assert.doesNotMatch(grid, /justifyContent: 'center',\s*\n\s*overflowY/, 'center fazia as colunas encolherem')
})

test('o volume não usa <details> nativo (fechava ao arrastar)', () => {
  // O tile remonta a cada evento da chamada e o `<details>` nativo fechava no
  // meio do gesto do slider. O aberto/fechado agora é estado do React.
  assert.doesNotMatch(controls, /<details[\s>]/, 'sem tag details')
  assert.doesNotMatch(controls, /<summary[\s>]/, 'sem tag summary')
  assert.match(controls, /const \[aberto, setAberto\]/, 'aberto/fechado é estado do React')
})

test('o controle de volume não propaga o clique para fixar/expandir', () => {
  assert.match(controls, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/)
  assert.match(controls, /onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}/)
})

test('o volume é salvo e reaplicado em todos os elementos montados', () => {
  assert.match(controls, /saveParticipantPlaybackSettings/)
  assert.match(controls, /applyMountedParticipantPlayback/)
  assert.match(controls, /type="range"/)
})

test('o botão de volume aparece mesmo sem stream (áudio pode chegar depois)', () => {
  const posControle = tile.indexOf('showAudioControls && !tile.isLocal')
  assert.ok(posControle > 0, 'existe o bloco do controle')
  const bloco = tile.slice(posControle, posControle + 400)
  assert.match(bloco, /ParticipantAudioControls/)
  assert.doesNotMatch(bloco, /audioStream \?\? tile\.stream/, 'não depende de haver stream')
})

test('o volume do <audio> é reaplicado quando o stream chega', () => {
  const efeito = tile.slice(tile.indexOf('const audioSrc ='))
  assert.match(efeito.slice(0, 900), /applyParticipantPlayback/, 'reaplica no elemento')
})
