import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FLAG_APPLIED,
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

test('pre-release e a MESMA versao da base (igual ao Rust, sem loop)', () => {
  assert.equal(isNewer('1.1.10', '1.1.11-pre-alpha'), true)
  assert.equal(isNewer('1.2.0-pre-alpha', '1.2.0'), false)
  assert.equal(isNewer('1.2.0', '1.2.0-pre-alpha'), false)
  assert.equal(compareVersions('1.1.23-pre-alpha', '1.1.23'), 0)
})

test('versionamento futuro: alpha < pre-alpha? não — pre-alpha é o mais inicial', () => {
  assert.equal(isNewer('1.2.1-pre-alpha', '1.2.1-alpha'), true)
  assert.equal(isNewer('1.2.1-alpha', '1.2.1-beta'), true)
  assert.equal(isNewer('1.2.1-beta', '1.2.1-rc'), true)
  assert.equal(isNewer('1.2.1-alpha', '1.2.1-pre-alpha'), false)
  assert.equal(isNewer('1.2.1-beta', '1.2.1-alpha'), false)
  assert.equal(compareVersions('1.2.1', '1.2.1-rc'), 0, 'tag limpa = mesma versão')
  assert.equal(isNewer('1.2.1-rc', '1.2.2'), true)
})

test('versionamento futuro: base nova sempre ganha do sufixo da base antiga', () => {
  assert.equal(isNewer('1.2.0', '1.2.1-pre-alpha'), true)
  assert.equal(isNewer('1.1.99-pre-alpha', '1.2.0-pre-alpha'), true)
  assert.equal(isNewer('1.2.0-pre-alpha', '1.10.0-pre-alpha'), true)
  assert.equal(isNewer('1.2.1-alpha.2', '1.2.1-alpha.10'), true)
  assert.equal(isNewer('1.2.1-alpha.10', '1.2.1-alpha.2'), false)
})

test('quem esta na 1.1.22 enxerga a 1.1.23 publicada', () => {
  assert.equal(isNewer('1.1.22-pre-alpha', '1.1.23'), true)
  assert.equal(isNewer('1.1.22-pre-alpha', '1.1.23-pre-alpha'), true)
  assert.equal(isNewer('1.1.21-pre-alpha', '1.1.23'), true)
  assert.equal(isNewer('1.1.23-pre-alpha', '1.1.23'), false)
  assert.equal(isNewer('1.1.23', '1.1.23-pre-alpha'), false)
})

test('updateModeFor: windows instala sozinho, linux e android abrem instalador, resto link', () => {
  assert.equal(updateModeFor('windows'), 'auto')
  assert.equal(updateModeFor('linux'), 'manual')
  assert.equal(updateModeFor('linux', 'DisTorrent_1.1.23-pre-alpha_amd64.AppImage'), 'auto')
  assert.equal(updateModeFor('linux', 'DisTorrent_1.1.23-pre-alpha_amd64.deb'), 'manual')
  assert.equal(updateModeFor('android', 'DisTorrent_1.1.23-pre-alpha_arm64.apk'), 'manual')
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

test('android baixa o APK e abre o instalador (atualização automática de verdade)', async () => {
  const { deps, calls } = fakeDeps({}, info({ platform: 'android', asset_name: 'a.apk' }))
  const out = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(out.kind, 'applied')
  assert.deepEqual(calls, ['check', 'download', 'apply'])
})

test('android com "atualizar sozinho" desligado: só o cartão', async () => {
  const { deps, calls } = fakeDeps({}, info({ platform: 'android', asset_name: 'a.apk' }))
  const out = await runUpdateFlow(deps, { autoApply: false })
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
  // Seção 1: out
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
  assert.match(flags.get(FLAG_FAILED) ?? '', /^1\.1\.10-pre-alpha\|\d+$/)
  assert.equal(flags.get(FLAG_APPLIED), '', 'falha no instalador desfaz a marca de "aplicado"')

  const second = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(second.kind, 'later')
})

test('versão já instalada que não mudou o app para de tentar (o loop da janela)', async () => {
  const { deps, flags, calls } = fakeDeps()
  flags.set(FLAG_APPLIED, '1.1.10-pre-alpha')

  const out = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(out.kind, 'stalled', 'não baixa nem instala de novo')
  assert.deepEqual(calls, ['check'], 'só consultou; nenhum download')

  const manual = await runUpdateFlow(deps, { autoApply: false })
  assert.equal(manual.kind, 'stalled')
})

test('a marca de "aplicado" é gravada ANTES de executar o instalador', async () => {
  let marcadoQuandoAplicou: string | null = null
  const { deps, flags } = fakeDeps({
    apply: async () => {
      marcadoQuandoAplicou = flags.get(FLAG_APPLIED) ?? null
    },
  })
  const out = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(out.kind, 'applied')
  assert.equal(marcadoQuandoAplicou, '1.1.10-pre-alpha')
})

test('versão nova depois de uma instalada volta a ser oferecida', async () => {
  const { deps, flags, calls } = fakeDeps({}, info({ latest: '1.1.11-pre-alpha' }))
  flags.set(FLAG_APPLIED, '1.1.10-pre-alpha')
  const out = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(out.kind, 'applied')
  assert.ok(calls.includes('download'))
})

test('formatBytes e shortNotes não mentem nem estouram a tela', () => {
  assert.equal(formatBytes(9_337_131), '8,9 MB')
  assert.equal(formatBytes(0), '?')
  assert.equal(formatBytes(2048), '2 KB')
  const notes = 'a\n\nb\nc\nd\ne\nf\ng\nh'
  assert.equal(shortNotes(notes, 3), 'a\nb\nc')
})
