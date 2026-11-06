// Contrato de autenticidade de releases, do lado que o app usa.
//
// A decisão de segurança é do Rust; estes testes travam o que a UI pode e não
// pode fazer: ela nunca fornece URL/hash, nunca promove um peer a confiável e
// nunca trata "não verificado" como "oficial". Onde o teste olha o código-fonte
// é porque o contrato É a assinatura da função nativa (não há como exercitar
// Tauri em Node).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { procedenciaResumo } from '../src/services/updateRules.ts'
import type { UpdateInfo } from '../src/services/updateRules.ts'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ler = (p: string) => readFileSync(resolve(raiz, p), 'utf8')

function info(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: '1.0.0',
    latest: '2.0.0',
    asset_name: 'DisTorrent_2.0.0_x64_setup.exe',
    asset_size: 9_000_000,
    download_url: 'https://github.com/ArthurFreire77/dis-torrent/releases/download/v2.0.0/x.exe',
    digest: 'sha256:abc',
    notes: '',
    html_url: 'https://github.com/ArthurFreire77/dis-torrent/releases/tag/v2.0.0',
    platform: 'windows',
    verified: true,
    valid_signatures: 2,
    security_epoch: 9,
    ...over,
  }
}

test('resumo de procedência só afirma verificado quando o Rust disse verificado', () => {
  assert.match(procedenciaResumo(info()), /2 assinaturas válidas/)
  assert.match(procedenciaResumo(info()), /época 9/)
  const naoVerificado = procedenciaResumo(info({ verified: false }))
  assert.match(naoVerificado, /NÃO comprovada/)
  assert.doesNotMatch(naoVerificado, /assinaturas válidas/)
})

test('a UI pede o download pelo NOME do asset, nunca por URL/hash', () => {
  const updater = ler('src/services/updater.ts')
  // A única chamada de download usa `info.asset_name`.
  assert.match(updater, /download: \(info\) => s\.updateDownload!\(info\.asset_name\)/)
  // E não existe nenhum repasse de URL ou digest para o nativo.
  assert.doesNotMatch(updater, /updateDownload!\([^)]*download_url/)
  assert.doesNotMatch(updater, /updateDownload!\([^)]*digest/)
})

test('o comando Rust update_download não aceita url nem digest da UI', () => {
  const updater = ler('src-tauri/src/updater.rs')
  const assinatura = /pub async fn update_download\(([\s\S]*?)\) -> Result<String, String>/.exec(
    updater,
  )
  assert.ok(assinatura, 'achou update_download')
  const params = assinatura![1]
  assert.match(params, /name: String/, 'recebe o nome')
  assert.doesNotMatch(params, /url: String/, 'NÃO recebe URL')
  assert.doesNotMatch(params, /digest: String/, 'NÃO recebe digest')
  // Revalida o registro verificado antes de baixar.
  assert.match(updater, /name != pending\.asset_name/)
})

test('update_apply revalida hash, pasta e symlink antes de executar', () => {
  const updater = ler('src-tauri/src/updater.rs')
  assert.match(updater, /fn update_apply\(app: tauri::AppHandle/)
  assert.match(updater, /verify_before_apply\(&app, &path\)\?/)
  assert.match(updater, /is_symlink\(\)/)
  assert.match(updater, /starts_with\(&dir_canon\)/)
  assert.match(updater, /eq_ignore_ascii_case\(&pending\.sha256\)/)
})

test('existe UM único ponto de execução do instalador, e é depois da verificação', () => {
  const updater = ler('src-tauri/src/updater.rs')
  const posVerificacao = updater.indexOf('verify_before_apply(&app, &path)?')
  const posExec = updater.indexOf('std::process::Command::new(&p)')
  assert.ok(posVerificacao > 0, 'a verificação existe')
  assert.ok(posExec > posVerificacao, 'a execução vem depois da verificação')
  const execs = updater.match(/Command::new\(&p\)/g) ?? []
  assert.equal(execs.length, 1, 'não há execução fora do update_apply')
})

test('o atualizador recusa downgrade e epoch abaixo do piso', () => {
  const updater = ler('src-tauri/src/updater.rs')
  assert.match(updater, /ReleaseStatus::Obsoleto/)
  assert.match(updater, /downgrade recusado/)
  assert.match(updater, /pending\.security_epoch < trust\.epoch_floor\(\)/)
})

test('URL do instalador vem do manifesto verificado, não do GitHub nem da UI', () => {
  const updater = ler('src-tauri/src/updater.rs')
  // O download usa `asset.url` (do manifesto aceito)...
  assert.match(updater, /client\s*\.get\(&asset\.url\)/)
  // ...e o asset é procurado DENTRO do manifesto verificado.
  assert.match(updater, /\.find\(\|a\| a\.name == pending\.asset_name\)/)
  assert.match(updater, /fn url_allowed/)
})

test('a raiz de confiança embutida só tem chave PÚBLICA, nunca privada', () => {
  const trustKeys = ler('distorrent-core/src/release/trust_keys.rs')
  // A constante está preenchida (cerimônia executada) e o formato é
  // `epoch|threshold|key_id:pubkey,...` — nada de segredo.
  assert.match(trustKeys, /pub const TRUST_SET_BOOTSTRAP: &str = "1\|2\|/)
  assert.doesNotMatch(trustKeys, /SigningKey|private key/i)
  // Nenhum literal de 64 hex que NÃO esteja precedido por `key_id:` — que é
  // exatamente a forma de uma semente ed25519 colada por engano.
  const linha = /pub const TRUST_SET_BOOTSTRAP: &str = "([^"]*)"/.exec(trustKeys)?.[1] ?? ''
  for (const item of linha.split('|')[2]?.split(',') ?? []) {
    assert.match(item, /^[0-9a-f]{16}:[0-9a-f]{64}$/, `item fora do formato: ${item}`)
  }
})

test('não existe override da raiz de confiança em runtime', () => {
  const trust = ler('distorrent-core/src/release/trust.rs')
  const bloco = /pub fn bootstrap_trust_set\(\)[\s\S]*?\n}/.exec(trust)?.[0] ?? ''
  assert.ok(bloco.length > 0, 'achou bootstrap_trust_set')
  // A raiz de confiança vem SÓ da constante compilada: nenhuma variável de
  // ambiente, arquivo ou argumento pode trocá-la em runtime.
  assert.doesNotMatch(bloco, /env::var|std::fs::read|read_to_string|from_env/)
  assert.match(bloco, /TRUST_SET_BOOTSTRAP/)
})

test('o limiar mínimo do código é 2 e é verificado por contagem efetiva', () => {
  const trust = ler('distorrent-core/src/release/trust.rs')
  assert.match(trust, /pub const MIN_THRESHOLD: u8 = 2;/)
  assert.match(trust, /if valid < trust\.threshold/)
  // Duplicata da mesma chave não conta duas vezes.
  assert.match(trust, /if seen\.contains\(&key\.key_id\.as_str\(\)\)/)
  // Assinatura inválida de chave conhecida aborta (não é "ignorada").
  assert.match(trust, /assinatura de release inválida/)
})

test('peer revogado é bloqueado em qualquer política', () => {
  const att = ler('distorrent-core/src/release/attestation.rs')
  assert.match(att, /if trust\.state == PeerTrustState::Revogado/)
  assert.match(att, /if trust\.state == PeerTrustState::Obsoleto/)
})

test('PROTO_V subiu para 5 e a atestação exige esse nível', () => {
  const transport = ler('distorrent-core/src/net/transport.rs')
  assert.match(transport, /pub const PROTO_V: u32 = 5;/)
  const att = ler('distorrent-core/src/release/attestation.rs')
  assert.match(att, /pub const ATTEST_PROTO_V: u32 = 5;/)
})
