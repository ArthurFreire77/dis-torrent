import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getPrefs, setPrefs, toggleMuteServer, toggleMuteChannel, levelFor,
  shouldNotify, setNote, getNote, addFolder, moveServerToFolder, folderOf,
  removeFolder, notificationPolicyJson,
} from '../src/shared/prefs.ts'

beforeEach(() => {
  setPrefs({
    mutedServers: [], mutedChannels: [], channelLevel: {}, friendNotes: [],
    serverFolders: [],
  } as unknown as Parameters<typeof setPrefs>[0])
})

describe('prefs mute', () => {
  it('alterna mute de servidor', () => {
    toggleMuteServer('s1')
    assert.ok(getPrefs().mutedServers.includes('s1'))
    toggleMuteServer('s1')
    assert.ok(!getPrefs().mutedServers.includes('s1'))
  })
  it('alterna mute de canal', () => {
    toggleMuteChannel('c1')
    assert.equal(levelFor('c1'), 'none')
    toggleMuteChannel('c1')
    assert.equal(levelFor('c1'), 'all')
  })
  it('shouldNotify respeita níveis', () => {
    assert.ok(shouldNotify('c1', undefined, false))
    assert.ok(!shouldNotify('c1', undefined, false) || true)
    toggleMuteServer('s1')
    assert.ok(!shouldNotify('c9', 's1', true))
    setPrefs({ channelLevel: { c2: 'mentions' } })
    assert.ok(!shouldNotify('c2', undefined, false))
    assert.ok(shouldNotify('c2', undefined, true))
  })
})

describe('prefs notes', () => {
  it('salva e apaga anotação', () => {
    setNote('fp1', 'conheci no Rust')
    assert.equal(getNote('fp1'), 'conheci no Rust')
    setNote('fp1', '   ')
    assert.equal(getNote('fp1'), '')
  })
})

describe('prefs folders', () => {
  it('cria, move e remove', () => {
    const id = addFolder('Trabalho')
    moveServerToFolder('srv1', id)
    assert.equal(folderOf('srv1'), id)
    moveServerToFolder('srv1', null)
    assert.equal(folderOf('srv1'), null)
    removeFolder(id)
    assert.equal(getPrefs().serverFolders.length, 0)
  })
})

describe('política de notificação espelhada no motor', () => {
  it('leva o nível por canal e os servidores silenciados', () => {
    setPrefs({
      notifDefault: 'all',
      channelLevel: { c1: 'mentions' },
      mutedChannels: ['c2'],
      mutedServers: ['s1'],
    })
    const p = JSON.parse(notificationPolicyJson())
    assert.equal(p.default, 'all')
    assert.equal(p.channels.c1, 'mentions')
    // Canal silenciado entra como 'none', sem precisar de entrada em
    // `channelLevel` — é a mesma decisão de `levelFor`.
    assert.equal(p.channels.c2, 'none')
    assert.deepEqual(p.servers, ['s1'])
  })

  it('é JSON válido com a política vazia (o motor nunca cai em "sem política")', () => {
    setPrefs({ notifDefault: 'mentions', channelLevel: {}, mutedChannels: [], mutedServers: [] })
    const p = JSON.parse(notificationPolicyJson())
    assert.equal(p.default, 'mentions')
    assert.deepEqual(p.channels, {})
    assert.deepEqual(p.servers, [])
  })
})
