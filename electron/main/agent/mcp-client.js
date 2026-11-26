// Minimal MCP (Model Context Protocol) stdio client: JSON-RPC 2.0 over newline-delimited stdin/stdout.
// spawnFn is injectable for unit tests. Each session spawns its own server process.
const { spawn } = require('child_process')
const { processRegistry, terminateChild, waitForExit } = require('../lifecycle')

const PROTOCOL_VERSION = '2024-11-05'

function createMcpClient({ command, args = [], spawnFn = spawn, timeoutMs = 15000 } = {}) {
  let child = null
  let nextId = 1
  let buf = ''
  let stopping = null
  const pending = new Map() // id -> { resolve, reject, timer }

  function start() {
    if (child) return child
    if (stopping) throw new Error('MCP 会话正在关闭')
    if (command == null || command === '') throw new Error('MCP 服务器未配置启动命令')
    const invalid = validateMcpServerConfig({ command, args })
    if (invalid) throw new Error(`MCP 配置无效: ${invalid.reason}`)
    child = spawnFn(command, args, { windowsHide: true })
    processRegistry.track(child)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        handleMessage(line)
      }
    })
    child.on('error', (e) => failAll(new Error(`MCP 进程错误: ${e.message}`)))
    child.on('exit', (code) => {
      failAll(new Error(`MCP 进程已退出(code=${code})`))
      child = null
    })
    return child
  }

  function handleMessage(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return // 忽略非 JSON 输出
    }
    if (msg && msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      clearTimeout(p.timer)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`MCP 错误(${msg.error.code}): ${msg.error.message}`))
      else p.resolve(msg.result || {})
    }
  }

  function failAll(err) {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }

  function request(method, params) {
    start()
    const id = nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP 请求超时(${timeoutMs}ms): ${method}`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(payload + '\n')
      } catch (e) {
        clearTimeout(timer)
        pending.delete(id)
        reject(new Error(`MCP 写入失败: ${e.message}`))
      }
    })
  }

  function notify(method, params = {}) {
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    } catch {
      // 通知失败不影响主流程
    }
  }

  async function initialize() {
    const r = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mini-agent', version: '1.0.0' }
    })
    notify('notifications/initialized')
    return r
  }

  async function listTools() {
    const r = await request('tools/list', {})
    return r.tools || []
  }

  async function callTool(name, args) {
    const r = await request('tools/call', { name, arguments: args || {} })
    if (r.isError) throw new Error(extractText(r) || 'MCP 工具返回错误')
    return extractText(r) || JSON.stringify(r) || '(空结果)'
  }

  function extractText(result) {
    if (!result || !Array.isArray(result.content)) return ''
    return result.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
  }

  function stop({ graceMs = 500, killMs = 600 } = {}) {
    if (stopping) return stopping
    failAll(new Error('MCP 会话已关闭'))
    const current = child
    child = null
    if (!current) return Promise.resolve('exited')
    stopping = (async () => {
      try {
        // MCP 服务通常以 stdin EOF 作为正常退出信号；给一次优雅退出的机会。
        if (current.stdin && !current.stdin.destroyed && !current.stdin.writableEnded) {
          // 子进程可能已退出，end() 后的 EPIPE 属于预期噪音，先吞掉避免 unhandled 'error'。
          current.stdin.once('error', () => {})
          current.stdin.end()
        }
        if (await waitForExit(current, graceMs)) return 'closed'
        return await terminateChild(current, { graceMs: 300, killMs })
      } catch {
        return await terminateChild(current, { graceMs: 0, killMs })
      } finally {
        processRegistry.untrack(current)
        stopping = null
      }
    })()
    return stopping
  }

  return { initialize, listTools, callTool, stop, _getChild: () => child }
}

// 起停一次会话执行 fn(client)，无论成败都回收进程。
async function withMcpServer(cfg, fn, opts = {}) {
  const client = createMcpClient({ ...cfg, ...opts })
  try {
    await client.initialize()
    return await fn(client)
  } finally {
    await client.stop()
  }
}

// 设置里的 agentMcpServers 是 JSON 字符串：{"name": {"command": "...", "args": [...]}}
// 保留旧解析器的过滤语义，主进程可逐步迁移到带诊断的 parseMcpServersDetailed。
function parseMcpServers(raw) {
  if (!raw) return {}
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out = {}
    for (const [name, cfg] of Object.entries(v)) {
      if (cfg && typeof cfg === 'object' && cfg.command) out[name] = cfg
    }
    return out
  } catch {
    return {}
  }
}

function validateMcpServerConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { code: 'invalid_entry', reason: '服务器配置必须是对象' }
  }
  if (!Object.prototype.hasOwnProperty.call(cfg, 'command')) {
    return { code: 'invalid_command', reason: '缺少 command 启动命令' }
  }
  const command = cfg.command
  if (
    typeof command !== 'string' ||
    !command.trim() ||
    command.trim() !== command ||
    command.includes('\0')
  ) {
    return {
      code: 'invalid_command',
      reason: 'command 必须是非空字符串，且不能包含首尾空白或 NUL 字符'
    }
  }
  const args = Object.prototype.hasOwnProperty.call(cfg, 'args') ? cfg.args : []
  if (!Array.isArray(args)) {
    return { code: 'invalid_args', reason: 'args 必须是字符串数组' }
  }
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] !== 'string' || args[i].includes('\0')) {
      return {
        code: 'invalid_args',
        reason: 'args 的每一项必须是不含 NUL 字符的字符串',
        index: i
      }
    }
  }
  return null
}

// 纯解析，不启动服务器。null/空字符串表示未配置；其余输入逐项给出稳定诊断码。
function parseMcpServersDetailed(raw) {
  const result = { configured: false, servers: {}, diagnostics: [] }
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return result
  result.configured = true

  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      result.diagnostics.push({ code: 'invalid_json', reason: 'MCP 配置不是合法 JSON' })
      return result
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    result.diagnostics.push({ code: 'invalid_root', reason: 'MCP 配置必须是服务器对象映射' })
    return result
  }

  for (const [name, cfg] of Object.entries(value)) {
    if (!name.trim() || name.includes('\0')) {
      result.diagnostics.push({ code: 'invalid_name', reason: '服务器名称不能为空或包含 NUL 字符' })
      continue
    }
    const invalid = validateMcpServerConfig(cfg)
    if (invalid) {
      result.diagnostics.push({ name, ...invalid })
      continue
    }
    const normalized = { ...cfg, args: cfg.args ? [...cfg.args] : [] }
    // 不使用普通赋值，避免 __proto__ 等合法名称改变结果对象的原型。
    Object.defineProperty(result.servers, name, {
      value: normalized,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return result
}

module.exports = {
  createMcpClient,
  withMcpServer,
  parseMcpServers,
  parseMcpServersDetailed,
  PROTOCOL_VERSION
}
