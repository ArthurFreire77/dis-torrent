// Separa os hunks que são DESTA rodada dos que são de outro agente no mesmo
// arquivo. Sem isso, `git add <arquivo>` levaria trabalho alheio junto.
//
// Uso: node scripts/stage-hunks.mjs <arquivo> <hunkInicial> [hunkInicial...]
// Cada número é o `-N` do cabeçalho `@@ -N,M +N,M @@` do diff atual.
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [file, ...want] = process.argv.slice(2)
if (!file || want.length === 0) {
  console.error('uso: node scripts/stage-hunks.mjs <arquivo> <hunkInicial> [...]')
  process.exit(2)
}
const wanted = new Set(want.map(Number))

const diff = execFileSync('git', ['diff', '-U3', '--', file], { encoding: 'utf8' })
const lines = diff.split('\n')
const headerEnd = lines.findIndex((l) => l.startsWith('@@'))
if (headerEnd < 0) {
  console.log('nada para estagiar em ' + file)
  process.exit(0)
}

const header = lines.slice(0, headerEnd)
const hunks = []
let cur = null
for (const line of lines.slice(headerEnd)) {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
  if (m) {
    if (cur) hunks.push(cur)
    cur = { start: Number(m[1]), lines: [line] }
  } else if (cur) {
    cur.lines.push(line)
  }
}
if (cur) hunks.push(cur)

const chosen = hunks.filter((h) => wanted.has(h.start))
if (chosen.length === 0) {
  console.error('nenhum hunk casou; disponíveis: ' + hunks.map((h) => h.start).join(', '))
  process.exit(3)
}
const body = [...header, ...chosen.flatMap((h) => h.lines)].join('\n')
const text = body.endsWith('\n') ? body : body + '\n'

const dir = mkdtempSync(join(tmpdir(), 'hunks-'))
const patch = join(dir, 'p.patch')
writeFileSync(patch, text, 'utf8')
execFileSync('git', ['apply', '--cached', patch], { stdio: 'inherit' })
console.log(
  `estagiado ${file}: ${chosen.length} de ${hunks.length} hunk(s) [${chosen.map((h) => h.start).join(', ')}]`,
)
