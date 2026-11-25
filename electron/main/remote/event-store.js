const crypto = require('node:crypto')
const repos = require('../../store/repos')
const { remoteError } = require('./protocol')

function messageOut(m) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    status: m.status,
    seq: m.seq,
    createdAt: m.createdAt || m.created_at,
    agentRunId: safeMeta(m.meta).agentRunId || safeMeta(m.meta).runId || null
  }
}
function safeMeta(v) {
  try {
    const parsed = v ? JSON.parse(v) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
function approvalOut(r) {
  return {
    id: r.approval_id,
    approvalId: r.approval_id,
    runId: r.run_id,
    conversationId: r.conversation_id,
    tool: r.tool,
    risk: r.risk_level,
    riskLevel: r.risk_level,
    argsSummary: r.canonical_args.slice(0, 4000),
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    expiresAt: r.expires_at
  }
}
class RemoteEventStore {
  constructor({ db }) {
    this.db = db
    this.listeners = new Set()
    this.ensure()
  }
  ensure() {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO remote_event_state(singleton_id,epoch,oldest_available_seq,updated_at) VALUES(1,?,1,?)`
      )
      .run(crypto.randomUUID(), Date.now())
    this.db
      .prepare('DELETE FROM remote_sessions WHERE absolute_expires_at<? OR last_seen_at<?')
      .run(Date.now(), Date.now() - 1800000)
    this.db
      .prepare(
        "UPDATE remote_commands SET status='interrupted_unknown',updated_at=? WHERE status='accepted'"
      )
      .run(Date.now())
  }
  state() {
    return this.db.prepare('SELECT * FROM remote_event_state WHERE singleton_id=1').get()
  }
  epoch() {
    return this.state().epoch
  }
  latest() {
    return this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM remote_events').get().seq
  }
  record({ type, conversationId = null, runId = null, payload = {} }) {
    const row = this.db
      .prepare(
        `INSERT INTO remote_events(event_id,epoch,conversation_id,run_id,type,payload_json,created_at)
      VALUES(?,?,?,?,?,?,?)`
      )
      .run(
        crypto.randomUUID(),
        this.epoch(),
        conversationId,
        runId,
        type,
        JSON.stringify(payload),
        Date.now()
      )
    const event = {
      v: 1,
      id: crypto.randomUUID(),
      kind: 'event',
      type,
      seq: Number(row.lastInsertRowid),
      stream_epoch: this.epoch(),
      conversation_id: conversationId,
      run_id: runId,
      payload,
      sent_at: Date.now()
    }
    for (const fn of [...this.listeners]) {
      try {
        fn(event)
      } catch {
        /* 单连接错误不影响事件事实 */
      }
    }
    return event
  }
  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  authorized(_auth, event) {
    return (
      !!event.conversation_id &&
      !!this.db
        .prepare('SELECT 1 AS ok FROM conversations WHERE id=? AND deleted_at IS NULL')
        .get(event.conversation_id)
    )
  }
  sendable(auth, e) {
    return this.authorized(auth, e)
  }
  since(auth, after = 0, epoch = '') {
    const state = this.state()
    const from = Number(after) || 0
    if ((epoch && epoch !== state.epoch) || from < state.oldest_available_seq - 1)
      return { truncated: true, events: [] }
    const rows = this.db
      .prepare('SELECT * FROM remote_events WHERE seq>? AND epoch=? ORDER BY seq LIMIT 1000')
      .all(from, state.epoch)
    const events = rows
      .map((r) => ({
        v: 1,
        id: r.event_id,
        kind: 'event',
        type: r.type,
        seq: r.seq,
        stream_epoch: r.epoch,
        conversation_id: r.conversation_id,
        run_id: r.run_id,
        payload: JSON.parse(r.payload_json),
        sent_at: r.created_at
      }))
      .filter((e) => this.sendable(auth, e))
    return {
      truncated: false,
      events,
      latestSeq: this.latest(),
      hasMore: this.latest() > (rows.at(-1)?.seq || from)
    }
  }
  snapshot(auth) {
    const list = this.authService.listConversations(auth)
    const snapshot = {
      epoch: this.epoch(),
      snapshotSeq: this.latest(),
      conversations: list,
      messages: list.length ? this.messages(auth, list[0].id) : [],
      runs: this.runs(auth),
      approvals: this.approvals(auth)
    }
    return snapshot
  }
  messages(auth, conversationId) {
    this.authService.requireGrant(auth, conversationId)
    return repos
      .listMessages(this.db, conversationId)
      .filter((m) => !m.deleted_at)
      .slice(-50)
      .map(messageOut)
  }
  runs(_auth) {
    return this.db
      .prepare(
        `SELECT r.id,r.conversation_id AS conversationId,r.goal,r.status,r.max_steps AS maxSteps,
      r.transfer_to_run_id AS transferToRunId,r.steps_used AS stepsUsed,r.started_at AS startedAt,r.ended_at AS endedAt,c.control_state AS control
      FROM agent_runs r JOIN conversations cv ON cv.id=r.conversation_id AND cv.deleted_at IS NULL
      LEFT JOIN remote_run_controls c ON c.run_id=r.id ORDER BY r.started_at DESC LIMIT 50`
      )
      .all()
  }
  approvals(_auth) {
    return this.db
      .prepare(
        `SELECT a.* FROM agent_approvals a JOIN conversations c ON c.id=a.conversation_id AND c.deleted_at IS NULL
      WHERE a.status='pending' ORDER BY a.created_at LIMIT 100`
      )
      .all()
      .map(approvalOut)
  }
  calls(auth, runId) {
    const run = repos.getRun(this.db, runId)
    if (!run) throw remoteError('NOT_FOUND', '任务不存在', 404)
    this.authService.requireGrant(auth, run.conversationId)
    return repos.getRunCalls(this.db, runId).map((r) => ({
      step: r.step,
      tool: r.tool,
      argsSummary: String(r.args).slice(0, 1000),
      risk: r.risk_level,
      result: String(r.result || '').slice(0, 2000),
      error: String(r.error || '').slice(0, 500),
      at: r.at,
      durationMs: r.duration_ms
    }))
  }
  bridge(channel, payload) {
    const p = payload || {}
    const cid = p.conversationId
    if (!cid) return
    if (
      channel === 'chat:event' &&
      ['delta', 'done', 'stopped', 'error', 'snapshot'].includes(p.type)
    ) {
      if (p.type === 'snapshot') return
      this.record({
        type: p.type === 'delta' ? 'message.delta' : 'message.completed',
        conversationId: cid,
        payload: {
          messageId: p.msgId,
          delta: p.delta,
          content: p.content,
          status: p.status || p.type
        }
      })
    } else if (
      channel === 'agent:event' &&
      [
        'queued',
        'started',
        'state',
        'done',
        'tool-start',
        'tool-done',
        'paused',
        'resumed'
      ].includes(p.type)
    ) {
      const run = repos.getRun(this.db, p.runId)
      this.record({
        type: 'run.status.changed',
        conversationId: cid || (run && run.conversationId),
        runId: p.runId,
        payload: {
          runId: p.runId,
          status: p.status || p.type,
          control: p.control || null,
          goal: run && run.goal,
          transferToRunId: run && run.transferToRunId,
          tool: p.name,
          ok: p.ok
        }
      })
    } else if (channel === 'agent:confirm' && p.runId) {
      const run = repos.getRun(this.db, p.runId)
      this.record({
        type: 'approval.requested',
        conversationId: run && run.conversationId,
        runId: p.runId,
        payload: {
          approvalId: p.requestId,
          tool: p.tool,
          summary: p.summary,
          riskLevel: p.riskLevel
        }
      })
    } else if (channel === 'agent:confirmCancel' && p.runId) {
      const run = repos.getRun(this.db, p.runId)
      this.record({
        type: 'approval.cancelled',
        conversationId: run && run.conversationId,
        runId: p.runId,
        payload: { requestIds: p.requestIds || [] }
      })
    } else if (channel === 'agent:confirmTimeout' && p.runId) {
      const run = repos.getRun(this.db, p.runId)
      this.record({
        type: 'approval.expired',
        conversationId: run && run.conversationId,
        runId: p.runId,
        payload: { requestId: p.requestId, tool: p.tool }
      })
    }
  }
  retain({ max = 5000, days = 7 } = {}) {
    const cutoff = Date.now() - days * 86400000
    this.db
      .prepare(
        'DELETE FROM remote_events WHERE created_at<? OR seq<(SELECT MAX(seq)-? FROM remote_events)'
      )
      .run(cutoff, max)
    const oldest = this.db
      .prepare('SELECT COALESCE(MIN(seq),?) AS seq FROM remote_events')
      .get(this.latest() + 1).seq
    this.db
      .prepare(
        'UPDATE remote_event_state SET oldest_available_seq=?,updated_at=? WHERE singleton_id=1'
      )
      .run(oldest, Date.now())
    this.db
      .prepare('DELETE FROM remote_pairing_tickets WHERE expires_at<?')
      .run(Date.now() - 86400000)
    this.db
      .prepare('DELETE FROM remote_audit_logs WHERE created_at<?')
      .run(Date.now() - 90 * 86400000)
  }
}
module.exports = { RemoteEventStore, messageOut, approvalOut }
