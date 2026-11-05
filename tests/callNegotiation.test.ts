import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOfferInStable } from '../src/services/callMedia.ts'

function fakePC(opts: { state: string; depoisDoCreateOffer?: string }) {
  let signalingState = opts.state
  let setLocal = 0
  const pc = {
    get signalingState() { return signalingState },
    async createOffer() {
      if (opts.depoisDoCreateOffer) signalingState = opts.depoisDoCreateOffer
      return { type: 'offer', sdp: 'v=0\r\n' }
    },
    async setLocalDescription(desc: { type: string }) {
      if (signalingState !== 'stable') {
        throw new Error(`Failed to set local ${desc.type} sdp: Called in wrong state: ${signalingState}`)
      }
      setLocal++
      signalingState = 'have-local-offer'
    },
  }
  return { pc: pc as unknown as Parameters<typeof applyOfferInStable>[0], contador: () => setLocal }
}

test('não aplica offer quando o PC já não está em stable', async () => {
  const { pc, contador } = fakePC({ state: 'have-remote-offer' })
  const offer = await applyOfferInStable(pc)
  assert.equal(offer, null, 'devolve null em vez de lançar')
  assert.equal(contador(), 0, 'não chamou setLocalDescription')
})

test('a oferta remota que chega DURANTE o createOffer não faz setLocalDescription', async () => {
  const { pc, contador } = fakePC({ state: 'stable', depoisDoCreateOffer: 'have-remote-offer' })
  const offer = await applyOfferInStable(pc)
  assert.equal(offer, null, 'a offer é descartada, não aplicada fora de hora')
  assert.equal(contador(), 0, 'nenhum setLocalDescription em estado errado')
})

test('aplica normalmente quando o PC continua em stable', async () => {
  const { pc, contador } = fakePC({ state: 'stable' })
  const offer = await applyOfferInStable(pc)
  assert.ok(offer, 'devolve a offer aplicada')
  assert.equal(contador(), 1)
})

test('iceRestart pede a offer com iceRestart (reparo de rota)', async () => {
  let pediu: any = null
  const pc = {
    get signalingState() { return 'stable' },
    async createOffer(o?: any) { pediu = o; return { type: 'offer', sdp: '' } },
    async setLocalDescription() {  },
  } as unknown as Parameters<typeof applyOfferInStable>[0]
  await applyOfferInStable(pc, { iceRestart: true })
  assert.deepEqual(pediu, { iceRestart: true })
})

test('PC fechado não tenta renegociar', async () => {
  const { pc, contador } = fakePC({ state: 'closed' })
  assert.equal(await applyOfferInStable(pc), null)
  assert.equal(contador(), 0)
})
