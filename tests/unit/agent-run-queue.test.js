import { afterEach, beforeEach, expect, it } from 'vitest'
import { setImmediate as tick } from 'node:timers/promises'
import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'
import storage from '../../electron/store/run-storage'
import runtime from '../../electron/main/agent/run-runtime'
import graph from '../../electron/main/agent/graph'

let db

beforeEach(() => {
  db = dbm.open(':memory:')
})
afterEach(() => dbm.close())

function seed(status, parentRunId, controlMode, { graphId = null, nodeKey = null } = {}) {
  const conv = repos.createConversation(db, {})
  const id = repos.createRun(db, {
    conversationId: conv.id,
    goal: 'goal',
    status,
    parentRunId,
    controlMode,
    graphId,
    nodeKey
  })
  const message = repos.insertMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    status: 'pending'
  })
  db.prepare(
    `UPDATE agent_runs SET run_spec_json='{"version":1}', assistant_message_id=?, submitted_at=? WHERE id=?`
  ).run(message.id, Date.now(), id)
  return id
}

it('exposes run snapshots, transfer results and event-driven waits', async () => {
  const parent = seed('running')
  const child = seed('transferred', parent, 'transferred')
  const handoff = seed('done', child, 'transferred')
  db.prepare('UPDATE agent_runs SET transfer_to_run_id=? WHERE id=?').run(handoff, child)
  const message = repos.getMessage(db, repos.getRun(db, handoff).assistantMessageId)
  repos.updateMessage(db, message.id, { content: 'handoff result', status: 'done' })

  expect(runtime.getRunStatus(db, parent).id).toBe(parent)
  expect(runtime.followTransfer(db, repos.getRun(db, child)).id).toBe(handoff)
  expect(runtime.getRunResult(db, handoff).content).toBe('handoff result')
  await expect(
    runtime.waitForRuns(db, { runIds: [handoff], timeoutMs: 10 })
  ).resolves.toMatchObject({
    timedOut: false,
    runs: [expect.objectContaining({ runId: handoff, content: 'handoff result' })]
  })
  await expect(
    runtime.waitForRuns(db, { runIds: ['removed'], resolveRunIds: () => [], timeoutMs: 10 })
  ).resolves.toEqual({ timedOut: false, runs: [] })
})

it('reset clears stale slots and invalidates a scheduled callback', async () => {
  const first = seed('queued')
  const launches = []
  const queue = runtime.createRunQueue({
    limit: 1,
    shuttingDown: () => false,
    launch(store, id) {
      runtime.transition(store, id, { status: 'running' })
      launches.push(id)
    }
  })
  queue.schedule(db)
  queue.reset()
  await tick()
  expect(launches).toEqual([])

  repos.updateRunStatus(db, first, { status: 'stopped' })
  const second = seed('queued')
  queue.schedule(db)
  await tick()
  expect(launches).toEqual([second])
  expect(repos.getRun(db, first).status).toBe('stopped')
})

it('restarts unclaimed handoffs and interrupts claimed work without replaying it', () => {
  const root = seed('transferred')
  const handoff = seed('queued', root, 'transferred')
  const claimedParent = seed('waiting_child')
  const delegated = seed('transferred', claimedParent, 'delegated')
  const orphan = seed('queued', delegated, 'transferred')
  storage.recoverRuns(db)
  expect(repos.getRun(db, handoff).status).toBe('queued')
  expect(repos.getRun(db, claimedParent).status).toBe('interrupted')
  expect(repos.getRun(db, orphan)).toMatchObject({
    status: 'stopped',
    finishedReason: 'parent_interrupted'
  })
  const history = db.prepare('SELECT status FROM run_events ORDER BY seq').all()
  expect(history.map((row) => row.status)).toEqual(
    expect.arrayContaining(['interrupted', 'stopped'])
  )
})

it('releases the only execution slot for a child and resumes the waiting parent', async () => {
  const parent = seed('queued')
  const child = seed('queued', parent, 'delegated')
  const launches = []
  const signal = new AbortController().signal
  let resumed
  const queue = runtime.createRunQueue({
    limit: 1,
    shuttingDown: () => false,
    launch(store, id) {
      runtime.transition(store, id, { status: 'running' })
      launches.push(id)
    }
  })
  db.prepare('UPDATE agent_runs SET submitted_at=0 WHERE id=?').run(parent)
  queue.schedule(db)
  await tick()
  expect(launches).toEqual([parent])
  queue.release(db, parent)
  await tick()
  expect(launches).toEqual([parent, child])
  resumed = queue.acquire(db, parent, signal)
  queue.release(db, child)
  expect(await resumed).toBe(true)
})

it('only launches graph nodes whose dependencies are done', async () => {
  const graphId = graph.createGraph(db, { parentRunId: 'p' })
  const a = seed('queued', null, null, { graphId, nodeKey: 'a' })
  const b = seed('queued', null, null, { graphId, nodeKey: 'b' })
  graph.addDependencies(
    db,
    [
      { key: 'a', deps: [] },
      { key: 'b', deps: ['a'] }
    ],
    new Map([
      ['a', a],
      ['b', b]
    ])
  )
  const launches = []
  const queue = runtime.createRunQueue({
    limit: 4,
    shuttingDown: () => false,
    launch(store, id) {
      runtime.transition(store, id, { status: 'running' })
      launches.push(id)
    }
  })
  queue.schedule(db)
  await tick()
  expect(launches).toEqual([a])

  db.prepare(
    "UPDATE agent_runs SET status='done', acceptance_policy='{}', acceptance_status='pending' WHERE id=?"
  ).run(a)
  queue.release(db, a)
  await tick()
  expect(launches).toEqual([a])

  db.prepare("UPDATE agent_runs SET acceptance_status='accepted' WHERE id=?").run(a)
  queue.schedule(db)
  await tick()
  expect(launches).toEqual([a, b])
})

it('keeps a failed dependency from launching downstream nodes and caps one graph at four', async () => {
  const graphId = graph.createGraph(db, { parentRunId: 'p' })
  const failed = seed('error', null, null, { graphId, nodeKey: 'failed' })
  const blocked = seed('queued', null, null, { graphId, nodeKey: 'blocked' })
  graph.addDependencies(
    db,
    [
      { key: 'failed', deps: [] },
      { key: 'blocked', deps: ['failed'] }
    ],
    new Map([
      ['failed', failed],
      ['blocked', blocked]
    ])
  )
  const nodes = Array.from({ length: 6 }, (_, i) =>
    seed('queued', null, null, { graphId, nodeKey: `n${i}` })
  )
  const launches = []
  const queue = runtime.createRunQueue({
    limit: 4,
    shuttingDown: () => false,
    launch(store, id) {
      runtime.transition(store, id, { status: 'running' })
      launches.push(id)
    }
  })
  queue.schedule(db)
  await tick()
  expect(launches).toHaveLength(4)
  expect(launches).not.toContain(blocked)
  expect(nodes.length).toBe(6)
})

it('recovers interrupted graph nodes and blocks their queued dependents', () => {
  const graphId = graph.createGraph(db, { parentRunId: 'p' })
  const parent = seed('running', null, null, { graphId, nodeKey: 'parent' })
  const child = seed('queued', null, null, { graphId, nodeKey: 'child' })
  graph.addDependencies(
    db,
    [
      { key: 'parent', deps: [] },
      { key: 'child', deps: ['parent'] }
    ],
    new Map([
      ['parent', parent],
      ['child', child]
    ])
  )
  storage.recoverRuns(db)
  expect(repos.getRun(db, parent).status).toBe('interrupted')
  expect(repos.getRun(db, child)).toMatchObject({
    status: 'stopped',
    finishedReason: 'dependency_failed'
  })
  expect(graph.refreshGraph(db, graphId).status).toBe('stopped')
})
