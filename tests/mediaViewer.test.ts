import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const card = readFileSync('src/components/FileCard.tsx', 'utf8')
const viewer = readFileSync('src/components/MediaViewer.tsx', 'utf8')

test('clicar na prévia de imagem/vídeo abre a tela cheia', () => {
  assert.match(card, /import \{ MediaViewer \} from '\.\/MediaViewer'/, 'o card usa o visualizador')
  assert.match(card, /Abrir \$\{name\} em tela cheia/, 'a prévia é um botão acessível')
  assert.match(card, /onClick=\{openFull\}/, 'clique abre')
  assert.match(card, /openFull\(\)/, 'teclado também abre')
  assert.match(card, /\{full && previewUrl && \(/, 'só monta com prévia')
})

test('a tela cheia mostra a mídia e tem botão de salvar e de fechar', () => {
  assert.match(viewer, /aria-modal="true"/, 'é um diálogo modal')
  assert.match(viewer, /controls/, 'vídeo com controles')
  assert.match(viewer, /alt=\{name\}/, 'imagem com alt')
  assert.match(viewer, /onSave/, 'tem ação de salvar')
  assert.match(viewer, /name="download"/, 'ícone de download no salvar')
  assert.match(viewer, /aria-label="Fechar"/, 'botão de fechar acessível')
  assert.match(viewer, /name="x"/, 'ícone de fechar')
})

test('a tela cheia fecha com Esc e devolve o scroll da página', () => {
  assert.match(viewer, /key === 'Escape'/, 'Esc fecha')
  assert.match(viewer, /overflow = 'hidden'/, 'trava o fundo')
  assert.match(viewer, /overflow = before/, 'restaura o scroll ao sair')
  assert.match(viewer, /onClick=\{onClose\}/, 'clique fora fecha')
})
