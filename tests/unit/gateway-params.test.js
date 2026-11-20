import { describe, expect, it } from 'vitest'

import { effectiveParams } from '../../electron/main/gateway/index'

// 采样参数优先级：全局设置（设置 → 会话）→ 该模型参数 → 不发送（用服务端默认）。
// 会话级 contextPolicy 只作旧数据兼容层，不再由界面写入。
// 真实形态：providers.models 在 DB 里存的是 JSON 字符串
const provider = {
  models: JSON.stringify([
    { id: 'm1', temperature: 0.4, topP: 0.6, maxTokens: 512, maxChars: 9000 }
  ])
}

describe('effectiveParams 采样参数优先级', () => {
  it('全局设置为空时回退到该模型参数', () => {
    const p = effectiveParams({}, provider, 'm1', {})
    expect(p.temperature).toBe(0.4)
    expect(p.topP).toBe(0.6)
    expect(p.maxTokens).toBe(512)
    expect(p.maxChars).toBe(9000)
  })

  it('全局设置覆盖模型参数（仅覆盖显式设置过的字段）', () => {
    const p = effectiveParams({ temperature: 1.1 }, provider, 'm1', {})
    expect(p.temperature).toBe(1.1)
    // 未设置的字段仍回退模型参数，不被清空
    expect(p.topP).toBe(0.6)
  })

  it('全局设置优先于旧会话策略', () => {
    const p = effectiveParams({ temperature: 0.2 }, provider, 'm1', { temperature: 1.5 })
    expect(p.temperature).toBe(0.2)
  })

  it('模型未配置且全局未设置时不发送这些参数', () => {
    const bare = { models: JSON.stringify([{ id: 'm2' }]) }
    const p = effectiveParams({}, bare, 'm2', {})
    expect(p.temperature).toBeUndefined()
    expect(p.topP).toBeUndefined()
    expect(p.maxTokens).toBeUndefined()
  })

  it('0 与空字符串的边界：0 是有效值，空字符串视为未设置', () => {
    const zero = effectiveParams({ temperature: 0 }, provider, 'm1', {})
    expect(zero.temperature).toBe(0)
    const blank = effectiveParams({ temperature: '' }, provider, 'm1', {})
    expect(blank.temperature).toBe(0.4)
  })

  it('保留轮数取全局设置，模型参数不参与', () => {
    expect(effectiveParams({ keepTurns: 35 }, provider, 'm1', {}).keepTurns).toBe(35)
    expect(effectiveParams({}, provider, 'm1', {}).keepTurns).toBeUndefined()
  })
})
