import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  resolveVoiceLayout,
  callScreenTitle,
  participantsLabel,
  CONTROLS_WIDTH_PX,
  MEMBERS_MIN_WIDTH_PX,
} from '../src/services/voiceLayout.ts'

const shell = readFileSync('src/designs/ThemeShell.tsx', 'utf8')
const stage = readFileSync('src/components/calls/VoiceStage.tsx', 'utf8')
const mobileChannel = readFileSync('src/mobile/MobileCallChannel.tsx', 'utf8')

test('dentro da chamada o palco preenche e o painel é estreito e fixo', () => {
  const l = resolveVoiceLayout({ isChannel: true, inThisCall: true, hasActiveCall: true, widthPx: 1600 })
  assert.equal(l.mode, 'in-call')
  assert.equal(l.stageFill, true, 'a mídia ocupa o centro todo')
  assert.equal(l.controlsWidthPx, CONTROLS_WIDTH_PX)
  assert.ok(l.controlsWidthPx <= 360, 'painel de controles estreito')
  assert.equal(l.showText, false, 'canal de chamada não tem compositor')
})

test('canal de chamada NUNCA mostra a tela de texto', () => {
  const lobby = resolveVoiceLayout({ isChannel: true, inThisCall: false, hasActiveCall: false, widthPx: 1400 })
  assert.equal(lobby.mode, 'lobby')
  assert.equal(lobby.showText, false, 'nem no lobby: canal de voz não tem mensagens')
  assert.equal(lobby.showChannelHeader, true)
})

test('conversa de texto continua com histórico e compositor', () => {
  const dm = resolveVoiceLayout({ isChannel: false, inThisCall: false, hasActiveCall: false, widthPx: 1400 })
  assert.equal(dm.showText, true)
  assert.equal(dm.stageFill, false)
})

test('painel de membros some dentro da chamada e em janela estreita', () => {
  const estreito = resolveVoiceLayout({ isChannel: true, inThisCall: true, hasActiveCall: true, widthPx: MEMBERS_MIN_WIDTH_PX - 1 })
  assert.equal(estreito.showMemberList, false, 'não cabe sem esmagar a mídia')
  const largo = resolveVoiceLayout({ isChannel: true, inThisCall: true, hasActiveCall: true, widthPx: MEMBERS_MIN_WIDTH_PX + 400 })
  assert.equal(largo.showMemberList, true)
})

test('largura desconhecida não esconde a lista (SSR/teste)', () => {
  const l = resolveVoiceLayout({ isChannel: true, inThisCall: true, hasActiveCall: true })
  assert.equal(l.showMemberList, true)
})

test('título nunca é um id nem fica vazio', () => {
  assert.equal(callScreenTitle({ channelName: 'geral' }), 'geral')
  assert.equal(callScreenTitle({ conversationTitle: 'Squad' }), 'Squad')
  assert.equal(callScreenTitle({ peerName: 'Ana' }), 'Ana')
  assert.equal(callScreenTitle({}), 'Chamada')
  assert.equal(callScreenTitle({ channelName: '   ' }), 'Chamada')
})

test('contagem de participantes é honesta no singular e no plural', () => {
  assert.equal(participantsLabel(0), 'ninguém na chamada')
  assert.equal(participantsLabel(1), '1 pessoa na chamada')
  assert.equal(participantsLabel(3), '3 pessoas na chamada')
})

test('o desktop tem UMA tela de chamada para lobby e chamada', () => {
  assert.match(shell, /import VoiceStage from/, 'o componente único é importado')
  assert.match(shell, /<VoiceStage/, 'é renderizado')
  assert.match(shell, /resolveVoiceLayout\(/, 'o layout vem da regra pura')
  assert.doesNotMatch(shell, /inThisCall \? \(\s*<CallTilesGrid/, 'sem dois layouts concorrentes')
})

test('o painel lateral antigo não duplica a tela unificada', () => {
  assert.match(shell, /\{painelLateralVisivel && \(/, 'painel lateral só fora da tela unificada')
  assert.match(shell, /painelLateralVisivel \? \(callPanelSize/, 'a margem acompanha o layout')
})

test('a barra lateral lê o canal do callId (não de estado paralelo)', () => {
  assert.match(shell, /parseVoiceCallId\(activeCall\?\.callId, activeCall\?\.convId\)/)
  assert.match(shell, /const estouNesteCanal = canalDaChamada\?\.channelId === ch\.id/)
  assert.match(shell, /\{canalDaChamada && \(/, 'a barra "Voz conectada" segue o canal real')
})

test('o palco monta os quadrados (áudio/vídeo vivem neles)', () => {
  assert.match(stage, /media\?: ReactNode/, 'recebe a mídia')
  assert.match(stage, /\{media\}/, 'renderiza a mídia')
  assert.match(stage, /data-testid="voice-stage"/)
})

test('os controles são os mesmos nos dois estados', () => {
  for (const rotulo of ['Ativar microfone', 'Ensurdecer', 'Ligar câmera', 'Sair da chamada']) {
    assert.match(stage, new RegExp(rotulo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `existe o controle "${rotulo}"`)
  }
  assert.match(stage, /Na chamada · \{peers\.length\}/, 'a coluna lista quem está na chamada')
})

test('no celular a mídia domina a tela e os controles ficam na barra inferior', () => {
  assert.match(mobileChannel, /if \(inCall\)/, 'há um layout próprio de chamada ativa')
  assert.match(mobileChannel, /media\b/, 'a mídia continua sendo renderizada (senão fica muda)')
  assert.match(mobileChannel, /env\(safe-area-inset-bottom\)/, 'controles respeitam a barra do sistema')
  assert.match(mobileChannel, /Sair da chamada/, 'dá para sair pelo celular')
})
