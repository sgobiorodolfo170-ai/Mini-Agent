import { describe, expect, it, vi } from 'vitest'
import {
  ACTIONS,
  STAGES,
  normalizeRule,
  parseHooks,
  runHooks,
  applyHooks
} from '../../electron/main/events/hooks'

describe('hooks 配置解析', () => {
  it('暴露固定的阶段与动作白名单', () => {
    expect(STAGES).toEqual(['session.send', 'run.start', 'run.end', 'tool.before', 'tool.after'])
    expect(ACTIONS).toEqual(['notify', 'log', 'block'])
  })

  it('丢弃非法阶段/动作，保留合法项', () => {
    const rules = parseHooks([
      { stage: 'tool.before', action: 'block', match: { tool: 'run_command' } },
      { stage: 'nope', action: 'block' },
      { stage: 'run.end', action: 'exec' },
      null,
      'x'
    ])
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ stage: 'tool.before', action: 'block' })
  })

  it('accepts JSON string and returns [] on broken JSON', () => {
    expect(parseHooks('[{"stage":"run.end","action":"notify"}]')).toHaveLength(1)
    expect(parseHooks('{oops')).toEqual([])
    expect(parseHooks(null)).toEqual([])
  })

  it('normalizeRule 补齐 id / enabled，并为 block 提供默认 reason', () => {
    const r = normalizeRule({ stage: 'run.end', action: 'block' }, 2)
    expect(r.id).toBe('h3')
    expect(r.enabled).toBe(true)
    expect(r.reason).toBe('已被钩子策略拦截')
    const off = normalizeRule({ stage: 'run.end', action: 'log', enabled: false }, 0)
    expect(off.enabled).toBe(false)
  })

  it('超长 message/reason 被截断', () => {
    const r = normalizeRule({ stage: 'run.end', action: 'block', reason: 'x'.repeat(999) }, 0)
    expect(r.reason.length).toBe(300)
  })
})

describe('hooks 命中与执行', () => {
  const rules = parseHooks([
    { id: 'n1', stage: 'run.end', action: 'notify', message: '完成' },
    {
      id: 'b1',
      stage: 'tool.before',
      action: 'block',
      match: { tool: 'run_command' },
      reason: '禁命令'
    },
    { id: 'l1', stage: 'tool.after', action: 'log', match: { tool: 'write_*' } }
  ])

  it('notify 命中收集通知而不拦截', () => {
    const r = runHooks(rules, 'run.end', { runId: 'r1' })
    expect(r.blocked).toBe(false)
    expect(r.notifications).toEqual([{ ruleId: 'n1', level: 'info', message: '完成' }])
  })

  it('block 命中即拦截并带出规则来源', () => {
    const r = runHooks(rules, 'tool.before', { tool: 'run_command', runId: 'r1' })
    expect(r.blocked).toBe(true)
    expect(r.reason).toBe('禁命令')
    expect(r.blockedBy).toBe('b1')
  })

  it('同阶段其他工具不命中 block', () => {
    const r = runHooks(rules, 'tool.before', { tool: 'read_file' })
    expect(r.blocked).toBe(false)
  })

  it('match 支持前缀通配（write_*）', () => {
    const r = runHooks(rules, 'tool.after', { tool: 'write_file' })
    expect(r.logs.map((l) => l.ruleId)).toEqual(['l1'])
    expect(runHooks(rules, 'tool.after', { tool: 'read_file' }).logs).toHaveLength(0)
  })

  it('stage 不匹配时完全不触发', () => {
    const r = runHooks(rules, 'session.send', { tool: 'run_command' })
    expect(r.blocked).toBe(false)
    expect(r.notifications).toHaveLength(0)
    expect(r.logs).toHaveLength(0)
  })

  it('match 可按 run / session 维度过滤', () => {
    const scoped = parseHooks([
      { stage: 'run.start', action: 'log', match: { run: 'r-*' } },
      { stage: 'run.start', action: 'log', match: { session: 'c1' } }
    ])
    const r = runHooks(scoped, 'run.start', { runId: 'r-9', conversationId: 'c2' })
    expect(r.logs.map((l) => l.ruleId)).toEqual(['h1'])
  })

  it('多项 block 只报告第一条，且不因重复命中报错', () => {
    const two = parseHooks([
      { id: 'b1', stage: 'tool.before', action: 'block', reason: 'A' },
      { id: 'b2', stage: 'tool.before', action: 'block', reason: 'B' }
    ])
    const r = runHooks(two, 'tool.before', {})
    expect(r.blocked).toBe(true)
    expect(r.blockedBy).toBe('b1')
    expect(r.reason).toBe('A')
  })
})

describe('hooks 副作用执行', () => {
  it('applyHooks 广播通知并回传日志', () => {
    const broadcast = vi.fn()
    const log = vi.fn()
    const rules = parseHooks([
      { stage: 'run.end', action: 'notify', message: '跑完了' },
      { stage: 'run.end', action: 'log', message: 'audit' }
    ])
    const r = applyHooks(rules, 'run.end', { runId: 'r1' }, { broadcast, log })
    expect(broadcast).toHaveBeenCalledWith('app:notice', { level: 'info', message: '跑完了' })
    expect(log).toHaveBeenCalledTimes(1)
    expect(r.notifications).toHaveLength(1)
  })

  it('缺少 sink 时安全降级（不抛错）', () => {
    const rules = parseHooks([{ stage: 'run.end', action: 'notify' }])
    expect(() => applyHooks(rules, 'run.end', {})).not.toThrow()
  })
})
