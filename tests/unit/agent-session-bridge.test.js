import { describe, expect, it, vi } from 'vitest'

import { createSessionBridge } from '../../electron/main/agent/session-bridge'

function build({ target, state = {} } = {}) {
  const db = {}
  const repos = {
    getConversation: vi.fn(() => target || null)
  }
  const sessionsApi = {
    createSession: vi.fn(async (opts) => ({ id: 'child-1', ...opts })),
    sendToSession: vi.fn(async (opts) => ({
      mode: opts.permission === 'default' ? 'chat' : 'agent',
      ...opts
    })),
    getSessionStatus: vi.fn((o) => ({ status: 'done', ...o })),
    waitForSession: vi.fn(async (o) => ({ status: 'done', timedOut: false, ...o })),
    getSessionResult: vi.fn((o) => ({ content: '结果', ...o })),
    listSessions: vi.fn((o) => [o])
  }
  const bridge = createSessionBridge({
    db,
    repos,
    sessionsApi,
    conversationId: 'parent-conv',
    runId: 'parent-run',
    state: {
      permission: 'autonomous',
      cluster: false,
      mandate: { schemaVersion: 1, allowedTools: ['read_file'] },
      ...state
    }
  })
  return { bridge, repos, sessionsApi }
}

describe('session bridge 参数透传', () => {
  it('agent 模式把任务关系、授权、验收与幂等键完整下传', async () => {
    const { bridge, sessionsApi } = build({
      target: { id: 'child-1', parentId: 'parent-conv' }
    })
    const acceptancePolicy = { schemaVersion: 1, criteria: '验收', judge: 'parent' }

    await bridge.sendToSession({
      conversationId: 'child-1',
      content: '去做事',
      mode: 'agent',
      controlMode: 'transferred',
      acceptancePolicy,
      idempotencyKey: 'dispatch-1'
    })

    expect(sessionsApi.sendToSession).toHaveBeenCalledWith({
      conversationId: 'child-1',
      content: '去做事',
      permission: 'autonomous',
      cluster: false,
      runId: 'parent-run',
      controlMode: 'transferred',
      mandate: { schemaVersion: 1, allowedTools: ['read_file'] },
      acceptancePolicy,
      idempotencyKey: 'dispatch-1'
    })
  })

  it('chat 模式使用 default 权限，controlMode 仍保留默认值', async () => {
    const { bridge, sessionsApi } = build({
      target: { id: 'parent-conv', parentId: null }
    })

    await bridge.sendToSession({ conversationId: 'parent-conv', content: '你好' })

    expect(sessionsApi.sendToSession).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'parent-conv',
        permission: 'default',
        controlMode: 'delegated',
        acceptancePolicy: null,
        idempotencyKey: null
      })
    )
  })

  it('拒绝向既非本会话也非直接子会话的目标发送', () => {
    const { bridge, sessionsApi } = build({
      target: { id: 'other', parentId: 'another-conv' }
    })

    expect(() => bridge.sendToSession({ conversationId: 'other', content: '越权' })).toThrow(
      '只能向本会话或其派生的子会话发送提示词'
    )
    expect(sessionsApi.sendToSession).not.toHaveBeenCalled()
  })

  it('目标会话不存在时给出明确错误', () => {
    const { bridge } = build({ target: null })
    expect(() => bridge.sendToSession({ conversationId: 'missing', content: 'x' })).toThrow(
      '目标会话不存在'
    )
  })

  it('createSession 自动补父会话与创建者运行', async () => {
    const { bridge, sessionsApi } = build()
    await bridge.createSession({ title: '子任务' })
    expect(sessionsApi.createSession).toHaveBeenCalledWith({
      title: '子任务',
      parentConversationId: 'parent-conv',
      runId: 'parent-run'
    })
  })

  it('只读接口保持透传，listSessions 强制当前运行范围', async () => {
    const { bridge, sessionsApi } = build()
    const status = bridge.getSessionStatus({ conversationId: 'c1' })
    expect(status.status).toBe('done')

    await bridge.waitForSession({ conversationId: 'c1' })
    expect(sessionsApi.waitForSession).toHaveBeenCalledWith({ conversationId: 'c1' })

    expect(bridge.getSessionResult({ conversationId: 'c1' }).content).toBe('结果')
    expect(bridge.listSessions({ limit: 5 })).toEqual([{ limit: 5, runId: 'parent-run' }])
  })
})
