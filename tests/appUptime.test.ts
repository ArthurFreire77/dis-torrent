import test from 'node:test'
import assert from 'node:assert/strict'
import {
  QUIT_LOCK_MS,
  canQuitNow,
  formatQuitLock,
  quitLockRemaining,
  resolveSessionStart,
} from '../src/services/appUptime.ts'

const T0 = 1_700_000_000_000

test('encerrar fica bloqueado nos primeiros 15 minutos', () => {
  assert.equal(QUIT_LOCK_MS, 15 * 60 * 1000)
  assert.equal(canQuitNow(T0, T0), false)
  assert.equal(canQuitNow(T0 + 60_000, T0), false)
  assert.equal(canQuitNow(T0 + 14 * 60_000, T0), false)
})

test('aos 15 minutos libera e não volta a bloquear', () => {
  assert.equal(canQuitNow(T0 + QUIT_LOCK_MS, T0), true)
  assert.equal(canQuitNow(T0 + QUIT_LOCK_MS + 1, T0), true)
  assert.equal(canQuitNow(T0 + 10 * QUIT_LOCK_MS, T0), true)
})

test('remaining nunca é negativo', () => {
  assert.equal(quitLockRemaining(T0, T0), QUIT_LOCK_MS)
  assert.equal(quitLockRemaining(T0 + QUIT_LOCK_MS, T0), 0)
  assert.equal(quitLockRemaining(T0 + 10 * QUIT_LOCK_MS, T0), 0)
})

test('texto do bloqueio é legível e honesto', () => {
  assert.equal(formatQuitLock(0), '0s')
  assert.equal(formatQuitLock(45_000), '45s')
  assert.equal(formatQuitLock(12 * 60_000 + 34_000), '12m 34s')
  assert.equal(formatQuitLock(QUIT_LOCK_MS), '15m 00s')
  // Arredonda para CIMA: nunca mostra "0s" com bloqueio pendente.
  assert.equal(formatQuitLock(1), '1s')
  assert.equal(formatQuitLock(-500), '0s')
})

/** Storage falso mínimo (sem DOM). */
function fakeStorage(initial: Record<string, string> = {}): Storage & { dump: () => Record<string, string> } {
  const map = new Map(Object.entries(initial))
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, v) },
    dump: () => Object.fromEntries(map),
  }
}

test('sem storage: usa o instante recebido', () => {
  assert.equal(resolveSessionStart(T0, null), T0)
})

test('primeira vez grava a marca de início', () => {
  const s = fakeStorage()
  assert.equal(resolveSessionStart(T0, s), T0)
  assert.equal(s.getItem('distorrent:app:started_at'), String(T0))
})

test('marca existente é respeitada (janela não reinicia a cada render)', () => {
  const s = fakeStorage({ 'distorrent:app:started_at': String(T0) })
  assert.equal(resolveSessionStart(T0 + 5 * 60_000, s), T0)
})

test('marca no futuro (relógio mudou) recomeça daqui', () => {
  const s = fakeStorage({ 'distorrent:app:started_at': String(T0 + 60_000) })
  assert.equal(resolveSessionStart(T0, s), T0)
})

test('marca inválida recomeça daqui', () => {
  const s = fakeStorage({ 'distorrent:app:started_at': 'lixo' })
  assert.equal(resolveSessionStart(T0, s), T0)
})

test('storage que lança não derruba o boot', () => {
  const boom = {
    getItem: () => { throw new Error('bloqueado') },
    setItem: () => { throw new Error('bloqueado') },
  } as unknown as Storage
  assert.equal(resolveSessionStart(T0, boom), T0)
})
