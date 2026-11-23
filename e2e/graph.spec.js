import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeApp, launchApp, setupProviderAndKey, unexpectedErrors } from './helpers'

let ctx

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('任务图可视化与重规划', () => {
  it('展示分层依赖，并允许修改和删除尚未启动的节点', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    mock.state.planRun = true
    mock.state.planNodeDelayMs = 20000
    await win.getByTestId('nav-chat').click()
    await win.getByTestId('new-conv').click()
    const started = await win.evaluate(async () => {
      const [conversation] = await window.api.conversations.list()
      return window.api.agent.run({
        conversationId: conversation.id,
        permission: 'full',
        goal: '任务图验收'
      })
    })

    await expect
      .poll(() => win.evaluate((runId) => window.api.agent.graph(runId), started.runId), {
        timeout: 15000
      })
      .toMatchObject({
        status: 'running',
        nodes: [
          expect.objectContaining({ nodeKey: 'a', status: 'running' }),
          expect.objectContaining({ nodeKey: 'b', status: 'queued', editable: true }),
          expect.objectContaining({ nodeKey: 'c', status: 'queued', editable: true })
        ]
      })

    await win.getByTestId('nav-agent').click()
    await win.getByTestId('agent-run').filter({ hasText: '任务图验收' }).click()
    await win.getByTestId('run-graph-panel').waitFor()
    await win.getByTestId('graph-node-a').waitFor()
    await win.getByTestId('graph-node-b').waitFor()
    await win.getByTestId('graph-node-c').waitFor()
    await win.screenshot({ path: '.e2e-artifacts/p9-task-graph.png' })

    await win.getByTestId('graph-node-c').getByTestId('graph-node-edit').click()
    await win.getByTestId('graph-node-goal').fill('节点C 已重规划')
    await win.getByTestId('graph-dep-b').uncheck()
    await win.getByTestId('graph-dep-a').check()
    await win.getByTestId('graph-node-save').click()
    await win.screenshot({ path: '.e2e-artifacts/p9-task-graph-after-save.png' })
    await expect
      .poll(() => win.evaluate((runId) => window.api.agent.graph(runId), started.runId))
      .toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({ nodeKey: 'c', goal: '节点C 已重规划', depth: 2 })
        ])
      })
    const replanned = await win.evaluate((runId) => window.api.agent.graph(runId), started.runId)
    const nodeC = replanned.nodes.find((node) => node.nodeKey === 'c')
    const nodeA = replanned.nodes.find((node) => node.nodeKey === 'a')
    expect(
      replanned.dependencies
        .filter((edge) => edge.runId === nodeC.runId)
        .map((edge) => edge.dependsOnRunId)
    ).toEqual([nodeA.runId])

    await win.getByTestId('graph-node-b').getByTestId('graph-node-delete').click()
    await win.screenshot({ path: '.e2e-artifacts/p9-task-graph-after-delete-click.png' })
    await win.getByText(/删除节点.*「b」/).waitFor()
    await win.getByRole('button', { name: '删除节点' }).click()
    await expect
      .poll(() => win.evaluate((runId) => window.api.agent.graph(runId), started.runId))
      .toMatchObject({
        nodes: [
          expect.objectContaining({ nodeKey: 'a' }),
          expect.objectContaining({ nodeKey: 'c' })
        ]
      })

    await expect
      .poll(() => win.evaluate((runId) => window.api.agent.status(runId), started.runId), {
        timeout: 30000
      })
      .toMatchObject({ status: 'done' })
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})
