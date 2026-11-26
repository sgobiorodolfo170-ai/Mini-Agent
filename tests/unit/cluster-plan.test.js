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
  repos.addKey(db, { providerId, label: 'key', secretEnc: 'plain:key' })
  conversationId = repos.createConversation(db, { title: 'Root', providerId, model: 'm1' }).id
})

afterEach(async () => {
  await agent.stopAllRuns()
  dbm.close()
  require.cache[electronPath].exports = originalElectron
  vi.restoreAllMocks()
})

function response(content) {
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      if (content) {
        yield Buffer.from(
          `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`
        )
      } else {
        await new Promise(() => {})
      }
    })()
  }
}

it('creates no child run before a draft plan is confirmed', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(''))
  const parent = await agent.startAgentRun({
    conversationId,
    goal: 'root',
    permission: 'full',
    cluster: true
  })
  await expect.poll(() => agent.getRunStatus(parent.runId).status).toBe('running')
  const draft = agent.createDraftPlan(
    [
      { key: 'a', goal: 'A' },
      { key: 'b', goal: 'B', deps: ['a'] }
    ],
    { parentRunId: parent.runId, idempotencyKey: 'draft-1' }
  )
  expect(draft.status).toBe('draft')
  expect(repos.listChildRuns(db, parent.runId)).toEqual([])
  expect(agent.listDraftPlans(parent.runId)).toHaveLength(1)
  expect(
    agent.createDraftPlan(draft.tasks, { parentRunId: parent.runId, idempotencyKey: 'draft-1' })
      .planId
  ).toBe(draft.planId)
  expect(() => agent.confirmDraftPlan({ planId: draft.planId, etag: 'stale' })).toThrow(
    /计划内容已变化/
  )
  const confirmed = agent.confirmDraftPlan({ planId: draft.planId, etag: draft.etag })
  expect(confirmed.status).toBe('confirmed')
  expect(confirmed.graphId).toBeTruthy()
  expect(repos.listChildRuns(db, parent.runId)).toHaveLength(2)
  expect(agent.confirmDraftPlan({ planId: draft.planId, etag: draft.etag }).graphId).toBe(
    confirmed.graphId
  )
})

it('rejects a draft without creating runs and enforces the cluster gate', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(''))
  const parent = await agent.startAgentRun({
    conversationId,
    goal: 'root',
    permission: 'full',
    cluster: true
  })
  await expect.poll(() => agent.getRunStatus(parent.runId).status).toBe('running')
  const draft = agent.createDraftPlan([{ key: 'a', goal: 'A' }], { parentRunId: parent.runId })
  expect(agent.rejectDraftPlan({ planId: draft.planId, etag: draft.etag }).status).toBe('rejected')
  expect(repos.listChildRuns(db, parent.runId)).toEqual([])

  const plainConversation = repos.createConversation(db, {
    title: 'Plain',
    providerId: repos.getConversation(db, conversationId).providerId,
    model: 'm1'
  }).id
  const plain = await agent.startAgentRun({
    conversationId: plainConversation,
    goal: 'plain',
    permission: 'full'
  })
  await expect.poll(() => agent.getRunStatus(plain.runId).status).toBe('running')
  expect(() =>
    agent.createDraftPlan([{ key: 'a', goal: 'A' }], { parentRunId: plain.runId })
  ).toThrow(/未开启/)
})
