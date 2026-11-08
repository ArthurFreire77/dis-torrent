import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const checks = readFileSync('src-tauri/src/updater_checks.rs', 'utf8')
const updater = readFileSync('src-tauri/src/updater.rs', 'utf8')
const apply = readFileSync('src-tauri/src/updater_apply.rs', 'utf8')
const gate = readFileSync('src/components/UpdateGate.tsx', 'utf8')
const box = readFileSync('src/components/UpdateSettingsBox.tsx', 'utf8')
const theme = readFileSync('src/designs/ThemeShell.tsx', 'utf8')
const mobile = readFileSync('src/mobile/MobileShell.tsx', 'utf8')
const tauri = readFileSync('src/services/tauri.ts', 'utf8')
const models = readFileSync('src/services/models.ts', 'utf8')

test('boot NÃO responde do cache quando o cache diz "nada novo"', () => {
  // Era o bug: o cache congelava a resposta por 6 h e a release recém-publicada
  // ficava invisível até o próximo boot depois da janela.
  assert.match(checks, /cache_tem_nova/, 'só usa cache se ele já aponta versão maior')
  assert.match(checks, /compare_version_strings\(v, &current\)/, 'compara de verdade, não só existência')
  assert.match(checks, /if cache_tem_nova\.is_some\(\)/, 'cache só responde quando há versão maior')
  // Dentro da janela, o cache NÃO pode ser devolvido só por não estar vazio.
  const janela = checks.slice(checks.indexOf('if dentro_da_janela'), checks.indexOf('let client = http_client'))
  assert.match(janela, /cache_tem_nova/, 'a decisão vem da comparação de versão')
  assert.doesNotMatch(janela, /kv_delete\(KV_ETAG\)/, 'sem ETag escondido no ramo da janela')
})

test('existe verificação forçada ("Verificar agora")', () => {
  assert.match(checks, /force: Option<bool>/, 'comando aceita force')
  assert.match(checks, /let forcar = force\.unwrap_or\(false\)/, 'lê a flag')
  assert.match(checks, /!etag\.is_empty\(\) && !forcar/, 'sem ETag quando forçado, senão vem 304')
  assert.match(tauri, /updateCheckForce: .*force: true/, 'o front envia force: true')
  assert.match(models, /updateCheckForce\?\(\)/, 'contrato exposto')
  assert.match(gate, /checkNow/, 'o gate sabe verificar agora')
  assert.match(box, /checkNow\(\)/, 'o botão usa o caminho forçado')
})

test('intervalo de rotina caiu de 6 h para 30 min', () => {
  assert.match(updater, /MIN_CHECK_INTERVAL_MS: i64 = 30 \* 60 \* 1000/)
  assert.doesNotMatch(updater, /6 \* 60 \* 60 \* 1000/)
})

test('existe tela de atualização nas Configurações (desktop e celular)', () => {
  assert.match(theme, /<UpdateSettingsBox api=\{updateGate\}/, 'montado no desktop')
  assert.match(mobile, /<UpdateSettingsBox api=\{updateGate\}/, 'montado no celular')
  assert.match(box, /instalar sozinho quando sair versão nova/, 'checkbox de auto')
  assert.match(box, /Verificar agora/, 'botão manual')
})

test('instalação em Program Files pede UAC em vez de mandar baixar no GitHub', () => {
  assert.match(apply, /run_elevated/, 'existe caminho elevado')
  assert.match(apply, /ShellExecuteW/, 'usa ShellExecuteW')
  assert.match(apply, /"runas"/, 'verbo runas dispara o UAC')
  assert.match(apply, /código == 5|code == 5|== 5/, 'UAC negado tem mensagem própria')
  assert.doesNotMatch(
    apply,
    /baixe o instalador e execute manualmente/,
    'não manda mais baixar na mão',
  )
})

test('verificação automática respeita o "pular esta versão"', () => {
  const rules = readFileSync('src/services/updateRules.ts', 'utf8')
  assert.match(rules, /FLAG_SKIP = 'update\.skip'/)
  assert.match(rules, /if \(\(await deps\.getFlag\(FLAG_SKIP\)\) === info\.latest\) return \{ kind: 'none' \}/)
})
