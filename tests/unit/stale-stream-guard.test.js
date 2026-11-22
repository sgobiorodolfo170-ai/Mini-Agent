import { beforeEach, describe, expect, it } from 'vitest'

import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'
import { createEventHub, resetHub } from '../../electron/main/events/hub'

// 验证方案四 §5.3（旧流隔离）与 §5.4（内部召回留痕）的可观测契约。
// 这里不拉起真实 Run，而是复现两个核心判定：
//  1) 迟到事件必须被识别并标记，而不是静默丢弃；
//  2) 召回必须产生带发起方的事件。

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
  resetHub()
})

describe('旧流隔离判定（§5.3）', () => {
  // 复现 agent/index.js 中 isCurrentRun 的判定逻辑：
  // 有状态对象且仍在 active 表中、未被停止，才算「当前 Run」。
  function makeGuard() {
    const active = new Map()
    const state = { stopped: false }
    active.set('run-1', state)
    const isCurrent = () => !state.stopped && active.get('run-1') === state
    return { active, state, isCurrent }
  }

  it('正常运行时判定为当前 Run', () => {
    const { isCurrent } = makeGuard()
    expect(isCurrent()).toBe(true)
  })

  it('被 stopRun 后不再是当前 Run', () => {
    const { isCurrent, state } = makeGuard()
    state.stopped = true
    expect(isCurrent()).toBe(false)
  })

  it('被从 active 表中移除后不再是当前 Run', () => {
    const { isCurrent, active } = makeGuard()
    active.delete('run-1')
    expect(isCurrent()).toBe(false)
  })

  it('state 被同 id 的新对象替换后，旧闭包判定为过期', () => {
    const { isCurrent, active } = makeGuard()
    // 模拟「旧流仍在跑，但 Run 已被替换成新的 state」
    active.set('run-1', { stopped: false })
    expect(isCurrent()).toBe(false)
  })
})

describe('迟到事件审计（§5.3）', () => {
  it('stale_event_ignored 事件携带 runId / traceId / 原因', () => {
    const hub = resetHub()
    hub.emit('stale_event_ignored', {
      runId: 'r1',
      traceId: 't1',
      conversationId: 'c1',
      kind: 'delta',
      reason: 'stopped'
    })
    const ev = hub.recent({ name: 'stale_event_ignored' }).pop()
    expect(ev.payload).toMatchObject({
      runId: 'r1',
      traceId: 't1',
      kind: 'delta',
      reason: 'stopped'
    })
  })

  it('可区分 replaced 与 stopped 两种原因', () => {
    const hub = resetHub()
    hub.emit('stale_event_ignored', { runId: 'a', reason: 'stopped', kind: 'delta' })
    hub.emit('stale_event_ignored', { runId: 'b', reason: 'replaced', kind: 'tool-call' })
    const all = hub.recent({ name: 'stale_event_ignored' })
    expect(all).toHaveLength(2)
    expect(new Set(all.map((e) => e.payload.reason))).toEqual(new Set(['stopped', 'replaced']))
  })
})

describe('内部召回留痕（§5.4）', () => {
  // 复现 gateway/index.js 中 abortStreamsOf 的审计语义
  function abortStreams(active, conversationId, by) {
    const recalled = []
    for (const [msgId, entry] of active) {
      if (entry && entry.conversationId === conversationId) {
        active.delete(msgId)
        recalled.push(msgId)
      }
    }
    const hub = createEventHub()
    if (recalled.length) {
      hub.emit('stream.recalled', { conversationId, by, msgIds: recalled })
    }
    return { recalled, hub }
  }

  it('召回产生 stream.recalled，含发起方与被召回消息', () => {
    const active = new Map([
      ['m1', { conversationId: 'c1', superseded: false }],
      ['m2', { conversationId: 'c1', superseded: false }]
    ])
    const { recalled, hub } = abortStreams(active, 'c1', 'regenerate')
    expect(recalled.sort()).toEqual(['m1', 'm2'])
    const ev = hub.recent({ name: 'stream.recalled' }).pop()
    expect(ev.payload).toMatchObject({ conversationId: 'c1', by: 'regenerate' })
    expect(ev.payload.msgIds.sort()).toEqual(['m1', 'm2'])
  })

  it('只召回目标会话，不影响其他会话', () => {
    const active = new Map([
      ['m1', { conversationId: 'c1' }],
      ['m2', { conversationId: 'c2' }]
    ])
    const { recalled } = abortStreams(active, 'c1', 'new-send')
    expect(recalled).toEqual(['m1'])
    expect(active.has('m2')).toBe(true)
  })

  it('无在途流时不产生事件', () => {
    const active = new Map()
    const { recalled, hub } = abortStreams(active, 'c1', 'edit-resend')
    expect(recalled).toEqual([])
    expect(hub.recent({ name: 'stream.recalled' })).toHaveLength(0)
  })

  it('发起方原因覆盖三种入口', () => {
    for (const by of ['new-send', 'regenerate', 'edit-resend']) {
      const active = new Map([['m1', { conversationId: 'c1' }]])
      const { hub } = abortStreams(active, 'c1', by)
      const ev = hub.recent({ name: 'stream.recalled' }).pop()
      expect(ev.payload.by).toBe(by)
    }
  })
})

describe('完成状态写入不被旧流污染（§5.3 端到端）', () => {
  it('终态 Run 的再次写入被 CAS 拒绝', () => {
    const db = dbm.get()
    const conv = repos.createConversation(db, { title: 'C' })
    const runId = repos.createRun(db, { conversationId: conv.id, goal: 'g' })
    expect(repos.updateRunStatus(db, runId, { status: 'done' }).ok).toBe(true)
    // 模拟迟到回调尝试改写
    const late = repos.updateRunStatus(db, runId, { status: 'error' })
    expect(late.ok).toBe(false)
    expect(repos.getRun(db, runId).status).toBe('done')
  })

  it('Run 被删除后迟到写入返回 not_found 而非静默成功', () => {
    const db = dbm.get()
    const conv = repos.createConversation(db, { title: 'C' })
    const runId = repos.createRun(db, { conversationId: conv.id, goal: 'g' })
    db.prepare('DELETE FROM agent_runs WHERE id = ?').run(runId)
    const r = repos.updateRunStatus(db, runId, { status: 'done' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not_found')
  })
})
