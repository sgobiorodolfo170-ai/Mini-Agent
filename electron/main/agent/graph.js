// 任务依赖图：校验 DAG、持久化节点边、失败级联与图状态汇总。
// 只做数据与纯逻辑，不直接启动 Run；调度器通过 run_dependencies 判断节点是否就绪。

const repos = require('../../store/repos')

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
       WHERE r.graph_id=?`
    )
    .all(graphId)
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
  if (!allTerminal) {
    if (graph.status !== 'running') {
      db.prepare('UPDATE run_graphs SET status=? WHERE id=?').run('running', graphId)
    }
    return getGraph(db, graphId)
  }
  const status = nodes.every((node) => node.status === 'done') ? 'done' : 'stopped'
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
  const nodes = listNodes(db, graphId).map((node) => ({
    runId: node.id,
    nodeKey: node.node_key,
    goal: node.goal,
    status: node.status,
    finishedReason: node.finished_reason
  }))
  return {
    graphId,
    status: graph.status,
    parentRunId: graph.parent_run_id,
    nodes,
    dependencies: listDependencies(db, graphId)
  }
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
  blockedDependents,
  refreshGraph,
  summary
}
