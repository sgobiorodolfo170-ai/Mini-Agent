const repos = require('../../store/repos')
const { recordRunState } = require('../../store/run-storage')
const { getHub } = require('../events/hub')

const SLOT_LIMIT = 4

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

function waitForRuns(db, { runIds, timeoutMs, signal }) {
  const timeout = Math.min(300000, Math.max(1, Number(timeoutMs) || 60000))
  return new Promise((resolve, reject) => {
    function cleanup() {
      unsubscribe()
      clearTimeout(timer)
      clearInterval(poll)
      signal?.removeEventListener('abort', abort)
    }
    function abort() {
      cleanup()
      reject(Object.assign(new Error('任务已停止'), { name: 'AbortError' }))
    }
    function check(timedOut = false) {
      try {
        const runs = runIds.map((id) => {
          const run = followTransfer(db, repos.getRun(db, id))
          if (!run) throw new Error('任务不存在')
          return { ...getRunResult(db, run.id), requestedRunId: id }
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
    const unsubscribe = getHub().on('run.end', () => check())
    const timer = setTimeout(() => check(true), timeout)
    const poll = setInterval(() => check(), 500)
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
  let scheduled = false

  function schedule(db) {
    if (scheduled || shuttingDown()) return
    scheduled = true
    setImmediate(() => {
      scheduled = false
      if (shuttingDown()) return
      while (slots.size < limit) {
        const pending = resumes.entries().next().value
        if (pending) {
          const [id, resume] = pending
          resumes.delete(id)
          if (resume()) slots.add(id)
          continue
        }
        const queued = db
          .prepare(
            `SELECT id FROM agent_runs
          WHERE status='queued' AND run_spec_json IS NOT NULL ORDER BY submitted_at,id LIMIT 1`
          )
          .get()
        if (!queued) return
        slots.add(queued.id)
        try {
          launch(db, queued.id)
        } catch (error) {
          slots.delete(queued.id)
          throw error
        }
      }
    })
  }

  function release(db, id) {
    if (slots.delete(id)) schedule(db)
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

  return { schedule, release, acquire }
}

module.exports = {
  createRunQueue,
  transition,
  followTransfer,
  getRunStatus,
  getRunResult,
  waitForRuns
}
