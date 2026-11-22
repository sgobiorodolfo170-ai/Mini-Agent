const os = require('os')
const path = require('path')
const repos = require('../../store/repos')
const dbm = require('../../store/db')
const { chatStream, GatewayError } = require('../gateway/client')
const scheduler = require('../gateway/scheduler')
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

const active = new Map() // runId -> { ac, stopped, remember:Set, confirms:Map }

// 确认请求的最长等待时间：超时按拒绝处理，避免隐藏窗口里的任务永久挂起
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000

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

// 最大派生深度（方案四 §7.1）：沿 parent_run_id 链计算，默认只允许一层。
// 集中在此处配置，禁止各模块硬编码不同值。
const MAX_DELEGATION_DEPTH = 1

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
function assertCanDelegate(db, parentRunId) {
  const parent = repos.getRun(db, parentRunId)
  if (!parent) throw new Error('父任务不存在')
  if (!['running', 'waiting_child'].includes(parent.status)) {
    throw new Error(`父任务状态 ${parent.status} 不允许派生`)
  }
  if (parent.controlMode === 'transferred') throw new Error('已移交的任务不可再派生')
  if (parent.parentRunId && !parent.mandateJson) throw new Error('父任务缺少授权快照')
  // 深度：沿 parent_run_id 链
  if (depthOfRun(db, parentRunId) + 1 > MAX_DELEGATION_DEPTH) {
    throw new Error(`派生深度已达上限(${MAX_DELEGATION_DEPTH} 层)`)
  }
  // 同一父 Run 同时只允许一个活动子 Run（方案四 §6.4）
  const activeChildren = repos.listActiveChildRuns(db, parentRunId)
  if (activeChildren.length) throw new Error('父任务已有进行中的子任务，暂不可再派生')
  if (parent.mandateJson) {
    let pm = null
    try {
      pm = JSON.parse(parent.mandateJson)
    } catch {
      pm = null
    }
    if (pm && pm.canDelegate !== true) throw new Error('父任务授权未包含派生权限')
  }
  return parent
}

async function startAgentRun({
  conversationId,
  goal,
  permission,
  cluster,
  parentRunId,
  controlMode,
  mandate,
  acceptancePolicy,
  traceId,
  idempotencyKey
}) {
  const db = dbm.get()
  const { provider, model } = resolveModel(db, conversationId)
  if (!provider) throw new Error('未配置模型服务')
  if (!model) throw new Error('未配置模型')
  const settings = repos.getAllSettings(db)

  // 子任务：先校验父任务与授权，再求交得到有效权限
  let effectiveMandate = normalizeMandate(mandate)
  let inheritedTrace = traceId || null
  if (parentRunId) {
    if (!controlMode || !['delegated', 'transferred'].includes(controlMode)) {
      throw new Error('派生任务必须指定 controlMode: delegated 或 transferred')
    }
    const parent = assertCanDelegate(db, parentRunId)
    let parentMandate = null
    try {
      parentMandate = parent.mandateJson ? JSON.parse(parent.mandateJson) : null
    } catch {
      parentMandate = null
    }
    // 无 mandate 时不得全继承：收敛到受限默认（方案四 §4.3）
    effectiveMandate = effectiveMandate
      ? require('./mandate').intersectMandate(parentMandate, effectiveMandate)
      : defaultSubMandate(parentMandate)
    inheritedTrace = parent.traceId || parent.id
  } else if (!inheritedTrace) {
    inheritedTrace = repos.uid()
  }

  const runId = repos.createRun(db, {
    conversationId,
    goal,
    maxSteps: Number(settings.agentMaxSteps) || 15,
    parentRunId: parentRunId || null,
    controlMode: parentRunId ? controlMode : null,
    mandate: effectiveMandate,
    acceptancePolicy: acceptancePolicy || null,
    traceId: inheritedTrace,
    idempotencyKey: idempotencyKey || null
  })

  // 委派：同一事务内把父 Run 置为 waiting_child；移交：父 Run 置终态。
  // 先建子 Run 再改父状态，任一失败都不会造成任务丢失（方案四 §6.2）。
  if (parentRunId) {
    const parentTarget = controlMode === 'transferred' ? 'transferred' : 'waiting_child'
    const upd = repos.updateRunStatus(db, parentRunId, { status: parentTarget })
    if (!upd.ok) {
      // 回滚子 Run，避免出现孤儿任务
      db.prepare('DELETE FROM agent_runs WHERE id = ?').run(runId)
      throw new Error(`父任务状态更新失败：${upd.reason}`)
    }
  }
  const userMsg = repos.insertMessage(db, {
    conversationId,
    role: 'user',
    content: goal,
    meta: { agent: true, runId }
  })
  const assistant = repos.insertMessage(db, {
    conversationId,
    role: 'assistant',
    content: '',
    status: 'streaming',
    meta: { agentRunId: runId }
  })
  const state = {
    ac: new AbortController(),
    stopped: false,
    remember: new Set(),
    confirms: new Map(),
    // 父运行：子会话里的运行由此派生，用于会话管理与审计回溯
    parentRunId: parentRunId || null,
    controlMode: parentRunId ? controlMode : null,
    // 本次 Run 的授权快照：运行期不可被模型扩大（方案四 §4.1）
    mandate: effectiveMandate,
    traceId: inheritedTrace,
    // 权限等级：readonly = 仅只读工具、写入类直接拒绝；full = 所有非只读调用直接放行（不再逐次确认）
    permission: permission === 'readonly' || permission === 'full' ? permission : 'autonomous',
    // Agent 集群：允许派生多个子 Agent 并行处理子任务
    cluster: !!cluster
  }
  active.set(runId, state)
  const hub = getHub()
  hub.emit('run.start', {
    runId,
    conversationId,
    parentRunId: state.parentRunId,
    controlMode: state.controlMode,
    traceId: state.traceId,
    goal: String(goal || '').slice(0, 200),
    permission: state.permission,
    cluster: state.cluster
  })
  broadcast('chat:event', {
    type: 'snapshot',
    conversationId,
    messages: [msgOut(repos.getMessage(db, userMsg.id)), msgOut(repos.getMessage(db, assistant.id))]
  })
  broadcast('agent:event', { type: 'started', runId, assistantMsgId: assistant.id, conversationId })
  doAgentRun({
    runId,
    conversationId,
    assistantMsgId: assistant.id,
    provider,
    model,
    goal,
    state,
    acceptancePolicy,
    settings
  }).catch(() => {})
  return { runId, userMsgId: userMsg.id, assistantMsgId: assistant.id }
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
  settings: inherited
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
  // 会话管理：子会话继承本运行的权限等级，不擅自提权
  const sessionApi = require('./sessions')
  ctx.createSession = (opts) =>
    sessionApi.createSession({
      ...opts,
      parentConversationId: conversationId,
      runId
    })
  ctx.sendToSession = ({ conversationId: targetId, content, mode }) => {
    // 只允许向「本运行派生的子会话」或本会话发送，避免跨会话乱发
    const target = repos.getConversation(db, targetId)
    if (!target) throw new Error('目标会话不存在')
    const isChild = target.parentId === conversationId
    const isSelf = target.id === conversationId
    if (!isChild && !isSelf) throw new Error('只能向本会话或其派生的子会话发送提示词')
    return sessionApi.sendToSession({
      conversationId: targetId,
      content,
      permission: mode === 'agent' ? state.permission : 'default',
      cluster: state.cluster,
      runId
    })
  }
  ctx.getSessionStatus = (opts) => sessionApi.getSessionStatus(opts)
  ctx.waitForSession = (opts) => sessionApi.waitForSession(opts)
  ctx.getSessionResult = (opts) => sessionApi.getSessionResult(opts)
  ctx.listSessions = (opts) => sessionApi.listSessions({ ...opts, runId })

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
        permissionNote +
        clusterNote +
        (memoryText ? `\n\n以下是你的长期记忆（供参考，可按需更新）:\n${memoryText}` : '')
    },
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
    if (state.stopped) return false
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

  const modelCallWith = (apiKey) => async (msgs) => {
    const payload = { model, messages: msgs, stream: true, tools: toolSchemas(tools) }
    if (Number(params.maxTokens)) payload.max_tokens = Number(params.maxTokens)
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
    // 完整权限：用户已在输入区显式选择，不再逐次弹确认，但审计记录标记来源
    if (state.permission === 'full')
      return settle({ allowed: true, confirmedBy: 'permission:full' })
    if (risk === 'side_effect' && state.remember.has(name))
      return settle({ allowed: true, confirmedBy: 'session' })
    const requestId = repos.uid()
    const decision = await new Promise((resolve) => {
      // 等待用户确认期间可能有超时/停止两条退出路径，用 settled 保证只 resolve 一次
      let settled = false
      const finish = (d) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        state.confirms.delete(requestId)
        resolve(d)
      }
      // 主窗隐藏到托盘时确认卡不可见，任务会无限期挂起；超时按拒绝处理并告知前端
      const timer = setTimeout(() => {
        finish({ allow: false, remember: false, timedOut: true })
        broadcast('agent:confirmTimeout', { requestId, runId, tool: name })
      }, CONFIRM_TIMEOUT_MS)
      if (timer.unref) timer.unref()
      state.confirms.set(requestId, finish)
      broadcast('agent:confirm', {
        requestId,
        runId,
        tool: name,
        args,
        riskLevel: risk,
        summary: summarize(name, args)
      })
    })
    if (decision.allow && decision.remember) state.remember.add(name)
    return settle({
      allowed: !!decision.allow,
      confirmedBy: decision.allow ? 'user' : decision.timedOut ? 'timeout' : 'denied'
    })
  }
  const execute = async (tool, args) => {
    const t0 = Date.now()
    let resultText = ''
    let error = null

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
      const r = await tool.handler(args)
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

  // 子 Agent：复用同一套确认/日志/广播管道，深度固定为 1（工具集去掉 spawn_agent）。
  // 子 Agent 不参与会话派生：去掉 spawn_agent 与 session_*，否则会绕过嵌套深度限制
  const subTools = tools.filter((t) => t.name !== 'spawn_agent' && !t.name.startsWith('session_'))
  const subMap = Object.fromEntries(subTools.map((t) => [t.name, t]))
  const runSubAgent = async (subGoal) => {
    const sub = await withKeyRetry(db, provider, (apiKey) =>
      runAgentLoop({
        messages: [
          {
            role: 'system',
            content:
              '你是被主 Agent 派出的子 Agent，专注完成给定子任务，完成后用简洁的结论回复（不要寒暄）。'
          },
          { role: 'user', content: subGoal }
        ],
        maxSteps: Math.min(10, Number(settings.agentMaxSteps) || 15),
        toolMap: subMap,
        isStopped: () => state.stopped,
        modelCall: modelCallWith(apiKey),
        decide,
        execute,
        onEvent
      })
    )
    return lastAssistantContent(sub.messages) || '(子 Agent 无输出)'
  }
  // 单任务：串行执行；集群开启时同一轮多个子任务并发执行（各自独立上下文）
  ctx.spawnAgent = async ({ goal: subGoal, goals }) => {
    const list = Array.isArray(goals) && goals.length ? goals : [subGoal]
    if (!state.cluster && list.length > 1) {
      throw new Error('未开启 Agent 集群，一次只能派生一个子 Agent')
    }
    if (list.length === 1) return runSubAgent(String(list[0] || '').trim())
    const results = await Promise.all(
      list.map((g) => runSubAgent(String(g || '').trim()).catch((e) => `子任务失败：${e.message}`))
    )
    return results.map((r, i) => `【子任务 ${i + 1}】\n${r}`).join('\n\n')
  }

  try {
    const result = await withKeyRetry(db, provider, (apiKey) =>
      runAgentLoop({
        messages,
        maxSteps: Number(settings.agentMaxSteps) || 15,
        toolMap,
        isStopped: () => state.stopped,
        modelCall: modelCallWith(apiKey),
        decide,
        execute,
        onEvent
      })
    )
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

  const runUpdate = repos.updateRunStatus(db, runId, {
    status: finalStatus,
    stepsUsed,
    endedAt: Date.now(),
    // 有验收策略时进入待验收；否则 not_required
    acceptanceStatus: acceptancePolicy ? 'pending' : null
  })
  if (!runUpdate.ok) {
    // 终态已被其它路径写入：不覆盖，仅记录
    getHub().emit('run.stale_update_ignored', {
      runId,
      traceId: state.traceId,
      conversationId,
      attempted: finalStatus,
      reason: runUpdate.reason
    })
  }
  repos.updateMessage(db, assistantMsgId, {
    content: finalContent || '(无输出)',
    status: finalStatus === 'done' ? 'done' : finalStatus === 'error' ? 'error' : 'stopped'
  })
  if (finalStatus !== status) status = finalStatus
  repos.touchConversation(db, conversationId)
  if (ctx._browser) {
    try {
      ctx._browser.close()
    } catch {
      // 窗口可能已被销毁
    }
  }
  active.delete(runId)
  // run.end 钩子与事件：此时运行已落库，钩子可以安全地读结果
  const ended = applyHooks(hookRules, 'run.end', { runId, conversationId, status }, hookSink)
  getHub().emit('run.end', {
    runId,
    conversationId,
    parentRunId: state.parentRunId,
    status,
    stepsUsed,
    toolCalls: callCount,
    durationMs: Date.now() - startedAt,
    hookNotified: ended.notifications.length
  })
  broadcast('chat:event', {
    type: status === 'error' ? 'error' : status === 'stopped' ? 'stopped' : 'done',
    conversationId,
    msgId: assistantMsgId,
    content: finalContent || ''
  })
  broadcast('agent:event', {
    type: 'done',
    runId,
    status,
    content: finalContent,
    assistantMsgId
  })
}

function respondConfirm({ requestId, allow, remember }) {
  for (const st of active.values()) {
    if (st.confirms.has(requestId)) {
      const finish = st.confirms.get(requestId)
      // finish 内部负责 delete + 清理超时定时器，避免重复 resolve
      if (typeof finish === 'function') finish({ allow: !!allow, remember: !!remember })
      return true
    }
  }
  return false
}

function stopRun(runId, reason = 'user') {
  const st = active.get(runId)
  if (!st) return false
  st.stopped = true
  st.stopReason = reason
  st.ac.abort()
  // 内部中止不得静默（方案四 §5.4）：记录原因与发起者
  try {
    const db = dbm.get()
    // 只有用户取消才直接落 stopped；其余由各自路径处理
    if (reason === 'user') {
      repos.updateRunStatus(db, runId, { status: 'stopped', endedAt: Date.now() })
    }
    getHub().emit('run.abort_requested', {
      runId,
      traceId: st.traceId || null,
      reason
    })
  } catch {
    // 数据库未就绪时忽略，不影响中止
  }
  // 先收集再 resolve：finish 会从 confirms 中删除自身
  const pending = [...st.confirms.keys()]
  for (const requestId of pending) {
    const finish = st.confirms.get(requestId)
    if (typeof finish === 'function') finish({ allow: false, remember: false })
  }
  st.confirms.clear()
  // 通知前端按 runId 清掉僵尸确认卡（含主窗隐藏时积压的请求）
  if (pending.length) broadcast('agent:confirmCancel', { runId, requestIds: pending })
  return true
}

function listActiveRuns() {
  return [...active.keys()]
}

module.exports = {
  startAgentRun,
  respondConfirm,
  stopRun,
  listActiveRuns,
  summarize,
  resolveWorkingDir,
  resolveAgentParams
}
