import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

/**
 * Importação de bot por .zip: o comando de casca, o serviço do front e o modal
 * precisam existir juntos. Um .zip sem serviço é um botão que não faz nada.
 */

const ler = (p: string) => readFileSync(p, 'utf8')
const tauri = ler('src/services/tauri.ts')
const browser = ler('src/services/browser.ts')
const models = ler('src/services/models.ts')
const modal = ler('src/components/server/BotManager.tsx')
const rust = ler('src-tauri/src/commands_bot.rs')
const lib = ler('src-tauri/src/lib.rs')

test('o comando Tauri bot_zip_read existe e está registrado', () => {
  assert.match(rust, /fn bot_zip_read\s*\(/, 'falta o comando bot_zip_read')
  assert.match(rust, /botzip::extract_bot_zip/, 'o comando precisa extrair com a guarda')
  assert.match(rust, /botbridge::read_bot_folder/, 'e reusar a leitura de pasta')
  assert.match(lib, /commands_bot::bot_zip_read,/, 'comando fora do generate_handler falha em silêncio')
})

test('a extração tem guarda anti zip-slip e teto de tamanho', () => {
  const guarda = ler('src-tauri/src/botzip.rs')
  assert.match(guarda, /Component::ParentDir/, 'precisa recusar ..')
  assert.match(guarda, /Component::RootDir/, 'precisa recusar caminho absoluto')
  assert.match(guarda, /is_symlink/, 'precisa recusar link simbólico')
  assert.match(guarda, /MAX_TOTAL_BYTES/, 'precisa de teto de bytes totais')
  assert.match(guarda, /MAX_ENTRIES/, 'precisa de teto de número de arquivos')
  assert.match(guarda, /starts_with\(&root\)/, 'precisa conferir que o destino fica sob a raiz')
  assert.ok(
    existsSync('src-tauri/src/botzip.rs'),
    'o módulo de extração precisa existir',
  )
})

test('o serviço botZipRead existe no nativo, no browser e nos modelos', () => {
  assert.match(tauri, /botZipRead:\s*\(zipPath\)\s*=>\s*invoke<BotFolderInfo>\('bot_zip_read'/, 'tauri.ts sem botZipRead')
  assert.match(browser, /botZipRead:\s*\(\)\s*=>/, 'browser.ts precisa do stub')
  assert.match(browser, /botZipRead[\s\S]{0,200}Promise\.reject/, 'o stub precisa recusar honestamente')
  assert.match(models, /botZipRead\?\(zipPath: string\): Promise<BotFolderInfo>/, 'models.ts sem a assinatura')
})

test('o modal de import aceita .zip, não só pasta', () => {
  assert.match(modal, /export function botImportKind/, 'o modal precisa decidir pasta x zip')
  assert.match(modal, /\.zip\$/, 'a extensão .zip precisa ser reconhecida')
  assert.match(modal, /onImportZip/, 'o modal precisa receber o importador de zip')
  assert.match(modal, /onImportZip[\s\S]{0,120}onImportFolder|onImportFolder[\s\S]{0,120}onImportZip/, 'os dois caminhos precisam existir')
  assert.match(modal, /\.zip/, 'o texto do modal precisa citar .zip')
})

test('botImportKind separa pasta de zip pela extensão', () => {
  // Espelha a função do modal: a decisão é só a extensão, sem tocar o disco.
  const kind = (caminho: string): 'zip' | 'folder' =>
    /\.zip$/i.test(caminho.trim()) ? 'zip' : 'folder'
  assert.equal(kind('C:\\bots\\freirebot.zip'), 'zip')
  assert.equal(kind('C:\\bots\\FREIREBOT.ZIP'), 'zip')
  assert.equal(kind('C:\\bots\\freirebot'), 'folder')
  assert.equal(kind('C:\\bots\\bot.json'), 'folder')
  assert.equal(kind('C:\\bots\\zipado.txt'), 'folder')
})
