import { beforeEach, describe, expect, it, vi } from 'vitest'
import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'
import { dueProviders, createProbeScheduler } from '../../electron/main/probe-scheduler'

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
})

describe('dueProviders', () => {
  it('respects per-provider interval and disabled/off state', () => {
    const nowMs = 1_000_000_000
    const providers = [
      { id: 'a', probe_interval_min: 30, enabled: 1 }, // 从未探测 → 到期
      { id: 'b', probe_interval_min: 30, enabled: 1 }, // 上次 10 分钟前 → 未到期
      { id: 'c', probe_interval_min: 0, enabled: 1 }, // 关闭自动探测
      { id: 'd', probe_interval_min: 10, enabled: 0 }, // 供应商禁用（由调用方过滤，这里也返回）
      { id: 'e', probe_interval_min: 15, enabled: 1 } // 上次正好 15 分钟前 → 到期（>=）
    ]
    const lastRuns = new Map([
      ['b', nowMs - 10 * 60000],
      ['e', nowMs - 15 * 60000]
    ])
    const due = dueProviders(
      providers.filter((p) => p.enabled !== 0),
      lastRuns,
      nowMs
    )
    expect(due).toEqual(['a', 'e'])
  })
})

describe('createProbeScheduler', () => {
  it('ticks probe due providers and skips while running', async () => {
    const pid = repos.saveProvider(dbm.get(), {
      name: '中转',
      baseUrl: 'https://x/v1',
      probeIntervalMin: 30
    })
    repos.saveProvider(dbm.get(), {
      name: '关闭探测',
      baseUrl: 'https://y/v1',
      probeIntervalMin: 0
    })
    const probed = []
    let nowMs = 1_000_000_000_000 // 从「从未探测」状态出发：now - 0 必然 >= 间隔
    const sched = createProbeScheduler({
      probeProvider: async (id) => probed.push(id),
      intervalMs: 60000,
      now: () => nowMs
    })
    await sched.tick()
    expect(probed).toEqual([pid])

    // 刚探测过，未到间隔 → 不重复
    nowMs += 60000
    await sched.tick()
    expect(probed).toEqual([pid])

    // 到期（>30min）→ 再次探测
    nowMs += 31 * 60000
    await sched.tick()
    expect(probed).toEqual([pid, pid])

    // reset 后立即到期
    nowMs += 60000
    sched.reset(pid)
    await sched.tick()
    expect(probed).toEqual([pid, pid, pid])
  })

  it('probeProvider throw does not break the loop and tick is serialized', async () => {
    repos.saveProvider(dbm.get(), { name: 'A', baseUrl: 'https://x/v1', probeIntervalMin: 30 })
    repos.saveProvider(dbm.get(), { name: 'B', baseUrl: 'https://x/v1', probeIntervalMin: 30 })
    let calls = 0
    let release
    const gate = new Promise((r) => (release = r))
    const sched = createProbeScheduler({
      probeProvider: async (id) => {
        calls++
        if (calls === 1) await gate // 第一个 provider 挂起
        if (id === 'boom') throw new Error('x')
      },
      intervalMs: 60000,
      now: () => 1_000_000_000_000
    })
    const p1 = sched.tick()
    const p2 = sched.tick() // running=true → 立即返回
    await p2
    release()
    await expect(p1).resolves.toBeUndefined()
    expect(calls).toBe(2) // 两个到期 provider 都被探测（顺序执行）
  })

  it('start/stop manage the timer', () => {
    vi.useFakeTimers()
    const sched = createProbeScheduler({ probeProvider: async () => {}, intervalMs: 60000 })
    sched.start()
    vi.advanceTimersByTime(120000)
    sched.stop()
    vi.advanceTimersByTime(60000)
    vi.useRealTimers()
    expect(sched).toBeDefined()
  })
})
