import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manager = readFileSync('src/services/callManager.ts', 'utf8')
const grid = readFileSync('src/components/calls/CallTilesGrid.tsx', 'utf8')
const shell = readFileSync('src/designs/ThemeShell.tsx', 'utf8')

test('os DOIS lados abrem o par (não só o fingerprint maior)', () => {
  const roster = manager.slice(manager.indexOf('private onVoiceParticipantJoined'))
  const bloco = roster.slice(0, 1800)
  assert.match(bloco, /!this\.pcs\.has\(fp\)/, 'abre o par quando não existe')
  assert.match(bloco, /isCallPhaseActive\(st\.phase\)/, 'só com chamada ativa')
  assert.doesNotMatch(bloco, /this\.myFp > fp/, 'a regra do fp maior não pode mais bloquear a abertura')

  const added = manager.slice(manager.indexOf('private onParticipantAdded'))
  const bloco2 = added.slice(0, 2200)
  assert.match(bloco2, /!this\.pcs\.has\(fp\)/)
  assert.doesNotMatch(bloco2, /this\.myFp > fp/)
})

test('quem ENTRA também oferece (informação fresca do roster)', () => {
  const join = manager.slice(manager.indexOf('async joinVoice'))
  const trecho = join.slice(0, 9000)
  assert.match(trecho, /this\.createPC\(fp, callId, true\)/, 'o joiner abre o par')
  assert.doesNotMatch(trecho, /const iniciar = !!this\.myFp && this\.myFp > fp/, 'sem a trava do fp maior')
})

test('entrar no canal abre par mesmo quando o roster chega atrasado', () => {
  assert.match(manager, /catchUpVoiceRoster\(callId, communityId, channelId\)/, 'catch-up é chamado no join')
  const bloco = manager.slice(manager.indexOf('private catchUpVoiceRoster'))
  assert.ok(bloco.length > 0, 'a função existe')
  assert.match(bloco.slice(0, 2200), /createPC\(fp, callId, true\)/, 'abre o par que faltava')
  assert.match(bloco.slice(0, 1400), /\[1200, 3000, 6000, 10000, 16000, 25000\]/, 'tenta em seis janelas')
})

test('roster que chega durante o prompt do microfone não é descartado', () => {
  assert.match(manager, /pendingVoiceJoins = new Map/, 'existe a fila do roster adiantado')
  const joined = manager.slice(manager.indexOf('private onVoiceParticipantJoined'))
  assert.match(joined.slice(0, 1400), /pendingVoiceJoins\.get\(callId\)/, 'guarda em vez de descartar')
  const joinVoice = manager.slice(manager.indexOf('async joinVoice'))
  assert.match(joinVoice.slice(0, 12000), /const adiantados = this\.pendingVoiceJoins\.get\(callId\)/, 'drena no join')
})

test('captura de mídia é serializada (AbortError ao abrir câmera/mic)', () => {
  assert.match(manager, /function comFilaDeCaptura/, 'existe a fila global de captura')
  assert.match(manager, /let capturaFila: Promise<unknown> = Promise\.resolve\(\)/)
  const get = manager.slice(manager.indexOf('async function getLocalMedia('))
  assert.match(get.slice(0, 400), /comFilaDeCaptura\(/, 'getLocalMedia passa pela fila')
})

test('aparelho salvo que sumiu volta para o padrão (câmera que "não abre")', () => {
  const get = manager.slice(manager.indexOf('async function getLocalMediaInner('))
  const bloco = get.slice(0, 3200)
  assert.match(bloco, /usaDeviceExato/, 'detecta preferência de device salva')
  assert.match(bloco, /setCallMediaPrefs\(\{ audioInputId: '', videoInputId: '' \}\)/, 'esquece o device morto')
  assert.match(bloco, /videoConstraintsFromPrefs\(\{ \.\.\.mediaPrefs, videoInputId: '' \}\)/, 'recaptura no padrão')
})

test('sem par ICE selecionado a rota é "n/d", nunca "LAN"', () => {
  const rota = manager.slice(manager.indexOf('getRungSummary(): string'))
  assert.match(rota.slice(0, 1500), /const comPar = reports\.filter/, 'filtra relatórios sem par')
  assert.match(rota.slice(0, 1500), /if \(!comPar\.length\) return 'n\/d'/, 'sem par = sem rota')
})

test('fase presa em connecting é promovida pelo estado REAL do PC', () => {
  const repair = manager.slice(manager.indexOf('private startMeshRepair'))
  const bloco = repair.slice(0, 1800)
  assert.match(bloco, /if \(st\.phase === 'connecting'\)/, 'só age na fase presa')
  assert.match(bloco, /connectionState/, 'consulta o PC')
  assert.match(bloco, /applyPhase\('media-connected'\)/, 'promove quando há par vivo')
})

test('quadrado tem TETO de altura (não estica a janela toda)', () => {
  assert.match(grid, /maxTileHeight/, 'existe teto configurável')
  assert.match(grid, /height: maxTileHeight/, 'o card recebe a altura do teto')
  assert.match(grid, /flexWrap: 'wrap'/, 'fora do palco a grade é wrap com teto')
})

test('palco do canal de voz PREENCHE a área toda (relato do dono: "completar a tela como nos amigos, num espaço maior")', () => {
  assert.match(grid, /fill\?: boolean/, 'prop fill existe')
  assert.match(grid, /bestGrid\(/, 'o modo palco calcula a grade pela área medida')
  const primeiroUso = shell.indexOf('<VoiceStage')
  assert.match(shell.slice(primeiroUso, primeiroUso + 4000), /\bfill\b/, 'a grade do canal recebe o modo palco')
})

test('em chamada de canal o painel lateral fica fora da tela unificada', () => {
  assert.match(shell, /resolveVoiceLayout\(/)
  assert.match(shell, /painelLateralVisivel \? \(callPanelSize/, 'a margem do conteúdo segue o layout')
})
