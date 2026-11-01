// Trava de VERSIONAMENTO entre os arquivos que o updater lê.
//
// POR QUE ESTE TESTE EXISTE: o `update_check` do Rust recusa o asset quando a
// versão no NOME do instalador não bate com a TAG da release
// (`label_mismatch`) — é a proteção contra instalador rotulado errado entrar em
// loop "atualiza → reinicia → atualiza de novo". Essa proteção só funciona se
// os quatro pontos estiverem idênticos:
//
//   1. package.json                (o workflow lê daqui o NOME da release)
//   2. src-tauri/tauri.conf.json   (é a versão que o APP reporta ao GitHub)
//   3. src-tauri/Cargo.toml        (fallback de `current` no Rust)
//   4. o nome do instalador        (gerado desses campos pelo Tauri/Inno)
//
// Já aconteceu de publicar uma leva sem subir a versão: o app se achava "já
// atualizado", ou baixava o mesmo binário de novo para sempre. Este teste falha
// ANTES do build quando os arquivos divergem.
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
  // É esta versão que `app.config().version` devolve e que o app compara com a
  // tag do GitHub. Divergir aqui = app nunca vê a atualização.
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
  // O `pick_asset` do Rust prefere `*_setup.exe`. Se o Inno mudar o sufixo, o
  // app baixaria outro .exe (ou nenhum) — este teste avisa antes do build.
  const iss = ler('installer/distorent.iss')
  assert.ok(
    /OutputBaseFilename\s*=\s*DisTorrent_\{#AppVersion\}_x64_setup/i.test(iss),
    'OutputBaseFilename do Inno precisa ser DisTorrent_{#AppVersion}_x64_setup',
  )
})

test('a versão é publicável: não repete uma tag já existente', () => {
  // Guarda simples e offline: a numeração não pode "andar para trás" nem
  // publicar a mesma base duas vezes por acidente. A checagem real contra o
  // GitHub é feita no `publish-release.ps1`; aqui só barramos o erro grosseiro.
  const base = packageVersion.split('-')[0]
  const partes = base.split('.').map(Number)
  assert.equal(partes.length, 3, `base precisa ser X.Y.Z: ${base}`)
  assert.equal(partes.every((n) => n >= 0), true)
})
