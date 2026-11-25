import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockServer } from './mock-server'
import { closeApp, launchApp, setupProviderAndKey } from './helpers'

let app
let mock
let userData
let tempDir

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-p10-'))
  userData = path.join(tempDir, 'user-data')
  mock = await createMockServer()
  app = await launchApp({ mock, reuseUserData: userData })
})

afterEach(async () => {
  if (app) await closeApp(app.electronApp, null)
  await mock.close()
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  app = null
})

async function restart() {
  await closeApp(app.electronApp, null)
  app = await launchApp({ mock, reuseUserData: userData })
}

async function seedModelDoneRecovery(goal) {
  return app.electronApp.evaluate(async (targetGoal) => {
    const { createRequire } = process.getBuiltinModule('node:module')
    const require = createRequire(process.cwd() + '/e2e/recovery.spec.js')
    const target = String(targetGoal || '跨重启恢复')
    const dbm = require('../electron/store/db')
    const repos = require('../electron/store/repos')
    const storage = require('../electron/store/run-storage')
    const db = dbm.get()
    const provider = repos.listProviders(db)[0]
    const conversation = repos.createConversation(db, {
      title: '跨重启恢复',
      providerId: provider.id,
      model: JSON.parse(provider.models)[0].id
    })
    const runId = repos.createRun(db, {
      conversationId: conversation.id,
      goal: target,
      maxSteps: 15,
      status: 'interrupted'
    })
    const assistant = repos.insertMessage(db, {
      conversationId: conversation.id,
      role: 'assistant',
      content: '',
      status: 'pending',
      meta: { agentRunId: runId }
    })
    db.prepare(
      `UPDATE agent_runs SET run_spec_json=?,assistant_message_id=?,submitted_at=? WHERE id=?`
    ).run(
      JSON.stringify({
        version: 1,
        providerId: provider.id,
        model: conversation.model,
        permission: 'full',
        cluster: false,
        projectId: null,
        first: false,
        endpoint: provider.base_url,
        context: [],
        systemPrompt: ''
      }),
      assistant.id,
      Date.now(),
      runId
    )
    const call = {
      id: 'call-ledger',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"a.txt"}' }
    }
    const ledgerId = repos.startToolCall(db, {
      runId,
      step: 1,
      tool: 'read_file',
      args: { path: 'a.txt' },
      riskLevel: 'readonly',
      confirmedBy: 'auto',
      callId: call.id
    })
    repos.finishToolCall(db, ledgerId, { result: '台账结果', durationMs: 1 })
    storage.saveCheckpoint(db, runId, {
      phase: 'model_done',
      step: 2,
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: target },
        { role: 'assistant', content: '', tool_calls: [call] }
      ],
      pendingToolCalls: [call],
      stepsUsed: 2
    })
    return { runId, conversationId: conversation.id, goal: target }
  }, goal)
}

async function seedGraphRecovery(goal) {
  return app.electronApp.evaluate(async (targetGoal) => {
    const { createRequire } = process.getBuiltinModule('node:module')
    const require = createRequire(process.cwd() + '/e2e/recovery.spec.js')
    const target = String(targetGoal || '跨重启恢复')
    const dbm = require('../electron/store/db')
    const repos = require('../electron/store/repos')
    const storage = require('../electron/store/run-storage')
    const graph = require('../electron/main/agent/graph')
    const db = dbm.get()
    const provider = repos.listProviders(db)[0]
    const model = JSON.parse(provider.models)[0].id
    const parentConversation = repos.createConversation(db, {
      title: '跨重启任务图',
      providerId: provider.id,
      model
    })
    const spec = {
      version: 1,
      providerId: provider.id,
      model,
      permission: 'full',
      cluster: false,
      projectId: null,
      first: false,
      endpoint: provider.base_url,
      context: [],
      systemPrompt: ''
    }
    const parentRunId = repos.createRun(db, {
      conversationId: parentConversation.id,
      goal: target,
      maxSteps: 15,
      status: 'interrupted'
    })
    const parentAssistant = repos.insertMessage(db, {
      conversationId: parentConversation.id,
      role: 'assistant',
      content: '',
      status: 'pending',
      meta: { agentRunId: parentRunId }
    })
    const graphId = graph.createGraph(db, {
      parentRunId,
      conversationId: parentConversation.id
    })
    db.prepare(
      `UPDATE agent_runs SET run_spec_json=?,assistant_message_id=?,submitted_at=? WHERE id=?`
    ).run(JSON.stringify(spec), parentAssistant.id, Date.now(), parentRunId)
    storage.saveCheckpoint(db, parentRunId, {
      phase: 'before_model',
      step: 2,
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: target },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-plan',
              type: 'function',
              function: {
                name: 'run_plan',
                arguments: JSON.stringify({ tasks: [{ key: 'gate', goal: '门槛' }] })
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call-plan',
          content: JSON.stringify({ graphId, runs: [] })
        }
      ],
      pendingToolCalls: [],
      stepsUsed: 2
    })

    const ids = new Map()
    for (const key of ['gate', 'b']) {
      const conversation = repos.createConversation(db, {
        title: key,
        parentId: parentConversation.id,
        providerId: provider.id,
        model
      })
      const runId = repos.createRun(db, {
        conversationId: conversation.id,
        goal: key === 'gate' ? '门槛' : '节点B',
        maxSteps: 15,
        status: key === 'gate' ? 'done' : 'queued',
        parentRunId,
        controlMode: 'delegated',
        graphId,
        nodeKey: key,
        acceptancePolicy: key === 'gate' ? { criteria: '人工门槛' } : null
      })
      const user = repos.insertMessage(db, {
        conversationId: conversation.id,
        role: 'user',
        content: key === 'gate' ? '门槛' : '节点B'
      })
      const assistant = repos.insertMessage(db, {
        conversationId: conversation.id,
        role: 'assistant',
        content: key === 'gate' ? '门槛完成' : '',
        status: key === 'gate' ? 'done' : 'pending',
        meta: { agentRunId: runId }
      })
      db.prepare(
        `UPDATE agent_runs SET run_spec_json=?,user_message_id=?,assistant_message_id=?,submitted_at=?,ended_at=? WHERE id=?`
      ).run(
        JSON.stringify(spec),
        user.id,
        assistant.id,
        Date.now(),
        key === 'gate' ? Date.now() : null,
        runId
      )
      if (key === 'gate') {
        db.prepare("UPDATE agent_runs SET acceptance_status='pending' WHERE id=?").run(runId)
      }
      ids.set(key, runId)
    }
    graph.addDependencies(
      db,
      [
        { key: 'gate', deps: [] },
        { key: 'b', deps: ['gate'] }
      ],
      ids
    )
    graph.refreshGraph(db, graphId)
    return {
      parentRunId,
      graphId,
      gateRunId: ids.get('gate'),
      nodeRunId: ids.get('b'),
      goal: target
    }
  }, goal)
}

describe('P10 恢复与发布验收', () => {
  it('model_done 完整台账在跨重启后补齐消息并继续，不重放工具', async () => {
    let win = app.win
    await setupProviderAndKey(win, mock.url, 'sk-good')
    const goal = '跨重启 model_done 恢复'
    const { runId, goal: seededGoal } = await seedModelDoneRecovery(goal)
    await restart()
    win = app.win

    await expect
      .poll(() => win.evaluate((id) => window.api.agent.status(id), runId), { timeout: 20000 })
      .toMatchObject({ status: 'done', resumeCount: 1 })
    const result = await win.evaluate((id) => window.api.agent.result({ runId: id }), runId)
    expect(result.content).toContain('任务完成')
    const request = mock.state.requests.find(({ body }) =>
      body.messages?.some((message) => message.role === 'user' && message.content === seededGoal)
    )
    expect(request.body.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-ledger',
      content: '台账结果'
    })
    const calls = await win.evaluate((id) => window.api.agent.calls(id), runId)
    expect(calls).toHaveLength(1)
  })

  it('真实 Git 回并冲突按项目策略选择来源侧并记录审计', async () => {
    const { win } = app
    await setupProviderAndKey(win, mock.url, 'sk-good')
    const repo = path.join(tempDir, 'repo')
    fs.mkdirSync(repo)
    const git = (...args) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
    git('init')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n')
    git('add', 'a.txt')
    git('-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-m', 'base')

    await win.getByTestId('nav-chat').click()
    await win.getByTestId('project-add').click()
    await win.getByTestId('project-name').fill('冲突验收')
    await win.getByTestId('project-path').fill(repo)
    await win.getByTestId('project-conflict-strategy').selectOption('theirs')
    await win.getByTestId('project-confirm').click()
    await win
      .locator('[data-testid="project-item"]', { hasText: '冲突验收' })
      .locator('[data-testid="project-new-conv"]')
      .click()
    const conversationId = await win.evaluate(async () => {
      const [conversation] = await window.api.conversations.list()
      return conversation.id
    })
    const projectId = await win.evaluate(async () => {
      const [project] = await window.api.projects.list()
      return project.id
    })
    const project = await win.evaluate(async () => {
      const [item] = await window.api.projects.list()
      return item
    })
    expect(project).toMatchObject({ workspaceAutoMerge: 1, workspaceConflictStrategy: 'theirs' })
    mock.state.agentDelayMs = 2000
    const { runId } = await win.evaluate(
      (id) =>
        window.api.agent.run({ conversationId: id, goal: '冲突回并验收', permission: 'full' }),
      conversationId
    )
    mock.state.agentFile = path.join(userData, 'workspaces', projectId, runId, 'a.txt')
    await expect
      .poll(() => mock.state.requests.some(({ body }) => body?.tools?.length), { timeout: 20000 })
      .toBe(true)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'main change\n')
    git('add', 'a.txt')
    git('-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-m', 'main change')

    await expect
      .poll(() => win.evaluate((id) => window.api.agent.status(id), runId), { timeout: 20000 })
      .toMatchObject({ status: 'done' })
    await expect
      .poll(() => win.evaluate((id) => window.api.agent.status(id), runId), { timeout: 20000 })
      .toMatchObject({
        workspaceJson: expect.stringContaining('"strategy":"theirs"')
      })
    const run = await win.evaluate((id) => window.api.agent.status(id), runId)
    const workspace = JSON.parse(run.workspaceJson)
    expect(workspace.merge).toMatchObject({
      status: 'merged',
      resolution: { strategy: 'theirs', result: 'resolved', files: ['a.txt'] }
    })
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toContain('E2E写入内容')
  })

  it('任务图跨重启后仍可重规划 queued 节点并完成整图', async () => {
    let win = app.win
    await setupProviderAndKey(win, mock.url, 'sk-good')
    mock.state.planRun = true
    const goal = '跨重启任务图重规划'
    const { parentRunId, graphId, nodeRunId } = await seedGraphRecovery(goal)
    await restart()
    win = app.win

    await expect
      .poll(() => win.evaluate((id) => window.api.agent.graph(id), parentRunId), {
        timeout: 20000
      })
      .toMatchObject({
        graphId,
        nodes: expect.arrayContaining([
          expect.objectContaining({ nodeKey: 'gate', status: 'done' }),
          expect.objectContaining({ runId: nodeRunId, status: 'queued', editable: true })
        ])
      })
    const before = await win.evaluate((id) => window.api.agent.graph(id), parentRunId)
    await win.evaluate((input) => window.api.agent.mutateGraph(input), {
      graphId,
      etag: before.etag,
      ops: [{ action: 'update', runId: nodeRunId, deps: [] }]
    })
    await expect
      .poll(() => win.evaluate((id) => window.api.agent.status(id), parentRunId), {
        timeout: 20000
      })
      .toMatchObject({ status: 'done', resumeCount: 1 })
    const after = await win.evaluate((id) => window.api.agent.graph(id), parentRunId)
    expect(after.nodes.find((node) => node.runId === nodeRunId).status).toBe('done')
    expect(after.dependencies.filter((edge) => edge.runId === nodeRunId)).toEqual([])
  })
})
