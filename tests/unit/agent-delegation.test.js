import { beforeEach, describe, expect, it } from 'vitest'

import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'

// 这些用例验证方案四 §6 的事务语义。
// 直接调用仓储层复现 startAgentRun 的关系建立逻辑，
// 避免拉起真实模型请求。

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
})

function conv(title = 'C') {
  return repos.createConversation(dbm.get(), { title })
}

// 复现 startAgentRun 中「建子 Run + 改父状态」的原子序列
function spawnChild({ parentId, conversationId, controlMode, goal = 'sub' }) {
  const db = dbm.get()
  const childId = repos.createRun(db, {
    conversationId,
    goal,
    parentRunId: parentId,
    controlMode
  })
  const target = controlMode === 'transferred' ? 'transferred' : 'waiting_child'
  const upd = repos.updateRunStatus(db, parentId, { status: target })
  if (!upd.ok) {
    db.prepare('DELETE FROM agent_runs WHERE id = ?').run(childId)
    throw new Error(`父任务状态更新失败：${upd.reason}`)
  }
  return childId
}

describe('委派 delegated（§6.2）', () => {
  it('创建子 Run 后父 Run 进入 waiting_child', () => {
    const db = dbm.get()
    const c = conv()
    const parent = repos.createRun(db, { conversationId: c.id, goal: 'p' })
    const child = spawnChild({ parentId: parent, conversationId: c.id, controlMode: 'delegated' })
    expect(repos.getRun(db, parent).status).toBe('waiting_child')
    expect(repos.getRun(db, child).parentRunId).toBe(parent)
  })

  it('waiting_child 时不可再派生（同时只允许一个活动子 Run）', () => {
    const db = dbm.get()
    const c = conv()
    const parent = repos.createRun(db, { conversationId: c.id, goal: 'p' })
    spawnChild({ parentId: parent, conversationId: c.id, controlMode: 'delegated' })
    expect(repos.listActiveChildRuns(db, parent)).toHaveLength(1)
  })

  it('子 Run 完成后父 Run 可从 waiting_child 恢复 running', () => {
    const db = dbm.get()
    const c = conv()
    const parent = repos.createRun(db, { conversationId: c.id, goal: 'p' })
    const child = spawnChild({ parentId: parent, conversationId: c.id, controlMode: 'delegated' })
    repos.updateRunStatus(db, child, { status: 'done' })
    expect(repos.listActiveChildRuns(db, parent)).toHaveLength(0)
    expect(repos.updateRunStatus(db, parent, { status: 'running' }).ok).toBe(true)
  })

  it('父 Run 在 waiting_child 时不能直接置 done（必须先恢复 running）', () => {
    const db = dbm.get()
    const c = conv()
    const parent = repos.createRun(db, { conversationId: c.id, goal: 'p' })
    spawnChild({ parentId: parent, conversationId: c.id, controlMode: 'delegated' })
    const r = repos.updateRunStatus(db, parent, { status: 'done' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('illegal_transition')
  })
})

describe('移交 transferred（§6.2）', () => {
  it('父 Run 进入终态 transferred，子 Run 记录控制模式', () => {
    const db = dbm.get()
    const c = conv()
    const parent = repos.createRun(db, { conversationId: c.id, goal: 'p' })
    const child = spawnChild({ parentId: parent, conversationId: c.id, controlMode: 'transferred' })
    expect(repos.getRun(db, parent).status).toBe('transferred')
    expect(repos.getRun(db, child).controlMode).toBe('transferred')
  })

  it('已移交的父 Run 不可恢复', () => {
    const db = dbm.get()
    const c = conv()
    const parent = repos.createRun(db, { conversationId: c.id, goal: 'p' })
    spawnChild({ parentId: parent, conversationId: c.id, controlMode: 'transferred' })
    for (const target of ['running', 'waiting_child', 'done']) {
      const r = repos.updateRunStatus(db, parent, { status: target })
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('already_terminal')
    }
  })

  it('子 Run 完成/失败都不影响已移交父 Run 的状态', () => {
    const db = dbm.get()
    const c = conv()
    const parent = repos.createRun(db, { conversationId: c.id, goal: 'p' })
    const child = spawnChild({ parentId: parent, conversationId: c.id, controlMode: 'transferred' })
    repos.updateRunStatus(db, child, { status: 'done' })
    expect(repos.getRun(db, parent).status).toBe('transferred')

    const c2 = conv('C2')
    const parent2 = repos.createRun(db, { conversationId: c2.id, goal: 'p2' })
    const child2 = spawnChild({
      parentId: parent2,
      conversationId: c2.id,
      controlMode: 'transferred'
    })
    repos.updateRunStatus(db, child2, { status: 'error' })
    expect(repos.getRun(db, parent2).status).toBe('transferred')
  })
})

describe('父状态更新失败时回滚子 Run（§6.2 末段）', () => {
  it('父 Run 已是终态时派生失败且不留孤儿子 Run', () => {
    const db = dbm.get()
    const c = conv()
    const parent = repos.createRun(db, { conversationId: c.id, goal: 'p' })
    repos.updateRunStatus(db, parent, { status: 'done' })
    const before = repos.listChildRuns(db, parent).length
    expect(() =>
      spawnChild({ parentId: parent, conversationId: c.id, controlMode: 'delegated' })
    ).toThrow(/父任务状态更新失败/)
    expect(repos.listChildRuns(db, parent)).toHaveLength(before)
  })
})
