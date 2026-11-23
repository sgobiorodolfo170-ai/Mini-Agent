// 任务依赖图：校验 DAG、持久化节点边、失败级联与图状态汇总。
// 只做数据与纯逻辑，不直接启动 Run；调度器通过 run_dependencies 判断节点是否就绪。

const { createHash } = require('node:crypto')
const repos = require('../../store/repos')
const { recordRunState } = require('../../store/run-storage')

const MAX_NODES = 12
const MAX_DEPTH = 3
const MAX_CONCURRENCY = 4

function normalizeKey(value) {
  const key = String(value == null ? '' : value).trim()
  if (!key || key.length > 40) throw new Error('任务节点 key 必须为 1–40 个字符')
  return key
}

// 校验并规范化任务列表；返回 [{ key, goal, deps, conversationId, title }]
function validatePlan(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('任务列表不能为空')
  if (tasks.length > MAX_NODES) throw new Error(`首版最多支持 ${MAX_NODES} 个任务节点`)

  const seen = new Set()
  const normalized = tasks.map((task, index) => {
    if (!task || typeof task !== 'object') throw new Error(`第 ${index + 1} 个任务格式无效`)
    const key = normalizeKey(task.key)
    if (seen.has(key)) throw new Error(`任务节点 key 重复：${key}`)
    seen.add(key)
    const goal = String(task.goal == null ? '' : task.goal).trim()
    if (!goal) throw new Error(`任务节点 ${key} 缺少目标`)
    const deps = Array.isArray(task.deps) ? [...new Set(task.deps.map((x) => normalizeKey(x)))] : []
    if (deps.includes(key)) throw new Error(`任务节点 ${key} 不能依赖自身`)
    return {
      key,
      goal,
      deps,
      conversationId: task.conversationId ? String(task.conversationId) : null,
      title: task.title ? String(task.title).slice(0, 80) : null
    }
  })

  for (const task of normalized) {
    for (const dep of task.deps) {
      if (!seen.has(dep)) throw new Error(`任务节点 ${task.key} 依赖了不存在的节点：${dep}`)
    }
  }

  // Kahn 拓扑校验：能排空说明无环
  const indegree = new Map(normalized.map((t) => [t.key, t.deps.length]))
  const children = new Map(normalized.map((t) => [t.key, []]))
  for (const task of normalized) {
    for (const dep of task.deps) children.get(dep).push(task.key)
  }
  const ready = normalized.filter((t) => t.deps.length === 0).map((t) => t.key)
  const order = []
  while (ready.length) {
    const key = ready.shift()
    order.push(key)
    for (const child of children.get(key) || []) {
      const left = (indegree.get(child) || 0) - 1
      indegree.set(child, left)
      if (left === 0) ready.push(child)
    }
  }
  if (order.length !== normalized.length) throw new Error('任务依赖存在环，无法执行')
  const taskByKey = new Map(normalized.map((task) => [task.key, task]))
  const depthByKey = new Map()
  for (const key of order) {
    const deps = taskByKey.get(key).deps
    const depth = deps.length ? Math.max(...deps.map((dep) => depthByKey.get(dep))) + 1 : 1
    if (depth > MAX_DEPTH) throw new Error(`任务依赖深度不能超过 ${MAX_DEPTH} 层`)
    depthByKey.set(key, depth)
  }
  return normalized
}

function createGraph(db, { parentRunId, conversationId = null } = {}) {
  const id = repos.uid()
  db.prepare(
    `INSERT INTO run_graphs(id, parent_run_id, conversation_id, status, created_at)
     VALUES(?,?,?,'running',?)`
  ).run(id, parentRunId || null, conversationId || null, Date.now())
  return id
}

function addDependencies(db, tasks, keyToRunId) {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO run_dependencies(run_id, depends_on_run_id) VALUES(?,?)'
  )
  for (const task of tasks) {
    const runId = keyToRunId.get(task.key)
    for (const dep of task.deps || []) {
      const depId = keyToRunId.get(dep)
      if (runId && depId) stmt.run(runId, depId)
    }
  }
}

function getGraph(db, id) {
  return db.prepare('SELECT * FROM run_graphs WHERE id=?').get(id)
}

function getGraphForParent(db, parentRunId) {
  return db
    .prepare('SELECT * FROM run_graphs WHERE parent_run_id=? ORDER BY created_at DESC LIMIT 1')
    .get(parentRunId)
}

function listNodes(db, graphId) {
  return db.prepare('SELECT * FROM agent_runs WHERE graph_id=? ORDER BY rowid').all(graphId)
}

function listDependencies(db, graphId) {
  return db
    .prepare(
      `SELECT d.run_id AS runId, d.depends_on_run_id AS dependsOnRunId
       FROM run_dependencies d JOIN agent_runs r ON r.id=d.run_id
       WHERE r.graph_id=? ORDER BY d.run_id,d.depends_on_run_id`
    )
    .all(graphId)
}

function listDirectDependencies(db, runId) {
  return db
    .prepare(
      `SELECT r.* FROM run_dependencies d
       JOIN agent_runs r ON r.id=d.depends_on_run_id
       WHERE d.run_id=? ORDER BY r.rowid`
    )
    .all(runId)
}

// 失败节点的所有下游（传递闭包），只返回仍未终态的 queued 节点。
function blockedDependents(db, failedRunId) {
  return db
    .prepare(
      `WITH RECURSIVE downstream(id) AS (
         SELECT run_id FROM run_dependencies WHERE depends_on_run_id=?
         UNION
         SELECT d.run_id FROM run_dependencies d JOIN downstream x ON d.depends_on_run_id=x.id
       )
       SELECT r.id FROM downstream JOIN agent_runs r ON r.id=downstream.id
       WHERE r.status='queued'`
    )
    .all(failedRunId)
    .map((row) => row.id)
}

function refreshGraph(db, graphId) {
  const graph = getGraph(db, graphId)
  if (!graph) return null
  const nodes = listNodes(db, graphId)
  if (!nodes.length) return graph
  const allTerminal = nodes.every((node) => repos.isRunTerminal(node.status))
  const acceptancePending = nodes.some(
    (node) =>
      node.status === 'done' &&
      node.acceptance_policy &&
      !['accepted', 'rejected'].includes(node.acceptance_status)
  )
  if (!allTerminal || acceptancePending) {
    if (graph.status !== 'running') {
      db.prepare('UPDATE run_graphs SET status=?, finished_at=NULL WHERE id=?').run(
        'running',
        graphId
      )
    }
    return getGraph(db, graphId)
  }
  const status = nodes.every(
    (node) =>
      node.status === 'done' && (!node.acceptance_policy || node.acceptance_status === 'accepted')
  )
    ? 'done'
    : 'stopped'
  db.prepare('UPDATE run_graphs SET status=?, finished_at=? WHERE id=?').run(
    status,
    Date.now(),
    graphId
  )
  return getGraph(db, graphId)
}

function summary(db, graphId) {
  const graph = getGraph(db, graphId)
  if (!graph) return null
  const rawNodes = listNodes(db, graphId)
  const dependencies = listDependencies(db, graphId)
  if (!rawNodes.length) {
    return {
      graphId,
      status: graph.status,
      parentRunId: graph.parent_run_id,
      nodes: [],
      dependencies: [],
      layers: [],
      etag: createHash('sha1')
        .update(JSON.stringify({ status: graph.status }))
        .digest('hex')
    }
  }
  const depsByRun = new Map(rawNodes.map((node) => [node.id, []]))
  const keyByRun = new Map(rawNodes.map((node) => [node.id, node.node_key]))
  for (const edge of dependencies) {
    if (!depsByRun.has(edge.runId)) continue
    depsByRun.get(edge.runId).push(keyByRun.get(edge.dependsOnRunId))
  }
  const normalized = validatePlan(
    rawNodes.map((node) => ({
      key: node.node_key,
      goal: node.goal,
      deps: depsByRun.get(node.id)
    }))
  )
  const taskByKey = new Map(normalized.map((task) => [task.key, task]))
  const depthByKey = new Map()
  const depthOf = (key, visiting = new Set()) => {
    if (depthByKey.has(key)) return depthByKey.get(key)
    if (visiting.has(key)) throw new Error('任务依赖存在环，无法执行')
    visiting.add(key)
    const deps = taskByKey.get(key).deps
    const depth = deps.length ? Math.max(...deps.map((dep) => depthOf(dep, visiting))) + 1 : 1
    visiting.delete(key)
    depthByKey.set(key, depth)
    return depth
  }
  const nodes = rawNodes.map((node) => ({
    runId: node.id,
    nodeKey: node.node_key,
    goal: node.goal,
    status: node.status,
    finishedReason: node.finished_reason,
    depth: depthOf(node.node_key),
    editable: node.status === 'queued'
  }))
  const layers = []
  for (const node of nodes) {
    while (layers.length < node.depth) layers.push([])
    layers[node.depth - 1].push(node)
  }
  const etag = createHash('sha1')
    .update(
      JSON.stringify({
        status: graph.status,
        nodes: nodes.map(({ runId, nodeKey, goal, status }) => ({
          runId,
          nodeKey,
          goal,
          status
        })),
        dependencies
      })
    )
    .digest('hex')
  return {
    graphId,
    status: graph.status,
    parentRunId: graph.parent_run_id,
    nodes,
    dependencies,
    layers,
    etag
  }
}

function mutateGraph(db, { graphId, etag, ops = [], isClaimed = () => false } = {}) {
  const current = summary(db, graphId)
  if (!current) throw new Error('任务图不存在')
  if (etag !== current.etag) {
    const error = new Error('任务图已变化，请刷新后重试')
    error.code = 'GRAPH_CONFLICT'
    throw error
  }
  if (current.status !== 'running') throw new Error('仅运行中的任务图可以重规划')
  const parent = repos.getRun(db, current.parentRunId)
  if (!parent || !['running', 'waiting_child'].includes(parent.status))
    throw new Error('父任务当前不可重规划')
  const parentConversation = repos.getConversation(db, parent.conversationId)
  if (!parentConversation) throw new Error('父任务会话不存在')

  const nodes = new Map(current.nodes.map((node) => [node.runId, { ...node }]))
  const dependencies = new Map(
    current.nodes.map((node) => [
      node.runId,
      current.dependencies
        .filter((edge) => edge.runId === node.runId)
        .map((edge) => edge.dependsOnRunId)
    ])
  )
  const removed = new Set()
  for (const op of ops) {
    const node = nodes.get(op.runId)
    if (!node || removed.has(op.runId)) throw new Error('任务节点不存在')
    if (node.status !== 'queued' || isClaimed(op.runId))
      throw new Error('只有尚未启动的排队节点可以修改')
    const conversation = repos.getConversation(db, repos.getRun(db, op.runId).conversationId)
    if (
      !conversation ||
      conversation.parentId !== parentConversation.id ||
      conversation.projectId !== parentConversation.projectId
    )
      throw new Error('任务节点归属已变化')
    if (op.action === 'update') {
      if (op.goal !== undefined) {
        const goal = String(op.goal || '').trim()
        if (!goal) throw new Error('任务目标不能为空')
        node.goal = goal
        const run = repos.getRun(db, op.runId)
        db.prepare('UPDATE agent_runs SET goal=? WHERE id=?').run(goal, op.runId)
        if (run.userMessageId)
          repos.updateMessage(db, run.userMessageId, { content: goal, status: 'done' })
      }
      if (op.deps !== undefined) {
        if (!Array.isArray(op.deps)) throw new Error('任务依赖格式无效')
        const deps = [...new Set(op.deps.map((id) => String(id)))]
        if (deps.includes(op.runId)) throw new Error('任务节点不能依赖自身')
        if (deps.some((id) => !nodes.has(id) || removed.has(id)))
          throw new Error('任务依赖了不存在的节点')
        dependencies.set(op.runId, deps)
      }
    } else if (op.action === 'delete') {
      if (nodes.size <= 1) throw new Error('任务图至少需要保留一个节点')
      removed.add(op.runId)
      nodes.delete(op.runId)
      dependencies.delete(op.runId)
      for (const deps of dependencies.values()) {
        const index = deps.indexOf(op.runId)
        if (index >= 0) deps.splice(index, 1)
      }
    } else {
      throw new Error('不支持的任务图操作')
    }
  }

  const keyByRun = new Map([...nodes].map(([runId, node]) => [runId, node.nodeKey]))
  validatePlan(
    [...nodes.values()].map((node) => ({
      key: node.nodeKey,
      goal: node.goal,
      deps: dependencies.get(node.runId).map((runId) => keyByRun.get(runId))
    }))
  )
  for (const runId of removed) {
    repos.updateRunStatus(db, runId, { status: 'stopped' })
    db.prepare(
      `UPDATE agent_runs SET graph_id=NULL,node_key=NULL,finished_reason='removed_from_graph',ended_at=? WHERE id=?`
    ).run(Date.now(), runId)
    recordRunState(db, runId)
    db.prepare('DELETE FROM run_dependencies WHERE run_id=? OR depends_on_run_id=?').run(
      runId,
      runId
    )
    const run = repos.getRun(db, runId)
    for (const messageId of [run.userMessageId, run.assistantMessageId]) {
      if (!messageId) continue
      repos.updateMessage(db, messageId, { content: '节点已从任务图删除。', status: 'stopped' })
    }
  }
  for (const [runId, deps] of dependencies) {
    db.prepare('DELETE FROM run_dependencies WHERE run_id=?').run(runId)
    for (const dependencyRunId of deps)
      db.prepare(
        'INSERT OR IGNORE INTO run_dependencies(run_id,depends_on_run_id) VALUES(?,?)'
      ).run(runId, dependencyRunId)
  }
  refreshGraph(db, graphId)
  return summary(db, graphId)
}

module.exports = {
  MAX_NODES,
  MAX_DEPTH,
  MAX_CONCURRENCY,
  validatePlan,
  createGraph,
  addDependencies,
  getGraph,
  getGraphForParent,
  listNodes,
  listDependencies,
  listDirectDependencies,
  blockedDependents,
  refreshGraph,
  summary,
  mutateGraph
}
