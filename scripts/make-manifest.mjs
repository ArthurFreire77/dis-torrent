// Gera o release-<versao>.json com tamanho e sha256 reais de cada asset.
// Uso: node scripts/make-manifest.mjs <versao> <tag> <asset...>
import { readFileSync, writeFileSync, statSync, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'

const [versao, tag, ...assets] = process.argv.slice(2)
if (!versao || !tag || assets.length === 0) {
  console.error('uso: node scripts/make-manifest.mjs <versao> <tag> <asset...>')
  process.exit(2)
}

const repo = 'ArthurFreire77/dis-torrent'

/** OS/arch pelo nome do arquivo: é o mesmo critério que o cliente usa. */
function plataforma(nome) {
  const n = nome.toLowerCase()
  if (n.endsWith('.exe')) return { os: 'windows', arch: 'x86_64' }
  if (n.endsWith('.apk')) return { os: 'android', arch: 'aarch64' }
  if (n.endsWith('.appimage') || n.endsWith('.deb')) return { os: 'linux', arch: 'x86_64' }
  if (n.endsWith('.dmg')) return { os: 'macos', arch: 'x86_64' }
  throw new Error(`não sei a plataforma de ${nome}`)
}

function sha256(caminho) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(caminho)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

const saida = []
for (const caminho of assets) {
  const nome = basename(caminho)
  const { os, arch } = plataforma(nome)
  const size = statSync(caminho).size
  const hash = await sha256(caminho)
  saida.push({
    name: nome,
    os,
    arch,
    size,
    sha256: hash,
    url: `https://github.com/${repo}/releases/download/${tag}/${nome}`,
  })
  console.log(`${nome} ${(size / 1024 / 1024).toFixed(1)} MB ${hash.slice(0, 16)}…`)
}

// O validador exige ordem canônica (os, arch, name).
saida.sort((a, b) => {
  const k = (x) => `${x.os}\u0000${x.arch}\u0000${x.name}`
  return k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0
})

const manifest = {
  version: versao,
  channel: 'stable',
  tag,
  commit: process.env.GIT_COMMIT ?? '',
  published_at_ms: Date.now(),
  protocol_version: 5,
  min_protocol_version: 4,
  security_epoch: 4,
  min_security_epoch: 1,
  revoked_versions: [],
  revoked_key_ids: [],
  assets: saida,
}

const caminhoSaida = `dist-release/release-${versao.split('-')[0]}.json`
writeFileSync(caminhoSaida, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log('manifesto:', caminhoSaida)
