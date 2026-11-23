import { beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dbm = require('../../electron/store/db')
const repos = require('../../electron/store/repos')
const { RemoteAuthService } = require('../../electron/main/remote/auth-service')
const { RemoteEventStore } = require('../../electron/main/remote/event-store')
const { RemoteCommandRouter } = require('../../electron/main/remote/router')
const { createApprovalService } = require('../../electron/main/remote/approval-service')

let db, auth, events, router, conv, device

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
  db = dbm.get()
  conv = repos.createConversation(db, { title: '路由测试' })
  auth = new RemoteAuthService({ db })
  events = new RemoteEventStore({ db })
  events.authService = auth
  router = new RemoteCommandRouter({ db, auth, events })

  const ticket = auth.createTicket('127.0.0.1')
  const req = auth.requestPair(ticket.ticket, '手机', '127.0.0.1')
  device = db.prepare('SELECT * FROM remote_devices WHERE device_id=?').get(req.deviceId)
})

function cmd(type, payload = {}, cid = conv.id) {
  return {
    v: 1,
    id: 'test-id',
    kind: 'command',
    type,
    conversation_id: cid,
    request_id: 'req-' + Math.random().toString(36).slice(2),
    payload
  }
}

describe('RemoteCommandRouter', () => {
  it('viewer 不能发送消息', async () => {
    db.prepare("UPDATE remote_devices SET role='viewer' WHERE device_id=?").run(device.device_id)
    const authCtx = { deviceId: device.device_id, role: 'viewer' }
    await expect(
      router.execute(authCtx, cmd('chat.message.send', { content: 'hi' }), 'tls')
    ).rejects.toThrow(/操作权限/)
  })

  it('operator 不能处理审批', async () => {
    const approvals = createApprovalService({ db })
    const runId = repos.createRun(db, { conversationId: conv.id, goal: 'g' })
    approvals.decide({
      runId,
      conversationId: conv.id,
      name: 'write_file',
      args: { path: 'a' },
      riskLevel: 'side_effect'
    })
    const approval = db.prepare('SELECT * FROM agent_approvals').get()
    const authCtx = { deviceId: device.device_id, role: 'operator' }
    await expect(
      router.execute(
        authCtx,
        cmd('approval.respond', { approvalId: approval.approval_id, decision: 'approved' }),
        'tls'
      )
    ).rejects.toThrow(/审批权限/)
  })

  it('viewer 不能恢复或重试中断任务', async () => {
    const runId = repos.createRun(db, {
      conversationId: conv.id,
      goal: '中断任务',
      status: 'running'
    })
    repos.updateRunStatus(db, runId, { status: 'interrupted' })
    db.prepare("UPDATE remote_devices SET role='viewer' WHERE device_id=?").run(device.device_id)
    const authCtx = { deviceId: device.device_id, role: 'viewer' }
    await expect(
      router.execute(authCtx, cmd('agent.run.retry', { runId, mode: 'retry' }), 'tls')
    ).rejects.toThrow(/操作权限/)
  })

  it('明文模式拒绝 Agent 启动', async () => {
    const authCtx = { deviceId: device.device_id, role: 'operator' }
    await expect(
      router.execute(authCtx, cmd('agent.run.start', { goal: 'test' }), 'restricted_plain')
    ).rejects.toThrow(/非加密/)
  })

  it('明文模式拒绝审批', async () => {
    const authCtx = { deviceId: device.device_id, role: 'approver' }
    await expect(
      router.execute(
        authCtx,
        cmd('approval.respond', { approvalId: 'x', decision: 'approved' }),
        'restricted_plain'
      )
    ).rejects.toThrow(/非加密/)
  })

  it('明文模式拒绝任务控制', async () => {
    const authCtx = { deviceId: device.device_id, role: 'operator' }
    await expect(
      router.execute(authCtx, cmd('agent.run.pause', { runId: 'r1' }), 'restricted_plain')
    ).rejects.toThrow(/非加密/)
  })

  it('全部会话自动授权，包括配对后新建的会话；角色操作权限仍受控', async () => {
    const other = repos.createConversation(db, { title: '后续创建会话' })
    const authCtx = { deviceId: device.device_id, role: 'operator' }
    expect(() => auth.requireGrant(authCtx, other.id, 'operate')).not.toThrow()
    expect(() => auth.requireGrant(authCtx, other.id, 'approve')).toThrow(/没有该操作权限/)
    expect(auth.listConversations(authCtx).map((c) => c.id)).toContain(other.id)
  })

  it('命令幂等：同 request_id 同 payload 返回缓存结果', async () => {
    const authCtx = { deviceId: device.device_id, role: 'operator' }
    const c = {
      v: 1,
      id: 'x',
      kind: 'command',
      type: 'conversation.create',
      request_id: 'idem-test-001',
      payload: { title: '幂等测试' }
    }
    const r1 = await router.execute(authCtx, c, 'tls')
    const r2 = await router.execute(authCtx, c, 'tls')
    expect(r2.idempotent).toBe(true)
    expect(r2.conversation.id).toBe(r1.conversation.id)
  })

  it('命令幂等：同 request_id 不同 payload 返回冲突', async () => {
    const authCtx = { deviceId: device.device_id, role: 'operator' }
    const c1 = {
      v: 1,
      id: 'x',
      kind: 'command',
      type: 'conversation.create',
      request_id: 'idem-test-002',
      payload: { title: 'A' }
    }
    const c2 = { ...c1, payload: { title: 'B' } }
    await router.execute(authCtx, c1, 'tls')
    await expect(router.execute(authCtx, c2, 'tls')).rejects.toThrow(/幂等/)
  })
})
