import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

// Travas de release: versão só publica assinada (2-de-3) e o update aceita o manifesto.

const root = new URL('../', import.meta.url)
const read = (p: string) => readFileSync(new URL(p, root), 'utf8')

const updaterVersion = read('src-tauri/src/updater_version.rs')
const updaterRs = read('src-tauri/src/updater.rs')
const trust = read('distorrent-core/src/release/trust.rs')
const pkg = JSON.parse(read('package.json')) as { version: string }
const tauriConf = JSON.parse(read('src-tauri/tauri.conf.json')) as { version: string }

describe('release: assinatura obrigatória', () => {
  test('o app exige o threshold (2-de-3) para aceitar o manifesto', () => {
    assert.match(trust, /MIN_THRESHOLD/, 'existe um piso de assinaturas')
    assert.match(trust, /if valid < trust\.threshold/, 'menos assinaturas que o threshold = recusa')
    assert.match(trust, /if valid < current\.threshold/, 'rotação de chave também exige o threshold')
  })

  test('a raiz de confiança é compilada, não lida de env/arquivo', () => {
    const trustKeys = read('distorrent-core/src/release/trust_keys.rs')
    assert.match(trustKeys, /TRUST_SET_BOOTSTRAP|pub const/)
    assert.doesNotMatch(updaterRs, /DISTORRENT_TRUST_SET/, 'override da raiz de confiança é proibido')
    assert.doesNotMatch(trust, /env::var\("DISTORRENT_TRUST/, 'nenhum caminho pode ler a raiz de env')
  })

  test('comparação de versão é por núcleo (manifesto com sufixo × tag limpa)', () => {
    assert.match(updaterVersion, /pub fn mesma_versao/)
    assert.match(updaterVersion, /split\('-'\)/, 'sem split do sufixo a release nunca casa')
    assert.doesNotMatch(
      updaterVersion,
      /signed\.body\.version\s*!=\s*tag\.trim_start_matches\('v'\)/,
      'bug histórico: igualdade exata recusava toda release',
    )
  })

  test('package.json e tauri.conf.json carregam a MESMA versão', () => {
    assert.equal(pkg.version, tauriConf.version, 'versões divergentes quebram o auto-update')
  })
})

describe('release: scripts de publicação', () => {
  const signPath = new URL('tools/release-trust/sign-release.mjs', root)
  const verifyPath = new URL('tools/release-trust/verify-release.mjs', root)

  test('existem assinador e verificador independentes', () => {
    const here = new URL('.', import.meta.url).pathname
    void here
    assert.ok(existsSync(signPath), 'sign-release.mjs sumiu')
    assert.ok(existsSync(verifyPath), 'verify-release.mjs sumiu')
  })

  test('o assinador recusa menos de 2 chaves', () => {
    if (!existsSync(signPath)) return
    const sign = readFileSync(signPath, 'utf8')
    assert.match(sign, /2/, 'precisa exigir 2-de-3')
    assert.match(sign, /refresh-hashes|refreshHashes|asset-dir|assetDir/)
  })

  test('o verificador usa decoder próprio (não reusa o assinador)', () => {
    if (!existsSync(verifyPath)) return
    const verify = readFileSync(verifyPath, 'utf8')
    assert.doesNotMatch(verify, /import .*sign-release/, 'verificador não pode reusar o assinador')
  })

  test('nenhuma chave privada dentro do repositório', () => {
    // Só os arquivos rastreados conhecidos; qualquer `.key` no repo é falha.
    const scan = read('scripts/scan-secrets.mjs')
    assert.match(scan, /signer|key|secret/i)
  })
})
