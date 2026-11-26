import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as agent from '../../electron/main/agent'

const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
require('electron')
const dbm = require('../../electron/store/db')
const repos = require('../../electron/store/repos')

let db
let conversationId
let originalElectron

beforeEach(() => {
  originalElectron = require.cache[electronPath].exports
  require.cache[electronPath].exports = { app: { getPath: () => tmpdir() } }
  db = dbm.open(':memory:')
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
  conversationId = repos.createConversation(db, { title: 'Root', providerId, model: 'm1' }).id
})

afterEach(async () => {
  await agent.stopAllRuns()
  dbm.close()
  require.cache[electronPath].exports = originalElectron
  vi.restoreAllMocks()
})

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

function tool(name, args, index = 0) {
  return {
    index,
    id: 'call-' + name,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  }
}

async function approvePlans() {
  const approvals = agent.getApprovalService()
  const original = approvals.decide.bind(approvals)
  approvals.decide = (input) => {
    const pending = original(input)
    setImmediate(() => {
      const row = dbm
        .get()
        .prepare(
          "SELECT approval_id FROM agent_approvals WHERE run_id=? AND tool='run_plan_confirm' AND status='pending' ORDER BY created_at DESC LIMIT 1"
        )
        .get(input.runId)
      if (row) approvals.respond({ approvalId: row.approval_id, decision: 'approved' })
    })
    return pending
  }
}

it('runs a dependency graph in order and waits for the whole graph', async () => {
  await approvePlans()
  const childGoals = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
    const { messages } = JSON.parse(opts.body)
    const last = messages.at(-1)
    if (last.content === '任务A') {
      childGoals.push('A')
      return response({ content: 'A result' })
    }
    if (last.content === '任务B') {
      childGoals.push('B')
      return response({ content: 'B result' })
    }
    if (last.role !== 'tool') {
      return response({
        tool_calls: [
          tool('run_plan', {
            tasks: [
              { key: 'a', goal: '任务A' },
              { key: 'b', goal: '任务B', deps: ['a'] }
            ]
          })
        ]
      })
    }
    const output = JSON.parse(last.content)
    if (last.tool_call_id === 'call-run_plan') {
      return response({
        tool_calls: [tool('run_plan_confirm', { planId: output.planId, etag: output.etag })]
      })
    }
    if (last.tool_call_id === 'call-run_plan_confirm') {
      return response({ tool_calls: [tool('run_wait', { graphId: output.graphId })] })
    }
    return response({ content: output.runs.map((r) => r.content).join(' / ') })
  })

  const parent = await agent.startAgentRun({
    conversationId,
    goal: '按顺序完成两个任务',
    permission: 'full',
    cluster: true
  })
  await expect
    .poll(() => agent.getRunResult(parent.runId), { timeout: 20000 })
    .toMatchObject({ status: 'done', content: 'A result / B result' })

  expect(childGoals).toEqual(['A', 'B'])
  const graph = agent.getGraphForParent(parent.runId)
  expect(graph.status).toBe('done')
  expect(graph.nodes.map((n) => n.nodeKey)).toEqual(['a', 'b'])
  expect(graph.nodes.map((n) => n.status)).toEqual(['done', 'done'])
  expect(graph.dependencies).toEqual([
    expect.objectContaining({ dependsOnRunId: graph.nodes[0].runId })
  ])
})

it('blocks downstream nodes when a dependency fails', async () => {
  await approvePlans()
  const childGoals = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
    const { messages } = JSON.parse(opts.body)
    const last = messages.at(-1)
    if (last.content === '任务A') {
      childGoals.push('A')
      return response({})
    }
    if (last.content === '任务B') {
      childGoals.push('B')
      return response({ content: 'B should not run' })
    }
    if (last.role !== 'tool') {
      return response({
        tool_calls: [
          tool('run_plan', {
            tasks: [
              { key: 'a', goal: '任务A' },
              { key: 'b', goal: '任务B', deps: ['a'] }
            ]
          })
        ]
      })
    }
    const output = JSON.parse(last.content)
    if (last.tool_call_id === 'call-run_plan') {
      return response({
        tool_calls: [tool('run_plan_confirm', { planId: output.planId, etag: output.etag })]
      })
    }
    if (last.tool_call_id === 'call-run_plan_confirm') {
      return response({ tool_calls: [tool('run_wait', { graphId: output.graphId })] })
    }
    return response({ content: '已处理失败依赖' })
  })

  const parent = await agent.startAgentRun({
    conversationId,
    goal: '验证失败级联',
    permission: 'full',
    cluster: true
  })
  await expect
    .poll(() => agent.getRunResult(parent.runId), { timeout: 20000 })
    .toMatchObject({ status: 'done', content: '已处理失败依赖' })

  expect(childGoals).toEqual(['A'])
  const graph = agent.getGraphForParent(parent.runId)
  expect(graph.status).toBe('stopped')
  expect(graph.nodes.find((n) => n.nodeKey === 'a').status).toBe('error')
  expect(graph.nodes.find((n) => n.nodeKey === 'b')).toMatchObject({
    status: 'stopped',
    finishedReason: 'dependency_failed'
  })
})
