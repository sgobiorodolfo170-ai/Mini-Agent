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
    if (!command) throw new Error('MCP 服务器未配置启动命令')
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

module.exports = { createMcpClient, withMcpServer, parseMcpServers, PROTOCOL_VERSION }
