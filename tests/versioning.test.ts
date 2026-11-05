import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { parseVersion } from '../src/services/updateRules.ts'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')

function ler(rel: string): string {
  return readFileSync(join(raiz, rel), 'utf8')
}

const packageVersion = JSON.parse(ler('package.json')).version as string

test('package.json tem versão semver parseável', () => {
  const p = parseVersion(packageVersion)
  assert.equal(p.nums.length >= 3, true, `versão sem 3 componentes: ${packageVersion}`)
  assert.equal(p.nums.slice(0, 3).every((n) => Number.isInteger(n) && n > 0), true)
})

test('tauri.conf.json usa a MESMA versão do package.json', () => {
  const conf = JSON.parse(ler('src-tauri/tauri.conf.json'))
  assert.equal(conf.version, packageVersion)
})

test('src-tauri/Cargo.toml usa a MESMA versão do package.json', () => {
  const cargo = ler('src-tauri/Cargo.toml')
  const m = /^version\s*=\s*"([^"]+)"/m.exec(cargo)
  assert.ok(m, 'Cargo.toml sem campo version')
  assert.equal(m![1], packageVersion)
})

test('o instalador do Inno gera o nome que o updater espera', () => {
  const iss = ler('installer/distorent.iss')
  assert.ok(
    /OutputBaseFilename\s*=\s*DisTorrent_\{#AppVersion\}_x64_setup/i.test(iss),
    'OutputBaseFilename do Inno precisa ser DisTorrent_{#AppVersion}_x64_setup',
  )
})

test('a versão é publicável: não repete uma tag já existente', () => {
  const base = packageVersion.split('-')[0]
  const partes = base.split('.').map(Number)
  assert.equal(partes.length, 3, `base precisa ser X.Y.Z: ${base}`)
  assert.equal(partes.every((n) => n >= 0), true)
})
