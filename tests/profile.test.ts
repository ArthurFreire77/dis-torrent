import { profileContentHash, shouldApplyRemoteProfile } from '../src/services/profileRevision.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dark, light, resolveTheme, avatarColor } from '../src/shared/theme.ts'
import { avatarCacheGet, avatarCacheSet, avatarCacheClear, AVATAR_MAX_PX, AVATAR_MAX_BYTES, BANNER_MAX_BYTES } from '../src/shared/avatar.ts'

describe('theme tokens', () => {
  it('dark/light preservam os hex em produção', () => {
    assert.equal(dark.accent, '#5865f2')
    assert.equal(dark.rail, '#1e1f22')
    assert.equal(light.main, '#ffffff')
  })
  it('resolveTheme nunca quebra sem window', () => {
    assert.equal(resolveTheme('dark').main, '#313338')
    assert.equal(resolveTheme('light').main, '#ffffff')
  })
  it('avatarColor é determinística', () => {
    assert.equal(avatarColor('abc123'), avatarColor('abc123'))
  })
})

describe('avatar cache', () => {
  it('set/get com LRU', () => {
    avatarCacheClear()
    avatarCacheSet('fp1', 'aaa')
    assert.equal(avatarCacheGet('fp1'), 'aaa')
    assert.equal(avatarCacheGet('missing'), undefined)
  })
  it('limites P2P', () => {
    assert.equal(AVATAR_MAX_PX, 128)
    assert.ok(AVATAR_MAX_BYTES <= 100_000)
  })
  it('avatar + capa cabem no frame do P2P (senão a foto nunca chega)', () => {
    // O core tem PROFILE_IMG_B64_MAX=80_000 e PROFILE_BANNER_B64_MAX=110_000.
    // Estes limites falham ALTO se alguém aumentar a compressão sem revisar o
    // transporte: avatares acima disso eram cortados/evictados no relay e o
    // destinatário nunca via a foto.
    const b64 = (bytes: number) => Math.ceil(bytes / 3) * 4
    assert.ok(b64(AVATAR_MAX_BYTES) <= 80_000, 'avatar base64 acima do teto do core')
    assert.ok(b64(BANNER_MAX_BYTES) <= 110_000, 'capa base64 acima do teto do core')
    // Soma dos dois (pior caso de um ProfileSet) com folga no frame de 1 MiB.
    assert.ok(b64(AVATAR_MAX_BYTES) + b64(BANNER_MAX_BYTES) < 200_000)
  })
})

// ============ REVISÃO E SINCRONIZAÇÃO DE PERFIL ============
// Cobre a política de conflito usada pelo core (social.rs) e pelo mock do
// navegador: revisão maior vence, versão antiga é descartada, conteúdo igual
// não gera trabalho e edições concorrentes convergem sem depender do relógio.

describe('perfil: hash de conteúdo', () => {
  it('é determinístico e estável para os mesmos campos', () => {
    const p = { display_name: 'Ana', about: 'bio', avatar_b64: 'QUJD', banner_b64: '', accent: '#5865f2' }
    assert.equal(profileContentHash(p), profileContentHash({ ...p }))
    assert.equal(profileContentHash(p).length, 32)
  })

  it('muda quando qualquer campo público muda', () => {
    const base = { display_name: 'Ana', about: '', avatar_b64: '', banner_b64: '', accent: '' }
    const h = profileContentHash(base)
    assert.notEqual(profileContentHash({ ...base, display_name: 'Ana Maria' }), h)
    assert.notEqual(profileContentHash({ ...base, about: 'oi' }), h)
    assert.notEqual(profileContentHash({ ...base, avatar_b64: 'QUJD' }), h)
    assert.notEqual(profileContentHash({ ...base, banner_b64: 'QUJD' }), h)
    assert.notEqual(profileContentHash({ ...base, accent: '#ff0000' }), h)
  })

  it('não colide com a concatenação ingênua dos campos', () => {
    // "ab"+"c" e "a"+"bc" precisam ser perfis DIFERENTES.
    const a = profileContentHash({ display_name: 'ab', about: 'c', avatar_b64: '', banner_b64: '', accent: '' })
    const b = profileContentHash({ display_name: 'a', about: 'bc', avatar_b64: '', banner_b64: '', accent: '' })
    assert.notEqual(a, b)
  })
})

describe('perfil: política de conflito', () => {
  it('revisão maior vence', () => {
    assert.equal(shouldApplyRemoteProfile({ rev: 1 }, { rev: 2 }), true)
  })

  it('revisão antiga NUNCA sobrescreve a nova', () => {
    assert.equal(shouldApplyRemoteProfile({ rev: 5 }, { rev: 3 }), false)
    assert.equal(shouldApplyRemoteProfile({ rev: 5 }, { rev: 4 }), false)
  })

  it('mesma revisão e mesmo conteúdo = nada a fazer', () => {
    const h = 'abc123'
    assert.equal(shouldApplyRemoteProfile({ rev: 4, content_hash: h }, { rev: 4, content_hash: h }), false)
  })

  it('mesma revisão com conteúdo diferente converge (maior hash vence)', () => {
    const low = { rev: 2, content_hash: '1111' }
    const high = { rev: 2, content_hash: '9999' }
    assert.equal(shouldApplyRemoteProfile(low, high), true)
    assert.equal(shouldApplyRemoteProfile(high, low), false)
  })

  it('perfil legado (rev 0) mantém o comportamento anterior', () => {
    assert.equal(shouldApplyRemoteProfile(null, { rev: 0, content_hash: 'aaa' }), true)
    assert.equal(shouldApplyRemoteProfile({ rev: 0, content_hash: 'aaa' }, { rev: 0, content_hash: 'aaa' }), false)
  })
})
