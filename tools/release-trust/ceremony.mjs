#!/usr/bin/env node
// Cerimonia offline: gera as chaves de assinatura de release e a linha de
// confianca que o build embute. Roda em maquina sem rede; as chaves privadas
// NUNCA entram no repositorio (o diretorio padrao e fora dele).

import {
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as ed from '@noble/ed25519'

import {
  MIN_THRESHOLD,
  MAX_TRUST_KEYS,
  ToolError,
  bytesToHex,
  fail,
  formatTrustSet,
  humanBytes,
  keyFromSecret,
  parseArgv,
  run,
} from './lib.mjs'

const DEFAULT_DIR = join(homedir(), '.distorrent-release-keys')
const RELATIVE_TRUST_KEYS = 'distorrent-core/src/release/trust_keys.rs'

function usage() {
  console.log(`uso: node tools/release-trust/ceremony.mjs --init [opcoes]

  --init                  gera o conjunto inicial (obrigatorio)
  --dir <path>            diretorio das chaves (padrao: ${DEFAULT_DIR})
  --keys <n>              quantidade de chaves, ${MIN_THRESHOLD}..${MAX_TRUST_KEYS} (padrao 3)
  --threshold <n>         assinaturas minimas, ${MIN_THRESHOLD}..keys (padrao 2)
  --epoch <n>             epoch do conjunto de confianca (padrao 1)
  --force                 sobrescreve chaves existentes (PERDE as antigas)

As chaves privadas ficam em <dir>/signer-N.key (32 bytes hex, modo 0600) e a
linha de confianca em <dir>/trust-set.txt. O script NAO escreve no repositorio:
ele imprime o snippet para colar em ${RELATIVE_TRUST_KEYS}.`)
}

function parseArgs(argv) {
  const args = parseArgv(argv, { flags: ['init', 'force', 'help'] })
  if (args.has('help')) {
    usage()
    process.exit(0)
  }
  if (!args.has('init')) {
    usage()
    fail('--init e obrigatorio (este script nao altera um conjunto existente)')
  }
  const dir = resolve(args.get('dir') ?? DEFAULT_DIR)
  const keys = Number(args.get('keys') ?? 3)
  const threshold = Number(args.get('threshold') ?? MIN_THRESHOLD)
  const epoch = Number(args.get('epoch') ?? 1)
  return { dir, keys, threshold, epoch, force: args.has('force') }
}

function validateArgs({ keys, threshold, epoch }) {
  if (!Number.isSafeInteger(keys) || keys < MIN_THRESHOLD || keys > MAX_TRUST_KEYS) {
    fail(`--keys precisa estar entre ${MIN_THRESHOLD} e ${MAX_TRUST_KEYS}`)
  }
  if (!Number.isSafeInteger(threshold) || threshold < MIN_THRESHOLD || threshold > keys) {
    fail(`--threshold precisa estar entre ${MIN_THRESHOLD} e --keys`)
  }
  if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch > 1_000_000) {
    fail('--epoch precisa estar entre 1 e 1000000')
  }
}

function isPosix() {
  return process.platform !== 'win32'
}

// Escreve a chave e restringe o acesso. No Windows nao existe chmod; o arquivo
// herda a ACL do diretorio, entao o aviso e parte da saida, nao um detalhe.
function writeSecret(path, secretHex, force) {
  // 'wx' falha se o arquivo apareceu entre a checagem e a escrita; sem essa
  // corrida, duas cerimonias simultaneas gravariam em cima uma da outra.
  writeFileSync(path, `${secretHex}\n`, { mode: 0o600, flag: force ? 'w' : 'wx' })
  if (isPosix()) {
    chmodSync(path, 0o600)
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  validateArgs(args)

  const targetDir = args.dir
  const keyPaths = Array.from({ length: args.keys }, (_, i) =>
    join(targetDir, `signer-${i + 1}.key`),
  )
  const trustPath = join(targetDir, 'trust-set.txt')
  const clobber = [...keyPaths, trustPath].filter((p) => existsSync(p))

  if (clobber.length > 0 && !args.force) {
    throw new ToolError(
      `arquivos ja existem (nada foi tocado):\n${clobber
        .map((p) => `  ${p}`)
        .join('\n')}\n` +
        'Use outro --dir ou --force. Com --force as chaves antigas saem do ar e\n' +
        'TODA release ja assinada por elas deixa de verificar contra o novo conjunto.',
    )
  }

  if (args.force && clobber.length > 0) {
    console.warn('')
    console.warn('  ####################################################################')
    console.warn('  #  --force: gerando um conjunto NOVO por cima das chaves antigas.  #')
    console.warn('  #  As chaves sobrescritas nao voltam. As assinaturas que elas     #')
    console.warn('  #  produziram NAO verificam mais contra o novo conjunto.           #')
    console.warn('  #  Se a intencao era trocar de chaves, o caminho e rotate-keys.   #')
    console.warn('  ####################################################################')
    console.warn('')
  }

  mkdirSync(targetDir, { recursive: true })

  const generated = []
  for (let i = 0; i < args.keys; i += 1) {
    const seed = randomBytes(32)
    const key = keyFromSecret(seed)
    writeSecret(keyPaths[i], bytesToHex(seed), args.force)
    generated.push({ key, path: keyPaths[i] })
  }

  const trustSet = {
    epoch: args.epoch,
    threshold: args.threshold,
    keys: generated.map(({ key }) => ({
      keyId: key.keyId,
      pubkeyHex: key.pubkeyHex,
    })),
  }
  const trustLine = formatTrustSet(trustSet)
  writeFileSync(trustPath, `${trustLine}\n`, 'utf8')

  console.log('')
  console.log(`Conjunto gerado: epoch=${args.epoch} threshold=${args.threshold} chaves=${args.keys}`)
  console.log(`Diretorio: ${targetDir}`)
  console.log('')
  console.log('Chaves privadas (segredo NUNCA impresso; guarde cada uma offline):')
  for (const { key, path } of generated) {
    console.log(`  ${path}`)
    console.log(`    key_id    ${key.keyId}`)
    console.log(`    pubkey    ${key.pubkeyHex}`)
  }
  console.log('')
  console.log(`Linha de confianca (tambem em ${trustPath}):`)
  console.log(`  ${trustLine}`)
  console.log('')
  console.log(`Cole MANUALMENTE em ${RELATIVE_TRUST_KEYS}:`)
  console.log('')
  console.log('pub const TRUST_SET_BOOTSTRAP: &str =')
  console.log(`    "${trustLine}";`)
  console.log('')
  console.log('Depois: cargo test -p distorrent-core release::')

  if (isPosix()) {
    console.log('')
    console.log('Modo dos arquivos de chave: 0600 (somente o dono le/escreve).')
  } else {
    console.log('')
    console.log('ATENCAO (Windows): nao existe chmod. Os arquivos herdam a ACL NTFS do')
    console.log(`diretorio ${targetDir}. Garanta que:`)
    console.log('  - o diretorio esta numa unidade NTFS criptografada (BitLocker) ou')
    console.log('    num volume offline removivel que fica guardado fisicamente;')
    console.log('  - somente a sua conta tem acesso a essa pasta (Properties > Security);')
    console.log('  - o disco nao e sincronizado com OneDrive/backup em nuvem.')
  }

  const total = generated.length * 32
  console.log('')
  console.log(`Tamanho das chaves: ${generated.length} x 32 bytes (${humanBytes(total)} de segredo).`)
  console.log('Nada foi escrito dentro do repositorio.')
}

run(async () => main())
