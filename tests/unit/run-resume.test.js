import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
require('electron')
const dbm = require('../../electron/store/db')
const repos = require('../../electron/store/repos')
const storage = require('../../electron/store/run-storage')
const agent = require('../../electron/main/agent')

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
})
