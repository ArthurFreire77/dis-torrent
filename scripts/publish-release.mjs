/**
 * Publica a release da versão do package.json no GitHub.
 *
 * - Resolve a release PELA TAG (nunca por id fixo: id fixo foi o que subiu
 *   arquivos da 1.1.45 na 1.1.44 e apagou o AppImage).
 * - Sobe só instalador: .exe, .deb, .AppImage e .apk.
 * - Não apaga asset de release nenhuma.
 *
 * Uso: node scripts/publish-release.mjs [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const REPO = 'ArthurFreire77/dis-torrent'
const DRY = process.argv.includes('--dry')

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const version = pkg.version // 1.1.56-pre-alpha
const tag = `v${version.replace(/-pre-alpha$/, '')}` // v1.1.56
const name = `DisTorrent ${version}`

async function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  // Credencial do Credential Manager, via git (o formato do `fill` é
  // `key=value` por linha; lemos só a linha do password).
  try {
    const out = execSync('git credential fill', {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
    })
    const m = /^password=(.+)$/m.exec(out)
    return m?.[1]?.trim() || null
  } catch {
    return null
  }
}

const password = await githubToken()
if (!password) {
  console.error('sem credencial do git para github.com (defina GITHUB_TOKEN)')
  process.exit(1)
}

const H = {
  Authorization: `Bearer ${password}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'distorrent-release',
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { ...H, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* corpo não-JSON */
  }
  return { status: res.status, json, text }
}

function findAsset(dir, pattern) {
  if (!fs.existsSync(dir)) return null
  // Só a versão desta release: o diretório de bundle acumula todas as antigas,
  // e pegar o primeiro .exe/.deb subiria binário de versão errada.
  const hits = fs
    .readdirSync(dir)
    .filter((f) => pattern.test(f) && f.includes(version))
    .sort()
  return hits.length ? path.join(dir, hits[hits.length - 1]) : null
}

const candidates = [
  {
    label: '.exe (instalador Inno)',
    file: findAsset('src-tauri/target/release/bundle/inno', /_x64_setup\.exe$/i),
  },
  {
    label: '.deb',
    file: findAsset('src-tauri/target/release/bundle/deb', /_amd64\.deb$/i),
  },
  {
    label: '.AppImage',
    file: findAsset('src-tauri/target/release/bundle/appimage', /\.AppImage$/i),
  },
  {
    label: '.apk',
    file:
      findAsset('src-tauri/target/release/bundle/apk', /_arm64.*\.apk$/i) ??
      findAsset('src-tauri/gen/android/app/build/outputs/apk/arm64/release', /\.apk$/i),
  },
]

console.log(`release: ${name}  (tag ${tag})`)
for (const c of candidates) {
  console.log(`  ${c.label}: ${c.file ?? 'AUSENTE'}`)
}
if (DRY) process.exit(0)

const missing = candidates.filter((c) => !c.file)
if (missing.length) {
  console.error(
    `faltam ${missing.length} arquivo(s): ${missing.map((m) => m.label).join(', ')} — nada foi publicado`,
  )
  process.exit(1)
}

// 1) Resolve/cria a release pela TAG.
let rel = await api('GET', `https://api.github.com/repos/${REPO}/releases/tags/${tag}`)
if (rel.status === 404) {
  console.log('criando release...')
  const created = await api('POST', `https://api.github.com/repos/${REPO}/releases`, {
    tag_name: tag,
    name,
    prerelease: false,
    draft: false,
    generate_release_notes: false,
    body: fs.existsSync('CHANGELOG.md')
      ? fs
          .readFileSync('CHANGELOG.md', 'utf8')
          .split('\n## [')[1]
          ?.split('\n## [')[0]
          ?.slice(0, 60000) ?? ''
      : '',
  })
  if (created.status >= 300) {
    console.error('falha ao criar release:', created.status, created.text.slice(0, 400))
    process.exit(1)
  }
  rel = created
}
if (rel.status >= 300) {
  console.error('falha ao consultar release:', rel.status, rel.text.slice(0, 400))
  process.exit(1)
}
const release = rel.json
console.log(`release id ${release.id} (${release.tag_name}) — ${release.assets.length} asset(s)`)

// 2) Sobe cada arquivo; reusa o asset existente (não cria duplicata).
for (const c of candidates) {
  const filename = path.basename(c.file)
  const existing = release.assets.find((a) => a.name === filename)
  if (existing) {
    console.log(`· ${filename} já está na release (${existing.size} bytes) — mantido`)
    continue
  }
  const buf = fs.readFileSync(c.file)
  const sameName = release.assets.find((a) => a.name === filename)
  const url = sameName
    ? `https://uploads.github.com/repos/${REPO}/releases/assets/${sameName.id}`
    : `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(filename)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...H,
      'content-type': 'application/octet-stream',
      'content-length': String(buf.length),
    },
    body: buf,
  })
  const text = await res.text()
  if (res.status >= 300) {
    console.error(`FALHOU ${filename}: ${res.status} ${text.slice(0, 300)}`)
    process.exitCode = 1
  } else {
    console.log(`✓ ${filename} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`)
  }
}

// 3) Confere o resultado final.
const final = await api('GET', `https://api.github.com/repos/${REPO}/releases/tags/${tag}`)
const assets = final.json?.assets ?? []
console.log(`\nrelease ${tag}: ${assets.length} asset(s)`)
for (const a of assets) {
  console.log(`  ${a.name}  ${(a.size / 1024 / 1024).toFixed(2)} MB  digest=${a.digest ?? 'AUSENTE'}`)
}
const faltaDigest = assets.filter((a) => !a.digest)
if (faltaDigest.length) {
  console.log(`\nAVISO: ${faltaDigest.length} asset(s) sem digest SHA-256`)
}
