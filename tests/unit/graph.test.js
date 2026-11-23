import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'
import graph from '../../electron/main/agent/graph'
import { transaction } from '../../electron/main/remote/protocol'

let db
let conversationId

beforeEach(() => {
  db = dbm.open(':memory:')
  conversationId = repos.createConversation(db, { title: '图测试' }).id
})

afterEach(() => dbm.close())

function addRun(graphId, nodeKey, status = 'queued') {
  return repos.createRun(db, {
    conversationId,
    goal: nodeKey,
    status,
    graphId,
    nodeKey
  })
}

describe('任务依赖图', () => {
  it('校验 key、依赖存在、自依赖与环', () => {
    expect(graph.validatePlan([{ key: 'a', goal: 'A' }])).toHaveLength(1)
    expect(() => graph.validatePlan([])).toThrow(/不能为空/)
    expect(() => graph.validatePlan([{ key: 'a', goal: '' }])).toThrow(/缺少目标/)
    expect(() =>
      graph.validatePlan([
        { key: 'a', goal: 'A' },
        { key: 'a', goal: 'B' }
      ])
    ).toThrow(/重复/)
    expect(() => graph.validatePlan([{ key: 'a', goal: 'A', deps: ['x'] }])).toThrow(/不存在/)
    expect(() => graph.validatePlan([{ key: 'a', goal: 'A', deps: ['a'] }])).toThrow(/自身/)
    expect(() =>
      graph.validatePlan([
        { key: 'a', goal: 'A', deps: ['b'] },
        { key: 'b', goal: 'B', deps: ['a'] }
      ])
    ).toThrow(/环/)
  })

  it('限制节点数与深度', () => {
    expect(graph.MAX_NODES).toBe(12)
    expect(graph.MAX_DEPTH).toBe(3)
    expect(graph.MAX_CONCURRENCY).toBe(4)
    const tooMany = Array.from({ length: 13 }, (_, i) => ({ key: `n${i}`, goal: `G${i}` }))
    expect(() => graph.validatePlan(tooMany)).toThrow(/12/)
    const chain = (length) =>
      Array.from({ length }, (_, i) => ({
        key: `n${i}`,
        goal: `G${i}`,
        deps: i ? [`n${i - 1}`] : []
      }))
    expect(graph.validatePlan(chain(3))).toHaveLength(3)
    expect(() => graph.validatePlan(chain(4))).toThrow(/深度/)
  })

  it('持久化依赖、查询下游并汇总图状态', () => {
    const graphId = graph.createGraph(db, { parentRunId: 'p1', conversationId })
    const a = addRun(graphId, 'a')
    const b = addRun(graphId, 'b')
    const c = addRun(graphId, 'c')
    graph.addDependencies(
      db,
      [
        { key: 'a', deps: [] },
        { key: 'b', deps: ['a'] },
        { key: 'c', deps: ['b'] }
      ],
      new Map([
        ['a', a],
        ['b', b],
        ['c', c]
      ])
    )

    const deps = graph.listDependencies(db, graphId)
    expect(deps).toHaveLength(2)
    expect(graph.listDirectDependencies(db, b).map((run) => run.id)).toEqual([a])
    expect(graph.getGraphForParent(db, 'p1').id).toBe(graphId)
    expect(graph.blockedDependents(db, a)).toEqual([b, c])

    db.prepare("UPDATE agent_runs SET status='done' WHERE id IN (?,?)").run(a, b)
    db.prepare("UPDATE agent_runs SET status='done' WHERE id=?").run(c)
    expect(graph.refreshGraph(db, graphId).status).toBe('done')
    const sum = graph.summary(db, graphId)
    expect(sum.nodes.map((n) => n.nodeKey)).toEqual(['a', 'b', 'c'])
  })

  it('验收未结束时图保持 running，拒绝后收口为 stopped', () => {
    const graphId = graph.createGraph(db, { parentRunId: 'p3' })
    const a = addRun(graphId, 'a', 'done')
    db.prepare(
      "UPDATE agent_runs SET acceptance_policy='{}', acceptance_status='pending' WHERE id=?"
    ).run(a)
    expect(graph.refreshGraph(db, graphId).status).toBe('running')
    db.prepare("UPDATE agent_runs SET acceptance_status='rejected' WHERE id=?").run(a)
    expect(graph.refreshGraph(db, graphId).status).toBe('stopped')
  })

  it('任一节点失败时图状态收口为 stopped', () => {
    const graphId = graph.createGraph(db, { parentRunId: 'p2' })
    const a = addRun(graphId, 'a')
    const b = addRun(graphId, 'b')
    db.prepare("UPDATE agent_runs SET status='error' WHERE id=?").run(a)
    db.prepare("UPDATE agent_runs SET status='stopped' WHERE id=?").run(b)
    expect(graph.refreshGraph(db, graphId).status).toBe('stopped')
  })

  it('只允许修改 queued 节点并在事务中重规划依赖', () => {
    const parentConversation = repos.createConversation(db, { title: '父会话' })
    const parentRunId = repos.createRun(db, {
      conversationId: parentConversation.id,
      goal: '父任务',
      status: 'running'
    })
    const graphId = graph.createGraph(db, { parentRunId, conversationId: parentConversation.id })
    const ids = new Map()
    for (const key of ['a', 'b', 'c']) {
      const nodeConversation = repos.createConversation(db, {
        title: key,
        parentId: parentConversation.id
      })
      const runId = repos.createRun(db, {
        conversationId: nodeConversation.id,
        goal: `目标 ${key}`,
        status: 'queued',
        parentRunId,
        controlMode: 'delegated',
        graphId,
        nodeKey: key
      })
      const user = repos.insertMessage(db, {
        conversationId: nodeConversation.id,
        role: 'user',
        content: `目标 ${key}`
      })
      const assistant = repos.insertMessage(db, {
        conversationId: nodeConversation.id,
        role: 'assistant',
        content: '',
        status: 'pending'
      })
      db.prepare(
        `UPDATE agent_runs SET run_spec_json='{"version":1}',user_message_id=?,assistant_message_id=?,submitted_at=? WHERE id=?`
      ).run(user.id, assistant.id, Date.now(), runId)
      ids.set(key, runId)
    }
    graph.addDependencies(
      db,
      [
        { key: 'a', deps: [] },
        { key: 'b', deps: ['a'] },
        { key: 'c', deps: ['b'] }
      ],
      ids
    )
    const before = graph.summary(db, graphId)
    expect(before.layers.map((layer) => layer.map((node) => node.nodeKey))).toEqual([
      ['a'],
      ['b'],
      ['c']
    ])
    const updated = transaction(db, () =>
      graph.mutateGraph(db, {
        graphId,
        etag: before.etag,
        ops: [
          {
            action: 'update',
            runId: ids.get('c'),
            goal: '目标 C 已更新',
            deps: [ids.get('a')]
          }
        ]
      })
    )
    expect(updated.nodes.find((node) => node.runId === ids.get('c'))).toMatchObject({
      goal: '目标 C 已更新',
      depth: 2
    })
    expect(updated.dependencies).not.toContainEqual(
      expect.objectContaining({ runId: ids.get('c'), dependsOnRunId: ids.get('b') })
    )

    const deleted = transaction(db, () =>
      graph.mutateGraph(db, {
        graphId,
        etag: updated.etag,
        ops: [{ action: 'delete', runId: ids.get('b') }]
      })
    )
    expect(deleted.nodes.map((node) => node.nodeKey)).toEqual(['a', 'c'])
    expect(repos.getRun(db, ids.get('b'))).toMatchObject({
      status: 'stopped',
      graphId: null,
      finishedReason: 'removed_from_graph'
    })
    expect(() =>
      graph.mutateGraph(db, {
        graphId,
        etag: before.etag,
        ops: [{ action: 'update', runId: ids.get('a'), goal: '过期编辑' }]
      })
    ).toThrow(/已变化/)
  })

  it('运行中节点和队列已认领节点不可修改', () => {
    const parentConversation = repos.createConversation(db, { title: '父会话' })
    const parentRunId = repos.createRun(db, {
      conversationId: parentConversation.id,
      goal: '父任务',
      status: 'running'
    })
    const graphId = graph.createGraph(db, { parentRunId, conversationId: parentConversation.id })
    const ids = new Map()
    for (const key of ['a', 'b']) {
      const nodeConversation = repos.createConversation(db, {
        title: key,
        parentId: parentConversation.id
      })
      const runId = repos.createRun(db, {
        conversationId: nodeConversation.id,
        goal: key,
        status: 'queued',
        parentRunId,
        controlMode: 'delegated',
        graphId,
        nodeKey: key
      })
      ids.set(key, runId)
    }
    repos.updateRunStatus(db, ids.get('a'), { status: 'running' })
    const snapshot = graph.summary(db, graphId)
    expect(() =>
      graph.mutateGraph(db, {
        graphId,
        etag: snapshot.etag,
        ops: [{ action: 'update', runId: ids.get('a'), goal: '不允许' }]
      })
    ).toThrow(/排队节点/)
    expect(() =>
      graph.mutateGraph(db, {
        graphId,
        etag: snapshot.etag,
        ops: [{ action: 'update', runId: ids.get('b'), goal: '不允许' }],
        isClaimed: (runId) => runId === ids.get('b')
      })
    ).toThrow(/排队节点/)
  })
})
