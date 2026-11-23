const repos = require('../../store/repos')
const gateway = require('../gateway')
const agent = require('../agent')
const { canonicalJson, remoteError, tokenHash, transaction } = require('./protocol')
const { createRunControl } = require('./run-control-service')

class RemoteCommandRouter {
  constructor({ db, auth, events }) {
    this.db = db
    this.auth = auth
    this.events = events
    this.runs = createRunControl({ db, agent, events })
    this.approvals = require('../agent').getApprovalService()
  }
  async execute(auth, command, transport = 'tls') {
    const c = command
    const requestId = c.request_id
    const hash = tokenHash(
      canonicalJson({
        type: c.type,
        cid: c.conversation_id,
        payload: c.payload,
        expected: c.expected_version
      }),
      'command'
    )
    const previous = this.db
      .prepare('SELECT * FROM remote_commands WHERE device_id=? AND request_id=?')
      .get(auth.deviceId, requestId)
    if (previous) {
      if (previous.request_hash !== hash)
        throw remoteError('IDEMPOTENCY_CONFLICT', '请求编号已用于其他操作（幂等冲突）', 409)
      if (previous.status === 'interrupted_unknown' && c.type !== 'agent.run.start')
        throw remoteError('STATE_CONFLICT', '上次请求结果未知，请核对后使用新请求编号', 409)
      if (previous.result_json) return { ...JSON.parse(previous.result_json), idempotent: true }
      if (previous.status === 'accepted') return { status: 'accepted', message: '请求正在处理' }
    }
    if (!previous && !['device.heartbeat', 'session.subscribe', 'events.ack'].includes(c.type)) {
      this.db
        .prepare(
          `INSERT INTO remote_commands(device_id,request_id,command_type,request_hash,status,created_at,updated_at)
        VALUES(?,?,?,?,'accepted',?,?)`
        )
        .run(auth.deviceId, requestId, c.type, hash, Date.now(), Date.now())
    }
    try {
      const result = await this.dispatch(auth, c, transport)
      if (!['device.heartbeat', 'session.subscribe', 'events.ack'].includes(c.type)) {
        this.db
          .prepare(
            "UPDATE remote_commands SET status='completed',result_json=?,updated_at=? WHERE device_id=? AND request_id=?"
          )
          .run(JSON.stringify(result), Date.now(), auth.deviceId, requestId)
      }
      return result
    } catch (e) {
      if (!['device.heartbeat', 'session.subscribe', 'events.ack'].includes(c.type)) {
        this.db
          .prepare(
            "UPDATE remote_commands SET status='rejected',result_json=?,updated_at=? WHERE device_id=? AND request_id=?"
          )
          .run(
            JSON.stringify({ code: e.code || 'INTERNAL_ERROR', message: e.message }),
            Date.now(),
            auth.deviceId,
            requestId
          )
      }
      throw e
    }
  }
  operator(auth, cid) {
    if (auth.role !== 'operator') throw remoteError('FORBIDDEN', '当前设备没有操作权限', 403)
    this.auth.requireGrant(auth, cid, 'operate')
  }
  async dispatch(auth, c, transport) {
    const p = c.payload || {}
    const cid = c.conversation_id || p.conversationId
    if (c.type === 'device.heartbeat') return { status: 'completed', serverTime: Date.now() }
    if (c.type === 'session.subscribe' || c.type === 'events.ack')
      return {
        status: 'completed',
        ...this.events.since(auth, p.afterSeq || p.after_seq || 0, p.epoch || '')
      }
    if (transport !== 'tls' && c.type !== 'chat.message.send')
      throw remoteError('FORBIDDEN', '非加密兼容模式只允许普通消息', 403)

    // 审批：仅 approver 角色，独立授权检查，不走 operator
    if (c.type === 'approval.respond') {
      if (auth.role !== 'approver') throw remoteError('FORBIDDEN', '当前设备没有审批权限', 403)
      const approval = this.approvals.get(p.approvalId)
      if (!approval) throw remoteError('NOT_FOUND', '审批不存在', 404)
      this.auth.requireGrant(auth, approval.conversation_id, 'approve')
      return {
        status: 'completed',
        result: this.approvals.respond({
          approvalId: p.approvalId,
          decision: p.decision,
          actor: `remote:${auth.deviceId}`,
          deviceId: auth.deviceId,
          expectedVersion: p.expectedVersion || c.expected_version
        })
      }
    }

    // 会话创建：operator 即可，无需已有会话 grant
    if (c.type === 'conversation.create') {
      if (auth.role !== 'operator') throw remoteError('FORBIDDEN', '当前设备没有操作权限', 403)
      const conv = transaction(this.db, () => {
        const created = repos.createConversation(this.db, {
          title: String(p.title || '手机会话').slice(0, 100),
          permission: 'autonomous'
        })
        this.db
          .prepare(
            'INSERT INTO remote_device_grants(device_id,conversation_id,capabilities_json,created_at) VALUES(?,?,?,?)'
          )
          .run(auth.deviceId, created.id, '["view","operate"]', Date.now())
        return created
      })
      return { status: 'completed', conversation: conv }
    }

    // 以下均需要 operator 角色 + 会话 grant
    this.operator(auth, cid)

    if (c.type === 'chat.message.send') {
      const content = String(p.content || '').trim()
      if (!content || content.length > 16000)
        throw remoteError('INVALID_MESSAGE', '消息为空或超过长度限制')
      const originId = `remote:${auth.deviceId}:${c.request_id}`
      const existing = this.db.prepare('SELECT id FROM messages WHERE id=?').get(originId)
      if (!existing)
        await gateway.sendChat({ conversationId: cid, content, originMessageId: originId })
      return { status: 'accepted' }
    }
    if (c.type === 'chat.message.stop') {
      const message = repos.getMessage(this.db, String(p.messageId || ''))
      if (!message) throw remoteError('NOT_FOUND', '消息不存在', 404)
      this.auth.requireGrant(auth, message.conversationId, 'operate')
      return { status: 'accepted', stopped: gateway.stopChat(message.id) }
    }
    if (c.type === 'agent.run.start') {
      const permission = p.permission === 'readonly' ? 'readonly' : 'autonomous'
      const goal = String(p.goal || p.content || '').trim()
      if (!goal || goal.length > 16000)
        throw remoteError('INVALID_MESSAGE', '任务目标为空或超过长度限制')
      const result = await agent.startAgentRun({
        conversationId: cid,
        goal,
        permission,
        idempotencyKey: `${auth.deviceId}:${c.request_id}`
      })
      return { status: 'accepted', runId: result.runId, reused: !!result.reused }
    }
    if (c.type === 'agent.run.retry') {
      const runId = p.runId || c.run_id
      const run = repos.getRun(this.db, runId)
      if (!run) throw remoteError('NOT_FOUND', '任务不存在', 404)
      this.auth.requireGrant(auth, run.conversationId, 'operate')
      const mode = p.mode === 'retry' ? 'retry' : 'continue'
      const result =
        mode === 'retry'
          ? await agent.retryInterruptedRun(runId, {
              actor: `remote:${auth.deviceId}`,
              reason: p.reason,
              idempotencyKey: `${auth.deviceId}:${c.request_id}`
            })
          : agent.resumeInterruptedRun(runId, {
              actor: `remote:${auth.deviceId}`,
              reason: p.reason
            })
      return {
        status: 'accepted',
        runId: result.runId,
        mode,
        retryOfRunId: result.retryOfRunId || (mode === 'retry' ? runId : null)
      }
    }
    if (['agent.run.pause', 'agent.run.resume', 'agent.run.stop'].includes(c.type)) {
      const runId = p.runId || c.run_id
      const run = repos.getRun(this.db, runId)
      if (!run) throw remoteError('NOT_FOUND', '任务不存在', 404)
      this.auth.requireGrant(auth, run.conversationId, 'operate')
      const action = c.type.split('.').at(-1)
      const control = this.runs.request(runId, action, `remote:${auth.deviceId}`, p.reason)
      return { status: 'accepted', runId, control: control.control_state, version: control.version }
    }
    throw remoteError('INVALID_MESSAGE', '不支持的命令类型')
  }
}
module.exports = { RemoteCommandRouter }
