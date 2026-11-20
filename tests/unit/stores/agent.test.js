// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useAgentStore } from '../../../src/stores/agent'

function stubApi() {
  const api = {
    agent: {
      runs: vi.fn(async () => [{ id: 'r1', status: 'done' }]),
      calls: vi.fn(async () => [{ id: 'call1', name: 'write_file' }]),
      stop: vi.fn(async () => ({})),
      respond: vi.fn(async () => ({}))
    }
  }
  window.api = api
  return api
}

beforeEach(() => {
  setActivePinia(createPinia())
  stubApi()
})

describe('agent store', () => {
  it('loadRuns 拉取运行列表', async () => {
    const s = useAgentStore()
    await s.loadRuns()
    expect(s.runs).toEqual([{ id: 'r1', status: 'done' }])
  })

  it('select 设置 activeRunId 并加载调用明细', async () => {
    const s = useAgentStore()
    await s.select('r1')
    expect(s.activeRunId).toBe('r1')
    expect(s.calls).toEqual([{ id: 'call1', name: 'write_file' }])
  })

  it('stopRun 委托到 agent.stop', async () => {
    const s = useAgentStore()
    await s.stopRun('r1')
    expect(window.api.agent.stop).toHaveBeenCalledWith('r1')
  })

  it('pushConfirm 追加确认请求', () => {
    const s = useAgentStore()
    s.pushConfirm({ requestId: 'q1', tool: 'write_file' })
    expect(s.confirms).toEqual([{ requestId: 'q1', tool: 'write_file' }])
  })

  it('respond 移除对应确认请求并提交决定', async () => {
    const s = useAgentStore()
    s.pushConfirm({ requestId: 'q1', tool: 'write_file' })
    s.pushConfirm({ requestId: 'q2', tool: 'run_command' })
    await s.respond('q1', true, 'session')
    expect(window.api.agent.respond).toHaveBeenCalledWith({
      requestId: 'q1',
      allow: true,
      remember: 'session'
    })
    expect(s.confirms.map((c) => c.requestId)).toEqual(['q2'])
  })

  it('started/done 事件触发运行列表刷新，其他事件不触发', async () => {
    const s = useAgentStore()
    s.handleEvent({ type: 'started', runId: 'r1' })
    expect(window.api.agent.runs).toHaveBeenCalledTimes(1)
    s.handleEvent({ type: 'done', runId: 'r1' })
    expect(window.api.agent.runs).toHaveBeenCalledTimes(2)
    s.handleEvent({ type: 'tool_call', runId: 'r1' })
    expect(window.api.agent.runs).toHaveBeenCalledTimes(2)
  })
})
