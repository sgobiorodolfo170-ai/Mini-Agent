const repos = require('../../store/repos')
const { recordRunState } = require('../../store/run-storage')
const { getHub } = require('../events/hub')
const graph = require('./graph')
const { LIMITS } = require('./cluster-policy')

const SLOT_LIMIT = LIMITS.globalSlots

function transition(db, id, patch) {
  const result = repos.updateRunStatus(db, id, patch)
  if (!result.ok) throw new Error(`任务状态更新失败：${result.reason}`)
  recordRunState(db, id)
  return result.run
}

function getRunStatus(db, id) {
  const run = repos.getRun(db, id)
  if (!run || !repos.getConversation(db, run.conversationId)) throw new Error('任务不存在')
  const result = { ...run }
  delete result.runSpecJson
  delete result.mandateJson
  delete result.idempotencyKey
  return result
}

function getRunResult(db, id, maxChars) {
  const run = getRunStatus(db, id)
  const limit = Math.min(20000, Math.max(1, Number(maxChars) || 8000))
  const message = run.assistantMessageId && repos.getMessage(db, run.assistantMessageId)
  const text = repos.isRunTerminal(run.status) ? String(message?.content || '') : ''
  const toolCalls = repos
    .getRunCalls(db, id)
    .slice(-10)
    .map((call) => ({
      step: call.step,
      tool: call.tool,
      ok: !call.error,
      durationMs: call.duration_ms
    }))
  return {
    runId: id,
    conversationId: run.conversationId,
    status: run.status,
    finishedReason: run.finishedReason,
    transferToRunId: run.transferToRunId,
    content: text.slice(0, limit),
    truncated: text.length > limit,
    toolCalls
  }
}

function followTransfer(db, run) {
  const visited = new Set()
  while (run?.status === 'transferred' && run.transferToRunId && !visited.has(run.id)) {
    visited.add(run.id)
    const next = repos.getRun(db, run.transferToRunId)
    if (!next || next.parentRunId !== run.id || next.controlMode !== 'transferred') break
    run = next
  }
  return run
}

function waitForRuns(db, { runIds, resolveRunIds, timeoutMs, signal }) {
  const timeout = Math.min(300000, Math.max(1, Number(timeoutMs) || 60000))
  return new Promise((resolve, reject) => {
    function cleanup() {
      unsubscribeRun()
      unsubscribeGraph()
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    function abort() {
      cleanup()
      reject(Object.assign(new Error('任务已停止'), { name: 'AbortError' }))
    }
    function check(timedOut = false) {
      try {
        const ids = typeof resolveRunIds === 'function' ? resolveRunIds() : runIds
        const runs = ids.map((id) => {
          const run = followTransfer(db, repos.getRun(db, id))
          if (!run) throw new Error('任务不存在')
          return {
            ...getRunResult(db, run.id),
            requestedRunId: id,
            nodeKey: run.nodeKey,
            graphId: run.graphId
          }
        })
        const ready = runs.every((run) => repos.isRunTerminal(run.status))
        if (!ready && !timedOut) return
        cleanup()
        resolve({ timedOut: !ready, runs })
      } catch (error) {
        cleanup()
        reject(error)
      }
    }
    const unsubscribeRun = getHub().on('run.end', () => check())
    const unsubscribeGraph = getHub().on('graph.updated', () => check())
    const timer = setTimeout(() => check(true), timeout)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    else check()
  })
}

// An execution slot is held only while a run can advance. Resuming runs compete
// before starting more work so a sustained queue cannot starve a waiting parent.
function createRunQueue({ launch, shuttingDown, limit = SLOT_LIMIT }) {
  const slots = new Set()
  const resumes = new Map()
  const activeGraphs = new Map()
  const workspaceLeases = new Map()
  let scheduled = false
  let generation = 0

  function workspaceKey(db, id) {
    const run = repos.getRun(db, id)
    if (!run) return null
    const spec = safeSpec(run.runSpecJson)
    if (spec.workspacePolicy === 'worktree') return null
    const conv = repos.getConversation(db, run.conversationId)
    return conv?.projectId
      ? `project:${conv.projectId}`
      : `conversation:${conv?.id || run.conversationId}`
  }

  function safeSpec(value) {
    try {
      return value ? JSON.parse(value) : {}
    } catch {
      return {}
    }
  }

  function snapshot(db) {
    const queued = db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_runs WHERE status='queued' AND run_spec_json IS NOT NULL"
      )
      .get().n
    return {
      activeSlots: slots.size,
      slotLimit: limit,
      queued,
      waitingResumes: resumes.size,
      graphs: [...activeGraphs].map(([graphId, ids]) => ({ graphId, active: ids.size })),
      workspaceLeases: [...workspaceLeases].map(([key, runId]) => ({ key, runId }))
    }
  }

  function trackGraph(db, id) {
    const run = repos.getRun(db, id)
    if (!run || !run.graphId) return
    const active = activeGraphs.get(run.graphId) || new Set()
    active.add(id)
    activeGraphs.set(run.graphId, active)
  }

  function untrackGraph(id) {
    for (const [graphId, active] of activeGraphs) {
      if (!active.delete(id)) continue
      if (!active.size) activeGraphs.delete(graphId)
      return
    }
  }

  function graphHasCapacity(db, id) {
    const run = repos.getRun(db, id)
    if (!run || !run.graphId) return true
    const active = activeGraphs.get(run.graphId)
    return !active || active.size < graph.MAX_CONCURRENCY
  }

  function dependenciesReady(db, id) {
    const deps = db
      .prepare(
        `SELECT p.status, p.acceptance_policy, p.acceptance_status FROM run_dependencies d
         JOIN agent_runs p ON p.id=d.depends_on_run_id WHERE d.run_id=?`
      )
      .all(id)
    return deps.every(
      (dep) =>
        dep.status === 'done' && (!dep.acceptance_policy || dep.acceptance_status === 'accepted')
    )
  }

  function pickQueued(db) {
    const rows = db
      .prepare(
        `SELECT id FROM agent_runs
         WHERE status='queued' AND run_spec_json IS NOT NULL ORDER BY submitted_at,id`
      )
      .all()
    for (const row of rows) {
      if (slots.has(row.id)) continue
      const lease = workspaceKey(db, row.id)
      if (lease && workspaceLeases.has(lease)) continue
      if (dependenciesReady(db, row.id) && graphHasCapacity(db, row.id)) return row.id
    }
    return null
  }

  function schedule(db) {
    if (scheduled || shuttingDown()) return
    scheduled = true
    const queuedGeneration = generation
    setImmediate(() => {
      if (queuedGeneration !== generation) return
      scheduled = false
      if (shuttingDown()) return
      try {
        while (slots.size < limit) {
          const pending = resumes.entries().next().value
          if (pending) {
            const [id, resume] = pending
            resumes.delete(id)
            if (resume()) {
              slots.add(id)
              trackGraph(db, id)
            }
            continue
          }
          const queuedId = pickQueued(db)
          if (!queuedId) return
          slots.add(queuedId)
          trackGraph(db, queuedId)
          const lease = workspaceKey(db, queuedId)
          if (lease) workspaceLeases.set(lease, queuedId)
          try {
            launch(db, queuedId)
          } catch (error) {
            slots.delete(queuedId)
            untrackGraph(queuedId)
            if (lease && workspaceLeases.get(lease) === queuedId) workspaceLeases.delete(lease)
            throw error
          }
        }
      } catch (error) {
        // 应用退出/数据库已关闭时，后台调度不应产生未处理异常。
        if (!shuttingDown()) console.error('RUN_QUEUE_SCHEDULE_FAILED', error)
      }
    })
  }

  function release(db, id) {
    const had = slots.delete(id)
    untrackGraph(id)
    const lease = workspaceKey(db, id)
    if (lease && workspaceLeases.get(lease) === id) workspaceLeases.delete(lease)
    if (had) schedule(db)
  }

  async function acquire(db, id, signal) {
    if (signal.aborted || shuttingDown()) return false
    if (slots.has(id)) return true
    return new Promise((resolve) => {
      function abort() {
        resumes.delete(id)
        resolve(false)
      }
      signal.addEventListener('abort', abort, { once: true })
      resumes.set(id, () => {
        signal.removeEventListener('abort', abort)
        resolve(!signal.aborted)
        return !signal.aborted
      })
      schedule(db)
    })
  }

  function isClaimed(id) {
    return slots.has(id)
  }

  function reset() {
    generation += 1
    slots.clear()
    resumes.clear()
    activeGraphs.clear()
    workspaceLeases.clear()
    scheduled = false
  }

  return { schedule, release, acquire, isClaimed, reset, snapshot }
}

module.exports = {
  createRunQueue,
  transition,
  followTransfer,
  getRunStatus,
  getRunResult,
  waitForRuns
}
