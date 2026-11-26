import { describe, expect, it } from 'vitest'
import { defineTools } from '../../electron/main/agent/tools'

// spawn_agent 的新契约：单任务用 goal；集群模式用 goals 批量派发。
// 这里只验证工具层的参数归一与校验，真实并发由 agent/index.js 的 Promise.all 承担。
function buildCtx(spawnAgent) {
  return {
    cluster: true,
    authorizedDirs: [],
    workingDir: process.cwd(),
    clipboard: { readText: () => '', writeText: () => {} },
    spawnAgent
  }
}

describe('spawn_agent 参数归一', () => {
  it('单个 goal 透传为 { goal }', async () => {
    const calls = []
    const map = Object.fromEntries(
      defineTools(
        buildCtx(async (arg) => {
          calls.push(arg)
          return '结论'
        })
      ).map((t) => [t.name, t])
    )
    expect(await map.spawn_agent.handler({ goal: '统计行数' })).toBe('结论')
    expect(calls).toEqual([{ goal: '统计行数' }])
  })

  it('多个 goals 合并为一次批量派发', async () => {
    const calls = []
    const map = Object.fromEntries(
      defineTools(
        buildCtx(async (arg) => {
          calls.push(arg)
          return '结论'
        })
      ).map((t) => [t.name, t])
    )
    await map.spawn_agent.handler({ goals: ['任务A', '任务B'] })
    expect(calls).toEqual([{ goals: ['任务A', '任务B'] }])
  })

  it('goal 与 goals 同时给出时优先批量；空输入报错', async () => {
    const calls = []
    const map = Object.fromEntries(
      defineTools(
        buildCtx(async (arg) => {
          calls.push(arg)
          return '结论'
        })
      ).map((t) => [t.name, t])
    )
    await map.spawn_agent.handler({ goal: '单个', goals: ['任务A', '任务B'] })
    expect(calls[0]).toEqual({ goals: ['任务A', '任务B'] })
    await expect(map.spawn_agent.handler({ goal: ' ', goals: ['  '] })).rejects.toThrow(/goal/)
    await expect(map.spawn_agent.handler({})).rejects.toThrow(/goal/)
  })

  it('未启用子 Agent 时明确报错', async () => {
    const map = Object.fromEntries(defineTools(buildCtx(undefined)).map((t) => [t.name, t]))
    await expect(map.spawn_agent.handler({ goal: 'x' })).rejects.toThrow(/未启用/)
  })
})
