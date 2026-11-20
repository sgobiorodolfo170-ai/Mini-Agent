import { describe, expect, it } from 'vitest'
import { chatStream } from '../../electron/main/gateway/client'

function abortErr() {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

function sseBody(lines, signal) {
  return (async function* () {
    for (const l of lines) yield Buffer.from(l)
    if (signal) {
      await new Promise((_, reject) => {
        if (signal.aborted) return reject(abortErr())
        signal.addEventListener('abort', () => reject(abortErr()))
      })
    }
  })()
}

describe('chatStream', () => {
  it('streams deltas and assembles content, finishReason and usage', async () => {
    const deltas = []
    const res = {
      ok: true,
      status: 200,
      body: sseBody([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":7}}\n\n',
        'data: [DONE]\n\n'
      ])
    }
    const r = await chatStream(
      { baseUrl: 'https://x/v1', apiKey: 'sk', payload: {} },
      {
        fetchImpl: async () => res,
        onDelta: (d) => deltas.push(d)
      }
    )
    expect(deltas).toEqual(['你', '好'])
    expect(r.content).toBe('你好')
    expect(r.finishReason).toBe('stop')
    expect(r.usage).toEqual({ total_tokens: 7 })
  })

  it('assembles streamed tool_calls fragments', async () => {
    const res = {
      ok: true,
      status: 200,
      body: sseBody([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"C:/a\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    }
    const r = await chatStream(
      { baseUrl: 'https://x/v1', apiKey: 'sk', payload: {} },
      { fetchImpl: async () => res }
    )
    expect(r.finishReason).toBe('tool_calls')
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].id).toBe('c1')
    expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ path: 'C:/a' })
  })

  it('throws GatewayError with classified kind on http error', async () => {
    const res = { ok: false, status: 429, text: async () => 'slow down' }
    await expect(
      chatStream(
        { baseUrl: 'https://x/v1', apiKey: 'sk', payload: {} },
        { fetchImpl: async () => res }
      )
    ).rejects.toMatchObject({ kind: 'rate_limited', status: 429 })
  })

  it('wraps network failures as network_error', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED')
    }
    await expect(
      chatStream({ baseUrl: 'https://x/v1', apiKey: 'sk', payload: {} }, { fetchImpl })
    ).rejects.toMatchObject({ kind: 'network_error' })
  })

  it('propagates AbortError untouched', async () => {
    const ac = new AbortController()
    const res = {
      ok: true,
      status: 200,
      body: sseBody(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n'], ac.signal)
    }
    await expect(
      chatStream(
        { baseUrl: 'https://x/v1', apiKey: 'sk', payload: {} },
        {
          fetchImpl: async () => res,
          signal: ac.signal,
          onDelta: () => setTimeout(() => ac.abort(), 30)
        }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
