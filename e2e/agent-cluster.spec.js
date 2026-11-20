import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeApp, launchApp, setupProviderAndKey, unexpectedErrors } from './helpers'

// Agent 集群：开启后一次派发多个子 Agent 并行执行（真实 Promise.all 并发）
let ctx

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('Agent 集群并发派发', () => {
  it('开启集群后一次派发 3 个子任务并发执行并汇总', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    mock.state.clusterSpawn = true

    await win.getByTestId('nav-chat').click()
    await win.getByTestId('new-conv').click()
    await win.getByTestId('agent-toggle').click()
    await win.getByRole('menuitemradio', { name: /自主模式/ }).click()

    // 开启集群
    const cluster = win.getByTestId('composer-cluster')
    await cluster.click()
    expect(await cluster.getAttribute('aria-pressed')).toBe('true')

    await win.getByTestId('chat-input').fill('并行处理这三件事')
    await win.keyboard.press('Enter')

    // 子 Agent 的工具调用会请求确认；允许后继续
    await win.getByText('Agent 请求确认').waitFor({ timeout: 45000 })
    await win.getByText('允许执行', { exact: true }).click()

    // 任务完成：结果落在「智能任务」页的执行记录里（会话主区不渲染 Agent 正文）
    await win.getByTestId('nav-agent').click()
    await win.getByTestId('agent-run').first().waitFor({ timeout: 60000 })
    await win.getByTestId('agent-run').first().click()
    // 汇总正文落在折叠的结果区，这里只断言内容已真实落库渲染
    await win.getByText('集群任务完成。').first().waitFor({ state: 'attached', timeout: 60000 })

    // 并发证据：同时在途的子 Agent 数峰值 > 1（串行执行时峰值只会是 1）
    console.log('subPeak', mock.state.subPeak)
    expect(mock.state.subPeak).toBeGreaterThan(1)
    // 三个子任务都各自收到了模型请求（system prompt 标识为子 Agent）
    const subReqs = mock.state.requests.filter((r) =>
      String(
        (((r.body || {}).messages || []).find((m) => m.role === 'system') || {}).content || ''
      ).includes('被主 Agent 派出的子 Agent')
    )
    expect(subReqs.length).toBeGreaterThanOrEqual(3)

    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})
