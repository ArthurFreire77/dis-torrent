// Atualização automática: comparação de versão e fluxo (sem rede).
//
// REGRESSÃO QUE ESTES TESTES TRAVAM: comparar `1.1.10` com `1.1.9` como string
// dá "1.1.10 < 1.1.9", e o app passa a oferecer uma atualização que ele já tem
// — o pior sintoma possível para um updater (loop de download) e o mais fácil
// de introduzir sem perceber.
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

test('pre-release e a MESMA versao da base (igual ao Rust, sem loop)', () => {
  // O projeto publica sempre como -pre-alpha: se pré-release fosse "menor",
  // o app nunca se atualizaria.
  assert.equal(isNewer('1.1.10', '1.1.11-pre-alpha'), true)
  // MAS: a tag é limpa (`v1.1.23`) e o app reporta `1.1.23-pre-alpha`. Se o
  // sufixo contasse, quem já atualizou baixaria o mesmo instalador de novo
  // (bug real: `stalled` a cada boot). Rust e TS precisam dar o mesmo resultado.
  assert.equal(isNewer('1.2.0-pre-alpha', '1.2.0'), false)
  assert.equal(isNewer('1.2.0', '1.2.0-pre-alpha'), false)
  assert.equal(compareVersions('1.1.23-pre-alpha', '1.1.23'), 0)
})

test('versionamento futuro: alpha < pre-alpha? não — pre-alpha é o mais inicial', () => {
  // Ordem dos rótulos: pre-alpha < alpha < beta < rc. Quem está em pre-alpha
  // recebe o alpha da MESMA base, e alpha recebe beta.
  assert.equal(isNewer('1.2.1-pre-alpha', '1.2.1-alpha'), true)
  assert.equal(isNewer('1.2.1-alpha', '1.2.1-beta'), true)
  assert.equal(isNewer('1.2.1-beta', '1.2.1-rc'), true)
  // E o inverso nunca "atualiza para trás".
  assert.equal(isNewer('1.2.1-alpha', '1.2.1-pre-alpha'), false)
  assert.equal(isNewer('1.2.1-beta', '1.2.1-alpha'), false)
  // Uma versão final depois do rc é mais nova.
  assert.equal(compareVersions('1.2.1', '1.2.1-rc'), 0, 'tag limpa = mesma versão')
  assert.equal(isNewer('1.2.1-rc', '1.2.2'), true)
})

test('versionamento futuro: base nova sempre ganha do sufixo da base antiga', () => {
  // 1.2.1-alpha é mais nova que 1.2.0 final.
  assert.equal(isNewer('1.2.0', '1.2.1-pre-alpha'), true)
  assert.equal(isNewer('1.1.99-pre-alpha', '1.2.0-pre-alpha'), true)
  assert.equal(isNewer('1.2.0-pre-alpha', '1.10.0-pre-alpha'), true)
  // Número de build no sufixo é comparado como número: alpha.2 < alpha.10.
  assert.equal(isNewer('1.2.1-alpha.2', '1.2.1-alpha.10'), true)
  assert.equal(isNewer('1.2.1-alpha.10', '1.2.1-alpha.2'), false)
})

// A transição que esta release precisa fazer de verdade: quem está na 1.1.22
// tem de ver a 1.1.23. `latest` chega do Rust sem o `v` da tag.
test('quem esta na 1.1.22 enxerga a 1.1.23 publicada', () => {
  assert.equal(isNewer('1.1.22-pre-alpha', '1.1.23'), true)
  assert.equal(isNewer('1.1.22-pre-alpha', '1.1.23-pre-alpha'), true)
  assert.equal(isNewer('1.1.21-pre-alpha', '1.1.23'), true)
  // E quem ja atualizou nao recebe a mesma versao de novo (sem loop).
  assert.equal(isNewer('1.1.23-pre-alpha', '1.1.23'), false)
  assert.equal(isNewer('1.1.23', '1.1.23-pre-alpha'), false)
})

test('updateModeFor: windows instala sozinho, linux e android abrem instalador, resto link', () => {
  assert.equal(updateModeFor('windows'), 'auto')
  // Linux SEM nome de asset: não dá para saber o formato, então não promete auto.
  assert.equal(updateModeFor('linux'), 'manual')
  // AppImage é um arquivo só: o Rust substitui e reexecuta, então é automático.
  assert.equal(updateModeFor('linux', 'DisTorrent_1.1.23-pre-alpha_amd64.AppImage'), 'auto')
  // .deb depende de root/prompt do sistema: automático seria mentira.
  assert.equal(updateModeFor('linux', 'DisTorrent_1.1.23-pre-alpha_amd64.deb'), 'manual')
  // Android baixa o APK e abre o instalador do sistema (exige um toque do
  // usuário, mas é instalação de verdade — não é mais "só o link").
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
  // Antes o Android NUNCA se atualizava sozinho: o fluxo devolvia `later`
  // antes de baixar, então quem não tocasse no cartão ficava semanas numa
  // build antiga. Agora baixa e abre o instalador, igual ao Linux.
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
  assert.equal(flags.get(FLAG_APPLIED), '', 'falha no instalador desfaz a marca de "aplicado"')

  // Segunda abertura: não tenta de novo sozinho, mas ainda oferece manual.
  const second = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(second.kind, 'later')
})

test('versão já instalada que não mudou o app para de tentar (o loop da janela)', async () => {
  // REGRESSÃO QUE ESTE TESTE TRAVA: o app baixava, instalava, reabria, encontrava
  // a MESMA atualização pendente (porque o instalador publicado continha a
  // versão antiga) e repetia — a janela abrindo e fechando sem parar.
  const { deps, flags, calls } = fakeDeps()
  flags.set(FLAG_APPLIED, '1.1.10-pre-alpha')

  const out = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(out.kind, 'stalled', 'não baixa nem instala de novo')
  assert.deepEqual(calls, ['check'], 'só consultou; nenhum download')

  // Mesmo com autoApply desligado o estado é o mesmo: não é uma escolha do
  // usuário, é um fato (o instalador não entrega a versão anunciada).
  const manual = await runUpdateFlow(deps, { autoApply: false })
  assert.equal(manual.kind, 'stalled')
})

test('a marca de "aplicado" é gravada ANTES de executar o instalador', async () => {
  // O Inno encerra este processo; se a marca fosse escrita depois, o loop
  // voltaria na próxima abertura.
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
  // O freio é por VERSÃO: sair a 1.1.11 tem de funcionar normalmente.
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
