import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { runUpdateFlow, FLAG_FAILED, FLAG_APPLIED, FLAG_HANDOFF, type UpdateDeps, type UpdateInfo } from '../src/services/updateRules.ts'

// O bug da 1.1.68: o manifesto assinado apontava as URLs para a tag
// `v1.1.68-pre-alpha`, mas a tag real é `v1.1.68`. O download dava 404, o app
// gravava `update.failed` e ficava 6h sem tentar — "não atualiza sozinho".

function info(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: '1.1.67-pre-alpha',
    latest: '1.1.68-pre-alpha',
    asset_name: 'DisTorrent_1.1.68-pre-alpha_x64_setup.exe',
    asset_size: 1024,
    download_url: 'https://github.com/ArthurFreire77/dis-torrent/releases/download/v1.1.68/x.exe',
    digest: 'sha256:abc',
    notes: '',
    html_url: '',
    platform: 'windows',
    verified: true,
    ...over,
  }
}

function deps(over: Partial<UpdateDeps> = {}): UpdateDeps & { flags: Map<string, string>; downloads: number } {
  const flags = new Map<string, string>()
  const state = {
    flags,
    downloads: 0,
    check: async () => info(),
    download: async () => {
      state.downloads++
      return 'C:/tmp/setup.exe'
    },
    apply: async () => {},
    quit: async () => {},
    getFlag: async (k: string) => flags.get(k) ?? null,
    setFlag: async (k: string, v: string) => {
      if (v === '') flags.delete(k)
      else flags.set(k, v)
    },
    ...over,
  }
  return state as UpdateDeps & { flags: Map<string, string>; downloads: number }
}

test('abrir o app é a tentativa de atualizar: falha anterior do boot não bloqueia', async () => {
  const d = deps()
  d.flags.set(FLAG_FAILED, `1.1.68-pre-alpha|${Date.now()}`)
  const r = await runUpdateFlow(d, { autoApply: true, boot: true })
  assert.equal(r.kind, 'applied', 'no boot tenta mesmo com falha da sessão anterior')
})

test('falha recente adia o download fora do boot (não martela o GitHub)', async () => {
  const d = deps()
  d.flags.set(FLAG_FAILED, `1.1.68-pre-alpha|${Date.now()}`)
  const r = await runUpdateFlow(d, { autoApply: true, boot: false })
  assert.equal(r.kind, 'later')
  assert.equal(d.downloads, 0, 'não baixou de novo')
})

test('falha vencida (6h) volta a tentar sem reiniciar o app', async () => {
  const d = deps()
  d.flags.set(FLAG_FAILED, `1.1.68-pre-alpha|${Date.now() - 7 * 60 * 60 * 1000}`)
  const r = await runUpdateFlow(d, { autoApply: true, boot: false })
  assert.equal(r.kind, 'applied')
})

test('erro de download marca falha e não aplica nada', async () => {
  const d = deps({ download: async () => { throw new Error('download recusado pelo GitHub (404)') } })
  const r = await runUpdateFlow(d, { autoApply: true, boot: false })
  assert.equal(r.kind, 'error')
  assert.match((r as { message: string }).message, /404/)
  assert.ok(d.flags.get(FLAG_FAILED)?.startsWith('1.1.68-pre-alpha|'), 'falha registrada com carimbo')
  assert.equal(d.flags.get(FLAG_APPLIED), undefined, 'não marca aplicado quando falhou')
})

test('versão igual não baixa nada (sem loop de update)', async () => {
  const d = deps({ check: async () => info({ current: '1.1.68-pre-alpha', latest: '1.1.68-pre-alpha' }) })
  const r = await runUpdateFlow(d, { autoApply: true, boot: true })
  assert.equal(r.kind, 'none')
  assert.equal(d.downloads, 0)
})

test('versão mais nova é detectada pelo núcleo, não pela string', async () => {
  const d = deps({ check: async () => info({ current: '1.1.9', latest: '1.1.68-pre-alpha' }) })
  const r = await runUpdateFlow(d, { autoApply: true, boot: true })
  assert.equal(r.kind, 'applied', '1.1.68 > 1.1.9 por número, não por texto')
})

test('salto aplicado e versão ainda antiga = stalled (instalador não subiu)', async () => {
  const d = deps()
  d.flags.set(FLAG_APPLIED, '1.1.68-pre-alpha')
  const r = await runUpdateFlow(d, { autoApply: true, boot: true })
  assert.equal(r.kind, 'stalled')
})

test('instalador já aberto NÃO é reaberto no boot seguinte (loop infinito)', async () => {
  const d = deps()
  d.flags.set(FLAG_HANDOFF, `1.1.68-pre-alpha|${Date.now() - 60_000}`)
  const r = await runUpdateFlow(d, { autoApply: true, boot: true })
  assert.equal(r.kind, 'handoff', 'o app reabriu antes do Inno terminar')
  assert.equal(d.downloads, 0, 'baixar de novo alimentava o loop')
})

test('handoff vencido volta a permitir a atualização', async () => {
  const d = deps()
  d.flags.set(FLAG_HANDOFF, `1.1.68-pre-alpha|${Date.now() - 11 * 60 * 1000}`)
  const r = await runUpdateFlow(d, { autoApply: true, boot: true })
  assert.equal(r.kind, 'applied')
})

test('versão nova depois de um handoff antigo não fica presa', async () => {
  const d = deps()
  d.flags.set(FLAG_HANDOFF, `1.1.67-pre-alpha|${Date.now() - 60_000}`)
  const r = await runUpdateFlow(d, { autoApply: true, boot: true })
  assert.equal(r.kind, 'applied')
})

// --- fio: o manifesto publicado precisa usar a tag real ---------------------

const updaterSrc = readFileSync(new URL('../src-tauri/src/updater.rs', import.meta.url), 'utf8')
const versionSrc = readFileSync(new URL('../src-tauri/src/updater_version.rs', import.meta.url), 'utf8')

test('a URL do instalador é validada, mas o caminho da tag não pode passar em branco', () => {
  assert.match(updaterSrc, /fn url_allowed/, 'existe validação de host')
  assert.match(updaterSrc, /releases\/download\//, 'exige o caminho de release')
  // A URL da 1.1.68 apontava para uma tag que não existe e a validação deixou
  // passar (só checa host+caminho). O download é que descobria o 404.
  assert.match(versionSrc, /mesma_versao/, 'manifesto e tag são comparados pelo núcleo')
})

test('o carimbo de falha inclui a versão (não bloqueia a próxima release)', () => {
  const d = deps()
  void d
  assert.match(
    readFileSync(new URL('../src/services/updateRules.ts', import.meta.url), 'utf8'),
    /FLAG_FAILED, `\$\{info\.latest\}\|\$\{Date\.now\(\)\}`/,
    'falha de uma versão não pode impedir a seguinte',
  )
})
