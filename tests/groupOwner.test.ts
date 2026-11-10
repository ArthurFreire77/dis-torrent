import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Estes arquivos usavam `mems[0][0] === fingerprint` para decidir se o usuário
// é dono do grupo. A lista de membros vem ordenada por `added_at`, não por
// dono, então quem criou o grupo via "Sair do grupo" em vez de "Apagar" — e o
// core recusava com "só quem criou o grupo pode apagar para todos".

const desktop = readFileSync(new URL('../src/designs/ThemeShell.tsx', import.meta.url), 'utf8')
const mobile = readFileSync(new URL('../src/mobile/MobileShell.tsx', import.meta.url), 'utf8')
const tauri = readFileSync(new URL('../src/services/tauri.ts', import.meta.url), 'utf8')
const models = readFileSync(new URL('../src/services/models.ts', import.meta.url), 'utf8')
const browser = readFileSync(new URL('../src/services/browser.ts', import.meta.url), 'utf8')

test('a UI pergunta o dono ao core, não adivinha pelo primeiro membro', () => {
  assert.doesNotMatch(
    desktop,
    /mems\[0\]\[0\] === identity\?\.fingerprint/,
    'o desktop não pode mais adivinhar o dono pela ordem dos membros',
  )
  assert.doesNotMatch(
    mobile,
    /mems\[0\]\[0\] === identity\?\.fingerprint/,
    'o celular também não',
  )
  assert.match(desktop, /services\.groupOwner\(/, 'usa o dono real (desktop)')
  assert.match(mobile, /services\.groupOwner\(/, 'usa o dono real (celular)')
})

test('existe comando group_owner com contrato nos três lados', () => {
  assert.match(tauri, /groupOwner:\s*\(cid\)\s*=>\s*invoke<string \| null>\('group_owner'/, 'ponte Tauri')
  assert.match(models, /groupOwner\(convId: string\): Promise<string \| null>/, 'tipo do serviço')
  assert.match(browser, /groupOwner:\s*\(cid\)/, 'modo navegador também responde')
})

test('o dono real vem do registro do core (group_owners), com fallback documentado', () => {
  const groups = readFileSync(new URL('../distorrent-core/src/net/engine/groups.rs', import.meta.url), 'utf8')
  assert.match(groups, /pub fn group_dono/, 'método do motor')
  const corpo = groups.slice(groups.indexOf('pub fn group_dono'))
  assert.match(corpo.slice(0, 400), /store\.group_owner/, 'delega para o store')

  const storage = readFileSync(new URL('../distorrent-core/src/storage_groups.rs', import.meta.url), 'utf8')
  const rodape = storage.slice(storage.indexOf('pub fn group_owner'))
  assert.match(
    rodape.slice(0, 700),
    /list_group_members_conn/,
    'sem registro explícito, cai no primeiro membro (compatibilidade)',
  )
})

test('sair do grupo continua disponível e avisa quando não pode', () => {
  for (const [nome, src] of [['desktop', desktop], ['celular', mobile]] as const) {
    assert.match(src, /groupLeave|group_delete_local|leaveTarget/, `${nome} tem o fluxo de saída`)
  }
  const core = readFileSync(new URL('../distorrent-core/src/net/engine/groups.rs', import.meta.url), 'utf8')
  const leave = core.slice(core.indexOf('pub fn group_leave'))
  assert.match(
    leave.slice(0, 1400),
    /você criou este grupo — escolha apagar/,
    'o dono recebe uma instrução clara em vez de um erro seco',
  )
  // A janela precisa alcançar o fim de group_leave: o `dismiss_owned` vem
  // depois de leave_group_local, e o teste com 1600 falhava por 1 linha.
  assert.match(
    leave.slice(0, 2600),
    /dismiss_owned/,
    'sair precisa dispensar, senão o grupo volta no próximo sync',
  )
})
