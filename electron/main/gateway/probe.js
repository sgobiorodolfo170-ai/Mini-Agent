const { joinUrl, classifyHttpStatus } = require('./client')

// Minimal liveness probe for one key: smallest possible /chat/completions call.
async function probeKey(
  { baseUrl, apiKey, model, timeoutMs = 15000 },
  fetchImpl = globalThis.fetch
) {
  const started = Date.now()
  try {
    const res = await fetchImpl(joinUrl(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model || 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false
      }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const kind = res.ok ? 'ok' : classifyHttpStatus(res.status)
    const detail = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 300)
    return { ok: res.ok, kind, status: res.status, detail, latencyMs: Date.now() - started }
  } catch (e) {
    const cause = e && e.cause ? String(e.cause.message || e.cause) : ''
    return {
      ok: false,
      kind: 'network_error',
      status: 0,
      detail: [String((e && e.message) || e), cause].filter(Boolean).join(' | ').slice(0, 300),
      latencyMs: Date.now() - started
    }
  }
}

module.exports = { probeKey }
