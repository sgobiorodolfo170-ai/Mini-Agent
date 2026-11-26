const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 30000
const DEFAULT_IDLE_TIMEOUT_MS = 45000

const TIMEOUT_LABELS = {
  first_event: '等待首个 SSE 事件',
  idle: 'SSE 空闲'
}

class StreamTimeoutError extends Error {
  constructor(phase, timeoutMs) {
    super(`${TIMEOUT_LABELS[phase] || '模型流'}超时（${timeoutMs}ms）`)
    this.name = 'StreamTimeoutError'
    this.kind = 'timeout'
    this.timedOut = true
    this.phase = phase
    this.timeoutMs = timeoutMs
  }
}

function abortError(signal) {
  if (signal && signal.reason && signal.reason.name === 'AbortError') return signal.reason
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function timeoutValue(value, fallback) {
  if (value == null) return fallback
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

// Race one read only. A stalled provider (or a mock that ignores AbortSignal)
// must not leave the generator waiting forever. Null disables the deadline;
// zero means the first-event deadline has already been exhausted.
function readWithTimeout(iterator, { signal, timeoutMs, phase, onTimeout }) {
  const error = () =>
    signal && signal.reason && signal.reason.kind === 'timeout' ? signal.reason : abortError(signal)

  if (signal?.aborted) return Promise.reject(error())
  if (timeoutMs === 0) {
    const timeout = new StreamTimeoutError(phase, timeoutMs)
    if (onTimeout) onTimeout(timeout)
    return Promise.reject(timeout)
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }
    const onAbort = () => settle(reject, error())
    const timer =
      timeoutMs == null
        ? null
        : setTimeout(() => {
            const timeout = new StreamTimeoutError(phase, timeoutMs)
            if (onTimeout) onTimeout(timeout)
            settle(reject, timeout)
          }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => iterator.next())
      .then(
        (result) => settle(resolve, result),
        (cause) => settle(reject, signal?.aborted ? error() : cause)
      )
  })
}

function parseData(buffer) {
  const events = []
  let rest = buffer
  let index
  while ((index = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, index).replace(/\r$/, '')
    rest = rest.slice(index + 1)
    if (!line || !line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data) continue
    if (data === '[DONE]') return { events, rest, done: true }
    try {
      events.push(JSON.parse(data))
    } catch {
      // Ignore malformed events, as before; the idle timer still bounds them.
    }
  }
  return { events, rest, done: false }
}

// Parse an SSE byte stream into OpenAI-style JSON events. The first-event
// deadline is absolute; after the first event, every chunk refreshes idle time.
async function* sseEvents(
  body,
  {
    signal,
    firstEventTimeoutMs = DEFAULT_FIRST_EVENT_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    onChunk,
    onTimeout
  } = {}
) {
  const iterator = body[Symbol.asyncIterator]()
  const decoder = new TextDecoder('utf-8')
  const firstEventMs = timeoutValue(firstEventTimeoutMs, DEFAULT_FIRST_EVENT_TIMEOUT_MS)
  const idleMs = timeoutValue(idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS)
  const firstEventDeadline = Date.now() + firstEventMs
  let buffer = ''
  let firstEvent = true
  let iteratorDone = false

  try {
    while (true) {
      const phase = firstEvent ? 'first_event' : 'idle'
      const timeoutMs = firstEvent
        ? firstEventMs === 0
          ? null
          : Math.max(0, firstEventDeadline - Date.now())
        : idleMs || null
      const next = await readWithTimeout(iterator, { signal, timeoutMs, phase, onTimeout })
      if (next.done) {
        iteratorDone = true
        break
      }
      if (onChunk) onChunk(next.value)
      buffer += decoder.decode(next.value, { stream: true })
      const parsed = parseData(buffer)
      buffer = parsed.rest
      for (const event of parsed.events) {
        firstEvent = false
        yield event
      }
      if (parsed.done) return
    }

    // Accept a final data line without a trailing newline.
    buffer += decoder.decode()
    if (buffer.startsWith('data:')) {
      const data = buffer.slice(5).trim()
      if (data && data !== '[DONE]') {
        try {
          yield JSON.parse(data)
        } catch {
          // Ignore a malformed final event.
        }
      }
    }
  } finally {
    if (!iteratorDone && typeof iterator.return === 'function') {
      // Do not await return(): a broken provider can leave its pending read
      // unresolved even after cancellation. Timers/listeners are already gone.
      Promise.resolve(iterator.return()).catch(() => {})
    }
  }
}

module.exports = {
  sseEvents,
  StreamTimeoutError,
  DEFAULT_FIRST_EVENT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS
}
