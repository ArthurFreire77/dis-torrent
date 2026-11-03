import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const storage = readFileSync('distorrent-core/src/storage.rs', 'utf8')
const lib = readFileSync('src-tauri/src/lib.rs', 'utf8')
const ui = readFileSync('src/components/prefs/MessageRetentionSettings.tsx', 'utf8')
const tauri = readFileSync('src/services/tauri.ts', 'utf8')

test('a exclusão grava uma lápide local (não manda nada para a rede)', () => {
  const bloco = storage.slice(storage.indexOf('pub fn hide_messages_local'))
  assert.match(bloco.slice(0, 1600), /INSERT OR IGNORE INTO local_hidden/)
  assert.doesNotMatch(
    bloco.slice(0, 1600),
    /cmd_tx|SendToPeer|broadcast|events\.send/,
    'limpeza local NÃO pode enviar frame para outros participantes',
  )
})

test('mensagem escondida não volta na sincronização (insert bloqueado pelo id)', () => {
  const bloco = storage.slice(storage.indexOf('pub fn insert_message('))
  assert.match(
    bloco.slice(0, 900),
    /NOT EXISTS \(SELECT 1 FROM local_hidden WHERE msg_id=\?1\)/,
    'o INSERT tem de recusar id já escondido',
  )
})

test('a migração cria a tabela da lápide e a versão é numérica', () => {
  assert.match(storage, /CREATE TABLE IF NOT EXISTS local_hidden/)
  assert.match(
    storage,
    /let version: u32 = version\.trim\(\)\.parse\(\)/,
    'comparar versão como string fazia "10" < "2" e recriava a tabela toda abertura',
  )
})

test('o escopo é configurável e canal de servidor entra como servidor', () => {
  const bloco = storage.slice(storage.indexOf('pub fn expired_message_ids'))
  assert.match(bloco.slice(0, 1800), /c\.kind = 'dm'/)
  assert.match(bloco.slice(0, 1800), /c\.kind = 'group'/)
  assert.match(
    bloco.slice(0, 1800),
    /c\.id IS NULL/,
    'canal não tem linha em conversations — sem isto a limpeza nunca alcança servidor',
  )
})

test('comando persiste a configuração e aplica na hora', () => {
  assert.match(lib, /fn retention_get\(/)
  assert.match(lib, /fn retention_set\(/)
  assert.match(lib, /privacy\.retention_days/)
  assert.match(lib, /retention_apply\(&store\)/, 'salvar aplica a regra imediatamente')
  assert.match(tauri, /retentionGet|retentionSet|retentionRun/)
})

test('padrão é 30 dias, servidores e grupos ligados, DMs desligadas', () => {
  const bloco = lib.slice(lib.indexOf('impl Default for RetentionSettings'))
  assert.match(bloco.slice(0, 300), /days: 30/)
  assert.match(bloco.slice(0, 300), /servers: true/)
  assert.match(bloco.slice(0, 300), /groups: true/)
  assert.match(bloco.slice(0, 300), /dms: false/)
})

test('a UI oferece os cinco prazos e "Nunca" desliga', () => {
  assert.match(ui, /\[7, 30, 90, 180, 0\]/)
  assert.match(ui, /d === 0 \? 'Nunca'/)
})

test('a UI diz explicitamente que apaga só para o usuário', () => {
  assert.match(ui, /só para você/)
  assert.match(ui, /não mudam|nada é enviado|não muda/)
})

test('a UI existe no desktop e no celular', () => {
  const desktop = readFileSync('src/designs/ThemeShell.tsx', 'utf8')
  const mobile = readFileSync('src/mobile/MobileShell.tsx', 'utf8')
  assert.match(desktop, /<MessageRetentionSettings/)
  assert.match(mobile, /<MessageRetentionSettings/)
})

test('mensagem presa em "sending" volta para a fila no boot', () => {
  assert.match(lib, /revert_all_sending_to_pending/, 'recuperação na abertura')
  assert.match(storage, /pub fn revert_all_sending_to_pending/)
})
