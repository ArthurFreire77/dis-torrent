import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manager = readFileSync('src/services/callManager.ts', 'utf8')

function blocoDe(nome: string, tamanho = 2200): string {
  const i = manager.indexOf(nome)
  assert.ok(i > 0, `não achei ${nome}`)
  return manager.slice(i, i + tamanho)
}

test('trocar de câmera SOLTA a antiga antes de abrir a nova', () => {
  const bloco = blocoDe('private async trocarFeedDeCamera')
  const solta = bloco.indexOf('antigo?.stop()')
  const abre = bloco.indexOf('getLocalMedia({ video: constraints })')
  assert.ok(solta > 0, 'precisa soltar a câmera antiga')
  assert.ok(abre > 0, 'precisa abrir a nova')
  assert.ok(
    solta < abre,
    'abrir a nova com a antiga viva dá NotReadableError ("em uso por outro app") no Windows',
  )
  assert.match(bloco, /soltarAntes/, 'o chamador escolhe soltar antes (Windows) ou depois (celular)')
})

test('troca de câmera que falha reabre a ANTERIOR (preferência volta antes)', () => {
  const bloco = blocoDe('private async trocarFeedDeCamera', 3600)
  assert.match(bloco, /reverter\?\.\(\)/, 'sem reverter a preferência o retry pede a câmera que falhou')
  const iReverter = bloco.indexOf('reverter?.()')
  const iVolta = bloco.indexOf('const volta = await getLocalMedia')
  assert.ok(iVolta > 0, 'precisa reabrir a câmera anterior')
  assert.ok(iReverter > 0 && iReverter < iVolta, 'a preferência precisa voltar ANTES de reabrir')
})

test('câmera ocupada é retentada ANTES de cair para só voz', () => {
  const iRetry = manager.indexOf("NotReadableError') {")
  const iFallbackGeral = manager.indexOf(
    "if (merged.video && (e as Error)?.name !== 'OverconstrainedError')",
  )
  assert.ok(iRetry > 0, 'existe tratamento de NotReadableError')
  assert.ok(iFallbackGeral > 0, 'existe o fallback genérico')
  assert.ok(
    iRetry < iFallbackGeral,
    'o fallback "só voz" devolvia stream sem vídeo e o retry nunca rodava',
  )
  const retry = manager.slice(iRetry, iFallbackGeral)
  assert.match(retry, /for \(const espera of \[/, 'tenta mais de uma vez')
  assert.match(retry, /getUserMedia\(merged\)/, 'retenta com vídeo')
})

test('sair do canal limpa o estado que impedia reentrar', () => {
  const bloco = blocoDe('async leaveVoice', 3200)
  assert.match(bloco, /this\.leavingCalls\.clear\(\)/, 'sem isto a reentrada era tratada como duplicada')
  assert.match(bloco, /this\.accepting\.clear\(\)/)
  assert.match(bloco, /this\.cameraBusy = false/, 'troca travada impedia ligar a câmera depois')
  assert.match(bloco, /this\.state = null/)
})

test('pseudo-id de câmera nunca vira deviceId exato', () => {
  const prefs = readFileSync('src/services/callMediaPrefs.ts', 'utf8')
  assert.match(
    prefs,
    /videoInputId\.startsWith\('__'\)/,
    'preferência envenenada por 1.1.51/1.1.52 é saneada na leitura',
  )
  assert.match(prefs, /facingMode/, 'frontal/traseira usa facingMode, não deviceId falso')
  const mgr = readFileSync('src/services/callManager.ts', 'utf8')
  assert.doesNotMatch(
    mgr,
    /videoInputId: alvo === 'user' \? '__user'/,
    'gravar __user como deviceId deixa a câmera quebrada entre sessões',
  )
  assert.match(mgr, /setCallMediaPrefs\(\{ videoInputId: '', facingMode: alvo \}\)/)
})

test('a grade usa o stream local mesmo antes do primeiro quadro', () => {
  const tiles = readFileSync('src/services/callTiles.ts', 'utf8')
  assert.match(
    tiles,
    /localCameraStream/,
    'o card local depende do localStream chegar ao state',
  )
  const bind = manager.slice(manager.indexOf('bind(cb:'), manager.indexOf('bind(cb:') + 1600)
  assert.match(bind, /withScreen\.localStream = this\.localStream/, 'bind injeta o stream no state')
})

test('a fase sai de "Discando…" com answer/offer, sem depender de call_accepted', () => {
  const resposta = manager.slice(manager.indexOf('private async handleAnswer'))
  assert.match(
    resposta.slice(0, 1800),
    /st\.phase === 'outgoing'\) this\.applyPhase\('signal'\)/,
    'answer aplicada é prova de que atenderam',
  )
  const junto = manager.slice(manager.indexOf('private markJoined'))
  assert.match(
    junto.slice(0, 900),
    /if \(this\.state\.phase === 'outgoing'\) this\.applyPhase\('signal'\)/,
    'par vivo também tira o selo de discando',
  )
})

test('o estado da chamada existe antes do getUserMedia (answer não se perde)', () => {
  const inicio = manager.slice(manager.indexOf('async start(kind: CallKind'))
  const iState = inicio.indexOf("phase: 'outgoing'")
  const iMidia = inicio.indexOf('await getLocalMedia(constraints)')
  assert.ok(iState > 0, 'o chamador precisa nascer em outgoing')
  assert.ok(iMidia > 0, 'captura de mídia continua no start')
  assert.ok(iState < iMidia, 'sem state antes da captura, a answer rápida era descartada')
})

test('troca de rede (wifi ↔ dados) refaz a rota da chamada', () => {
  const bind = manager.slice(manager.indexOf('bind(cb:'), manager.indexOf('bind(cb:') + 1800)
  assert.match(bind, /addEventListener\('online'/, 'volta da rede dispara recuperação')
  assert.match(bind, /addEventListener\('offline'/, 'perda de rede é detectada na hora')
  const rec = manager.slice(manager.indexOf('private onNetworkChanged'), manager.indexOf('private onNetworkChanged') + 1200)
  assert.match(
    rec,
    /restartIceAll\(st\.callId, true\)/,
    'precisa forçar TODOS os PCs: o ICE antigo fica "connected" com a rota morta',
  )
  assert.match(rec, /ultimaTrocaDeRede/, 'debounce evita renegociar em loop')
})

test('celular: chamada dentro da conversa não esconde as mensagens', () => {
  const mobile = readFileSync('src/mobile/MobileShell.tsx', 'utf8')
  assert.match(
    mobile,
    /renderCallTilesMobile\(callPanelSize === 'compact', true\)/,
    'o painel da conversa usa o modo tira (vídeos em faixa)',
  )
  const stage = readFileSync('src/mobile/MobileCallStage.tsx', 'utf8')
  assert.match(stage, /if \(strip\)/, 'existe o modo tira')
  assert.match(stage, /height: stripHeight/, 'a faixa tem altura fixa e deixa o resto para o chat')
})

test('celular: o botão de inverter câmera NÃO depende de enumerateDevices', () => {
  const mobile = readFileSync('src/mobile/MobileShell.tsx', 'utf8')
  assert.match(
    mobile,
    /shouldShowCameraFlip\(\{/,
    'antes o botão sumia: no Android o enumerateDevices devolve uma câmera só',
  )
  const cameras = readFileSync('src/services/callCameras.ts', 'utf8')
  assert.match(cameras, /if \(input\.mobile\) return true/, 'no celular frontal/traseira é dado do aparelho')
})

test('inverter câmera é AO VIVO, não só na próxima transmissão', () => {
  const troca = manager.slice(manager.indexOf('async switchCamera'))
  assert.match(
    troca.slice(0, 3000),
    /hasLiveCamera\(\)/,
    'só troca o feed se houver câmera viva',
  )
  assert.match(
    troca.slice(0, 3000),
    /trocarFeedDeCamera\(/,
    'com câmera ligada a troca precisa acontecer na hora',
  )
  // `trocarFeedDeCamera` publica para todos e devolve a track nova.
  const feed = manager.slice(manager.indexOf('private async trocarFeedDeCamera'))
  assert.match(feed.slice(0, 3000), /publicarCameraEmTodos\(track\)/, 'manda a track nova para os pares')
  assert.doesNotMatch(
    feed.slice(0, 3000),
    /videoConstraintsFromPrefs\(getCallMediaPrefs\(\)\)/,
    'constraints montadas à mão esquecem facingMode e a câmera não muda',
  )
})

test('câmera no canal de servidor: reusa a m-line de vídeo existente', () => {
  const attach = manager.slice(manager.indexOf('private attachLocalStreamToPC'))
  const bloco = attach.slice(0, 2200)
  assert.match(
    bloco,
    /findVideoTransceiver\(pc\)/,
    'sem reusar a m-line, a câmera virava uma segunda seção de vídeo',
  )
  assert.match(bloco, /tr\.sender\.replaceTrack\(t\)/, 'a track vai pela m-line que já existe')
})

test('chamada de grupo: quem NÃO aceitou não aparece no roster', () => {
  const added = manager.slice(manager.indexOf('private onParticipantAdded'))
  const bloco = added.slice(0, 1400)
  assert.doesNotMatch(
    bloco,
    /st\.participants\.push\(/,
    'call_participant_added é aviso, não convite: ninguém entra no roster por ele',
  )
  assert.match(bloco, /markJoined\(fp\)/, 'só quem provou presença por mídia entra')
})
