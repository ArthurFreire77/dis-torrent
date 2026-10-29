import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDiagReport } from '../src/services/connectionDiagnostics.ts'

const reportInput = {
  version: '1.1.7-pre-alpha',
  fp: 'fingerprint-local-1234567890',
  nickname: 'Lucas',
  state: 'CONNECTING' as const,
  onlinePeers: 0,
  listenPort: 51413,
  peers: [{
    fp: 'f2dbd8491229',
    pubkey_hex: '',
    nickname: 'Teste',
    addr: '170.254.152.96:52559',
    last_seen: 0,
    origin: 'test',
    state: 'CONNECTING' as const,
    last_direct_error: 'connect timeout 170.254.152.96:52559',
    direct_attempts: 6,
  }],
  legs: [{ name: 'broker.emqx.io:1883', ok: true, latency_ms: 20, last_error: null }],
  legsError: null,
  netDiag: {
    stun_ok: true,
    stun_addr: '179.68.2.70:5257',
    stun_ms: 10,
    announce_addr: '170.254.152.96:52559',
    announce_ms: 5,
    nat_source: 'stun',
    dht_ok: null,
    dht_ms: 0,
  },
  kind: 'normal',
}

test('relatório oculta por padrão IPs, fingerprints, apelidos, portas e brokers', () => {
  const report = buildDiagReport({ ...reportInput, redactSensitive: true })

  for (const sensitive of [
    'fingerprint-local-1234567890',
    'f2dbd8491229',
    'Lucas',
    'Teste',
    '170.254.152.96',
    '179.68.2.70',
    '51413',
    '52559',
    'broker.emqx.io',
  ]) {
    assert.equal(report.includes(sensitive), false, `${sensitive} precisa ficar oculto`)
  }
  assert.match(report, /DHT BitTorrent: não informado/)
  assert.match(report, /broker alcançável não comprova/)
})

test('relatório detalhado só inclui identificadores quando a pessoa desmarca a ocultação', () => {
  const report = buildDiagReport({ ...reportInput, redactSensitive: false })
  assert.match(report, /179\.68\.2\.70:5257/)
  assert.match(report, /broker\.emqx\.io:1883/)
  assert.match(report, /fingerprint-local-1234567890/)
})
