/**
 * Bitmap de blocos: um `Set<number>` para 500 GB (2 milhões de blocos) custa
 * centenas de MB; o bitmap custa 2 MB e responde às mesmas operações.
 */
export class ChunkSet implements Iterable<number> {
  private bits: Uint8Array
  private count = 0
  readonly total: number

  constructor(total: number) {
    this.total = total
    this.bits = new Uint8Array(Math.ceil(Math.max(0, total) / 8))
  }

  static full(total: number): ChunkSet {
    const s = new ChunkSet(total)
    s.bits.fill(0xff)
    const sobra = total % 8
    if (sobra !== 0 && s.bits.length > 0) {
      s.bits[s.bits.length - 1] = (1 << sobra) - 1
    }
    s.count = Math.max(0, total)
    return s
  }

  static from(total: number, indices: Iterable<number>): ChunkSet {
    const s = new ChunkSet(total)
    for (const i of indices) s.add(i)
    return s
  }

  get size(): number {
    return this.count
  }

  has(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.total) return false
    return (this.bits[index >> 3] & (1 << (index & 7))) !== 0
  }

  add(index: number): this {
    if (!Number.isInteger(index) || index < 0 || index >= this.total) return this
    const byte = index >> 3
    const mask = 1 << (index & 7)
    if ((this.bits[byte] & mask) === 0) {
      this.bits[byte] |= mask
      this.count++
    }
    return this
  }

  delete(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.total) return false
    const byte = index >> 3
    const mask = 1 << (index & 7)
    if ((this.bits[byte] & mask) === 0) return false
    this.bits[byte] &= ~mask
    this.count--
    return true
  }

  clear(): void {
    this.bits.fill(0)
    this.count = 0
  }

  *[Symbol.iterator](): IterableIterator<number> {
    for (let b = 0; b < this.bits.length; b++) {
      const v = this.bits[b]
      if (v === 0) continue
      for (let bit = 0; bit < 8; bit++) {
        if ((v & (1 << bit)) !== 0) yield b * 8 + bit
      }
    }
  }

  /** Percorre só os blocos que faltam (2 milhões de blocos em ~2 MB de bitmap). */
  *missing(): IterableIterator<number> {
    for (let b = 0; b < this.bits.length; b++) {
      const v = this.bits[b]
      if (v === 0xff) continue
      for (let bit = 0; bit < 8; bit++) {
        const idx = b * 8 + bit
        if (idx >= this.total) return
        if ((v & (1 << bit)) === 0) yield idx
      }
    }
  }

  firstMissing(): number {
    for (const i of this.missing()) return i
    return -1
  }
}
