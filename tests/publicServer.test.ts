// Servidor público × privado: o que entra no core e o que a UI promete.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const core = readFileSync('distorrent-core/src/net/engine.rs', 'utf8')
const storage = readFileSync('distorrent-core/src/storage.rs', 'utf8')
const limit = readFileSync('distorrent-core/src/net/netlimit.rs', 'utf8')
const wizard = readFileSync('src/components/server/wizardSteps.tsx', 'utf8')
const overview = readFileSync('src/components/server/OverviewSection.tsx', 'utf8')
const manager = readFileSync('src/components/CreateServerWizard.tsx', 'utf8')
const tauri = readFileSync('src-tauri/src/lib.rs', 'utf8')
const services = readFileSync('src/services/models.ts', 'utf8')

test('o servidor guarda público/privado no banco', () => {
  assert.match(storage, /ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0/, 'migração existe')
  assert.match(storage, /pub fn community_set_public/, 'dá para mudar depois')
  assert.match(storage, /pub fn community_is_public/, 'dá para ler a regra')
})

test('padrão é PRIVADO: coluna nasce 0 e frame antigo sem o campo cai em privado', () => {
  assert.match(storage, /is_public INTEGER NOT NULL DEFAULT 0/)
  const protocol = readFileSync('distorrent-core/src/protocol.rs', 'utf8')
  // O campo do FRAME (dentro de CommunityState), não o da opção de criação.
  const i = protocol.indexOf('is_public: bool')
  assert.ok(i > 0, 'o frame carrega is_public')
  const antes = protocol.slice(Math.max(0, i - 220), i)
  assert.match(antes, /serde\(default\)/, 'campo ausente = false (privado)')
})

test('público entra SEM convite e sem aprovação; privado exige convite', () => {
  // O handler é o que aceita a entrada, não o que envia o frame.
  const i = core.indexOf('muitas tentativas de entrada')
  assert.ok(i > 0, 'existe o caminho de entrada pública')
  const trecho = core.slice(Math.max(0, i - 1600), i + 400)
  assert.match(trecho, /if token\.trim\(\)\.is_empty\(\)/, 'público é o caminho sem convite')
  assert.match(trecho, /community_is_public/, 'confere a regra antes de aceitar')
  assert.match(
    trecho,
    /este servidor é privado — peça um convite/,
    'privado recusa com mensagem honesta em vez de aceitar calado',
  )
  // E o privado NÃO tem caminho de aprovação automática: quem não é dono nem
  // membro cai no erro de "seed não autorizado".
  assert.match(core, /membro não autorizado como seed deste servidor/)
})

test('"qualquer um entra" tem rate limit por peer', () => {
  assert.match(core, /allow_public_join\(peer_fp\)/, 'a entrada pública passa pelo limitador')
  assert.match(core, /muitas tentativas de entrada/, 'a recusa explica o motivo')
  assert.match(limit, /pub fn allow_public_join/, 'existe o balde próprio')
  assert.match(limit, /join_attempt_per_peer_10s: 6/, 'limite padrão conservador')
})

test('o botão de público aparece na criação e nas configurações', () => {
  assert.match(wizard, /export function PublicToggle/, 'existe o interruptor')
  assert.match(wizard, /role="switch"/, 'acessível como switch')
  assert.match(manager, /isPublic/, 'o wizard guarda a escolha')
  assert.match(manager, /isPublic,\s*\n/, 'a escolha vai no createCommunity')
  assert.match(overview, /onSetPublic/, 'as configurações deixam mudar depois')
})

test('a UI diz a verdade nos dois estados', () => {
  assert.match(wizard, /Qualquer pessoa entra pelo servidor, sem convite/, 'texto do ligado')
  assert.match(wizard, /só entra quem receber convite/, 'texto do desligado')
  assert.match(overview, /limite de tentativas por minuto/, 'não promete porta aberta sem limite')
})

test('tipo e comando chegam até o core', () => {
  assert.match(services, /is_public\?: boolean/)
  assert.match(services, /communitySetPublic/)
  assert.match(tauri, /fn community_set_public/)
  assert.match(tauri, /fn join_public_community/)
  assert.match(tauri, /community_set_public,/, 'comando registrado no generate_handler')
})

test('abrir link no Windows não passa pelo shell (o & da query quebrava)', () => {
  const updater = readFileSync('src-tauri/src/updater.rs', 'utf8')
  const bloco = updater.slice(updater.indexOf('pub fn open_external'))
  const trecho = bloco.slice(0, 2500)
  assert.match(trecho, /ShellExecuteW/, 'abre direto no SO')
  assert.doesNotMatch(
    trecho,
    /Command::new\("cmd"\)/,
    'cmd /C start trata & como separador e o link com query não abria',
  )
  assert.match(trecho, /<= 32/, 'falha do ShellExecute é reportada, não engolida')
})

test('falha ao abrir link avisa na tela, não só no console', () => {
  const install = readFileSync('src/shared/installExternalLinks.ts', 'utf8')
  const app = readFileSync('src/App.tsx', 'utf8')
  assert.match(install, /OPEN_EXTERNAL_FAILED_EVENT/, 'existe o evento de falha')
  assert.match(install, /window\.open\(url/, 'cai para a janela do WebView antes de desistir')
  assert.match(app, /link-open-error/, 'a UI mostra o aviso')
  assert.match(app, /role="alert"/, 'o aviso é anunciado')
})
