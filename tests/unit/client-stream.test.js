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

  it('times out a fetch that hangs before returning a response', async () => {
    const fetchImpl = () => new Promise(() => {})
    await expect(
      chatStream(
        { baseUrl: 'https://x/v1', apiKey: 'sk', payload: {} },
        {
          fetchImpl,
          timeouts: { connectTimeoutMs: 20, firstByteTimeoutMs: 0, totalTimeoutMs: 0 }
        }
      )
    ).rejects.toMatchObject({ kind: 'timeout', timedOut: true, phase: 'connect' })
  })

  it('times out before the first body byte even if the body ignores abort', async () => {
    const res = {
      ok: true,
      status: 200,
      body: (async function* () {
        yield* []
        await new Promise(() => {})
      })()
    }
    await expect(
      chatStream(
        { baseUrl: 'https://x/v1', apiKey: 'sk', payload: {} },
        {
          fetchImpl: async () => res,
          timeouts: { connectTimeoutMs: 0, firstByteTimeoutMs: 20, totalTimeoutMs: 0 }
        }
      )
    ).rejects.toMatchObject({ kind: 'timeout', timedOut: true, phase: 'first_byte' })
  })

  it('times out a partial first event after bytes have arrived', async () => {
    const res = {
      ok: true,
      status: 200,
      body: (async function* () {
        yield Buffer.from('data: {"choices":')
        await new Promise(() => {})
      })()
    }
    await expect(
      chatStream(
        { baseUrl: 'https://x/v1', apiKey: 'sk', payload: {} },
        {
          fetchImpl: async () => res,
          timeouts: { connectTimeoutMs: 0, firstByteTimeoutMs: 20, totalTimeoutMs: 0 }
        }
      )
    ).rejects.toMatchObject({ kind: 'timeout', phase: 'first_event' })
  })

  it('times out an idle stream after its first event', async () => {
    const res = {
      ok: true,
      status: 200,
      body: (async function* () {
        yield Buffer.from('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
        await new Promise(() => {})
      })()
    }
    await expect(
      chatStream(
        { baseUrl: 'https://x/v1', apiKey: 'sk', payload: {} },
        {
          fetchImpl: async () => res,
          timeouts: {
            connectTimeoutMs: 0,
            firstByteTimeoutMs: 1000,
            idleTimeoutMs: 20,
            totalTimeoutMs: 0
          }
        }
      )
    ).rejects.toMatchObject({ kind: 'timeout', phase: 'idle' })
  })

  it('does not kill a stream while deltas continue arriving', async () => {
    const deltas = []
    const res = {
      ok: true,
      status: 200,
      body: (async function* () {
        for (let i = 0; i < 5; i++) {
          yield Buffer.from(`data: {"choices":[{"delta":{"content":"${i}"}}]}\n\n`)
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        yield Buffer.from('data: [DONE]\n\n')
      })()
    }
    const result = await chatStream(
      { baseUrl: 'https://x/v1', apiKey: 'sk', payload: {} },
      {
        fetchImpl: async () => res,
        onDelta: (delta) => deltas.push(delta),
        timeouts: {
          connectTimeoutMs: 0,
          firstByteTimeoutMs: 100,
          idleTimeoutMs: 30,
          totalTimeoutMs: 500
        }
      }
    )
    expect(result.content).toBe('01234')
    expect(deltas).toEqual(['0', '1', '2', '3', '4'])
  })

  it('enforces total duration even while bytes continue arriving', async () => {
    const res = {
      ok: true,
      status: 200,
      body: (async function* () {
        for (let i = 0; i < 10; i++) {
          yield Buffer.from(`data: {"choices":[{"delta":{"content":"x"}}]}\n\n`)
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      })()
    }
    await expect(
      chatStream(
        { baseUrl: 'https://x/v1', apiKey: 'sk', payload: {} },
        {
          fetchImpl: async () => res,
          timeouts: {
            connectTimeoutMs: 0,
            firstByteTimeoutMs: 1000,
            idleTimeoutMs: 1000,
            totalTimeoutMs: 25
          }
        }
      )
    ).rejects.toMatchObject({ kind: 'timeout', phase: 'total' })
  })

  it('propagates external cancellation during a hung fetch as AbortError', async () => {
    const ac = new AbortController()
    const pending = chatStream(
      { baseUrl: 'https://x/v1', apiKey: 'sk', payload: {} },
      { fetchImpl: () => new Promise(() => {}), signal: ac.signal }
    )
    setTimeout(() => ac.abort(), 20)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(pending).rejects.not.toMatchObject({ kind: 'timeout' })
  })

  it('propagates external cancellation of an abort-ignoring body with timeouts disabled', async () => {
    const ac = new AbortController()
    const res = {
      ok: true,
      status: 200,
      body: (async function* () {
        yield* []
        await new Promise(() => {})
      })()
    }
    const pending = chatStream(
      { baseUrl: 'https://x/v1', apiKey: 'sk', payload: {} },
      {
        fetchImpl: async () => res,
        signal: ac.signal,
        timeouts: {
          connectTimeoutMs: 0,
          firstByteTimeoutMs: 0,
          idleTimeoutMs: 0,
          totalTimeoutMs: 0
        }
      }
    )
    setTimeout(() => ac.abort(), 20)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(pending).rejects.not.toMatchObject({ kind: 'timeout' })
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
