const crypto = require('node:crypto')
const { broadcast } = require('../notify')
const { canonicalJson, remoteError, transaction, audit } = require('./protocol')

function createApprovalService({ db, timeoutMs = 300000, events = null }) {
  const waiters = new Map()
  const timers = new Map()
  function cancelRun(runId, reason = 'stopped') {
    for (const [id, entry] of waiters) {
      if (entry.runId !== runId) continue
      finish(id, 'cancelled', 'system', reason)
    }
  }
  function finish(id, status, actor) {
    const entry = waiters.get(id)
    if (!entry) return false
    waiters.delete(id); clearTimeout(timers.get(id)); timers.delete(id)
    entry.resolve({ allow: status === 'approved', remember: false, timedOut: status === 'expired', confirmedBy: status === 'approved' ? actor : status })
    return true
  }
  function respond({ approvalId, decision, actor = 'desktop', deviceId = null, expectedVersion, reason = '' }) {
    if (!['approved', 'rejected'].includes(decision)) throw remoteError('INVALID_MESSAGE', '审批决定无效')
    return transaction(db, () => {
      const row = db.prepare('SELECT * FROM agent_approvals WHERE approval_id=?').get(approvalId)
      if (!row) throw remoteError('NOT_FOUND', '审批不存在', 404)
      if (row.status !== 'pending') throw remoteError('APPROVAL_ALREADY_DECIDED', '审批已处理', 409)
      if (row.expires_at <= Date.now()) {
        db.prepare("UPDATE agent_approvals SET status='expired',version=version+1 WHERE approval_id=? AND status='pending'").run(approvalId)
        finish(approvalId, 'expired', actor)
        throw remoteError('APPROVAL_EXPIRED', '审批已过期', 410)
      }
      if (expectedVersion !== undefined && row.version !== expectedVersion) throw remoteError('VERSION_CONFLICT', '审批已变化，请刷新', 409)
      const run = db.prepare('SELECT status FROM agent_runs WHERE id=?').get(row.run_id)
      const control = db.prepare('SELECT control_state FROM remote_run_controls WHERE run_id=?').get(row.run_id)
      if (!run || ['done', 'stopped', 'error', 'max_steps', 'transferred'].includes(run.status) || (control && ['paused', 'stop_requested'].includes(control.control_state))) {
        throw remoteError('STATE_CONFLICT', '任务当前状态不允许审批', 409)
      }
      const r = db.prepare(`UPDATE agent_approvals SET status=?,version=version+1,decided_by=?,decided_at=?,decision_reason=?
        WHERE approval_id=? AND status='pending' AND version=?`).run(decision, actor, Date.now(), String(reason).slice(0, 300), approvalId, row.version)
      if (!r.changes) throw remoteError('APPROVAL_ALREADY_DECIDED', '审批已处理', 409)
      audit(db, { deviceId, actor, action: 'approval.respond', targetId: approvalId, result: decision })
      if (events) events.record({ type: 'approval.decided', conversationId: row.conversation_id, runId: row.run_id,
        payload: { approvalId, decision, decidedBy: actor, version: row.version + 1 } })
      finish(approvalId, decision, actor)
      return { ok: true, approvalId, decision, version: row.version + 1 }
    })
  }
  function decide({ runId, conversationId, name, args, riskLevel }) {
    const approvalId = crypto.randomUUID(); const now = Date.now()
    const canonicalArgs = canonicalJson(args)
    const argsHash = crypto.createHash('sha256').update(`${name}\0${runId}\0${canonicalArgs}`).digest('hex')
    db.prepare(`INSERT INTO agent_approvals(approval_id,run_id,conversation_id,tool,canonical_args,args_hash,risk_level,created_at,expires_at,status)
      VALUES(?,?,?,?,?,?,?,?,?,'pending')`).run(approvalId, runId, conversationId, name, canonicalArgs, argsHash, riskLevel, now, now + timeoutMs)
    if (events) events.record({ type: 'approval.requested', conversationId, runId,
      payload: { approvalId, tool: name, argsSummary: canonicalArgs.slice(0, 4000), riskLevel, expiresAt: now + timeoutMs, version: 1 } })
    return new Promise((resolve) => {
      waiters.set(approvalId, { runId, resolve })
      const timer = setTimeout(() => {
        try {
          const r = db.prepare("UPDATE agent_approvals SET status='expired',version=version+1 WHERE approval_id=? AND status='pending'").run(approvalId)
          if (r.changes) finish(approvalId, 'expired', 'timeout')
          broadcast('agent:confirmTimeout', { requestId: approvalId, runId, tool: name })
        } catch { /* 下次访问时按过期拒绝 */ }
      }, timeoutMs)
      if (timer.unref) timer.unref()
      timers.set(approvalId, timer)
      broadcast('agent:confirm', { requestId: approvalId, runId, tool: name, args, riskLevel,
        summary: `${name}: ${canonicalArgs.slice(0, 300)}` })
    }).then((result) => {
      const row = db.prepare('SELECT * FROM agent_approvals WHERE approval_id=?').get(approvalId)
      if (row && row.status === 'approved' && row.args_hash !== argsHash) {
        db.prepare("UPDATE agent_approvals SET status='superseded',version=version+1 WHERE approval_id=?").run(approvalId)
        return { allowed: false, confirmedBy: 'superseded' }
      }
      return { allowed: result.allow, remember: false, confirmedBy: result.confirmedBy, timedOut: result.timedOut }
    })
  }
  function get(approvalId) { return db.prepare('SELECT * FROM agent_approvals WHERE approval_id=?').get(approvalId) }
  return { decide, respond, cancelRun, get }
}
module.exports = { createApprovalService }
