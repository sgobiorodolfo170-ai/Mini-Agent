import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeApp, launchApp, setupProviderAndKey, unexpectedErrors } from './helpers'

// Agent 集群：开启后一次派发多个子 Agent 并行执行（由任务调度器并发执行）
let ctx

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('Agent 集群并发派发', () => {
  it('开启集群后一次派发 2 个子任务并发执行并汇总', async () => {
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

    await win.getByTestId('chat-input').fill('并行处理这两件事')
    await win.keyboard.press('Enter')

    // 模型先创建计划草稿，确认工具触发审批；此时不应有子 Agent 模型请求
    await win.getByText('Agent 请求确认').waitFor({ timeout: 45000 })
    const draft = await win.evaluate(async () => {
      const runs = await window.api.agent.runs()
      const parent = runs.find((run) => run.goal === '并行处理这两件事')
      const plans = await window.api.agent.plans(parent.id)
      return { plans, childCount: runs.filter((run) => run.parent_run_id === parent.id).length }
    })
    expect(draft.plans[0].status).toBe('draft')
    expect(draft.childCount).toBe(0)
    expect(mock.state.subPeak).toBe(0)
    await win.getByText('允许执行', { exact: true }).click()

    // 任务完成：结果落在「智能任务」页的执行记录里（会话主区不渲染 Agent 正文）
    await win.getByTestId('nav-agent').click()
    await win
      .getByTestId('agent-run')
      .filter({ hasText: '并行处理这两件事' })
      .waitFor({ timeout: 60000 })
    await win.getByTestId('agent-run').filter({ hasText: '并行处理这两件事' }).click()
    // 汇总正文落在折叠的结果区，这里只断言内容已真实落库渲染
    await win.getByText('集群任务完成。').first().waitFor({ state: 'attached', timeout: 60000 })

    // 并发证据：同时在途的子 Agent 数峰值 > 1（串行执行时峰值只会是 1）
    expect(mock.state.subPeak).toBeGreaterThan(1)
    // 两个子任务都各自收到了模型请求（system prompt 标识为子 Agent）
    const subReqs = mock.state.requests.filter((r) =>
      String(
        (((r.body || {}).messages || []).find((m) => m.role === 'system') || {}).content || ''
      ).includes('被主 Agent 派出的子 Agent')
    )
    expect(subReqs.length).toBeGreaterThanOrEqual(2)

    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

  it('移交提交后跳过同批剩余工具，并由接手 Run 产出结果', async () => {
    const { win, mock } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    mock.state.transferRun = true
    await win.getByTestId('nav-chat').click()
    await win.getByTestId('new-conv').click()
    const started = await win.evaluate(async () => {
      const conversation = window.api.conversations
      const entries = await conversation.list()
      return window.api.agent.run({
        conversationId: entries[0].id,
        permission: 'full',
        cluster: true,
        goal: '请移交任务'
      })
    })
    await expect
      .poll(() => win.evaluate((id) => window.api.agent.status(id), started.runId), {
        timeout: 15000
      })
      .toMatchObject({ status: 'transferred' })
    const parent = await win.evaluate((id) => window.api.agent.status(id), started.runId)
    expect(parent.transferToRunId).toBeTruthy()
    await expect
      .poll(
        () => win.evaluate((runId) => window.api.agent.result({ runId }), parent.transferToRunId),
        { timeout: 15000 }
      )
      .toMatchObject({ status: 'done', content: expect.stringContaining('接手目标') })
    const runs = await win.evaluate(() => window.api.agent.runs())
    expect(runs.map((run) => run.goal)).not.toContain('不得派发的目标')
    const calls = await win.evaluate((id) => window.api.agent.calls(id), started.runId)
    expect(calls.map((call) => call.tool)).toEqual(['run_transfer'])
    const rootRequests = mock.state.requests.filter(
      ({ body }) =>
        body?.tools &&
        body.messages?.some(
          (message) => message.role === 'user' && message.content === '请移交任务'
        )
    )
    expect(rootRequests).toHaveLength(1)

    await win.getByTestId('nav-agent').click()
    await win.getByTestId('agent-run').filter({ hasText: '请移交任务' }).click()
    await win.getByRole('button', { name: '查看接手任务' }).click()
    await win.getByRole('heading', { name: '接手目标', exact: true }).waitFor()
    // 控制模式与执行状态分开展示：接手 Run 明确标记来源
    expect(await win.getByTestId('run-control-mode').textContent()).toContain('移交接手')
  })

  it('从任务页停止正在执行的任务并保留停止状态', async () => {
    const { win, mock } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    mock.state.mode = 'hang'
    await win.getByTestId('nav-chat').click()
    await win.getByTestId('new-conv').click()
    const { runId } = await win.evaluate(async () => {
      const [conversation] = await window.api.conversations.list()
      return window.api.agent.run({
        conversationId: conversation.id,
        permission: 'readonly',
        goal: '停止验收任务'
      })
    })
    await expect.poll(() => mock.state.requests.some(({ body }) => body?.tools)).toBe(true)
    await win.getByTestId('nav-agent').click()
    await win.getByTestId('agent-run').filter({ hasText: '停止验收任务' }).click()
    await win.getByRole('button', { name: '停止执行' }).click()
    await expect
      .poll(() => win.evaluate((id) => window.api.agent.status(id), runId))
      .toMatchObject({ status: 'stopped' })
    await win
      .getByTestId('agent-run')
      .filter({ hasText: '停止验收任务' })
      .getByText('已停止', { exact: true })
      .waitFor()
  })
})
