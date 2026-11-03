import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TILE_ASPECT,
  bestGrid,
  gridColumns,
  maxColumnsFor,
  spotlightLayout,
} from '../src/services/callLayout.ts'

function areaOk(w: number, h: number) {
  assert.ok(w > 0 && h > 0, `card sem tamanho (${w}x${h})`)
  assert.ok(
    Math.abs(w / h - TILE_ASPECT) < 0.02,
    `card deformado: ${w.toFixed(1)}x${h.toFixed(1)} (proporção ${(w / h).toFixed(2)})`,
  )
}

test('uma pessoa ocupa a área com um card 16:9', () => {
  const g = bestGrid({ count: 1, width: 1200, height: 700 })
  assert.equal(g.columns, 1)
  assert.equal(g.rows, 1)
  areaOk(g.tileWidth, g.tileHeight)
})

test('duas pessoas lado a lado numa janela larga', () => {
  const g = bestGrid({ count: 2, width: 1400, height: 700 })
  assert.equal(g.columns, 2)
  assert.equal(g.rows, 1)
  areaOk(g.tileWidth, g.tileHeight)
})

test('duas pessoas empilhadas numa janela retrato (celular em pé)', () => {
  const g = bestGrid({ count: 2, width: 400, height: 800 })
  assert.equal(g.columns, 1, 'não dá para pôr dois cards lado a lado em 400px')
  assert.equal(g.rows, 2)
  areaOk(g.tileWidth, g.tileHeight)
})

test('três pessoas: grade equilibrada, sem card órfão no canto', () => {
  const g = bestGrid({ count: 3, width: 1400, height: 800 })
  assert.ok(g.columns >= 2, 'com espaço, três pessoas não ficam numa coluna só')
  assert.equal(g.rows, Math.ceil(3 / g.columns))
  areaOk(g.tileWidth, g.tileHeight)
})

test('quanto mais gente, mais colunas (até o teto)', () => {
  const duas = gridColumns({ count: 2, width: 1600, height: 900 })
  const seis = gridColumns({ count: 6, width: 1600, height: 900 })
  assert.ok(seis >= duas, 'a grade cresce com o número de participantes')
  assert.ok(seis <= 4, 'teto de colunas no desktop')
})

test('janela pequena mantém o card confortável e prefere rolar', () => {
  const g = bestGrid({ count: 9, width: 420, height: 300, minTileWidth: 200 })
  assert.equal(g.scroll, true, '9 pessoas em 420x300 não cabem legíveis')
  areaOk(g.tileWidth, g.tileHeight)
})

test('sem medida (primeiro paint) devolve um palpite sem quebrar', () => {
  const g = bestGrid({ count: 6, width: 0, height: 0 })
  assert.ok(g.columns >= 1 && g.rows >= 1)
  assert.equal(g.scroll, false, 'não rola antes de saber o tamanho')
})

test('fixar: destaque grande + faixa de miniaturas', () => {
  const s = spotlightLayout({ count: 3, width: 1400, height: 800 })
  assert.equal(s.strip, 'right', 'janela larga usa faixa lateral, como o Meet')
  assert.ok(s.main.width > s.thumb.width * 1.5, 'o destaque tem de ser bem maior que a miniatura')
  areaOk(s.main.width, s.main.height)
  areaOk(s.thumb.width, s.thumb.height)
})

test('fixar no celular: miniaturas embaixo, destaque com a largura toda', () => {
  const s = spotlightLayout({ count: 3, width: 390, height: 700 })
  assert.equal(s.strip, 'bottom', 'área estreita empilha as miniaturas')
  areaOk(s.main.width, s.main.height)
  assert.ok(s.main.width > 300, 'o destaque aproveita a largura do celular')
})

test('spotlight com 1 só miniatura não cria faixa gigante', () => {
  const s = spotlightLayout({ count: 1, width: 1400, height: 800 })
  assert.equal(s.perLine, 1)
  areaOk(s.main.width, s.main.height)
})

test('celular não tenta 4 colunas', () => {
  assert.equal(maxColumnsFor('mobile', 390), 2)
  assert.equal(maxColumnsFor('mobile', 700), 3)
  assert.equal(maxColumnsFor('desktop', 1200), 4)
  assert.equal(maxColumnsFor('desktop', 400), 1)
})

test('dimensionamento nunca zera (divisão por zero não vira NaN na tela)', () => {
  const g = bestGrid({ count: 5, width: 1, height: 1 })
  assert.ok(Number.isFinite(g.tileWidth) && Number.isFinite(g.tileHeight))
  assert.ok(g.columns >= 1)
})
