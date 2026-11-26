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
const DEFAULT_DIAGNOSTIC_INTERVAL_MS = 60000
const MAX_SCOPE = 80
const MAX_MESSAGE = 4000
const MAX_DATA = 12000
const PERSISTENCE_REASONS = {
  mkdir: '无法创建运行日志目录',
  read: '无法读取运行日志历史',
  append: '无法追加运行日志',
  rotate: '无法轮转运行日志',
  write: '无法清空运行日志文件'
}

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
  diagnosticIntervalMs = DEFAULT_DIAGNOSTIC_INTERVAL_MS,
  now = Date.now,
  fsImpl = fs
} = {}) {
  const file = dir ? path.join(dir, 'runtime.log') : null
  const entries = []
  let bytes = 0
  let seq = 0
  let dirReady = false
  let captureRestore = null
  let persistenceFailed = false
  let failureCount = 0
  let consecutiveFailures = 0
  let diagnosticsEmitted = 0
  let diagnosticsSuppressed = 0
  let lastDiagnosticAt = null
  let lastError = null
  let lastSuccessAt = null
  let recoveredAt = null
  // 轮转失败后，普通 append 仍会落盘，但不能证明轮转已恢复。
  // 只有轮转及随后 append 均成功，或显式清空成功，才解除这一待恢复状态。
  let rotationPending = false

  function nextId(at) {
    seq += 1
    return `${at}-${seq.toString(36)}`
  }

  function retain(entry) {
    entries.push(entry)
    while (entries.length > maxEntries) entries.shift()
  }

  function getPersistenceHealth() {
    return {
      enabled: Boolean(file),
      status: !file ? 'disabled' : persistenceFailed ? 'degraded' : 'healthy',
      lastError: lastError ? { ...lastError } : null,
      lastSuccessAt,
      recoveredAt,
      failureCount,
      consecutiveFailures,
      diagnosticsEmitted,
      diagnosticsSuppressed
    }
  }

  function noteSuccess({ rotationRecovered = false } = {}) {
    const at = now()
    if (rotationRecovered) rotationPending = false
    const recovered = persistenceFailed && !rotationPending
    lastSuccessAt = at
    if (!rotationPending) {
      persistenceFailed = false
      consecutiveFailures = 0
      if (recovered) recoveredAt = at
    }
  }

  function noteFailure(operation, error) {
    const at = now()
    const code =
      error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : 'UNKNOWN'
    const reason =
      code === 'INVALID_JSONL'
        ? '运行日志历史包含损坏行'
        : PERSISTENCE_REASONS[operation] || '运行日志持久化失败'
    persistenceFailed = true
    failureCount += 1
    consecutiveFailures += 1
    lastError = { operation, code, reason, at }

    // 首次失败必报，后续失败按时间限流；诊断只含操作与错误码，不带文件内容或异常原文。
    if (lastDiagnosticAt == null || at - lastDiagnosticAt >= diagnosticIntervalMs) {
      lastDiagnosticAt = at
      diagnosticsEmitted += 1
      retain(
        normalizeEntry({
          at,
          level: 'error',
          scope: 'runtime-log.persistence',
          message: `运行日志持久化异常：${reason}`,
          data: JSON.stringify({ operation, code })
        })
      )
    } else {
      diagnosticsSuppressed += 1
    }
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
      noteSuccess()
    } catch (error) {
      dirReady = false
      noteFailure('mkdir', error)
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
      let damagedLines = 0
      for (const line of lines.slice(-maxEntries)) {
        if (!line.trim()) continue
        try {
          entries.push(normalizeEntry(JSON.parse(line)))
        } catch {
          // 跳过损坏行，保证单行损坏不影响其余历史；诊断不携带行内容。
          damagedLines += 1
        }
      }
      if (damagedLines) noteFailure('read', { code: 'INVALID_JSONL' })
      else noteSuccess()
    } catch (error) {
      // 读取失败时以内存日志继续运行。
      noteFailure('read', error)
    }
  }

  function rotate() {
    if (!file || !ensureDir()) return false
    try {
      const backup = file + '.1'
      if (fsImpl.existsSync(backup)) fsImpl.unlinkSync(backup)
      if (fsImpl.existsSync(file)) fsImpl.renameSync(file, backup)
      bytes = 0
      return true
    } catch (error) {
      // 轮转失败时继续追加，文件变大也不会影响功能。
      rotationPending = true
      noteFailure('rotate', error)
      return false
    }
  }

  function append(entry) {
    retain(entry)
    if (!file || !ensureDir()) return
    try {
      const line = JSON.stringify(entry) + '\n'
      const size = Buffer.byteLength(line, 'utf8')
      let rotated = false
      if (bytes + size > maxBytes) {
        rotated = rotate()
        // 一次完整轮转还必须包含对新活动文件的 append 成功。
        if (rotated) rotationPending = true
      }
      fsImpl.appendFileSync(file, line, 'utf8')
      bytes += size
      noteSuccess({ rotationRecovered: rotated })
    } catch (error) {
      // 持久化失败不阻塞业务，内存条目已保留。
      noteFailure('append', error)
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
      maxEntries,
      persistence: getPersistenceHealth()
    }
  }

  function clear() {
    if (!file) {
      entries.length = 0
      return true
    }
    if (!ensureDir()) return false
    try {
      fsImpl.writeFileSync(file, '', 'utf8')
      entries.length = 0
      bytes = 0
      // 显式清空成功也会建立全新的活动文件，等价于持久化恢复边界。
      noteSuccess({ rotationRecovered: true })
      return true
    } catch (error) {
      noteFailure('write', error)
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
    getPersistenceHealth,
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
