// Publica a release pela TAG e sobe os assets.
// Uso: node scripts/publish-release.mjs <tag> <notesFile> <asset> [asset...]
//
// POR QUE NODE: o PowerShell 5.1 grava o corpo como latin1 e o GitHub responde
// "Problems parsing JSON" com qualquer acento. Aqui o corpo é Buffer utf-8 e o
// asset sobe como stream, sem carregar 10-40 MB na memória do shell.
import { execFileSync } from 'node:child_process'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'

const [tag, notesFile, ...assets] = process.argv.slice(2)
if (!tag || !notesFile || assets.length === 0) {
  console.error('uso: node scripts/publish-release.mjs <tag> <notesFile> <asset...>')
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
  if (!res.ok) throw new Error(`${res.status} ${url}\n${text.slice(0, 600)}`)
  return text ? JSON.parse(text) : null
}

let rel = null
try {
  rel = await ghub(`${api}/releases/tags/${tag}`)
  console.log(`release existente: id=${rel.id}`)
} catch (e) {
  if (!String(e.message).startsWith('404')) throw e
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const body = JSON.stringify({
    tag_name: tag,
    target_commitish: head,
    name: `DisTorrent ${tag.replace(/^v/, '')}-pre-alpha`,
    body: readFileSync(notesFile, 'utf8'),
    draft: false,
    prerelease: false,
  })
  rel = await ghub(`${api}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body,
  })
  console.log(`release criada: id=${rel.id}`)
  console.log(rel.html_url)
}

const existing = new Map((rel.assets ?? []).map((a) => [a.name, a.id]))
for (const path of assets) {
  const name = basename(path)
  if (existing.has(name)) {
    console.log(`ja publicado, pulando: ${name}`)
    continue
  }
  const size = statSync(path).size
  const sha = await new Promise((res, rej) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej)
  })
  console.log(`subindo ${name} (${(size / 1048576).toFixed(2)} MB) sha256=${sha}`)
  const up = `https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`
  const out = await ghub(up, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
    body: createReadStream(path),
    duplex: 'half',
  })
  console.log(`  ok: id=${out.id} state=${out.state} digest=${out.digest}`)
}

const final = await ghub(`${api}/releases/tags/${tag}`)
console.log('')
console.log(`== ${final.name} ==`)
console.log(`url: ${final.html_url}`)
for (const a of final.assets ?? []) {
  console.log(`  ${a.name.padEnd(52)} ${(a.size / 1048576).toFixed(1)} MB  ${a.digest ?? '(sem digest)'}`)
}
