#!/usr/bin/env node
// Assina um manifesto de release com 2+ chaves offline. O binario produzido
// (`<out>.bin`) e exatamente o que o app baixa como `distorrent-manifest.bin`
// e o que `SignedManifest::from_wire` aceita.

import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

import {
  MAX_ASSETS,
  MAX_SIGNATURES,
  ToolError,
  canonicalBodyBytes,
  encodeSignedManifest,
  fail,
  formatTrustSet,
  manifestHashHex,
  parseArgv,
  parseTrustSet,
  readSecretKeyFile,
  run,
  shortHex,
  signBytes,
  signingPayloadBytes,
  sortAssets,
  sortUniqueStrings,
  validateManifest,
} from './lib.mjs'

function usage() {
  console.log(`uso: node tools/release-trust/sign-release.mjs --manifest <file.json> \\
         --trust <trust-set.txt> --key <signer-1.key> --key <signer-2.key> \\
         [--key <signer-3.key>] [--out <prefix>] [--asset-dir <dir>] [--refresh-hashes]

  --manifest <file.json>   manifesto em JSON (autoral; o .bin e derivado dele)
  --trust <file>           linha de confianca (epoch|threshold|key_id:pubkey,...)
  --key <file>             chave privada (32 bytes hex); repita 2 ou 3 vezes
  --out <prefix>           prefixo de saida (padrao: nome do manifesto sem .json)
  --asset-dir <dir>        diretorio local dos instaladores para conferir/refazer size+sha256
  --refresh-hashes         recalcula size/sha256 do --asset-dir mesmo se o JSON ja trouxer

O manifesto JSON precisa de: version, channel, tag, commit, published_at_ms,
protocol_version, min_protocol_version, security_epoch, min_security_epoch,
revoked_versions[], revoked_key_ids[], assets[{name,os,arch,size,sha256,url}].
Sem --asset-dir, size e sha256 precisam estar no JSON.`)
}

function parseArgs(argv) {
  const args = parseArgv(argv, {
    multi: ['key'],
    flags: ['refresh-hashes', 'help'],
  })
  if (args.has('help')) {
    usage()
    process.exit(0)
  }
  const manifest = args.get('manifest')
  const trust = args.get('trust')
  const keys = args.all('key')
  if (!manifest) fail('--manifest e obrigatorio')
  if (!trust) fail('--trust e obrigatorio')
  if (keys.length === 0) fail('informe ao menos 2 --key (chaves privadas distintas)')
  if (keys.length > MAX_SIGNATURES) fail(`no maximo ${MAX_SIGNATURES} --key`)
  const out = args.get('out')
  return {
    manifest,
    trust,
    keys,
    // Derivar o nome do manifesto evita sobrescrever o .bin de outra versao
    // por esquecimento: <dir>/<nome>.bin fica ao lado do JSON.
    out: out ?? join(dirname(manifest), basename(manifest).replace(/\.json$/i, '')),
    assetDir: args.get('asset-dir'),
    refresh: args.has('refresh-hashes'),
  }
}

// JSON estrito: comentario, virgula sobrando e numero fora da faixa viram erro
// explicito, em vez de entrarem mudos na assinatura.
function readManifestJson(path) {
  if (!existsSync(path)) fail(`manifesto nao encontrado: ${path}`)
  const raw = readFileSync(path, 'utf8')
  let obj
  try {
    obj = JSON.parse(raw)
  } catch (e) {
    throw new ToolError(`manifesto JSON invalido: ${e.message}`)
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    fail('manifesto JSON precisa ser um objeto')
  }
  const required = [
    'version',
    'channel',
    'tag',
    'commit',
    'published_at_ms',
    'protocol_version',
    'min_protocol_version',
    'security_epoch',
    'min_security_epoch',
  ]
  for (const k of required) {
    if (!(k in obj)) fail(`manifesto JSON sem o campo obrigatorio "${k}"`)
  }
  return obj
}

function sha256File(path) {
  return new Promise((res, rej) => {
    // Le em blocos: carregar 40 MB por asset na memoria do processo nao escala.
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej)
  })
}

async function resolveAssets(obj, assetDir, refresh) {
  if (!Array.isArray(obj.assets) || obj.assets.length === 0) {
    fail('manifesto precisa listar ao menos um asset')
  }
  if (obj.assets.length > MAX_ASSETS) fail(`no maximo ${MAX_ASSETS} assets`)

  const out = []
  for (const a of obj.assets) {
    if (typeof a !== 'object' || a === null) fail('asset invalido no JSON')
    if (typeof a.name !== 'string' || a.name === '') fail('asset sem name')
    const entry = { ...a }
    const hasSize = Number.isSafeInteger(entry.size) && entry.size > 0
    const hasSha = typeof entry.sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(entry.sha256)

    if (!assetDir && (!hasSize || !hasSha)) {
      fail(
        `asset ${a.name}: size/sha256 ausentes e sem --asset-dir. ` +
          'Informe os dois no JSON ou passe --asset-dir com os instaladores.',
      )
    }
    if (assetDir) {
      // Com os arquivos em maos, o valor do JSON nao e confiavel por si: se
      // divergir, assinar o numero errado produz um manifesto que nenhum peer
      // consegue baixar. --refresh-hashes existe so para assumir a troca.
      const path = join(assetDir, a.name)
      if (!existsSync(path)) fail(`asset ${a.name}: arquivo nao encontrado em ${path}`)
      const st = statSync(path)
      const realSha = await sha256File(path)
      if (refresh) {
        entry.size = st.size
        entry.sha256 = realSha
        console.log(`  ${a.name}: ${st.size} bytes sha256=${realSha.slice(0, 16)}... (recalculado)`)
      } else {
        if (hasSize && entry.size !== st.size) {
          fail(
            `asset ${a.name}: size do JSON (${entry.size}) difere do arquivo (${st.size}). ` +
              'Corrija o JSON ou use --refresh-hashes para recalcular.',
          )
        }
        if (hasSha && entry.sha256.toLowerCase() !== realSha) {
          fail(
            `asset ${a.name}: sha256 do JSON difere do arquivo. ` +
              `manifesto ${entry.sha256.slice(0, 16)}... arquivo ${realSha.slice(0, 16)}... ` +
              'Corrija o JSON ou use --refresh-hashes para recalcular.',
          )
        }
        entry.size = st.size
        entry.sha256 = realSha
        console.log(`  ${a.name}: ${st.size} bytes sha256=${realSha.slice(0, 16)}... (conferido)`)
      }
    } else {
      entry.sha256 = entry.sha256.toLowerCase()
    }
    out.push(entry)
  }
  return out
}

function buildBody(obj, assets) {
  const body = {
    schema: 1,
    project: 'distorrent',
    version: obj.version,
    channel: obj.channel,
    tag: obj.tag,
    commit: String(obj.commit).toLowerCase(),
    published_at_ms: obj.published_at_ms,
    protocol_version: obj.protocol_version,
    min_protocol_version: obj.min_protocol_version,
    security_epoch: obj.security_epoch,
    min_security_epoch: obj.min_security_epoch,
    revoked_versions: sortUniqueStrings(obj.revoked_versions ?? [], 'revoked_versions'),
    revoked_key_ids: sortUniqueStrings(obj.revoked_key_ids ?? [], 'revoked_key_ids'),
    assets: sortAssets(assets),
  }
  validateManifest(body)
  return body
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const obj = readManifestJson(args.manifest)

  console.log(`Manifesto: ${args.manifest}`)
  console.log('Assets:')
  const assets = await resolveAssets(obj, args.assetDir, args.refresh)
  const body = buildBody(obj, assets)

  console.log('')
  console.log(`  versao     ${body.version} (canal ${body.channel}, tag ${body.tag})`)
  console.log(`  commit     ${body.commit}`)
  console.log(`  epoch      ${body.security_epoch} (minima ${body.min_security_epoch})`)
  console.log(`  assets     ${body.assets.length} (ordenados por os,arch,name)`)
  console.log(`  hash body  ${manifestHashHex(body)}`)

  const trustSet = parseTrustSet(readFileSync(args.trust, 'utf8'))
  console.log('')
  console.log(`Conjunto de confianca: epoch=${trustSet.epoch} threshold=${trustSet.threshold}`)
  console.log(`  ${formatTrustSet(trustSet)}`)
  if (trustSet.threshold < 2) fail('conjunto de confianca com limiar abaixo de 2')

  const signers = []
  const seen = new Set()
  for (const path of args.keys) {
    if (!existsSync(path)) fail(`chave nao encontrada: ${path}`)
    const key = readSecretKeyFile(path)
    if (seen.has(key.keyId)) fail(`chave repetida: ${path} (key_id ${key.keyId})`)
    seen.add(key.keyId)
    const trusted = trustSet.keys.find((k) => k.keyId === key.keyId)
    if (!trusted) {
      fail(
        `chave ${path} (key_id ${key.keyId}) nao esta no conjunto de confianca ${args.trust}`,
      )
    }
    if (trusted.pubkeyHex !== key.pubkeyHex) {
      fail(`chave ${path}: pubkey derivada nao bate com a do conjunto de confianca`)
    }
    signers.push(key)
    console.log(`  assinante ${key.keyId} ok`)
  }

  if (signers.length < 2) {
    fail(`sao necessarias 2 chaves distintas autorizadas; recebi ${signers.length}`)
  }
  if (signers.length < trustSet.threshold) {
    fail(
      `o conjunto exige ${trustSet.threshold} assinaturas, mas so ${signers.length} ` +
        'chaves foram passadas',
    )
  }

  const payload = signingPayloadBytes(body)
  console.log('')
  console.log(`Payload (blake3 do dominio+body): ${payload.toString('hex')}`)

  const signatures = signers.map((key) => ({
    keyId: key.keyId,
    sig: signBytes(payload, key),
  }))
  const wire = encodeSignedManifest(body, signatures)

  const outBin = `${args.out.replace(/\.bin$/i, '')}.bin`
  writeFileSync(outBin, wire)

  console.log('')
  console.log(`Assinaturas: ${signatures.length}`)
  for (const s of signatures) {
    console.log(`  ${s.keyId}  ${shortHex(s.sig, 24)}`)
  }
  console.log('')
  console.log(`Escrito: ${outBin} (${wire.length} bytes)`)
  console.log(`manifest_hash: ${manifestHashHex(body)}`)
  console.log(`body_bytes:    ${canonicalBodyBytes(body).length}`)
  console.log('')
  console.log(`Publique como asset da release com o nome exato "distorrent-manifest.bin":`)
  console.log(`  node scripts/publish-release.mjs <tag> <notes.md> ${outBin}`)
  console.log('Confira antes com:')
  console.log(`  node tools/release-trust/verify-release.mjs --manifest ${outBin} --trust ${args.trust}`)
}

run(main)
