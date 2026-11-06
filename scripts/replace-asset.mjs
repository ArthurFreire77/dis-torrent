// Substitui um asset da release quando o binário foi reconstruído.
// Uso: node scripts/replace-asset.mjs <tag> <arquivo> [...]
//
// Reconstruir muda o SHA256, e o app se recusa a executar instalador cujo digest
// não bate. Então o asset antigo é APAGADO e o novo sobe com o mesmo nome — não
// dá para deixar os dois (o GitHub rejeita nome duplicado na mesma release).
import { execFileSync } from 'node:child_process'
import { createReadStream, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'

const [tag, ...files] = process.argv.slice(2)
if (!tag || files.length === 0) {
  console.error('uso: node scripts/replace-asset.mjs <tag> <arquivo...>')
  process.exit(2)
}

const repo = 'ArthurFreire77/dis-torrent'
const cred = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
})
const token = (cred.match(/^password=(.*)$/m) ?? [])[1]?.trim()
if (!token) throw new Error('sem credencial do git')

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

const rel = await ghub(`${api}/releases/tags/${tag}`)
const porNome = new Map((rel.assets ?? []).map((a) => [a.name, a]))

for (const path of files) {
  const name = basename(path)
  const antigo = porNome.get(name)
  const size = statSync(path).size
  const sha = await new Promise((res, rej) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej)
  })

  if (antigo?.digest === `sha256:${sha}`) {
    console.log(`sem mudanca, pulando: ${name}`)
    continue
  }
  if (antigo) {
    console.log(`apagando versao antiga de ${name} (id=${antigo.id})`)
    await ghub(`${api}/releases/assets/${antigo.id}`, { method: 'DELETE' })
  }
  console.log(`subindo ${name} (${(size / 1048576).toFixed(2)} MB) sha256=${sha}`)
  const up = `https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`
  const out = await ghub(up, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
    body: createReadStream(path),
    duplex: 'half',
  })
  console.log(`  ok: digest=${out.digest}`)
}

const final = await ghub(`${api}/releases/tags/${tag}`)
console.log('')
console.log(`== ${final.name} ==`)
for (const a of final.assets ?? []) {
  console.log(`  ${a.name.padEnd(52)} ${(a.size / 1048576).toFixed(1)} MB  ${a.digest ?? '(sem digest)'}`)
}
