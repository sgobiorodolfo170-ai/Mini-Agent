const { sseEvents, StreamTimeoutError } = require('./sse')

const DEFAULT_STREAM_TIMEOUTS = Object.freeze({
  connectTimeoutMs: 15000,
  firstByteTimeoutMs: 30000,
  idleTimeoutMs: 45000,
  totalTimeoutMs: 600000
})

const TIMEOUT_LABELS = {
  connect: '连接模型服务',
  first_byte: '等待首个响应字节',
  total: '模型流总时长'
}

class GatewayError extends Error {
  constructor(kind, status, detail) {
    super(detail || kind)
    this.name = 'GatewayError'
    this.kind = kind
    this.status = status || 0
    this.detail = detail || ''
  }
}

function streamTimeout(phase, timeoutMs) {
  const error = new StreamTimeoutError(phase, timeoutMs)
  if (TIMEOUT_LABELS[phase]) error.message = `${TIMEOUT_LABELS[phase]}超时（${timeoutMs}ms）`
  return error
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

function resolveTimeouts(timeouts) {
  const input = timeouts && typeof timeouts === 'object' ? timeouts : {}
  return Object.fromEntries(
    Object.entries(DEFAULT_STREAM_TIMEOUTS).map(([key, value]) => [
      key,
      timeoutValue(input[key], value)
    ])
  )
}

// Own the internal controller so timeout aborts can be distinguished from a
// user's AbortSignal even when fetch/body rejects with a generic AbortError.
function createStreamControl(externalSignal) {
  const controller = new AbortController()
  let failure = null
  let cancelled = false
  const onExternalAbort = () => {
    if (failure) return
    cancelled = true
    controller.abort(externalSignal.reason)
  }
  if (externalSignal?.aborted) onExternalAbort()
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true })

  return {
    signal: controller.signal,
    get error() {
      return failure || (cancelled ? abortError(externalSignal) : null)
    },
    timeout(error) {
      if (failure || cancelled) return
      failure = error
      controller.abort(error)
    },
    dispose() {
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }
}

function waitForOperation(operation, control, timeoutMs, phase) {
  if (control.error) return Promise.reject(control.error)
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      control.signal.removeEventListener('abort', onAbort)
    }
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }
    const onAbort = () => settle(reject, control.error || abortError(control.signal))
    const timer = timeoutMs
      ? setTimeout(() => {
          const error = streamTimeout(phase, timeoutMs)
          control.timeout(error)
          settle(reject, error)
        }, timeoutMs)
      : null
    control.signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(operation)
      .then(
        (value) => settle(resolve, value),
        (cause) => settle(reject, control.error || cause)
      )
  })
}

// Map an HTTP status to the key-scheduler semantic (mirrors apikey测试工具 conventions).
function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return 'invalid'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'retryable'
  if (status === 400 || status === 404 || status === 422) return 'bad_request'
  return 'retryable'
}

function joinUrl(base, p) {
  return `${String(base).replace(/\/+$/, '')}${p}`
}

function mergeToolCall(acc, tc) {
  const idx = typeof tc.index === 'number' ? tc.index : acc.length
  while (acc.length <= idx)
    acc.push({ id: '', type: 'function', function: { name: '', arguments: '' } })
  const t = acc[idx]
  if (tc.id) t.id = tc.id
  if (tc.function) {
    if (tc.function.name) t.function.name += tc.function.name
    if (tc.function.arguments) t.function.arguments += tc.function.arguments
  }
  return t
}

// Stream a chat completion. Returns the full assembled result. Timeouts are
// configurable per call; zero disables an individual deadline.
async function chatStream(
  { baseUrl, apiKey, payload },
  { fetchImpl = globalThis.fetch, signal, onDelta, timeouts: configuredTimeouts } = {}
) {
  const timeouts = resolveTimeouts(configuredTimeouts)
  const control = createStreamControl(signal)
  let totalTimer = null
  let firstByteTimer = null
  const clearFirstByteTimer = () => {
    if (firstByteTimer) clearTimeout(firstByteTimer)
    firstByteTimer = null
  }

  try {
    if (control.error) throw control.error
    if (timeouts.totalTimeoutMs) {
      totalTimer = setTimeout(
        () => control.timeout(streamTimeout('total', timeouts.totalTimeoutMs)),
        timeouts.totalTimeoutMs
      )
    }

    let res
    try {
      res = await waitForOperation(
        () =>
          fetchImpl(joinUrl(baseUrl, '/chat/completions'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify(payload),
            signal: control.signal
          }),
        control,
        timeouts.connectTimeoutMs,
        'connect'
      )
    } catch (e) {
      if (control.error) throw control.error
      if (e && e.name === 'AbortError') throw e
      const cause = e && e.cause ? String(e.cause.message || e.cause) : ''
      throw new GatewayError(
        'network_error',
        0,
        [String((e && e.message) || e), cause].filter(Boolean).join(' | ')
      )
    }

    if (timeouts.firstByteTimeoutMs) {
      firstByteTimer = setTimeout(
        () => control.timeout(streamTimeout('first_byte', timeouts.firstByteTimeoutMs)),
        timeouts.firstByteTimeoutMs
      )
    }
    if (!res.ok) {
      const detail = await waitForOperation(() => res.text().catch(() => ''), control, 0)
      throw new GatewayError(classifyHttpStatus(res.status), res.status, detail.slice(0, 800))
    }
    if (!res.body) throw new GatewayError('retryable', res.status, 'empty response body')

    let content = ''
    let finishReason = null
    let usage = null
    const toolCalls = []
    for await (const ev of sseEvents(res.body, {
      signal: control.signal,
      firstEventTimeoutMs: timeouts.firstByteTimeoutMs,
      idleTimeoutMs: timeouts.idleTimeoutMs,
      onChunk: clearFirstByteTimer,
      onTimeout: control.timeout
    })) {
      if (control.error) throw control.error
      if (ev.usage) usage = ev.usage
      const choice = ev.choices && ev.choices[0]
      if (!choice) continue
      if (choice.finish_reason) finishReason = choice.finish_reason
      const d = choice.delta || {}
      if (typeof d.content === 'string' && d.content.length > 0) {
        content += d.content
        if (onDelta) onDelta(d.content)
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) mergeToolCall(toolCalls, tc)
      }
    }
    if (control.error) throw control.error
    return { content, finishReason, toolCalls, usage }
  } finally {
    if (totalTimer) clearTimeout(totalTimer)
    clearFirstByteTimer()
    control.dispose()
  }
}

// Non-streaming completion (used for small utility calls).
async function chatOnce(opts, extras = {}) {
  return chatStream({ ...opts, payload: { ...opts.payload, stream: false } }, extras)
}

module.exports = {
  GatewayError,
  StreamTimeoutError,
  DEFAULT_STREAM_TIMEOUTS,
  classifyHttpStatus,
  joinUrl,
  chatStream,
  chatOnce,
  mergeToolCall
}
