// 事件中枢：进程内的发布/订阅 + 有界历史环形缓冲。
//
// 设计取舍：
// - 历史只留在内存（默认 500 条），不落库：事件是运行时观测量，写库会拖慢流式路径；
// - 每条事件带单调递增 seq，供前端做游标增量拉取（since(seq)），断线重连后不靠猜；
// - 订阅支持通配：「*」匹配全部，「run:*」「chat:*」匹配前缀，便于按域挂钩子；
// - emit 对监听器异常做隔离，单个监听器抛错不影响其他监听器与主流程。

const DEFAULT_HISTORY = 500

// 事件名有两种常见写法：域.动作（run.start）与 通道:事件（chat:event）。
// 匹配前把两种分隔符归一化，避免钩子/订阅因分隔符风格不同而静默失效。
function normalizeName(s) {
  return String(s == null ? '' : s).replace(/:/g, '.')
}

function patternMatches(pattern, name) {
  if (!pattern) return false
  const p = normalizeName(pattern)
  const n = normalizeName(name)
  if (p === '*' || p === n) return true
  if (p.endsWith('*')) return n.startsWith(p.slice(0, -1))
  return false
}

function createEventHub({ historyLimit = DEFAULT_HISTORY, now = Date.now } = {}) {
  const listeners = new Set() // { pattern, fn, once }
  const history = []
  let seq = 0
  let dropped = 0

  function push(record) {
    history.push(record)
    // 环形裁剪：超出上限就丢最旧的，并记录累计丢弃量
    while (history.length > historyLimit) {
      history.shift()
      dropped++
    }
  }

  function on(pattern, fn, { once = false } = {}) {
    const entry = { pattern, fn, once }
    listeners.add(entry)
    return () => listeners.delete(entry)
  }

  function once(pattern, fn) {
    return on(pattern, fn, { once: true })
  }

  function off(pattern, fn) {
    for (const entry of [...listeners]) {
      if (entry.pattern === pattern && (!fn || entry.fn === fn)) listeners.delete(entry)
    }
  }

  function emit(name, payload = {}) {
    seq++
    const record = { seq, at: now(), name, payload }
    push(record)
    // 复制一份再遍历：监听器内部可能增删订阅
    for (const entry of [...listeners]) {
      if (!patternMatches(entry.pattern, name)) continue
      try {
        entry.fn(record)
      } catch {
        // 监听器异常不得影响分发链路
      }
      if (entry.once) listeners.delete(entry)
    }
    return record
  }

  // 游标拉取：返回 seq 大于 since 的事件；truncated 表示历史已滚动、可能漏事件
  function since(cursor = 0, { limit = 200 } = {}) {
    const from = Number(cursor) || 0
    const oldest = history.length ? history[0].seq : seq + 1
    const matched = history.filter((r) => r.seq > from)
    const truncated = from > 0 && from < oldest - 1
    return {
      seq,
      firstSeq: oldest,
      dropped,
      truncated,
      events: matched.slice(0, Math.max(1, limit)),
      hasMore: matched.length > Math.max(1, limit)
    }
  }

  function recent({ limit = 100, name } = {}) {
    const list = name ? history.filter((r) => patternMatches(name, r.name)) : history
    return list.slice(-Math.max(1, limit))
  }

  function clear() {
    history.length = 0
    dropped = 0
  }

  return {
    on,
    once,
    off,
    emit,
    since,
    recent,
    clear,
    get seq() {
      return seq
    },
    get size() {
      return history.length
    },
    listenerCount() {
      return listeners.size
    }
  }
}

// 进程级单例：main 里所有模块共用一个中枢（globalThis 以兼容测试中的模块重复加载）。
function getHub() {
  if (!globalThis.__miniagentHub) globalThis.__miniagentHub = createEventHub()
  return globalThis.__miniagentHub
}

function resetHub(opts) {
  globalThis.__miniagentHub = createEventHub(opts || {})
  return globalThis.__miniagentHub
}

module.exports = { createEventHub, getHub, resetHub, patternMatches, normalizeName }
