import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canManageChannels,
  channelActionLabel,
  channelIcon,
  defaultCategoryFor,
  normalizeChannelName,
} from '../src/mobile/mobileServerModel.ts'
import { isCallableChannel, mergeChannels, groupByCategory } from '../src/app/channels.ts'
import type { ChannelMeta } from '../src/services/models.ts'

const ch = (id: string, name: string, over: Partial<ChannelMeta> = {}): ChannelMeta => ({
  id,
  name,
  topic: '',
  category: 'CANAIS DE TEXTO',
  position: 0,
  kind: 'text',
  ...over,
})

// ---------- canal de vídeo é chamada, como o de voz ----------

test('voice e video entram em chamada; texto e forum não', () => {
  assert.equal(isCallableChannel('voice'), true)
  assert.equal(isCallableChannel('video'), true)
  assert.equal(isCallableChannel('text'), false)
  assert.equal(isCallableChannel('forum'), false)
  assert.equal(isCallableChannel(undefined), false)
})

test('o canal de vídeo NÃO abre a tela de texto no celular', () => {
  // Antes só `voice` era tratado como canal; `video` caía no compositor.
  const canais = [ch('a', 'geral'), ch('b', 'sala', { kind: 'video' }), ch('c', 'call', { kind: 'voice' })]
  const chamada = canais.filter((c) => isCallableChannel(c.kind))
  assert.deepEqual(chamada.map((c) => c.id), ['b', 'c'])
})

test('mergeChannels preserva o tipo video (não degrada para texto)', () => {
  const merged = mergeChannels([['cid-v', 'sala']], [ch('cid-v', 'sala', { kind: 'video' })])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.kind, 'video')
})

test('groupByCategory separa vídeo de voz quando as categorias diferem', () => {
  const lista = [
    ch('v1', 'voz', { kind: 'voice', category: 'CANAIS DE VOZ' }),
    ch('v2', 'sala', { kind: 'video', category: 'CANAIS DE VÍDEO' }),
  ]
  const grupos = groupByCategory(lista)
  assert.deepEqual(grupos.map((g) => g.category), ['CANAIS DE VOZ', 'CANAIS DE VÍDEO'])
  assert.equal(grupos[1]!.channels[0]!.kind, 'video')
})

// ---------- ícone / rótulo de ação ----------

test('ícone do canal segue o tipo', () => {
  assert.equal(channelIcon('voice'), 'speaker')
  assert.equal(channelIcon('video'), 'video')
  assert.equal(channelIcon('forum'), 'tag')
  assert.equal(channelIcon('text'), 'hash')
  assert.equal(channelIcon(undefined), 'hash')
})

test('rótulo diz entrar, sair e quantas pessoas estão na chamada', () => {
  assert.equal(channelActionLabel('voice', 0, false), 'Entrar na chamada de voz')
  assert.equal(channelActionLabel('video', 0, false), 'Entrar na chamada de vídeo')
  assert.equal(channelActionLabel('voice', 2, false), 'Entrar na chamada de voz — 2 pessoas')
  assert.equal(channelActionLabel('voice', 1, false), 'Entrar na chamada de voz — 1 pessoa')
  assert.equal(channelActionLabel('voice', 3, true), 'Sair da chamada de voz')
  assert.equal(channelActionLabel('text', 5, false), 'Abrir canal de texto')
})

// ---------- gestão: só o dono (o core também recusa) ----------

test('só o dono gerencia canais', () => {
  assert.equal(canManageChannels('dono', 'dono'), true)
  assert.equal(canManageChannels('dono', 'outro'), false)
  assert.equal(canManageChannels(undefined, 'eu'), false)
  assert.equal(canManageChannels('dono', undefined), false)
})

test('categoria padrão por tipo bate com o core', () => {
  assert.equal(defaultCategoryFor('voice'), 'CANAIS DE VOZ')
  assert.equal(defaultCategoryFor('video'), 'CANAIS DE VÍDEO')
  assert.equal(defaultCategoryFor('text'), 'CANAIS DE TEXTO')
  assert.equal(defaultCategoryFor(undefined), 'CANAIS DE TEXTO')
})

test('nome do canal é normalizado antes de ir para o core', () => {
  assert.equal(normalizeChannelName('  Sala de Jogo  '), 'sala-de-jogo')
  assert.equal(normalizeChannelName(''), '')
  assert.equal(normalizeChannelName('   '), '')
})
