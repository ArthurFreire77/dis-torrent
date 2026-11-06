import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const shell = readFileSync('src/designs/ThemeShell.tsx', 'utf8')
const grid = readFileSync('src/components/calls/CallTilesGrid.tsx', 'utf8')
const tile = readFileSync('src/components/calls/CallTile.tsx', 'utf8')

test('painéis em FLUXO não aparecem dentro do canal de chamada', () => {
  // Eles são irmãos do VoiceStage numa coluna flex. Sem este gate, o
  // min-content deles (até 380px cada) empurrava o palco para 0px — a raiz do
  // "vídeo achatado" quando outro painel estava aberto.
  for (const painel of ['showSearch', 'showPins', 'showBookmarks', 'showInbox']) {
    assert.match(
      shell,
      new RegExp(`\\{\\(?[^}\\n]*!selCallChannel[^}\\n]*${painel} && \\(`),
      `${painel} precisa do gate !selCallChannel`,
    )
  }
})

test('a coluna principal nunca deixa o conteúdo ditar a altura', () => {
  const linha = shell.split('\n').find((l) => l.includes('ref={mainColRef}')) ?? ''
  assert.match(linha, /minHeight: 0/, 'sem minHeight:0 o min-content dos painéis vence')
  assert.match(linha, /overflow: 'hidden'/, 'sem overflow o conteúdo extra estica a coluna')
})

test('a grade com rolagem realmente rola (não corta)', () => {
  // `height:'auto'` deixava a grade do tamanho do conteúdo: o overflowY:auto
  // nunca tinha o que rolar e o excesso era cortado topo/rodapé.
  const grade = grid.slice(grid.indexOf('const grade = ('))
  assert.match(grade.slice(0, 900), /height: '100%'/)
  assert.doesNotMatch(grade.slice(0, 900), /height: spec\.scroll \? 'auto'/)
  assert.match(grade.slice(0, 900), /alignContent: spec\.scroll \? 'start'/)
})

test('card com proporção não leva piso de altura', () => {
  // `min-height` vence `aspect-ratio`: qualquer célula estreita saía achatada.
  const card = tile.slice(tile.indexOf('position: \'relative\''))
  assert.match(card.slice(0, 1200), /isScreen \? \{ minHeight:/, 'só o card sem proporção tem piso')
  assert.doesNotMatch(card.slice(0, 1200), /minHeight: expanded \? 0 : thumbnail \? 72 : minHeight(?![^?]*isScreen)/)
})
