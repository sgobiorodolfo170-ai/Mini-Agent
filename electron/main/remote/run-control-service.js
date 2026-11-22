const { remoteError, audit, transaction } = require('./protocol')

function createRunControl({ db, agent, events = null }) {
  function state(runId) { return db.prepare('SELECT * FROM remote_run_controls WHERE run_id=?').get(runId) }
  function ensure(runId) {
    db.prepare(`INSERT OR IGNORE INTO remote_run_controls(run_id,control_state,updated_at) VALUES(?,'none',?)`).run(runId, Date.now())
    return state(runId)
  }
  function set(runId, control, actor, reason) {
    const before = ensure(runId)
    const run = db.prepare('SELECT conversation_id AS conversationId FROM agent_runs WHERE id=?').get(runId)
    transaction(db, () => {
      db.prepare(`UPDATE remote_run_controls SET control_state=?,requested_by=?,reason=?,version=version+1,updated_at=? WHERE run_id=?`)
        .run(control, actor, reason || null, Date.now(), runId)
      if (events) events.record({ type: 'run.status.changed', conversationId: run && run.conversationId, runId,
        payload: { runId, control, previousControl: before.control_state } })
      audit(db, { actor, action: `run.${control}`, targetId: runId })
    })
    return state(runId)
  }
  function request(runId, action, actor = 'desktop', reason = '') {
    const run = db.prepare('SELECT * FROM agent_runs WHERE id=?').get(runId)
    if (!run) throw remoteError('NOT_FOUND', '任务不存在', 404)
    if (['done', 'stopped', 'error', 'max_steps', 'transferred'].includes(run.status)) throw remoteError('STATE_CONFLICT', '任务已结束', 409)
    const cur = ensure(runId)
    if (action === 'stop') {
      set(runId, 'stop_requested', actor, reason)
      agent.stopRun(runId, 'user', { actor, reason })
      return state(runId)
    }
    if (cur.control_state === 'stop_requested') throw remoteError('STATE_CONFLICT', '任务正在停止', 409)
    if (action === 'pause') {
      if (['paused', 'pause_requested'].includes(cur.control_state)) return cur
      if (cur.control_state !== 'none') throw remoteError('STATE_CONFLICT', '任务当前不可暂停', 409)
      return set(runId, 'pause_requested', actor, reason)
    }
    if (action === 'resume') {
      if (cur.control_state === 'none') return cur
      if (cur.control_state !== 'paused') throw remoteError('STATE_CONFLICT', '任务尚未到达可恢复的暂停点', 409)
      return set(runId, 'resume_requested', actor, reason)
    }
    throw remoteError('INVALID_MESSAGE', '任务控制动作无效')
  }
  async function checkpoint(runId, runState) {
    const cur = ensure(runId)
    if (cur.control_state === 'stop_requested') return false
    if (cur.control_state === 'pause_requested') {
      set(runId, 'paused', 'system', 'checkpoint')
      runState.pauseNotified = false
    }
    while (true) {
      const current = state(runId)
      if (!current || current.control_state === 'stop_requested' || runState.stopped) return false
      if (!['paused', 'resume_requested'].includes(current.control_state)) return true
      if (current.control_state === 'resume_requested') {
        set(runId, 'none', 'system', 'resumed')
        broadcastControl(runId, 'resumed')
        return true
      }
      if (!runState.pauseNotified) {
        runState.pauseNotified = true; broadcastControl(runId, 'paused')
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  function broadcastControl(runId, type) {
    const run = db.prepare('SELECT conversation_id AS conversationId FROM agent_runs WHERE id=?').get(runId)
    require('../notify').broadcast('agent:event', { type, runId, conversationId: run && run.conversationId })
  }
  return { request, checkpoint, state, set }
}
module.exports = { createRunControl }
