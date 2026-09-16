import { describe, expect, test } from 'vitest'
import { FirefoxNetworkBudget } from '../src/firefox-network-budget'

const encode = (text: string): Uint8Array => {
  return new TextEncoder().encode(text)
}

describe('Firefox network body byte budget', () => {
  test('concurrent chunks share space with retained request and response text', () => {
    const budget = new FirefoxNetworkBudget(12)
    const request = budget.createBody(8)
    const first = budget.createBody(8)
    const second = budget.createBody(8)
    expect(request.retainText('猫')).toBe('猫')
    first.append(encode('12345'))
    second.append(encode('abcdef'))
    expect(budget.usedBytes).toBe(12)
    expect(second.truncated).toBe(true)
    expect(first.finish()).toBe('12345')
    expect(second.finish()).toBe('abcd')
    expect(budget.usedBytes).toBe(12)
    request.release()
    first.release()
    second.release()
    expect(budget.usedBytes).toBe(0)
  })

  test('200 concurrent responses cannot reserve more than the capture byte limit', () => {
    const budget = new FirefoxNetworkBudget(2 * 1024 * 1024)
    const bodies = Array.from({ length: 200 }, () => {
      return budget.createBody(64 * 1024)
    })
    const chunk = new Uint8Array(64 * 1024).fill(97)
    for (const body of bodies) {
      body.append(chunk)
      expect(budget.usedBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
    }
    expect(budget.usedBytes).toBe(2 * 1024 * 1024)
    expect(
      bodies.filter((body) => {
        return body.truncated
      }).length,
    ).toBe(168)
    for (const body of bodies) {
      body.finish()
      expect(budget.usedBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
    }
    for (const body of bodies) body.release()
    expect(budget.usedBytes).toBe(0)
  })

  test('Unicode text is charged in UTF-8 bytes without splitting surrogate pairs', () => {
    const budget = new FirefoxNetworkBudget(8)
    const body = budget.createBody(8)
    expect(body.retainText('猫😀ab')).toBe('猫😀a')
    expect(body.truncated).toBe(true)
    expect(budget.usedBytes).toBe(8)
    body.release()
    expect(budget.usedBytes).toBe(0)
  })

  test('invalid UTF-8 expansion cannot consume another in-flight reservation', () => {
    const budget = new FirefoxNetworkBudget(7)
    const invalid = budget.createBody(6)
    const concurrent = budget.createBody(6)
    invalid.append(Uint8Array.from([255, 255, 255]))
    concurrent.append(encode('abcd'))
    expect(invalid.finish()).toBe('�')
    expect(invalid.truncated).toBe(true)
    expect(budget.usedBytes).toBe(7)
    expect(concurrent.finish()).toBe('abcd')
    invalid.release()
    concurrent.release()
    expect(budget.usedBytes).toBe(0)
  })

  test('split UTF-8 chunks decode together and empty chunks consume no quota', () => {
    const budget = new FirefoxNetworkBudget(4)
    const body = budget.createBody(4)
    const emoji = encode('😀')
    body.append(emoji.subarray(0, 2))
    body.append(new Uint8Array())
    body.append(emoji.subarray(2))
    expect(body.finish()).toBe('😀')
    expect(body.truncated).toBe(false)
    expect(budget.usedBytes).toBe(4)
    body.release()
    expect(budget.usedBytes).toBe(0)
  })

  test('per-body truncation forwards no ownership of the source buffer', () => {
    const budget = new FirefoxNetworkBudget(20)
    const body = budget.createBody(4)
    const source = encode('abcdef')
    body.append(source)
    expect(source).toEqual(encode('abcdef'))
    source.fill(120)
    expect(body.finish()).toBe('abcd')
    expect(body.truncated).toBe(true)
    expect(budget.usedBytes).toBe(4)
  })

  test('stop, error, eviction and late callbacks release a reservation only once', () => {
    for (const finishFirst of [false, true]) {
      const budget = new FirefoxNetworkBudget(8)
      const body = budget.createBody(8)
      body.append(encode('12345678'))
      if (finishFirst) expect(body.finish()).toBe('12345678')
      body.release()
      body.release()
      body.append(encode('late data'))
      expect(body.finish()).toBe('')
      expect(body.retainText('late stop')).toBe('')
      expect(budget.usedBytes).toBe(0)
    }
  })

  test('redirect and restart reservations cannot be released by an old body', () => {
    const budget = new FirefoxNetworkBudget(8)
    const old = budget.createBody(8)
    old.append(encode('12345678'))
    old.release()
    const replacement = budget.createBody(8)
    replacement.append(encode('abcdefgh'))
    old.release()
    expect(budget.usedBytes).toBe(8)
    const restarted = new FirefoxNetworkBudget(8)
    const current = restarted.createBody(8)
    current.append(encode('new'))
    replacement.release()
    expect(restarted.usedBytes).toBe(3)
    expect(budget.usedBytes).toBe(0)
  })

  test('truncation keeps a prefix even when another body is later evicted', () => {
    const budget = new FirefoxNetworkBudget(4)
    const retained = budget.createBody(4)
    retained.retainText('1234')
    const waiting = budget.createBody(4)
    waiting.append(encode('lost'))
    expect(waiting.truncated).toBe(true)
    expect(budget.usedBytes).toBe(4)
    retained.release()
    waiting.append(encode('next'))
    expect(waiting.finish()).toBe('')
    expect(budget.usedBytes).toBe(0)
    expect(waiting.finish()).toBe('')
    expect(budget.usedBytes).toBe(0)
  })
})
