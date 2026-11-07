import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  callIsActive,
  callMediaLive,
  callPanelVisible,
  joinButtonState,
} from '../src/services/callUiState.ts'

const shell = readFileSync('src/designs/ThemeShell.tsx', 'utf8')
const mobileShell = readFileSync('src/mobile/MobileShell.tsx', 'utf8')
const mobileChannel = readFileSync('src/mobile/MobileCallChannel.tsx', 'utf8')
const stage = readFileSync('src/components/calls/VoiceStage.tsx', 'utf8')
const manager = readFileSync('src/services/callManager.ts', 'utf8')

test('chamada encerrada NÃO bloqueia o próximo "Entrar"', () => {
  for (const fase of ['idle', 'ended', 'rejected', 'failed', 'missed']) {
    assert.equal(callIsActive({ phase: fase }), false, `fase ${fase} não está viva`)
    assert.equal(
      callIsActive({ phase: fase }) // mesmo objeto usado por `busy`
        ? joinButtonState({ busy: true }).disabled
        : joinButtonState({ busy: callIsActive({ phase: fase }) }).disabled,
      false,
      `com fase ${fase} o botão precisa ficar habilitado`,
    )
  }
  for (const fase of ['outgoing', 'incoming', 'connecting', 'connected', 'reconnecting']) {
    assert.equal(callIsActive({ phase: fase }), true, `fase ${fase} está viva`)
  }
  assert.equal(callIsActive(null), false)
  assert.equal(callIsActive(undefined), false)
  assert.equal(callIsActive({ phase: '' }), false)
})

test('botão de entrar: estado, rótulo e motivo vêm de UMA regra', () => {
  const livre = joinButtonState({})
  assert.equal(livre.disabled, false)
  assert.equal(livre.label, 'Entrar na chamada')
  assert.equal(livre.reason, null)
  assert.equal(livre.tone, 'join')

  const ocupado = joinButtonState({ busy: true })
  assert.equal(ocupado.disabled, true)
  assert.match(ocupado.label, /Já existe uma chamada/)
  assert.match(String(ocupado.reason), /encerre a atual/)

  const semSuporte = joinButtonState({ unavailable: 'sem WebRTC neste aparelho' })
  assert.equal(semSuporte.disabled, true)
  assert.equal(semSuporte.tone, 'unavailable')
  assert.match(String(semSuporte.reason), /WebRTC/)

  const entrando = joinButtonState({ joining: true })
  assert.equal(entrando.disabled, true, 'duplo clique não pode disparar duas entradas')
  assert.equal(entrando.label, 'Entrando…')
  assert.equal(entrando.tone, 'joining')

  // Indisponível ganha de ocupado: o motivo mais forte é o que o usuário vê.
  assert.equal(joinButtonState({ busy: true, unavailable: 'x' }).tone, 'unavailable')
})

test('painel da chamada só aparece com chamada VIVA e fora do palco', () => {
  assert.equal(callPanelVisible({ state: { phase: 'connected' }, inThisCall: false }), true)
  assert.equal(callPanelVisible({ state: { phase: 'connected' }, inThisCall: true }), false)
  assert.equal(callPanelVisible({ state: { phase: 'ended' }, inThisCall: false }), false)
  assert.equal(callPanelVisible({ state: null, inThisCall: false }), false)
})

test('selo "conectado" considera a TELA como mídia viva', () => {
  const vivo = (_id: string) => ({ getTracks: () => [{ readyState: 'live' }] })
  assert.equal(callMediaLive({ sharing: true }), true, 'compartilhando = mídia viva')
  assert.equal(
    callMediaLive({ participants: [{ videoUrl: 'data:image/jpeg;base64,xx' }] }),
    true,
    'quadro nativo conta',
  )
  assert.equal(callMediaLive({ localScreenStream: vivo('s') as any }), true, 'tela local conta')
  assert.equal(callMediaLive({ localStream: vivo('c') as any }), true)
  assert.equal(callMediaLive({ localStream: { getTracks: () => [{ readyState: 'ended' }] } as any }), false)
})

test('os shells usam a regra pura, não `activeCall` cru, para "já existe chamada"', () => {
  assert.match(shell, /const callViva = callIsActive\(activeCall\)/)
  assert.match(shell, /busy=\{callViva && !inThisCall\}/)
  assert.match(shell, /hasActiveCall: callViva/)
  assert.doesNotMatch(shell, /busy=\{!!activeCall && !inThisCall\}/)
  assert.match(mobileShell, /callIsActive\(activeCall\)/)
})

test('o botão de entrar do canal usa o estado compartilhado (nada de texto duplicado)', () => {
  assert.match(stage, /joinButtonState\(\{/)
  assert.match(stage, /\{entrar\.label\}/)
  assert.match(stage, /aria-label=\{entrar\.ariaLabel\}/)
  assert.doesNotMatch(stage, /\{unavailable \? 'Chamada indisponível'/)
  assert.match(mobileChannel, /joinButtonState\(\{/)
  assert.match(mobileChannel, /\{entrar\.label\}/)
})

test('lobby: controles ancorados fora da área que rola (botão não sai da tela)', () => {
  const lobby = stage.slice(stage.indexOf('const lobby ='))
  assert.match(lobby.slice(0, 2600), /flexDirection: 'column'/, 'lobby em coluna')
  assert.match(lobby.slice(0, 2600), /overflowY: 'auto'/, 'só o conteúdo rola')
  assert.doesNotMatch(
    lobby.slice(0, 2600),
    /overflowY: 'auto'[\s\S]{0,200}position: 'absolute'/,
    'controles absolutos dentro da área rolável saíam da tela',
  )
  assert.match(stage, /maxWidth: 'calc\(100% - 24px\)'/, 'pílula nunca vaza da janela')
})

test('barra de controles do canal de voz tem o botão de tela', () => {
  assert.match(stage, /onToggleScreen && !compact/)
  assert.match(stage, /Compartilhar tela/)
})

test('no celular o canal de voz TEM botão de tela (antes não existia)', () => {
  const bloco = mobileChannel.slice(mobileChannel.indexOf('if (inCall)'), mobileChannel.indexOf('if (inCall)') + 4200)
  assert.match(bloco, /onToggleScreen/, 'o controle precisa existir na barra da chamada')
  assert.match(bloco, /icon="screen"/)
  assert.match(mobileShell, /canShareScreen=\{supportsScreenShare\(\) \|\| !!st\?\.sharing\}/)
})

test('o picker de tela é montado na vista do canal no celular (senão o clique some)', () => {
  const vista = mobileShell.slice(mobileShell.indexOf('if (selCallChannel)'), mobileShell.indexOf('const channelName = activeComm'))
  assert.ok(vista.length > 0, 'achou a vista do canal')
  assert.match(vista, /<ScreenSharePicker/, 'o modal precisa existir neste ramo (há return antecipado)')
})

test('volume/mute por transmissão não quebra ao desmontar o card', () => {
  const tile = readFileSync('src/components/calls/CallTile.tsx', 'utf8')
  assert.match(tile, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); onPin\(tile\.id\) \}\}/)
  assert.match(tile, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); onExpand\(tile\.id\) \}\}/)
  assert.match(tile, /streamIsPlayable/, 'trilha mutada não pode render <video> congelado')
})

test('reentrar no MESMO canal de voz é no-op (sem áudio duplicado)', () => {
  const join = manager.slice(manager.indexOf('async joinVoice'))
  assert.match(join.slice(0, 1800), /this\.state\.callId === alvo/, 'detecta o mesmo canal')
  assert.match(join.slice(0, 1800), /return this\.state/, 'devolve o estado vivo em vez de recriar')
})

test('compartilhar sem chamada falha alto (não retorna em silêncio)', () => {
  const bloco = manager.slice(manager.indexOf('private async startScreenShareNow'))
  assert.match(bloco.slice(0, 800), /throw new ScreenShareError\('no-source'/, 'erro explícito')
  assert.doesNotMatch(bloco.slice(0, 900), /if \(!this\.state\) return$/)
})

test('segundo stream de vídeo do peer vira TELA, não substitui a câmera', () => {
  const bloco = manager.slice(manager.indexOf('function attachRemoteTrack'))
  assert.match(bloco.slice(0, 2600), /screenStream = stream/, 'guarda a tela no campo próprio')
  assert.match(bloco.slice(0, 2600), /hasLiveVideoTrack\(stream\)/)
  const limpar = manager.slice(manager.indexOf('private onScreenShareSignal'))
  assert.match(limpar.slice(0, 2200), /screenStream = null/, 'encerrar a tela solta o stream')
})

test('câmera religada NÃO vira card de tela (só a tela anunciada é tela)', () => {
  const bloco = manager.slice(manager.indexOf('function attachRemoteTrack'))
  assert.match(
    bloco.slice(0, 2600),
    /const ehTela = !!p\.sharing && temVideo/,
    'sem o sinal `sharing` um vídeo novo é câmera, não tela',
  )
  assert.doesNotMatch(
    bloco.slice(0, 2600),
    /p\.sharing = true\s*\n\s*}\s*\n\s*onUpdate/,
    'não pode inventar sharing ao ver dois streams de vídeo',
  )
})

test('offer recusada no glare é reenviada sozinha (sem desligar/ligar)', () => {
  const bloco = manager.slice(manager.indexOf("console.debug(`[call] GLARE"))
  assert.match(
    bloco.slice(0, 500),
    /marcarRenegociacaoPendente\(fromFp, 'resend'\)/,
    'o lado impolite precisa reenviar a própria offer',
  )
  const reparo = manager.slice(manager.indexOf('private async repairMidiaDivergente'))
  assert.match(reparo.slice(0, 2600), /have-local-offer/, 'sabe reenviar a offer pendente')
  assert.match(reparo.slice(0, 2600), /pc\.localDescription/, 'usa a offer já criada')
})

test('answer que chega adiantada fica guardada e é aplicada depois', () => {
  assert.match(manager, /private pendingAnswers = new Map/)
  const descarte = manager.slice(manager.indexOf('private async handleAnswer'))
  assert.match(
    descarte.slice(0, 900),
    /this\.pendingAnswers\.set\(fromFp/,
    'sem PC ainda, a answer não pode ser descartada',
  )
  const envio = manager.slice(manager.indexOf('private async sendOffer'))
  assert.match(envio.slice(0, 2000), /flushPendingAnswer\(fp, pc, callId\)/, 'aplica logo após a offer')
})

test('fila de renegociação tem teto (não vira loop de offers)', () => {
  const bloco = manager.slice(manager.indexOf('private marcarRenegociacaoPendente'))
  assert.match(bloco.slice(0, 1200), /MAX_RENEGOCIACOES/)
  assert.match(bloco.slice(0, 1200), /tentativas/)
})

test('offer repetida reenvia a answer local (answer perdida não trava)', () => {
  assert.match(manager, /private async reenviarAnswerLocal/)
  const oferta = manager.slice(manager.indexOf('private async handleOffer'))
  assert.match(
    oferta.slice(0, 2400),
    /reenviarAnswerLocal\(fromFp, callId, pc, sdpStr\)/,
    'dedupe não pode ser um `return` seco: a answer pode ter se perdido',
  )
  assert.match(
    oferta.slice(0, 2400),
    /lastRemoteOffer\.get\(fromFp\) === sdpStr/,
    'só reenvia quando é a MESMA offer (não trata renegociação nova como duplicata)',
  )
  const reenvio = manager.slice(manager.indexOf('private async reenviarAnswerLocal'))
  assert.match(
    reenvio.slice(0, 1200),
    /remote\.sdp !== offerSdp/,
    'answer antiga não serve para uma offer nova',
  )
})

test('direção já em sendrecv não impede a oferta quando a track muda', () => {
  const cam = manager.slice(manager.indexOf('private async publicarCameraEmTodos'))
  assert.match(
    cam.slice(0, 2000),
    /if \(!precisaOffer && anterior !== track\.id\) precisaOffer = true/,
    'sem isto a câmera religada ficava sem offer (só voltava desligando/ligando)',
  )
  const tela = manager.slice(manager.indexOf('private async seedScreenPeers'))
  assert.match(tela.slice(0, 2600), /anterior !== track\.id/, 'mesma regra para a tela')
  const volta = manager.slice(manager.indexOf('private async restoreCameraAfterScreen'))
  assert.match(volta.slice(0, 1400), /enviarOfferComRetry/, 'volta da tela usa retry')
})

test('câmera/tela só contam como enviadas quando a oferta sai', () => {
  const cam = manager.slice(manager.indexOf('private async publicarCameraEmTodos'))
  assert.match(cam.slice(0, 2000), /if \(!saiu\) \{/, 'oferta que falhou não conta como enviada')
  assert.match(cam.slice(0, 2200), /marcarRenegociacaoPendente\(fp\)/, 'entra na fila de retry')
  const tela = manager.slice(manager.indexOf('private async seedScreenPeers'))
  assert.match(tela.slice(0, 3400), /enviarOfferComRetry\(fp, this\.state\.callId\)/, 'tela usa retry')
})
