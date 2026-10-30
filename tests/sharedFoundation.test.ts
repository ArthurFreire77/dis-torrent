// Testes da fundação compartilhada (`src/shared/*`).
//
// Estes módulos nasceram para eliminar duplicação, então o teste tem um alvo
// específico: garantir que o comportamento é EXATAMENTE o que cada cópia antiga
// prometia, para a consolidação não virar regressão silenciosa.

import test from 'node:test'
import assert from 'node:assert/strict'

test('bytes: os dois formatos históricos continuam iguais ao que a UI mostrava', async () => {
  const { formatFileSize, formatBytes } = await import('../src/shared/bytes.ts')

  // Anexos: ponto decimal, duas casas em MB (cartão de arquivo).
  assert.equal(formatFileSize(512), '512 B')
  assert.equal(formatFileSize(2048), '2.0 KB')
  assert.equal(formatFileSize(5 * 1024 * 1024), '5.00 MB')
  assert.equal(formatFileSize(0), '0 B')

  // Update: vírgula decimal (pt-BR) e "?" quando não se sabe o tamanho.
  assert.equal(formatBytes(9_337_131), '8,9 MB')
  assert.equal(formatBytes(2048), '2 KB')
  assert.equal(formatBytes(0), '?')
  assert.equal(formatBytes(Number.NaN), '?')
  // Abaixo de 1 KB o cartão não pode dizer "0 KB".
  assert.equal(formatBytes(300), '1 KB')
})

test('bytes: valor negativo ou não finito não vira texto absurdo', async () => {
  const { formatFileSize } = await import('../src/shared/bytes.ts')
  assert.equal(formatFileSize(-5), '0 B')
  assert.equal(formatFileSize(Number.POSITIVE_INFINITY), '0 B')
})

test('base64: ida e volta preserva bytes, inclusive acima do bloco de 8 KiB', async () => {
  const { bytesToBase64, base64ToBytes, tryBase64ToBytes } = await import('../src/shared/base64.ts')
  for (const size of [0, 1, 255, 8192, 8193, 300_000]) {
    const src = new Uint8Array(size)
    for (let i = 0; i < size; i++) src[i] = (i * 37 + 11) & 0xff
    const round = base64ToBytes(bytesToBase64(src))
    assert.equal(round.length, size, `tamanho ${size}`)
    assert.deepEqual(round, src, `conteúdo ${size}`)
  }
  assert.equal(base64ToBytes('').length, 0)
  // Lixo de terceiro devolve null em vez de lançar dentro do laço de rede.
  assert.equal(tryBase64ToBytes('não é base64 %%%'), null)
})

test('emitter: falha de um handler não impede os outros', async () => {
  const { createEmitter } = await import('../src/shared/emitter.ts')
  const bus = createEmitter<number>()
  const got: number[] = []
  let errors = 0
  const errored = createEmitter<number>(() => { errors++ })

  errored.subscribe(() => { throw new Error('quebrado') })
  errored.subscribe((v) => got.push(v))

  errored.emit(1)
  assert.deepEqual(got, [1], 'o segundo handler recebe mesmo com o primeiro lançando')
  assert.equal(errors, 1, 'a falha é reportada ao dono do bus')

  bus.subscribe((v) => got.push(v * 10))
  bus.emit(2)
  assert.deepEqual(got, [1, 20])
})

test('emitter: cancelar duas vezes não quebra e o handler sai na hora', async () => {
  const { createEmitter } = await import('../src/shared/emitter.ts')
  const bus = createEmitter<string>()
  const got: string[] = []
  const off = bus.subscribe((v) => got.push(v))
  assert.equal(bus.size(), 1)
  off()
  off()
  assert.equal(bus.size(), 0)
  bus.emit('depois')
  assert.deepEqual(got, [])
})

test('emitter: handler que se cancela durante a entrega não pula os seguintes', async () => {
  const { createEmitter } = await import('../src/shared/emitter.ts')
  const bus = createEmitter<number>()
  const got: string[] = []
  const offA = bus.subscribe(() => { got.push('a'); offA() })
  bus.subscribe(() => got.push('b'))
  bus.emit(1)
  bus.emit(2)
  assert.deepEqual(got, ['a', 'b', 'b'], 'a sai depois da primeira entrega; b continua')
})

test('runtime: sem window/navigator (Node) não quebra e assume navegador puro', async () => {
  const rt = await import('../src/shared/runtime.ts')
  assert.equal(rt.isTauriRuntime(), false)
  assert.equal(rt.isAndroidRuntime(), false)
  assert.equal(rt.isTauriAndroid(), false)
  assert.equal(rt.isIOSRuntime(), false)
  assert.equal(rt.isBrowserOnly(), true)
})

test('runtime: reconhece as três marcas de IPC do Tauri', async () => {
  const rt = await import('../src/shared/runtime.ts')
  const realWindow = (globalThis as { window?: unknown }).window
  try {
    for (const flag of ['__TAURI_INTERNALS__', '__TAURI__', '__TAURI_IPC__']) {
      ;(globalThis as { window?: unknown }).window = { [flag]: {} }
      assert.equal(rt.isTauriRuntime(), true, `${flag} marca Tauri`)
    }
    ;(globalThis as { window?: unknown }).window = {}
    assert.equal(rt.isTauriRuntime(), false, 'window comum não é Tauri')
  } finally {
    ;(globalThis as { window?: unknown }).window = realWindow
  }
})
