// Atualização automática: comparação de versão e fluxo (sem rede).
//
// REGRESSÃO QUE ESTES TESTES TRAVAM: comparar `1.1.10` com `1.1.9` como string
// dá "1.1.10 < 1.1.9", e o app passa a oferecer uma atualização que ele já tem
// — o pior sintoma possível para um updater (loop de download) e o mais fácil
// de introduzir sem perceber.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FLAG_FAILED,
  FLAG_SKIP,
  compareVersions,
  formatBytes,
  isNewer,
  parseVersion,
  runUpdateFlow,
  shortNotes,
  updateModeFor,
  type UpdateDeps,
  type UpdateInfo,
} from '../src/services/updateRules.ts'

function info(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: '1.1.9-pre-alpha',
    latest: '1.1.10-pre-alpha',
    asset_name: 'DisTorrent_1.1.10-pre-alpha_x64_setup.exe',
    asset_size: 9_337_131,
    download_url:
      'https://github.com/ArthurFreire77/dis-torrent/releases/download/v1.1.10/DisTorrent_1.1.10-pre-alpha_x64_setup.exe',
    digest: 'sha256:abc',
    notes: 'correções de voz\n- corrige roster',
    html_url: 'https://github.com/ArthurFreire77/dis-torrent/releases/tag/v1.1.10',
    platform: 'windows',
    ...over,
  }
}

/** Deps de mentira: nada de rede, nada de disco. */
function fakeDeps(over: Partial<UpdateDeps> = {}, infoValue = info()) {
  const flags = new Map<string, string>()
  const calls: string[] = []
  const deps: UpdateDeps = {
    check: async () => {
      calls.push('check')
      return infoValue
    },
    download: async () => {
      calls.push('download')
      return 'C:/tmp/DisTorrent_setup.exe'
    },
    apply: async () => {
      calls.push('apply')
    },
    quit: async () => {
      calls.push('quit')
    },
    getFlag: async (k) => flags.get(k) ?? null,
    setFlag: async (k, v) => {
      flags.set(k, v)
    },
    ...over,
  }
  return { deps, flags, calls }
}

test('parseVersion separa núcleo numérico de sufixo pré-release', () => {
  assert.deepEqual(parseVersion('1.1.10-pre-alpha').nums.slice(0, 3), [1, 1, 10])
  assert.equal(parseVersion('1.1.10-pre-alpha').pre, 'pre-alpha')
  assert.equal(parseVersion('v2.0').pre, '')
  assert.deepEqual(parseVersion('v2.0').nums, [2, 0])
})

test('1.1.10 é mais nova que 1.1.9 (o bug do compare por string)', () => {
  assert.equal(compareVersions('1.1.10-pre-alpha', '1.1.9-pre-alpha'), 1)
  assert.equal(compareVersions('1.1.9-pre-alpha', '1.1.10-pre-alpha'), -1)
  assert.equal(isNewer('1.1.9-pre-alpha', '1.1.10-pre-alpha'), true)
  assert.equal(isNewer('1.1.10-pre-alpha', '1.1.10-pre-alpha'), false)
})

test('pré-release mais nova que a base anterior, final mais nova que pré-release', () => {
  // O projeto publica sempre como -pre-alpha: se pré-release fosse "menor",
  // o app nunca se atualizaria.
  assert.equal(isNewer('1.1.10', '1.1.11-pre-alpha'), true)
  // Mas quando existir uma final da MESMA base, ela ganha.
  assert.equal(isNewer('1.2.0-pre-alpha', '1.2.0'), true)
  assert.equal(isNewer('1.2.0', '1.2.0-pre-alpha'), false)
})

test('updateModeFor: windows instala sozinho, linux e android abrem instalador, resto link', () => {
  assert.equal(updateModeFor('windows'), 'auto')
  assert.equal(updateModeFor('linux'), 'manual')
  // Android baixa o APK e abre o instalador do sistema (exige um toque do
  // usuário, mas é instalação de verdade — não é mais "só o link").
  assert.equal(updateModeFor('android'), 'manual')
  assert.equal(updateModeFor('outro'), 'link')
})

test('fluxo automático baixa e aplica quando há versão nova', async () => {
  const { deps, calls } = fakeDeps()
  const out = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(out.kind, 'applied')
  assert.deepEqual(calls, ['check', 'download', 'apply'])
})

test('sem versão nova não baixa nada', async () => {
  const { deps, calls } = fakeDeps({}, info({ current: '1.1.10-pre-alpha', latest: '1.1.10-pre-alpha' }))
  const out = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(out.kind, 'none')
  assert.deepEqual(calls, ['check'])
})

test('versão pulada pelo usuário não é oferecida de novo', async () => {
  const { deps, flags } = fakeDeps()
  flags.set(FLAG_SKIP, '1.1.10-pre-alpha')
  const out = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(out.kind, 'none')
})

test('android mostra o cartão sem baixar sozinho (o sistema exige um toque)', async () => {
  // Agora o Android SABE instalar (baixa o APK e abre o instalador), mas o
  // download de ~40 MB não acontece sem o usuário pedir.
  const { deps, calls } = fakeDeps({}, info({ platform: 'android', asset_name: 'a.apk' }))
  const out = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(out.kind, 'later')
  assert.deepEqual(calls, ['check'])
})

test('macOS não tem instalador para baixar: só o link', async () => {
  const { deps, calls } = fakeDeps({}, info({ platform: 'outro', asset_name: 'x.dmg' }))
  const out = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(out.kind, 'later')
  assert.deepEqual(calls, ['check'])
})

test('autoApply desligado devolve "later" sem baixar', async () => {
  const { deps, calls } = fakeDeps()
  const out = await runUpdateFlow(deps, { autoApply: false })
  assert.equal(out.kind, 'later')
  assert.deepEqual(calls, ['check'])
})

test('falha de rede na checagem é erro, não "tem update"', async () => {
  const { deps } = fakeDeps({
    check: async () => {
      throw new Error('sem conexão')
    },
  })
  const out = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(out.kind, 'error')
  assert.match((out as { message: string }).message, /sem conexão/)
})

test('instalador que falha é marcado para não reiniciar em loop', async () => {
  const { deps, flags } = fakeDeps({
    apply: async () => {
      throw new Error('instalador quebrado')
    },
  })
  const first = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(first.kind, 'error')
  assert.equal(flags.get(FLAG_FAILED), '1.1.10-pre-alpha')

  // Segunda abertura: não tenta de novo sozinho, mas ainda oferece manual.
  const second = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(second.kind, 'later')
})

test('formatBytes e shortNotes não mentem nem estouram a tela', () => {
  assert.equal(formatBytes(9_337_131), '8,9 MB')
  assert.equal(formatBytes(0), '?')
  assert.equal(formatBytes(2048), '2 KB')
  const notes = 'a\n\nb\nc\nd\ne\nf\ng\nh'
  assert.equal(shortNotes(notes, 3), 'a\nb\nc')
})
