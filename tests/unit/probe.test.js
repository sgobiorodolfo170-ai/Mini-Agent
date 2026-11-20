import { describe, expect, it, vi } from 'vitest'

import { probeKey } from '../../electron/main/gateway/probe'

function res(status, body = 'error body') {
  return { ok: status >= 200 && status < 300, status, text: async () => body }
}

describe('probeKey', () => {
  it('sends a minimal chat request and reports ok with latency', async () => {
    const fetchImpl = vi.fn(async () => res(200))
    const r = await probeKey(
      { baseUrl: 'https://x.com/v1/', apiKey: 'sk-1', model: 'm1' },
      fetchImpl
    )
    expect(r.ok).toBe(true)
    expect(r.kind).toBe('ok')
    expect(r.status).toBe(200)
    expect(r.detail).toBe('')
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://x.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer sk-1')
    expect(JSON.parse(init.body)).toEqual({
      model: 'm1',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('falls back to a default probe model when none configured', async () => {
    const fetchImpl = vi.fn(async () => res(200))
    await probeKey({ baseUrl: 'https://x.com/v1', apiKey: 'k' }, fetchImpl)
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe('gpt-3.5-turbo')
  })

  it('classifies http failures via the scheduler semantics', async () => {
    for (const [status, kind] of [
      [429, 'rate_limited'],
      [401, 'invalid'],
      [403, 'invalid'],
      [500, 'retryable'],
      [400, 'bad_request']
    ]) {
      const r = await probeKey({ baseUrl: 'https://x.com', apiKey: 'k' }, async () => res(status))
      expect(r.ok).toBe(false)
      expect(r.kind).toBe(kind)
      expect(r.status).toBe(status)
      expect(r.detail).toBe('error body')
    }
  })

  it('truncates error detail to 300 chars', async () => {
    const r = await probeKey({ baseUrl: 'https://x.com', apiKey: 'k' }, async () =>
      res(503, 'x'.repeat(500))
    )
    expect(r.detail).toHaveLength(300)
  })

  it('returns network_error with the cause chain on fetch failure', async () => {
    const err = new Error('fetch failed')
    err.cause = new Error('ECONNREFUSED')
    const r = await probeKey({ baseUrl: 'https://x.com', apiKey: 'k' }, async () => {
      throw err
    })
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('network_error')
    expect(r.status).toBe(0)
    expect(r.detail).toContain('fetch failed')
    expect(r.detail).toContain('ECONNREFUSED')
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('survives a res.text() rejection on http failure', async () => {
    const r = await probeKey({ baseUrl: 'https://x.com', apiKey: 'k' }, async () => ({
      ok: false,
      status: 502,
      text: async () => {
        throw new Error('stream gone')
      }
    }))
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('retryable')
    expect(r.detail).toBe('')
  })
})
