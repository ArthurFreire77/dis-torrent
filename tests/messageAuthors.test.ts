import test from 'node:test'
import assert from 'node:assert/strict'
import {
  JANELA_AGRUPAMENTO_MS,
  agruparComAnterior,
  autorDaMensagem,
} from '../src/components/social/messageAuthors.ts'

const bots = [
  { id: 'c-bot-DJ', name: 'DJ Resenha', avatar: '🎵' },
  { id: 'c-bot-Smith', name: 'ServerSmith', avatar: '🤖' },
]

const msg = (over: Partial<{
  author_fp: string
  direction: string
  bot_id: string
  ts: number
}> = {}) => ({
  author_fp: 'dono',
  direction: 'out',
  bot_id: '',
  ts: 1_000_000,
  ...over,
})

test('mensagens a menos de 30 s do mesmo autor ficam juntas', () => {
  const a = msg({ ts: 1_000_000 })
  const b = msg({ ts: 1_000_000 + 20_000 })
  assert.equal(agruparComAnterior(b, a), true, '20 s ainda é a mesma fala')
})

test('passou de 30 s, o perfil volta (avatar, nome e horário de novo)', () => {
  const a = msg({ ts: 1_000_000 })
  const b = msg({ ts: 1_000_000 + 31_000 })
  assert.equal(agruparComAnterior(b, a), false, '31 s separa as mensagens')
  assert.equal(JANELA_AGRUPAMENTO_MS, 30_000)
})

test('exatamente 30 s corta o grupo', () => {
  const a = msg({ ts: 0 })
  assert.equal(agruparComAnterior(msg({ ts: 30_000 }), a), false)
  assert.equal(agruparComAnterior(msg({ ts: 29_999 }), a), true)
})

test('autores diferentes nunca agrupam', () => {
  const a = msg({ author_fp: 'ana' })
  const b = msg({ author_fp: 'bruno' })
  assert.equal(agruparComAnterior(b, a), false)
})

test('dois bots diferentes não agrupam, mesmo falando pelo mesmo dono', () => {
  const dj = msg({ bot_id: 'c-bot-DJ', direction: 'out' })
  const smith = msg({ bot_id: 'c-bot-Smith', direction: 'out' })
  assert.equal(agruparComAnterior(smith, dj), false)
  assert.equal(agruparComAnterior(msg({ bot_id: 'c-bot-DJ' }), dj), true)
})

test('mensagem apagada quebra o grupo', () => {
  const a = msg({ ts: 1_000_000 })
  const b = msg({ ts: 1_001_000 })
  assert.equal(agruparComAnterior(b, a, { anteriorApagada: true }), false)
})

test('sem mensagem anterior não há grupo', () => {
  assert.equal(agruparComAnterior(msg(), null), false)
  assert.equal(agruparComAnterior(msg(), undefined), false)
})

test('mensagem de bot mostra o BOT, não o dono', () => {
  const autor = autorDaMensagem(
    { author_fp: 'dono', direction: 'out', bot_id: 'c-bot-DJ' },
    { myFp: 'dono', bots, nomeDe: () => 'Lucas' },
  )
  assert.equal(autor.bot, true)
  assert.equal(autor.nome, 'DJ Resenha')
  assert.equal(autor.emoji, '🎵')
  assert.equal(autor.fp, 'c-bot-DJ', 'o fingerprint vira o do bot para não abrir o perfil do dono')
})

test('bot desconhecido não vira o dono nem quebra', () => {
  const autor = autorDaMensagem(
    { author_fp: 'dono', direction: 'out', bot_id: 'c-bot-sumiu' },
    { myFp: 'dono', bots, nomeDe: () => 'Lucas' },
  )
  assert.equal(autor.bot, true)
  assert.equal(autor.nome, 'Bot')
  assert.equal(autor.emoji, undefined)
})

test('minha mensagem normal continua sendo minha', () => {
  const autor = autorDaMensagem(
    { author_fp: 'dono', direction: 'out' },
    { myFp: 'dono', bots, nomeDe: () => 'Lucas' },
  )
  assert.equal(autor.bot, false)
  assert.equal(autor.nome, 'Lucas')
  assert.equal(autor.fp, 'dono')
})

test('mensagem recebida usa o autor do envelope, não eu', () => {
  const autor = autorDaMensagem(
    { author_fp: 'ana', direction: 'in' },
    { myFp: 'dono', bots, nomeDe: (fp) => (fp === 'ana' ? 'Ana' : 'Lucas') },
  )
  assert.equal(autor.fp, 'ana')
  assert.equal(autor.nome, 'Ana')
  assert.equal(autor.bot, false)
})
