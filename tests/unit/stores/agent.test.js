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
      respond: vi.fn(async () => ({})),
      recovery: vi.fn(async () => ({ runId: 'r1', canResume: true })),
      mutateGraph: vi.fn(async () => ({ graphId: 'g1', etag: 'e2', nodes: [] })),
      resumeInterrupted: vi.fn(async () => ({ id: 'r1', status: 'queued' })),
      retryInterrupted: vi.fn(async () => ({ runId: 'r2', retryOfRunId: 'r1' })),
      acceptanceDecide: vi.fn(async () => ({ id: 'r1', acceptance_status: 'accepted' }))
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
    await s.loadRuns()
    await s.select('r1')
    expect(s.activeRunId).toBe('r1')
    expect(s.activeRun).toEqual({ id: 'r1', status: 'done' })
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

  it('started/done/acceptance 事件触发运行列表刷新，其他事件不触发', async () => {
    const s = useAgentStore()
    s.handleEvent({ type: 'started', runId: 'r1' })
    expect(window.api.agent.runs).toHaveBeenCalledTimes(1)
    s.handleEvent({ type: 'done', runId: 'r1' })
    expect(window.api.agent.runs).toHaveBeenCalledTimes(2)
    s.handleEvent({ type: 'acceptance', runId: 'r1' })
    expect(window.api.agent.runs).toHaveBeenCalledTimes(3)
    s.handleEvent({ type: 'tool_call', runId: 'r1' })
    expect(window.api.agent.runs).toHaveBeenCalledTimes(3)
  })

  it('decideAcceptance 提交人工验收并刷新列表', async () => {
    const s = useAgentStore()
    await s.decideAcceptance('r1', 'accepted', '人工确认')
    expect(window.api.agent.acceptanceDecide).toHaveBeenCalledWith({
      runId: 'r1',
      decision: 'accepted',
      reason: '人工确认'
    })
    expect(window.api.agent.runs).toHaveBeenCalledTimes(1)
  })

  it('stopRun 立即清掉该运行的本地确认卡', async () => {
    const s = useAgentStore()
    s.pushConfirm({ requestId: 'q1', runId: 'r1', tool: 'write_file' })
    s.pushConfirm({ requestId: 'q2', runId: 'r2', tool: 'run_command' })
    // stop 的返回值不应影响本地清理（后端可能已无该运行）
    window.api.agent.stop.mockResolvedValueOnce(false)
    s.stopRun('r1')
    expect(s.confirms.map((c) => c.requestId)).toEqual(['q2'])
  })

  it('continueInterrupted 从安全检查点继续并刷新当前任务', async () => {
    const s = useAgentStore()
    await s.continueInterrupted('r1', '已核对')
    expect(window.api.agent.resumeInterrupted).toHaveBeenCalledWith({
      runId: 'r1',
      reason: '已核对'
    })
    expect(s.activeRunId).toBe('r1')
  })

  it('retryInterrupted 创建关联任务并切换到新任务', async () => {
    const s = useAgentStore()
    const retry = await s.retryInterrupted('r1', '已核对台账')
    expect(window.api.agent.retryInterrupted).toHaveBeenCalledWith({
      runId: 'r1',
      reason: '已核对台账'
    })
    expect(retry.retryOfRunId).toBe('r1')
    expect(s.activeRunId).toBe('r2')
  })

  it('mutateGraph 提交重规划并更新本地图状态', async () => {
    const s = useAgentStore()
    const input = { graphId: 'g1', etag: 'e1', ops: [] }
    const result = await s.mutateGraph(input)
    expect(window.api.agent.mutateGraph).toHaveBeenCalledWith(input)
    expect(result.etag).toBe('e2')
    expect(s.graph.etag).toBe('e2')
  })

  it('done 事件清掉该运行遗留的确认卡（含停止/出错路径）', () => {
    const s = useAgentStore()
    s.pushConfirm({ requestId: 'q1', runId: 'r1' })
    s.pushConfirm({ requestId: 'q2', runId: 'r2' })
    s.handleEvent({ type: 'done', runId: 'r1', status: 'stopped' })
    expect(s.confirms.map((c) => c.requestId)).toEqual(['q2'])
  })

  it('clearConfirms 支持按 requestIds 批量清理', () => {
    const s = useAgentStore()
    s.pushConfirm({ requestId: 'q1', runId: 'r1' })
    s.pushConfirm({ requestId: 'q2', runId: 'r1' })
    s.pushConfirm({ requestId: 'q3', runId: 'r2' })
    s.clearConfirms({ requestIds: ['q1', 'q2'] })
    expect(s.confirms.map((c) => c.requestId)).toEqual(['q3'])
  })
})
