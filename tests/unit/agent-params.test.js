import { describe, expect, it } from 'vitest'
import { resolveAgentParams } from '../../electron/main/agent'

// Agent 任务链路的采样参数解析。
// 回归护栏：doAgentRun 拿到的是 getAllSettings() 的全量对象，必须先取其中的
// chatSampling 再交给 effectiveParams；若把整包 settings 当作旧会话策略传入，
// 设置页里的全局采样参数对智能任务就完全不生效（曾出现的真实缺陷）。
const provider = {
  models: JSON.stringify([
    { id: 'm1', temperature: 0.4, topP: 0.6, maxTokens: 512, maxChars: 9000 }
  ])
}

describe('resolveAgentParams 全局采样设置生效', () => {
  it('全局 chatSampling 覆盖模型参数（不再被整包 settings 顶掉）', () => {
    const settings = { chatSampling: { temperature: 1.1, topP: 1, keepTurns: 35 } }
    const p = resolveAgentParams(settings, { contextPolicy: '{}' }, provider, 'm1')
    expect(p.temperature).toBe(1.1)
    expect(p.topP).toBe(1)
    expect(p.keepTurns).toBe(35)
  })

  it('未设置全局采样时回退到模型参数', () => {
    const p = resolveAgentParams({}, { contextPolicy: '{}' }, provider, 'm1')
    expect(p.temperature).toBe(0.4)
    expect(p.topP).toBe(0.6)
    expect(p.maxTokens).toBe(512)
    expect(p.maxChars).toBe(9000)
  })

  it('旧会话 contextPolicy 仍可回放，但优先级低于全局设置', () => {
    const conv = { contextPolicy: JSON.stringify({ temperature: 1.5 }) }
    expect(resolveAgentParams({}, conv, provider, 'm1').temperature).toBe(1.5)
    const settings = { chatSampling: { temperature: 0.2 } }
    expect(resolveAgentParams(settings, conv, provider, 'm1').temperature).toBe(0.2)
  })

  it('agent 相关设置项不应被误当成采样字段', () => {
    // 整包 settings 里含有大量非采样键，不能被读成 temperature/topP 等
    const settings = { chatSampling: {}, agentAuthorizedDirs: ['C:\\work'], theme: 'dark' }
    const p = resolveAgentParams(settings, null, provider, 'm1')
    expect(p.temperature).toBe(0.4)
    expect(p.topP).toBe(0.6)
    expect(p.maxChars).toBe(9000)
  })
})
