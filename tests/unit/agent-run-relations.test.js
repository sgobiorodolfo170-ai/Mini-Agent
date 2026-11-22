import { beforeEach, describe, expect, it } from 'vitest'

import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
})

function seedConversation() {
  return repos.createConversation(dbm.get(), { title: '任务会话' })
}

describe('Run 关系字段与迁移（方案四 §3.5）', () => {
  it('v5 迁移后新增列存在', () => {
    const db = dbm.get()
    const cols = db
      .prepare('PRAGMA table_info(agent_runs)')
      .all()
      .map((c) => c.name)
    for (const c of [
      'parent_run_id',
      'control_mode',
      'mandate_json',
      'acceptance_policy',
      'acceptance_status',
      'acceptance_result',
      'trace_id',
      'idempotency_key',
      'version'
    ]) {
      expect(cols).toContain(c)
    }
  })

  it('根 Run 的父关系为空，acceptance 默认 not_required', () => {
    const db = dbm.get()
    const conv = seedConversation()
    const runId = repos.createRun(db, { conversationId: conv.id, goal: '根任务' })
    const run = repos.getRun(db, runId)
    expect(run.parentRunId).toBeNull()
    expect(run.controlMode).toBeNull()
    expect(run.acceptanceStatus).toBe('not_required')
    expect(run.version).toBe(1)
  })

  it('子 Run 正确引用父 Run 并继承 traceId', () => {
    const db = dbm.get()
    const conv = seedConversation()
    const parentId = repos.createRun(db, { conversationId: conv.id, goal: '父', traceId: 't-1' })
    const childId = repos.createRun(db, {
      conversationId: conv.id,
      goal: '子',
      parentRunId: parentId,
      controlMode: 'delegated',
      traceId: 't-1'
    })
    const child = repos.getRun(db, childId)
    expect(child.parentRunId).toBe(parentId)
    expect(child.controlMode).toBe('delegated')
    expect(child.traceId).toBe('t-1')
  })

  it('非法 control_mode 被拒绝，且 parentRunId/controlMode 必须成对出现', () => {
    const db = dbm.get()
    const conv = seedConversation()
    const parentId = repos.createRun(db, { conversationId: conv.id, goal: '父' })
    expect(() =>
      repos.createRun(db, {
        conversationId: conv.id,
        goal: '子',
        parentRunId: parentId,
        controlMode: 'agency'
      })
    ).toThrow(/非法的 controlMode/)
    expect(() =>
      repos.createRun(db, { conversationId: conv.id, goal: '子', parentRunId: parentId })
    ).toThrow(/必须同时提供/)
    expect(() =>
      repos.createRun(db, { conversationId: conv.id, goal: '子', controlMode: 'delegated' })
    ).toThrow(/必须同时提供/)
  })

  it('重复 idempotencyKey 不会创建第二条 Run', () => {
    const db = dbm.get()
    const conv = seedConversation()
    const a = repos.createRun(db, {
      conversationId: conv.id,
      goal: '任务',
      idempotencyKey: 'k-1'
    })
    const b = repos.createRun(db, {
      conversationId: conv.id,
      goal: '任务',
      idempotencyKey: 'k-1'
    })
    expect(b).toBe(a)
    const rows = db.prepare('SELECT id FROM agent_runs WHERE idempotency_key = ?').all('k-1')
    expect(rows).toHaveLength(1)
  })
})

describe('Run 状态机与并发（方案四 §5）', () => {
  it('终态不可逆向非终态', () => {
    const db = dbm.get()
    const conv = seedConversation()
    const runId = repos.createRun(db, { conversationId: conv.id, goal: 'g' })
    expect(repos.updateRunStatus(db, runId, { status: 'done' }).ok).toBe(true)
    const back = repos.updateRunStatus(db, runId, { status: 'running' })
    expect(back.ok).toBe(false)
    expect(back.reason).toBe('already_terminal')
    expect(repos.getRun(db, runId).status).toBe('done')
  })

  it('非法跃迁被拒绝（queued → done）', () => {
    const db = dbm.get()
    const conv = seedConversation()
    const runId = repos.createRun(db, { conversationId: conv.id, goal: 'g', status: 'queued' })
    const r = repos.updateRunStatus(db, runId, { status: 'done' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('illegal_transition')
  })

  it('并发更新只有一个 CAS 成功', () => {
    const db = dbm.get()
    const conv = seedConversation()
    const runId = repos.createRun(db, { conversationId: conv.id, goal: 'g' })
    const v = repos.getRun(db, runId).version
    const first = repos.updateRunStatus(db, runId, { status: 'done', expectedVersion: v })
    const second = repos.updateRunStatus(db, runId, { status: 'stopped', expectedVersion: v })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    expect(repos.getRun(db, runId).status).toBe('done')
  })

  it('版本号每次成功更新递增', () => {
    const db = dbm.get()
    const conv = seedConversation()
    const runId = repos.createRun(db, { conversationId: conv.id, goal: 'g' })
    repos.updateRunStatus(db, runId, { status: 'waiting_child' })
    expect(repos.getRun(db, runId).version).toBe(2)
    repos.updateRunStatus(db, runId, { status: 'running' })
    expect(repos.getRun(db, runId).version).toBe(3)
  })

  it('委派/移交的父状态流转合法', () => {
    const db = dbm.get()
    const conv = seedConversation()
    const p1 = repos.createRun(db, { conversationId: conv.id, goal: 'p1' })
    expect(repos.updateRunStatus(db, p1, { status: 'waiting_child' }).ok).toBe(true)
    expect(repos.updateRunStatus(db, p1, { status: 'running' }).ok).toBe(true)

    const p2 = repos.createRun(db, { conversationId: conv.id, goal: 'p2' })
    expect(repos.updateRunStatus(db, p2, { status: 'transferred' }).ok).toBe(true)
    expect(repos.isRunTerminal('transferred')).toBe(true)
  })

  it('列出活动子 Run 供并发约束使用', () => {
    const db = dbm.get()
    const conv = seedConversation()
    const parent = repos.createRun(db, { conversationId: conv.id, goal: 'p' })
    repos.createRun(db, {
      conversationId: conv.id,
      goal: 'c',
      parentRunId: parent,
      controlMode: 'delegated'
    })
    expect(repos.listActiveChildRuns(db, parent)).toHaveLength(1)
    const childId = repos.listChildRuns(db, parent)[0].id
    repos.updateRunStatus(db, childId, { status: 'done' })
    expect(repos.listActiveChildRuns(db, parent)).toHaveLength(0)
  })
})
