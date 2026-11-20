import { describe, expect, it } from 'vitest'
import { buildContext, renderKbSystem } from '../../electron/main/gateway/context'

describe('buildContext', () => {
  it('keeps system prompt first and respects turn budget', () => {
    const history = []
    for (let i = 0; i < 50; i++) {
      history.push({ role: 'user', content: 'u'.repeat(100) + i })
      history.push({ role: 'assistant', content: 'a'.repeat(100) + i })
    }
    const msgs = buildContext({ systemPrompt: '你是助手', history, maxChars: 800, keepTurns: 50 })
    expect(msgs[0].content).toBe('你是助手')
    // Each message ~101 chars; budget 800 → at least 3 messages picked, all from the tail.
    expect(msgs.length).toBeGreaterThanOrEqual(3)
    const joined = msgs.map((m) => m.content).join('')
    expect(joined.endsWith(history[history.length - 1].content)).toBe(true)
  })
  it('always includes at least one message even if over budget', () => {
    const history = [{ role: 'user', content: 'x'.repeat(50000) }]
    const msgs = buildContext({ systemPrompt: '', history, maxChars: 100 })
    expect(msgs).toHaveLength(1)
  })
  it('renders kb blocks with citations', () => {
    const msgs = buildContext({
      systemPrompt: '',
      history: [{ role: 'user', content: 'q' }],
      kbBlocks: [{ n: 1, title: '文档A', headingPath: '第1章', text: '内容' }]
    })
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('[1] 来源：文档A > 第1章')
  })
})

describe('renderKbSystem', () => {
  it('numbers blocks in order', () => {
    const s = renderKbSystem([
      { n: 1, title: 'A', text: 'x' },
      { n: 2, title: 'B', text: 'y' }
    ])
    expect(s).toContain('[1]')
    expect(s).toContain('[2]')
  })
})
