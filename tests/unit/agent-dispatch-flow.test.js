import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
require('electron')
const dbm = require('../../electron/store/db')
const repos = require('../../electron/store/repos')
const agent = require('../../electron/main/agent')
const { getHub } = require('../../electron/main/events/hub')

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

async function start(goal = 'root') {
  return agent.startAgentRun({ conversationId, goal, permission: 'full' })
}

it('stops the real parent loop after a committed handoff', async () => {
  let rootCalls = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
    const { messages } = JSON.parse(opts.body)
    if (messages.at(-1).content === 'handoff') return response({ content: 'child result' })
    rootCalls++
    return response({
      tool_calls: [
        tool('run_transfer', { goal: 'handoff' }),
        tool('run_dispatch', { goal: 'must not run' }, 1)
      ]
    })
  })
  const parent = await start()
  await expect
    .poll(() => agent.getRunStatus(parent.runId).status, { timeout: 15000 })
    .toBe('transferred')
  const target = agent.getRunStatus(parent.runId).transferToRunId
  await expect
    .poll(() => agent.getRunResult(target), { timeout: 15000 })
    .toMatchObject({ status: 'done', content: 'child result' })
  expect(repos.getRunCalls(db, parent.runId).map((entry) => entry.tool)).toEqual(['run_transfer'])
  expect(rootCalls).toBe(1)
  expect(repos.getMessage(db, parent.assistantMsgId).status).toBe('transferred')
})

it('rolls back child, messages and events if the parent transfer update fails', async () => {
  db.exec(`CREATE TRIGGER fail_transfer BEFORE UPDATE OF status ON agent_runs
    WHEN NEW.status='transferred' BEGIN SELECT RAISE(ABORT, 'test transfer failure'); END`)
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
    const { messages } = JSON.parse(opts.body)
    return messages.at(-1).role === 'tool'
      ? response({ content: 'parent continued' })
      : response({ tool_calls: [tool('run_transfer', { goal: 'rolled back' })] })
  })
  const parent = await start()
  await expect
    .poll(() => agent.getRunResult(parent.runId), { timeout: 15000 })
    .toMatchObject({ status: 'done', content: 'parent continued' })
  expect(repos.listChildRuns(db, parent.runId)).toEqual([])
  expect(repos.listChildConversations(db, conversationId)).toEqual([])
  expect(
    db
      .prepare('SELECT DISTINCT run_id FROM run_events')
      .all()
      .map((r) => r.run_id)
  ).toEqual([parent.runId])
})

it('continues between dispatch and explicit wait, then reads the child result', async () => {
  const states = []
  const off = getHub().on('run.end', (event) => states.push(event.payload.status))
  try {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
      const { messages } = JSON.parse(opts.body)
      const last = messages.at(-1)
      if (last.content === 'child') return response({ content: 'delegated result' })
      if (last.role !== 'tool')
        return response({ tool_calls: [tool('run_dispatch', { goal: 'child' })] })
      const output = JSON.parse(last.content)
      if (last.tool_call_id === 'call-run_dispatch') {
        const child = repos.getRun(db, output.runId)
        states.push(repos.getRun(db, child.parentRunId).status)
        return response({ tool_calls: [tool('run_wait', { runIds: [child.id] })] })
      }
      return response({ content: output.runs[0].content })
    })
    const parent = await start()
    await expect
      .poll(() => agent.getRunResult(parent.runId), { timeout: 15000 })
      .toMatchObject({ status: 'done', content: 'delegated result' })
    expect(states[0]).toBe('running')
    expect(
      db
        .prepare('SELECT status FROM run_events WHERE run_id=? ORDER BY seq')
        .all(parent.runId)
        .map((r) => r.status)
    ).toEqual(['queued', 'running', 'waiting_child', 'running', 'done'])
  } finally {
    off()
  }
})
