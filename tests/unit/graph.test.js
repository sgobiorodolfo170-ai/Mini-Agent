import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dbm = require('../../electron/store/db')
const repos = require('../../electron/store/repos')
const graph = require('../../electron/main/agent/graph')

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

  it('限制节点数与深度常量', () => {
    expect(graph.MAX_NODES).toBe(12)
    expect(graph.MAX_DEPTH).toBe(3)
    expect(graph.MAX_CONCURRENCY).toBe(4)
    const tooMany = Array.from({ length: 13 }, (_, i) => ({ key: `n${i}`, goal: `G${i}` }))
    expect(() => graph.validatePlan(tooMany)).toThrow(/12/)
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
    expect(graph.blockedDependents(db, a)).toEqual([b, c])

    db.prepare("UPDATE agent_runs SET status='done' WHERE id IN (?,?)").run(a, b)
    db.prepare("UPDATE agent_runs SET status='done' WHERE id=?").run(c)
    expect(graph.refreshGraph(db, graphId).status).toBe('done')
    const sum = graph.summary(db, graphId)
    expect(sum.nodes.map((n) => n.nodeKey)).toEqual(['a', 'b', 'c'])
  })

  it('任一节点失败时图状态收口为 stopped', () => {
    const graphId = graph.createGraph(db, { parentRunId: 'p2' })
    const a = addRun(graphId, 'a')
    const b = addRun(graphId, 'b')
    db.prepare("UPDATE agent_runs SET status='error' WHERE id=?").run(a)
    db.prepare("UPDATE agent_runs SET status='stopped' WHERE id=?").run(b)
    expect(graph.refreshGraph(db, graphId).status).toBe('stopped')
  })
})
