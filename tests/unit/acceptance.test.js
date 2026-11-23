import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dbm = require('../../electron/store/db')
const repos = require('../../electron/store/repos')
const acceptance = require('../../electron/main/agent/acceptance')

let db
let providerId
let conversationId

function seedRun({ content = '报告结论：任务已完成', criteria = '交付必须包含结论' } = {}) {
  const runId = repos.createRun(db, {
    conversationId,
    goal: '写一份报告',
    acceptancePolicy: { schemaVersion: 1, criteria, judge: 'parent', onTimeout: 'escalate' }
  })
  const assistant = repos.insertMessage(db, {
    conversationId,
    role: 'assistant',
    content,
    status: 'pending'
  })
  db.prepare('UPDATE agent_runs SET status=?, assistant_message_id=? WHERE id=?').run(
    'running',
    assistant.id,
    runId
  )
  repos.updateRunStatus(db, runId, { status: 'done', acceptanceStatus: 'pending' })
  return runId
}

function deps(chatOnce, overrides = {}) {
  const events = []
  return {
    db,
    repos,
    chatOnce,
    resolveModel: () => ({
      provider: repos.getProvider(db, providerId),
      model: 'm1'
    }),
    decryptSecret: async () => 'test-key',
    broadcast: (channel, payload) => events.push({ channel, payload }),
    emit: (type, payload) => events.push({ type, payload }),
    timeoutMs: 1000,
    events,
    ...overrides
  }
}

beforeEach(() => {
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
    title: '验收会话',
    providerId,
    model: 'm1'
  }).id
})

afterEach(() => {
  acceptance._resetQueue()
  dbm.close()
  vi.restoreAllMocks()
})

describe('自动验收 judge', () => {
  it('解析 fenced JSON，并拒绝非法 verdict', () => {
    expect(
      acceptance.parseVerdict('```json\n{"verdict":"accepted","reason":"ok","unmet":[]}\n```')
    ).toMatchObject({ verdict: 'accepted', reason: 'ok', unmet: [] })
    expect(acceptance.parseVerdict('{"verdict":"maybe"}')).toBeNull()
    expect(acceptance.parseVerdict('不是 JSON')).toBeNull()
  })

  it('通过时落库 accepted、原因与事件', async () => {
    const runId = seedRun()
    const d = deps(async () => ({
      content: '{"verdict":"accepted","reason":"包含结论","unmet":[]}'
    }))
    const updated = await acceptance.judgeRun(d, runId)

    expect(updated.acceptanceStatus).toBe('accepted')
    const result = JSON.parse(updated.acceptanceResult)
    expect(result).toMatchObject({ verdict: 'accepted', reason: '包含结论', model: 'm1' })
    expect(result.attempts).toBe(1)
    expect(d.events.some((e) => e.type === 'acceptance.judged')).toBe(true)
    expect(d.events.some((e) => e.channel === 'agent:event')).toBe(true)
  })

  it('非法 JSON 或模型失败时升级人工，不覆盖 Run 终态', async () => {
    const runId = seedRun()
    const d = deps(async () => ({ content: '我觉得可以通过' }))
    const updated = await acceptance.judgeRun(d, runId)

    expect(updated.status).toBe('done')
    expect(updated.acceptanceStatus).toBe('escalated')
    expect(JSON.parse(updated.acceptanceResult).verdict).toBe('escalated')
    expect(d.events.some((e) => e.type === 'acceptance.failed')).toBe(true)
  })

  it('没有可用模型时直接升级人工', async () => {
    const runId = seedRun()
    const d = deps(async () => ({ content: '{}' }), {
      resolveModel: () => ({ provider: null, model: null })
    })
    const updated = await acceptance.judgeRun(d, runId)
    expect(updated.acceptanceStatus).toBe('escalated')
    expect(JSON.parse(updated.acceptanceResult).reason).toContain('验收模型')
  })

  it('人工改判 pending → accepted 并保留此前结果', async () => {
    const runId = seedRun()
    const d = deps(async () => ({ content: '{}' }))
    const updated = acceptance.decideAcceptance(d, {
      runId,
      decision: 'accepted',
      reason: '人工确认',
      actor: 'test'
    })
    expect(updated.acceptanceStatus).toBe('accepted')
    const result = JSON.parse(updated.acceptanceResult)
    expect(result.manual).toMatchObject({ decision: 'accepted', actor: 'test', reason: '人工确认' })
  })

  it('已通过的任务不接受再次人工改判', () => {
    const runId = seedRun()
    repos.updateRunAcceptance(db, runId, { status: 'accepted', result: { verdict: 'accepted' } })
    const d = deps(async () => ({ content: '{}' }))
    expect(() =>
      acceptance.decideAcceptance(d, { runId, decision: 'rejected', reason: '再改' })
    ).toThrow(/不允许/)
  })
})
