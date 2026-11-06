#!/usr/bin/env node
// Varredura de segredos na arvore de trabalho.
//
// Objetivo: impedir que chave privada, keystore ou senha de assinatura entre no
// repositorio. NUNCA imprime o conteudo encontrado: so arquivo, linha e uma
// dica redigida. O log de CI tambem e publico, entao ele nao pode virar o
// vazamento que a varredura tenta evitar.
//
// Regras (o que BLOQUEIA):
//   1. bloco `-----BEGIN ... PRIVATE KEY-----`
//   2. atribuicao real (nao referencia nem placeholder) de
//      WINDOWS_CERT_PFX_BASE64 / DISTORRENT_SIGN_PASSWORD
//   3. hex de 32 bytes (chave ed25519) ou 64 bytes em contexto de segredo
//   4. arquivo de chave/keystore versionado no git
//   5. conteudo de `signer-N.key` (hex unico) fora do diretorio de chaves
//
// Uso: node scripts/scan-secrets.mjs [--root <dir>] [--verbose]
// Sai 0 = PASS, 1 = achado bloqueante, 2 = erro de uso.

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'dist-release',
  'dist-ssr',
  'test-results',
  'playwright-report',
  'blob-report',
  '.gradle',
  'cmdline-tools',
  '.playwright-mcp',
  '.vite',
])

// Arquivos sensiveis que o projeto versiona DE PROPOSITO e que sao publicos.
// Ficar visivel na saida (AVISO) e melhor do que uma excecao silenciosa.
const KNOWN_PUBLIC = new Map([
  [
    'src-tauri/gen/android/app/debug.keystore',
    'keystore de DEBUG do template Android: a chave e publica e o Gradle exige o arquivo',
  ],
])

const SENSITIVE_EXT = /\.(key|pem|pfx|p12|jks|keystore)$/i
const PEM_PRIVATE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/
const ENV_NAMES = ['WINDOWS_CERT_PFX_BASE64', 'DISTORRENT_SIGN_PASSWORD']
// Atribuicao: NAME = valor / NAME: valor / $env:NAME = valor / export NAME=valor
const ENV_ASSIGN = new RegExp(
  `(?:^|[\\s$])(?:env:)?(?:export\\s+)?(${ENV_NAMES.join('|')})\\s*[:=]\\s*(.*)$`,
)
// Valor que NAO e segredo: referencia a secret, variavel, placeholder ou vazio.
const PLACEHOLDER = /^(?:['"]{2}|['"]?(?:\$\{\{.*\}\}|\$env:[A-Za-z_]\w*|\$\{?[A-Za-z_]\w*\}?|secrets\.\S+|env\.\S*|process\.env\.\S+|<[^>]*>|\.\.\.|xxx+|\*+)?['"]?)\s*(?:#.*)?$/

const HEX64 = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/
const HEX128 = /(?<![0-9a-fA-F])[0-9a-fA-F]{128}(?![0-9a-fA-F])/
const STANDALONE_HEX = /^[0-9a-fA-F]{64}$/ // 32 bytes: semente de chave
// Nome de variavel/campo que denuncia segredo quando precede um hex.
const SECRET_CONTEXT =
  /(?:secret|private|priv[_\-]?key|seed|signing[_\-]?key|master[_\-]?key|\bsk)\w*\s*[:=]\s*["'`]?\s*$/i

const MAX_SCAN_BYTES = 4 * 1024 * 1024
// Diretiva para fixture de teste, mesma convencao de
// `distorrent-core/tests/release_vector.rs`. Vale na propria linha ou na
// anterior. Nao e' um "ignore" generico: o marcador e' explicito e revisavel.
const SCAN_ALLOW = /secret-scan:\s*allow/

function parseArgs(argv) {
  const out = { root: process.cwd(), verbose: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--verbose' || a === '-v') out.verbose = true
    else if (a === '--root') {
      out.root = argv[i + 1]
      i += 1
    } else if (a === '--help' || a === '-h') {
      console.log('uso: node scripts/scan-secrets.mjs [--root <dir>] [--verbose]')
      process.exit(0)
    } else {
      console.error(`argumento desconhecido: ${a}`)
      process.exit(2)
    }
  }
  if (!out.root) {
    console.error('--root exige um diretorio')
    process.exit(2)
  }
  return out
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true
  return false
}

function walk(dir, root, files) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(full, root, files)
      continue
    }
    if (!e.isFile()) continue
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    files.push({ full, rel: relative(root, full).split(sep).join('/'), size: st.size })
  }
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function gitState(root) {
  try {
    const list = git(root, ['ls-files', '-z'])
    const tracked = new Set(list.split('\0').filter(Boolean))
    return { ok: true, tracked }
  } catch {
    return { ok: false, tracked: new Set() }
  }
}

function isIgnored(root, rel) {
  try {
    git(root, ['check-ignore', '-q', '--', rel])
    return true
  } catch {
    return false
  }
}

// Valor de uma atribuicao e segredo de verdade? Referencia e placeholder nao sao.
function realSecretValue(raw) {
  const v = raw.trim()
  if (v === '') return false
  return !PLACEHOLDER.test(v)
}

function scanFile(entry, findings, verbose) {
  if (entry.size === 0 || entry.size > MAX_SCAN_BYTES) return
  let buf
  try {
    buf = readFileSync(entry.full)
  } catch {
    return
  }
  if (isBinary(buf)) return
  const text = buf.toString('utf8')

  // Arquivo cujo conteudo inteiro e um hex unico de 32 bytes: e exatamente o
  // formato de `signer-N.key`. Fora de um diretorio de chaves, isso e chave
  // privada vazando — mesmo que a extensao nao diga nada.
  const trimmed = text.trim()
  if (STANDALONE_HEX.test(trimmed)) {
    if (SCAN_ALLOW.test(text)) return
    findings.push({
      level: 'fail',
      rel: entry.rel,
      line: 0,
      why: 'arquivo contem apenas 64 hex (32 bytes) — forma exata de chave privada ed25519',
    })
    return
  }

  const lines = text.split(/\r?\n/)
  const underTooling = /^(?:tools|scripts)\//.test(entry.rel)
  // A diretiva pode valer para o arquivo inteiro (fixture no topo) ou por linha.
  // `signer-N.key` real nunca tem esse marcador.
  const allowWholeFile = SCAN_ALLOW.test(lines.slice(0, 40).join('\n'))

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const ln = i + 1
    const allowed =
      allowWholeFile || SCAN_ALLOW.test(line) || (i > 0 && SCAN_ALLOW.test(lines[i - 1]))
    if (allowed) continue

    if (PEM_PRIVATE.test(line)) {
      findings.push({
        level: 'fail',
        rel: entry.rel,
        line: ln,
        why: 'bloco de chave privada PEM (conteudo redigido)',
      })
      continue
    }

    let handled = false
    const env = line.match(ENV_ASSIGN)
    if (env) {
      handled = true
      const [, name, value] = env
      if (realSecretValue(value)) {
        findings.push({
          level: 'fail',
          rel: entry.rel,
          line: ln,
          why: `atribuicao de ${name} com valor literal (valor redigido)`,
        })
      } else if (verbose) {
        findings.push({
          level: 'warn',
          rel: entry.rel,
          line: ln,
          why: `${name} citada, mas o valor e referencia/placeholder (nao e segredo)`,
        })
      }
    }
    if (handled) continue

    const first64 = line.search(HEX64)
    const hasContext =
      first64 >= 0 && SECRET_CONTEXT.test(line.slice(Math.max(0, first64 - 80), first64))

    if (first64 >= 0 && hasContext) {
      findings.push({
        level: 'fail',
        rel: entry.rel,
        line: ln,
        why: 'hex de 32 bytes em contexto de segredo (chave privada ed25519; valor redigido)',
      })
      continue
    }
    if (HEX128.test(line) && hasContext) {
      findings.push({
        level: 'fail',
        rel: entry.rel,
        line: ln,
        why: 'hex de 64 bytes em contexto de segredo (valor redigido)',
      })
      continue
    }
    if (first64 >= 0 && underTooling) {
      findings.push({
        level: 'warn',
        rel: entry.rel,
        line: ln,
        why: 'hex de 32 bytes em ferramenta de assinatura — confirme que e pubkey/hash, nao semente',
      })
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = resolve(args.root)
  const findings = []
  const notes = []
  const state = gitState(root)
  if (!state.ok) {
    notes.push('git indisponivel: nao deu para checar arquivos versionados nem .gitignore')
  }

  // 1) Arquivos de chave/keystore versionados no git.
  let trackedSensitive = 0
  for (const rel of state.tracked) {
    if (!SENSITIVE_EXT.test(rel)) continue
    trackedSensitive += 1
    if (KNOWN_PUBLIC.has(rel)) {
      findings.push({
        level: 'warn',
        rel,
        line: 0,
        why: `versionado no git, mas publico por projeto: ${KNOWN_PUBLIC.get(rel)}`,
      })
    } else {
      findings.push({
        level: 'fail',
        rel,
        line: 0,
        why: 'arquivo de chave/keystore versionado no git',
      })
    }
  }

  // 2) Conteudo de toda a arvore de trabalho.
  const files = []
  walk(root, root, files)
  let ignoredSensitive = 0
  for (const f of files) {
    if (SENSITIVE_EXT.test(f.rel) && !state.tracked.has(f.rel)) {
      // Sem git, ou sem regra de ignore, `git add -A` levaria o arquivo.
      if (state.ok && isIgnored(root, f.rel)) {
        ignoredSensitive += 1
        if (args.verbose) {
          findings.push({
            level: 'warn',
            rel: f.rel,
            line: 0,
            why: 'arquivo de chave/keystore na arvore, coberto pelo .gitignore',
          })
        }
        continue
      }
      findings.push({
        level: 'fail',
        rel: f.rel,
        line: 0,
        why: state.ok
          ? 'arquivo de chave/keystore NAO ignorado pelo git (git add -A o levaria)'
          : 'arquivo de chave/keystore presente e git indisponivel para dizer se e ignorado',
      })
    }
    scanFile(f, findings, args.verbose)
  }

  const fails = findings.filter((f) => f.level === 'fail')
  const warns = findings.filter((f) => f.level === 'warn')

  console.log('varredura de segredos - DisTorrent')
  console.log(`  raiz:      ${root}`)
  console.log(`  arquivos:  ${files.length} (fora de ${[...SKIP_DIRS].join(', ')})`)
  console.log(
    `  git:       ${state.ok ? `${state.tracked.size} versionados, ${trackedSensitive} com extensao sensivel` : 'indisponivel'}`,
  )
  if (ignoredSensitive > 0) {
    console.log(`  ignorados: ${ignoredSensitive} arquivo(s) sensivel(is) coberto(s) pelo .gitignore`)
  }
  for (const n of notes) console.log(`  nota:      ${n}`)
  console.log('')

  for (const f of findings) {
    const where = f.line > 0 ? `${f.rel}:${f.line}` : f.rel
    console.log(`  ${f.level === 'fail' ? 'FALHA' : 'AVISO'}  ${where}`)
    console.log(`         ${f.why}`)
  }
  if (findings.length > 0) console.log('')

  console.log('Resumo por regra:')
  console.log(`  chave privada PEM .............. ${count(findings, 'PEM')}`)
  console.log(`  variavel de assinatura literal . ${count(findings, 'valor literal')}`)
  console.log(`  hex com cara de segredo ........ ${count(findings, 'contexto de segredo')}`)
  console.log(`  conteudo de signer-N.key ....... ${count(findings, 'apenas 64 hex')}`)
  console.log(`  chave/keystore (git) ........... ${count(findings, 'versionado no git') + count(findings, 'NAO ignorado')}`)
  console.log('')

  if (fails.length > 0) {
    console.log(`FAIL  ${fails.length} achado(s) bloqueante(s), ${warns.length} aviso(s)`)
    console.log('      Nada do conteudo foi impresso. Remova o arquivo/segredo e ROTACIONE a')
    console.log('      chave: se ela chegou a ser commitada, o historico ja a expoe.')
    process.exit(1)
  }

  if (warns.length > 0) {
    console.log(`PASS  nenhum segredo bloqueante (${warns.length} aviso(s) acima)`)
    process.exit(0)
  }

  console.log('PASS  nenhum segredo encontrado')
  process.exit(0)
}

function count(findings, needle) {
  return findings.filter((f) => f.why.includes(needle)).length
}

main()
