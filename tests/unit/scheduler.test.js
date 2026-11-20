import { describe, expect, it } from 'vitest'
import { applyKeyResult, pickKey, usable } from '../../electron/main/gateway/scheduler'

const now = 1_000_000

function key(id, extra = {}) {
  return { id, status: 'ok', cooldownUntil: null, rateCount: 0, lastUsedAt: 0, sort: 0, ...extra }
}

describe('scheduler.usable', () => {
  it('excludes invalid and cooling keys', () => {
    const keys = [
      key('a'),
      key('b', { status: 'invalid' }),
      key('c', { cooldownUntil: now + 100 }),
      key('d', { cooldownUntil: now - 1 })
    ]
    expect(usable(keys, now).map((k) => k.id)).toEqual(['a', 'd'])
  })
})

describe('scheduler.pickKey', () => {
  it('failover picks lowest sort first', () => {
    const keys = [key('b', { sort: 2 }), key('a', { sort: 1 })]
    expect(pickKey(keys, 'failover', [], now).id).toBe('a')
  })
  it('respects exclude list', () => {
    const keys = [key('a', { sort: 1 }), key('b', { sort: 2 })]
    expect(pickKey(keys, 'failover', ['a'], now).id).toBe('b')
  })
  it('round_robin prefers least recently used', () => {
    const keys = [key('a', { sort: 1, lastUsedAt: 500 }), key('b', { sort: 2, lastUsedAt: 100 })]
    expect(pickKey(keys, 'round_robin', [], now).id).toBe('b')
  })
  it('returns null when nothing usable', () => {
    expect(pickKey([key('a', { status: 'invalid' })], 'failover', [], now)).toBeNull()
  })
})

describe('scheduler.applyKeyResult', () => {
  it('ok resets everything', () => {
    const r = applyKeyResult(key('a', { status: 'cooldown', rateCount: 3 }), 'ok', now)
    expect(r).toEqual({ status: 'ok', cooldownUntil: null, lastError: null, rateCount: 0 })
  })
  it('invalid marks key invalid', () => {
    expect(applyKeyResult(key('a'), 'invalid', now).status).toBe('invalid')
  })
  it('rate_limited escalates cooldown', () => {
    const first = applyKeyResult(key('a'), 'rate_limited', now, { baseCooldownMs: 60000 })
    expect(first.status).toBe('cooldown')
    expect(first.cooldownUntil).toBe(now + 60000)
    const second = applyKeyResult(
      { ...key('a'), rateCount: first.rateCount },
      'rate_limited',
      now,
      {
        baseCooldownMs: 60000
      }
    )
    expect(second.cooldownUntil).toBe(now + 120000)
    expect(first.rateCount).toBe(1)
    expect(second.rateCount).toBe(2)
  })
  it('cooldown caps at 30 minutes', () => {
    const r = applyKeyResult(key('a', { rateCount: 100 }), 'rate_limited', now, {
      baseCooldownMs: 60000
    })
    expect(r.cooldownUntil).toBe(now + 30 * 60000)
  })
  it('transient errors keep status', () => {
    const r = applyKeyResult(
      key('a', { status: 'ok', cooldownUntil: null }),
      'network_error',
      now,
      {
        lastError: 'boom'
      }
    )
    expect(r.status).toBe('ok')
    expect(r.lastError).toBe('boom')
  })
})
