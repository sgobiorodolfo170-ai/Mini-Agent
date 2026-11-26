import { describe, expect, it } from 'vitest'
import { runAgentLoop, safeParseJson } from '../../electron/main/agent/loop'

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

describe('safeParseJson', () => {
  it('returns null on malformed input', () => {
    expect(safeParseJson('{oops')).toBeNull()
    expect(safeParseJson('{"a":1}')).toEqual({ a: 1 })
  })
})

describe('runAgentLoop', () => {
  const echoTool = {
    name: 'echo',
    risk: 'side_effect',
    handler: async (args) => 'echo:' + args.text
  }
  const toolMap = { echo: echoTool }

  it('runs tool calls and finishes when the model stops', async () => {
    const script = [
      { content: '', toolCalls: [toolCall('c1', 'echo', { text: 'hi' })] },
      { content: '完成', toolCalls: [] }
    ]
    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'go' }],
      toolMap,
      modelCall: async () => script.shift(),
      decide: async () => ({ allowed: true, confirmedBy: 'auto' }),
      execute: async (tool, args) => tool.handler(args)
    })
    expect(result.status).toBe('done')
    expect(result.steps).toBe(2)
    const toolMsg = result.messages.find((m) => m.role === 'tool')
    expect(toolMsg.content).toBe('echo:hi')
    expect(result.messages.at(-1).content).toBe('完成')
  })

  it('feeds denial back as a tool result', async () => {
    const script = [
      { content: '', toolCalls: [toolCall('c1', 'echo', { text: 'x' })] },
      { content: '好的，不执行了', toolCalls: [] }
    ]
    const result = await runAgentLoop({
      messages: [],
      toolMap,
      modelCall: async () => script.shift(),
      decide: async () => ({ allowed: false, confirmedBy: 'denied' }),
      execute: async (tool, args) => tool.handler(args)
    })
    expect(result.messages.find((m) => m.role === 'tool').content).toBe('用户拒绝执行该操作')
  })

  it('reports unknown tools', async () => {
    const script = [
      { content: '', toolCalls: [toolCall('c1', 'nope', {})] },
      { content: '收到', toolCalls: [] }
    ]
    const result = await runAgentLoop({
      messages: [],
      toolMap,
      modelCall: async () => script.shift(),
      execute: async (_tool) => ''
    })
    expect(result.messages.find((m) => m.role === 'tool').content).toContain('未知工具')
  })

  it('stops at max_steps when the model keeps calling tools', async () => {
    const result = await runAgentLoop({
      messages: [],
      toolMap,
      maxSteps: 3,
      modelCall: async () => ({
        content: '',
        toolCalls: [toolCall('c', 'echo', { text: 'loop' })]
      }),
      decide: async () => ({ allowed: true, confirmedBy: 'auto' }),
      execute: async (tool, args) => tool.handler(args)
    })
    expect(result.status).toBe('max_steps')
    expect(result.steps).toBe(3)
  })

  it('stops when isStopped turns true', async () => {
    let stopped = false
    const result = await runAgentLoop({
      messages: [],
      toolMap,
      modelCall: async () => ({ content: '', toolCalls: [toolCall('c', 'echo', { text: 'x' })] }),
      isStopped: () => stopped,
      decide: async () => ({ allowed: true, confirmedBy: 'auto' }),
      execute: async (tool) => {
        stopped = true
        return tool.handler({ text: 'x' })
      }
    })
    expect(result.status).toBe('stopped')
  })

  it('exposes phase and step before a model call can hang', async () => {
    const heartbeats = []
    const checkpoints = []
    const result = await runAgentLoop({
      messages: [],
      toolMap,
      modelCall: async (_msgs, context) => {
        expect(heartbeats.at(-1)).toMatchObject({
          phase: 'model_call',
          step: 1,
          stepsUsed: 1
        })
        expect(context).toMatchObject({ phase: 'model_call', step: 1, stepsUsed: 1 })
        return { content: '完成', toolCalls: [] }
      },
      onHeartbeat: (snapshot) => heartbeats.push(snapshot),
      onCheckpoint: (snapshot) => checkpoints.push(snapshot)
    })
    expect(result.status).toBe('done')
    expect(checkpoints[0]).toMatchObject({ phase: 'before_model', step: 1, stepsUsed: 1 })
    expect(heartbeats.map((entry) => entry.phase)).toEqual([
      'before_model',
      'model_call',
      'model_done'
    ])
  })

  it('captures tool execution failures', async () => {
    const script = [
      { content: '', toolCalls: [toolCall('c1', 'echo', {})] },
      { content: '好', toolCalls: [] }
    ]
    const result = await runAgentLoop({
      messages: [],
      toolMap,
      modelCall: async () => script.shift(),
      decide: async () => ({ allowed: true, confirmedBy: 'auto' }),
      execute: async () => {
        throw new Error('disk full')
      }
    })
    expect(result.messages.find((m) => m.role === 'tool').content).toContain('disk full')
  })
})
