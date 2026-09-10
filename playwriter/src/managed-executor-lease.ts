import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js'
import type { ICDPSession } from './cdp-session.js'

export class ManagedExecutionLease {
  private active = true

  isActive(): boolean {
    return this.active
  }

  assertActive(): void {
    if (!this.active) {
      throw new Error('Managed raw execution lease has expired; future browser control calls are rejected')
    }
  }

  release(): void {
    this.active = false
  }
}

export class ManagedTimerScope {
  private readonly timeouts = new Set<ReturnType<typeof setTimeout>>()
  private readonly intervals = new Set<ReturnType<typeof setInterval>>()

  constructor(private readonly lease: ManagedExecutionLease) {}

  setTimeout(handler: unknown, delay?: number): ReturnType<typeof setTimeout> {
    this.lease.assertActive()
    const callback = timerCallback(handler)
    const timer = setTimeout(() => {
      if (!this.lease.isActive()) {
        return
      }
      callback()
      this.timeouts.delete(timer)
    }, delay)
    this.timeouts.add(timer)
    return timer
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer)
    this.timeouts.delete(timer)
  }

  setInterval(handler: unknown, delay?: number): ReturnType<typeof setInterval> {
    this.lease.assertActive()
    const callback = timerCallback(handler)
    const timer = setInterval(() => {
      if (!this.lease.isActive()) {
        return
      }
      callback()
    }, delay)
    this.intervals.add(timer)
    return timer
  }

  clearInterval(timer: ReturnType<typeof setInterval>): void {
    clearInterval(timer)
    this.intervals.delete(timer)
  }

  dispose(): void {
    this.timeouts.forEach((timer) => {
      clearTimeout(timer)
    })
    this.intervals.forEach((timer) => {
      clearInterval(timer)
    })
    this.timeouts.clear()
    this.intervals.clear()
  }
}

export class LeasedCDPSession implements ICDPSession {
  private readonly session: ICDPSession
  private readonly lease: ManagedExecutionLease
  private readonly subscriptions: Array<{
    event: string
    original: unknown
    remove: () => void
  }> = []

  constructor({ session, lease }: { session: ICDPSession; lease: ManagedExecutionLease }) {
    this.session = session
    this.lease = lease
  }

  async send<K extends keyof ProtocolMapping.Commands>(
    method: K,
    params?: ProtocolMapping.Commands[K]['paramsType'][0],
    sessionId?: string | null,
  ): Promise<ProtocolMapping.Commands[K]['returnType']> {
    this.lease.assertActive()
    return await this.session.send(method, params, sessionId)
  }

  on<K extends keyof ProtocolMapping.Events>(event: K, callback: (params: ProtocolMapping.Events[K][0]) => void): this {
    this.lease.assertActive()
    const leasedCallback = (params: ProtocolMapping.Events[K][0]): void => {
      if (!this.lease.isActive()) {
        return
      }
      callback(params)
    }
    this.session.on(event, leasedCallback)
    this.subscriptions.push({
      event: String(event),
      original: callback,
      remove: () => {
        this.session.off(event, leasedCallback)
      },
    })
    return this
  }

  off<K extends keyof ProtocolMapping.Events>(event: K, callback: (params: ProtocolMapping.Events[K][0]) => void): this {
    const index = this.subscriptions.findIndex((subscription) => {
      return subscription.event === String(event) && subscription.original === callback
    })
    if (index >= 0) {
      const [subscription] = this.subscriptions.splice(index, 1)
      subscription.remove()
    }
    return this
  }

  async detach(): Promise<void> {
    this.lease.assertActive()
    await this.session.detach()
  }

  dispose(): void {
    const subscriptions = this.subscriptions.splice(0, this.subscriptions.length)
    subscriptions.forEach((subscription) => {
      try {
        subscription.remove()
      } catch (error) {
        console.error('[managed-executor] failed to remove CDP listener:', error)
      }
    })
  }
}

function timerCallback(handler: unknown): () => void {
  if (typeof handler !== 'function') {
    throw new TypeError('Managed raw execution timers require a function callback')
  }
  return () => {
    try {
      const result = handler()
      void Promise.resolve(result).catch((error) => {
        console.error('[managed-executor] request-scoped timer callback failed:', error)
      })
    } catch (error) {
      console.error('[managed-executor] request-scoped timer callback failed:', error)
    }
  }
}
