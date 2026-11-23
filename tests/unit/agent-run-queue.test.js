import { afterEach, beforeEach, expect, it } from 'vitest'
import { setImmediate as tick } from 'node:timers/promises'
import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'
import storage from '../../electron/store/run-storage'
import runtime from '../../electron/main/agent/run-runtime'

let db

beforeEach(() => {
  db = dbm.open(':memory:')
})
afterEach(() => dbm.close())

function seed(status, parentRunId, controlMode) {
  const conv = repos.createConversation(db, {})
  const id = repos.createRun(db, {
    conversationId: conv.id,
    goal: 'goal',
    status,
    parentRunId,
    controlMode
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
