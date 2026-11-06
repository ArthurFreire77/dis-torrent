#!/usr/bin/env node
// Verificador independente do manifesto de release.
//
// Decodifica os bytes que CHEGARAM e os reencoda por conta propria; se as duas
// formas nao baterem byte-a-byte, o arquivo nao esta na forma canonica que o
// Rust exige. Nao importa o codificador do assinador de proposito: um bug nos
// dois lados nao pode passar despercebido.

import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { createHash } from 'node:crypto'
import { blake3 } from '@noble/hashes/blake3.js'

import {
  MAX_ASSETS,
  MAX_MANIFEST_BYTES,
  MAX_REVOKED,
  MAX_SIGNATURES,
  fail,
  parseArgv,
  parseTrustSet,
  run,
  shortHex,
  verifyBytes,
  bytesToHex,
} from './lib.mjs'

const MAGIC = Buffer.from('DTMF1', 'ascii')
const SIGN_DOMAIN = Buffer.from('distorrent/v1|release-manifest|', 'utf8')
const PROJECT_ID = 'distorrent'

function usage() {
  console.log(`uso: node tools/release-trust/verify-release.mjs --manifest <file.bin> \\
         --trust <trust-set.txt> [--file <name>=<path>]... [--min-epoch <n>]

  --manifest <file.bin>    manifesto assinado (distorrent-manifest.bin)
  --trust <file>           linha de confianca (epoch|threshold|key_id:pubkey,...)
  --file <name>=<path>     confere um instalador local contra o manifesto
  --min-epoch <n>          piso local de epoch (rollback); padrao 0

Sai com codigo != 0 se a verificacao falhar.`)
}

function parseArgs(argv) {
  const args = parseArgv(argv, { multi: ['file'], flags: ['help'] })
  if (args.has('help')) {
    usage()
    process.exit(0)
  }
  if (!args.get('manifest')) fail('--manifest e obrigatorio')
  if (!args.get('trust')) fail('--trust e obrigatorio')
  const files = args.all('file').map((spec) => {
    const i = spec.indexOf('=')
    if (i <= 0) fail(`--file precisa ser <name>=<path> (recebido: ${spec})`)
    return { name: spec.slice(0, i), path: spec.slice(i + 1) }
  })
  return {
    manifest: args.get('manifest'),
    trust: args.get('trust'),
    files,
    minEpoch: args.get('min-epoch') ? Number(args.get('min-epoch')) : 0,
  }
}

// ---------------------------------------------------------------------------
// Decoder proprio
// ---------------------------------------------------------------------------

class Dec {
  constructor(buf) {
    this.buf = buf
    this.pos = 0
  }
  take(n) {
    if (this.pos + n > this.buf.length) fail('manifesto truncado')
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  u16() {
    return this.take(2).readUInt16BE(0)
  }
  u32() {
    return this.take(4).readUInt32BE(0)
  }
  u64() {
    return Number(this.take(8).readBigUInt64BE(0))
  }
  i64() {
    return Number(this.take(8).readBigInt64BE(0))
  }
  str() {
    const n = this.u32()
    if (n > 2048) fail('string acima do limite')
    const b = this.take(n)
    const s = b.toString('utf8')
    // Buffer.toString substitui byte invalido por U+FFFD; comparar o
    // reencode detecta isso sem depender de TextDecoder fatal.
    if (!Buffer.from(s, 'utf8').equals(b)) fail('string nao e UTF-8')
    return s
  }
  strList() {
    const n = this.u32()
    if (n > MAX_REVOKED) fail('lista acima do limite')
    const out = []
    for (let i = 0; i < n; i += 1) out.push(this.str())
    return out
  }
  expectEnd() {
    if (this.pos !== this.buf.length) fail('bytes sobrando no manifesto')
  }
}

function decodeBody(bytes) {
  if (bytes.length > MAX_MANIFEST_BYTES) fail('manifesto acima do limite')
  const d = new Dec(bytes)
  if (!d.take(5).equals(MAGIC)) fail('magic do manifesto invalido')
  const body = {
    schema: d.u16(),
    project: d.str(),
    version: d.str(),
    channel: d.str(),
    tag: d.str(),
    commit: d.str(),
    published_at_ms: d.i64(),
    protocol_version: d.u32(),
    min_protocol_version: d.u32(),
    security_epoch: d.u64(),
    min_security_epoch: d.u64(),
    revoked_versions: d.strList(),
    revoked_key_ids: d.strList(),
  }
  const n = d.u32()
  if (n === 0 || n > MAX_ASSETS) fail('quantidade de assets fora da faixa')
  body.assets = []
  for (let i = 0; i < n; i += 1) {
    body.assets.push({
      name: d.str(),
      os: d.str(),
      arch: d.str(),
      size: d.u64(),
      sha256: d.str(),
      url: d.str(),
    })
  }
  d.expectEnd()
  return body
}

// Reencode independente. Repete a ordem de campos do Rust para comparar com os
// bytes recebidos; qualquer divergencia significa que o arquivo nao e canonico.
function reencodeBody(body) {
  const parts = []
  const u16 = (v) => {
    const b = Buffer.alloc(2)
    b.writeUInt16BE(v)
    parts.push(b)
  }
  const u32 = (v) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(v)
    parts.push(b)
  }
  const u64 = (v) => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64BE(BigInt(v))
    parts.push(b)
  }
  const i64 = (v) => {
    const b = Buffer.alloc(8)
    b.writeBigInt64BE(BigInt(v))
    parts.push(b)
  }
  const str = (s) => {
    const b = Buffer.from(s, 'utf8')
    u32(b.length)
    parts.push(b)
  }
  parts.push(MAGIC)
  u16(body.schema)
  str(body.project)
  str(body.version)
  str(body.channel)
  str(body.tag)
  str(body.commit)
  i64(body.published_at_ms)
  u32(body.protocol_version)
  u32(body.min_protocol_version)
  u64(body.security_epoch)
  u64(body.min_security_epoch)
  u32(body.revoked_versions.length)
  for (const v of body.revoked_versions) str(v)
  u32(body.revoked_key_ids.length)
  for (const v of body.revoked_key_ids) str(v)
  u32(body.assets.length)
  for (const a of body.assets) {
    str(a.name)
    str(a.os)
    str(a.arch)
    u64(a.size)
    str(a.sha256)
    str(a.url)
  }
  return Buffer.concat(parts)
}

function cmpUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

// Mesmas regras de ManifestBody::validate. Sem isso um arquivo canonico mas
// semanticamente invalido (http, tag errada) passaria na assinatura.
function validateBody(body, problems) {
  const bad = (m) => problems.push(m)
  const nonEmpty = (s, max) =>
    typeof s === 'string' &&
    s.length > 0 &&
    Buffer.byteLength(s) <= max &&
    ![...s].some((c) => {
      const cp = c.codePointAt(0)
      return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)
    })
  if (body.schema !== 1) bad('schema de manifesto nao suportado')
  if (body.project !== PROJECT_ID) bad('manifesto de outro projeto')
  const core = body.version.split('-')[0]
  const vparts = core.split('.')
  if (
    vparts.length !== 3 ||
    !vparts.every((p) => p.length > 0 && p.length <= 9 && /^[0-9]+$/.test(p)) ||
    Buffer.byteLength(body.version) > 64
  ) {
    bad('versao invalida no manifesto')
  }
  if (!nonEmpty(body.channel, 32)) bad('canal invalido no manifesto')
  if (body.tag.replace(/^v+/, '') !== core) bad('tag e versao nao batem')
  if (!/^[0-9a-fA-F]{40}$/.test(body.commit)) bad('commit nao e SHA-1 de 40 hex')
  if (body.published_at_ms <= 0) bad('data de publicacao invalida')
  if (body.protocol_version === 0 || body.protocol_version > 1_000_000) {
    bad('protocol_version invalida')
  }
  if (body.min_protocol_version > body.protocol_version) {
    bad('min_protocol_version maior que a versao')
  }
  if (body.min_security_epoch > body.security_epoch) {
    bad('epoch minima maior que a epoch do manifesto')
  }
  if (body.assets.length === 0 || body.assets.length > MAX_ASSETS) {
    bad('quantidade de assets fora da faixa')
  }
  for (const [list, name] of [
    [body.revoked_versions, 'revoked_versions'],
    [body.revoked_key_ids, 'revoked_key_ids'],
  ]) {
    for (let i = 1; i < list.length; i += 1) {
      if (cmpUtf8(list[i - 1], list[i]) >= 0) {
        bad(`${name} fora de ordem/duplicada`)
        break
      }
    }
  }
  for (const a of body.assets) {
    if (!nonEmpty(a.name, 255) || a.name.includes('/') || a.name.includes('\\') || a.name === '.' || a.name === '..') {
      bad(`nome de asset invalido (${a.name})`)
    }
    if (!nonEmpty(a.os, 32) || !nonEmpty(a.arch, 32)) bad(`os/arch invalidos (${a.name})`)
    if (a.size === 0 || a.size > 4 * 1024 * 1024 * 1024) bad(`tamanho de asset fora da faixa (${a.name})`)
    if (!/^[0-9a-fA-F]{64}$/.test(a.sha256)) bad(`sha256 invalido (${a.name})`)
    if (!(nonEmpty(a.url, 1024) && a.url.startsWith('https://'))) bad(`URL precisa ser https (${a.name})`)
  }
  for (let i = 1; i < body.assets.length; i += 1) {
    const p = body.assets[i - 1]
    const c = body.assets[i]
    const kp = [p.os, p.arch, p.name]
    const kc = [c.os, c.arch, c.name]
    let cmp = 0
    for (let j = 0; j < 3 && cmp === 0; j += 1) cmp = cmpUtf8(kp[j], kc[j])
    if (cmp >= 0) {
      bad('assets fora de ordem canonica')
      break
    }
  }
}

function decodeSigned(bytes) {
  if (bytes.length > MAX_MANIFEST_BYTES) fail('manifesto assinado acima do limite')
  const d = new Dec(bytes)
  const bodyLen = d.u32()
  if (bodyLen === 0 || bodyLen > MAX_MANIFEST_BYTES) fail('tamanho do body invalido')
  const bodyBytes = d.take(bodyLen)
  const body = decodeBody(bodyBytes)
  const n = d.u32()
  if (n === 0 || n > MAX_SIGNATURES) fail('quantidade de assinaturas fora da faixa')
  const signatures = []
  for (let i = 0; i < n; i += 1) {
    signatures.push({ keyId: d.str(), sig: d.str() })
  }
  d.expectEnd()
  return { body, bodyBytes, signatures }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.manifest)) fail(`manifesto nao encontrado: ${args.manifest}`)
  const raw = readFileSync(args.manifest)
  const trust = parseTrustSet(readFileSync(args.trust, 'utf8'))

  const problems = []
  const lines = []
  const say = (s = '') => lines.push(s)

  let decoded
  try {
    decoded = decodeSigned(raw)
  } catch (e) {
    console.error(`FAIL: ${e.message}`)
    console.error(`  arquivo: ${args.manifest}`)
    process.exit(1)
  }
  const { body, bodyBytes, signatures } = decoded

  validateBody(body, problems)

  // Forma canonica: o reencode tem de ser identico aos bytes recebidos.
  const reencoded = reencodeBody(body)
  if (!reencoded.equals(bodyBytes)) {
    problems.push('body nao esta na forma canonica (reencode diverge dos bytes recebidos)')
  }

  say(`Manifesto: ${args.manifest} (${raw.length} bytes, body ${bodyBytes.length})`)
  say(`Conjunto:  epoch=${trust.epoch} threshold=${trust.threshold} chaves=${trust.keys.length}`)
  say('')
  say(`  versao      ${body.version}`)
  say(`  canal       ${body.channel}`)
  say(`  tag         ${body.tag}`)
  say(`  commit      ${body.commit}`)
  say(`  publicado   ${new Date(body.published_at_ms).toISOString()} (${body.published_at_ms})`)
  say(`  protocolo   ${body.protocol_version} (minimo ${body.min_protocol_version})`)
  say(`  epoch       ${body.security_epoch} (minima ${body.min_security_epoch})`)
  say(
    `  revogadas   ${body.revoked_versions.length} versoes, ${body.revoked_key_ids.length} chaves`,
  )
  const bodyHash = bytesToHex(blake3(bodyBytes))
  say(`  hash body   ${bodyHash}`)
  say('')
  say(`Assets (${body.assets.length}):`)
  for (const a of body.assets) {
    say(
      `  ${a.name}\n` +
        `    ${a.os}/${a.arch}  ${a.size} bytes  sha256=${shortHex(a.sha256, 16)}\n` +
        `    ${a.url}`,
    )
  }

  // Assinatura: mesma regra do trust.rs — chave desconhecida e ignorada,
  // assinatura invalida de chave conhecida derruba TUDO, duplicata conta uma vez.
  const payload = Buffer.from(
    (() => {
      const h = blake3.create()
      h.update(SIGN_DOMAIN)
      h.update(bodyBytes)
      return h.digest()
    })(),
  )
  const seen = new Set()
  let valid = 0
  let invalidKnown = false
  let unknown = 0
  say('')
  say(`Assinaturas (${signatures.length}):`)
  for (const s of signatures) {
    const key = trust.keys.find((k) => k.keyId === s.keyId)
    if (!key) {
      unknown += 1
      say(`  ${s.keyId}  CHAVE DESCONHECIDA (ignorada)`)
      continue
    }
    if (seen.has(s.keyId)) {
      say(`  ${s.keyId}  duplicada (conta uma vez)`)
      continue
    }
    const ok = verifyBytes(payload, s.sig, key.pubkeyHex)
    say(`  ${s.keyId}  ${ok ? 'OK' : 'ASSINATURA INVALIDA'}`)
    if (!ok) {
      invalidKnown = true
      continue
    }
    seen.add(s.keyId)
    valid += 1
  }

  if (invalidKnown) problems.push('assinatura invalida de chave conhecida (adulteracao)')
  if (valid < trust.threshold) {
    problems.push(`assinaturas validas (${valid}) abaixo do limiar (${trust.threshold})`)
  }
  if (body.revoked_versions.includes(body.version)) {
    problems.push('a propria versao esta na lista de revogacao do manifesto')
  }
  if (body.security_epoch < args.minEpoch) {
    problems.push(
      `epoch ${body.security_epoch} abaixo do piso local ${args.minEpoch} (rollback)`,
    )
  }

  // Conferencia de instalador local: o hash do arquivo tem de ser o assinado.
  if (args.files.length > 0) {
    say('')
    say('Arquivos locais:')
    for (const f of args.files) {
      const asset = body.assets.find((a) => a.name === f.name)
      if (!asset) {
        problems.push(`arquivo ${f.name} nao esta no manifesto`)
        say(`  ${f.name}  AUSENTE NO MANIFESTO`)
        continue
      }
      if (!existsSync(f.path)) {
        problems.push(`arquivo local nao encontrado: ${f.path}`)
        say(`  ${f.name}  NAO ENCONTRADO (${f.path})`)
        continue
      }
      const size = readFileSync(f.path).length
      const sha = sha256File(f.path)
      const sizeOk = size === asset.size
      const shaOk = sha.toLowerCase() === asset.sha256.toLowerCase()
      if (!sizeOk) problems.push(`${f.name}: tamanho ${size} != ${asset.size} do manifesto`)
      if (!shaOk) problems.push(`${f.name}: sha256 do arquivo nao bate com o manifesto`)
      say(
        `  ${f.name}  ${sizeOk && shaOk ? 'OK' : 'DIVERGE'}  ` +
          `${size} bytes sha256=${shortHex(sha, 16)}${shaOk ? '' : ` (manifesto ${shortHex(asset.sha256, 16)})`}`,
      )
    }
  }

  say('')
  if (unknown > 0) say(`Aviso: ${unknown} assinatura(s) de chave fora do conjunto foram ignoradas.`)
  for (const l of lines) console.log(l)

  if (problems.length > 0) {
    console.log('')
    for (const p of problems) console.log(`  FALHA: ${p}`)
    console.log('')
    console.log(`FAIL  ${basename(args.manifest)} (${valid}/${trust.threshold} assinaturas validas)`)
    process.exit(1)
  }

  console.log('')
  console.log(`PASS  ${body.version} assinado por ${valid} de ${trust.keys.length} chaves (limiar ${trust.threshold})`)
  console.log(`      manifest_hash ${bodyHash}`)
}

run(async () => main())
