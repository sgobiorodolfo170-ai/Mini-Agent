const { sseEvents } = require('./sse')

class GatewayError extends Error {
  constructor(kind, status, detail) {
    super(detail || kind)
    this.name = 'GatewayError'
    this.kind = kind
    this.status = status || 0
    this.detail = detail || ''
  }
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

// Stream a chat completion. Returns the full assembled result.
async function chatStream(
  { baseUrl, apiKey, payload },
  { fetchImpl = globalThis.fetch, signal, onDelta } = {}
) {
  let res
  try {
    res = await fetchImpl(joinUrl(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal
    })
  } catch (e) {
    if (e && e.name === 'AbortError') throw e
    const cause = e && e.cause ? String(e.cause.message || e.cause) : ''
    throw new GatewayError(
      'network_error',
      0,
      [String((e && e.message) || e), cause].filter(Boolean).join(' | ')
    )
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new GatewayError(classifyHttpStatus(res.status), res.status, detail.slice(0, 800))
  }
  if (!res.body) throw new GatewayError('retryable', res.status, 'empty response body')

  let content = ''
  let finishReason = null
  let usage = null
  const toolCalls = []
  for await (const ev of sseEvents(res.body)) {
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
  return { content, finishReason, toolCalls, usage }
}

// Non-streaming completion (used for small utility calls).
async function chatOnce(opts, extras = {}) {
  return chatStream({ ...opts, payload: { ...opts.payload, stream: false } }, extras)
}

module.exports = { GatewayError, classifyHttpStatus, joinUrl, chatStream, chatOnce, mergeToolCall }
