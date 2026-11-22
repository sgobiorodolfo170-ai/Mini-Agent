import { beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dbm = require('../../electron/store/db')
const repos = require('../../electron/store/repos')
const { createApprovalService } = require('../../electron/main/remote/approval-service')
const { createRunControl } = require('../../electron/main/remote/run-control-service')
const { RemoteEventStore } = require('../../electron/main/remote/event-store')
const { RemoteAuthService } = require('../../electron/main/remote/auth-service')

let db, conv, run, approvals, runs, events

beforeEach(() => {
  dbm.close(); dbm.open(':memory:'); db = dbm.get()
  conv = repos.createConversation(db, { title: '审批测试' })
  const runId = repos.createRun(db, { conversationId: conv.id, goal: '测试任务' })
  run = repos.getRun(db, runId)
  events = new RemoteEventStore({ db })
  approvals = createApprovalService({ db, timeoutMs: 60000 })
  runs = createRunControl({ db, agent: { stopRun: () => true }, events })
})

describe('持久化审批服务', () => {
  it('创建审批→批准→resolve→重复响应被拒绝', async () => {
    const p = approvals.decide({ runId: run.id, conversationId: conv.id, name: 'write_file', args: { path: 'a.txt', content: 'x' }, riskLevel: 'side_effect' })
    const pending = db.prepare("SELECT * FROM agent_approvals WHERE status='pending'").get()
    expect(pending.tool).toBe('write_file')

    const r1 = approvals.respond({ approvalId: pending.approval_id, decision: 'approved', actor: 'desktop' })
    expect(r1.ok).toBe(true)
    const result = await p
    expect(result.allowed).toBe(true)

    expect(() => approvals.respond({ approvalId: pending.approval_id, decision: 'approved', actor: 'desktop' })).toThrow(/已处理/)
  })

  it('拒绝审批→Agent 收到拒绝结果', async () => {
    const p = approvals.decide({ runId: run.id, conversationId: conv.id, name: 'run_command', args: { command: 'ls' }, riskLevel: 'destructive' })
    const pending = db.prepare("SELECT * FROM agent_approvals WHERE status='pending'").get()
    approvals.respond({ approvalId: pending.approval_id, decision: 'rejected', actor: 'desktop' })
    const result = await p
    expect(result.allowed).toBe(false)
  })

  it('参数摘要在批准后变化时置 superseded', async () => {
    const p = approvals.decide({ runId: run.id, conversationId: conv.id, name: 'write_file', args: { path: 'a.txt' }, riskLevel: 'side_effect' })
    const pending = db.prepare("SELECT * FROM agent_approvals WHERE status='pending'").get()
    // 模拟批准后参数被篡改
    db.prepare("UPDATE agent_approvals SET args_hash='tampered' WHERE approval_id=?").run(pending.approval_id)
    approvals.respond({ approvalId: pending.approval_id, decision: 'approved', actor: 'desktop' })
    const result = await p
    expect(result.allowed).toBe(false)
    expect(result.confirmedBy).toBe('superseded')
  })

  it('取消 Run 时待处理审批被取消', async () => {
    const p = approvals.decide({ runId: run.id, conversationId: conv.id, name: 'write_file', args: { path: 'b.txt' }, riskLevel: 'side_effect' })
    approvals.cancelRun(run.id, 'user')
    const result = await p
    expect(result.allowed).toBe(false)
  })

  it('版本不匹配时拒绝审批', async () => {
    approvals.decide({ runId: run.id, conversationId: conv.id, name: 'write_file', args: { path: 'c.txt' }, riskLevel: 'side_effect' })
    const pending = db.prepare("SELECT * FROM agent_approvals WHERE status='pending'").get()
    expect(() => approvals.respond({ approvalId: pending.approval_id, decision: 'approved', actor: 'desktop', expectedVersion: 99 })).toThrow(/已变化/)
  })
})

describe('Run 控制状态机', () => {
  it('pause → checkpoint 进入 paused → resume 恢复', async () => {
    runs.request(run.id, 'pause', 'desktop')
    expect(runs.state(run.id).control_state).toBe('pause_requested')

    const state = { stopped: false }
    const cp = runs.checkpoint(run.id, state)
    await new Promise((r) => setTimeout(r, 50))
    expect(runs.state(run.id).control_state).toBe('paused')

    runs.request(run.id, 'resume', 'desktop')
    const ok = await cp
    expect(ok).toBe(true)
    expect(runs.state(run.id).control_state).toBe('none')
  })

  it('stop 优先于 pause，checkpoint 返回 false', async () => {
    runs.request(run.id, 'stop', 'desktop')
    const ok = await runs.checkpoint(run.id, { stopped: false })
    expect(ok).toBe(false)
  })

  it('终态 Run 拒绝控制操作', () => {
    repos.updateRunStatus(db, run.id, { status: 'done', endedAt: Date.now() })
    expect(() => runs.request(run.id, 'pause', 'desktop')).toThrow(/已结束/)
  })
})

describe('远程事件存储', () => {
  it('全部会话事件均按角色授权接收，未登录身份仍由服务入口拒绝', () => {
    const auth = new RemoteAuthService({ db })
    const ticket = auth.createTicket('127.0.0.1')
    const req = auth.requestPair(ticket.ticket, '手机', '127.0.0.1')
    const device = db.prepare('SELECT * FROM remote_devices WHERE device_id=?').get(req.deviceId)
    const other = repos.createConversation(db, { title: '未授权' })
    events.authService = auth
    events.record({ type: 'message.delta', conversationId: other.id, payload: { secret: true } })
    const page = events.since({ deviceId: device.device_id }, 0, events.epoch())
    expect(page.events.length).toBe(1)
    expect(page.events[0].conversation_id).toBe(other.id)
  })

  it('snapshot 包含授权会话、Run、审批', () => {
    const auth = new RemoteAuthService({ db })
    const ticket = auth.createTicket('127.0.0.1')
    const req = auth.requestPair(ticket.ticket, '手机', '127.0.0.1')
    const device = db.prepare('SELECT * FROM remote_devices WHERE device_id=?').get(req.deviceId)
    events.authService = auth

    const authCtx = { deviceId: device.device_id, role: 'operator', authVersion: 1 }
    events.record({ type: 'run.status.changed', conversationId: conv.id, runId: run.id, payload: { status: 'running' } })
    const snap = events.snapshot(authCtx)
    expect(snap.conversations.map((c) => c.id)).toContain(conv.id)
    expect(snap.runs.length).toBeGreaterThan(0)
    expect(snap.snapshotSeq).toBeGreaterThan(0)
    expect(snap.epoch).toBe(events.epoch())
  })

  it('since 分页与游标恢复', () => {
    const auth = new RemoteAuthService({ db })
    const ticket = auth.createTicket('127.0.0.1')
    const req = auth.requestPair(ticket.ticket, '手机', '127.0.0.1')
    const device = db.prepare('SELECT * FROM remote_devices WHERE device_id=?').get(req.deviceId)
    events.authService = auth

    for (let i = 0; i < 5; i++) events.record({ type: 'message.delta', conversationId: conv.id, payload: { i } })
    const page = events.since({ deviceId: device.device_id }, 0, events.epoch())
    expect(page.events.length).toBe(5)
    expect(page.truncated).toBe(false)

    const last = page.events.at(-1).seq
    events.record({ type: 'message.delta', conversationId: conv.id, payload: { i: 99 } })
    const next = events.since({ deviceId: device.device_id }, last, events.epoch())
    expect(next.events.length).toBe(1)
    expect(next.events[0].payload.i).toBe(99)
  })
})
