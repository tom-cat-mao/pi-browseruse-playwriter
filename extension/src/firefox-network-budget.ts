export class FirefoxNetworkBudget {
  usedBytes = 0
  readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  createBody(limit: number): FirefoxNetworkBody {
    return new FirefoxNetworkBody({ budget: this, limit })
  }
}

export class FirefoxNetworkBody {
  private readonly budget: FirefoxNetworkBudget
  private readonly limit: number
  private chunks: Uint8Array[] = []
  private bytes = 0
  private ended = false
  truncated = false

  constructor(options: { budget: FirefoxNetworkBudget; limit: number }) {
    this.budget = options.budget
    this.limit = options.limit
  }

  append(data: Uint8Array): void {
    if (this.ended || this.truncated) return
    const room = Math.min(this.limit - this.bytes, this.budget.limit - this.budget.usedBytes)
    const part = data.slice(0, room)
    if (part.byteLength) {
      this.chunks.push(part)
      this.bytes += part.byteLength
      this.budget.usedBytes += part.byteLength
    }
    if (part.byteLength < data.byteLength) this.truncated = true
  }

  retainText(text: string): string {
    if (this.ended) return ''
    this.releaseBytes()
    this.ended = true
    const room = Math.min(this.limit, this.budget.limit - this.budget.usedBytes)
    let end = 0
    for (const character of text) {
      const point = character.codePointAt(0)!
      const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
      if (this.bytes + size > room) break
      this.bytes += size
      end += character.length
    }
    this.budget.usedBytes += this.bytes
    if (end < text.length) this.truncated = true
    return text.slice(0, end)
  }

  finish(): string {
    if (this.ended) return ''
    const bytes = new Uint8Array(this.bytes)
    let offset = 0
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return this.retainText(new TextDecoder().decode(bytes))
  }

  release(): void {
    this.ended = true
    this.releaseBytes()
  }

  private releaseBytes(): void {
    this.budget.usedBytes -= this.bytes
    this.bytes = 0
    this.chunks = []
  }
}
