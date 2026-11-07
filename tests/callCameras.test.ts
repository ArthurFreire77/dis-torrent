import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cameraDevices,
  cameraCycleLabel,
  nextCameraId,
  sameCamera,
  shouldShowCameraFlip,
  shouldShowCameraSwitch,
} from '../src/services/callCameras.ts'

const cam = (deviceId: string, label = '') => ({ kind: 'videoinput', deviceId, label })

test('só lista câmeras, sem duplicar e sem o "default"', () => {
  const lista = cameraDevices([
    cam('default', 'padrão'),
    cam('a', 'Frontal'),
    cam('a', 'Frontal'),
    cam('b', 'Traseira'),
    { kind: 'audioinput', deviceId: 'mic', label: 'Mic' },
  ])
  assert.deepEqual(lista.map((d) => d.deviceId), ['a', 'b'])
})

test('entrada inválida não explode', () => {
  assert.deepEqual(cameraDevices(null), [])
  assert.deepEqual(cameraDevices(undefined), [])
})

test('uma câmera: o botão de alternância NÃO aparece', () => {
  const uma = cameraDevices([cam('a')])
  assert.equal(shouldShowCameraSwitch(uma), false)
  assert.equal(cameraCycleLabel(uma, 'a'), null)
})

test('duas câmeras alternam entre as duas e voltam ao começo', () => {
  const duas = cameraDevices([cam('a'), cam('b')])
  assert.equal(shouldShowCameraSwitch(duas), true)
  assert.equal(nextCameraId(duas, 'a'), 'b')
  assert.equal(nextCameraId(duas, 'b'), 'a', 'depois da última volta para a primeira')
})

test('três câmeras percorrem todas', () => {
  const tres = cameraDevices([cam('a'), cam('b'), cam('c')])
  assert.equal(nextCameraId(tres, 'a'), 'b')
  assert.equal(nextCameraId(tres, 'b'), 'c')
  assert.equal(nextCameraId(tres, 'c'), 'a')
  assert.equal(cameraCycleLabel(tres, 'b'), 'Câmera 2 de 3')
})

test('preferência "padrão do sistema" (vazia) começa pelo segundo aparelho', () => {
  const duas = cameraDevices([cam('a'), cam('b')])
  assert.equal(
    nextCameraId(duas, ''),
    'b',
    'se o primeiro clique ficasse no "padrão", pareceria que o botão não fez nada',
  )
})

test('preferência apontando para device removido cai na primeira', () => {
  const duas = cameraDevices([cam('a'), cam('b')])
  assert.equal(nextCameraId(duas, 'sumiu'), 'a')
})

test('botão de inverter: no celular aparece mesmo com enumerateDevices mentindo', () => {
  assert.equal(shouldShowCameraFlip({ devices: [], rawCount: 0, mobile: true }), true)
  assert.equal(shouldShowCameraFlip({ devices: [], rawCount: 1, mobile: true }), true)
  assert.equal(shouldShowCameraFlip({ devices: cameraDevices([cam('a')]), rawCount: 1, mobile: true }), true)
})

test('botão de inverter no desktop segue a regra honesta: 2+ câmeras', () => {
  assert.equal(shouldShowCameraFlip({ devices: [], rawCount: 0, mobile: false }), false)
  assert.equal(shouldShowCameraFlip({ devices: cameraDevices([cam('a')]), rawCount: 1, mobile: false }), false)
  assert.equal(
    shouldShowCameraFlip({ devices: cameraDevices([cam('a'), cam('b')]), rawCount: 2, mobile: false }),
    true,
  )
  assert.equal(shouldShowCameraFlip({ devices: [], rawCount: 2, mobile: false }), true)
})

test('sameCamera evita anunciar "inverti" quando o sensor não mudou', () => {
  assert.equal(sameCamera({ deviceId: 'a' }, { deviceId: 'a' }), true)
  assert.equal(sameCamera({ deviceId: 'a' }, { deviceId: 'b' }), false)
  assert.equal(sameCamera({ facingMode: 'user' }, { facingMode: 'user' }), true)
  assert.equal(sameCamera({ facingMode: 'user' }, { facingMode: 'environment' }), false)
  assert.equal(sameCamera(null, { deviceId: 'a' }), false, 'settings ausente não prova nada')
  assert.equal(sameCamera({ deviceId: 'a' }, { facingMode: 'user' }), false, 'id e facing não se comparam')
})

test('lista vazia devolve null em vez de quebrar', () => {
  assert.equal(nextCameraId([], 'a'), null)
})

test('rótulo não mente sobre a posição', () => {
  const duas = cameraDevices([cam('a'), cam('b')])
  assert.equal(cameraCycleLabel(duas, 'a'), 'Câmera 1 de 2')
  assert.equal(cameraCycleLabel(duas, 'b'), 'Câmera 2 de 2')
})
