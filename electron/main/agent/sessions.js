// Agent 会话管理：让运行中的 Agent 创建并驱动子会话。
//
// 三条安全闸门：
// 1) 并发闸门——同一会话已有在途流时拒绝再发，避免多条流同时写同一份消息；
// 2) 嵌套闸门——子会话深度超过 MAX_DEPTH 直接拒绝，防止递归衍生失控；
// 3) 权限闸门——子会话继承父运行权限（full → full，其余 → autonomous），不擅自提权。
//
// 所有会话仍复用 conversations / messages / agent_runs 表，因此子会话在界面上
// 就是一个普通会话（带 origin=agent 标记），可直接点开查看消息与运行记录。

const dbm = require('../../store/db')
const repos = require('../../store/repos')
const gateway = require('../gateway/index')
const agentRunner = require('./index')
const { getHub } = require('../events/hub')

const MAX_DEPTH = 2 // 人工会话(0) → 子会话(1) → 孙会话(2)
const DEFAULT_WAIT_MS = 60000
const MAX_WAIT_MS = 300000
const POLL_MS = 500

// 仍在推进中的状态：等待会话时不得当成终态。
// 包含 Run 的 queued/waiting_child，以及消息的 streaming/pending。
const ACTIVE_STATUSES = new Set(['queued', 'running', 'waiting_child', 'streaming', 'pending'])

// 外部依赖的唯一接缝：默认指向真实实现，单测用 _setDeps 换成替身，
// 从而不必依赖打包器对 CJS require 的 mock 行为。
const deps = {
  gateway: { sendChat: (...a) => gateway.sendChat(...a) },
  agentRunner: { startAgentRun: (...a) => agentRunner.startAgentRun(...a) },
  hub: { emit: (name, payload) => getHub().emit(name, payload) },
  repos,
  dbm
}

function _setDeps(patch) {
  Object.assign(deps, patch || {})
  return deps
}

function _resetDeps() {
  deps.gateway = { sendChat: (...a) => gateway.sendChat(...a) }
  deps.agentRunner = { startAgentRun: (...a) => agentRunner.startAgentRun(...a) }
  deps.hub = { emit: (name, payload) => getHub().emit(name, payload) }
  deps.repos = repos
  deps.dbm = dbm
}

function emit(name, payload) {
  deps.hub.emit(name, payload)
}

// 计算某个会话的派生深度：沿 parent_id 向上数层级，带环保护
function depthOf(db, conversationId) {
  let depth = 0
  let cur = conversationId
  const seen = new Set()
  while (cur && depth <= MAX_DEPTH + 1) {
    if (seen.has(cur)) break
    seen.add(cur)
    const row = db.prepare('SELECT parent_id FROM conversations WHERE id = ?').get(cur)
    if (!row || !row.parent_id) break
    cur = row.parent_id
    depth++
  }
  return depth
}

function sessionView(db, conversationId) {
  const conv = deps.repos.getConversation(db, conversationId)
  if (!conv) return null
  const runs = db
    .prepare(
      `SELECT id, status, goal, max_steps AS maxSteps, steps_used AS stepsUsed,
       started_at AS startedAt, ended_at AS endedAt
       FROM agent_runs WHERE conversation_id = ? ORDER BY started_at DESC LIMIT 1`
    )
    .all(conversationId)
  const run = runs[0] || null
  const runRow = run ? deps.repos.getRun(db, run.id) : null
  const messages = deps.repos.listMessages(db, conversationId)
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  return {
    conversationId,
    title: conv.title,
    origin: conv.origin || 'user',
    parentId: conv.parentId || null,
    createdByRun: conv.createdByRun || null,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    runId: run ? run.id : null,
    parentRunId: runRow ? runRow.parentRunId || null : null,
    controlMode: runRow ? runRow.controlMode || null : null,
    traceId: runRow ? runRow.traceId || null : null,
    acceptanceStatus: runRow ? runRow.acceptanceStatus || 'not_required' : 'not_required',
    status: run ? run.status : lastAssistant ? lastAssistant.status : 'idle',
    stepsUsed: run ? run.stepsUsed : 0,
    maxSteps: run ? run.maxSteps : null,
    messageCount: messages.length,
    lastMessageId: lastAssistant ? lastAssistant.id : null,
    lastMessageStatus: lastAssistant ? lastAssistant.status : null,
    preview: lastAssistant ? String(lastAssistant.content || '').slice(0, 300) : ''
  }
}

// 创建子会话。父会话用于继承供应商/模型/项目与权限上下文。
async function createSession({
  parentConversationId,
  title,
  goal,
  runId,
  providerId,
  model,
  projectId
}) {
  const db = deps.dbm.get()
  const parent = parentConversationId ? deps.repos.getConversation(db, parentConversationId) : null
  if (parentConversationId && !parent) throw new Error('父会话不存在')
  if (parent) {
    const depth = depthOf(db, parent.id)
    if (depth >= MAX_DEPTH)
      throw new Error(`会话嵌套已达上限(${MAX_DEPTH} 层)，请在本会话内继续处理`)
  }
  const conv = deps.repos.createConversation(db, {
    title: String(title || goal || '子任务').slice(0, 80),
    origin: 'agent',
    parentId: parent ? parent.id : null,
    createdByRun: runId || null,
    // 未显式指定时继承父会话的供应商/模型/项目，保证子会话不必重复配置
    providerId: providerId || (parent && parent.providerId) || null,
    model: model || (parent && parent.model) || null,
    projectId: projectId || (parent && parent.projectId) || null,
    systemPrompt: parent && parent.systemPrompt ? parent.systemPrompt : null
  })
  emit('session.created', {
    conversationId: conv.id,
    parentId: conv.parentId,
    runId: runId || null,
    title: conv.title
  })
  return conv
}

// 向子会话发送提示词。permission 决定走普通对话还是任务模式。
async function sendToSession({
  conversationId,
  content,
  permission,
  cluster,
  runId,
  controlMode,
  mandate,
  acceptancePolicy,
  idempotencyKey
}) {
  const db = deps.dbm.get()
  const conv = deps.repos.getConversation(db, conversationId)
  if (!conv) throw new Error('会话不存在')
  const text = String(content || '').trim()
  if (!text) throw new Error('提示词不能为空')
  // 并发闸门：同会话已有在途流时拒绝，避免两条流写同一份消息
  const streaming = db
    .prepare(
      "SELECT id FROM messages WHERE conversation_id = ? AND status = 'streaming' AND deleted_at IS NULL LIMIT 1"
    )
    .get(conversationId)
  if (streaming) throw new Error('该会话仍在生成中，请先用 session_status 轮询或等待其完成')

  emit('session.send', {
    conversationId,
    parentId: conv.parentId,
    runId: runId || null,
    length: text.length
  })

  // permission 缺省按普通对话处理；只有显式要求任务模式才起 Agent 运行。
  // readonly/full 原样透传：readonly 子会话继承只读不提权（index.js 会话管理同口径）
  const mode = ['readonly', 'full'].includes(permission)
    ? permission
    : permission === 'autonomous'
      ? 'autonomous'
      : 'default'
  if (mode === 'default') {
    const r = await deps.gateway.sendChat({ conversationId, content: text })
    emit('session.sent', {
      conversationId,
      runId: runId || null,
      msgId: r.assistantMsgId,
      mode: 'chat'
    })
    return { conversationId, ...r, mode: 'chat' }
  }
  const r = await deps.agentRunner.startAgentRun({
    conversationId,
    goal: text,
    permission: mode,
    cluster: !!cluster,
    parentRunId: runId || null,
    controlMode: controlMode || 'delegated',
    mandate: mandate || null,
    acceptancePolicy: acceptancePolicy || null,
    idempotencyKey: idempotencyKey || null
  })
  emit('session.sent', {
    conversationId,
    runId: r.runId,
    msgId: r.assistantMsgId,
    mode: 'agent',
    parentRunId: runId || null
  })
  return { conversationId, ...r, mode: 'agent' }
}

function getSessionStatus({ conversationId }) {
  const view = sessionView(deps.dbm.get(), conversationId)
  if (!view) throw new Error('会话不存在')
  return view
}

function listSessions({ parentId, runId, limit = 20 } = {}) {
  const db = deps.dbm.get()
  const rows = parentId
    ? deps.repos.listChildConversations(db, parentId)
    : deps.repos.listAgentConversations(db, runId)
  return rows
    .slice(0, Math.max(1, limit))
    .map((c) => sessionView(db, c.id))
    .filter(Boolean)
}

// 有界轮询等待：等到 run 进入终态或超时。
// 用轮询而非长连接，是因为子会话可能由另一条 IPC 链路驱动，
// 事件订阅拿不到「刚结束」的确定性通知；轮询语义简单且可预期。
async function waitForSession({ conversationId, timeoutMs = DEFAULT_WAIT_MS, pollMs = POLL_MS }) {
  const limit = Math.min(MAX_WAIT_MS, Math.max(1000, Number(timeoutMs) || DEFAULT_WAIT_MS))
  const interval = Math.max(200, Number(pollMs) || POLL_MS)
  const started = Date.now()
  let last = null
  for (;;) {
    last = getSessionStatus({ conversationId })
    if (last.status && !ACTIVE_STATUSES.has(last.status)) {
      return { ...last, waited: Date.now() - started, timedOut: false }
    }
    if (Date.now() - started >= limit) {
      return { ...last, waited: Date.now() - started, timedOut: true }
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}

// 取运行结果：最终回答 + 最近的工具调用摘要
function getSessionResult({ conversationId, maxChars = 8000, calls = 10 }) {
  const db = deps.dbm.get()
  const view = sessionView(db, conversationId)
  if (!view) throw new Error('会话不存在')
  const messages = deps.repos.listMessages(db, conversationId)
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const content = lastAssistant ? String(lastAssistant.content || '') : ''
  const toolCalls = view.runId
    ? deps.repos.getRunCalls(db, view.runId).slice(-Math.max(1, calls))
    : []
  const userMsg = [...messages].reverse().find((m) => m.role === 'user')
  return {
    conversationId,
    runId: view.runId,
    status: view.status,
    content: content.slice(0, Math.max(1, maxChars)),
    truncated: content.length > Math.max(1, maxChars),
    userMessage: userMsg ? String(userMsg.content || '').slice(0, 500) : '',
    toolCalls: toolCalls.map((c) => ({
      step: c.step,
      tool: c.tool,
      riskLevel: c.risk_level,
      confirmedBy: c.confirmed_by,
      ok: !c.error,
      error: c.error ? String(c.error).slice(0, 200) : null,
      durationMs: c.duration_ms
    }))
  }
}

module.exports = {
  MAX_DEPTH,
  _setDeps,
  _resetDeps,
  depthOf,
  createSession,
  sendToSession,
  getSessionStatus,
  listSessions,
  waitForSession,
  getSessionResult,
  sessionView
}
