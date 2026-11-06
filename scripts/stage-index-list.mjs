// Regera tests/index.ts a partir do HEAD + só as linhas desta rodada, e
// estagia só esse arquivo. O working tree mantém o que os outros agentes
// adicionaram (não tocamos nele).
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const head = execFileSync('git', ['show', 'HEAD:tests/index.ts'], { encoding: 'utf8' })
const work = readFileSync('tests/index.ts', 'utf8')

const meuSchema = "import './botSchemaV3.test.ts'"
const meuDoc = "import './botsDocSync.test.ts'"
const meuWin = "import './botsWindow.test.ts'"

let out = head
if (!out.includes(meuSchema)) {
  out = out.replace(
    "import './botRuntime.test.ts'\n",
    `import './botRuntime.test.ts'\n${meuSchema}\n${meuDoc}\n`,
  )
}
if (!out.includes(meuWin)) {
  out = out.replace(
    "import './windowBoot.test.ts'\n",
    `import './windowBoot.test.ts'\n${meuWin}\n`,
  )
}
// sanity: tudo que o HEAD importa continua importado
for (const line of head.split('\n')) {
  if (line.startsWith('import ') && !out.includes(line)) {
    throw new Error('perdi um import do HEAD: ' + line)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'idx-'))
const blob = join(dir, 'index.ts')
writeFileSync(blob, out, 'utf8')
const hash = execFileSync('git', ['hash-object', '-w', blob], { encoding: 'utf8' }).trim()
execFileSync('git', ['update-index', '--cacheinfo', `100644,${hash},tests/index.ts`])
console.log('tests/index.ts do stage = HEAD + 3 imports; working tree intocado')
console.log('imports no stage:', out.split('\n').filter((l) => l.startsWith('import ')).length)
console.log('imports no working tree:', work.split('\n').filter((l) => l.startsWith('import ')).length)
