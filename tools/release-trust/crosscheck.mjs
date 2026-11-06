// Prova de compatibilidade binária entre o Rust e o tooling Node.
//
// 1. Os bytes canônicos que o Node gera são idênticos aos do Rust (vetor fixo).
// 2. O verificador INDEPENDENTE (decoder próprio) aceita o manifesto que o
//    Rust assinou.
// 3. Adulterar 1 campo derruba a verificação.
//
// Uso: node tools/release-trust/crosscheck.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  canonicalBodyBytes,
  manifestHashHex,
  keyIdFromPubkey,
  parseTrustSet,
  verifyBytes,
  hexToBytes,
  bytesToHex,
} from './lib.mjs'

const aqui = dirname(fileURLToPath(import.meta.url))
const vetor = JSON.parse(
  readFileSync(resolve(aqui, '../../distorrent-core/tests/fixtures/release_vector.json'), 'utf8'),
)

// Mesmo conteúdo do `body()` em distorrent-core/tests/release_vector.rs.
const body = {
  schema: 1,
  project: 'distorrent',
  version: '1.2.3',
  channel: 'stable',
  tag: 'v1.2.3',
  commit: '0123456789abcdef0123456789abcdef01234567',
  published_at_ms: 1_700_000_000_000,
  protocol_version: 5,
  min_protocol_version: 4,
  security_epoch: 7,
  min_security_epoch: 3,
  revoked_versions: ['1.0.0', '1.1.0'],
  revoked_key_ids: [],
  assets: [
    ['DisTorrent_1.2.3_arm64.apk', 'android', 'aarch64'],
    ['DisTorrent_1.2.3_amd64.AppImage', 'linux', 'x86_64'],
    ['DisTorrent_1.2.3_x64_setup.exe', 'windows', 'x86_64'],
  ].map(([name, os, arch]) => ({
    name,
    os,
    arch,
    size: 1234567,
    sha256: '3f'.repeat(32),
    url: `https://github.com/ArthurFreire77/dis-torrent/releases/download/v1.2.3/${name}`,
  })),
}

let falhas = 0
function check(nome, ok, detalhe = '') {
  if (ok) console.log(`PASS  ${nome}`)
  else {
    console.log(`FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ''}`)
    falhas++
  }
}

check(
  'bytes canônicos Node == Rust',
  bytesToHex(canonicalBodyBytes(body)) === vetor.canonical_hex,
)
check('manifest_hash Node == Rust', manifestHashHex(body) === vetor.manifest_hash)
check(
  'key_id deriva igual ao Rust',
  keyIdFromPubkey(hexToBytes(vetor.pubkey_1, 32)) ===
    parseTrustSet(vetor.trust_set).keys.find((k) => k.pubkeyHex === vetor.pubkey_1)?.keyId,
  `${keyIdFromPubkey(hexToBytes(vetor.pubkey_1, 32))} vs ${parseTrustSet(vetor.trust_set).keys.find((k) => k.pubkeyHex === vetor.pubkey_1)?.keyId}`,
)

// As assinaturas que o Rust produziu verificam com o BLAKE3 do payload.
const trust = parseTrustSet(vetor.trust_set)
check('trust set do vetor tem 2 chaves', trust.keys.length === 2)

const dir = mkdtempSync(join(tmpdir(), 'dt-crosscheck-'))
try {
  const manifestPath = join(dir, 'distorrent-manifest.bin')
  const trustPath = join(dir, 'trust-set.txt')
  writeFileSync(manifestPath, hexToBytes(vetor.wire_hex))
  writeFileSync(trustPath, vetor.trust_set + '\n')

  let saida = ''
  let ok = true
  try {
    saida = execFileSync(
      process.execPath,
      [resolve(aqui, 'verify-release.mjs'), '--manifest', manifestPath, '--trust', trustPath],
      { encoding: 'utf8' },
    )
  } catch (e) {
    ok = false
    saida = String(e.stdout ?? '') + String(e.stderr ?? '')
  }
  check('verificador independente aceita o manifesto do Rust', ok, saida.trim().slice(0, 200))

  // Adulteração: troca 1 byte do sha256 do primeiro asset no wire. O decoder
  // reencoda e vê a divergência (ou a assinatura quebra).
  const adulterado = Buffer.from(hexToBytes(vetor.wire_hex))
  const alvo = Buffer.from(body.assets[0].sha256, 'ascii')
  const pos = adulterado.indexOf(alvo)
  check('achou o sha256 no wire para adulterar', pos > 0)
  if (pos > 0) {
    adulterado[pos] = 'e'.charCodeAt(0)
    writeFileSync(manifestPath, adulterado)
    let recusou = false
    try {
      execFileSync(
        process.execPath,
        [resolve(aqui, 'verify-release.mjs'), '--manifest', manifestPath, '--trust', trustPath],
        { encoding: 'utf8', stdio: 'pipe' },
      )
    } catch {
      recusou = true
    }
    check('verificador recusa manifesto adulterado', recusou)
  }

  // Assinatura vazia não valida.
  check(
    'assinatura vazia não valida',
    verifyBytes(canonicalBodyBytes(body), '00'.repeat(64), vetor.pubkey_1) === false,
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (falhas > 0) {
  console.error(`\n${falhas} verificação(ões) falharam`)
  process.exit(1)
}
console.log('\nOK — tooling Node e Rust falam o mesmo formato')
