import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as agent from '../../electron/main/agent'
import storage from '../../electron/store/run-storage'
import graph from '../../electron/main/agent/graph'

const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
require('electron')
const dbm = require('../../electron/store/db')
const repos = require('../../electron/store/repos')

let db
let originalElectron
let providerId
let conversationId

const SAFE_MESSAGES = [
  { role: 'system', content: 'system' },
  { role: 'user', content: '目标' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{}' }
      }
    ]
  },
  { role: 'tool', tool_call_id: 'call-1', content: '工具结果' }
]

function response(delta) {
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      yield Buffer.from(
        'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n'
      )
    })()
  }
}

function seedRun({ checkpoint = null, status = 'interrupted', workspace = null } = {}) {
  const runId = repos.createRun(db, {
    conversationId,
    goal: '恢复任务',
    maxSteps: 15,
    status: 'running'
  })
  const assistant = repos.insertMessage(db, {
    conversationId,
    role: 'assistant',
    content: '',
    status: 'pending',
    meta: { agentRunId: runId }
  })
  db.prepare(
    `UPDATE agent_runs SET run_spec_json=?, assistant_message_id=?, workspace_json=? WHERE id=?`
  ).run(
    JSON.stringify({
      version: 1,
      providerId,
      model: 'm1',
      permission: 'full',
      cluster: false,
      projectId: null,
      first: false,
      endpoint: 'https://mock/v1',
      context: [],
      systemPrompt: ''
    }),
    assistant.id,
    workspace ? JSON.stringify(workspace) : null,
    runId
  )
  repos.updateRunStatus(db, runId, { status })
  if (checkpoint) storage.saveCheckpoint(db, runId, checkpoint)
  return { runId, assistantId: assistant.id }
}

beforeEach(() => {
  originalElectron = require.cache[electronPath].exports
  require.cache[electronPath].exports = { app: { getPath: () => tmpdir() } }
  db = dbm.open(':memory:')
  providerId = repos.saveProvider(db, {
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
    title: '恢复会话',
    providerId,
    model: 'm1'
  }).id
})

afterEach(async () => {
  await agent.stopAllRuns()
  dbm.close()
  require.cache[electronPath].exports = originalElectron
  vi.restoreAllMocks()
})

describe('检查点与恢复', () => {
  it('保存、读取与清理检查点', () => {
    const runId = repos.createRun(db, { conversationId, goal: 'g' })
    expect(
      storage.saveCheckpoint(db, runId, {
        phase: 'tool_done',
        step: 2,
        messages: SAFE_MESSAGES,
        pendingToolCalls: [],
        stepsUsed: 2
      })
    ).toBe(true)
    const cp = storage.loadCheckpoint(db, runId)
    expect(cp).toMatchObject({ phase: 'tool_done', step: 2, stepsUsed: 2 })
    expect(cp.messages).toHaveLength(4)
    storage.clearCheckpoint(db, runId)
    expect(storage.loadCheckpoint(db, runId)).toBeNull()
  })

  it('只恢复安全边界且没有未完成工具的运行', () => {
    const safe = seedRun({
      checkpoint: {
        phase: 'tool_done',
        step: 1,
        messages: SAFE_MESSAGES,
        pendingToolCalls: [],
        stepsUsed: 1
      }
    })
    const pending = seedRun({
      checkpoint: {
        phase: 'model_done',
        step: 1,
        messages: SAFE_MESSAGES.slice(0, 3),
        pendingToolCalls: [{ id: 'call-1' }],
        stepsUsed: 1
      }
    })
    const unsafeTool = seedRun({
      checkpoint: {
        phase: 'tool_done',
        step: 1,
        messages: SAFE_MESSAGES,
        pendingToolCalls: [],
        stepsUsed: 1
      }
    })
    repos.startToolCall(db, {
      runId: unsafeTool.runId,
      step: 1,
      tool: 'write_file',
      args: {},
      riskLevel: 'side_effect',
      confirmedBy: 'auto',
      callId: 'call-unknown'
    })
    const missingWorkspace = seedRun({
      checkpoint: {
        phase: 'tool_done',
        step: 1,
        messages: SAFE_MESSAGES,
        pendingToolCalls: [],
        stepsUsed: 1
      },
      workspace: { mode: 'worktree', path: 'Z:\\definitely-missing\\run' }
    })

    const resumed = storage.autoResumeRuns(db)
    expect(resumed).toEqual([safe.runId])
    expect(repos.getRun(db, safe.runId)).toMatchObject({ status: 'queued', resumeCount: 1 })
    expect(repos.getRun(db, pending.runId).status).toBe('interrupted')
    expect(repos.getRun(db, unsafeTool.runId).status).toBe('interrupted')
    expect(repos.getRun(db, missingWorkspace.runId).status).toBe('interrupted')
  })

  it('从 tool_done 检查点继续执行且不重放工具', async () => {
    const { runId } = seedRun({
      checkpoint: {
        phase: 'tool_done',
        step: 1,
        messages: SAFE_MESSAGES,
        pendingToolCalls: [],
        stepsUsed: 1
      }
    })
    expect(storage.autoResumeRuns(db)).toEqual([runId])

    const bodies = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
      bodies.push(JSON.parse(opts.body))
      return response({ content: '恢复完成' })
    })
    agent.resumeQueuedRuns()
    await expect
      .poll(() => agent.getRunStatus(runId), { timeout: 10000 })
      .toMatchObject({ status: 'done', resumeCount: 1 })
    expect(agent.getRunResult(runId).content).toBe('恢复完成')
    expect(bodies).toHaveLength(1)
    expect(bodies[0].messages.at(-1).role).toBe('tool')
    expect(storage.loadCheckpoint(db, runId)).toBeNull()
  })

  it('从 model_done 的完整台账补齐工具消息后继续，不重放工具', async () => {
    const call = {
      id: 'call-ledger',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"a.txt"}' }
    }
    const { runId } = seedRun({
      checkpoint: {
        phase: 'model_done',
        step: 2,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: '目标' },
          { role: 'assistant', content: '', tool_calls: [call] }
        ],
        pendingToolCalls: [call],
        stepsUsed: 2
      }
    })
    const ledgerId = repos.startToolCall(db, {
      runId,
      step: 1,
      tool: 'read_file',
      args: { path: 'a.txt' },
      riskLevel: 'readonly',
      confirmedBy: 'auto',
      callId: call.id
    })
    repos.finishToolCall(db, ledgerId, { result: '台账结果', durationMs: 1 })

    expect(agent.getRunRecovery(runId)).toMatchObject({
      canResume: true,
      checkpoint: { phase: 'tool_done', pendingTools: [] },
      recoveredCalls: [{ callId: call.id, status: 'done' }]
    })
    expect(storage.autoResumeRuns(db)).toEqual([runId])
    expect(storage.loadCheckpoint(db, runId).messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: call.id,
      content: '台账结果'
    })

    const bodies = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
      bodies.push(JSON.parse(opts.body))
      return response({ content: '恢复完成' })
    })
    agent.resumeQueuedRuns()
    await expect
      .poll(() => agent.getRunStatus(runId), { timeout: 10000 })
      .toMatchObject({ status: 'done', resumeCount: 1 })
    expect(bodies).toHaveLength(1)
    expect(bodies[0].messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: call.id,
      content: '台账结果'
    })
  })

  it('model_done 的台账参数或结果冲突时保持人工恢复', () => {
    const call = {
      id: 'call-conflict',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"a.txt"}' }
    }
    const { runId } = seedRun({
      checkpoint: {
        phase: 'model_done',
        step: 1,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: '目标' },
          { role: 'assistant', content: '', tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id, content: '消息结果' }
        ],
        pendingToolCalls: [],
        stepsUsed: 1
      }
    })
    const ledgerId = repos.startToolCall(db, {
      runId,
      step: 1,
      tool: 'read_file',
      args: { path: 'different.txt' },
      riskLevel: 'readonly',
      confirmedBy: 'auto',
      callId: call.id
    })
    repos.finishToolCall(db, ledgerId, { result: '消息结果', durationMs: 1 })
    expect(agent.getRunRecovery(runId)).toMatchObject({
      canResume: false,
      reason: 'model_done_args_mismatch'
    })
    expect(storage.autoResumeRuns(db)).toEqual([])
  })

  it('存储层直接核对并重新入队安全中断任务，拒绝损坏工作区配置', () => {
    const safe = seedRun({
      checkpoint: {
        phase: 'before_model',
        step: 1,
        messages: SAFE_MESSAGES.slice(0, 2),
        pendingToolCalls: [],
        stepsUsed: 1
      }
    })
    expect(storage.inspectInterruptedRun(db, safe.runId).canResume).toBe(true)
    expect(storage.requeueInterruptedRun(db, safe.runId)).toEqual({ ok: true })
    expect(repos.getRun(db, safe.runId).status).toBe('queued')

    conversationId = repos.createConversation(db, {
      title: '损坏工作区会话',
      providerId,
      model: 'm1'
    }).id
    const damaged = seedRun({
      checkpoint: {
        phase: 'before_model',
        step: 1,
        messages: SAFE_MESSAGES.slice(0, 2),
        pendingToolCalls: [],
        stepsUsed: 1
      }
    })
    db.prepare('UPDATE agent_runs SET workspace_json=? WHERE id=?').run('{bad-json', damaged.runId)
    expect(storage.inspectInterruptedRun(db, damaged.runId)).toMatchObject({
      canResume: false,
      reason: 'workspace_invalid'
    })
    expect(storage.requeueInterruptedRun(db, damaged.runId)).toEqual({
      ok: false,
      reason: 'workspace_invalid'
    })
  })

  it('人工核对后可继续安全中断任务，并保留恢复次数', async () => {
    const { runId } = seedRun({
      checkpoint: {
        phase: 'before_model',
        step: 1,
        messages: SAFE_MESSAGES.slice(0, 2),
        pendingToolCalls: [],
        stepsUsed: 1
      }
    })
    db.prepare('UPDATE agent_runs SET resume_count=1 WHERE id=?').run(runId)
    expect(agent.getRunRecovery(runId).canResume).toBe(true)
    agent.resumeInterruptedRun(runId, { reason: '已核对工作区' })
    expect(repos.getRun(db, runId)).toMatchObject({ status: 'queued', resumeCount: 2 })

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      response({ content: '人工恢复完成' })
    )
    agent.resumeQueuedRuns()
    await expect
      .poll(() => agent.getRunStatus(runId), { timeout: 10000 })
      .toMatchObject({ status: 'done', resumeCount: 2 })
  })

  it('未知副作用任务禁止原样继续，但可创建关联新任务', async () => {
    const { runId } = seedRun({
      checkpoint: {
        phase: 'model_done',
        step: 1,
        messages: SAFE_MESSAGES.slice(0, 3),
        pendingToolCalls: [{ id: 'call-1' }],
        stepsUsed: 1
      }
    })
    expect(agent.getRunRecovery(runId)).toMatchObject({
      canResume: false,
      reason: 'model_done_tool_unsettled'
    })
    expect(() => agent.resumeInterruptedRun(runId)).toThrow(/不可继续/)

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({ content: '重试完成' }))
    const retry = await agent.retryInterruptedRun(runId, { reason: '已核对工具台账' })
    expect(repos.getRun(db, retry.runId).retryOfRunId).toBe(runId)
    expect(repos.getRun(db, runId).status).toBe('interrupted')
    await expect
      .poll(() => agent.getRunStatus(retry.runId), { timeout: 10000 })
      .toMatchObject({ status: 'done', retryOfRunId: runId })
  })

  it('超限裁剪检查点时保持工具调用与结果配对', () => {
    const runId = repos.createRun(db, { conversationId, goal: 'g' })
    const calls = Array.from({ length: 20 }, (_, index) => ({
      id: `call-${index}`,
      type: 'function',
      function: { name: 'read_file', arguments: '{}' }
    }))
    expect(
      storage.saveCheckpoint(db, runId, {
        phase: 'tool_done',
        step: 1,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: '目标' },
          { role: 'assistant', content: '', tool_calls: calls },
          ...calls.map((call) => ({
            role: 'tool',
            tool_call_id: call.id,
            content: 'x'.repeat(30000)
          }))
        ],
        pendingToolCalls: [],
        stepsUsed: 1
      })
    ).toBe(true)

    const checkpoint = storage.loadCheckpoint(db, runId)
    const callIds = checkpoint.messages.flatMap((message) =>
      (message.tool_calls || []).map((call) => call.id)
    )
    const resultIds = checkpoint.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.tool_call_id)
    expect(callIds.length).toBeGreaterThan(0)
    expect(callIds.length).toBeLessThan(calls.length)
    expect([...callIds].sort()).toEqual([...resultIds].sort())
  })

  it('恢复有安全检查点的父任务时保留排队图节点', () => {
    const parent = seedRun({
      status: 'waiting_child',
      checkpoint: {
        phase: 'before_model',
        step: 1,
        messages: SAFE_MESSAGES.slice(0, 2),
        pendingToolCalls: [],
        stepsUsed: 1
      }
    })
    const graphId = graph.createGraph(db, { parentRunId: parent.runId, conversationId })
    const nodeConversationId = repos.createConversation(db, { title: '图节点会话' }).id
    const nodeRunId = repos.createRun(db, {
      conversationId: nodeConversationId,
      goal: '图节点',
      status: 'queued',
      parentRunId: parent.runId,
      controlMode: 'delegated',
      graphId,
      nodeKey: 'node'
    })
    const nodeMessage = repos.insertMessage(db, {
      conversationId: nodeConversationId,
      role: 'assistant',
      content: '',
      status: 'pending'
    })
    db.prepare(
      `UPDATE agent_runs SET run_spec_json='{"version":1}', assistant_message_id=?, submitted_at=? WHERE id=?`
    ).run(nodeMessage.id, Date.now(), nodeRunId)

    storage.recoverRuns(db)

    expect(repos.getRun(db, parent.runId)).toMatchObject({ status: 'queued', resumeCount: 1 })
    expect(repos.getRun(db, nodeRunId).status).toBe('queued')
  })
})
