<script setup>
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { Background, Controls, Handle, MiniMap, Panel, Position, VueFlow } from '@xyflow/vue'
import '@xyflow/vue/style.css'
import { buildTaskGraphEdges, buildTaskGraphNodes } from '../../common/task-graph'
import { useAgentStore } from '../../stores/agent'
import { useUiStore } from '../../stores/ui'

const props = defineProps({
  graph: { type: Object, default: null },
  busy: { type: Boolean, default: false }
})

const emit = defineEmits(['edit-node', 'error'])

const agent = useAgentStore()
const ui = useUiStore()

const SAVE_DELAY = 300
const HISTORY_LIMIT = 50
const nodes = shallowRef([])
const edges = shallowRef([])
const viewport = shallowRef({ x: 0, y: 0, zoom: 1 })
const localGraph = shallowRef(null)
const flowInstance = shallowRef(null)
const errorMessage = ref('')
const undoDepth = ref(0)
const redoDepth = ref(0)
const pendingMutations = ref(0)
const undoStack = []
const redoStack = []
const showAddNode = ref(false)
const newNodeKey = ref('')
const newNodeGoal = ref('')
const newNodeDeps = ref([])
const newNodeClientId = ref('')

let pendingDeletion = null
let mutationTail = Promise.resolve()
let propsDirty = false
let saveTimer = null
let errorTimer = null
let layoutTail = Promise.resolve()
let layoutPending = 0
let layoutDirty = false
let layoutVersion = 0
let layoutEpoch = 0
let savedLayout = {}
let savedViewport = normalizeViewport(null)
let lastEtag = null
let lastLayoutRevision = 0
let disposed = false

const canEdit = computed(
  () => !props.busy && localGraph.value?.status === 'running' && !!localGraph.value?.graphId
)
const mutationBusy = computed(() => pendingMutations.value > 0)
const canAddNode = computed(() => canEdit.value && !mutationBusy.value && nodes.value.length < 12)

const statusLabels = {
  queued: '排队',
  running: '运行中',
  waiting_child: '等待子任务',
  done: '完成',
  error: '失败',
  stopped: '停止'
}

function normalizeViewport(value) {
  const finite = (input, fallback, min, max) => {
    const number = Number(input)
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
  }
  return {
    x: finite(value?.x, 0, -100000, 100000),
    y: finite(value?.y, 0, -100000, 100000),
    zoom: finite(value?.zoom, 1, 0.2, 2)
  }
}

function cloneLayout(layout) {
  const result = {}
  if (layout && typeof layout === 'object') {
    for (const [runId, position] of Object.entries(layout)) {
      if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        result[runId] = { x: position.x, y: position.y }
      }
    }
  }
  return result
}

function cloneGraph(graph) {
  if (!graph) return null
  return {
    ...graph,
    nodes: Array.isArray(graph.nodes) ? graph.nodes.map((node) => ({ ...node })) : [],
    dependencies: Array.isArray(graph.dependencies)
      ? graph.dependencies.map((dependency) => ({ ...dependency }))
      : [],
    layout: cloneLayout(graph.layout),
    viewport: normalizeViewport(graph.viewport)
  }
}

function dependencyMap(graph) {
  const result = new Map()
  for (const node of graph?.nodes || []) {
    if (node?.runId != null) result.set(String(node.runId), [])
  }
  for (const dependency of graph?.dependencies || []) {
    const runId = String(dependency?.runId ?? '')
    const dependsOnRunId = String(dependency?.dependsOnRunId ?? '')
    if (!result.has(runId) || !result.has(dependsOnRunId) || runId === dependsOnRunId) continue
    const deps = result.get(runId)
    if (!deps.includes(dependsOnRunId)) deps.push(dependsOnRunId)
  }
  return result
}

function dependencySnapshot(graph) {
  const snapshot = {}
  for (const [runId, deps] of dependencyMap(graph)) snapshot[runId] = [...deps].sort()
  return snapshot
}

function sameDependencySnapshot(left, right) {
  const leftIds = Object.keys(left || {})
  const rightIds = Object.keys(right || {})
  return (
    leftIds.length === rightIds.length &&
    leftIds.every(
      (runId) =>
        Object.hasOwn(right || {}, runId) &&
        left[runId].length === right[runId].length &&
        left[runId].every((dependencyRunId, index) => dependencyRunId === right[runId][index])
    )
  )
}

function dependencyOpsBetween(before, after) {
  const ops = []
  for (const runId of Object.keys(after)) {
    if (!Object.hasOwn(before, runId)) continue
    if (sameDependencySnapshot({ [runId]: before[runId] }, { [runId]: after[runId] })) continue
    ops.push({ action: 'update', runId, deps: [...after[runId]] })
  }
  return ops
}

function graphFromDependencies(graph, dependencies) {
  const next = []
  for (const node of graph.nodes) {
    const runId = String(node.runId)
    for (const dependsOnRunId of dependencies.get(runId) || []) {
      next.push({ runId, dependsOnRunId })
    }
  }
  return { ...graph, dependencies: next }
}

function applyDependencyOps(graph, ops) {
  const dependencies = dependencyMap(graph)
  for (const op of ops) {
    if (op?.action !== 'update' || !Array.isArray(op.deps) || !dependencies.has(op.runId)) {
      continue
    }
    const runId = String(op.runId)
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
    dependencies.set(runId, next)
  }
  return graphFromDependencies(graph, dependencies)
}

function depsFor(graph, runId) {
  return [...(dependencyMap(graph).get(String(runId)) || [])]
}

function makeDependencyOp(graph, change) {
  const runId = String(change.target)
  const dependsOnRunId = String(change.source)
  const deps = depsFor(graph, runId)
  const next = change.present
    ? deps.includes(dependsOnRunId)
      ? deps
      : [...deps, dependsOnRunId]
    : deps.filter((value) => value !== dependsOnRunId)
  return { action: 'update', runId, deps: next }
}

function nodeById(graph, runId) {
  return graph?.nodes?.find((node) => String(node.runId) === String(runId))
}

function hasDependency(graph, source, target) {
  return depsFor(graph, target).includes(String(source))
}

function createsCycle(graph, source, target) {
  const adjacency = new Map()
  for (const node of graph.nodes) adjacency.set(String(node.runId), [])
  for (const dependency of graph.dependencies) {
    const from = String(dependency.dependsOnRunId)
    const to = String(dependency.runId)
    if (adjacency.has(from) && adjacency.has(to)) adjacency.get(from).push(to)
  }

  const queue = [String(target)]
  const visited = new Set()
  while (queue.length) {
    const current = queue.shift()
    if (current === String(source)) return true
    if (visited.has(current)) continue
    visited.add(current)
    queue.push(...(adjacency.get(current) || []))
  }
  return false
}

function graphDepthError(graph) {
  const dependencies = dependencyMap(graph)
  const depths = new Map()
  const visiting = new Set()

  const depthOf = (runId) => {
    if (depths.has(runId)) return depths.get(runId)
    if (visiting.has(runId)) return '任务依赖存在环，无法执行'
    visiting.add(runId)
    const deps = dependencies.get(runId) || []
    let depth = 1
    for (const dependencyRunId of deps) {
      const dependencyDepth = depthOf(dependencyRunId)
      if (typeof dependencyDepth === 'string') return dependencyDepth
      depth = Math.max(depth, dependencyDepth + 1)
    }
    visiting.delete(runId)
    depths.set(runId, depth)
    return depth
  }

  for (const runId of dependencies.keys()) {
    const depth = depthOf(runId)
    if (typeof depth === 'string') return depth
    if (depth > 3) return '任务依赖深度不能超过 3 层'
  }
  return ''
}

function editBlockedMessage() {
  return props.busy ? '任务图正在更新，请稍后重试' : '仅运行中的任务图可以修改'
}

function validateChange(graph, change) {
  if (!canEdit.value) return editBlockedMessage()
  const source = String(change.source)
  const target = String(change.target)
  if (!nodeById(graph, source) || !nodeById(graph, target)) return '依赖连接包含不存在的任务节点'
  if (source === target) return '任务节点不能依赖自身'
  if (nodeById(graph, target)?.editable !== true) return '只有可编辑的排队目标节点可以修改依赖'
  const exists = hasDependency(graph, source, target)
  if (change.present && exists) return '依赖已存在，不能重复连接'
  if (!change.present && !exists) return '依赖不存在，无法断开'
  if (change.present && createsCycle(graph, source, target)) return '该连接会形成循环依赖'
  return ''
}

function buildDependencyChanges(graph, changes) {
  let working = cloneGraph(graph)
  const ops = []
  for (const change of changes) {
    const error = validateChange(working, change)
    if (error) return { error }
    const op = makeDependencyOp(working, change)
    ops.push(op)
    working = applyDependencyOps(working, [op])
  }
  const depthError = graphDepthError(working)
  return depthError ? { error: depthError } : { ops, graph: working }
}

function syncHistoryDepth() {
  undoDepth.value = undoStack.length
  redoDepth.value = redoStack.length
}

function clearHistory() {
  undoStack.length = 0
  redoStack.length = 0
  syncHistoryDepth()
}

function currentHistorySnapshot() {
  return undoStack.at(-1)?.after || redoStack.at(-1)?.before || null
}

function graphMatchesHistory(graph) {
  const expected = currentHistorySnapshot()
  return !!expected && sameDependencySnapshot(dependencySnapshot(graph), expected)
}

function recordDependencyHistory(before, after) {
  if (sameDependencySnapshot(before, after)) return
  undoStack.push({ before, after })
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
  redoStack.length = 0
  syncHistoryDepth()
}

function syncFlow() {
  nodes.value = buildTaskGraphNodes(localGraph.value)
  edges.value = buildTaskGraphEdges(localGraph.value)
}

function reportError(message) {
  const text = String(message || '任务图操作失败')
  if (errorMessage.value === text) return
  errorMessage.value = text
  emit('error', text)
  clearTimeout(errorTimer)
  errorTimer = setTimeout(() => {
    errorMessage.value = ''
  }, 4000)
}

function rememberPersistedLayout(graph) {
  savedLayout = cloneLayout(graph?.layout)
  savedViewport = normalizeViewport(graph?.viewport)
  layoutDirty = false
}

function rebuildFromProps(force = false) {
  const graph = cloneGraph(props.graph)
  if (!force && pendingMutations.value > 0) {
    propsDirty = true
    return
  }

  const previous = localGraph.value
  const sameGraph = !!graph && !!previous && graph.graphId === previous.graphId

  if (!sameGraph) {
    clearHistory()
    clearTimeout(saveTimer)
    saveTimer = null
    layoutEpoch += 1
    layoutVersion += 1
    pendingDeletion = null
    localGraph.value = graph
    viewport.value = normalizeViewport(graph?.viewport)
    rememberPersistedLayout(graph)
  } else {
    const semanticChanged = graph.etag !== lastEtag
    const layoutRevision = Number(graph?.layoutRevision) || 0
    const layoutChanged = layoutRevision !== lastLayoutRevision
    if (!force && !semanticChanged && !layoutChanged) {
      propsDirty = false
      return
    }

    if (semanticChanged && !graphMatchesHistory(graph)) clearHistory()
    const preserveLayout = !force && (layoutDirty || layoutPending > 0)
    if (preserveLayout) {
      graph.layout = cloneLayout(previous.layout)
      graph.viewport = normalizeViewport(previous.viewport)
    }

    if (force) {
      clearTimeout(saveTimer)
      saveTimer = null
      layoutEpoch += 1
      layoutVersion += 1
      pendingDeletion = null
    }

    localGraph.value = graph
    const acceptLayout = force || !preserveLayout
    if (acceptLayout) {
      rememberPersistedLayout(graph)
      if (!sameViewport(viewport.value, graph.viewport)) viewport.value = graph.viewport
    }
    if (force || semanticChanged || (layoutChanged && acceptLayout)) syncFlow()
  }

  lastEtag = graph?.etag ?? null
  lastLayoutRevision = Number(graph?.layoutRevision) || 0
  propsDirty = false
  if (!sameGraph) syncFlow()
}

watch(
  () => props.graph,
  () => rebuildFromProps(),
  { immediate: true, deep: true }
)

function assertMutable() {
  if (!canEdit.value) throw new Error(editBlockedMessage())
}

function handleMutationFailure(error) {
  const message = String(error?.message || error || '任务图保存失败')
  ui.toast(message, 'error')
  reportError(message)
  rebuildFromProps(true)
}

function enqueueMutation(task) {
  if (!canEdit.value) {
    reportError(editBlockedMessage())
    return Promise.resolve(false)
  }

  pendingMutations.value += 1
  const run = async () => {
    try {
      return await task()
    } catch (error) {
      handleMutationFailure(error)
      return false
    } finally {
      pendingMutations.value -= 1
      if (pendingMutations.value === 0 && propsDirty) rebuildFromProps()
    }
  }
  const result = mutationTail.then(run, run)
  mutationTail = result.catch(() => {})
  return result
}

function adoptServerGraph(graph) {
  const next = cloneGraph(graph)
  if (!next?.graphId) throw new Error('任务图保存结果无效')
  const previous = localGraph.value
  const preserveLayout = previous?.graphId === next.graphId && (layoutDirty || layoutPending > 0)

  if (preserveLayout) {
    next.layout = cloneLayout(previous.layout)
    next.viewport = normalizeViewport(previous.viewport)
  } else {
    rememberPersistedLayout(next)
  }

  localGraph.value = next
  lastEtag = next.etag ?? null
  lastLayoutRevision = Number(next.layoutRevision) || 0
  syncFlow()
  return next
}

async function mutateGraphOps(ops) {
  assertMutable()
  const graph = localGraph.value
  const result = await agent.mutateGraph({
    graphId: graph.graphId,
    etag: graph.etag,
    ops
  })
  return adoptServerGraph(result)
}

function commitDependencyChanges(changes) {
  if (!changes.length) return Promise.resolve(true)
  if (!canEdit.value) {
    reportError(editBlockedMessage())
    return Promise.resolve(false)
  }

  return enqueueMutation(async () => {
    const before = dependencySnapshot(localGraph.value)
    const result = buildDependencyChanges(localGraph.value, changes)
    if (result.error) throw new Error(result.error)
    const serverGraph = await mutateGraphOps(result.ops)
    recordDependencyHistory(before, dependencySnapshot(serverGraph))
    return true
  })
}

function onConnect(connection) {
  void commitDependencyChanges([
    { source: String(connection.source), target: String(connection.target), present: true }
  ])
}

function openAddNode() {
  if (!canAddNode.value) {
    reportError(nodes.value.length >= 12 ? '任务图最多支持 12 个节点' : editBlockedMessage())
    return
  }
  newNodeKey.value = ''
  newNodeGoal.value = ''
  newNodeDeps.value = []
  newNodeClientId.value = crypto.randomUUID()
  showAddNode.value = true
}

function closeAddNode() {
  showAddNode.value = false
}

function addNode() {
  if (!canAddNode.value) {
    reportError(editBlockedMessage())
    return Promise.resolve(false)
  }
  const key = newNodeKey.value.trim()
  const goal = newNodeGoal.value.trim()
  if (!key || !goal) {
    reportError('请填写节点 key 和目标')
    return Promise.resolve(false)
  }
  if (localGraph.value.nodes.some((node) => node.nodeKey === key)) {
    reportError(`任务节点 key 重复：${key}`)
    return Promise.resolve(false)
  }
  const maxX = nodes.value.reduce((max, node) => Math.max(max, node.position?.x || 0), 0)
  return enqueueMutation(async () => {
    await mutateGraphOps([
      {
        action: 'add',
        clientId: newNodeClientId.value,
        key,
        goal,
        deps: [...newNodeDeps.value],
        position: { x: maxX + 300, y: 0 }
      }
    ])
    showAddNode.value = false
    return true
  })
}

function editableTask(task) {
  return !!task && task.editable === true && canEdit.value
}

function onBeforeDelete({ nodes: deletedNodes, edges: deletedEdges }) {
  if (!canEdit.value) {
    pendingDeletion = null
    reportError(editBlockedMessage())
    return { nodes: [], edges: [] }
  }

  const allowedNodes = deletedNodes.filter(
    (node) => nodeById(localGraph.value, node.id)?.editable === true
  )
  const allowedNodeIds = new Set(allowedNodes.map((node) => String(node.id)))
  const rejectedNodeIds = new Set(
    deletedNodes
      .filter((node) => !allowedNodeIds.has(String(node.id)))
      .map((node) => String(node.id))
  )
  pendingDeletion = { nodeIds: allowedNodeIds, edgeChanges: [] }

  const allowedEdges = deletedEdges.filter((edge) => {
    if (allowedNodeIds.has(String(edge.source)) || allowedNodeIds.has(String(edge.target))) {
      return true
    }
    if (rejectedNodeIds.has(String(edge.source)) || rejectedNodeIds.has(String(edge.target))) {
      return false
    }
    return nodeById(localGraph.value, edge.target)?.editable === true
  })

  if (allowedNodes.length !== deletedNodes.length) reportError('运行中或已完成的任务节点不能删除')
  else if (allowedEdges.length !== deletedEdges.length)
    reportError('只有可编辑的排队目标节点可以删除依赖')
  return { nodes: allowedNodes, edges: allowedEdges }
}

function onEdgesDelete(deletedEdges) {
  if (!deletedEdges?.length) return
  const batch = pendingDeletion
  const changes = []
  for (const edge of deletedEdges) {
    if (batch?.nodeIds.has(String(edge.source)) || batch?.nodeIds.has(String(edge.target))) {
      continue
    }
    changes.push({ source: String(edge.source), target: String(edge.target), present: false })
  }

  if (batch?.nodeIds.size) {
    batch.edgeChanges.push(...changes)
    return
  }
  pendingDeletion = null
  void commitDependencyChanges(changes)
}

async function deleteTasks(tasks, edgeChanges = []) {
  const uniqueTasks = [...new Map(tasks.map((task) => [String(task.runId), task])).values()]
  if (!uniqueTasks.length) {
    if (edgeChanges.length) return commitDependencyChanges(edgeChanges)
    return false
  }
  if (!canEdit.value) {
    reportError(editBlockedMessage())
    rebuildFromProps(true)
    return false
  }

  const currentTasks = uniqueTasks.map((task) => nodeById(localGraph.value, task.runId))
  if (currentTasks.some((task) => !task || task.editable !== true)) {
    reportError('运行中或已完成的任务节点不能删除')
    rebuildFromProps(true)
    return false
  }

  let confirmed = false
  try {
    confirmed = await ui.confirm({
      title: '删除排队节点',
      message:
        currentTasks.length > 1
          ? `确定删除选中的 ${currentTasks.length} 个排队节点吗？`
          : `删除节点「${currentTasks[0].nodeKey}」？`,
      impact: '节点会停止并从任务图移除，其他节点对它的依赖会同时清除。',
      confirmText: '删除节点'
    })
  } catch (error) {
    reportError(error?.message || error)
    rebuildFromProps(true)
    return false
  }

  if (!confirmed) {
    rebuildFromProps(true)
    return false
  }
  if (!canEdit.value) {
    reportError(editBlockedMessage())
    rebuildFromProps(true)
    return false
  }

  return enqueueMutation(async () => {
    assertMutable()
    const deleteIds = uniqueTasks.map((task) => String(task.runId))
    const deleteSet = new Set(deleteIds)
    const deletableTasks = deleteIds.map((runId) => nodeById(localGraph.value, runId))
    if (deletableTasks.some((task) => !task || task.editable !== true)) {
      throw new Error('运行中或已完成的任务节点不能删除')
    }

    const dependencyResult = edgeChanges.length
      ? buildDependencyChanges(localGraph.value, edgeChanges)
      : { ops: [] }
    if (dependencyResult.error) throw new Error(dependencyResult.error)
    if (dependencyResult.ops.some((op) => deleteSet.has(String(op.runId)))) {
      throw new Error('待删除节点不能同时修改依赖')
    }

    const ops = [
      ...dependencyResult.ops,
      ...deletableTasks.map((task) => ({ action: 'delete', runId: String(task.runId) }))
    ]
    await mutateGraphOps(ops)
    clearHistory()
    return true
  })
}

function onNodesDelete(deletedNodes) {
  if (!deletedNodes?.length) return
  const batch = pendingDeletion
  pendingDeletion = null
  const tasks = deletedNodes.map(
    (node) => nodeById(localGraph.value, node.id) || { runId: String(node.id) }
  )
  void deleteTasks(tasks, batch?.edgeChanges || [])
}

function applyPassiveChanges(changes, current, allowedTypes) {
  const next = [...current]
  const indexById = new Map(next.map((item, index) => [item.id, index]))
  for (const change of changes) {
    if (!allowedTypes.includes(change.type)) {
      if (change.type !== 'remove') reportError('画布不支持直接新增、替换或改写任务语义')
      continue
    }
    const index = indexById.get(change.id)
    if (index == null) continue
    const item = next[index]
    if (change.type === 'position') {
      item.position = { ...change.position }
      if (change.positionAbsolute) item.positionAbsolute = { ...change.positionAbsolute }
    } else if (change.type === 'select') {
      item.selected = change.selected
    } else if (change.type === 'dimensions') {
      item.measured = change.measured
      if (change.width != null) item.width = change.width
      if (change.height != null) item.height = change.height
    }
  }
  return next
}

function layoutFromNodes() {
  const layout = {}
  for (const node of nodes.value) {
    if (node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)) {
      layout[node.id] = { x: node.position.x, y: node.position.y }
    }
  }
  return layout
}

function updateLayoutFromNodes() {
  if (!localGraph.value) return
  localGraph.value = { ...localGraph.value, layout: layoutFromNodes() }
}

function onNodesChange(changes) {
  const list = Array.from(changes)
  const hasPositionChange = list.some((change) => change.type === 'position' && !change.dragging)
  nodes.value = applyPassiveChanges(list, nodes.value, ['position', 'select', 'dimensions'])
  if (hasPositionChange) {
    updateLayoutFromNodes()
    scheduleLayoutSave()
  }
}

function onEdgesChange(changes) {
  edges.value = applyPassiveChanges(Array.from(changes), edges.value, ['select'])
}

function editTask(task) {
  if (!editableTask(task)) {
    reportError('只有可编辑的排队节点可以修改目标')
    return
  }
  emit('edit-node', { ...task })
}

function requestDeleteTask(task) {
  if (!editableTask(task)) {
    reportError('运行中或已完成的任务节点不能删除')
    return
  }
  void deleteTasks([task])
}

function validateHistoryOps(ops) {
  for (const op of ops) {
    if (nodeById(localGraph.value, op.runId)?.editable !== true) {
      throw new Error('只有可编辑的排队目标节点可以修改依赖')
    }
  }
  const next = applyDependencyOps(localGraph.value, ops)
  const depthError = graphDepthError(next)
  if (depthError) throw new Error(depthError)
}

function applyHistory(entry, direction) {
  if (!canEdit.value) {
    reportError(editBlockedMessage())
    return Promise.resolve(false)
  }

  return enqueueMutation(async () => {
    assertMutable()
    const stack = direction === 'undo' ? undoStack : redoStack
    if (stack.at(-1) !== entry) throw new Error('依赖状态已变化，无法撤销或重做')
    const target = direction === 'undo' ? entry.before : entry.after
    const ops = dependencyOpsBetween(dependencySnapshot(localGraph.value), target)
    validateHistoryOps(ops)
    await mutateGraphOps(ops)

    stack.pop()
    const oppositeStack = direction === 'undo' ? redoStack : undoStack
    oppositeStack.push(entry)
    syncHistoryDepth()
    return true
  })
}

function undo() {
  const entry = undoStack.at(-1)
  if (entry) void applyHistory(entry, 'undo')
}

function redo() {
  const entry = redoStack.at(-1)
  if (entry) void applyHistory(entry, 'redo')
}

function sameLayout(layout, persisted) {
  const ids = Object.keys(layout)
  return (
    ids.length === Object.keys(persisted || {}).length &&
    ids.every((runId) => {
      const position = persisted?.[runId]
      return (
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x === layout[runId].x &&
        position.y === layout[runId].y
      )
    })
  )
}

function sameViewport(left, right) {
  return left.x === right.x && left.y === right.y && left.zoom === right.zoom
}

function hasUnsavedLayout() {
  if (!localGraph.value) return false
  return (
    !sameLayout(layoutFromNodes(), savedLayout) ||
    !sameViewport(normalizeViewport(viewport.value), savedViewport)
  )
}

function restoreStoreAfterStaleLayout(graphId) {
  if (localGraph.value && agent.graph?.graphId === graphId) {
    agent.graph = cloneGraph(localGraph.value)
  }
}

function scheduleLayoutSave() {
  if (!localGraph.value) return
  layoutDirty = true
  layoutVersion += 1
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flushLayoutSave, SAVE_DELAY)
}

function flushLayoutSave() {
  clearTimeout(saveTimer)
  saveTimer = null
  const graph = localGraph.value
  if (!graph) return

  const layout = layoutFromNodes()
  const nextViewport = normalizeViewport(viewport.value)
  if (!hasUnsavedLayout()) {
    if (layoutPending === 0) layoutDirty = false
    return
  }

  const snapshot = {
    graphId: graph.graphId,
    runId: graph.parentRunId || agent.activeRunId,
    layout,
    viewport: nextViewport,
    version: layoutVersion,
    epoch: layoutEpoch
  }
  layoutPending += 1

  const save = async () => {
    try {
      if (disposed) return
      if (snapshot.epoch !== layoutEpoch || localGraph.value?.graphId !== snapshot.graphId) {
        restoreStoreAfterStaleLayout(snapshot.graphId)
        return
      }
      if (!snapshot.runId) throw new Error('任务图缺少父任务标识，无法保存布局')

      const result = await agent.saveGraphLayout({
        runId: snapshot.runId,
        layout: snapshot.layout,
        viewport: snapshot.viewport,
        baseRevision: Number(localGraph.value.layoutRevision) || 0
      })
      if (disposed) {
        if (agent.graph?.graphId === snapshot.graphId && agent.activeRunId) {
          void agent.loadGraph(agent.activeRunId).catch(() => {})
        }
        return
      }
      if (snapshot.epoch !== layoutEpoch || localGraph.value?.graphId !== snapshot.graphId) {
        restoreStoreAfterStaleLayout(snapshot.graphId)
        return
      }

      const hasNewerChanges = snapshot.version !== layoutVersion
      const next = {
        ...localGraph.value,
        layoutRevision: result.layoutRevision
      }
      savedLayout = cloneLayout(result.layout)
      savedViewport = normalizeViewport(result.viewport)
      if (!hasNewerChanges) {
        next.layout = cloneLayout(result.layout)
        next.viewport = normalizeViewport(result.viewport)
        layoutDirty = false
        if (!sameViewport(viewport.value, next.viewport)) viewport.value = next.viewport
      } else {
        layoutDirty = hasUnsavedLayout()
      }
      localGraph.value = next
      lastLayoutRevision = Number(result.layoutRevision) || 0
      if (hasNewerChanges && layoutDirty && layoutPending === 1) scheduleLayoutSave()
    } catch (error) {
      if (
        !disposed &&
        snapshot.epoch === layoutEpoch &&
        localGraph.value?.graphId === snapshot.graphId
      ) {
        const message = String(error?.message || error || '任务图布局保存失败')
        ui.toast(message, 'error')
        reportError(message)
        layoutDirty = hasUnsavedLayout()
      }
    } finally {
      layoutPending -= 1
    }
  }

  const result = layoutTail.then(save, save)
  layoutTail = result.catch(() => {})
}

function onNodeDragStop() {
  updateLayoutFromNodes()
  scheduleLayoutSave()
}

function onViewportUpdate(value) {
  viewport.value = normalizeViewport(value)
}

function onMoveEnd({ viewport: value }) {
  onViewportUpdate(value)
  scheduleLayoutSave()
}

function isTypingTarget(target) {
  return !!target?.closest?.('input, textarea, button, select, [contenteditable="true"]')
}

function onKeydown(event) {
  if (event.key !== 'Delete' && event.key !== 'Backspace') return
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
  if (isTypingTarget(event.target)) return

  const selectedNodes = nodes.value.filter((node) => node.selected)
  const selectedEdges = edges.value.filter((edge) => edge.selected)
  if (!selectedNodes.length && !selectedEdges.length) return
  event.preventDefault()
  event.stopPropagation()
  if (!canEdit.value) {
    reportError(editBlockedMessage())
    return
  }
  if (!flowInstance.value) {
    reportError('任务图画布尚未就绪')
    return
  }

  void Promise.resolve(
    flowInstance.value.deleteElements({ nodes: selectedNodes, edges: selectedEdges })
  ).catch((error) => reportError(error?.message || error))
}

async function fitView() {
  if (!flowInstance.value || !nodes.value.length) return
  try {
    await flowInstance.value.fitView({ padding: 0.2 })
  } catch (error) {
    reportError(error?.message || '适应视图失败')
  }
}

function miniMapNodeColor(node) {
  if (node.data?.status === 'done') return 'var(--status-ok-ink)'
  if (node.data?.status === 'error') return 'var(--status-error-ink)'
  if (node.data?.status === 'running') return 'var(--status-info-ink)'
  if (node.data?.status === 'queued') return 'var(--brand)'
  return 'var(--text-muted)'
}

function statusLabel(status) {
  return statusLabels[status] || status || '未知'
}

onBeforeUnmount(() => {
  disposed = true
  clearTimeout(saveTimer)
  clearTimeout(errorTimer)
  flushLayoutSave()
})
</script>

<template>
  <section class="task-graph-editor" data-testid="task-graph-editor" @keydown.capture="onKeydown">
    <div class="task-graph-editor__hint">
      拖动节点只调整布局；从任意节点右侧连线到排队目标节点左侧可新增依赖。
    </div>
    <div v-if="errorMessage" class="task-graph-editor__error" role="alert">
      {{ errorMessage }}
    </div>
    <form
      v-if="showAddNode"
      class="task-graph-editor__add-form"
      data-testid="task-graph-add-form"
      @submit.prevent="addNode"
    >
      <div class="task-graph-editor__add-title">
        <strong>新增任务节点</strong>
        <button type="button" aria-label="关闭新增节点" @click="closeAddNode">×</button>
      </div>
      <label>
        Key
        <input v-model="newNodeKey" maxlength="40" required data-testid="task-graph-new-key" />
      </label>
      <label>
        目标
        <textarea v-model="newNodeGoal" rows="3" required data-testid="task-graph-new-goal" />
      </label>
      <fieldset>
        <legend>前置依赖（可选）</legend>
        <div class="task-graph-editor__deps">
          <label v-for="node in nodes" :key="node.id">
            <input v-model="newNodeDeps" type="checkbox" :value="node.id" />
            {{ node.data.nodeKey }}
          </label>
        </div>
      </fieldset>
      <div class="task-graph-editor__add-actions">
        <button type="button" data-testid="task-graph-new-cancel" @click="closeAddNode">
          取消
        </button>
        <button type="submit" :disabled="!canAddNode" data-testid="task-graph-new-submit">
          添加
        </button>
      </div>
    </form>

    <div class="task-graph-editor__canvas">
      <VueFlow
        id="task-graph-editor-flow"
        :nodes="nodes"
        :edges="edges"
        :viewport="viewport"
        :nodes-draggable="true"
        :nodes-connectable="canEdit"
        :edges-reconnectable="false"
        :on-before-delete="onBeforeDelete"
        :min-zoom="0.2"
        :max-zoom="2"
        :delete-key-code="null"
        attribution-position="top-right"
        @nodes-change="onNodesChange"
        @edges-change="onEdgesChange"
        @connect="onConnect"
        @edges-delete="onEdgesDelete"
        @nodes-delete="onNodesDelete"
        @node-drag-stop="onNodeDragStop"
        @move-end="onMoveEnd"
        @update:viewport="onViewportUpdate"
        @init="flowInstance = $event"
        @error="reportError($event.message)"
      >
        <Background variant="dots" :gap="20" :size="1" />
        <Controls position="bottom-left" :show-interactive="false" />
        <MiniMap
          position="bottom-right"
          :width="180"
          :height="120"
          :node-color="miniMapNodeColor"
          :node-stroke-color="miniMapNodeColor"
          pannable
          zoomable
          aria-label="任务图缩略图"
        />
        <Panel position="top-left" class="task-graph-editor__toolbar" label="任务图画布工具">
          <button
            type="button"
            data-testid="task-graph-undo"
            :disabled="!undoDepth || !canEdit || mutationBusy"
            @click="undo"
          >
            撤销
          </button>
          <button
            type="button"
            data-testid="task-graph-redo"
            :disabled="!redoDepth || !canEdit || mutationBusy"
            @click="redo"
          >
            重做
          </button>
          <button type="button" data-testid="task-graph-fit-view" @click="fitView">适应视图</button>
          <button
            type="button"
            data-testid="task-graph-add-node"
            :disabled="!canAddNode"
            @click="openAddNode"
          >
            新增节点
          </button>
        </Panel>

        <template #node-default="nodeProps">
          <div
            class="task-graph-node"
            :data-testid="`task-graph-node-${nodeProps.id}`"
            :data-status="nodeProps.data.status"
            :data-editable="String(nodeProps.data.editable)"
          >
            <Handle
              type="target"
              :position="Position.Left"
              :is-connectable="canEdit"
              aria-label="依赖目标"
            />
            <Handle
              type="source"
              :position="Position.Right"
              :is-connectable="canEdit"
              aria-label="依赖来源"
            />
            <div class="task-graph-node__header">
              <strong :title="nodeProps.data.nodeKey">{{ nodeProps.data.nodeKey }}</strong>
              <span class="task-graph-node__status">{{ statusLabel(nodeProps.data.status) }}</span>
            </div>
            <p class="task-graph-node__goal" :title="nodeProps.data.goal">
              {{ nodeProps.data.goal || '未填写目标' }}
            </p>
            <div class="task-graph-node__footer">
              <span>第 {{ nodeProps.data.depth }} 层</span>
              <span v-if="nodeProps.data.editable" class="task-graph-node__actions nodrag nopan">
                <button type="button" @click.stop="editTask(nodeProps.data.task)">编辑</button>
                <button type="button" @click.stop="requestDeleteTask(nodeProps.data.task)">
                  删除
                </button>
              </span>
              <span v-else class="task-graph-node__readonly">只读</span>
            </div>
          </div>
        </template>
      </VueFlow>

      <div v-if="!nodes.length" class="task-graph-editor__empty">暂无任务节点</div>
    </div>
  </section>
</template>

<style>
.task-graph-editor {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
  color: var(--text-primary);
}

.task-graph-editor__hint {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
}

.task-graph-editor__error {
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--status-error-ink) 35%, transparent);
  border-radius: 8px;
  background: var(--status-error-bg);
  color: var(--status-error-ink);
  font-size: 12px;
}

.task-graph-editor__add-form {
  position: absolute;
  z-index: 20;
  top: 12px;
  left: 12px;
  display: flex;
  width: min(360px, calc(100% - 24px));
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--border-control);
  border-radius: 10px;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-menu);
}

.task-graph-editor__add-title,
.task-graph-editor__add-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.task-graph-editor__add-form label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--text-secondary);
  font-size: 12px;
}

.task-graph-editor__add-form input:not([type='checkbox']),
.task-graph-editor__add-form textarea {
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--border-control);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font: inherit;
}

.task-graph-editor__add-form fieldset {
  margin: 0;
  padding: 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
}

.task-graph-editor__add-form legend {
  padding: 0 4px;
  color: var(--text-muted);
  font-size: 11px;
}

.task-graph-editor__deps {
  display: flex;
  max-height: 120px;
  flex-wrap: wrap;
  gap: 6px 12px;
  overflow: auto;
}

.task-graph-editor__deps label {
  flex-direction: row;
  align-items: center;
}

.task-graph-editor__add-actions button {
  padding: 5px 12px;
  border: 1px solid var(--border-control);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.task-graph-editor__add-actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.task-graph-editor__canvas {
  position: relative;
  width: 100%;
  height: 520px;
  min-height: 320px;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--bg-panel);
}

.task-graph-editor__toolbar {
  display: flex;
  gap: 6px;
  padding: 6px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
  box-shadow: var(--shadow-menu);
}

.task-graph-editor__toolbar button,
.task-graph-node__actions button {
  min-height: 28px;
  padding: 3px 9px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.task-graph-editor__toolbar button:hover:not(:disabled),
.task-graph-node__actions button:hover {
  border-color: var(--brand);
  color: var(--brand-ink);
}

.task-graph-editor__toolbar button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.task-graph-node {
  width: 240px;
  min-height: 132px;
  padding: 12px 14px;
  border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--text-muted);
  border-radius: 9px;
  background: var(--bg-elevated);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--text-primary) 8%, transparent);
  font-size: 12px;
}

.task-graph-node[data-editable='true'] {
  border-left-color: var(--brand);
}

.task-graph-node[data-status='running'] {
  border-left-color: var(--status-info-ink);
}

.task-graph-node[data-status='done'] {
  border-left-color: var(--status-ok-ink);
}

.task-graph-node[data-status='error'] {
  border-left-color: var(--status-error-ink);
}

.task-graph-node__header,
.task-graph-node__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.task-graph-node__header strong {
  overflow: hidden;
  max-width: 145px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-graph-node__status {
  flex: none;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 11px;
}

.task-graph-node__goal {
  display: -webkit-box;
  min-height: 38px;
  margin: 10px 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.task-graph-node__footer {
  color: var(--text-muted);
  font-size: 11px;
}

.task-graph-node__actions {
  display: flex;
  gap: 4px;
}

.task-graph-node__actions button {
  min-height: 24px;
  padding: 2px 7px;
}

.task-graph-node__readonly {
  color: var(--text-muted);
}

.task-graph-editor__empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  font-size: 13px;
  pointer-events: none;
}
</style>
