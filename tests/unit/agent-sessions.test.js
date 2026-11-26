import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'
import storage from '../../electron/store/run-storage'
import { getHub, resetHub } from '../../electron/main/events/hub'
import * as sessions from '../../electron/main/agent/sessions'
import * as agent from '../../electron/main/agent'

const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
require('electron')

// 会话管理通过 _setDeps 暴露依赖接缝，测试直接注入替身，
// 不依赖打包器对 CJS require 的 mock 行为。
const gatewaySend = vi.fn(async () => ({ userMsgId: 'u1', assistantMsgId: 'a1' }))
const agentStart = vi.fn(async () => ({ runId: 'run-1', userMsgId: 'u2', assistantMsgId: 'a2' }))

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
  resetHub()
  gatewaySend.mockClear()
  agentStart.mockClear()
  sessions._setDeps({
    gateway: { sendChat: gatewaySend },
    agentRunner: { startAgentRun: agentStart },
    repos,
    dbm
  })
})

function seedParent(extra = {}) {
  const pid = repos.saveProvider(dbm.get(), {
    name: 'P',
    baseUrl: 'https://x/v1',
    models: [{ id: 'm1' }]
  })
  return repos.createConversation(dbm.get(), {
    title: '主会话',
    providerId: pid,
    model: 'm1',
    ...extra
  })
}

describe('session 创建', () => {
  it('创建子会话并记录来源、父会话与创建者运行', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({
      parentConversationId: parent.id,
      title: '子任务 A',
      goal: '搜集资料',
      runId: 'run-1'
    })
    expect(conv.origin).toBe('agent')
    expect(conv.parentId).toBe(parent.id)
    expect(conv.createdByRun).toBe('run-1')
    // 继承父会话的供应商/模型，避免子会话需要重复配置
    expect(conv.providerId).toBe(parent.providerId)
    expect(conv.model).toBe('m1')
  })

  it('title 缺省时用 goal 兜底并截断到 80 字符', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({
      parentConversationId: parent.id,
      goal: 'x'.repeat(200)
    })
    expect(conv.title.length).toBe(80)
  })

  it('父会话不存在时报错', async () => {
    await expect(
      sessions.createSession({ parentConversationId: 'nope', title: 't' })
    ).rejects.toThrow('父会话不存在')
  })

  it('嵌套深度超过上限时拒绝', async () => {
    const parent = seedParent()
    const l1 = await sessions.createSession({ parentConversationId: parent.id, title: 'L1' })
    const l2 = await sessions.createSession({ parentConversationId: l1.id, title: 'L2' })
    expect(sessions.depthOf(dbm.get(), l2.id)).toBe(2)
    await expect(
      sessions.createSession({ parentConversationId: l2.id, title: 'L3' })
    ).rejects.toThrow('嵌套已达上限')
  })

  it('创建时向事件中枢发 session.created', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    const ev = getHub().recent({ name: 'session.created' }).pop()
    expect(ev.payload).toMatchObject({ conversationId: conv.id, parentId: parent.id })
  })
})

describe('session 发送', () => {
  it('默认按普通对话发送（走 gateway.sendChat）', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    const r = await sessions.sendToSession({ conversationId: conv.id, content: '你好' })
    expect(r.mode).toBe('chat')
    expect(gatewaySend).toHaveBeenCalledWith({ conversationId: conv.id, content: '你好' })
    expect(agentStart).not.toHaveBeenCalled()
  })

  it('显式授权任务模式时走 Agent 运行器并透传父运行', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    const r = await sessions.sendToSession({
      conversationId: conv.id,
      content: '去做事',
      permission: 'full',
      runId: 'parent-run'
    })
    expect(r.mode).toBe('agent')
    expect(agentStart).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conv.id,
        goal: '去做事',
        permission: 'full',
        parentRunId: 'parent-run'
      })
    )
  })

  it('readonly 权限走 Agent 运行器并保持只读透传（子会话不提权）', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    const r = await sessions.sendToSession({
      conversationId: conv.id,
      content: '只读调查',
      permission: 'readonly'
    })
    expect(r.mode).toBe('agent')
    expect(agentStart).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conv.id,
        goal: '只读调查',
        permission: 'readonly'
      })
    )
  })

  it('空提示词被拒绝', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    await expect(
      sessions.sendToSession({ conversationId: conv.id, content: '   ' })
    ).rejects.toThrow('提示词不能为空')
  })

  it('会话已有在途流时拒绝并发发送', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    repos.insertMessage(dbm.get(), {
      conversationId: conv.id,
      role: 'assistant',
      content: '',
      status: 'streaming'
    })
    await expect(
      sessions.sendToSession({ conversationId: conv.id, content: '再来一条' })
    ).rejects.toThrow('仍在生成中')
    expect(gatewaySend).not.toHaveBeenCalled()
  })

  it('会话不存在时报错', async () => {
    await expect(sessions.sendToSession({ conversationId: 'nope', content: 'x' })).rejects.toThrow(
      '会话不存在'
    )
  })
})

describe('session 状态与结果', () => {
  function seedRun(convId, status = 'done', steps = 2) {
    const runId = repos.createRun(dbm.get(), {
      conversationId: convId,
      goal: 'g',
      maxSteps: 10
    })
    // running 是 createRun 默认值，重复写 running 会被状态机拒绝并污染 stderr
    if (status !== 'running') {
      repos.updateRun(dbm.get(), runId, { status, stepsUsed: steps, endedAt: Date.now() })
    }
    return runId
  }

  it('status 汇总最近一次运行与最后回复摘要', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    const runId = seedRun(conv.id)
    repos.insertMessage(dbm.get(), { conversationId: conv.id, role: 'user', content: '问题' })
    repos.insertMessage(dbm.get(), {
      conversationId: conv.id,
      role: 'assistant',
      content: '答案内容',
      status: 'done'
    })
    const s = sessions.getSessionStatus({ conversationId: conv.id })
    expect(s).toMatchObject({
      conversationId: conv.id,
      runId,
      status: 'done',
      stepsUsed: 2,
      origin: 'agent',
      parentId: parent.id
    })
    expect(s.preview).toBe('答案内容')
    expect(s.messageCount).toBe(2)
  })

  it('无运行记录时回落到最后一条 assistant 状态', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    repos.insertMessage(dbm.get(), {
      conversationId: conv.id,
      role: 'assistant',
      content: '聊完了',
      status: 'done'
    })
    const s = sessions.getSessionStatus({ conversationId: conv.id })
    expect(s.runId).toBeNull()
    expect(s.status).toBe('done')
  })

  it('result 返回正文、用户消息与工具调用摘要', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    const runId = seedRun(conv.id)
    repos.insertMessage(dbm.get(), { conversationId: conv.id, role: 'user', content: '用户问题' })
    repos.insertMessage(dbm.get(), {
      conversationId: conv.id,
      role: 'assistant',
      content: '最终回答',
      status: 'done'
    })
    repos.logToolCall(dbm.get(), {
      runId,
      step: 1,
      tool: 'read_file',
      args: {},
      riskLevel: 'readonly',
      confirmedBy: 'auto',
      result: 'ok',
      durationMs: 5
    })
    const r = sessions.getSessionResult({ conversationId: conv.id })
    expect(r.status).toBe('done')
    expect(r.content).toBe('最终回答')
    expect(r.userMessage).toBe('用户问题')
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]).toMatchObject({ tool: 'read_file', ok: true })
  })

  it('result 超长正文被截断并标记', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    repos.insertMessage(dbm.get(), {
      conversationId: conv.id,
      role: 'assistant',
      content: 'y'.repeat(500),
      status: 'done'
    })
    const r = sessions.getSessionResult({ conversationId: conv.id, maxChars: 100 })
    expect(r.content.length).toBe(100)
    expect(r.truncated).toBe(true)
  })

  it('list 只返回 agent 来源会话，可按 parentId / runId 过滤', async () => {
    const parent = seedParent()
    const a = await sessions.createSession({
      parentConversationId: parent.id,
      title: 'A',
      runId: 'run-1'
    })
    const b = await sessions.createSession({
      parentConversationId: parent.id,
      title: 'B',
      runId: 'run-2'
    })
    expect(sessions.listSessions({})).toHaveLength(2)
    const children = sessions.listSessions({ parentId: parent.id }).map((s) => s.conversationId)
    expect(children.sort()).toEqual([a.id, b.id].sort())
    expect(sessions.listSessions({ runId: 'run-1' }).map((s) => s.conversationId)).toEqual([a.id])
    // 人工会话不出现在 agent 会话列表里
    expect(sessions.listSessions({}).some((s) => s.conversationId === parent.id)).toBe(false)
  })

  it('wait 在终态时立即返回', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    seedRun(conv.id, 'done')
    const r = await sessions.waitForSession({ conversationId: conv.id, timeoutMs: 1000 })
    expect(r.timedOut).toBe(false)
    expect(r.status).toBe('done')
  })

  it('wait 超时返回当前状态而不是抛错', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    seedRun(conv.id, 'running')
    const r = await sessions.waitForSession({
      conversationId: conv.id,
      timeoutMs: 1000
    })
    expect(r.timedOut).toBe(true)
    expect(r.status).toBe('running')
    expect(r.waited).toBeGreaterThanOrEqual(1000)
  })

  it('wait 由状态事件唤醒，不依赖轮询', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    const runId = seedRun(conv.id, 'running')
    const pending = sessions.waitForSession({ conversationId: conv.id, timeoutMs: 5000 })
    getHub().emit('run.end', { runId: 'other', conversationId: 'other', status: 'done' })
    repos.updateRun(dbm.get(), runId, { status: 'done', stepsUsed: 1 })
    getHub().emit('run.end', { runId, conversationId: conv.id, status: 'done' })
    const r = await pending
    expect(r.timedOut).toBe(false)
    expect(r.status).toBe('done')
  })

  it('wait 支持普通对话完成事件', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    const message = repos.insertMessage(dbm.get(), {
      conversationId: conv.id,
      role: 'assistant',
      content: '',
      status: 'pending'
    })
    const pending = sessions.waitForSession({ conversationId: conv.id, timeoutMs: 5000 })
    repos.updateMessage(dbm.get(), message.id, { content: '完成', status: 'done' })
    getHub().emit('chat:event', {
      type: 'done',
      conversationId: conv.id,
      msgId: message.id
    })
    expect(await pending).toMatchObject({ status: 'done', timedOut: false })
  })

  it('wait 中止时拒绝并释放事件订阅', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    seedRun(conv.id, 'running')
    expect(sessions.getSessionStatus({ conversationId: conv.id }).status).toBe('running')
    const controller = new AbortController()
    const listeners = getHub().listenerCount()
    const pending = sessions.waitForSession({
      conversationId: conv.id,
      timeoutMs: 5000,
      signal: controller.signal
    })
    expect(getHub().listenerCount()).toBe(listeners + 1)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(getHub().listenerCount()).toBe(listeners)
  })

  it('wait 不把 waiting_child 当成终态', async () => {
    const parent = seedParent()
    const conv = await sessions.createSession({ parentConversationId: parent.id, title: 'T' })
    const runId = seedRun(conv.id, 'running')
    expect(repos.updateRunStatus(dbm.get(), runId, { status: 'waiting_child' }).ok).toBe(true)
    const r = await sessions.waitForSession({
      conversationId: conv.id,
      timeoutMs: 1000
    })
    expect(r.timedOut).toBe(true)
    expect(r.status).toBe('waiting_child')
  })
})

describe('Agent 首流挂起', () => {
  let originalElectron
  let conversationId

  beforeEach(() => {
    originalElectron = require.cache[electronPath].exports
    require.cache[electronPath].exports = { app: { getPath: () => tmpdir() } }
    const db = dbm.get()
    const providerId = repos.saveProvider(db, {
      name: 'Mock',
      baseUrl: 'https://mock/v1',
      models: [{ id: 'm1' }]
    })
    repos.addKey(db, {
      providerId,
      label: 'key',
      secretEnc: 'plain:' + Buffer.from('key').toString('base64')
    })
    conversationId = repos.createConversation(db, {
      title: '挂起会话',
      providerId,
      model: 'm1'
    }).id
    // Avoid starting the independent title request in these stream tests.
    repos.insertMessage(db, { conversationId, role: 'user', content: '历史消息' })
  })

  afterEach(async () => {
    await agent.stopAllRuns()
    dbm.close()
    require.cache[electronPath].exports = originalElectron
    vi.restoreAllMocks()
  })

  function hangFirstStream() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        yield* []
        await new Promise(() => {})
      })()
    }))
  }

  it('exposes heartbeat then reaches error on stream timeout', async () => {
    hangFirstStream()
    repos.setSetting(dbm.get(), 'agentStreamTimeouts', {
      connectTimeoutMs: 0,
      firstByteTimeoutMs: 40,
      idleTimeoutMs: 0,
      totalTimeoutMs: 0
    })
    const heartbeat = new Promise((resolve) => {
      const off = getHub().on('run.heartbeat', (event) => {
        if (event.payload.phase !== 'model_call') return
        off()
        resolve(event.payload)
      })
    })
    const { runId, assistantMsgId } = await agent.startAgentRun({
      conversationId,
      goal: '首流挂起',
      permission: 'full'
    })
    await expect(heartbeat).resolves.toMatchObject({
      runId,
      phase: 'model_call',
      step: 1,
      stepsUsed: 1
    })
    expect(storage.loadCheckpoint(dbm.get(), runId)).toMatchObject({
      phase: 'before_model',
      step: 1,
      stepsUsed: 1
    })
    await expect
      .poll(() => agent.getRunStatus(runId), { timeout: 2000 })
      .toMatchObject({ status: 'error', finishedReason: 'model_timeout', stepsUsed: 1 })
    expect(repos.getMessage(dbm.get(), assistantMsgId).status).toBe('error')
    expect(storage.loadCheckpoint(dbm.get(), runId)).toBeNull()
  })

  it('external cancel of the same hung stream reaches stopped, not error', async () => {
    hangFirstStream()
    repos.setSetting(dbm.get(), 'agentStreamTimeouts', {
      connectTimeoutMs: 0,
      firstByteTimeoutMs: 5000,
      idleTimeoutMs: 0,
      totalTimeoutMs: 0
    })
    const { runId, assistantMsgId } = await agent.startAgentRun({
      conversationId,
      goal: '取消挂起流',
      permission: 'full'
    })
    await expect
      .poll(() => agent.getRunStatus(runId), { timeout: 2000 })
      .toMatchObject({ status: 'running', phase: 'model_call', step: 1, stepsUsed: 1 })
    expect(agent.stopRun(runId, 'user')).toBe(true)
    await expect
      .poll(() => agent.getRunStatus(runId), { timeout: 2000 })
      .toMatchObject({ status: 'stopped', finishedReason: 'user', stepsUsed: 1 })
    expect(repos.getMessage(dbm.get(), assistantMsgId).status).toBe('stopped')
  })
})
