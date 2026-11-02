// Layout da tela de chamada e o "só conecta na segunda".
//
// Relatos do dono:
// - "tira as threads da sidebar, deixa só o canal normal";
// - "quando está no mesmo canal de voz ele deve ocupar aquele espaço com a
//   janela de chamada";
// - "só conectou de segunda" (a estreia no canal não abre par nenhum).

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const shell = readFileSync('src/designs/ThemeShell.tsx', 'utf8')
const manager = readFileSync('src/services/callManager.ts', 'utf8')
const grid = readFileSync('src/components/calls/CallTilesGrid.tsx', 'utf8')

test('threads NÃO ficam mais aninhadas na sidebar', () => {
  assert.doesNotMatch(shell, /<ThreadList/, 'a lista de threads saiu da navegação')
  assert.match(shell, /Threads saíram da sidebar/, 'o motivo fica registrado')
})

test('canal de voz ocupa o espaço central com os quadrados da chamada', () => {
  // Dentro da chamada do canal aberto, a mídia é o conteúdo principal.
  assert.match(shell, /const inThisCall = /, 'existe o estado "estou nesta chamada"')
  assert.match(shell, /inThisCall \? \(\s*<CallTilesGrid/, 'a chamada ocupa o centro do canal')
})

test('os quadrados não aparecem DUAS vezes (centro + painel lateral)', () => {
  assert.match(shell, /\{!inThisCall && \(\s*<CallTilesGrid/, 'o painel lateral só mostra tiles fora do canal')
  assert.match(shell, /senão a mesma mídia\s*\n?\s*aparece duas vezes/, 'o porquê está documentado')
})

test('a grade de tiles é UM componente (áudio/vídeo vivem nos tiles)', () => {
  assert.match(grid, /export default function CallTilesGrid/, 'grade reutilizável')
  assert.match(grid, /CallTileComponent/, 'usa o tile que monta <audio>/<video>')
})

test('entrar no canal abre par mesmo quando o roster chega atrasado', () => {
  // Causa do "só conecta de segunda": o voiceStates era lido uma única vez e,
  // na estreia, ainda não tinha o outro peer — ninguém abria o PC.
  assert.match(manager, /catchUpVoiceRoster\(callId, communityId, channelId\)/, 'catch-up é chamado no join')
  const bloco = manager.slice(manager.indexOf('private catchUpVoiceRoster'))
  assert.ok(bloco.length > 0, 'a função existe')
  assert.match(bloco.slice(0, 2000), /createPC\(fp, callId, true\)/, 'abre o par que faltava')
  assert.match(bloco.slice(0, 1200), /\[1200, 3500, 8000\]/, 'tenta em três janelas')
})
