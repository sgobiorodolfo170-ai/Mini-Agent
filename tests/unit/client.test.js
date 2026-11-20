import { describe, expect, it } from 'vitest'
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
  it('buffers events split across chunks', async () => {
    const out = await collect(['data: {"a":', '1}\n\ndata', ': {"b":2}\n\n'])
    expect(out).toEqual([{ a: 1 }, { b: 2 }])
  })
  it('skips malformed json and non-data lines', async () => {
    const out = await collect([': ping\n\n', 'data: not-json\n\n', 'data: {"ok":true}\n\n'])
    expect(out).toEqual([{ ok: true }])
  })
})
