import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeChannels,
  groupByCategory,
  channelsOfKind,
} from '../src/app/channels.ts'
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

// ---------- o bug real ----------

// `communities_list` e `channel_list` devolvem a MESMA tabela `channels`.
// A UI juntava as duas listas. Com filtro, ficava certo; sem filtro (o painel
// de bot), o mesmo canal aparecia duas vezes.
test('canal presente nas DUAS listas aparece uma vez só', () => {
  const summary = [['cid-geral', 'geral'], ['cid-random', 'random']] as const
  const full = [ch('cid-geral', 'geral'), ch('cid-random', 'random')]

  const merged = mergeChannels(summary, full)
  assert.equal(merged.length, 2, 'duas fontes, dois canais, duas linhas')
  assert.deepEqual(merged.map((c) => c.id), ['cid-geral', 'cid-random'])
})

test('sem filtro de duplicata o painel de bot mostrava o dobro', () => {
  // Reproduz o bug exato do ThemeShell.tsx:2725 antes da correção.
  const summary = [['cid-geral', 'geral']] as const
  const full = [ch('cid-geral', 'geral')]

  const antigo = [...summary.map(([id, name]) => ch(id, name)), ...full]
  assert.equal(antigo.length, 2, 'o merge ingênuo duplica — este é o bug')

  const novo = mergeChannels(summary, full)
  assert.equal(novo.length, 1, 'mergeChannels não duplica')
})

// ---------- precedência ----------

test('lista completa vence: traz tipo, categoria, tópico e posição', () => {
  const summary = [['cid-v', 'voz']] as const
  const full = [
    ch('cid-v', 'voz', {
      kind: 'voice',
      category: 'CANAIS DE VOZ',
      topic: 'fale aqui',
      position: 7,
    }),
  ]

  const [c] = mergeChannels(summary, full)
  assert.equal(c.kind, 'voice')
  assert.equal(c.category, 'CANAIS DE VOZ')
  assert.equal(c.topic, 'fale aqui')
  assert.equal(c.position, 7)
})

test('canal só na resumida sobrevive (channel_list ainda não respondeu)', () => {
  const summary = [['cid-a', 'a'], ['cid-b', 'b']] as const
  const full = [ch('cid-b', 'b')]

  const merged = mergeChannels(summary, full)
  assert.deepEqual(merged.map((c) => c.id).sort(), ['cid-a', 'cid-b'])
})

test('entrada sem id ou nome é ignorada, não quebra o merge', () => {
  const summary = [['', 'sem-id'], ['cid-ok', 'ok'], ['cid-sem-nome', '']] as const
  const full = [ch('cid-ok', 'ok'), ch('', 'nada')]

  const merged = mergeChannels(summary, full)
  assert.deepEqual(merged.map((c) => c.id), ['cid-ok'])
})

test('listas vazias e indefinidas não quebram', () => {
  assert.deepEqual(mergeChannels(undefined, undefined), [])
  assert.deepEqual(mergeChannels([], []), [])
  assert.equal(mergeChannels(undefined, [ch('a', 'a')]).length, 1)
  assert.equal(mergeChannels([['a', 'a']], undefined).length, 1)
})

// ---------- deduplicação por nome ----------

test('mesmo nome com id diferente deduplica (usuário vê um canal só)', () => {
  // Convite de outro host pode ter dado ao mesmo canal um id prefixado.
  const summary = [['outrocid-geral', 'geral']] as const
  const full = [ch('cid-geral', 'geral')]

  const merged = mergeChannels(summary, full)
  assert.equal(merged.length, 1, 'geral não pode aparecer duas vezes')
})

test('dedup de nome ignora caixa, acento e separador', () => {
  const full = [
    ch('a', 'Geral'),
    ch('b', 'geral'),
    ch('c', 'gera l'),
    ch('d', 'gerál'),
  ]
  const merged = mergeChannels(undefined, full)
  const nomes = merged.map((c) => c.name.toLowerCase())
  assert.equal(new Set(nomes).size, nomes.length, `ainda duplicado: ${nomes}`)
  assert.ok(merged.length < full.length, 'algum deve ter sido absorvido')
})

test('nomes realmente diferentes convivem', () => {
  const full = [ch('a', 'geral'), ch('b', 'random'), ch('c', 'videos')]
  assert.equal(mergeChannels(undefined, full).length, 3)
})

// ---------- ordenação ----------

test('ordena por posição e desempata por nome', () => {
  const full = [
    ch('c', 'zebra', { position: 2 }),
    ch('a', 'alfa', { position: 0 }),
    ch('b', 'beta', { position: 0 }),
  ]
  assert.deepEqual(
    mergeChannels(undefined, full).map((c) => c.id),
    ['a', 'b', 'c'],
    'posição 0 vem antes da 2; alfa antes de beta no empate',
  )
})

test('ordem é determinística com posições iguais e nomes iguais em caixa diferente', () => {
  const full = [ch('z', 'ALFA', { position: 1 }), ch('a', 'alfa', { position: 1 })]
  const r1 = mergeChannels(undefined, full).map((c) => c.id)
  const r2 = mergeChannels(undefined, [...full].reverse()).map((c) => c.id)
  assert.deepEqual(r1, r2)
})

// ---------- agrupamento ----------

test('groupByCategory preserva ordem de aparição e junta iguais', () => {
  const list = [
    ch('1', 'geral', { category: 'TEXTO' }),
    ch('2', 'random', { category: 'TEXTO' }),
    ch('3', 'voz1', { category: 'VOZ', kind: 'voice' }),
    ch('4', 'sem-cat', { category: '' }),
  ]
  const grupos = groupByCategory(list)
  assert.deepEqual(grupos.map((g) => g.category), ['TEXTO', 'VOZ', 'SEM CATEGORIA'])
  assert.equal(grupos[0].channels.length, 2)
})

test('groupByCategory com lista vazia não quebra', () => {
  assert.deepEqual(groupByCategory([]), [])
})

test('channelsOfKind separa texto, voz e vídeo; ausente = texto', () => {
  const list = [
    ch('1', 't'),
    ch('2', 'v', { kind: 'voice' }),
    ch('3', 'vid', { kind: 'video' }),
    ch('4', 'sem-kind', { kind: undefined as never }),
  ]
  assert.deepEqual(channelsOfKind(list, 'text').map((c) => c.id), ['1', '4'])
  assert.deepEqual(channelsOfKind(list, 'voice').map((c) => c.id), ['2'])
  assert.deepEqual(channelsOfKind(list, 'video').map((c) => c.id), ['3'])
})

// ---------- o contrato que a UI realmente usa ----------

test('contagem bate com a lista deduplicada (o contador somava as duas listas)', () => {
  const summary = [['c1', 'geral'], ['c2', 'random'], ['c3', 'voz']] as const
  const full = [ch('c1', 'geral'), ch('c2', 'random'), ch('c3', 'voz')]
  const merged = mergeChannels(summary, full)
  assert.equal(merged.length, 3)
  // a UI antiga exibia `summary.length + full.length` = 6 para 3 canais
  assert.notEqual(summary.length + full.length, merged.length)
})