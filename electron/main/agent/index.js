const os = require('os')
const { createHash } = require('node:crypto')
const { transaction, canonicalJson, remoteError } = require('../remote/protocol')
const { recordRunState } = require('../../store/run-storage')
const {
  createRunQueue,
  transition,
  followTransfer,
  getRunStatus,
  getRunResult,
  waitForRuns
} = require('./run-runtime')
const path = require('path')
const repos = require('../../store/repos')
const dbm = require('../../store/db')
const { chatStream, chatOnce, GatewayError } = require('../gateway/client')
const scheduler = require('../gateway/scheduler')
const title = require('../gateway/title')
const { resolveModel, msgOut, effectiveParams, safeJson } = require('../gateway/index')
const { decryptSecret } = require('../../store/keys')
const { broadcast } = require('../notify')
const { defineTools } = require('./tools')
const { escalateRisk } = require('./guard')
const { runAgentLoop } = require('./loop')
const { readMemoryFile } = require('./memory')
const { parseMcpServers } = require('./mcp-client')
const { getHub } = require('../events/hub')
const { parseHooks, applyHooks } = require('../events/hooks')
const { normalizeMandate, defaultSubMandate, authorizeToolCall } = require('./mandate')
const { createSessionBridge } = require('./session-bridge')
const acceptance = require('./acceptance')
const graph = require('./graph')
const { createApprovalService } = require('../remote/approval-service')
const { createRunControl } = require('../remote/run-control-service')
const { isShuttingDown } = require('../lifecycle')

let controlRuntime = null
function getControlRuntime(db) {
  if (!controlRuntime || controlRuntime.db !== db) {
    controlRuntime = {
      db,
      approvals: createApprovalService({ db, events: globalThis.__miniagentRemoteEvents || null })
    }
    controlRuntime.runs = createRunControl({
      db,
      agent: { stopRun },
      events: globalThis.__miniagentRemoteEvents || null
    })
  }
  return controlRuntime
}

const active = new Map() // runId -> { ac, stopped, remember:Set, confirms:Map }

// 确认请求的最长等待时间：超时按拒绝处理，避免隐藏窗口里的任务永久挂起

function toolSchemas(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

// Agent 任务的采样参数解析：全局采样设置（设置 → 会话，键 chatSampling）优先，
// 会话级 contextPolicy 仅作旧数据兼容。settings 是 getAllSettings() 的全量对象，
// 必须先取出 chatSampling 再交给 effectiveParams，否则整包 settings 会被当成旧会话策略。
function resolveAgentParams(settings, conv, provider, model) {
  const s = settings || {}
  const globalPolicy = s.chatSampling && typeof s.chatSampling === 'object' ? s.chatSampling : {}
  const legacyPolicy = safeJson(conv && conv.contextPolicy, {}) || {}
  return effectiveParams(globalPolicy, provider, model, legacyPolicy)
}

function summarize(toolName, args) {
  try {
    if (toolName === 'write_file')
      return `写入文件 ${args.path}（${String(args.content || '').length} 字符）`
    if (toolName === 'run_command') return `执行命令: ${String(args.command || '').slice(0, 200)}`
    if (toolName === 'read_file') return `读取文件 ${args.path}`
    if (toolName === 'list_dir') return `列目录 ${args.path}`
    if (toolName === 'search_files') return `搜索 ${args.dir} 中的「${args.pattern}」`
    if (toolName === 'web_fetch') return `抓取网页 ${args.url}`
    if (toolName === 'web_search') return `搜索「${args.query}」`
    if (toolName === 'edit_file') return `编辑文件 ${args.path}`
    if (toolName === 'grep_files') return `搜索内容「${args.pattern}」@ ${args.dir}`
    if (toolName === 'update_todo') return `更新任务清单: ${args.action}`
    if (toolName === 'save_memory') return `保存记忆「${args.name}」`
    if (toolName === 'spawn_agent') return `派生子 Agent: ${String(args.goal || '').slice(0, 120)}`
    if (toolName === 'session_create')
      return `创建子会话「${String(args.title || '').slice(0, 60)}」`
    if (toolName === 'session_send')
      return `向会话 ${String(args.conversationId || '').slice(0, 8)} 发送提示词（${String(args.content || '').length} 字符）`
    if (toolName === 'session_status')
      return `查询会话状态 ${String(args.conversationId || '').slice(0, 8)}`
    if (toolName === 'session_wait')
      return `等待会话完成 ${String(args.conversationId || '').slice(0, 8)}`
    if (toolName === 'session_result')
      return `读取会话结果 ${String(args.conversationId || '').slice(0, 8)}`
    if (toolName === 'session_list') return '列出子会话'
    if (toolName === 'browser_navigate') return `打开网页 ${args.url}`
    if (toolName === 'browser_click') return `点击 ${args.selector}`
    if (toolName === 'browser_type') return `输入到 ${args.selector}`
    if (toolName === 'browser_close') return '关闭内置浏览器'
    if (toolName === 'mcp_list_tools') return `列出 MCP 工具(${args.server})`
    if (toolName === 'mcp_call_tool') return `调用 MCP ${args.server}.${args.tool}`
    if (toolName === 'open_url') return `打开 ${args.url}`
    if (toolName === 'clipboard_write')
      return `写入剪贴板（${String(args.text || '').length} 字符）`
    return JSON.stringify(args).slice(0, 200)
  } catch {
    return ''
  }
}

function lastAssistantContent(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].content) return messages[i].content
  }
  return ''
}

// 任务模式下命令执行目录：会话所属项目的工作目录 → 旧全局设置兑底 → 用户主目录。
// 单独导出以便单测覆盖优先级。
function resolveWorkingDir(db, conversationId, settings) {
  let projectId = null
  if (conversationId) {
    try {
      const conv = repos.getConversation(db, conversationId)
      projectId = conv && conv.projectId
    } catch {
      projectId = null
    }
  }
  if (projectId) {
    const project = repos.getProject(db, projectId)
    if (project && project.path) return project.path
  }
  return (settings && settings.agentWorkingDir) || os.homedir()
}

async function withKeyRetry(db, provider, fn) {
  const keyRows = repos.listAllKeysWithSecret(db).filter((x) => x.providerId === provider.id)
  if (!keyRows.length) throw new Error(`供应商「${provider.name}」没有可用的 Key`)
  const exclude = []
  let lastErr = null
  const maxAttempts = Math.max(1, Math.min(2, keyRows.length))
  for (let i = 0; i < maxAttempts; i++) {
    const key = scheduler.pickKey(keyRows, provider.rotation_strategy, exclude, Date.now())
    if (!key) break
    exclude.push(key.id)
    try {
      const r = await fn(await decryptSecret(key.secretEnc), key)
      repos.updateKeyStatus(db, key.id, {
        ...scheduler.applyKeyResult(key, 'ok', Date.now()),
        lastUsedAt: Date.now()
      })
      return r
    } catch (e) {
      if (e && e.name === 'AbortError') throw e
      const kind = e instanceof GatewayError ? e.kind : 'network_error'
      lastErr = String((e && e.message) || e).slice(0, 300)
      repos.updateKeyStatus(
        db,
        key.id,
        scheduler.applyKeyResult(key, kind, Date.now(), { lastError: lastErr })
      )
      repos.logKeyEvent(db, { apiKeyId: key.id, kind: 'request', result: kind, detail: lastErr })
    }
  }
  throw new Error(lastErr || '无可用 Key')
}

// 沿 parent_run_id 链计算派生和移交的深度。
// 集中在此处配置，禁止各模块硬编码不同值。
const MAX_DELEGATION_DEPTH = 3

function depthOfRun(db, runId) {
  let depth = 0
  let cur = runId
  const seen = new Set()
  while (cur && depth < 64) {
    if (seen.has(cur)) break
    seen.add(cur)
    const row = db.prepare('SELECT parent_run_id FROM agent_runs WHERE id = ?').get(cur)
    if (!row || !row.parent_run_id) break
    cur = row.parent_run_id
    depth++
  }
  return depth
}

// 校验能否把 childConversation 的任务挂到 parentRunId 之下
function assertCanDelegate(db, parentRunId, controlMode, count, { plan = false } = {}) {
  const parent = repos.getRun(db, parentRunId)
  const state = active.get(parentRunId)
  if (!parent || parent.status !== 'running' || !state || state.stopped) {
    throw new Error('父任务当前不可派发')
  }
  if (state.mandate && !state.mandate.canDelegate) throw new Error('父任务授权未包含派发权限')
  if (depthOfRun(db, parentRunId) >= MAX_DELEGATION_DEPTH) throw new Error('已达到任务派发深度上限')
  if (plan) return { parent, state }
  const children = repos
    .listChildRuns(db, parentRunId)
    .filter((child) => child.controlMode === 'delegated')
    .map((child) => followTransfer(db, child))
    .filter((child) => !repos.isRunTerminal(child.status))
  const limit = controlMode === 'transferred' ? 0 : state.cluster ? 2 : 1
  if (children.length + (controlMode === 'transferred' ? 0 : count) > limit) {
    throw new Error('活动子任务超过并发上限')
  }
  return { parent, state }
}

const runQueue = createRunQueue({ launch: launchQueuedRun, shuttingDown: isShuttingDown })

function publishRegistration(db, row) {
  broadcast('chat:event', {
    type: 'snapshot',
    conversationId: row.conversationId,
    messages: [row.userMsgId, row.assistantMsgId].map((id) => msgOut(repos.getMessage(db, id)))
  })
  broadcast('agent:event', { type: 'queued', ...row })
}

function registerRuns(requests, { parentRunId, controlMode, idempotencyKey, plan = false } = {}) {
  const db = dbm.get()
  if (isShuttingDown()) throw new Error('应用正在退出，无法开始新的智能任务')
  const scope = parentRunId ? `parent:${parentRunId}` : 'root'
  const fingerprint = createHash('sha256')
    .update(
      canonicalJson({
        requests: JSON.parse(JSON.stringify(requests)),
        controlMode: controlMode || null
      })
    )
    .digest('hex')
  const graphId = plan ? repos.uid() : null
  let transferParent
  const rows = transaction(db, () => {
    if (idempotencyKey) {
      const prev = db
        .prepare('SELECT * FROM run_dispatch_requests WHERE scope=? AND request_key=?')
        .get(scope, idempotencyKey)
      if (prev) {
        if (prev.fingerprint !== fingerprint)
          throw remoteError('IDEMPOTENCY_CONFLICT', '请求编号已用于其他任务', 409)
        return JSON.parse(prev.run_ids).map((id) => {
          const run = getRunStatus(db, id)
          return {
            runId: id,
            conversationId: run.conversationId,
            status: run.status,
            userMsgId: run.userMessageId,
            assistantMsgId: run.assistantMessageId,
            graphId: run.graphId,
            nodeKey: run.nodeKey,
            reused: true
          }
        })
      }
    }
    const owner = parentRunId
      ? assertCanDelegate(db, parentRunId, controlMode, requests.length, { plan })
      : null
    const settings = repos.getAllSettings(db)
    const registered = requests.map((request) => {
      const goal = String(request.goal || '').trim()
      if (!goal) throw new Error('任务目标不能为空')
      let { conversationId } = request
      const parentConv = owner && repos.getConversation(db, owner.parent.conversationId)
      if (!conversationId && parentConv) {
        conversationId = repos.createConversation(db, {
          title: String(request.title || goal).slice(0, 80),
          origin: 'agent',
          parentId: parentConv.id,
          createdByRun: parentRunId,
          providerId: parentConv.providerId,
          model: parentConv.model,
          projectId: parentConv.projectId,
          systemPrompt: parentConv.systemPrompt
        }).id
      }
      const conv = repos.getConversation(db, conversationId)
      if (
        !conv ||
        (owner && (conv.parentId !== parentConv?.id || conv.projectId !== parentConv.projectId))
      ) {
        throw remoteError('INVALID_TARGET', '任务只能派发到本项目的直接子会话', 400)
      }
      if (
        db
          .prepare(
            `SELECT 1 FROM agent_runs
        WHERE conversation_id=? AND status IN ('queued','running','waiting_child')`
          )
          .get(conversationId) ||
        db
          .prepare(
            `SELECT 1 FROM messages WHERE conversation_id=? AND deleted_at IS NULL
          AND status='streaming'`
          )
          .get(conversationId)
      ) {
        throw remoteError('SESSION_BUSY', '会话正在执行', 409)
      }
      const { provider, model } = resolveModel(db, conversationId)
      if (!provider || !model) throw new Error('未配置模型服务或模型')
      const mandate = owner
        ? defaultSubMandate(owner.state.mandate)
        : normalizeMandate(request.mandate)
      let permission =
        request.permission === 'readonly' || request.permission === 'full'
          ? request.permission
          : 'autonomous'
      if (owner) permission = owner.state.permission === 'readonly' ? 'readonly' : 'autonomous'
      if (mandate?.permissionMode === 'readonly') permission = 'readonly'
      if (mandate && mandate.permissionMode !== 'full' && permission === 'full')
        permission = 'autonomous'
      const maxSteps = Math.min(
        Number(settings.agentMaxSteps) || 15,
        mandate?.limits.maxSteps || Infinity
      )
      const runId = repos.createRun(db, {
        conversationId,
        goal,
        maxSteps,
        status: 'queued',
        parentRunId,
        controlMode,
        mandate,
        acceptancePolicy: request.acceptancePolicy,
        traceId: owner ? owner.parent.traceId || parentRunId : request.traceId || repos.uid(),
        graphId,
        nodeKey: request.key || null
      })
      const first = repos.listMessages(db, conversationId).length === 0
      const user = repos.insertMessage(db, {
        conversationId,
        role: 'user',
        content: goal,
        meta: { agent: true, runId }
      })
      const assistant = repos.insertMessage(db, {
        conversationId,
        role: 'assistant',
        content: '',
        status: 'pending',
        meta: { agentRunId: runId }
      })
      db.prepare(
        `UPDATE agent_runs SET submitted_at=?,user_message_id=?,assistant_message_id=?,
        run_spec_json=? WHERE id=?`
      ).run(
        Date.now(),
        user.id,
        assistant.id,
        JSON.stringify({
          version: 1,
          providerId: provider.id,
          model,
          permission,
          cluster: !!(owner ? owner.state.cluster : request.cluster),
          projectId: conv.projectId,
          first,
          endpoint: provider.base_url,
          context: repos
            .listMessages(db, conversationId)
            .filter(
              (m) =>
                ['user', 'assistant'].includes(m.role) &&
                m.id !== user.id &&
                m.id !== assistant.id &&
                m.status === 'done'
            )
            .slice(-20)
            .map(({ role, content }) => ({ role, content: String(content).slice(0, 2000) })),
          systemPrompt: conv.systemPrompt || ''
        }),
        runId
      )
      repos.touchConversation(db, conversationId)
      recordRunState(db, runId)
      return {
        runId,
        conversationId,
        userMsgId: user.id,
        assistantMsgId: assistant.id,
        status: 'queued',
        graphId,
        nodeKey: request.key || null
      }
    })
    if (plan) {
      db.prepare(
        `INSERT INTO run_graphs(id, parent_run_id, conversation_id, status, created_at)
         VALUES(?,?,?,'running',?)`
      ).run(graphId, parentRunId, owner ? owner.parent.conversationId : null, Date.now())
      const byKey = new Map()
      requests.forEach((request, index) => byKey.set(request.key, registered[index].runId))
      graph.addDependencies(db, requests, byKey)
    }
    if (controlMode === 'transferred') {
      const target = registered[0]
      transition(db, parentRunId, { status: 'transferred' })
      db.prepare(
        `UPDATE agent_runs SET transfer_to_run_id=?,finished_reason='transferred' WHERE id=?`
      ).run(target.runId, parentRunId)
      const content = '任务已移交给子会话。'
      repos.updateMessage(db, owner.parent.assistantMessageId, { content, status: 'transferred' })
      transferParent = owner.state
    }
    if (idempotencyKey)
      db.prepare('INSERT INTO run_dispatch_requests VALUES(?,?,?,?)').run(
        scope,
        idempotencyKey,
        fingerprint,
        JSON.stringify(registered.map((row) => row.runId))
      )
    return registered
  })
  if (transferParent) transferParent.transferred = true
  for (const row of rows) if (!row.reused) publishRegistration(db, row)
  if (plan) rows.graphId = (rows[0] && rows[0].graphId) || graphId
  runQueue.schedule(db)
  return rows
}

async function startAgentRun({ parentRunId, controlMode, idempotencyKey, ...request }) {
  if (parentRunId && !['delegated', 'transferred'].includes(controlMode))
    throw new Error('非法任务关系')
  if (!parentRunId && controlMode) throw new Error('任务派生必须指定父任务')
  return registerRuns([request], {
    parentRunId: parentRunId || null,
    controlMode: controlMode || null,
    idempotencyKey
  })[0]
}

function registerPlan(tasks, { parentRunId, idempotencyKey } = {}) {
  const normalized = graph.validatePlan(tasks)
  const requests = normalized.map((task) => ({
    goal: task.goal,
    key: task.key,
    deps: task.deps,
    conversationId: task.conversationId,
    title: task.title
  }))
  const rows = registerRuns(requests, {
    parentRunId,
    controlMode: 'delegated',
    idempotencyKey,
    plan: true
  })
  return { graphId: rows.graphId || (rows[0] && rows[0].graphId) || null, runs: rows }
}

function getGraphForParent(parentRunId) {
  const db = dbm.get()
  const g = graph.getGraphForParent(db, parentRunId)
  return g ? graph.summary(db, g.id) : null
}

function launchQueuedRun(db, runId) {
  const run = repos.getRun(db, runId)
  const { conversationId, assistantMessageId: assistantMsgId, goal } = run
  const spec = safeJson(run.runSpecJson)
  const conv = repos.getConversation(db, conversationId)
  const { provider, model } = resolveModel(db, conversationId)
  if (
    spec?.version !== 1 ||
    !conv ||
    conv.projectId !== spec.projectId ||
    !provider ||
    provider.id !== spec.providerId ||
    model !== spec.model ||
    provider.base_url !== spec.endpoint
  ) {
    finishRun(db, run, {
      status: 'error',
      reason: 'configuration_changed',
      content: '任务配置已变更，请重新派发。'
    })
    runQueue.release(db, runId)
    return
  }
  transaction(db, () => {
    transition(db, runId, { status: 'running' })
    db.prepare('UPDATE agent_runs SET claimed_at=?,started_at=? WHERE id=?').run(
      Date.now(),
      Date.now(),
      runId
    )
    repos.updateMessage(db, assistantMsgId, { status: 'streaming' })
  })
  const settings = repos.getAllSettings(db)
  const state = {
    ac: new AbortController(),
    stopped: false,
    remember: new Set(),
    confirms: new Map(),
    parentRunId: run.parentRunId,
    controlMode: run.controlMode,
    pauseNotified: false,
    mandate: normalizeMandate(safeJson(run.mandateJson)),
    traceId: run.traceId,
    permission: spec.permission,
    cluster: spec.cluster,
    maxSteps: run.maxSteps
  }
  active.set(runId, state)
  getHub().emit('run.start', {
    runId,
    conversationId,
    parentRunId: run.parentRunId,
    traceId: run.traceId
  })
  broadcast('chat:event', {
    type: 'snapshot',
    conversationId,
    messages: [msgOut(repos.getMessage(db, assistantMsgId))]
  })
  broadcast('agent:event', {
    type: 'started',
    runId,
    assistantMsgId,
    conversationId,
    status: 'running'
  })
  if (spec.first) {
    title
      .titleConversation(
        { dbm, repos, scheduler, chatOnce, resolveModel, decryptSecret, broadcast },
        { conversationId, content: goal }
      )
      .catch(() => {})
  }
  state.done = doAgentRun({
    runId,
    conversationId,
    assistantMsgId,
    provider,
    model,
    goal,
    state,
    acceptancePolicy: safeJson(run.acceptancePolicy),
    settings,
    spec
  })
    .catch((error) => {
      const current = repos.getRun(db, runId)
      if (current && !repos.isRunTerminal(current.status)) {
        finishRun(db, current, {
          status: 'error',
          reason: 'runner_error',
          content: String(error.message)
        })
      }
      cancelChildren(db, runId)
      console.error('AGENT_RUN_FAILED', error)
    })
    .finally(() => {
      active.delete(runId)
      runQueue.release(db, runId)
    })
}

function finishRun(db, run, { status, reason, content, stepsUsed, acceptanceStatus }) {
  if (!repos.isRunTerminal(run.status)) {
    transaction(db, () => {
      transition(db, run.id, { status, stepsUsed, acceptanceStatus })
      db.prepare('UPDATE agent_runs SET finished_reason=? WHERE id=?').run(reason || status, run.id)
      repos.updateMessage(db, run.assistantMessageId, { content: content || '', status })
      repos.touchConversation(db, run.conversationId)
    })
  } else {
    status = run.status
    content = repos.getMessage(db, run.assistantMessageId)?.content || ''
  }
  getHub().emit('run.end', { runId: run.id, conversationId: run.conversationId, status })
  broadcast('chat:event', {
    type: ['interrupted', 'stopped', 'error'].includes(status)
      ? status === 'interrupted'
        ? 'stopped'
        : status
      : 'done',
    conversationId: run.conversationId,
    msgId: run.assistantMessageId,
    content,
    status
  })
  broadcast('agent:event', {
    type: 'done',
    runId: run.id,
    conversationId: run.conversationId,
    assistantMsgId: run.assistantMessageId,
    status,
    content,
    transferToRunId: run.transferToRunId
  })
  if (run.graphId) {
    if (status !== 'done') {
      for (const id of graph.blockedDependents(db, run.id)) {
        const child = repos.getRun(db, id)
        if (!child || repos.isRunTerminal(child.status)) continue
        finishRun(db, child, {
          status: 'stopped',
          reason: 'dependency_failed',
          content: `前置任务 ${run.nodeKey || run.id} 未成功，已停止。`
        })
      }
    }
    const refreshed = graph.refreshGraph(db, run.graphId)
    if (refreshed && refreshed.status !== 'running') {
      getHub().emit('graph.finished', {
        graphId: run.graphId,
        parentRunId: refreshed.parent_run_id,
        status: refreshed.status
      })
      broadcast('agent:event', {
        type: 'graph',
        graphId: run.graphId,
        status: refreshed.status
      })
    }
  }
}

async function waitForIds(db, runId, state, ids, timeoutMs, extra = {}) {
  if (state.stopped) throw new Error('任务已停止')
  transaction(db, () => transition(db, runId, { status: 'waiting_child' }))
  runQueue.release(db, runId)
  const conversationId = repos.getRun(db, runId).conversationId
  broadcast('agent:event', { type: 'state', runId, conversationId, status: 'waiting_child' })
  try {
    const result = await waitForRuns(db, { runIds: ids, timeoutMs, signal: state.ac.signal })
    return { ...extra, ...result }
  } finally {
    if (!state.stopped && (await runQueue.acquire(db, runId, state.ac.signal))) {
      transaction(db, () => transition(db, runId, { status: 'running' }))
      broadcast('agent:event', { type: 'state', runId, conversationId, status: 'running' })
    } else if (!state.stopped) {
      stopRun(runId, 'app_quit')
    }
  }
}

async function waitForChildren(db, runId, state, { runIds, timeoutMs }) {
  const ids = Array.isArray(runIds) ? [...new Set(runIds)] : []
  if (
    !ids.length ||
    ids.length > 2 ||
    ids.some((id) => {
      const child = repos.getRun(db, id)
      return !child || child.parentRunId !== runId || child.controlMode !== 'delegated'
    })
  )
    throw new Error('只能等待本任务直接派发的子任务')
  return waitForIds(db, runId, state, ids, timeoutMs)
}

async function waitForGraph(db, runId, state, { graphId, timeoutMs }) {
  const g = graph.getGraph(db, graphId)
  if (!g || g.parent_run_id !== runId) throw new Error('任务图不属于当前任务')
  const ids = graph.listNodes(db, graphId).map((node) => node.id)
  if (!ids.length) throw new Error('任务图没有节点')
  return waitForIds(db, runId, state, ids, timeoutMs, { graphId })
}

async function doAgentRun({
  runId,
  conversationId,
  assistantMsgId,
  provider,
  model,
  goal,
  state,
  acceptancePolicy,
  settings: inherited,
  spec
}) {
  const db = dbm.get()
  const settings = inherited || repos.getAllSettings(db)
  const conv = repos.getConversation(db, conversationId)
  const params = resolveAgentParams(settings, conv, provider, model)
  const electron = require('electron')
  const ctx = {
    authorizedDirs: settings.agentAuthorizedDirs || [],
    workingDir: resolveWorkingDir(db, conversationId, settings),
    clipboard: electron.clipboard,
    shell: electron.shell,
    todo: { seq: 0, items: [] },
    memoryPath: path.join(electron.app.getPath('userData'), 'agent-memory.md'),
    browserFactory: (opts) => new electron.BrowserWindow(opts),
    mcpServers: parseMcpServers(settings.agentMcpServers),
    tavilyKey: settings.tavilyApiKey || '',
    webSearchProvider: settings.webSearchProvider || 'auto',
    // 会话管理：供 session_* 工具创建/驱动子会话
    sessionRunId: runId,
    sessionConversationId: conversationId,
    sessionPermission: state.permission,
    sessionCluster: state.cluster
  }
  // 会话管理：子会话继承本运行的权限等级，不擅自提权。
  // 参数透传与目标会话归属校验集中在 session-bridge，便于单测覆盖。
  const sessionApi = require('./sessions')
  const sessionBridge = createSessionBridge({
    db,
    repos,
    sessionsApi: sessionApi,
    conversationId,
    runId,
    state
  })
  ctx.createSession = (opts) => {
    if (opts.projectId && opts.projectId !== conv?.projectId) {
      throw remoteError('INVALID_TARGET', '子会话必须属于当前项目', 400)
    }
    return sessionBridge.createSession(opts)
  }
  ctx.sendToSession = (opts) => {
    if (opts.mode !== 'agent' && state.mandate) throw new Error('受限任务不能发起独立聊天请求')
    assertSessionAccess(opts.conversationId)
    return sessionBridge.sendToSession(opts)
  }
  const ownChild = (id) => {
    const run = repos.getRun(db, id)
    if (!run || run.parentRunId !== runId) throw new Error('目标任务不属于当前运行')
    return run
  }
  const dispatch = (controlMode, { goal, conversationId: targetId, title }, callId) =>
    startAgentRun({
      parentRunId: runId,
      controlMode,
      goal,
      conversationId: targetId,
      title,
      idempotencyKey: callId
    })
  ctx.runPlan = (opts, callId) =>
    registerPlan(opts.tasks, { parentRunId: runId, idempotencyKey: callId })
  ctx.runDispatch = (opts, callId) => dispatch('delegated', opts, callId)
  ctx.runTransfer = (opts, callId) => dispatch('transferred', opts, callId)
  ctx.runStatus = ({ runId: id }) => getRunStatus(db, ownChild(id).id)
  ctx.runResult = ({ runId: id, maxChars }) => getRunResult(db, ownChild(id).id, maxChars)
  ctx.runWait = (opts) =>
    opts && opts.graphId
      ? waitForGraph(db, runId, state, opts)
      : waitForChildren(db, runId, state, opts)
  ctx.runCancel = ({ runId: id, graphId }) => {
    if (graphId) {
      const g = graph.getGraph(db, graphId)
      if (!g || g.parent_run_id !== runId) throw new Error('任务图不属于当前任务')
      let requested = false
      for (const node of graph.listNodes(db, graphId)) {
        if (repos.isRunTerminal(node.status)) continue
        if (stopRun(node.id, 'user')) requested = true
      }
      const refreshed = graph.refreshGraph(db, graphId)
      return {
        requested,
        graphId,
        status: refreshed && refreshed.status,
        ...graph.summary(db, graphId)
      }
    }
    const child = ownChild(id)
    if (child.controlMode !== 'delegated') throw new Error('移交任务由接手方控制')
    const target = followTransfer(db, child)
    return { requested: stopRun(target.id), ...getRunStatus(db, target.id) }
  }
  const assertSessionAccess = (id) => {
    const target = repos.getConversation(db, id)
    if (
      !target ||
      target.projectId !== conv?.projectId ||
      (target.id !== conversationId && target.parentId !== conversationId)
    ) {
      throw new Error('目标会话不属于当前运行')
    }
  }
  ctx.getSessionStatus = (opts) => {
    assertSessionAccess(opts.conversationId)
    return sessionBridge.getSessionStatus(opts)
  }
  ctx.getSessionResult = (opts) => {
    assertSessionAccess(opts.conversationId)
    return sessionBridge.getSessionResult(opts)
  }
  ctx.waitForSession = async (opts) => {
    assertSessionAccess(opts.conversationId)
    if (opts.conversationId === conversationId) throw new Error('不能等待当前任务所在的会话')
    const snapshot = sessionBridge.getSessionStatus(opts)
    const target = snapshot.runId && repos.getRun(db, snapshot.runId)
    if (target && target.parentRunId === runId && target.controlMode === 'delegated') {
      const result = await ctx.runWait({ runIds: [target.id], timeoutMs: opts.timeoutMs })
      return { ...snapshot, ...result.runs[0], timedOut: result.timedOut }
    }
    return sessionBridge.waitForSession({ ...opts, signal: state.ac.signal })
  }
  ctx.listSessions = (opts) => {
    if (opts.parentId) assertSessionAccess(opts.parentId)
    if (opts.parentId && opts.parentId !== conversationId)
      throw new Error('只能列出当前会话的子会话')
    return sessionBridge.listSessions(opts)
  }

  // 钩子规则来自用户设置，模型无法改动；此处解析一次，运行内复用
  const hookRules = parseHooks(settings.agentHooks)
  const hookSink = {
    broadcast,
    log: (entry) => getHub().emit('hook.fired', entry)
  }
  const tools = defineTools(ctx)
  const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]))
  const memoryText = readMemoryFile(ctx.memoryPath)
  const clusterNote = state.cluster
    ? '\n\n当前已开启 Agent 集群：遇到可拆分的独立子任务时，请调用 spawn_agent 并行派出多个子 Agent 分别处理，最后由你汇总结果。'
    : ''
  const permissionNote =
    state.permission === 'readonly'
      ? '\n\n当前权限为只读任务模式：仅可使用只读工具（读文件、列目录、搜索文件、内容检索、网页搜索/抓取、会话状态查询等）。写文件、改文件、执行命令、剪贴板、打开链接、更新待办与长期记忆等写入类操作会被直接拒绝，且不会请求用户确认。请只用只读方式完成任务，不要尝试写入操作。'
      : state.permission === 'full'
        ? '\n\n当前权限为完整权限：非只读工具调用将直接执行，不再逐次请求用户确认；仍须严格遵守授权目录限制。'
        : ''
  const messages = [
    {
      role: 'system',
      content:
        '你是运行在用户 Windows 桌面上的 Agent。谨慎使用工具完成目标；写文件和执行命令前先用一句话说明计划。基于工具返回结果作答，不要臆造。' +
        (state.parentRunId ? '\n你是被主 Agent 派出的子 Agent，请根据独立目标完成任务。' : '') +
        (spec.systemPrompt ? '\n' + spec.systemPrompt : '') +
        permissionNote +
        clusterNote +
        (memoryText ? `\n\n以下是你的长期记忆（供参考，可按需更新）:\n${memoryText}` : '')
    },
    ...(Array.isArray(spec.context) ? spec.context : []),
    { role: 'user', content: goal }
  ]
  const startedAt = Date.now()
  let lastDecision = { allowed: true, confirmedBy: 'auto' }
  let callCount = 0
  let finalContent = ''
  let stepsUsed = 0
  let status = 'done'

  // 旧流隔离：Run 仍是本进程内当前活动的那一个，且未被停止。
  // 被 stopRun / 移交 / 替换后，任何迟到回调都不得写入或广播。
  const isCurrentRun = () => {
    if (state.stopped || state.transferred) return false
    const cur = active.get(runId)
    return !!cur && cur === state
  }

  // 迟到事件审计：只记一次每条 Run 的第一条，避免刷屏
  let staleNoted = false
  const noteStaleEvent = (kind) => {
    if (staleNoted) return
    staleNoted = true
    try {
      getHub().emit('stale_event_ignored', {
        runId,
        traceId: state.traceId,
        conversationId,
        kind,
        reason: state.stopped ? 'stopped' : 'replaced'
      })
    } catch {
      // 事件中枢不可用时不影响主流
    }
  }

  state.releaseSlot = () => runQueue.release(db, runId)
  state.acquireSlot = () => runQueue.acquire(db, runId, state.ac.signal)
  const modelCallWith = (apiKey) => async (msgs) => {
    if (!(await getControlRuntime(db).runs.checkpoint(runId, state)))
      return { content: '', toolCalls: [], stopped: true }
    const payload = { model, messages: msgs, stream: true, tools: toolSchemas(tools) }
    const tokenLimit = Math.min(
      Number(params.maxTokens) || Infinity,
      state.mandate?.limits.maxTokens || Infinity
    )
    if (Number.isFinite(tokenLimit)) payload.max_tokens = tokenLimit
    if (Number(params.temperature) >= 0) payload.temperature = Number(params.temperature)
    if (Number(params.topP) > 0) payload.top_p = Number(params.topP)
    const r = await chatStream(
      { baseUrl: provider.base_url, apiKey, payload },
      {
        signal: state.ac.signal,
        onDelta: (d) => {
          // 旧流隔离（方案四 §5.3）：被取消/移交/替换的 Run 不得继续广播增量。
          // 迟到的 token 一律丢弃并记审计，不依赖 Renderer 过滤。
          if (!isCurrentRun()) {
            noteStaleEvent('delta')
            return
          }
          broadcast('chat:event', {
            type: 'delta',
            conversationId,
            msgId: assistantMsgId,
            delta: d
          })
        }
      }
    )
    return r
  }
  const decide = async ({ name, args, riskLevel }) => {
    const risk = escalateRisk(name, args, riskLevel)
    // 每条返回路径都要写回 lastDecision，否则日志里的「确认方式」会沿用上一步的旧值
    const settle = (decision) => {
      lastDecision = { allowed: !!decision.allowed, confirmedBy: decision.confirmedBy }
      return decision
    }
    // tool.before 钩子：只能更严格（把允许改成拒绝），不能把需要确认的调用放行
    const gate = applyHooks(
      hookRules,
      'tool.before',
      { tool: name, runId, conversationId, riskLevel: risk },
      hookSink
    )
    getHub().emit('tool.before', {
      runId,
      conversationId,
      tool: name,
      riskLevel: risk,
      blockedByHook: gate.blocked || null
    })
    if (gate.blocked) return settle({ allowed: false, confirmedBy: `hook:${gate.blockedBy}` })
    if (risk === 'readonly') return settle({ allowed: true, confirmedBy: 'auto' })
    // 只读权限：非只读工具直接拒绝，不弹确认卡；与 full 的 permission:full 标记对称。
    // 插在 remember 会话记忆之前，保证记忆集合无法绕过 readonly 限制。
    if (state.permission === 'readonly' && risk !== 'readonly') {
      // 系统性策略拒绝，与 mandate.denied 同性质：落 agent_tool_calls 审计
      repos.logToolCall(db, {
        runId,
        step: ++callCount,
        tool: name,
        args,
        riskLevel: risk,
        confirmedBy: 'permission:readonly',
        result: null,
        error: '授权拒绝: 只读模式不允许写入类工具',
        durationMs: 0
      })
      return settle({
        allowed: false,
        confirmedBy: 'permission:readonly',
        denyMessage:
          '只读任务模式下该操作被拒绝：仅允许只读工具（读文件、搜索、网页查询等）。请改用只读方式完成，或建议用户切换到自主/完整权限。'
      })
    }
    if (state.stopped) return settle({ allowed: false, confirmedBy: 'stopped' })
    if (!(await getControlRuntime(db).runs.checkpoint(runId, state)))
      return settle({ allowed: false, confirmedBy: 'stopped' })
    // 完整权限：用户已在输入区显式选择，不再逐次弹确认，但审计记录标记来源
    if (state.permission === 'full')
      return settle({ allowed: true, confirmedBy: 'permission:full' })
    if (risk === 'side_effect' && state.remember.has(name))
      return settle({ allowed: true, confirmedBy: 'session' })
    const decision = await getControlRuntime(db).approvals.decide({
      runId,
      conversationId,
      name,
      args,
      riskLevel: risk
    })
    return settle({
      allowed: !!decision.allowed,
      confirmedBy:
        decision.confirmedBy || (decision.allow ? 'user' : decision.timedOut ? 'timeout' : 'denied')
    })
  }
  const execute = async (tool, args, callId) => {
    const t0 = Date.now()
    let resultText = ''
    let error = null
    if (!(await getControlRuntime(db).runs.checkpoint(runId, state))) throw new Error('任务已停止')

    // 旧流隔离（方案四 §5.3）：Run 已被取消或替换后，不得再执行任何工具。
    // 必须在授权校验与 handler 调用之前拦截，否则旧流会产生真实副作用。
    if (!isCurrentRun()) {
      noteStaleEvent('tool-call')
      throw new Error('任务已结束，工具调用被丢弃')
    }

    // 强制授权校验：发生在任何副作用之前（方案四 §4.4）。
    // Hook 与提示词只作辅助，不能替代此处；所有工具路径（含子 Agent）都经过 execute。
    const decision = authorizeToolCall({
      toolName: tool.name,
      args,
      mandate: state.mandate,
      riskLevel: tool.risk
    })
    if (!decision.allowed) {
      getHub().emit('mandate.denied', {
        runId,
        traceId: state.traceId,
        conversationId,
        tool: tool.name,
        reason: decision.reason,
        detail: String(decision.detail || '').slice(0, 200)
      })
      repos.logToolCall(db, {
        runId,
        step: ++callCount,
        tool: tool.name,
        args,
        riskLevel: tool.risk,
        confirmedBy: `mandate:${decision.reason}`,
        result: null,
        error: `授权拒绝: ${decision.detail || decision.reason}`,
        durationMs: Date.now() - t0
      })
      throw new Error(`授权拒绝：${decision.detail || decision.reason}`)
    }

    try {
      const r = await tool.handler(args, callId)
      resultText = typeof r === 'string' ? r : JSON.stringify(r)
    } catch (e) {
      error = String((e && e.message) || e)
      resultText = '工具执行失败: ' + error
    }
    callCount++
    repos.logToolCall(db, {
      runId,
      step: callCount,
      tool: tool.name,
      args,
      riskLevel: tool.risk,
      confirmedBy: lastDecision.confirmedBy,
      result: resultText,
      error,
      durationMs: Date.now() - t0
    })
    const after = applyHooks(
      hookRules,
      'tool.after',
      { tool: tool.name, runId, conversationId, ok: !error },
      hookSink
    )
    getHub().emit('tool.after', {
      runId,
      conversationId,
      tool: tool.name,
      ok: !error,
      error: error ? String(error).slice(0, 200) : null,
      durationMs: Date.now() - t0,
      notified: after.notifications.length
    })
    if (error) throw new Error(error)
    return resultText
  }
  const onEvent = (type, payload) => broadcast('agent:event', { type, runId, ...payload })

  ctx.spawnAgent = async ({ goal, goals }, callId) => {
    const list = goals?.length ? goals : [goal]
    const rows = registerRuns(
      list.map((item) => ({ goal: item })),
      {
        parentRunId: runId,
        controlMode: 'delegated',
        idempotencyKey: callId
      }
    )
    const result = await ctx.runWait({ runIds: rows.map((row) => row.runId) })
    const parts = result.runs.map((item) =>
      item.status === 'done'
        ? item.content
        : `${item.status}（${item.runId}）：${item.content || item.finishedReason || '可用 run_status 查询'}`
    )
    return parts.length === 1
      ? parts[0]
      : parts.map((item, i) => `【子任务 ${i + 1}】\n${item}`).join('\n\n')
  }

  try {
    const result = await runAgentLoop({
      messages,
      maxSteps: state.maxSteps,
      toolMap,
      isStopped: () => state.stopped,
      isTransferred: () => !!state.transferred,
      modelCall: (msgs) => withKeyRetry(db, provider, (apiKey) => modelCallWith(apiKey)(msgs)),
      decide,
      execute,
      onEvent
    })
    finalContent = lastAssistantContent(result.messages)
    stepsUsed = result.steps
    status = result.status === 'done' ? 'done' : result.status
  } catch (e) {
    if (e && e.name === 'AbortError') {
      status = 'stopped'
    } else {
      status = 'error'
      finalContent =
        (finalContent ? finalContent + '\n\n' : '') +
        `> ⚠ Agent 出错：${String((e && e.message) || e)}`
    }
  }

  // 空输出不得算作成功（方案四 §5.5）：done 但无有效内容 → 判为 error。
  // '(无输出)' 只是展示占位，不是交付物。
  const hasDeliverable = String(finalContent || '').trim().length > 0
  let finalStatus = status
  if (status === 'done' && !hasDeliverable) {
    finalStatus = 'error'
    getHub().emit('run.empty_result', {
      runId,
      traceId: state.traceId,
      conversationId,
      stepsUsed
    })
  }

  status = state.transferred ? 'transferred' : state.stopped ? 'stopped' : finalStatus
  if (!state.transferred) cancelChildren(db, runId)
  finishRun(db, repos.getRun(db, runId), {
    status,
    reason: state.stopReason,
    content: finalContent,
    stepsUsed,
    acceptanceStatus: acceptancePolicy && status === 'done' ? 'pending' : null
  })
  if (acceptancePolicy && status === 'done') {
    acceptance.queueAcceptance(
      {
        db,
        repos,
        chatOnce,
        scheduler,
        decryptSecret,
        resolveModel,
        broadcast,
        emit: (type, payload) => getHub().emit(type, payload)
      },
      runId
    )
  }
  if (ctx._browser) {
    try {
      ctx._browser.close()
    } catch {
      // 窗口可能已被销毁
    }
  }
  applyHooks(
    hookRules,
    'run.end',
    { runId, conversationId, status, durationMs: Date.now() - startedAt },
    hookSink
  )
}

function respondConfirm({ requestId, allow, remember }) {
  return getControlRuntime(dbm.get()).approvals.respond({
    approvalId: requestId,
    decision: allow ? 'approved' : 'rejected',
    actor: 'desktop',
    reason: remember ? 'remember_not_supported' : ''
  }).ok
}

function decideAcceptance(input) {
  return acceptance.decideAcceptance(
    {
      db: dbm.get(),
      repos,
      broadcast,
      emit: (type, payload) => getHub().emit(type, payload)
    },
    input
  )
}

function stopRun(runId, reason = 'user', context = {}) {
  const db = dbm.get()
  const run = repos.getRun(db, runId)
  if (!run || repos.isRunTerminal(run.status)) return false
  const state = active.get(runId)
  if (state?.stopped) return true
  if (state) {
    state.stopped = true
    state.stopReason = reason
    state.ac.abort()
    getControlRuntime(db).approvals.cancelRun(runId, reason)
    const pending = [...state.confirms.keys()]
    state.confirms.clear()
    if (pending.length) broadcast('agent:confirmCancel', { runId, requestIds: pending })
  } else if (run.status === 'queued') {
    finishRun(db, run, { status: 'stopped', reason, content: '任务已停止。' })
    runQueue.schedule(db)
  } else {
    return false
  }
  cancelChildren(db, runId)
  getHub().emit('run.abort_requested', {
    runId,
    traceId: run.traceId,
    reason,
    actor: context.actor || 'desktop'
  })
  return true
}

function cancelChildren(db, runId) {
  for (const child of repos.listChildRuns(db, runId)) {
    if (child.controlMode === 'delegated') {
      stopRun(followTransfer(db, child).id, 'parent_finished')
    }
  }
}

function resumeQueuedRuns() {
  runQueue.schedule(dbm.get())
}

function listActiveRuns() {
  return [...active.keys()]
}

async function stopAllRuns() {
  const current = [...active.entries()]
  for (const [runId] of current) stopRun(runId, 'app_quit', { actor: 'desktop' })
  await Promise.allSettled(current.map(([, state]) => state.done))
  // 只清理本次快照：退出期间新登记的运行不归这里管（入口已由 isShuttingDown 拦截）。
  for (const [runId, state] of current) {
    if (active.get(runId) === state) active.delete(runId)
  }
  controlRuntime = null
}

function getApprovalService() {
  return getControlRuntime(dbm.get()).approvals
}
function pauseRun(runId, actor = 'desktop') {
  return getControlRuntime(dbm.get()).runs.request(runId, 'pause', actor)
}
function resumeRun(runId, actor = 'desktop') {
  return getControlRuntime(dbm.get()).runs.request(runId, 'resume', actor)
}

module.exports = {
  startAgentRun,
  getGraphForParent,
  resumeQueuedRuns,
  getRunStatus: (id) => getRunStatus(dbm.get(), id),
  getRunResult: (id, maxChars) => getRunResult(dbm.get(), id, maxChars),
  respondConfirm,
  decideAcceptance,
  getApprovalService,
  pauseRun,
  resumeRun,
  stopRun,
  stopAllRuns,
  listActiveRuns,
  summarize,
  resolveWorkingDir,
  resolveAgentParams
}
