// Modelo dos quadrados da chamada (pessoa × tela).
//
// Cada teste aqui trava um bug REAL que existia na UI antiga:
//  - quem transmite não via a própria câmera (o tile local dependia do roster);
//  - a tela e a câmera brigavam pelo mesmo quadrado;
//  - o mesmo vídeo aparecia nos dois quadrados quando o cliente só manda um;
//  - fixar/expandir era por participante, então a tela nunca podia ser fixada;
//  - evento duplicado criava dois quadrados e dois `<audio>`.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCallTiles,
  participantTileId,
  screenTileId,
  screenTileLabel,
  resolveTileId,
  sortTilesForPin,
  nextTileSelection,
  streamHasLiveVideo,
  tilesKey,
  type CallTileParticipantInput,
} from '../src/services/callTiles.ts'

/** MediaStream falso: `callTiles` só olha `getVideoTracks().readyState`. */
function fakeStream(opts: { video?: boolean; live?: boolean } = {}): MediaStream {
  const { video = true, live = true } = opts
  const tracks = video ? [{ kind: 'video', readyState: live ? 'live' : 'ended' }] : []
  return {
    id: `stream-${Math.random().toString(36).slice(2)}`,
    getVideoTracks: () => tracks,
    getAudioTracks: () => [{ kind: 'audio', readyState: 'live' }],
    getTracks: () => tracks,
  } as unknown as MediaStream
}

const ME = 'aaaaaaaaaaaa'
const PEER = 'bbbbbbbbbbbb'

test('câmera local aparece no MEU quadrado sem depender do roster', () => {
  // O roster pode não ter o stream local (caminho nativo ou roster criado
  // antes do getUserMedia). A mídia do "eu" vem de `local.stream`.
  const cam = fakeStream()
  const tiles = buildCallTiles({
    participants: [{ fp: ME, nickname: 'Eu' }],
    myFp: ME,
    local: { stream: cam, cameraOn: true },
  })
  const mine = tiles.find((t) => t.kind === 'participant' && t.fp === ME)!
  assert.equal(mine.isLocal, true)
  assert.equal(mine.stream, cam, 'a prévia local precisa usar o stream PRÓPRIO')
  assert.equal(mine.cameraOn, true)
  assert.equal(mine.localPreviewUnavailable, false)
})

test('desligar a câmera restaura o avatar (sem vídeo congelado)', () => {
  const tiles = buildCallTiles({
    participants: [{ fp: ME, nickname: 'Eu' }],
    myFp: ME,
    local: { stream: fakeStream(), cameraOn: false },
  })
  const mine = tiles.find((t) => t.kind === 'participant')!
  assert.equal(mine.cameraOn, false)
  assert.equal(mine.stream, undefined, 'sem câmera ligada não deve haver <video>')
})

test('tela tem quadrado PRÓPRIO e a pessoa continua no dela (câmera + tela juntas)', () => {
  const cam = fakeStream()
  const screen = fakeStream()
  const tiles = buildCallTiles({
    participants: [{ fp: ME, nickname: 'Eu' }],
    myFp: ME,
    local: { stream: cam, screenStream: screen, cameraOn: true, sharing: true },
  })
  const person = tiles.find((t) => t.kind === 'participant')!
  const shared = tiles.find((t) => t.kind === 'screen')!
  assert.equal(person.stream, cam, 'a câmera NÃO pode ser substituída pela tela')
  assert.equal(shared.stream, screen)
  assert.notEqual(person.id, shared.id)
  assert.equal(shared.fp, ME, 'o quadrado da tela pertence à MESMA pessoa')
  assert.equal(shared.label, 'Sua tela')
})

test('tela remota não duplica o único vídeo nos dois quadrados', () => {
  // Cliente antigo/nativo manda UM vídeo e sinaliza screen:'on'.
  const only = fakeStream()
  const tiles = buildCallTiles({
    participants: [{ fp: PEER, nickname: 'Bob', stream: only, sharing: true }],
    myFp: ME,
    local: { stream: fakeStream(), cameraOn: false },
  })
  const person = tiles.find((t) => t.kind === 'participant' && t.fp === PEER)!
  const shared = tiles.find((t) => t.kind === 'screen' && t.fp === PEER)!
  assert.equal(person.stream, undefined, 'o vídeo consumido pela tela sai do tile da pessoa')
  assert.equal(shared.stream, only)
  assert.equal(shared.label, 'Tela de Bob')
})

test('câmera e tela remotos em streams separados ocupam quadrados separados', () => {
  const cam = fakeStream()
  const screen = fakeStream()
  const tiles = buildCallTiles({
    participants: [{ fp: PEER, nickname: 'Bob', stream: cam, screenStream: screen, sharing: true, cameraOn: true }],
    myFp: ME,
    local: { stream: fakeStream(), cameraOn: false },
  })
  const person = tiles.find((t) => t.kind === 'participant' && t.fp === PEER)!
  const shared = tiles.find((t) => t.kind === 'screen' && t.fp === PEER)!
  assert.equal(person.stream, cam)
  assert.equal(shared.stream, screen)
})

test('parar a tela remove SÓ o quadrado da tela', () => {
  const cam = fakeStream()
  const withScreen = buildCallTiles({
    participants: [{ fp: PEER, nickname: 'Bob', stream: cam, sharing: true }],
    myFp: ME,
  })
  assert.ok(withScreen.some((t) => t.kind === 'screen'))

  const without = buildCallTiles({
    participants: [{ fp: PEER, nickname: 'Bob', stream: cam, sharing: false }],
    myFp: ME,
  })
  assert.equal(without.some((t) => t.kind === 'screen'), false, 'a tela sumiu')
  assert.equal(without.find((t) => t.fp === PEER)!.stream, cam, 'a câmera continua')
})

test('evento duplicado não cria quadrado nem áudio duplicado', () => {
  const cam = fakeStream()
  const dup: CallTileParticipantInput[] = [
    { fp: PEER, nickname: 'Bob', stream: cam },
    { fp: PEER, nickname: 'Bob', stream: cam },
  ]
  const tiles = buildCallTiles({ participants: dup, myFp: ME })
  assert.equal(tiles.filter((t) => t.fp === PEER).length, 1)
})

test('merge não apaga estado conhecido com campo ausente', () => {
  // `call_accepted` chega sem `sharing`; `screen_share_offer` já marcou true.
  const tiles = buildCallTiles({
    participants: [
      { fp: PEER, nickname: 'Bob', sharing: true },
      { fp: PEER, nickname: 'Bob' },
    ],
    myFp: ME,
  })
  assert.equal(tiles.some((t) => t.kind === 'screen'), true)
})

test('fixar e expandir são independentes e por ID de transmissão', () => {
  const screenId = screenTileId(PEER)
  let sel = { pinnedId: null as string | null, expandedId: null as string | null }

  sel = nextTileSelection('pin', sel, screenId)
  assert.equal(sel.pinnedId, screenId)
  assert.equal(sel.expandedId, null, 'fixar NÃO expande')

  sel = nextTileSelection('expand', sel, screenId)
  assert.equal(sel.expandedId, screenId)
  assert.equal(sel.pinnedId, screenId, 'expandir NÃO desafixa')

  sel = nextTileSelection('collapse', sel, screenId)
  assert.equal(sel.expandedId, null)
  assert.equal(sel.pinnedId, screenId, 'recolher preserva a fixação')

  sel = nextTileSelection('unpin', sel, screenId)
  assert.equal(sel.pinnedId, null)
})

test('seleção morta é descartada (tela encerrada não trava o layout)', () => {
  const tiles = buildCallTiles({ participants: [{ fp: PEER, nickname: 'Bob' }], myFp: ME })
  assert.equal(resolveTileId(screenTileId(PEER), tiles), null, 'tela não existe mais')
  assert.equal(resolveTileId(participantTileId(PEER), tiles), participantTileId(PEER))
  assert.equal(resolveTileId(null, tiles), null)
})

test('sortTilesForPin põe o fixado primeiro sem perder ninguém', () => {
  const tiles = buildCallTiles({
    participants: [
      { fp: PEER, nickname: 'Bob' },
      { fp: 'cccccccccccc', nickname: 'Carol', sharing: true },
    ],
    myFp: ME,
  })
  const screenId = screenTileId('cccccccccccc')
  const sorted = sortTilesForPin(tiles, screenId)
  assert.equal(sorted[0].id, screenId)
  assert.equal(sorted.length, tiles.length)
})

test('tilesKey é estável e muda quando um stream aparece/some', () => {
  const a = buildCallTiles({ participants: [{ fp: PEER, nickname: 'Bob' }], myFp: ME })
  const b = buildCallTiles({ participants: [{ fp: PEER, nickname: 'Bob' }], myFp: ME })
  assert.equal(tilesKey(a), tilesKey(b))
  const c = buildCallTiles({ participants: [{ fp: PEER, nickname: 'Bob', sharing: true }], myFp: ME })
  assert.notEqual(tilesKey(a), tilesKey(c))
})

test('caminho nativo: câmera viva sem stream na página vira estado honesto', () => {
  const tiles = buildCallTiles({
    participants: [{ fp: ME, nickname: 'Eu' }],
    myFp: ME,
    local: { stream: null, cameraOn: true, nativeMedia: true },
  })
  const mine = tiles.find((t) => t.kind === 'participant')!
  assert.equal(mine.stream, undefined)
  assert.equal(mine.localPreviewUnavailable, true, 'a UI avisa em vez de fingir vídeo')
})

test('a câmera remota não some quando o outro está compartilhando tela', () => {
  const cam = fakeStream()
  const tiles = buildCallTiles({
    participants: [{ fp: ME, nickname: 'Eu' }, { fp: PEER, nickname: 'Bob', stream: cam, cameraOn: true }],
    myFp: ME,
    local: { stream: fakeStream(), cameraOn: true },
  })
  assert.equal(tiles.find((t) => t.fp === PEER)!.stream, cam)
})

test('streamHasLiveVideo ignora trilha encerrada', () => {
  assert.equal(streamHasLiveVideo(fakeStream({ live: true })), true)
  assert.equal(streamHasLiveVideo(fakeStream({ live: false })), false)
  assert.equal(streamHasLiveVideo(fakeStream({ video: false })), false)
  assert.equal(streamHasLiveVideo(null), false)
})

test('rótulo da tela identifica quem compartilha', () => {
  assert.equal(screenTileLabel('Bob', false), 'Tela de Bob')
  assert.equal(screenTileLabel('', false), 'Tela compartilhada')
  assert.equal(screenTileLabel('Eu', true), 'Sua tela')
})

test('expandir a tela não remove os outros quadrados (áudio continua)', () => {
  // Regra de layout: `visibleCallTiles` mantém TODOS os tiles, apenas reordena
  // o expandido para a frente. Se a expansão filtrasse a lista, os `<audio>`
  // dos remotos desmontariam e a chamada ficaria muda.
  const tiles = buildCallTiles({
    participants: [{ fp: ME, nickname: 'Eu' }, { fp: PEER, nickname: 'Bob', stream: fakeStream() }],
    myFp: ME,
    local: { stream: fakeStream(), screenStream: fakeStream(), cameraOn: true, sharing: true },
  })
  const screenId = screenTileId(ME)
  const ordered = sortTilesForPin(tiles, screenId)
  assert.equal(ordered[0].id, screenId)
  assert.equal(ordered.length, tiles.length, 'ninguém sai da chamada ao expandir a tela')
  assert.ok(ordered.some((t) => t.fp === PEER), 'o remoto continua na lista')
})
