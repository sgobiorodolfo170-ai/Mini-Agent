const os = require('os')
const path = require('path')
const repos = require('../../store/repos')
const dbm = require('../../store/db')
const { chatStream, GatewayError } = require('../gateway/client')
const scheduler = require('../gateway/scheduler')
const { resolveModel, msgOut } = require('../gateway/index')
const { decryptSecret } = require('../../store/keys')
const { broadcast } = require('../notify')
const { defineTools } = require('./tools')
const { escalateRisk } = require('./guard')
const { runAgentLoop } = require('./loop')
const { readMemoryFile } = require('./memory')
const { parseMcpServers } = require('./mcp-client')

const active = new Map() // runId -> { ac, stopped, remember:Set, confirms:Map }

function toolSchemas(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
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

async function startAgentRun({ conversationId, goal }) {
  const db = dbm.get()
  const { provider, model } = resolveModel(db, conversationId)
  if (!provider) throw new Error('未配置模型服务')
  if (!model) throw new Error('未配置模型')
  const settings = repos.getAllSettings(db)
  const runId = repos.createRun(db, {
    conversationId,
    goal,
    maxSteps: Number(settings.agentMaxSteps) || 15
  })
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
    confirms: new Map()
  }
  active.set(runId, state)
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
    state
  }).catch(() => {})
  return { runId, userMsgId: userMsg.id, assistantMsgId: assistant.id }
}

async function doAgentRun({ runId, conversationId, assistantMsgId, provider, model, goal, state }) {
  const db = dbm.get()
  const settings = repos.getAllSettings(db)
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
    webSearchProvider: settings.webSearchProvider || 'auto'
  }
  const tools = defineTools(ctx)
  const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]))
  const memoryText = readMemoryFile(ctx.memoryPath)
  const messages = [
    {
      role: 'system',
      content:
        '你是运行在用户 Windows 桌面上的 Agent。谨慎使用工具完成目标；写文件和执行命令前先用一句话说明计划。基于工具返回结果作答，不要臆造。' +
        (memoryText ? `\n\n以下是你的长期记忆（供参考，可按需更新）:\n${memoryText}` : '')
    },
    { role: 'user', content: goal }
  ]
  let lastDecision = { allowed: true, confirmedBy: 'auto' }
  let callCount = 0
  let finalContent = ''
  let stepsUsed = 0
  let status = 'done'

  const modelCallWith = (apiKey) => async (msgs) => {
    const r = await chatStream(
      {
        baseUrl: provider.base_url,
        apiKey,
        payload: { model, messages: msgs, stream: true, tools: toolSchemas(tools) }
      },
      {
        signal: state.ac.signal,
        onDelta: (d) => broadcast('chat:event', { type: 'delta', msgId: assistantMsgId, delta: d })
      }
    )
    return r
  }
  const decide = async ({ name, args, riskLevel }) => {
    const risk = escalateRisk(name, args, riskLevel)
    if (risk === 'readonly') return { allowed: true, confirmedBy: 'auto' }
    if (state.stopped) return { allowed: false, confirmedBy: 'stopped' }
    if (risk === 'side_effect' && state.remember.has(name))
      return { allowed: true, confirmedBy: 'session' }
    const requestId = repos.uid()
    const decision = await new Promise((resolve) => {
      state.confirms.set(requestId, resolve)
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
    lastDecision = {
      allowed: !!decision.allow,
      confirmedBy: decision.allow ? 'user' : 'denied'
    }
    return { allowed: !!decision.allow, confirmedBy: lastDecision.confirmedBy }
  }
  const execute = async (tool, args) => {
    const t0 = Date.now()
    let resultText = ''
    let error = null
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
    if (error) throw new Error(error)
    return resultText
  }
  const onEvent = (type, payload) => broadcast('agent:event', { type, runId, ...payload })

  // 子 Agent：复用同一套确认/日志/广播管道，深度固定为 1（工具集去掉 spawn_agent）。
  const subTools = tools.filter((t) => t.name !== 'spawn_agent')
  const subMap = Object.fromEntries(subTools.map((t) => [t.name, t]))
  ctx.spawnAgent = async ({ goal: subGoal }) => {
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

  repos.updateRun(db, runId, { status, stepsUsed, endedAt: Date.now() })
  repos.updateMessage(db, assistantMsgId, {
    content: finalContent || '(无输出)',
    status: status === 'done' ? 'done' : status === 'error' ? 'error' : 'stopped'
  })
  repos.touchConversation(db, conversationId)
  if (ctx._browser) {
    try {
      ctx._browser.close()
    } catch {
      // 窗口可能已被销毁
    }
  }
  active.delete(runId)
  broadcast('chat:event', {
    type: status === 'error' ? 'error' : status === 'stopped' ? 'stopped' : 'done',
    msgId: assistantMsgId,
    content: finalContent || ''
  })
  broadcast('agent:event', { type: 'done', runId, status, content: finalContent, assistantMsgId })
}

function respondConfirm({ requestId, allow, remember }) {
  for (const st of active.values()) {
    if (st.confirms.has(requestId)) {
      const r = st.confirms.get(requestId)
      st.confirms.delete(requestId)
      r({ allow: !!allow, remember: !!remember })
      return true
    }
  }
  return false
}

function stopRun(runId) {
  const st = active.get(runId)
  if (!st) return false
  st.stopped = true
  st.ac.abort()
  for (const [, r] of st.confirms) r({ allow: false, remember: false })
  st.confirms.clear()
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
  resolveWorkingDir
}
