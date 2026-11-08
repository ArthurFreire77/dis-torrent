import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const swarm = readFileSync('src/services/fileSwarm.ts', 'utf8')
const rules = readFileSync('src/services/fileRules.ts', 'utf8')
const theme = readFileSync('src/designs/ThemeShell.tsx', 'utf8')
const mobile = readFileSync('src/mobile/MobileShell.tsx', 'utf8')
const cache = readFileSync('distorrent-core/src/cache.rs', 'utf8')
const lib = readFileSync('src-tauri/src/lib.rs', 'utf8')

test('mídia dentro do limite baixa AUTOMÁTICA e vai para o cache', () => {
  assert.match(rules, /MEDIA_CACHE_IMAGE_MAX = 7 \* 1024 \* 1024/, 'imagem até 7 MB')
  assert.match(rules, /MEDIA_CACHE_VIDEO_MAX = 250 \* 1024 \* 1024/, 'vídeo até 250 MB')
  assert.match(rules, /shouldCacheMedia/, 'existe a regra de limite')
  // A prévia dispara sozinha quando a mídia é anunciada.
  assert.match(theme, /prepareMedia\(sf\)/, 'desktop baixa prévia sozinho')
  assert.match(mobile, /prepareMedia\(sf\)/, 'celular baixa prévia sozinho')
  // E o bloco recebido vai para o cache.
  assert.match(swarm, /services\.cachePut\(spoolKey\(file_id, index\)/, 'grava no cache')
})

test('vídeo entre 40 e 250 MB NÃO é recusado: vai para o spool em disco', () => {
  // Antes havia um throw para qualquer mídia acima de mediaAutoFetchCap (40 MB
  // de vídeo), então um vídeo de 41–250 MB nunca baixava sozinho.
  assert.doesNotMatch(swarm, /grande demais para a prévia em memória/, 'o throw foi removido')
  assert.match(swarm, /sf\.onDisk = true/, 'roteia para o spool')
  assert.match(swarm, /mediaAutoFetchCap\(sf\.name\) && !sf\.onDisk/, 'só promove quando passa do teto de RAM')
})

test('acima do limite NÃO baixa sozinho: só com clique', () => {
  assert.match(
    swarm,
    /if \(!shouldCacheMedia\(sf\.name, sf\.size\)\) \{\s*throw new Error\(`mídia de \$\{Math\.round\(sf\.size \/ \(1024 \* 1024\)\)\}MB acima do automático — toque em Baixar`\)/,
    'acima do limite pede ação do usuário',
  )
})

test('cache cresce GRADUALMENTE com o uso, com teto máximo', () => {
  assert.match(cache, /GROW_START_BYTES: u64 = 512 \* 1024 \* 1024/, 'começa em 512 MB')
  assert.match(cache, /GROW_STEP_BYTES: u64 = 512 \* 1024 \* 1024/, 'sobe de 512 em 512')
  assert.match(cache, /GROW_MAX_BYTES: u64 = 8 \* 1024 \* 1024 \* 1024/, 'teto de 8 GB')
  assert.match(cache, /pub fn cap_para_uso/, 'função pura de degrau')
  assert.match(cache, /fn grow_if_needed/, 'cresce antes de podar')
  assert.match(cache, /if !deve_crescer\(self\.autogrow/, 'teto fixo não cresce')
  // O app usa o modo crescente no boot.
  assert.match(lib, /DiskLru::open_growing/, 'boot usa open_growing')
})

test('TTL de 7 dias continua valendo junto do crescimento', () => {
  assert.match(cache, /DEFAULT_TTL_SECS: u64 = 7 \* 24 \* 60 \* 60/, '7 dias')
  assert.match(cache, /ttl_continua_expirando_mesmo_com_teto_maior/, 'teste cobre TTL + teto')
})

test('dá para ver o perfil clicando na pessoa (lista de membros)', () => {
  // Antes o member-row não tinha onClick e clicar na fotinha não abria nada.
  // (A primeira ocorrência de member-row no arquivo é a de BOTS, que não tem
  // perfil — por isso procuramos o bloco de membros por cargo/online.)
  assert.match(theme, /onClick=\{\(\) => setProfileFp\(fp\)\}/, 'desktop abre o perfil')
  assert.match(theme, /Ver perfil de/, 'tem title acessível')
  assert.match(theme, /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter' \|\| e\.key === ' '\) setProfileFp\(fp\) \}\}/, 'teclado também')
  assert.match(mobile, /setProfilePeer\(\{ fp, name: nick \|\| fp\.slice\(0, 8\) \}\)/, 'celular abre o perfil')
  assert.match(mobile, /setShowMembers\(false\)/, 'fecha a gaveta ao abrir o perfil')
})

test('avatar e nome nas mensagens abrem o perfil', () => {
  const list = readFileSync('src/components/social/MessageList.tsx', 'utf8')
  assert.match(list, /onClick=\{\(\) => onProfile\(authorFp\)\}/, 'clique no avatar/nome chama onProfile')
  assert.match(theme, /onProfile=\{\(fp\) => setProfileFp\(fp\)\}/, 'desktop liga onProfile')
  assert.match(mobile, /onOpenProfile=\{\(fp\) => setProfilePeer/, 'celular liga onOpenProfile')
})
