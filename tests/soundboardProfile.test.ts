import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  SOUND_MAX_BYTES, SOUND_MAX_SECONDS, checkSoundUpload, estimateWavSeconds,
  isDownloadableSoundUrl, soundMime, soundNameSlug, soundSourceHost, sniffAudioExt,
} from '../src/services/soundboardRules.ts'
import {
  AVATAR_EFFECTS, PROFILE_THEMES, bannerBackground, effectClass, effectColor,
  normalizeAvatarEffect, normalizeDecoration, normalizeTheme, themeGradient,
} from '../src/shared/profileStyle.ts'

function wav(seconds: number): Uint8Array {
  const rate = 8000
  const data = rate * seconds
  const out = new Uint8Array(44 + data)
  const dv = new DataView(out.buffer)
  out.set([0x52, 0x49, 0x46, 0x46], 0)
  dv.setUint32(4, 36 + data, true)
  out.set([0x57, 0x41, 0x56, 0x45], 8)
  out.set([0x66, 0x6d, 0x74, 0x20], 12)
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, rate, true)
  dv.setUint32(28, rate, true)
  dv.setUint16(32, 1, true)
  dv.setUint16(34, 8, true)
  out.set([0x64, 0x61, 0x74, 0x61], 36)
  dv.setUint32(40, data, true)
  out.fill(128, 44)
  return out
}

describe('soundboard: formatos aceitos', () => {
  test('reconhece WAV, OGG, FLAC, M4A e MP3 pelos magic bytes', () => {
    assert.equal(sniffAudioExt(wav(1)), 'wav')
    const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...new Array(16).fill(0)])
    assert.equal(sniffAudioExt(ogg), 'ogg')
    const flac = new Uint8Array([0x66, 0x4c, 0x61, 0x43, ...new Array(16).fill(0)])
    assert.equal(sniffAudioExt(flac), 'flac')
    const m4a = new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, ...new Array(12).fill(0)])
    assert.equal(sniffAudioExt(m4a), 'm4a')
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, ...new Array(16).fill(0)])
    assert.equal(sniffAudioExt(mp3), 'mp3')
  })

  test('executável e texto puro NÃO passam por áudio', () => {
    const exe = new Uint8Array([0x4d, 0x5a, ...new Array(64).fill(0)])
    assert.equal(sniffAudioExt(exe), null)
    assert.equal(sniffAudioExt(new TextEncoder().encode('#!/bin/sh\necho oi\n')), null)
    assert.equal(sniffAudioExt(new Uint8Array(0)), null)
    assert.equal(sniffAudioExt(new Uint8Array(4)), null)
  })

  test('mime acompanha a extensão detectada', () => {
    assert.equal(soundMime('wav'), 'audio/wav')
    assert.equal(soundMime('mp3'), 'audio/mpeg')
    assert.equal(soundMime('desconhecido'), 'audio/wav')
  })
})

describe('soundboard: limites', () => {
  test('WAV de 3s tem duração estimada em 3s', () => {
    const s = estimateWavSeconds(wav(3))
    assert.ok(Math.abs(s - 3) < 0.05, `estimou ${s}`)
  })

  test('aceita som dentro dos 10s', () => {
    const r = checkSoundUpload({ bytes: wav(8) })
    assert.equal(r.ok, true)
    assert.equal(r.ext, 'wav')
    assert.ok((r.seconds ?? 0) <= SOUND_MAX_SECONDS)
  })

  test('recusa som acima de 10s', () => {
    const r = checkSoundUpload({ bytes: wav(12) })
    assert.equal(r.ok, false)
    assert.match(String(r.reason), /limite é 10s/)
  })

  test('duração decodificada manda mais que a estimativa', () => {
    const r = checkSoundUpload({ bytes: wav(2), decodedSeconds: 14 })
    assert.equal(r.ok, false)
  })

  test('recusa arquivo acima de 2 MB', () => {
    const big = new Uint8Array(SOUND_MAX_BYTES + 1)
    big.set([0x52, 0x49, 0x46, 0x46])
    big.set([0x57, 0x41, 0x56, 0x45], 8)
    const r = checkSoundUpload({ bytes: big })
    assert.equal(r.ok, false)
    assert.match(String(r.reason), /grande demais/)
  })

  test('recusa vazio', () => {
    assert.equal(checkSoundUpload({ bytes: new Uint8Array(0) }).ok, false)
  })
})

describe('soundboard: origem do download', () => {
  test('só aceita https com host', () => {
    assert.equal(isDownloadableSoundUrl('https://exemplo.com/som.mp3'), true)
    assert.equal(isDownloadableSoundUrl('http://exemplo.com/som.mp3'), false)
    assert.equal(isDownloadableSoundUrl('file:///etc/passwd'), false)
    assert.equal(isDownloadableSoundUrl('https://localhost/som.mp3'), false)
    assert.equal(isDownloadableSoundUrl('javascript:alert(1)'), false)
    assert.equal(isDownloadableSoundUrl('https://exemplo.com/a b.mp3'), false)
    assert.equal(isDownloadableSoundUrl(''), false)
  })

  test('host é exposto para a UI sem enganar', () => {
    assert.equal(soundSourceHost('https://cdn.exemplo.com/x.mp3'), 'cdn.exemplo.com')
    assert.equal(soundSourceHost('lixo'), '')
  })

  test('nome do som vem do arquivo e não da URL inteira', () => {
    assert.equal(soundNameSlug('https://x.com/a/buzina.mp3?token=1'), 'buzina')
    assert.equal(soundNameSlug('C:\\sons\\aplausos.ogg'), 'aplausos')
    assert.equal(soundNameSlug('sem-extensao'), 'sem-extensao')
    assert.equal(soundNameSlug(''), 'som')
    assert.ok(soundNameSlug('x'.repeat(200)).length <= 40)
  })
})

describe('perfil decorado: allowlist', () => {
  test('tema fora da lista vira none', () => {
    assert.equal(normalizeTheme('aurora'), 'aurora')
    assert.equal(normalizeTheme('AURORA'), 'aurora')
    assert.equal(normalizeTheme('javascript:alert(1)'), 'none')
    assert.equal(normalizeTheme(''), 'none')
    assert.equal(normalizeTheme(null), 'none')
    for (const t of PROFILE_THEMES) assert.equal(normalizeTheme(t), t)
  })

  test('efeito fora da lista vira none', () => {
    assert.equal(normalizeAvatarEffect('pulse'), 'pulse')
    assert.equal(normalizeAvatarEffect('explode'), 'none')
    for (const e of AVATAR_EFFECTS) assert.equal(normalizeAvatarEffect(e), e)
  })

  test('gradiente usa a cor de destaque quando não há tema', () => {
    const g = themeGradient('none', '#ff0000')
    assert.equal(g.from, '#ff0000')
    const aurora = themeGradient('aurora', '#ff0000')
    assert.notEqual(aurora.from, '#ff0000')
  })

  test('banner: capa vence tema; sem capa o tema pinta', () => {
    assert.match(bannerBackground('aurora', '#5865f2', 'QUJD'), /data:image\/jpeg;base64,QUJD/)
    assert.match(bannerBackground('aurora', '#5865f2', ''), /linear-gradient/)
    assert.match(bannerBackground('none', '#5865f2', ''), /#5865f2/)
  })

  test('classe do efeito é fechada (nada de CSS arbitrário)', () => {
    assert.equal(effectClass('glow'), 'pfx pfx-glow')
    assert.equal(effectClass('none'), '')
    assert.equal(effectClass('"><script>'), '')
    assert.equal(effectColor('none', '#fff'), null)
    assert.equal(effectColor('glow', '#123456'), '#123456')
  })

  test('decoração aceita até 3 grafemas e recusa texto comum', () => {
    assert.equal(normalizeDecoration('🌸'), '🌸')
    assert.equal(normalizeDecoration(''), '')
    assert.equal(normalizeDecoration('oi'), '', 'texto comum não pode virar decoração')
    assert.equal(normalizeDecoration('abc'), '')
    assert.equal(normalizeDecoration('🌸🌸🌸🌸'), '')
    assert.equal(normalizeDecoration('\u200b🌸'), '🌸')
  })
})
