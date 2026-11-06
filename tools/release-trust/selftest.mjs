#!/usr/bin/env node
// Autoteste do ferramental de release. Roda os CLIs de verdade (processos
// filhos, com os exit codes reais) num diretorio temporario, para provar que:
// a cerimonia gera o conjunto, 2 chaves assinam, o verificador aceita, um byte
// adulterado reprova e 1 assinatura so e recusada.
//
// Nenhuma chave gerada aqui toca o repositorio.

import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const NODE = process.execPath

let failures = 0
let checks = 0

function check(name, ok, detail) {
  checks += 1
  if (ok) {
    console.log(`  ok    ${name}`)
  } else {
    failures += 1
    console.log(`  FALHA ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function run(args, opts = {}) {
  const res = spawnSync(NODE, args, {
    cwd: HERE,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
  })
  return {
    code: res.status,
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

const dir = mkdtempSync(join(tmpdir(), 'distorrent-release-selftest-'))
const keysDir = join(dir, 'keys')
const assetsDir = join(dir, 'assets')

try {
  console.log(`diretorio temporario: ${dir}`)
  console.log('')

  // -------------------------------------------------------------------------
  console.log('[1] cerimonia: 3 chaves, limiar 2, epoch 1')
  const ceremony = run([
    join(HERE, 'ceremony.mjs'),
    '--init',
    '--dir',
    keysDir,
    '--keys',
    '3',
    '--threshold',
    '2',
    '--epoch',
    '1',
  ])
  check('cerimonia sai com 0', ceremony.code === 0, ceremony.out.slice(-800))
  const trustLine = (ceremony.stdout.match(/(\d+\|\d+\|[0-9a-f]{16}:[0-9a-f]{64}(?:,[0-9a-f]{16}:[0-9a-f]{64})*)/) ?? [])[1]
  check('cerimonia imprime a linha de confianca', Boolean(trustLine))
  const trustPath = join(keysDir, 'trust-set.txt')
  const trustFile = readFileSync(trustPath, 'utf8').trim()
  check('trust-set.txt bate com a saida', trustFile === trustLine, `${trustFile} != ${trustLine}`)

  const secrets = [1, 2, 3].map((i) =>
    readFileSync(join(keysDir, `signer-${i}.key`), 'utf8').trim(),
  )
  check(
    'cada .key tem 32 bytes hex + newline',
    secrets.every((s) => /^[0-9a-f]{64}$/.test(s)),
  )
  check('segredos sao distintos', new Set(secrets).size === 3)
  check(
    'nenhum segredo aparece na saida da cerimonia',
    secrets.every((s) => !ceremony.out.includes(s)),
  )
  const parsedTrust = trustLine.split('|')
  check('linha tem epoch=1 threshold=2 e 3 chaves', parsedTrust[0] === '1' && parsedTrust[1] === '2' && parsedTrust[2].split(',').length === 3)
  const ids = parsedTrust[2].split(',').map((k) => k.split(':')[0])
  check('chaves ordenadas por key_id', ids.join(',') === [...ids].sort().join(','))

  console.log('')
  console.log('[2] cerimonia recusa sobrescrever sem --force')
  const again = run([join(HERE, 'ceremony.mjs'), '--init', '--dir', keysDir])
  check('segunda cerimonia sai != 0', again.code !== 0, `code=${again.code}`)
  check('mensagem manda usar --force', again.out.includes('--force'))
  const after = readFileSync(join(keysDir, 'signer-1.key'), 'utf8').trim()
  check('chave existente nao foi alterada', after === secrets[0])

  // -------------------------------------------------------------------------
  console.log('')
  console.log('[3] manifesto + instaladores de mentira')
  mkdirSync(assetsDir, { recursive: true })
  const assetA = Buffer.from('instalador de mentira para windows x64\n'.repeat(40))
  const assetB = Buffer.from('apk de mentira para android arm64\n'.repeat(30))
  const shaA = createHash('sha256').update(assetA).digest('hex')
  const shaB = createHash('sha256').update(assetB).digest('hex')
  writeFileSync(join(assetsDir, 'DisTorrent_9.9.9_x64_setup.exe'), assetA)
  writeFileSync(join(assetsDir, 'DisTorrent_9.9.9_arm64.apk'), assetB)

  const manifestJson = {
    version: '9.9.9',
    channel: 'stable',
    tag: 'v9.9.9',
    commit: 'a'.repeat(40),
    published_at_ms: 1_700_000_000_000,
    protocol_version: 5,
    min_protocol_version: 4,
    security_epoch: 3,
    min_security_epoch: 2,
    revoked_versions: ['9.9.8', '9.9.7'],
    revoked_key_ids: [],
    assets: [
      // Fora de ordem de proposito: o assinador ordena por (os, arch, name).
      // size/sha256 vem do arquivo local; o --asset-dir confere os dois.
      {
        name: 'DisTorrent_9.9.9_x64_setup.exe',
        os: 'windows',
        arch: 'x86_64',
        size: assetA.length,
        sha256: shaA,
        url: 'https://github.com/ArthurFreire77/dis-torrent/releases/download/v9.9.9/DisTorrent_9.9.9_x64_setup.exe',
      },
      {
        name: 'DisTorrent_9.9.9_arm64.apk',
        os: 'android',
        arch: 'aarch64',
        size: assetB.length,
        sha256: shaB,
        url: 'https://github.com/ArthurFreire77/dis-torrent/releases/download/v9.9.9/DisTorrent_9.9.9_arm64.apk',
      },
    ],
  }
  const manifestPath = join(dir, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifestJson, null, 2))

  console.log('')
  console.log('[4] uma assinatura so e recusada')
  const oneSig = run([
    join(HERE, 'sign-release.mjs'),
    '--manifest',
    manifestPath,
    '--trust',
    trustPath,
    '--key',
    join(keysDir, 'signer-1.key'),
    '--asset-dir',
    assetsDir,
    '--out',
    join(dir, 'one'),
  ])
  check('assinar com 1 chave sai != 0', oneSig.code !== 0, `code=${oneSig.code}`)
  check(
    'mensagem explica o minimo de 2',
    /2 chaves|2 assinaturas|ao menos 2/i.test(oneSig.out),
    oneSig.out.slice(-300),
  )

  console.log('')
  console.log('[5] duas chaves assinam')
  const sign = run([
    join(HERE, 'sign-release.mjs'),
    '--manifest',
    manifestPath,
    '--trust',
    trustPath,
    '--key',
    join(keysDir, 'signer-1.key'),
    '--key',
    join(keysDir, 'signer-3.key'),
    '--asset-dir',
    assetsDir,
    '--out',
    join(dir, 'release'),
  ])
  check('assinatura sai com 0', sign.code === 0, sign.out.slice(-1200))
  const binPath = join(dir, 'release.bin')
  const bin = readFileSync(binPath)
  check('gerou release.bin', bin.length > 0)
  check('bin comeca com u32 body_len + "DTMF1"', bin.subarray(4, 9).toString('ascii') === 'DTMF1')
  const bodyLen = bin.readUInt32BE(0)
  check('body_len plausivel', bodyLen > 5 && bodyLen < bin.length)
  const sigCount = bin.readUInt32BE(4 + bodyLen)
  check('duas assinaturas no binario', sigCount === 2, `sigCount=${sigCount}`)
  check(
    'nenhum segredo aparece na saida do assinador',
    secrets.every((s) => !sign.out.includes(s)),
  )

  console.log('')
  console.log('[6] verificador aceita')
  const verify = run([
    join(HERE, 'verify-release.mjs'),
    '--manifest',
    binPath,
    '--trust',
    trustPath,
    '--file',
    `DisTorrent_9.9.9_x64_setup.exe=${join(assetsDir, 'DisTorrent_9.9.9_x64_setup.exe')}`,
    '--file',
    `DisTorrent_9.9.9_arm64.apk=${join(assetsDir, 'DisTorrent_9.9.9_arm64.apk')}`,
  ])
  check('verificacao sai com 0', verify.code === 0, verify.out.slice(-1200))
  check('imprime PASS', /^PASS/m.test(verify.stdout), verify.stdout.slice(-400))
  check('mostra a versao', verify.stdout.includes('9.9.9'))
  check('mostra o commit', verify.stdout.includes('a'.repeat(40)))
  check('confere os dois arquivos locais', (verify.stdout.match(/\bOK\b/g) ?? []).length >= 2)
  check(
    'sha256 do asset veio do arquivo',
    verify.stdout.includes(shaA.slice(0, 16)) && verify.stdout.includes(shaB.slice(0, 16)),
    verify.stdout.slice(-600),
  )

  console.log('')
  console.log('[7] um byte adulterado reprova')
  const tampered = Buffer.from(bin)
  // Muda um byte do body (na posicao 20, dentro do campo project/version),
  // deixando a estrutura decodificavel: o ataque e "mexer no conteudo sem
  // reassinar", nao "corromper o arquivo".
  const flipAt = 9 + 2 + 4 + 9 // magic + schema + len(project) + "distorrent"
  tampered[flipAt] = tampered[flipAt] === 0x31 ? 0x32 : 0x31
  const tamperedPath = join(dir, 'release-tampered.bin')
  writeFileSync(tamperedPath, tampered)
  const bad = run([
    join(HERE, 'verify-release.mjs'),
    '--manifest',
    tamperedPath,
    '--trust',
    trustPath,
  ])
  check('manifesto adulterado sai != 0', bad.code !== 0, `code=${bad.code}`)
  check('imprime FAIL', /FAIL/.test(bad.stdout), bad.stdout.slice(-400))

  console.log('')
  console.log('[8] arquivo local divergente reprova')
  const wrongAsset = join(dir, 'wrong.exe')
  writeFileSync(wrongAsset, Buffer.from('outro conteudo qualquer'))
  const badFile = run([
    join(HERE, 'verify-release.mjs'),
    '--manifest',
    binPath,
    '--trust',
    trustPath,
    '--file',
    `DisTorrent_9.9.9_x64_setup.exe=${wrongAsset}`,
  ])
  check('arquivo divergente sai != 0', badFile.code !== 0, `code=${badFile.code}`)
  check('aponta a divergencia', /DIVERGE|nao bate|não bate/.test(badFile.stdout))

  console.log('')
  console.log('[9] assinatura de chave fora do conjunto e recusada')
  // Gera um 2o conjunto (outra "autoridade") e tenta assinar com 1 chave do
  // conjunto real + 1 de fora: o assinador tem de recusar antes de gravar.
  const otherDir = join(dir, 'keys-other')
  const other = run([
    join(HERE, 'ceremony.mjs'),
    '--init',
    '--dir',
    otherDir,
    '--keys',
    '3',
    '--threshold',
    '2',
    '--epoch',
    '1',
  ])
  check('segunda cerimonia isolada sai com 0', other.code === 0, other.out.slice(-400))
  const foreign = run([
    join(HERE, 'sign-release.mjs'),
    '--manifest',
    manifestPath,
    '--trust',
    trustPath,
    '--key',
    join(keysDir, 'signer-1.key'),
    '--key',
    join(otherDir, 'signer-2.key'),
    '--asset-dir',
    assetsDir,
    '--out',
    join(dir, 'foreign'),
  ])
  check('assinador recusa chave de fora', foreign.code !== 0, `code=${foreign.code}`)
  check('diz que a chave nao esta no conjunto', /nao esta no conjunto|não está no conjunto/.test(foreign.out))

  console.log('')
  console.log('[10] mesma chave duas vezes e recusada')
  const dup = run([
    join(HERE, 'sign-release.mjs'),
    '--manifest',
    manifestPath,
    '--trust',
    trustPath,
    '--key',
    join(keysDir, 'signer-2.key'),
    '--key',
    join(keysDir, 'signer-2.key'),
    '--asset-dir',
    assetsDir,
    '--out',
    join(dir, 'dup'),
  ])
  check('chave repetida sai != 0', dup.code !== 0, `code=${dup.code}`)
  check('detecta repeticao', /repetida/.test(dup.out))

  console.log('')
  console.log('[11] rotacao assinada por 2 chaves')
  // Conjunto novo: mantem signer-1 (continuidade) e traz duas chaves novas.
  const rotDir = join(dir, 'keys-new')
  const rot = run([
    join(HERE, 'ceremony.mjs'),
    '--init',
    '--dir',
    rotDir,
    '--keys',
    '2',
    '--threshold',
    '2',
    '--epoch',
    '2',
  ])
  check('cerimonia do conjunto novo sai com 0', rot.code === 0, rot.out.slice(-400))
  const rotate = run([
    join(HERE, 'rotate-keys.mjs'),
    '--from',
    trustPath,
    '--key',
    join(keysDir, 'signer-1.key'),
    '--key',
    join(keysDir, 'signer-2.key'),
    '--new-key',
    join(keysDir, 'signer-1.key'),
    '--new-key',
    join(rotDir, 'signer-1.key'),
    '--new-key',
    join(rotDir, 'signer-2.key'),
    '--threshold',
    '2',
    '--epoch',
    '2',
    '--revoke',
    '9.0.0',
    '--reason',
    'rig de autoteste',
    '--effective-ms',
    '1700000000000',
    '--out',
    join(dir, 'rotation.txt'),
  ])
  check('rotacao sai com 0', rotate.code === 0, rotate.out.slice(-900))
  check('rotacao imprime a nova linha', /2\|2\|[0-9a-f]{16}:/.test(rotate.stdout))
  check('rotacao marca a chave mantida', /mantida do conjunto atual/.test(rotate.stdout))
  const rotFile = readFileSync(join(dir, 'rotation.txt'), 'utf8')
  const wire = (rotFile.match(/^payload_hex=([0-9a-f]+)$/m) ?? [])[1]
  const sigs = (rotFile.match(/^signatures_hex=([0-9a-f]+)$/m) ?? [])[1]
  check('arquivo tem payload_hex', Boolean(wire))
  check('arquivo tem signatures_hex', Boolean(sigs))
  check(
    'payload comeca com DTMF1ROT',
    Buffer.from(wire.slice(0, 16), 'hex').toString('ascii') === 'DTMF1ROT',
  )

  console.log('')
  console.log('[12] asset com hash errado no JSON e recusado')
  const badJsonPath = join(dir, 'manifest-bad-hash.json')
  const badJson = {
    ...manifestJson,
    assets: manifestJson.assets.map((a) =>
      a.name.endsWith('.exe') ? { ...a, size: assetA.length, sha256: 'f'.repeat(64) } : a,
    ),
  }
  writeFileSync(badJsonPath, JSON.stringify(badJson, null, 2))
  const badHash = run([
    join(HERE, 'sign-release.mjs'),
    '--manifest',
    badJsonPath,
    '--trust',
    trustPath,
    '--key',
    join(keysDir, 'signer-1.key'),
    '--key',
    join(keysDir, 'signer-2.key'),
    '--asset-dir',
    assetsDir,
    '--out',
    join(dir, 'badhash'),
  ])
  check('sha256 divergente sai != 0', badHash.code !== 0, `code=${badHash.code}`)
  check('aponta sha256 do manifesto vs arquivo', /sha256 do JSON difere do arquivo/.test(badHash.out))

  // size errado tambem: nao pode assinar um numero que o arquivo nao tem.
  const badSizeJson = {
    ...manifestJson,
    assets: manifestJson.assets.map((a) =>
      a.name.endsWith('.exe') ? { ...a, size: assetA.length + 1, sha256: shaA } : a,
    ),
  }
  const badSizePath = join(dir, 'manifest-bad-size.json')
  writeFileSync(badSizePath, JSON.stringify(badSizeJson, null, 2))
  const badSize = run([
    join(HERE, 'sign-release.mjs'),
    '--manifest',
    badSizePath,
    '--trust',
    trustPath,
    '--key',
    join(keysDir, 'signer-1.key'),
    '--key',
    join(keysDir, 'signer-2.key'),
    '--asset-dir',
    assetsDir,
    '--out',
    join(dir, 'badsize'),
  ])
  check('size divergente sai != 0', badSize.code !== 0, `code=${badSize.code}`)
  check('aponta size do manifesto vs arquivo', /size do JSON .* difere do arquivo/.test(badSize.out))

  // Com --refresh-hashes o mesmo JSON e aceito, e o hash assinado e o real.
  const refreshed = run([
    join(HERE, 'sign-release.mjs'),
    '--manifest',
    badSizePath,
    '--trust',
    trustPath,
    '--key',
    join(keysDir, 'signer-1.key'),
    '--key',
    join(keysDir, 'signer-2.key'),
    '--asset-dir',
    assetsDir,
    '--refresh-hashes',
    '--out',
    join(dir, 'refreshed'),
  ])
  check('--refresh-hashes aceita o JSON errado', refreshed.code === 0, refreshed.out.slice(-600))
  const refreshedCheck = run([
    join(HERE, 'verify-release.mjs'),
    '--manifest',
    join(dir, 'refreshed.bin'),
    '--trust',
    trustPath,
    '--file',
    `DisTorrent_9.9.9_x64_setup.exe=${join(assetsDir, 'DisTorrent_9.9.9_x64_setup.exe')}`,
  ])
  check('manifesto recalculado verifica o arquivo real', refreshedCheck.code === 0, refreshedCheck.out.slice(-600))

  console.log('')
  console.log('[13] rotacao usa a chave como pubkey quando o arquivo e .pub')
  const pubOnly = run([
    join(HERE, 'rotate-keys.mjs'),
    '--from',
    trustPath,
    '--key',
    join(keysDir, 'signer-1.key'),
    '--key',
    join(keysDir, 'signer-2.key'),
    '--new-key',
    join(keysDir, 'signer-3.key'),
    '--new-key',
    join(rotDir, 'signer-1.key'),
    '--reason',
    'rig de autoteste 2',
    '--effective-ms',
    '1700000000000',
    '--out',
    join(dir, 'rotation2.txt'),
  ])
  check('rotacao com 2 chaves novas continua valida', pubOnly.code === 0, pubOnly.out.slice(-600))
} finally {
  // Nada de chave gerada sobrevive ao teste.
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    console.log(`aviso: nao consegui apagar ${dir}`)
  }
}

console.log('')
if (failures === 0) {
  console.log(`PASS  autoteste: ${checks}/${checks} verificacoes`)
  process.exit(0)
}
console.log(`FAIL  autoteste: ${failures} de ${checks} verificacoes falharam`)
process.exit(1)
