#!/usr/bin/env node
// Rotacao do conjunto de confianca: produz o payload assinado que o app aplica
// via `update_trust_apply`, e imprime a nova linha para o proximo build.
//
// Formato identico a TrustUpdate::canonical_bytes (trust.rs): qualquer byte a
// mais aqui faz o app recusar com "rotacao nao esta na forma canonica".

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import {
  MAX_TRUST_KEYS,
  MIN_THRESHOLD,
  bytesToHex,
  encodeSignatureBlock,
  fail,
  formatTrustSet,
  keyFromSecret,
  keyIdFromPubkey,
  parseArgv,
  parseTrustSet,
  readSecretKeyFile,
  rotationBodyBytes,
  rotationSigningPayload,
  run,
  shortHex,
  signBytes,
  sortUniqueStrings,
} from './lib.mjs'

function usage() {
  console.log(`uso: node tools/release-trust/rotate-keys.mjs --from <trust-set.txt> \\
         --key <chave-atual-1> --key <chave-atual-2> [--key <chave-atual-3>] \\
         --new-key <pubkey-1> [--new-key <pubkey-2>] [--new-key <pubkey-3>] \\
         [--threshold <n>] [--epoch <n>] [--revoke <versao>]... \\
         [--reason "<texto>"] [--effective-ms <n>] [--out <arquivo>]

  --from <file>        conjunto ATUAL (epoch|threshold|key_id:pubkey,...)
  --key <file>         chave privada do conjunto ATUAL (2+; assina a rotacao)
  --new-key <file>     chave publica do conjunto NOVO: arquivo .key (seed de 32
                       bytes, a pubkey e derivada) ou .pub (64 hex da pubkey)
  --threshold <n>      limiar do conjunto novo (padrao 2; nunca abaixo de 2)
  --epoch <n>          epoch do conjunto novo (padrao: atual + 1)
  --revoke <versao>    versao a revogar (repetivel)
  --reason <texto>     justificativa (obrigatoria no limite de 512 bytes)
  --effective-ms <n>   quando a rotacao passa a valer (padrao: agora)
  --out <file>         saida de texto (padrao: rotation-<epoca>-<epoca>.txt)

Regra de continuidade do trust.rs: o conjunto novo precisa manter ao menos uma
chave do atual. Use --new-key com as chaves antigas que continuam e com as novas.`)
}

function parseArgs(argv) {
  const args = parseArgv(argv, {
    multi: ['key', 'new-key', 'revoke'],
    flags: ['help'],
  })
  if (args.has('help')) {
    usage()
    process.exit(0)
  }
  if (!args.get('from')) fail('--from e obrigatorio')
  const keys = args.all('key')
  const newKeys = args.all('new-key')
  if (keys.length < 2) fail('informe ao menos 2 --key do conjunto atual')
  if (newKeys.length < MIN_THRESHOLD) {
    fail(`informe ao menos ${MIN_THRESHOLD} --new-key para o conjunto novo`)
  }
  if (newKeys.length > MAX_TRUST_KEYS) fail(`no maximo ${MAX_TRUST_KEYS} chaves no conjunto`)
  return {
    from: args.get('from'),
    keys,
    newKeys,
    threshold: args.get('threshold') ? Number(args.get('threshold')) : MIN_THRESHOLD,
    epoch: args.get('epoch') ? Number(args.get('epoch')) : null,
    revoke: args.all('revoke'),
    reason: args.get('reason') ?? '',
    effectiveMs: args.get('effective-ms') ? Number(args.get('effective-ms')) : Date.now(),
    out: args.get('out'),
  }
}

// Le uma chave publica. `.key` traz a seed (ferramenta offline do dono); `.pub`
// traz a pubkey em hex, que e o que outra pessoa pode receber por papel.
function readPublicKeyFile(path) {
  if (!existsSync(path)) fail(`arquivo de chave nao encontrado: ${path}`)
  const raw = readFileSync(path, 'utf8').trim()
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    const bytes = Buffer.from(raw, 'hex')
    // 32 bytes hex tanto pode ser seed quanto pubkey. O nome do arquivo decide;
    // quando nao decide, tratar como pubkey e mais seguro para o operador (a
    // seed nao vira chave publica de terceiro por engano) e a checagem de
    // continuidade avisa se o resultado nao entrar no conjunto.
    if (/\.key$/i.test(path)) {
      return keyFromSecret(bytes)
    }
    return { pubkeyHex: bytesToHex(bytes), keyId: keyIdFromPubkey(bytes) }
  }
  fail(`${path}: precisa ser 32 bytes em hex (seed .key ou pubkey .pub)`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const current = parseTrustSet(readFileSync(args.from, 'utf8'))

  const newEpoch = args.epoch ?? current.epoch + 1
  if (args.threshold < MIN_THRESHOLD || args.threshold > args.newKeys.length) {
    fail(`--threshold precisa estar entre ${MIN_THRESHOLD} e o numero de chaves novas`)
  }

  const nextKeys = []
  const seenIds = new Set()
  for (const path of args.newKeys) {
    const k = readPublicKeyFile(path)
    if (seenIds.has(k.keyId)) fail(`chave repetida no conjunto novo: ${path}`)
    seenIds.add(k.keyId)
    nextKeys.push({ keyId: k.keyId, pubkeyHex: k.pubkeyHex, path })
  }
  nextKeys.sort((a, b) => (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0))

  const continuity = nextKeys.filter((k) => current.keys.some((c) => c.keyId === k.keyId))
  if (continuity.length === 0) {
    fail(
      'o conjunto novo nao mantem NENHUMA chave do atual; o trust.rs recusa a rotacao ' +
        'por falta de continuidade. Inclua ao menos uma chave atual entre os --new-key.',
    )
  }

  const revoked = sortUniqueStrings(args.revoke, 'revoked_versions')
  const reason = args.reason.trim() === '' ? '' : args.reason.trim()
  if (reason === '') fail('--reason e obrigatorio (o trust.rs exige justificativa)')

  const rot = {
    fromEpoch: current.epoch,
    newEpoch,
    threshold: args.threshold,
    keys: nextKeys,
    revokedVersions: revoked,
    effectiveMs: args.effectiveMs,
    reason,
  }
  const body = rotationBodyBytes(rot)
  const payload = rotationSigningPayload(rot)

  // Assinaturas: so chaves do conjunto ATUAL contam. Chave de fora e erro local,
  // nao "assinatura ignorada" — o operador precisa saber que o arquivo nao vale.
  const signers = []
  const seen = new Set()
  for (const path of args.keys) {
    const key = readSecretKeyFile(path)
    if (!current.keys.some((k) => k.keyId === key.keyId)) {
      fail(`chave ${path} (key_id ${key.keyId}) nao pertence ao conjunto atual`)
    }
    if (seen.has(key.keyId)) fail(`chave repetida: ${path}`)
    seen.add(key.keyId)
    signers.push(key)
  }
  if (signers.length < current.threshold) {
    fail(
      `o conjunto atual exige ${current.threshold} assinaturas; recebi ${signers.length} ` +
        'chaves distintas',
    )
  }

  const signatures = signers.map((key) => ({
    keyId: key.keyId,
    sig: signBytes(payload, key),
  }))
  const sigBlock = encodeSignatureBlock(signatures)

  const newTrustSet = {
    epoch: newEpoch,
    threshold: args.threshold,
    keys: nextKeys.map(({ keyId, pubkeyHex }) => ({ keyId, pubkeyHex })),
  }
  const newLine = formatTrustSet(newTrustSet)

  const outPath = args.out ?? `rotation-${current.epoch}-${newEpoch}.txt`
  const text = [
    '# DisTorrent — payload de rotacao do conjunto de confianca',
    `# gerado: ${new Date().toISOString()}`,
    `# from_epoch: ${current.epoch}`,
    `# new_epoch: ${newEpoch}`,
    `# threshold: ${args.threshold}`,
    `# effective_ms: ${rot.effectiveMs}`,
    `# reason: ${reason}`,
    `# assinada por: ${signers.map((k) => k.keyId).join(', ')}`,
    '#',
    '# Aplicar: update_trust_apply(wire_hex = payload_hex + signatures_hex)',
    '# = dhkm',
    `payload_hex=${body.toString('hex')}`,
    `signatures_hex=${sigBlock.toString('hex')}`,
    '#',
    '# Nova linha de confianca para o proximo build (trust_keys.rs):',
    `trust_set=${newLine}`,
    '',
  ].join('\n')
  writeFileSync(outPath, text, 'utf8')

  // O que o app espera e a concatencao; deixar pronto evita erro de mao.
  const wireHex = `${body.toString('hex')}${sigBlock.toString('hex')}`

  console.log('')
  console.log(`Rotacao ${current.epoch} -> ${newEpoch}  (threshold ${args.threshold})`)
  console.log(`  motivo       ${reason}`)
  console.log(`  vigencia     ${new Date(rot.effectiveMs).toISOString()}`)
  console.log(`  revogadas    ${revoked.length === 0 ? '(nenhuma)' : revoked.join(', ')}`)
  console.log('')
  console.log('Conjunto novo:')
  for (const k of nextKeys) {
    const kept = continuity.some((c) => c.keyId === k.keyId)
    console.log(`  ${k.keyId} ${kept ? '(mantida do conjunto atual)' : '(nova)'}`)
    console.log(`    ${k.pubkeyHex}`)
  }
  console.log('')
  console.log(`Assinaturas (${signatures.length} de ${current.keys.length} chaves atuais):`)
  for (const s of signatures) console.log(`  ${s.keyId}  ${shortHex(s.sig, 24)}`)
  console.log('')
  console.log(`Payload:  ${payload.toString('hex')}`)
  console.log(`Arquivo:  ${outPath}`)
  console.log('')
  console.log(`wire_hex (cole inteiro em update_trust_apply):`)
  console.log(wireHex)
  console.log('')
  console.log('Nova linha de confianca para o proximo build:')
  console.log(`  ${newLine}`)
  console.log('')
  console.log('PASSOS')
  console.log('  1. guarde o arquivo de rotacao offline (ele e a prova do que mudou);')
  console.log('  2. publique / entregue o payload e aplique com update_trust_apply;')
  console.log(`  3. troque TRUST_SET_BOOTSTRAP em distorrent-core/src/release/trust_keys.rs:`)
  console.log(`       pub const TRUST_SET_BOOTSTRAP: &str = "${newLine}";`)
  console.log('  4. rode cargo test -p distorrent-core release:: e gere um build novo.')
  console.log('')
  console.log(`manifest_hash da rotacao (blake3 do payload): ${bytesToHex(payload)}`)
}

run(async () => main())
