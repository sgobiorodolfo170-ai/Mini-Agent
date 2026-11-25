import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeApp, launchApp, setupProviderAndKey, unexpectedErrors } from './helpers'

let ctx

async function dragBy(win, locator, dx, dy) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('drag target is not visible')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await win.mouse.move(x, y)
  await win.mouse.down()
  await win.mouse.move(x + dx, y + dy, { steps: 8 })
  await win.mouse.up()
}

async function connect(win, source, target) {
  const from = await source.boundingBox()
  const to = await target.boundingBox()
  if (!from || !to) throw new Error('connection handle is not visible')
  await win.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await win.mouse.down()
  await win.waitForTimeout(80)
  await win.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 })
  await win.waitForTimeout(80)
  await win.mouse.up()
}

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('任务图可视化与重规划', () => {
  it('运行中动态新增节点，依赖完成后自动调度', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    mock.state.planRun = true
    mock.state.planNodeDelayMs = 12000
    await win.getByTestId('nav-chat').click()
    await win.getByTestId('new-conv').click()
    const started = await win.evaluate(async () => {
      const [conversation] = await window.api.conversations.list()
      return window.api.agent.run({
        conversationId: conversation.id,
        permission: 'full',
        goal: '动态节点验收'
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
          expect.objectContaining({ nodeKey: 'b', status: 'queued' }),
          expect.objectContaining({ nodeKey: 'c', status: 'queued' })
        ]
      })
    await win.getByTestId('nav-agent').click()
    await win.getByTestId('agent-run').filter({ hasText: '动态节点验收' }).click()
    await win.getByTestId('task-graph-editor').waitFor()
    await win.getByTestId('task-graph-add-node').click()
    await win.getByTestId('task-graph-new-key').fill('d')
    await win.getByTestId('task-graph-new-goal').fill('动态节点D')
    await win.getByTestId('task-graph-add-form').getByLabel('a', { exact: true }).check()
    await win.getByTestId('task-graph-new-submit').click()

    await expect
      .poll(() => win.evaluate((runId) => window.api.agent.graph(runId), started.runId), {
        timeout: 10000
      })
      .toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({ nodeKey: 'd', status: 'queued', editable: true })
        ])
      })
    const added = await win.evaluate((runId) => window.api.agent.graph(runId), started.runId)
    const nodeA = added.nodes.find((node) => node.nodeKey === 'a')
    const nodeD = added.nodes.find((node) => node.nodeKey === 'd')
    expect(added.dependencies).toContainEqual({ runId: nodeD.runId, dependsOnRunId: nodeA.runId })
    expect(nodeD.depth).toBe(2)

    await expect
      .poll(() => win.evaluate((runId) => window.api.agent.status(runId), started.runId), {
        timeout: 45000
      })
      .toMatchObject({ status: 'done' })
    const finished = await win.evaluate((runId) => window.api.agent.graph(runId), started.runId)
    expect(finished.nodes.find((node) => node.runId === nodeD.runId)?.status).toBe('done')
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

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
    const initialGraph = await win.evaluate((runId) => window.api.agent.graph(runId), started.runId)
    const nodeA = initialGraph.nodes.find((node) => node.nodeKey === 'a')
    const nodeB = initialGraph.nodes.find((node) => node.nodeKey === 'b')
    const nodeC = initialGraph.nodes.find((node) => node.nodeKey === 'c')
    const canvasNodeA = win.getByTestId(`task-graph-node-${nodeA.runId}`)
    const canvasNodeB = win.getByTestId(`task-graph-node-${nodeB.runId}`)
    const canvasNodeC = win.getByTestId(`task-graph-node-${nodeC.runId}`)
    await win.getByTestId('task-graph-editor').waitFor()
    await canvasNodeA.waitFor()
    await canvasNodeB.waitFor()
    await canvasNodeC.waitFor()
    await win.screenshot({ path: '.e2e-artifacts/p11-task-graph-canvas.png' })

    await dragBy(win, canvasNodeB.locator('.task-graph-node__header'), 70, 30)
    await expect
      .poll(() =>
        win.evaluate(
          ({ runId, nodeId }) =>
            window.api.agent.graphLayout(runId).then((state) => state.layout[nodeId]?.x),
          { runId: started.runId, nodeId: nodeB.runId }
        )
      )
      .toBeGreaterThan(300)
    await win.waitForTimeout(300)

    await connect(
      win,
      canvasNodeA.locator('.vue-flow__handle-right'),
      canvasNodeC.locator('.vue-flow__handle-left')
    )
    await expect
      .poll(() =>
        win.evaluate(
          ({ runId, nodeId, dependencyId }) =>
            window.api.agent
              .graph(runId)
              .then((graph) =>
                graph.dependencies.some(
                  (edge) => edge.runId === nodeId && edge.dependsOnRunId === dependencyId
                )
              ),
          { runId: started.runId, nodeId: nodeC.runId, dependencyId: nodeA.runId }
        )
      )
      .toBe(true)
    await win.getByTestId('task-graph-undo').click()
    await expect
      .poll(() =>
        win.evaluate(
          ({ runId, nodeId, dependencyId }) =>
            window.api.agent
              .graph(runId)
              .then((graph) =>
                graph.dependencies.some(
                  (edge) => edge.runId === nodeId && edge.dependsOnRunId === dependencyId
                )
              ),
          { runId: started.runId, nodeId: nodeC.runId, dependencyId: nodeA.runId }
        )
      )
      .toBe(false)
    await win.getByTestId('task-graph-redo').click()
    await expect
      .poll(() =>
        win.evaluate(
          ({ runId, nodeId, dependencyId }) =>
            window.api.agent
              .graph(runId)
              .then((graph) =>
                graph.dependencies.some(
                  (edge) => edge.runId === nodeId && edge.dependsOnRunId === dependencyId
                )
              ),
          { runId: started.runId, nodeId: nodeC.runId, dependencyId: nodeA.runId }
        )
      )
      .toBe(true)
    await win.getByTestId('task-graph-fit-view').click()

    await win.getByTestId('graph-view-list').click()
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
    const replannedNodeC = replanned.nodes.find((node) => node.nodeKey === 'c')
    const replannedNodeA = replanned.nodes.find((node) => node.nodeKey === 'a')
    expect(
      replanned.dependencies
        .filter((edge) => edge.runId === replannedNodeC.runId)
        .map((edge) => edge.dependsOnRunId)
    ).toEqual([replannedNodeA.runId])

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
