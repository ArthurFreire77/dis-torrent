// Status honesto da mensagem de saída: o relógio não pode dizer
// "aguardando conexão" quando o contato está ONLINE (era o relato "o cara
// parece online mas fica aguardando conexão").
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  statusGlyph,
  statusTitle,
} from '../src/components/social/messageStatus.ts'

describe('statusGlyph', () => {
  it('usa os mesmos glifos do WhatsApp nos dois shells', () => {
    assert.equal(statusGlyph('pending'), '🕓')
    assert.equal(statusGlyph('sending'), '○')
    assert.equal(statusGlyph('sent'), '✓')
    assert.equal(statusGlyph('delivered'), '✓✓')
    assert.equal(statusGlyph('read'), '✓✓')
    assert.equal(statusGlyph('failed'), '✕')
    // 'ok' é mensagem RECEBIDA — não tem status de saída.
    assert.equal(statusGlyph('ok'), '')
    assert.equal(statusGlyph(''), '')
  })
})

describe('statusTitle', () => {
  it('não fala em conexão quando o contato está online', () => {
    const comPeerOnline = statusTitle('pending', true)
    assert.match(comPeerOnline, /online/)
    assert.doesNotMatch(comPeerOnline, /aguardando conexão/)
    // Diz o que realmente falta: confirmação do outro lado.
    assert.match(comPeerOnline, /não confirmou/)
  })

  it('mantém "aguardando conexão" quando o contato está offline', () => {
    assert.equal(statusTitle('pending', false), 'aguardando conexão')
  })

  it('sem informação do contato cai no texto conservador', () => {
    // Grupo/canal não tem UM contato: nunca inventamos que há conexão.
    assert.equal(statusTitle('pending'), 'aguardando conexão')
  })

  it('demais estados não dependem da presença do contato', () => {
    for (const st of ['sent', 'delivered', 'read', 'sending', 'failed']) {
      assert.equal(statusTitle(st, true), statusTitle(st, false))
    }
    assert.equal(statusTitle('sent'), 'enviada')
    assert.equal(statusTitle('failed'), 'falhou — clique para reenviar')
    assert.equal(statusTitle('ok'), '')
  })
})
