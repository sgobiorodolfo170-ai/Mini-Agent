import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEventHub, patternMatches } from '../../electron/main/events/hub'

describe('event hub 订阅与匹配', () => {
  it('patternMatches 支持全通配与前缀通配', () => {
    expect(patternMatches('*', 'anything')).toBe(true)
    expect(patternMatches('run:*', 'run.start')).toBe(true)
    expect(patternMatches('run:*', 'chat:event')).toBe(false)
    expect(patternMatches('run.start', 'run.start')).toBe(true)
    expect(patternMatches('', 'x')).toBe(false)
  })

  it('emit 只通知匹配的监听器并返回带 seq 的记录', () => {
    const hub = createEventHub({ now: () => 123 })
    const runEvents = []
    const all = []
    hub.on('run:*', (r) => runEvents.push(r.name))
    hub.on('*', (r) => all.push(r.name))
    const rec = hub.emit('run.start', { runId: 'r1' })
    hub.emit('chat:event', { msgId: 'm1' })
    expect(rec).toMatchObject({ seq: 1, at: 123, name: 'run.start' })
    expect(rec.payload).toEqual({ runId: 'r1' })
    expect(runEvents).toEqual(['run.start'])
    expect(all).toEqual(['run.start', 'chat:event'])
    expect(hub.seq).toBe(2)
  })

  it('once 只触发一次，off 可移除订阅', () => {
    const hub = createEventHub()
    const hits = []
    hub.once('x', () => hits.push('once'))
    const fn = () => hits.push('on')
    hub.on('x', fn)
    hub.emit('x', {})
    hub.emit('x', {})
    expect(hits.filter((h) => h === 'once')).toHaveLength(1)
    expect(hits.filter((h) => h === 'on')).toHaveLength(2)
    hub.off('x', fn)
    hub.emit('x', {})
    expect(hits.filter((h) => h === 'on')).toHaveLength(2)
  })

  it('监听器抛错被隔离，不影响其他监听器与后续 emit', () => {
    const hub = createEventHub()
    const ok = []
    hub.on('e', () => {
      throw new Error('boom')
    })
    hub.on('e', () => ok.push(1))
    expect(() => hub.emit('e', {})).not.toThrow()
    expect(ok).toEqual([1])
    expect(hub.emit('e', {}).seq).toBe(2)
  })
})

describe('event hub 历史与游标', () => {
  it('since 返回游标之后的事件', () => {
    const hub = createEventHub()
    hub.emit('a', { i: 1 })
    hub.emit('a', { i: 2 })
    const cursor = hub.seq
    hub.emit('a', { i: 3 })
    const page = hub.since(cursor)
    expect(page.events.map((e) => e.payload.i)).toEqual([3])
    expect(page.seq).toBe(3)
    expect(page.truncated).toBe(false)
  })

  it('历史溢出时裁剪最旧记录并标记 dropped', () => {
    const hub = createEventHub({ historyLimit: 3 })
    for (let i = 1; i <= 5; i++) hub.emit('a', { i })
    expect(hub.size).toBe(3)
    expect(hub.recent().map((e) => e.payload.i)).toEqual([3, 4, 5])
    // 游标早于现存最旧记录 → 已截断，调用方应重载而非增量
    const page = hub.since(1)
    expect(page.truncated).toBe(true)
    expect(page.firstSeq).toBe(3)
  })

  it('since 支持 limit 与 hasMore', () => {
    const hub = createEventHub()
    for (let i = 1; i <= 5; i++) hub.emit('a', { i })
    const page = hub.since(0, { limit: 2 })
    expect(page.events).toHaveLength(2)
    expect(page.hasMore).toBe(true)
  })

  it('recent 可按事件名过滤', () => {
    const hub = createEventHub()
    hub.emit('run.start', { i: 1 })
    hub.emit('chat:event', { i: 2 })
    hub.emit('run.end', { i: 3 })
    expect(hub.recent({ name: 'run:*' }).map((e) => e.payload.i)).toEqual([1, 3])
    expect(hub.recent({ limit: 1 }).map((e) => e.payload.i)).toEqual([3])
  })

  it('clear 清空历史但保留 seq 单调性', () => {
    const hub = createEventHub()
    hub.emit('a', {})
    hub.emit('a', {})
    hub.clear()
    expect(hub.size).toBe(0)
    expect(hub.seq).toBe(2)
    expect(hub.emit('a', {}).seq).toBe(3)
  })
})

describe('event hub 单例', () => {
  let mod
  beforeEach(async () => {
    vi.resetModules()
    mod = await import('../../electron/main/events/hub')
  })

  it('getHub 复用同一实例，resetHub 换新实例', () => {
    const a = mod.getHub()
    const b = mod.getHub()
    expect(a).toBe(b)
    const c = mod.resetHub({ historyLimit: 1 })
    expect(c).not.toBe(a)
    expect(mod.getHub()).toBe(c)
  })
})
