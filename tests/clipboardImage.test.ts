// Colar imagem no compositor (Ctrl+V).
//
// A regressão: o `<textarea>` só entende texto, então um print na área de
// transferência não gerava NADA — nem mensagem, nem erro. `paste` precisa ler
// `clipboardData` e transformar o binário em arquivo do swarm.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hasPastedImage,
  isImageMime,
  pastedImageName,
  pastedImages,
  type ClipboardLike,
} from '../src/shared/clipboardImage.ts'

const WHEN = new Date(2026, 10, 2, 14, 5, 9)

function data(patch: Partial<ClipboardLike>): ClipboardLike {
  return { files: null, items: null, ...patch }
}

test('imagem colada: aceita os MIME de imagem usuais e recusa o resto', () => {
  for (const m of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif']) {
    assert.equal(isImageMime(m), true, `${m} é imagem`)
  }
  for (const m of ['text/plain', 'application/pdf', 'image/svg+xml', '', 'video/mp4']) {
    assert.equal(isImageMime(m), false, `${m} não é imagem colável`)
  }
})

test('imagem colada: nome vem do SO quando existe, senão é gerado com data', () => {
  assert.equal(pastedImageName('image/png', WHEN), 'imagem-20261102-140509.png')
  assert.equal(pastedImageName('image/jpeg', WHEN), 'imagem-20261102-140509.jpg')
  // Dois pastes no mesmo segundo não colidem por extensão diferente.
  assert.equal(pastedImageName('image/webp', WHEN), 'imagem-20261102-140509.webp')

  const comNome = pastedImages(data({
    files: [{ name: 'Captura de tela 2026-11-02.png', type: 'image/png', size: 1200 }],
  }), WHEN)
  assert.equal(comNome.length, 1)
  assert.equal(comNome[0].name, 'Captura de tela 2026-11-02.png', 'nome do SO é preservado')
})

test('imagem colada: print sem nome recebe nome único (não "image.png")', () => {
  const r = pastedImages(data({ files: [{ name: '', type: 'image/png', size: 999 }] }), WHEN)
  assert.equal(r.length, 1)
  assert.equal(r[0].name, 'imagem-20261102-140509.png')
  assert.equal(r[0].type, 'image/png')
  assert.equal(r[0].size, 999)
})

test('imagem colada: texto puro não vira arquivo', () => {
  const r = pastedImages(data({
    files: [{ name: 'nota.txt', type: 'text/plain', size: 12 }],
  }), WHEN)
  assert.deepEqual(r, [])
  assert.equal(hasPastedImage(data({ files: [{ name: 'a.txt', type: 'text/plain', size: 12 }] })), false)
})

test('imagem colada: cai em `items` quando o WebView não popula `files`', () => {
  // WebView2 às vezes só preenche `items`; sem este caminho o paste ficava vazio.
  const r = pastedImages(data({
    items: [
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/png', getAsFile: () => ({ name: '', type: 'image/png', size: 2048 }) },
    ],
  }), WHEN)
  assert.equal(r.length, 1)
  assert.equal(r[0].type, 'image/png')
  assert.equal(r[0].size, 2048)
  assert.equal(r[0].name, 'imagem-20261102-140509.png')
})

test('imagem colada: arquivo vazio ou ilegível é ignorado (não gera mensagem quebrada)', () => {
  const r = pastedImages(data({
    files: [
      { name: 'a.png', type: 'image/png', size: 0 },
      { name: 'b.png', type: 'image/png', size: Number.NaN },
    ],
  }), WHEN)
  assert.deepEqual(r, [])
})

test('imagem colada: várias imagens mantêm a ordem e o índice do File', () => {
  const r = pastedImages(data({
    files: [
      { name: 'um.png', type: 'image/png', size: 10 },
      { name: 'dois.jpg', type: 'image/jpeg', size: 20 },
    ],
  }), WHEN)
  assert.deepEqual(r.map(x => x.name), ['um.png', 'dois.jpg'])
  assert.deepEqual(r.map(x => x.fileIndex), [0, 1])
})
