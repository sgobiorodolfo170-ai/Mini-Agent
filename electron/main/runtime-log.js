// 运行日志：主进程控制台、事件中枢与显式业务日志的本地持久化。
//
// 设计取舍：
// - 内存环形缓冲（默认 800 条）供设置页快速读取；文件按 JSONL 追加写入，
//   应用重启后仍可回看；
// - 高频流式事件（chat delta、下载/导入进度）只记录完成或失败，避免落盘
//   拖慢主流程；
// - 日志模块自身不能影响业务：读写失败一律吞掉，不让异常向上冒泡；
// - Key / Authorization 等敏感串在落盘前脱敏。

const fs = require('fs')
const path = require('path')

const LEVELS = ['debug', 'info', 'warn', 'error']
const DEFAULT_MAX_ENTRIES = 800
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const MAX_SCOPE = 80
const MAX_MESSAGE = 4000
const MAX_DATA = 12000

function redact(text) {
  return String(text == null ? '' : text)
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1***')
    .replace(/("(?:api[_-]?key|secret|password|token)"\s*:\s*")[^"]*(")/gi, '$1***$2')
}

function toText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || value.message || String(value)
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

function trim(text, limit) {
  const s = String(text == null ? '' : text)
  return s.length > limit ? s.slice(0, limit) + '…' : s
}

function formatConsoleArgs(args) {
  if (!args.length) return { message: '', data: null }
  if (args.length === 1) return { message: toText(args[0]), data: null }
  return {
    message: toText(args[0]),
    data: args
      .slice(1)
      .map((x) => toText(x))
      .filter(Boolean)
      .join(' ')
  }
}

// 高频事件不逐条落库：流式增量与进度条只在完成/失败时留痕。
function shouldSkipEvent(name, payload) {
  if (name === 'chat:event' && payload && payload.type === 'delta') return true
  if (name === 'models:progress' && payload && !payload.done) return true
  if (name === 'kb:progress' && payload && !payload.done && !payload.error) return true
  return false
}

// 聊天事件带完整回复正文，运行日志只保留元信息和正文长度，避免重复落库个人数据。
function sanitizeEventPayload(name, payload) {
  if (!payload || typeof payload !== 'object' || name !== 'chat:event') return payload
  const keep = ['type', 'conversationId', 'msgId', 'status', 'message', 'meta']
  const out = {}
  for (const key of keep) {
    if (payload[key] !== undefined && payload[key] !== null) out[key] = payload[key]
  }
  if (typeof payload.content === 'string') out.contentLength = payload.content.length
  if (Array.isArray(payload.messages)) out.messageCount = payload.messages.length
  return out
}

function eventLevel(name, payload) {
  const hinted = payload && payload.level
  if (LEVELS.includes(hinted)) return hinted
  if (name === 'chat:event' && payload && payload.type === 'error') return 'error'
  if (name === 'agent:event' && payload && payload.type === 'error') return 'error'
  if (/uncaught|unhandled|error|fail|denied|timeout|abort|stale/i.test(name)) return 'warn'
  if (payload && payload.error) return 'warn'
  if (payload && /^(error|failed|timeout|stopped)$/i.test(String(payload.status || '')))
    return 'warn'
  if (name === 'hook.fired' && payload && payload.action === 'block') return 'warn'
  return 'info'
}

function createRuntimeLog({
  dir = null,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES,
  now = Date.now,
  fsImpl = fs
} = {}) {
  const file = dir ? path.join(dir, 'runtime.log') : null
  const entries = []
  let bytes = 0
  let seq = 0
  let dirReady = false
  let captureRestore = null

  function nextId(at) {
    seq += 1
    return `${at}-${seq.toString(36)}`
  }

  function normalizeEntry(raw) {
    const at = Number(raw && raw.at) || now()
    return {
      id: String((raw && raw.id) || nextId(at)),
      at,
      level: LEVELS.includes(raw && raw.level) ? raw.level : 'info',
      scope: trim(redact((raw && raw.scope) || 'app'), MAX_SCOPE),
      message: trim(redact((raw && raw.message) || ''), MAX_MESSAGE),
      data: raw && raw.data ? trim(redact(raw.data), MAX_DATA) : null
    }
  }

  function ensureDir() {
    if (!dir || dirReady) return dirReady
    try {
      fsImpl.mkdirSync(dir, { recursive: true })
      dirReady = true
    } catch {
      dirReady = false
    }
    return dirReady
  }

  function loadExisting() {
    if (!file) return
    try {
      if (!fsImpl.existsSync(file)) return
      const raw = fsImpl.readFileSync(file, 'utf8')
      bytes = Buffer.byteLength(raw, 'utf8')
      const lines = raw.split(/\r?\n/)
      for (const line of lines.slice(-maxEntries)) {
        if (!line.trim()) continue
        try {
          entries.push(normalizeEntry(JSON.parse(line)))
        } catch {
          // 跳过损坏行，保证单行损坏不影响其余历史
        }
      }
    } catch {
      // 读取失败时以内存日志继续运行
    }
  }

  function rotate() {
    if (!file || !ensureDir()) return
    try {
      const backup = file + '.1'
      if (fsImpl.existsSync(backup)) fsImpl.unlinkSync(backup)
      if (fsImpl.existsSync(file)) fsImpl.renameSync(file, backup)
      bytes = 0
    } catch {
      // 轮转失败时继续追加，文件变大也不会影响功能
    }
  }

  function append(entry) {
    entries.push(entry)
    while (entries.length > maxEntries) entries.shift()
    if (!file || !ensureDir()) return
    try {
      const line = JSON.stringify(entry) + '\n'
      const size = Buffer.byteLength(line, 'utf8')
      if (bytes + size > maxBytes) rotate()
      fsImpl.appendFileSync(file, line, 'utf8')
      bytes += size
    } catch {
      // 持久化失败不阻塞业务
    }
  }

  function log(level, scope, message, data) {
    const entry = normalizeEntry({
      at: now(),
      level: LEVELS.includes(level) ? level : 'info',
      scope,
      message,
      data: data == null ? null : toText(data)
    })
    append(entry)
    return entry
  }

  function event(record) {
    if (!record) return null
    const name = String(record.name || 'event')
    if (shouldSkipEvent(name, record.payload)) return null
    return log(
      eventLevel(name, record.payload),
      'event',
      name,
      sanitizeEventPayload(name, record.payload)
    )
  }

  function list({ level = 'all', search = '', limit = 500 } = {}) {
    const max = Math.min(Math.max(Number(limit) || 500, 1), maxEntries)
    const q = String(search || '')
      .trim()
      .toLowerCase()
    const wanted = LEVELS.includes(level) ? level : ''
    const out = []
    for (let i = entries.length - 1; i >= 0 && out.length < max; i--) {
      const e = entries[i]
      if (wanted && e.level !== wanted) continue
      if (q) {
        const hay = `${e.level} ${e.scope} ${e.message} ${e.data || ''}`.toLowerCase()
        if (!hay.includes(q)) continue
      }
      out.push(e)
    }
    return out
  }

  function stats() {
    return {
      size: entries.length,
      bytes,
      path: file || '',
      dir: dir || '',
      maxEntries
    }
  }

  function clear() {
    entries.length = 0
    if (!file || !ensureDir()) return true
    try {
      fsImpl.writeFileSync(file, '', 'utf8')
      bytes = 0
      return true
    } catch {
      return false
    }
  }

  function installConsoleCapture(target = console) {
    if (captureRestore) return captureRestore
    const originals = {}
    const methodLevel = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' }
    for (const [method, level] of Object.entries(methodLevel)) {
      if (typeof target[method] !== 'function') continue
      const original = target[method]
      originals[method] = original
      target[method] = function (...args) {
        try {
          const { message, data } = formatConsoleArgs(args)
          log(level, 'console', message, data)
        } catch {
          // 日志采集不能影响原控制台输出
        }
        return original.apply(this, args)
      }
    }
    captureRestore = () => {
      for (const [method, original] of Object.entries(originals)) target[method] = original
      captureRestore = null
    }
    return captureRestore
  }

  function dispose() {
    if (captureRestore) captureRestore()
  }

  loadExisting()

  return {
    log,
    event,
    list,
    stats,
    clear,
    installConsoleCapture,
    dispose,
    get dir() {
      return dir || ''
    }
  }
}

// 进程级单例：index.js 启动时用真实 userData/logs 初始化；
// 单测/未初始化场景退化为纯内存日志，保证 IPC 永远可调用。
let singleton = null

function initRuntimeLog(opts) {
  if (singleton) singleton.dispose()
  singleton = createRuntimeLog(opts)
  return singleton
}

function getRuntimeLog() {
  if (!singleton) singleton = createRuntimeLog()
  return singleton
}

function resetRuntimeLog() {
  if (singleton) singleton.dispose()
  singleton = null
}

module.exports = {
  LEVELS,
  createRuntimeLog,
  initRuntimeLog,
  getRuntimeLog,
  resetRuntimeLog,
  redact
}
