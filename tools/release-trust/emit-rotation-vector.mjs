// Gera tests/fixtures/rotation_vector.json para o teste Rust
// `rotation_interop.rs`. Usa chaves de TESTE determinísticas (sem segredo
// versionado: as seeds só existem neste script, marcadas com secret-scan: allow,
// e servem apenas para produzir o vetor).
//
// Uso: node tools/release-trust/emit-rotation-vector.mjs
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const aqui = dirname(fileURLToPath(import.meta.url))
const raiz = resolve(aqui, '../..')
const dir = mkdtempSync(join(tmpdir(), 'dt-rotvec-'))

try {
  // secret-scan: allow (sementes de teste, nunca usadas em release)
  const seeds = ['33'.repeat(32), '44'.repeat(32), '55'.repeat(32)]
  const cer = join(dir, 'cur')
  execFileSync(
    process.execPath,
    [resolve(aqui, 'ceremony.mjs'), '--init', '--dir', cer, '--keys', '3', '--epoch', '1'],
    { encoding: 'utf8', stdio: 'pipe' },
  )
  const trustFile = join(cer, 'trust-set.txt')
  const currentTrust = readFileSync(trustFile, 'utf8').trim()

  // Conjunto novo: mantém a chave 1 (continuidade) e troca as outras duas.
  const new1 = join(dir, 'new1.key')
  const new2 = join(dir, 'new2.key')
  writeFileSync(new1, seeds[1] + '\n')
  writeFileSync(new2, '66'.repeat(32) + '\n')

  const out = join(dir, 'rotation.txt')
  execFileSync(
    process.execPath,
    [
      resolve(aqui, 'rotate-keys.mjs'),
      '--from', trustFile,
      '--key', join(cer, 'signer-1.key'),
      '--key', join(cer, 'signer-2.key'),
      '--new-key', join(cer, 'signer-1.key'),
      '--new-key', new2,
      '--threshold', '2',
      '--epoch', '2',
      '--reason', 'rotacao de teste do vetor',
      '--out', out,
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  )

  const texto = readFileSync(out, 'utf8')
  const payload = /^payload_hex=(.*)$/m.exec(texto)?.[1]
  const sigs = /^signatures_hex=(.*)$/m.exec(texto)?.[1]
  if (!payload || !sigs) throw new Error('arquivo de rotação sem payload/assinaturas')

  // O formato que `update_trust_apply` recebe: payload || bloco de assinaturas.
  const wireHex = payload + sigs

  const destino = resolve(raiz, 'distorrent-core/tests/fixtures/rotation_vector.json')
  mkdirSync(dirname(destino), { recursive: true })
  writeFileSync(
    destino,
    JSON.stringify(
      {
        aviso: 'vetor de teste da rotação; só chaves públicas e assinaturas',
        current_trust_set: currentTrust,
        new_epoch: 2,
        wire_hex: wireHex,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`vetor de rotação: ${destino}`)
  console.log(`wire: ${wireHex.length / 2} bytes`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
