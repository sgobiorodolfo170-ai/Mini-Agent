// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useSessionsStore } from '../../../src/stores/sessions'

function stubApi() {
  const api = {
    sessions: {
      list: vi.fn(async () => [
        { conversationId: 'c1', status: 'running', parentId: 'p1' },
        { conversationId: 'c2', status: 'done', parentId: 'p1' },
        { conversationId: 'c3', status: 'error', parentId: 'p2' }
      ])
    },
    events: {
      since: vi.fn(async ({ cursor }) => ({
        seq: 12,
        events: [],
        truncated: cursor === 0 ? false : true
      }))
    }
  }
  window.api = api
  return api
}

beforeEach(() => {
  setActivePinia(createPinia())
  stubApi()
})

describe('sessions store', () => {
  it('load 拉取子会话列表', async () => {
    const s = useSessionsStore()
    await s.load()
    expect(s.list).toHaveLength(3)
    expect(s.error).toBe('')
  })

  it('load 失败时记录错误而不抛出', async () => {
    const s = useSessionsStore()
    window.api.sessions.list.mockRejectedValueOnce(new Error('boom'))
    await s.load()
    expect(s.error).toBe('boom')
  })

  it('childrenOf 按父会话过滤', () => {
    const s = useSessionsStore()
    s.list = [
      { conversationId: 'c1', parentId: 'p1', status: 'running' },
      { conversationId: 'c2', parentId: 'p2', status: 'done' }
    ]
    expect(s.childrenOf('p1').map((x) => x.conversationId)).toEqual(['c1'])
  })

  it('running / finished 按状态分组', () => {
    const s = useSessionsStore()
    s.list = [
      { conversationId: 'a', status: 'running' },
      { conversationId: 'b', status: 'streaming' },
      { conversationId: 'c', status: 'done' },
      { conversationId: 'd', status: 'error' }
    ]
    expect(s.running.map((x) => x.conversationId)).toEqual(['a', 'b'])
    expect(s.finished.map((x) => x.conversationId)).toEqual(['c', 'd'])
  })

  it('drain 推进游标并记录轮询时间', async () => {
    const s = useSessionsStore()
    const r = await s.drain()
    expect(r.seq).toBe(12)
    expect(s.cursor).toBe(12)
    expect(s.lastPolledAt).toBeGreaterThan(0)
  })

  it('startPolling 幂等，stopPolling 可停止', async () => {
    vi.useFakeTimers()
    const s = useSessionsStore()
    s.startPolling(1000)
    s.startPolling(1000) // 重复调用不应叠加定时器
    expect(s.polling).toBe(true)
    await vi.advanceTimersByTimeAsync(2500)
    expect(window.api.sessions.list).toHaveBeenCalledTimes(2)
    s.stopPolling()
    expect(s.polling).toBe(false)
    await vi.advanceTimersByTimeAsync(3000)
    expect(window.api.sessions.list).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('轮询期间单次失败不终止定时器', async () => {
    vi.useFakeTimers()
    const s = useSessionsStore()
    window.api.sessions.list.mockRejectedValueOnce(new Error('once'))
    s.startPolling(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(window.api.sessions.list).toHaveBeenCalledTimes(2)
    s.stopPolling()
    vi.useRealTimers()
  })
})
