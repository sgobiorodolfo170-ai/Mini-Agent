// Task graph adapters shared by the canvas and its tests. No Vue or DOM dependencies.

const NODE_WIDTH = 240
const LAYER_GAP = 300
const ROW_GAP = 170
const STATUS_LABELS = {
  queued: '排队',
  running: '运行中',
  waiting_child: '等待子任务',
  done: '完成',
  error: '失败',
  stopped: '停止'
}

function graphNodes(graph) {
  if (!Array.isArray(graph?.nodes)) return []

  const seen = new Set()
  return graph.nodes.filter((node) => {
    if (!node || node.runId == null) return false
    const runId = String(node.runId)
    if (!runId || seen.has(runId)) return false
    seen.add(runId)
    return true
  })
}

function validPosition(position) {
  return (
    position &&
    typeof position === 'object' &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y)
  )
}

function layerOf(node) {
  const depth = Number(node.depth)
  return Number.isFinite(depth) ? Math.max(0, Math.floor(depth) - 1) : 0
}

/**
 * Compute a deterministic layered layout without mutating the graph.
 * Persisted positions are intentionally handled by buildTaskGraphNodes.
 */
export function defaultTaskGraphLayout(graph) {
  const layout = {}
  const layerCounts = new Map()

  for (const node of graphNodes(graph)) {
    const runId = String(node.runId)
    const layer = layerOf(node)
    const index = layerCounts.get(layer) || 0
    layerCounts.set(layer, index + 1)
    layout[runId] = {
      x: layer * LAYER_GAP,
      y: index * ROW_GAP
    }
  }

  return layout
}

/** Build Vue Flow default nodes, preferring a valid persisted position per runId. */
export function buildTaskGraphNodes(graph) {
  const fallbackLayout = defaultTaskGraphLayout(graph)
  const persistedLayout =
    graph?.layout && typeof graph.layout === 'object' && !Array.isArray(graph.layout)
      ? graph.layout
      : {}

  return graphNodes(graph).map((node) => {
    const runId = String(node.runId)
    const persistedPosition = persistedLayout[runId]
    const position = validPosition(persistedPosition)
      ? { x: persistedPosition.x, y: persistedPosition.y }
      : { ...fallbackLayout[runId] }
    const goal = String(node.goal || '').trim()
    const nodeKey = String(node.nodeKey || '').trim()

    return {
      id: runId,
      type: 'default',
      position,
      width: NODE_WIDTH,
      sourcePosition: 'right',
      targetPosition: 'left',
      // Deletion permission is enforced by the editor's delete guards so that
      // rejected keyboard operations can still surface an error to the user.
      draggable: true,
      connectable: true,
      deletable: true,
      class: `task-graph-node--${String(node.status || 'unknown')}`,
      data: {
        label: goal || nodeKey || runId,
        ariaLabel: `${nodeKey || runId}，${STATUS_LABELS[node.status] || node.status || '未知'}，${goal || '未填写目标'}`,
        goal,
        nodeKey,
        status: node.status || 'unknown',
        depth: node.depth,
        editable: node.editable === true,
        runId,
        task: { ...node, runId }
      }
    }
  })
}

/** Build dependency → dependent edges, dropping invalid, self and duplicate edges. */
export function buildTaskGraphEdges(graph) {
  const nodes = graphNodes(graph)
  const validIds = new Set(nodes.map((node) => String(node.runId)))
  const nodeById = new Map(nodes.map((node) => [String(node.runId), node]))
  const dependencies = Array.isArray(graph?.dependencies) ? graph.dependencies : []
  const seen = new Set()
  const edges = []

  for (const dependency of dependencies) {
    if (!dependency) continue
    const source = String(dependency.dependsOnRunId ?? '')
    const target = String(dependency.runId ?? '')
    if (!validIds.has(source) || !validIds.has(target) || source === target) continue

    const key = JSON.stringify([source, target])
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({
      id: `task-graph-edge-${key}`,
      source,
      target,
      type: 'smoothstep',
      reconnectable: false,
      deletable: true,
      data: {
        runId: target,
        dependsOnRunId: source,
        targetEditable: nodeById.get(target)?.editable === true
      }
    })
  }

  return edges
}

function dependencyMap(graph) {
  const validIds = new Set(graphNodes(graph).map((node) => String(node.runId)))
  const dependencies = Array.isArray(graph?.dependencies) ? graph.dependencies : []
  const result = new Map([...validIds].map((runId) => [runId, []]))

  for (const dependency of dependencies) {
    const runId = String(dependency?.runId ?? '')
    const dependsOnRunId = String(dependency?.dependsOnRunId ?? '')
    if (!validIds.has(runId) || !validIds.has(dependsOnRunId) || runId === dependsOnRunId) {
      continue
    }
    const deps = result.get(runId)
    if (!deps.includes(dependsOnRunId)) deps.push(dependsOnRunId)
  }

  return result
}

function sameDependencies(left, right) {
  return left.length === right.length && left.every((runId, index) => runId === right[index])
}

/**
 * Return update ops that undo dependency edits, in reverse application order.
 * Only dependency-bearing update ops participate; layout and goal edits are not
 * part of this local history. The input graph is the state before `ops`.
 */
export function inverseDependencyOps(graph, ops) {
  if (!Array.isArray(ops) || ops.length === 0) return []

  const dependencies = dependencyMap(graph)
  const transitions = []

  // First replay the forward edits so each transition knows both its before
  // and after state. Reversing from the original graph alone is insufficient
  // when multiple ops target the same runId.
  for (const op of ops) {
    if (op?.action !== 'update' || !Array.isArray(op.deps)) continue
    const runId = String(op.runId)
    if (!dependencies.has(runId)) continue

    const previous = [...dependencies.get(runId)]
    const next = []
    for (const value of op.deps) {
      const dependencyRunId = String(value)
      if (
        dependencies.has(dependencyRunId) &&
        dependencyRunId !== runId &&
        !next.includes(dependencyRunId)
      ) {
        next.push(dependencyRunId)
      }
    }

    transitions.push({ runId, previous, next })
    dependencies.set(runId, next)
  }

  const inverse = []
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const { runId, previous, next } = transitions[index]
    if (!sameDependencies(previous, next)) {
      inverse.push({ action: 'update', runId, deps: [...previous] })
    }
  }
  return inverse
}
