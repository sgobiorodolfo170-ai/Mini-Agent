import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyHttpStatus,
  joinUrl,
  mergeToolCall,
  GatewayError
} from '../../electron/main/gateway/client'
import { sseEvents } from '../../electron/main/gateway/sse'

describe('classifyHttpStatus', () => {
  it('maps statuses to scheduler semantics', () => {
    expect(classifyHttpStatus(401)).toBe('invalid')
    expect(classifyHttpStatus(403)).toBe('invalid')
    expect(classifyHttpStatus(429)).toBe('rate_limited')
    expect(classifyHttpStatus(500)).toBe('retryable')
    expect(classifyHttpStatus(400)).toBe('bad_request')
    expect(classifyHttpStatus(200)).toBe('retryable')
  })
})

describe('joinUrl', () => {
  it('joins base url with path handling trailing slashes', () => {
    expect(joinUrl('https://x.com/v1', '/chat/completions')).toBe(
      'https://x.com/v1/chat/completions'
    )
    expect(joinUrl('https://x.com/v1/', '/chat/completions')).toBe(
      'https://x.com/v1/chat/completions'
    )
  })
})

describe('mergeToolCall', () => {
  it('accumulates streamed tool call fragments by index', () => {
    const acc = []
    mergeToolCall(acc, {
      index: 0,
      id: 'call1',
      function: { name: 'read_file', arguments: '{"pa' }
    })
    mergeToolCall(acc, { index: 0, function: { arguments: 'th": "C:/a"}' } })
    mergeToolCall(acc, { index: 1, id: 'call2', function: { name: 'list_dir', arguments: '{}' } })
    expect(acc).toHaveLength(2)
    expect(acc[0]).toEqual({
      id: 'call1',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path": "C:/a"}' }
    })
    expect(acc[1].function.name).toBe('list_dir')
  })
})

describe('GatewayError', () => {
  it('carries kind and status', () => {
    const e = new GatewayError('rate_limited', 429, 'slow down')
    expect(e.kind).toBe('rate_limited')
    expect(e.status).toBe(429)
    expect(e.message).toBe('slow down')
  })
})

describe('sseEvents', () => {
  afterEach(() => vi.useRealTimers())

  async function* bytes(chunks) {
    for (const c of chunks) yield Buffer.from(c)
  }
  async function collect(chunks) {
    const out = []
    for await (const ev of sseEvents(bytes(chunks))) out.push(ev)
    return out
  }
  it('parses data events and stops at [DONE]', async () => {
    const out = await collect([
      'data: {"a":1}\n\n',
      'data: {"a":2}\n\n',
      'data: [DONE]\n\n',
      'data: {"a":3}\n\n'
    ])
    expect(out).toEqual([{ a: 1 }, { a: 2 }])
  })
  it('yields events before [DONE] when they share a chunk', async () => {
    const out = await collect(['data: {"a":1}\n\ndata: [DONE]\n\ndata: {"a":2}\n\n'])
    expect(out).toEqual([{ a: 1 }])
  })
  it('buffers events split across chunks', async () => {
    const out = await collect(['data: {"a":', '1}\n\ndata', ': {"b":2}\n\n'])
    expect(out).toEqual([{ a: 1 }, { b: 2 }])
  })
  it('skips malformed json and non-data lines', async () => {
    const out = await collect([': ping\n\n', 'data: not-json\n\n', 'data: {"ok":true}\n\n'])
    expect(out).toEqual([{ ok: true }])
  })
  it('times out the first event and clears its timer', async () => {
    vi.useFakeTimers()
    async function* stalled() {
      yield* []
      await new Promise(() => {})
    }
    const pending = (async () => {
      const out = []
      for await (const event of sseEvents(stalled(), { firstEventTimeoutMs: 25 })) out.push(event)
      return out
    })()
    const rejection = expect(pending).rejects.toMatchObject({
      kind: 'timeout',
      phase: 'first_event'
    })
    await vi.advanceTimersByTimeAsync(25)
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })
  it('refreshes idle time for each chunk and clears timers on completion', async () => {
    vi.useFakeTimers()
    async function* active() {
      yield Buffer.from('data: {"a":1}\n\n')
      await new Promise((resolve) => setTimeout(resolve, 20))
      yield Buffer.from('data: {"a":2}\n\n')
      await new Promise((resolve) => setTimeout(resolve, 20))
      yield Buffer.from('data: [DONE]\n\n')
    }
    const pending = (async () => {
      const out = []
      for await (const event of sseEvents(active(), {
        firstEventTimeoutMs: 100,
        idleTimeoutMs: 30
      }))
        out.push(event)
      return out
    })()
    await vi.advanceTimersByTimeAsync(40)
    expect(await pending).toEqual([{ a: 1 }, { a: 2 }])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('times out an idle stream and removes its abort listener', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    const remove = vi.spyOn(ac.signal, 'removeEventListener')
    async function* stalled() {
      yield Buffer.from('data: {"a":1}\n\n')
      await new Promise(() => {})
    }
    const pending = (async () => {
      for await (const event of sseEvents(stalled(), { signal: ac.signal, idleTimeoutMs: 25 })) {
        void event // Drain the first event.
      }
    })()
    const rejection = expect(pending).rejects.toMatchObject({ kind: 'timeout', phase: 'idle' })
    await vi.advanceTimersByTimeAsync(25)
    await rejection
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })
  it('races external abort with a hung read when all timeouts are disabled', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    const add = vi.spyOn(ac.signal, 'addEventListener')
    const remove = vi.spyOn(ac.signal, 'removeEventListener')
    const next = vi.fn(() => new Promise(() => {}))
    const close = vi.fn(async () => ({ done: true }))
    const body = { [Symbol.asyncIterator]: () => ({ next, return: close }) }
    const pending = (async () => {
      for await (const event of sseEvents(body, {
        signal: ac.signal,
        firstEventTimeoutMs: 0,
        idleTimeoutMs: 0
      })) {
        void event
      }
    })()

    await vi.advanceTimersByTimeAsync(0)
    expect(next).toHaveBeenCalledOnce()
    ac.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(close).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('times out immediately when the first-event budget is exhausted', async () => {
    vi.useFakeTimers()
    const next = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: Buffer.from('data: {"a":') })
      .mockImplementation(() => new Promise(() => {}))
    const close = vi.fn(async () => ({ done: true }))
    const body = { [Symbol.asyncIterator]: () => ({ next, return: close }) }
    const onTimeout = vi.fn()
    const pending = (async () => {
      for await (const event of sseEvents(body, {
        firstEventTimeoutMs: 10,
        idleTimeoutMs: 0,
        onChunk: () => vi.advanceTimersByTime(10),
        onTimeout
      })) {
        void event
      }
    })()

    await expect(pending).rejects.toMatchObject({
      kind: 'timeout',
      phase: 'first_event',
      timeoutMs: 0
    })
    expect(next).toHaveBeenCalledOnce()
    expect(onTimeout).toHaveBeenCalledWith(expect.objectContaining({ phase: 'first_event' }))
    expect(close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('completes normally without timers when all timeouts are disabled', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    const remove = vi.spyOn(ac.signal, 'removeEventListener')
    const out = []
    for await (const event of sseEvents(bytes(['data: {"a":1}\n\n', 'data: [DONE]\n\n']), {
      signal: ac.signal,
      firstEventTimeoutMs: 0,
      idleTimeoutMs: 0
    })) {
      out.push(event)
    }
    expect(out).toEqual([{ a: 1 }])
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })
})
