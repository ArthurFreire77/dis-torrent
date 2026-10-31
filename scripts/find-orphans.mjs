// Encontra arquivos-fonte sem nenhum importador (código morto de verdade).
//
// POR QUE NÃO UM `grep` NO SHELL: pathspec do git não expande `**` como glob de
// shell e o PowerShell não tem `xargs` confiável — a primeira tentativa marcou
// 116 arquivos como órfãos, incluindo `App.tsx` (que é o entrypoint). Aqui a
// busca é feita em TODO o texto do repositório, contando import/require/dynamic
// import por nome de módulo, e o relatório separa:
//   - `LIVRO`   : entrypoints e arquivos referenciados por config (nunca órfãos);
//   - `ORFAO`   : nenhuma referência encontrada;
//   - `SO-TESTE`: só os testes importam (não é morto, mas não vai no bundle).
//
// Uso: node scripts/find-orphans.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

/** Nunca são órfãos: entrypoint, ou carregados por ferramenta/config. */
const LIVROS = new Set([
  'src/main.tsx',      // entrypoint do Vite (index.html)
  'src/App.tsx',       // importado pelo main
  'vite.config.ts',
  'playwright.config.ts',
  'eslint.config.js',
])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const norm = (p) => relative(ROOT, p).split(sep).join('/')

const sources = walk(SRC).filter((p) => /\.(ts|tsx)$/.test(p))
const tests = walk(join(ROOT, 'tests')).filter((p) => /\.(ts|tsx)$/.test(p))
const e2e = walk(join(ROOT, 'e2e')).filter((p) => /\.(ts|tsx)$/.test(p))

// Todo texto que pode conter um import.
const corpus = [
  ...sources, ...tests, ...e2e,
  join(ROOT, 'index.html'),
  join(ROOT, 'vite.config.ts'),
  join(ROOT, 'playwright.config.ts'),
].map((p) => ({ path: norm(p), text: readFileSync(p, 'utf8') }))

/** O módulo `target` aparece como `from '.../x'` ou `'.../x.ts'` em algum arquivo? */
function referenciadoPor(target, de) {
  const base = target.replace(/\.(ts|tsx)$/, '').split('/').pop()
  // `.ts` opcional: o projeto usa as duas formas (Vite resolve ambas, mas o
  // `node --test` exige a extensão — daí a mistura).
  const re = new RegExp(`(from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*)['"][^'"]*\\b${base}(\\.tsx?)?['"]`)
  return corpus.some((f) => f.path !== de && re.test(f.text))
}

const orfaos = []
const soTeste = []
for (const file of sources) {
  const rel = norm(file)
  if (LIVROS.has(rel)) continue
  if (referenciadoPor(rel, rel)) continue
  // Quem importa? Se só os testes, é código de teste — não apagar.
  const base = rel.replace(/\.(ts|tsx)$/, '').split('/').pop()
  const re = new RegExp(`(from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*)['"][^'"]*\\b${base}(\\.tsx?)?['"]`)
  const importadoPorTeste = corpus.some(
    (f) => (f.path.startsWith('tests/') || f.path.startsWith('e2e/')) && re.test(f.text),
  )
  if (importadoPorTeste) soTeste.push(rel)
  else orfaos.push(rel)
}

console.log(`arquivos em src/: ${sources.length}`)
console.log(`\nORFAOS (nenhuma referencia em src/, tests/ nem e2e/): ${orfaos.length}`)
for (const o of orfaos.sort()) console.log('  ' + o)
console.log(`\nSO USADOS POR TESTE: ${soTeste.length}`)
for (const o of soTeste.sort()) console.log('  ' + o)
