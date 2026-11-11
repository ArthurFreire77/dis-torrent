// Regressões dos bugs de call de servidor: botões, mute e roster.
// Os três foram reportados como "os botões da call de servidor não funcionam".

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manager = readFileSync('src/services/callManager.ts', 'utf8')
const shell = readFileSync('src/designs/ThemeShell.tsx', 'utf8')
const mobile = readFileSync('src/mobile/MobileShell.tsx', 'utf8')
const voiceChannels = readFileSync('distorrent-core/src/net/engine/voice_channels.rs', 'utf8')
const fVoice = readFileSync('distorrent-core/src/net/engine/f_voice.rs', 'utf8')

test('mute no canal PUBLICA voice_state (senão o mic dos outros nunca muda)', () => {
  const mute = manager.slice(manager.indexOf('toggleMute()'))
  assert.match(
    mute.slice(0, 1200),
    /services\s*\.\s*voiceState\(/,
    'sem publicar, o ícone de mic dos outros fica travado',
  )
  const deafen = manager.slice(manager.indexOf('toggleDeafen()'))
  assert.match(deafen.slice(0, 1400), /services\s*\.\s*voiceState\(/)
})

test('clicar no canal em que já estou abre os controles, não sai', () => {
  const bloco = shell.slice(shell.indexOf('const estouNesteCanal'))
  assert.match(
    bloco.slice(0, 900),
    /setShowCallSettings\(true\)/,
    'o clique precisa abrir os ajustes da chamada',
  )
  assert.doesNotMatch(
    bloco.slice(0, 900),
    /leaveVoice\(/,
    'o clique do canal não pode desconectar ninguém',
  )
})

test('no mobile, o mesmo canal também só abre (não sai)', () => {
  const enter = mobile.slice(mobile.indexOf('const enterCallChannel'))
  assert.match(
    enter.slice(0, 1600),
    /parseVoiceCallId/,
    'precisa reconhecer que já está no canal',
  )
  const bloco = enter.slice(0, 1600)
  const idxRef = bloco.indexOf('parseVoiceCallId')
  assert.doesNotMatch(
    bloco.slice(0, idxRef),
    /leaveVoice/,
    'não pode chamar leave antes de saber onde está',
  )
})

test('lista do canal usa presença de voz, não link P2P', () => {
  const lista = shell.slice(shell.indexOf('const channelCallPeers'))
  assert.doesNotMatch(
    lista.slice(0, 1600),
    /vivos\.size > 0 && !vivos\.has\(fp\)\) continue/,
    'filtrar por link vivo escondia quem estava na call via relay',
  )
  assert.match(lista.slice(0, 1600), /for \(const \[fp\] of voiceStates\)/)
})

test('botão de tela/efeitos do celular não some no painel compacto', () => {
  const painel = mobile.slice(mobile.indexOf('data-testid="mobile-call-panel"'))
  const idxTela = painel.indexOf('mobile-screen-share')
  const idxEfeitos = painel.indexOf('mobile-soundboard')
  assert.ok(idxTela > 0, 'o botão de tela existe no painel')
  assert.ok(idxEfeitos > 0, 'o botão de efeitos existe no painel')
  // Entre o início do painel e o botão de tela não pode haver um `&&` que
  // dependa de callPanelSize !== 'compact' abrindo o container dos dois.
  const antes = painel.slice(0, idxTela)
  const gate = /callPanelSize !== 'compact' && <div[^>]*>\s*$/
  assert.doesNotMatch(
    antes.slice(Math.max(0, antes.length - 400)),
    gate,
    'tela e efeitos precisam ficar fora do gate de compacto',
  )
})

test('reanúncio renova o carimbo ANTES de limpar o roster', () => {
  const reannounce = voiceChannels.slice(voiceChannels.indexOf('fn reannounce_voice_channels'))
  const bloco = reannounce.slice(0, 2600)
  const touch = bloco.indexOf('touch_voice_state')
  const purge = bloco.indexOf('purge_stale_voice_states')
  assert.ok(touch > 0, 'renova o próprio carimbo')
  assert.ok(purge > touch, 'limpa só depois de renovar o próprio')
})

test('o reanúncio do peer não zera mute (lê antes de gravar)', () => {
  // Ancora no braço do match (indentado), não no `matches!`/docs acima.
  const inicio = fVoice.indexOf('SecureFrame::VoiceJoin {\n            community_id,')
  assert.ok(inicio > 0, 'achou o braço do VoiceJoin')
  const bloco = fVoice.slice(inicio, inicio + 1800)
  const leitura = bloco.indexOf('peer_voice_mute')
  const escrita = bloco.indexOf('.set_voice_state(')
  assert.ok(leitura > 0, 'precisa ler o estado anterior')
  assert.ok(escrita > 0, 'precisa gravar o estado')
  assert.ok(
    leitura < escrita,
    'ler depois de gravar lia o valor já zerado (o mute sumia)',
  )
})
