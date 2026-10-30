// Regras de notificação/presença — SEM WebView, sem SO.
//
// Estes testes travam os erros que mais doem num app de mensagens:
//  • aviso duplicado para a mesma mensagem;
//  • notificação de canal silenciado;
//  • prévia de texto vazando com "mostrar prévia" desligado;
//  • usuário aparecendo ONLINE só porque o processo está conectado.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSeenTracker,
  decideMessageNotice,
  derivePresence,
  levelAllows,
  notificationIdFor,
  truncate,
} from '../src/services/notificationRules.ts'

describe('presença ≠ conexão', () => {
  it('online cai para ausente quando a janela não está em uso', () => {
    assert.equal(derivePresence('online', 'background', false), 'idle')
    assert.equal(derivePresence('online', 'active', false), 'online')
  })

  it('quem pediu para continuar online continua online', () => {
    assert.equal(derivePresence('online', 'background', true), 'online')
  })

  it('dnd/invisible/offline não mudam sozinhos', () => {
    assert.equal(derivePresence('dnd', 'background', false), 'dnd')
    assert.equal(derivePresence('invisible', 'background', true), 'invisible')
    assert.equal(derivePresence('offline', 'active', false), 'offline')
  })
})

describe('id de notificação por conversa', () => {
  it('é estável e positivo (0 é "sem id" no plugin)', () => {
    const a = notificationIdFor('conv:abc')
    assert.equal(a, notificationIdFor('conv:abc'))
    assert.ok(a > 0)
    assert.ok(Number.isSafeInteger(a))
  })

  it('conversas diferentes não colidem', () => {
    assert.notEqual(notificationIdFor('conv:abc'), notificationIdFor('conv:abd'))
  })
})

describe('dedupe', () => {
  it('a mesma mensagem não notifica duas vezes', () => {
    const t = createSeenTracker(10)
    assert.equal(t.seen('m1'), false)
    assert.equal(t.seen('m1'), true)
  })

  it('respeita o teto e libera as mais antigas', () => {
    const t = createSeenTracker(3)
    for (const id of ['a', 'b', 'c', 'd']) t.seen(id)
    assert.equal(t.size, 3)
    // 'a' foi evicted → visto de novo como novo
    assert.equal(t.seen('a'), false)
    assert.equal(t.seen('d'), true)
  })

  it('id vazio nunca conta como visto', () => {
    const t = createSeenTracker(3)
    assert.equal(t.seen(''), false)
    assert.equal(t.seen(''), false)
  })
})

describe('nível de notificação', () => {
  it('silenciado nunca avisa', () => {
    assert.equal(levelAllows('none', true), false)
  })
  it('só menções exige menção', () => {
    assert.equal(levelAllows('mentions', false), false)
    assert.equal(levelAllows('mentions', true), true)
  })
  it('tudo avisa sempre', () => {
    assert.equal(levelAllows('all', false), true)
  })
})

describe('decisão de aviso de mensagem', () => {
  const base = {
    level: 'all' as const,
    mentioned: false,
    activity: 'background' as const,
    openConversation: null,
    conversationId: 'c1',
    systemEnabled: true,
    previewEnabled: true,
    count: 1,
    preview: 'oi, tudo bem?',
  }

  it('em segundo plano mostra com prévia', () => {
    const d = decideMessageNotice(base)
    assert.equal(d.show, true)
    assert.match(d.body, /tudo bem/)
  })

  it('em primeiro plano NÃO usa o SO (a UI já avisa)', () => {
    const d = decideMessageNotice({ ...base, activity: 'active' })
    assert.equal(d.show, false)
    assert.equal(d.counts, true)
  })

  it('conversa aberta não notifica', () => {
    assert.equal(decideMessageNotice({ ...base, openConversation: 'c1' }).show, false)
  })

  it('prévia desligada não vaza o texto', () => {
    const d = decideMessageNotice({ ...base, previewEnabled: false })
    assert.equal(d.show, true)
    assert.equal(d.body, 'Nova mensagem')
    assert.ok(!d.body.includes('tudo bem'))
  })

  it('a segunda mensagem da conversa NÃO mostra contador — mostra o texto', () => {
    // O usuário pediu explicitamente: "não quero 'você tem tantas mensagens',
    // quero saber o que a pessoa mandou". O contador continua no badge/não-lidas.
    const d = decideMessageNotice({ ...base, count: 3 })
    assert.equal(d.show, true)
    assert.equal(d.body, 'oi, tudo bem?')
    assert.ok(!d.body.includes('novas mensagens'))
  })

  it('sem prévia, várias mensagens também não viram contador', () => {
    const d = decideMessageNotice({ ...base, count: 3, previewEnabled: false })
    assert.equal(d.show, true)
    assert.equal(d.body, 'Nova mensagem')
  })

  it('silenciado não mostra nem conta', () => {
    const d = decideMessageNotice({ ...base, level: 'none' })
    assert.equal(d.show, false)
    assert.equal(d.counts, false)
  })

  it('menções sem menção não mostra', () => {
    const d = decideMessageNotice({ ...base, level: 'mentions', mentioned: false })
    assert.equal(d.show, false)
    assert.equal(d.counts, false)
  })

  it('avisos do SO desligados: conta, mas não mostra', () => {
    const d = decideMessageNotice({ ...base, systemEnabled: false })
    assert.equal(d.show, false)
    assert.equal(d.counts, true)
  })
})

describe('truncate', () => {
  it('colapsa espaços e corta com reticências', () => {
    assert.equal(truncate('  a   b  '), 'a b')
    const long = 'x'.repeat(200)
    assert.ok(truncate(long, 10).endsWith('…'))
    assert.equal(truncate(long, 10).length, 10)
  })
})
