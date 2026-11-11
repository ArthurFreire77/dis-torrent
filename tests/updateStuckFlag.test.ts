import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  runUpdateFlow,
  falhaExpirada,
  FAILED_TTL_MS,
  FLAG_APPLIED,
  FLAG_FAILED,
  FLAG_SKIP,
  type UpdateDeps,
  type UpdateInfo,
} from '../src/services/updateRules.ts'

const rules = readFileSync('src/services/updateRules.ts', 'utf8')

function info(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: '1.1.44-pre-alpha',
    latest: '1.1.45-pre-alpha',
    asset_name: 'DisTorrent_1.1.45-pre-alpha_x64_setup.exe',
    asset_size: 9_500_000,
    download_url: 'https://github.com/ArthurFreire77/dis-torrent/releases/download/v1.1.45/x.exe',
    digest: 'sha256:abc',
    notes: '',
    html_url: '',
    platform: 'windows',
    ...over,
  }
}

function depsCom(flags: Record<string, string>, opts: { falhaApply?: boolean } = {}) {
  const estado = { ...flags }
  const usadas: string[] = []
  const d: UpdateDeps = {
    check: async () => info(),
    download: async () => 'C:\\tmp\\setup.exe',
    apply: async () => { if (opts.falhaApply) throw new Error('instalador recusou') },
    quit: async () => {},
    getFlag: async (k) => estado[k] ?? null,
    setFlag: async (k, v) => { estado[k] = v; usadas.push(`${k}=${v}`) },
  }
  return { deps: d, estado, usadas }
}

test('marca de versão JÁ instalada é lixo: não pode travar o update novo', () => {
  const { deps, estado } = depsCom({ [FLAG_APPLIED]: '1.1.44-pre-alpha' }, { falhaApply: false })
  return runUpdateFlow(deps, { autoApply: true }).then((r) => {
    assert.notEqual(r.kind, 'stalled', 'não pode dizer "já instalei" com versão MAIS NOVA publicada')
    assert.equal(r.kind, 'applied', 'segue o fluxo normal e instala')
    assert.equal(estado[FLAG_APPLIED], '1.1.45-pre-alpha', 'marca passa a ser a versão que está entrando')
  })
})

test('stalled continua valendo quando a marca está À FRENTE do que roda', () => {
  const { deps } = depsCom({ [FLAG_APPLIED]: '1.1.45-pre-alpha' })
  return runUpdateFlow(deps, { autoApply: true }).then((r) => {
    assert.equal(r.kind, 'stalled')
  })
})

test('marca de OUTRA versão não bloqueia a oferecida', () => {
  const { deps } = depsCom({ [FLAG_APPLIED]: '1.1.40-pre-alpha' })
  return runUpdateFlow(deps, { autoApply: true }).then((r) => {
    assert.equal(r.kind, 'applied')
  })
})

test('falha de update EXPIRA (não é para sempre)', () => {
  assert.equal(falhaExpirada(null), true)
  assert.equal(falhaExpirada('1.1.45-pre-alpha'), true, 'marca no formato antigo já conta como expirada')
  const agora = Date.now()
  assert.equal(falhaExpirada(`1.1.45-pre-alpha|${agora}`), false, 'recém-falhada: respeita')
  assert.equal(falhaExpirada(`1.1.45-pre-alpha|${agora - FAILED_TTL_MS - 1}`), true, 'passou do prazo: tenta de novo')
})

test('falha recente não reinstala em loop; passada do prazo, tenta', () => {
  const recente = depsCom({ [FLAG_FAILED]: `1.1.45-pre-alpha|${Date.now()}` })
  return runUpdateFlow(recente.deps, { autoApply: true }).then(async (r) => {
    assert.equal(r.kind, 'later', 'dentro do prazo: não insiste')
    const velha = depsCom({ [FLAG_FAILED]: `1.1.45-pre-alpha|${Date.now() - FAILED_TTL_MS - 1}` })
    const r2 = await runUpdateFlow(velha.deps, { autoApply: true })
    assert.equal(r2.kind, 'applied', 'depois do prazo: tenta de novo')
  })
})

test('a falha é gravada com instante (senão nunca expira)', () => {
  const { deps, estado } = depsCom({}, { falhaApply: true })
  return runUpdateFlow(deps, { autoApply: true }).then((r) => {
    assert.equal(r.kind, 'error')
    assert.match(estado[FLAG_FAILED] ?? '', /\|/, 'formato versao|instante')
  })
})

test('versão pulada pelo usuário continua respeitada', () => {
  const { deps } = depsCom({ [FLAG_SKIP]: '1.1.45-pre-alpha' })
  return runUpdateFlow(deps, { autoApply: true }).then((r) => {
    assert.equal(r.kind, 'none')
  })
})

test('o código limpa a marca quando a versão rodando já é a marcada', () => {
  assert.match(rules, /compareVersions\(info\.current, appliedFlag\) >= 0/)
  assert.match(rules, /setFlag\(FLAG_APPLIED, ''\)/)
})

test('qualquer versão antiga recebe a nova (varredura das releases reais)', async () => {
  const antigas = [
    '1.1.30-pre-alpha', '1.1.31-pre-alpha', '1.1.34-pre-alpha', '1.1.35-pre-alpha',
    '1.1.36-pre-alpha', '1.1.38-pre-alpha', '1.1.39-pre-alpha', '1.1.40-pre-alpha',
    '1.1.42-pre-alpha', '1.1.43-pre-alpha', '1.1.44-pre-alpha',
  ]
  for (const current of antigas) {
    const { deps, estado } = depsCom({ [FLAG_APPLIED]: current })
    const r = await runUpdateFlow(deps, { autoApply: true })
    assert.equal(
      r.kind,
      'applied',
      `${current} ficou preso (${r.kind}) em vez de instalar a 1.1.45`,
    )
    assert.equal(estado[FLAG_APPLIED], '1.1.45-pre-alpha')
  }
})

test('quem nunca atualizou (kv vazio) recebe a nova', async () => {
  const { deps } = depsCom({})
  const r = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(r.kind, 'applied')
})

test('quem está na versão mais nova não baixa nada', async () => {
  const { deps } = depsCom({ [FLAG_APPLIED]: '1.1.45-pre-alpha' })
  const d: UpdateDeps = { ...deps, check: async () => info({ current: '1.1.45-pre-alpha' }) }
  const r = await runUpdateFlow(d, { autoApply: true })
  assert.equal(r.kind, 'none')
})

test('quem pulou de propósito continua respeitado (não força)', async () => {
  const { deps } = depsCom({ [FLAG_SKIP]: '1.1.45-pre-alpha' })
  const r = await runUpdateFlow(deps, { autoApply: true })
  assert.equal(r.kind, 'none', 'skip é escolha do usuário, não bug')
})

test('o instalador do Windows NÃO pode receber /NORESTART', () => {
  const rust = [
    readFileSync('src-tauri/src/updater.rs', 'utf8'),
    ...readdirSync('src-tauri/src')
      .filter((f) => f.startsWith('updater_') && f.endsWith('.rs'))
      .map((f) => readFileSync(`src-tauri/src/${f}`, 'utf8')),
  ].join('\n')
  const ini = rust.indexOf('"/SILENT"')
  assert.ok(ini > 0, 'achou a lista de argumentos do instalador')
  const bloco = rust.slice(ini, ini + 300)
  assert.doesNotMatch(bloco, /NORESTART/, 'sem /NORESTART na atualização automática')
  assert.match(bloco, /CLOSEAPPLICATIONS/, 'o app precisa ser fechado para o exe ser substituído')
})

test('o reinício tem UM dono: o [Code] do instalador', () => {
  const apply = readFileSync('src-tauri/src/updater_apply.rs', 'utf8')
  assert.doesNotMatch(
    apply,
    /RESTARTAPPLICATIONS/,
    'o /RESTARTAPPLICATIONS brigava com RestartApplications=no e com o [Code]',
  )
  const iss = readFileSync('installer/distorent.iss', 'utf8')
  assert.match(iss, /RestartApplications=no/, 'quem reabre é o [Code], não o Restart Manager')
  assert.match(iss, /ReiniciarAppSilencioso/, 'o [Code] reabre esperando o mutex sumir')
})

test('o instalador .iss reabre o app no modo silencioso', () => {
  const iss = readFileSync('installer/distorent.iss', 'utf8')
  assert.match(iss, /ReiniciarAppSilencioso/, 'o [Code] é quem reabre')
  assert.match(iss, /WizardSilent|Silent/i, 'só no modo silencioso (o manual usa [Run])')
})
