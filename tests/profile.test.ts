import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dark, light, resolveTheme, avatarColor } from '../src/shared/theme.ts'
import { avatarCacheGet, avatarCacheSet, avatarCacheClear, AVATAR_MAX_PX, AVATAR_MAX_BYTES } from '../src/shared/avatar.ts'

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
})
