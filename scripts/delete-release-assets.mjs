// Apaga assets de uma release pelo NOME (republicar a mesma tag com bytes
// diferentes). O publish-release.mjs PULA assets existentes, então sem isto o
// arquivo antigo continua no ar com o hash velho e o manifesto novo aponta
// para bytes que não existem mais.
//
// Uso: node scripts/delete-release-assets.mjs <tag> <nome> [nome...]
import { execFileSync } from 'node:child_process'

const [tag, ...names] = process.argv.slice(2)
if (!tag || names.length === 0) {
  console.error('uso: node scripts/delete-release-assets.mjs <tag> <nome-do-asset> [nome...]')
  process.exit(2)
}

const repo = 'ArthurFreire77/dis-torrent'
const cred = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
})
const token = (cred.match(/^password=(.*)$/m) ?? [])[1]?.trim()
if (!token) throw new Error('sem credencial do git para github.com')

const H = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
}
const api = `https://api.github.com/repos/${repo}`

async function ghub(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...H, ...(init.headers ?? {}) } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${url}\n${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : null
}

// Resolve o release ID pela TAG a cada execução: ID fixo já publicou assets na
// release errada neste projeto.
const rel = await ghub(`${api}/releases/tags/${tag}`)
console.log(`release ${tag}: id=${rel.id}`)

const byName = new Map((rel.assets ?? []).map((a) => [a.name, a.id]))
let apagados = 0
for (const name of names) {
  const id = byName.get(name)
  if (!id) {
    console.log(`  (já ausente) ${name}`)
    continue
  }
  await ghub(`${api}/releases/assets/${id}`, { method: 'DELETE' })
  console.log(`  apagado: ${name} (id=${id})`)
  apagados++
}
console.log(`\n${apagados} asset(s) apagado(s).`)

const final = await ghub(`${api}/releases/tags/${tag}`)
console.log('\nrestantes:')
for (const a of final.assets ?? []) {
  console.log(`  ${a.name.padEnd(50)} ${(a.size / 1048576).toFixed(2)} MB  ${a.digest ?? '(sem digest)'}`)
}
