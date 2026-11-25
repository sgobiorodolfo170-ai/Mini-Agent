import { describe, expect, it } from 'vitest'
import {
  buildTaskGraphEdges,
  buildTaskGraphNodes,
  defaultTaskGraphLayout,
  inverseDependencyOps
} from '../../src/common/task-graph'

function task(runId, depth, overrides = {}) {
  return {
    runId,
    nodeKey: `key-${runId}`,
    goal: `目标 ${runId}`,
    status: 'queued',
    depth,
    editable: true,
    ...overrides
  }
}

function graph(overrides = {}) {
  return {
    graphId: 'graph-1',
    status: 'running',
    nodes: [task('a', 1), task('b', 2), task('c', 1), task('d', 3)],
    dependencies: [{ runId: 'b', dependsOnRunId: 'a' }],
    layout: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    layoutRevision: 0,
    etag: 'etag-1',
    ...overrides
  }
}

describe('任务图画布适配器', () => {
  it('按 depth 分层并在层内按输入顺序生成默认布局', () => {
    const input = graph({
      nodes: [task('b', 2), task('a', 1), task('c', 1), task('d', 3)]
    })

    expect(defaultTaskGraphLayout(input)).toEqual({
      b: { x: 300, y: 0 },
      a: { x: 0, y: 0 },
      c: { x: 0, y: 170 },
      d: { x: 600, y: 0 }
    })
    expect(buildTaskGraphNodes(input).map((node) => node.position)).toEqual([
      { x: 300, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 170 },
      { x: 600, y: 0 }
    ])
  })

  it('节点优先使用有效持久布局，无效坐标回退到默认布局', () => {
    const input = graph({
      layout: {
        a: { x: 120, y: 80 },
        b: { x: Number.NaN, y: 20 },
        unknown: { x: 1, y: 2 }
      }
    })
    const nodes = buildTaskGraphNodes(input)

    expect(nodes.find((node) => node.id === 'a').position).toEqual({ x: 120, y: 80 })
    expect(nodes.find((node) => node.id === 'b').position).toEqual({ x: 300, y: 0 })
    expect(nodes.find((node) => node.id === 'c').position).toEqual({ x: 0, y: 170 })
    expect(nodes.find((node) => node.id === 'a')).toMatchObject({
      type: 'default',
      draggable: true,
      data: {
        label: '目标 a',
        goal: '目标 a',
        status: 'queued',
        editable: true,
        runId: 'a'
      }
    })
    expect(input.layout.a).toEqual({ x: 120, y: 80 })
  })

  it('只保留有效节点之间的依赖边并过滤自环和重复边', () => {
    const input = graph({
      dependencies: [
        { runId: 'b', dependsOnRunId: 'a' },
        { runId: 'b', dependsOnRunId: 'a' },
        { runId: 'b', dependsOnRunId: 'missing' },
        { runId: 'missing', dependsOnRunId: 'a' },
        { runId: 'a', dependsOnRunId: 'a' },
        { runId: 'd', dependsOnRunId: 'c' }
      ]
    })

    const edges = buildTaskGraphEdges(input)
    expect(edges).toHaveLength(2)
    expect(edges[0]).toMatchObject({
      source: 'a',
      target: 'b',
      type: 'smoothstep',
      reconnectable: false,
      data: { runId: 'b', dependsOnRunId: 'a', targetEditable: true }
    })
    expect(edges[1]).toMatchObject({ source: 'c', target: 'd' })
  })

  it('空图或缺失数组返回空画布数据', () => {
    expect(defaultTaskGraphLayout(null)).toEqual({})
    expect(buildTaskGraphNodes(null)).toEqual([])
    expect(buildTaskGraphEdges(null)).toEqual([])
    expect(inverseDependencyOps(null, [])).toEqual([])
  })
})

describe('依赖增删逆向操作', () => {
  it('connect 生成的 update op 可逆向为 disconnect', () => {
    const input = graph({
      dependencies: [
        { runId: 'b', dependsOnRunId: 'a' },
        { runId: 'b', dependsOnRunId: 'c' }
      ]
    })
    const connect = [{ action: 'update', runId: 'b', deps: ['a', 'c', 'd'] }]

    expect(inverseDependencyOps(input, connect)).toEqual([
      { action: 'update', runId: 'b', deps: ['a', 'c'] }
    ])
  })

  it('disconnect 生成的 update op 可逆向为 connect', () => {
    const input = graph({
      dependencies: [
        { runId: 'b', dependsOnRunId: 'a' },
        { runId: 'b', dependsOnRunId: 'c' }
      ]
    })
    const disconnect = [{ action: 'update', runId: 'b', deps: ['c'] }]

    expect(inverseDependencyOps(input, disconnect)).toEqual([
      { action: 'update', runId: 'b', deps: ['a', 'c'] }
    ])
  })

  it('多个依赖操作按逆序还原且保留无依赖 update 语义', () => {
    const input = graph()
    const ops = [
      { action: 'update', runId: 'b', deps: ['a', 'c'] },
      { action: 'update', runId: 'd', deps: ['b'] },
      { action: 'update', runId: 'b', deps: ['a'] }
    ]

    expect(inverseDependencyOps(input, ops)).toEqual([
      { action: 'update', runId: 'b', deps: ['a', 'c'] },
      { action: 'update', runId: 'd', deps: [] },
      { action: 'update', runId: 'b', deps: ['a'] }
    ])
    expect(input.dependencies).toEqual([{ runId: 'b', dependsOnRunId: 'a' }])
  })

  it('忽略非依赖 update 和空依赖变更', () => {
    const input = graph()
    expect(
      inverseDependencyOps(input, [
        { action: 'update', runId: 'b', goal: '新目标' },
        { action: 'update', runId: 'b', deps: ['a'] },
        { action: 'delete', runId: 'd' }
      ])
    ).toEqual([])
  })
})
