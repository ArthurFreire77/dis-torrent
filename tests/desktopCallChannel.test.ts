// Canal de voz/vídeo no DESKTOP não pode ser uma tela de texto.
//
// Bug relatado: "no PC tá uma merda, o canal de servidor não deve ter como
// digitar". Selecionar um canal de voz/vídeo caía na tela de mensagens, com
// histórico vazio e COMPOSITOR de texto — num canal onde ninguém digita.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const shell = readFileSync('src/designs/ThemeShell.tsx', 'utf8')
const stage = readFileSync('src/components/calls/CallChannelStage.tsx', 'utf8')

test('desktop troca a tela de mensagens pela tela da chamada', () => {
  assert.match(shell, /selCallChannel &&/, 'existe o ramo que detecta canal de chamada')
  assert.match(shell, /<VoiceStage/, 'a tela da chamada é renderizada')
  // O compositor e o histórico ficam FORA do caso de chamada.
  assert.match(shell, /\{selConv && !selCallChannel && \(\s*<>/, 'histórico só em canal de texto')
  assert.match(shell, /\{selConv && !selCallChannel && \(\s*<div style=\{\{ padding: '0 16px 24px'/, 'compositor só em canal de texto')
})

test('o tipo do canal chega no desktop (senão cai como texto)', () => {
  // `mergedChannelsForLabel` alimenta a sidebar e a escolha da tela: sem o
  // `kind` ali, um canal de voz recém-criado volta a parecer texto.
  assert.match(shell, /name: string; kind: ChannelMeta\['kind'\]/, 'a lista da sidebar carrega o tipo')
  assert.match(shell, /kind: ov\.kind/, 'o tipo vem da lista completa')
})

test('cabeçalho do canal de voz usa ícone e texto de chamada, não "#"', () => {
  assert.match(shell, /selCallChannel \? \(selCallChannel\.kind === 'video' \? Icons\.video : Icons\.speaker\) : Icons\.hash/)
  assert.match(shell, /Canal de vídeo — a câmera é opcional/)
})

test('tela da chamada é honesta: sem entrar, mostra quem está e o motivo', () => {
  assert.match(stage, /useChannelVoicePeers/, 'participantes vêm do motor')
  assert.match(stage, /unavailable/, 'mostra por que não dá para entrar')
  assert.match(stage, /Canal de chamada não tem mensagens/, 'diz que não há texto')
})

test('entrar/sair usa o MESMO joinVoice/leaveVoice do canal de voz', () => {
  assert.match(shell, /callManager\.joinVoice\(selCommunity, selCallChannel\.id\)/)
  // Sair usa o canal DERIVADO do callId — não o `selCommunity` da tela, que
  // pode ser outro servidor e mandava o `voiceLeave` para o lugar errado.
  assert.match(shell, /callManager\.leaveVoice\(canalDaChamada\.communityId, canalDaChamada\.channelId\)/)
})
