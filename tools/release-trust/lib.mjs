/* global Buffer, console, process */
// Biblioteca do ferramental de release offline.
// O formato binario e fechado e vive em distorrent-core/src/release/manifest.rs
// e trust.rs; divergir em um byte aqui so aparece na verificacao do app, entao
// cada campo segue a ordem exata do Rust e os testes conferem bytes.

import { readFileSync } from 'node:fs'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { blake3 } from '@noble/hashes/blake3.js'

// @noble/ed25519 v3 expoe o slot em `hashes` (o antigo `etc.sha512Sync` e v2).
// Sem isto a API sincrona lanca; a assincrona dependeria de crypto.subtle.
ed.hashes.sha512 = sha512

export const MANIFEST_MAGIC = Buffer.from('DTMF1', 'ascii')
export const ROTATION_TAG = Buffer.from('ROT', 'ascii')
export const MANIFEST_SCHEMA = 1
export const PROJECT_ID = 'distorrent'
export const SIGN_DOMAIN = Buffer.from('distorrent/v1|release-manifest|', 'utf8')
export const ROTATION_DOMAIN = Buffer.from('distorrent/v1|trust-rotation|', 'utf8')

export const MAX_MANIFEST_BYTES = 64 * 1024
export const MAX_ASSETS = 32
export const MAX_REVOKED = 512
export const MAX_SIGNATURES = 3
export const MAX_TRUST_KEYS = 5
export const MIN_THRESHOLD = 2
export const TRUST_EPOCH_MAX = 1_000_000
export const MAX_ASSET_BYTES = 4 * 1024 * 1024 * 1024

export class ToolError extends Error {}

export function fail(msg) {
  throw new ToolError(msg)
}

// ---------------------------------------------------------------------------
// Hex e comparacao
// ---------------------------------------------------------------------------

export function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

export function hexToBytes(hex, expectedLen, label = 'hex') {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    fail(`${label}: nao e hexadecimal`)
  }
  const out = Buffer.from(hex, 'hex')
  if (expectedLen !== undefined && out.length !== expectedLen) {
    fail(`${label}: esperado ${expectedLen} bytes, veio ${out.length}`)
  }
  return out
}

// Rust compara `str` por bytes UTF-8; comparar code units do JS diverge em
// acento/emoji e mudaria a ordem canonica.
export function cmpUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export function sortUniqueStrings(list, field) {
  const seen = new Set()
  for (const v of list) {
    if (typeof v !== 'string') fail(`${field}: item nao e string`)
    if (seen.has(v)) fail(`${field}: valor duplicado "${v}"`)
    seen.add(v)
  }
  return [...list].sort(cmpUtf8)
}

// ---------------------------------------------------------------------------
// Validacao espelhando manifest.rs
// ---------------------------------------------------------------------------

export function validText(s, max) {
  if (typeof s !== 'string' || s.length === 0) return false
  if (Buffer.byteLength(s, 'utf8') > max) return false
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return false
  }
  return true
}

export function validVersion(s) {
  if (typeof s !== 'string') return false
  const core = s.split('-')[0]
  const parts = core.split('.')
  if (parts.length !== 3) return false
  for (const p of parts) {
    if (p.length === 0 || p.length > 9 || !/^[0-9]+$/.test(p)) return false
  }
  return Buffer.byteLength(s, 'utf8') <= 64
}

export function validAssetName(s) {
  return (
    validText(s, 255) &&
    !s.includes('/') &&
    !s.includes('\\') &&
    s !== '.' &&
    s !== '..'
  )
}

export function validHex(s, len) {
  return typeof s === 'string' && s.length === len && /^[0-9a-fA-F]+$/.test(s)
}

export function validKeyId(s) {
  return validHex(s, 16)
}

export function validSha256(s) {
  return validHex(s, 64)
}

export function validCommit(s) {
  return validHex(s, 40)
}

export function validHttpsUrl(s) {
  return validText(s, 1024) && s.startsWith('https://')
}

export function asSafeInt(v, label, { min = -Infinity, max = Infinity } = {}) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    fail(`${label}: precisa ser inteiro (recebido: ${JSON.stringify(v)})`)
  }
  if (v < min || v > max) fail(`${label}: fora da faixa (${v})`)
  return v
}

export function validateManifest(body) {
  const errs = []
  const bad = (m) => errs.push(m)

  if (body.schema !== MANIFEST_SCHEMA) bad('schema de manifesto nao suportado')
  if (body.project !== PROJECT_ID) bad('manifesto de outro projeto')
  if (!validVersion(body.version)) bad('versao invalida no manifesto')
  if (!validText(body.channel, 32)) bad('canal invalido no manifesto')
  // Rust usa trim_start_matches('v'), que remove TODOS os 'v' iniciais.
  if (String(body.tag ?? '').replace(/^v+/, '') !== String(body.version ?? '').split('-')[0]) {
    bad('tag e versao nao batem')
  }
  if (!validCommit(body.commit)) bad('commit do manifesto nao e SHA-1 de 40 hex')
  if (!Number.isSafeInteger(body.published_at_ms) || body.published_at_ms <= 0) {
    bad('data de publicacao invalida')
  }
  if (
    !Number.isSafeInteger(body.protocol_version) ||
    body.protocol_version <= 0 ||
    body.protocol_version > 1_000_000
  ) {
    bad('protocol_version invalida')
  }
  if (
    !Number.isSafeInteger(body.min_protocol_version) ||
    body.min_protocol_version > body.protocol_version
  ) {
    bad('min_protocol_version maior que a versao')
  }
  if (!Number.isSafeInteger(body.security_epoch) || body.security_epoch < 0) {
    bad('security_epoch invalida')
  }
  if (
    !Number.isSafeInteger(body.min_security_epoch) ||
    body.min_security_epoch > body.security_epoch
  ) {
    bad('epoch minima maior que a epoch do manifesto')
  }
  if (!Array.isArray(body.assets) || body.assets.length === 0) {
    bad('quantidade de assets fora da faixa')
  } else if (body.assets.length > MAX_ASSETS) {
    bad('quantidade de assets fora da faixa')
  }
  const revV = body.revoked_versions ?? []
  const revK = body.revoked_key_ids ?? []
  if (!Array.isArray(revV) || !Array.isArray(revK)) bad('listas de revogacao invalidas')
  if (revV.length > MAX_REVOKED || revK.length > MAX_REVOKED) {
    bad('lista de revogacao grande demais')
  }
  // Ordem estrita: duas codificacoes do mesmo conteudo assinariam hashes
  // diferentes, entao a forma canonica ja rejeita empate.
  for (const [list, name] of [
    [revV, 'revoked_versions'],
    [revK, 'revoked_key_ids'],
  ]) {
    for (let i = 1; i < list.length; i += 1) {
      if (typeof list[i - 1] !== 'string' || typeof list[i] !== 'string') {
        bad(`${name}: item nao e string`)
        break
      }
      if (cmpUtf8(list[i - 1], list[i]) >= 0) {
        bad(`${name} fora de ordem/duplicada`)
        break
      }
    }
  }
  if (Array.isArray(body.assets)) {
    for (const a of body.assets) {
      if (typeof a !== 'object' || a === null) {
        bad('asset invalido')
        continue
      }
      if (!validAssetName(a.name)) bad(`nome de asset invalido (${a.name})`)
      if (!validText(a.os, 32) || !validText(a.arch, 32)) {
        bad(`os/arch invalidos no asset (${a.name})`)
      }
      if (!Number.isSafeInteger(a.size) || a.size <= 0 || a.size > MAX_ASSET_BYTES) {
        bad(`tamanho de asset fora da faixa (${a.name})`)
      }
      if (!validSha256(a.sha256)) bad(`sha256 do asset nao e 64 hex (${a.name})`)
      if (!validHttpsUrl(a.url)) bad(`URL do asset precisa ser https (${a.name})`)
    }
    for (let i = 1; i < body.assets.length; i += 1) {
      const p = body.assets[i - 1]
      const c = body.assets[i]
      if (!p || !c) continue
      if (cmpAssetKey(p, c) >= 0) {
        bad('assets fora de ordem canonica')
        break
      }
    }
  }

  if (errs.length) {
    throw new ToolError(
      `manifesto invalido:\n${errs.map((e) => `  - ${e}`).join('\n')}`,
    )
  }
}

export function cmpAssetKey(a, b) {
  const ka = cmpUtf8(String(a.os), String(b.os))
  if (ka !== 0) return ka
  const kb = cmpUtf8(String(a.arch), String(b.arch))
  if (kb !== 0) return kb
  return cmpUtf8(String(a.name), String(b.name))
}

export function sortAssets(assets) {
  const seen = new Set()
  const seenNames = new Set()
  for (const a of assets) {
    const k = `${a.os}\u0000${a.arch}\u0000${a.name}`
    if (seen.has(k)) fail(`assets: entrada duplicada ${a.os}/${a.arch}/${a.name}`)
    seen.add(k)
    if (seenNames.has(a.name)) fail(`assets: nome de arquivo repetido ${a.name}`)
    seenNames.add(a.name)
  }
  return [...assets].sort(cmpAssetKey)
}

// ---------------------------------------------------------------------------
// Encoder canonico
// ---------------------------------------------------------------------------

class Enc {
  constructor() {
    this.parts = []
    this.len = 0
  }
  bytes(b) {
    this.parts.push(b)
    this.len += b.length
  }
  u8(v) {
    const b = Buffer.alloc(1)
    b.writeUInt8(v)
    this.bytes(b)
  }
  u16(v) {
    const b = Buffer.alloc(2)
    b.writeUInt16BE(v)
    this.bytes(b)
  }
  u32(v) {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(v)
    this.bytes(b)
  }
  u64(v) {
    const b = Buffer.alloc(8)
    b.writeBigUInt64BE(BigInt(v))
    this.bytes(b)
  }
  i64(v) {
    const b = Buffer.alloc(8)
    b.writeBigInt64BE(BigInt(v))
    this.bytes(b)
  }
  str(s) {
    const b = Buffer.from(s, 'utf8')
    this.u32(b.length)
    this.bytes(b)
  }
  finish() {
    return Buffer.concat(this.parts, this.len)
  }
}

export function canonicalBodyBytes(body) {
  validateManifest(body)
  const w = new Enc()
  w.bytes(MANIFEST_MAGIC)
  w.u16(body.schema)
  w.str(body.project)
  w.str(body.version)
  w.str(body.channel)
  w.str(body.tag)
  w.str(body.commit)
  w.i64(body.published_at_ms)
  w.u32(body.protocol_version)
  w.u32(body.min_protocol_version)
  w.u64(body.security_epoch)
  w.u64(body.min_security_epoch)
  w.u32(body.revoked_versions.length)
  for (const v of body.revoked_versions) w.str(v)
  w.u32(body.revoked_key_ids.length)
  for (const v of body.revoked_key_ids) w.str(v)
  w.u32(body.assets.length)
  for (const a of body.assets) {
    w.str(a.name)
    w.str(a.os)
    w.str(a.arch)
    w.u64(a.size)
    w.str(a.sha256)
    w.str(a.url)
  }
  const out = w.finish()
  if (out.length > MAX_MANIFEST_BYTES) fail('manifesto acima do limite de 64 KiB')
  return out
}

export function signingPayloadBytes(body) {
  const h = blake3.create()
  h.update(SIGN_DOMAIN)
  h.update(canonicalBodyBytes(body))
  return Buffer.from(h.digest())
}

export function manifestHashHex(body) {
  return bytesToHex(blake3(canonicalBodyBytes(body)))
}

export function encodeSignedManifest(body, signatures) {
  const bodyBytes = canonicalBodyBytes(body)
  if (signatures.length === 0 || signatures.length > MAX_SIGNATURES) {
    fail('quantidade de assinaturas fora da faixa')
  }
  const w = new Enc()
  w.u32(bodyBytes.length)
  w.bytes(bodyBytes)
  w.u32(signatures.length)
  for (const s of signatures) {
    if (!validKeyId(s.keyId)) fail(`key_id de assinatura invalido (${s.keyId})`)
    if (!validHex(s.sig, 128)) fail(`assinatura de ${s.keyId} nao e 64 bytes hex`)
    w.str(s.keyId)
    w.str(s.sig)
  }
  const out = w.finish()
  if (out.length > MAX_MANIFEST_BYTES) fail('manifesto assinado acima do limite')
  return out
}

export function encodeSignatureBlock(signatures) {
  const w = new Enc()
  w.u32(signatures.length)
  for (const s of signatures) {
    w.str(s.keyId)
    w.str(s.sig)
  }
  return w.finish()
}

// ---------------------------------------------------------------------------
// Rotacao (TrustUpdate::canonical_bytes)
// ---------------------------------------------------------------------------

export function rotationBodyBytes(rot) {
  if (!Number.isSafeInteger(rot.fromEpoch) || rot.fromEpoch <= 0) {
    fail('from_epoch invalida')
  }
  if (!Number.isSafeInteger(rot.newEpoch) || rot.newEpoch <= rot.fromEpoch) {
    fail('a rotacao precisa avancar a epoch')
  }
  if (rot.newEpoch > TRUST_EPOCH_MAX) fail('epoch do conjunto novo fora da faixa')
  if (!Number.isSafeInteger(rot.effectiveMs) || rot.effectiveMs <= 0) {
    fail('effective_ms invalida')
  }
  if (!validText(rot.reason, 512)) fail('justificativa da rotacao invalida')
  if (!Array.isArray(rot.keys) || rot.keys.length < MIN_THRESHOLD) {
    fail('quantidade de chaves da rotacao fora da faixa')
  }
  if (rot.keys.length > MAX_TRUST_KEYS) fail('quantidade de chaves da rotacao fora da faixa')
  if (
    !Number.isSafeInteger(rot.threshold) ||
    rot.threshold < MIN_THRESHOLD ||
    rot.threshold > rot.keys.length
  ) {
    fail('limiar da rotacao invalido')
  }
  for (const k of rot.keys) {
    const derived = keyIdFromPubkey(hexToBytes(k.pubkeyHex, 32, 'pubkey da rotacao'))
    if (derived !== k.keyId) fail(`key_id ${k.keyId} nao corresponde a pubkey`)
  }
  for (let i = 1; i < rot.keys.length; i += 1) {
    if (cmpUtf8(rot.keys[i - 1].keyId, rot.keys[i].keyId) >= 0) {
      fail('chaves da rotacao fora de ordem/duplicadas')
    }
  }
  for (let i = 1; i < rot.revokedVersions.length; i += 1) {
    if (cmpUtf8(rot.revokedVersions[i - 1], rot.revokedVersions[i]) >= 0) {
      fail('lista de revogacao fora de ordem/duplicada')
    }
  }
  const w = new Enc()
  w.bytes(MANIFEST_MAGIC)
  w.bytes(ROTATION_TAG)
  w.u64(rot.fromEpoch)
  w.u64(rot.newEpoch)
  w.u8(rot.threshold)
  w.u32(rot.keys.length)
  for (const k of rot.keys) {
    w.str(k.keyId)
    w.str(k.pubkeyHex)
  }
  w.u32(rot.revokedVersions.length)
  for (const v of rot.revokedVersions) w.str(v)
  w.i64(rot.effectiveMs)
  w.str(rot.reason)
  return w.finish()
}

export function rotationSigningPayload(rot) {
  const h = blake3.create()
  h.update(ROTATION_DOMAIN)
  h.update(rotationBodyBytes(rot))
  return Buffer.from(h.digest())
}

// ---------------------------------------------------------------------------
// Chaves
// ---------------------------------------------------------------------------

export function keyIdFromPubkey(pubkeyBytes) {
  const h = blake3(Buffer.from(pubkeyBytes))
  return Buffer.from(h).subarray(0, 8).toString('hex')
}

export function keyFromSecret(secret) {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) {
    fail('segredo ed25519 precisa ter 32 bytes')
  }
  const pubkey = ed.getPublicKey(secret)
  return {
    secret: Buffer.from(secret),
    pubkey: Buffer.from(pubkey),
    pubkeyHex: bytesToHex(pubkey),
    keyId: keyIdFromPubkey(pubkey),
  }
}

export function readSecretKeyFile(path) {
  const raw = readFileSync(path, 'utf8')
  const hex = raw.trim()
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    // Nunca ecoa o conteudo: o arquivo pode ser uma chave de verdade.
    fail(`${path}: chave privada deve ser 32 bytes em hex (64 caracteres)`)
  }
  return keyFromSecret(Buffer.from(hex, 'hex'))
}

export function signBytes(payload, key) {
  return bytesToHex(ed.sign(Buffer.from(payload), key.secret))
}

export function verifyBytes(payload, sigHex, pubkeyHex) {
  try {
    return ed.verify(
      hexToBytes(sigHex, 64, 'assinatura'),
      Buffer.from(payload),
      hexToBytes(pubkeyHex, 32, 'pubkey'),
    )
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Conjunto de confianca: `epoch|threshold|key_id:pubkey_hex,...`
// ---------------------------------------------------------------------------

export function parseTrustSet(raw) {
  const text = String(raw).trim()
  const parts = text.split('|')
  if (parts.length < 3) fail('conjunto de confianca incompleto')
  if (parts.length > 3) fail('conjunto de confianca com campos extras')
  const epochRaw = parts[0].trim()
  const thresholdRaw = parts[1].trim()
  if (!/^[0-9]+$/.test(epochRaw)) fail('epoch do conjunto de confianca invalido')
  if (!/^[0-9]+$/.test(thresholdRaw)) fail('limiar do conjunto de confianca invalido')
  const epoch = Number(epochRaw)
  const threshold = Number(thresholdRaw)
  if (epoch < 1 || epoch > TRUST_EPOCH_MAX) {
    fail('epoch do conjunto de confianca fora da faixa')
  }
  if (threshold < MIN_THRESHOLD) fail('limiar de confianca abaixo do minimo')

  const keysRaw = parts[2].trim()
  if (keysRaw === '') fail('conjunto de confianca sem chaves')
  const keys = []
  const seenIds = new Set()
  for (const item of keysRaw.split(',')) {
    const idx = item.indexOf(':')
    if (idx < 0) fail('chave de confianca malformada')
    const id = item.slice(0, idx).trim()
    const pub = item.slice(idx + 1).trim()
    const pubBytes = hexToBytes(pub, 32, 'pubkey da autoridade')
    const derived = keyIdFromPubkey(pubBytes)
    if (derived !== id) fail(`key_id ${id} nao corresponde a pubkey`)
    if (seenIds.has(id)) fail(`chave duplicada no conjunto: ${id}`)
    seenIds.add(id)
    keys.push({ keyId: derived, pubkeyHex: bytesToHex(pubBytes) })
  }
  keys.sort((a, b) => cmpUtf8(a.keyId, b.keyId))
  if (keys.length < MIN_THRESHOLD || keys.length > MAX_TRUST_KEYS) {
    fail('quantidade de chaves de confianca fora da faixa')
  }
  if (threshold > keys.length) fail('limiar de assinaturas invalido')

  return { epoch, threshold, keys }
}

export function formatTrustSet(set) {
  const keys = [...set.keys].sort((a, b) => cmpUtf8(a.keyId, b.keyId))
  return `${set.epoch}|${set.threshold}|${keys
    .map((k) => `${k.keyId}:${k.pubkeyHex}`)
    .join(',')}`
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgv(argv, { multi = [], flags = [] } = {}) {
  const opts = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) fail(`argumento inesperado: ${a} (use --nome valor)`)
    const name = a.slice(2)
    if (flags.includes(name)) {
      if (opts.has(name)) fail(`--${name} repetido`)
      opts.set(name, true)
      continue
    }
    const val = argv[i + 1]
    if (val === undefined || (val.startsWith('--') && val.length > 2)) {
      fail(`--${name} exige um valor`)
    }
    i += 1
    if (multi.includes(name)) {
      if (!opts.has(name)) opts.set(name, [])
      opts.get(name).push(val)
    } else {
      if (opts.has(name)) fail(`--${name} repetido`)
      opts.set(name, val)
    }
  }
  return {
    has: (n) => opts.has(n),
    get: (n) => opts.get(n),
    all: (n) => opts.get(n) ?? [],
  }
}

export function run(main) {
  main().catch((err) => {
    if (err instanceof ToolError) {
      console.error(`ERRO: ${err.message}`)
      process.exit(2)
    }
    console.error(`ERRO inesperado: ${err?.stack ?? err}`)
    process.exit(2)
  })
}

export function humanBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

export function shortHex(hex, n = 12) {
  return hex.length <= n ? hex : `${hex.slice(0, n)}...`
}
