#!/usr/bin/env node
// autoteste do scanner: secret-scan: allow
//
// Prova que o scanner PEGA o que deve pegar e nao acusa o que e referencia.
// Roda em diretorio temporario proprio (git init), nunca no repo.
// As senhas/chaves abaixo sao fixtures obvias de teste, nao segredos reais.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCANNER = join(HERE, '..', '..', 'scripts', 'scan-secrets.mjs')
const dir = mkdtempSync(join(tmpdir(), 'distorrent-scan-selftest-'))
let failures = 0
let checks = 0

function check(name, ok, detail) {
  checks += 1
  if (ok) console.log(`  ok    ${name}`)
  else {
    failures += 1
    console.log(`  FALHA ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function scan(extra = []) {
  const r = spawnSync(process.execPath, [SCANNER, '--root', dir, ...extra], { encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout ?? '' }
}

function sh(args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}

try {
  sh(['init', '-q'])
  sh(['config', 'user.email', 'test@example.invalid'])
  sh(['config', 'user.name', 'scan selftest'])
  writeFileSync(join(dir, '.gitignore'), '*.jks\n')
  mkdirSync(join(dir, 'src'), { recursive: true })

  console.log('[1] arvore limpa')
  writeFileSync(join(dir, 'src', 'app.js'), 'export const answer = 42\n')
  const clean = scan()
  check('limpa -> exit 0', clean.code === 0, clean.out.slice(-400))

  console.log('')
  console.log('[2] referencia a secret NAO e segredo')
  writeFileSync(
    join(dir, 'src', 'refs.js'),
    [
      "const a = process.env.DISTORRENT_SIGN_PASSWORD",
      "const b = '$env:DISTORRENT_SIGN_PASSWORD'",
      '// DISTORRENT_SIGN_PASSWORD=...  # so na sessao',
    ].join('\n'),
  )
  const refs = scan()
  check('referencias -> exit 0', refs.code === 0, refs.out.slice(-600))

  console.log('')
  console.log('[3] valor literal de senha BLOQUEIA')
  writeFileSync(join(dir, 'src', 'leak.js'), 'const p = "hunter2-super-secret"\nDISTORRENT_SIGN_PASSWORD="hunter2-super-secret"\n')
  const pw = scan()
  check('senha literal -> exit 1', pw.code === 1, `code=${pw.code}`)
  check('aponta o arquivo e a linha', /src\/leak\.js:2/.test(pw.stdout), pw.stdout.slice(-400))
  check('NAO imprime o valor', !pw.out.includes('hunter2'), 'VAZOU O SEGREDO')
  rmSync(join(dir, 'src', 'leak.js'))

  console.log('')
  console.log('[4] chave PEM BLOQUEIA e nao vaza conteudo')
  // Montado em runtime para o proprio scanner nao tropecar na string: o teste
  // do scanner nao pode ser a unica "chave" que ele encontra.
  const pemMarker = ['-----BEGIN', 'OPENSSH', 'PRIVATE KEY-----'].join(' ')
  const pemEnd = ['-----END', 'OPENSSH', 'PRIVATE KEY-----'].join(' ')
  writeFileSync(join(dir, 'src', 'id.txt'), `${pemMarker}\nb3BlbnNzaC1rZXk=\n${pemEnd}\n`)
  const pem = scan()
  check('PEM -> exit 1', pem.code === 1, `code=${pem.code}`)
  check('marca PEM', /PEM/.test(pem.stdout))
  check('NAO imprime base64', !pem.out.includes('b3BlbnNzaC1rZXk'), 'VAZOU O SEGREDO')
  rmSync(join(dir, 'src', 'id.txt'))

  console.log('')
  console.log('[5] arquivo com apenas 32 bytes hex BLOQUEIA (signer-N.key)')
  const seed = 'ab'.repeat(32)
  writeFileSync(join(dir, 'src', 'creds.txt'), `${seed}\n`)
  const raw = scan()
  check('seed solta -> exit 1', raw.code === 1, `code=${raw.code}`)
  check('detecta formato de chave', /apenas 64 hex|contexto de segredo/.test(raw.stdout), raw.stdout.slice(-500))
  check('NAO imprime a semente', !raw.out.includes(seed), 'VAZOU A CHAVE')
  rmSync(join(dir, 'src', 'creds.txt'))

  console.log('')
  console.log('[6] hex em contexto de segredo BLOQUEIA; hash solto nao')
  writeFileSync(join(dir, 'src', 'ctx.js'), `const signingKey = "${seed}"\n`)
  const ctx = scan()
  check('contexto de segredo -> exit 1', ctx.code === 1, `code=${ctx.code}`)
  rmSync(join(dir, 'src', 'ctx.js'))
  writeFileSync(join(dir, 'src', 'hash.js'), `export const sha = "${'cd'.repeat(32)}"\n`)
  const hash = scan()
  check('hash sem contexto -> exit 0', hash.code === 0, hash.out.slice(-500))
  rmSync(join(dir, 'src', 'hash.js'))

  console.log('')
  console.log('[7] nome de arquivo sensivel')
  writeFileSync(join(dir, 'src', 'server.pem'), 'nao e chave, mas a extensao manda tratar assim\n')
  const pemName = scan()
  check('*.pem nao ignorado -> exit 1', pemName.code === 1, `code=${pemName.code}`)
  check('diz para nao usar git add -A', /git add -A/.test(pemName.stdout))
  rmSync(join(dir, 'src', 'server.pem'))

  // Arquivo ignorado pelo .gitignore nao bloqueia, mas aparece como nota.
  writeFileSync(join(dir, 'src', 'debug.jks'), 'binario\n')
  const ignored = scan()
  check('*.jks ignorado -> exit 0', ignored.code === 0, ignored.out.slice(-500))
  check('reporta o ignorado', /ignorados: 1/.test(ignored.stdout), ignored.stdout.slice(-400))
  rmSync(join(dir, 'src', 'debug.jks'))

  console.log('')
  console.log('[8] arquivo sensivel VERSIONADO no git BLOQUEIA')
  writeFileSync(join(dir, 'src', 'tracked.key'), 'x\n')
  sh(['add', '-f', 'src/tracked.key'])
  const tracked = scan()
  check('*.key versionado -> exit 1', tracked.code === 1, `code=${tracked.code}`)
  check('diz que esta no git', /versionado no git/.test(tracked.stdout), tracked.stdout.slice(-500))
  sh(['rm', '--cached', '-q', 'src/tracked.key'])
  rmSync(join(dir, 'src', 'tracked.key'))

  console.log('')
  console.log('[9] volta a PASS depois de limpar')
  const final = scan()
  check('limpo -> exit 0', final.code === 0, final.out.slice(-400))
  check('imprime PASS', /PASS/.test(final.stdout))
} finally {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    console.log(`aviso: nao consegui apagar ${dir}`)
  }
}

console.log('')
if (failures === 0) {
  console.log(`PASS  autoteste do scanner: ${checks}/${checks} verificacoes`)
  process.exit(0)
}
console.log(`FAIL  autoteste do scanner: ${failures} de ${checks} falharam`)
process.exit(1)
