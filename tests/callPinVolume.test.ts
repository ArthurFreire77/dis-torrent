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

test('o palco dá DESTAQUE ao fixado, procurado por ID', () => {
  assert.match(grid, /const fixado = pinnedId \? tiles\.find/, 'acha o fixado pelo id')
  assert.match(grid, /const temDestaque = !!fixado && tiles\.length > 1/, 'só destaca com mais de um card')
  assert.doesNotMatch(
    grid,
    /tiles\[0\]\?\.id === pinnedId/,
    'confiar em tiles[0] desligava a fixação quando a ordem mudava',
  )
})

test('fixado só vale com mais de um card (sozinho já ocupa tudo)', () => {
  assert.match(grid, /tiles\.length > 1/)
})

test('os cards mantêm a PROPORÇÃO (nada de esticar para preencher a célula)', () => {
  assert.match(grid, /tileWidth/, 'largura calculada pelo motor de layout')
  assert.match(grid, /tileHeight/, 'altura calculada pelo motor de layout')
  assert.match(grid, /justifyItems: 'center'/, 'card centrado, não esticado')
})

test('o volume não usa <details> nativo (fechava ao arrastar)', () => {
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
