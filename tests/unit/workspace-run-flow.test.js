import { createRequire } from 'node:module'
import { spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as agent from '../../electron/main/agent'

const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
require('electron')
const dbm = require('../../electron/store/db')
const repos = require('../../electron/store/repos')
const workspace = require('../../electron/main/agent/workspace')

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0
let originalElectron
let db
let dir
let repo
let conversationId
let projectId

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

function response(delta) {
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      yield Buffer.from(
        'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n'
      )
    })()
  }
}

function tool(name, args) {
  return {
    index: 0,
    id: 'call-' + name,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  }
}

async function approveWorkspacePlan() {
  const approvals = agent.getApprovalService()
  const original = approvals.decide.bind(approvals)
  approvals.decide = (input) => {
    const pending = original(input)
    setImmediate(() => {
      const row = dbm
        .get()
        .prepare(
          "SELECT approval_id FROM agent_approvals WHERE run_id=? AND tool='run_plan_confirm' AND status='pending' ORDER BY created_at DESC LIMIT 1"
        )
        .get(input.runId)
      if (row) approvals.respond({ approvalId: row.approval_id, decision: 'approved' })
    })
    return pending
  }
}

beforeEach(() => {
  originalElectron = require.cache[electronPath].exports
  require.cache[electronPath].exports = { app: { getPath: () => os.tmpdir() } }
  db = dbm.open(':memory:')
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-wt-run-'))
  repo = path.join(dir, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, 'init')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-m', 'init')

  const project = repos.createProject(db, {
    name: 'WT',
    path: repo,
    workspaceMode: 'worktree',
    workspaceAutoMerge: 1
  })
  projectId = project.id
  const providerId = repos.saveProvider(db, {
    name: 'Mock',
    baseUrl: 'https://mock/v1',
    models: [{ id: 'm1' }]
  })
  repos.addKey(db, {
    providerId,
    label: 'key',
    secretEnc: 'plain:' + Buffer.from('key').toString('base64')
  })
  conversationId = repos.createConversation(db, {
    title: 'WT run',
    providerId,
    model: 'm1',
    projectId: project.id
  }).id
})

afterEach(async () => {
  await agent.stopAllRuns()
  dbm.close()
  require.cache[electronPath].exports = originalElectron
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows 上 git 索引偶发占用，测试目录留给系统清理
  }
  vi.restoreAllMocks()
})

it.skipIf(!hasGit)(
  'inherits a completed graph dependency before the downstream model starts',
  async () => {
    await approveWorkspacePlan()
    let releaseA
    let releaseB
    const gateA = new Promise((resolve) => {
      releaseA = resolve
    })
    const gateB = new Promise((resolve) => {
      releaseB = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
      const { messages } = JSON.parse(opts.body)
      const last = messages.at(-1)
      if (last.content === '任务A') {
        await gateA
        return response({ content: 'A result' })
      }
      if (last.content === '任务B') {
        await gateB
        return response({ content: 'B result' })
      }
      if (last.role !== 'tool') {
        return response({
          tool_calls: [
            tool('run_plan', {
              tasks: [
                { key: 'a', goal: '任务A' },
                { key: 'b', goal: '任务B', deps: ['a'] }
              ]
            })
          ]
        })
      }
      const output = JSON.parse(last.content)
      if (last.tool_call_id === 'call-run_plan') {
        return response({
          tool_calls: [tool('run_plan_confirm', { planId: output.planId, etag: output.etag })]
        })
      }
      if (last.tool_call_id === 'call-run_plan_confirm') {
        return response({ tool_calls: [tool('run_wait', { graphId: output.graphId })] })
      }
      return response({ content: output.runs.map((run) => run.content).join(' / ') })
    })

    const parent = await agent.startAgentRun({
      conversationId,
      goal: '验证图节点成果继承',
      permission: 'full',
      cluster: true
    })
    let upstreamRun
    await expect
      .poll(
        () => {
          const graph = agent.getGraphForParent(parent.runId)
          const node = graph && graph.nodes.find((item) => item.nodeKey === 'a')
          upstreamRun = node && repos.getRun(db, node.runId)
          return upstreamRun && upstreamRun.workspaceJson
        },
        { timeout: 15000 }
      )
      .toBeTruthy()

    const upstreamWorkspace = JSON.parse(upstreamRun.workspaceJson)
    fs.writeFileSync(path.join(upstreamWorkspace.path, 'from-a.txt'), 'from A\n')
    const artifact = await workspace.sealArtifact({ workspace: upstreamWorkspace })
    expect(artifact.status).toBe('sealed')
    repos.setRunWorkspace(db, upstreamRun.id, { ...upstreamWorkspace, artifact })
    releaseA()

    let downstreamRun
    await expect
      .poll(
        () => {
          const graph = agent.getGraphForParent(parent.runId)
          const node = graph && graph.nodes.find((item) => item.nodeKey === 'b')
          downstreamRun = node && repos.getRun(db, node.runId)
          if (!downstreamRun || !downstreamRun.workspaceJson) return null
          const current = JSON.parse(downstreamRun.workspaceJson)
          return current.inheritance && current.inheritance.status
        },
        { timeout: 15000 }
      )
      .toBeTruthy()
    const downstreamWorkspace = JSON.parse(downstreamRun.workspaceJson)
    expect(downstreamWorkspace.inheritance.reason).toBeUndefined()
    expect(downstreamWorkspace.inheritance).toMatchObject({ status: 'ready' })
    expect(
      fs
        .readFileSync(path.join(downstreamWorkspace.path, 'from-a.txt'), 'utf8')
        .replace(/\r\n/g, '\n')
    ).toBe('from A\n')
    releaseB()

    await expect
      .poll(() => agent.getRunResult(parent.runId), { timeout: 15000 })
      .toMatchObject({ status: 'done', content: 'A result / B result' })
    await expect
      .poll(
        () => {
          const current = JSON.parse(repos.getRun(db, parent.runId).workspaceJson || '{}')
          return current.merge && current.merge.status
        },
        { timeout: 15000 }
      )
      .toBe('merged')
    expect(JSON.parse(repos.getRun(db, upstreamRun.id).workspaceJson).artifact.status).toBe(
      'sealed'
    )
  },
  40000
)

it.skipIf(!hasGit)(
  'requires confirmation for commands in full mode and blocks merge when verification fails',
  async () => {
    repos.updateProject(db, projectId, { workspaceVerifyCommand: 'exit 1' })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
      const { messages } = JSON.parse(opts.body)
      const last = messages.at(-1)
      if (last.role === 'tool') return response({ content: '命令已执行' })
      return response({
        tool_calls: [
          tool('run_command', {
            command: 'Set-Content -Path a.txt -Value unverified -Encoding utf8'
          })
        ]
      })
    })
    const run = await agent.startAgentRun({
      conversationId,
      goal: '写入未通过验收的改动',
      permission: 'full'
    })
    await expect
      .poll(() => db.prepare("SELECT 1 FROM agent_approvals WHERE status='pending'").get(), {
        timeout: 15000
      })
      .toBeTruthy()
    const approval = db
      .prepare("SELECT approval_id FROM agent_approvals WHERE status='pending'")
      .get()
    expect(agent.respondConfirm({ requestId: approval.approval_id, allow: true })).toBe(true)
    await expect.poll(() => agent.getRunStatus(run.runId).status, { timeout: 20000 }).toBe('done')
    await expect
      .poll(
        () => {
          const current = JSON.parse(repos.getRun(db, run.runId).workspaceJson || '{}')
          return current.merge && current.merge.status
        },
        { timeout: 15000 }
      )
      .toBe('failed')
    const current = JSON.parse(repos.getRun(db, run.runId).workspaceJson)
    expect(current.merge.reason).toBe('verify_command_failed')
    expect(current.verification.checks).toContainEqual({ name: 'verify_command', ok: false })
    expect(git(repo, 'show', 'HEAD:a.txt')).toContain('base')
    expect(repos.getRunCalls(db, run.runId)[0].confirmed_by).toBe('desktop')
  },
  30000
)

it.skipIf(!hasGit)('stops instead of falling back when worktree isolation fails', async () => {
  vi.spyOn(workspace, 'prepare').mockResolvedValue({ mode: 'error', reason: 'test_failure' })
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const run = await agent.startAgentRun({
    conversationId,
    goal: '不应执行的任务',
    permission: 'full'
  })
  await expect
    .poll(() => agent.getRunStatus(run.runId))
    .toMatchObject({ status: 'error', finishedReason: 'workspace_prepare_failed' })
  expect(fetchSpy).not.toHaveBeenCalled()
})

it.skipIf(!hasGit)(
  'runs in a worktree and auto-merges successful changes',
  async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
      const { messages } = JSON.parse(opts.body)
      const last = messages.at(-1)
      if (last.role === 'tool') return response({ content: '工作区任务完成' })
      return response({
        tool_calls: [
          tool('run_command', {
            command: 'Set-Content -Path a.txt -Value agent -Encoding utf8'
          })
        ]
      })
    })

    const run = await agent.startAgentRun({
      conversationId,
      goal: '写 a.txt',
      permission: 'full'
    })
    await expect
      .poll(() => db.prepare("SELECT 1 FROM agent_approvals WHERE status='pending'").get(), {
        timeout: 15000
      })
      .toBeTruthy()
    const approval = db
      .prepare("SELECT approval_id FROM agent_approvals WHERE status='pending'")
      .get()
    expect(agent.respondConfirm({ requestId: approval.approval_id, allow: true })).toBe(true)
    await expect.poll(() => agent.getRunStatus(run.runId).status, { timeout: 20000 }).toBe('done')

    const workspace = JSON.parse(agent.getRunStatus(run.runId).workspaceJson)
    expect(workspace.mode).toBe('worktree')
    expect(workspace.branch).toContain('miniagent/run-')

    await expect
      .poll(
        () => {
          const current = JSON.parse(agent.getRunStatus(run.runId).workspaceJson || '{}')
          return current.merge && current.merge.status
        },
        { timeout: 20000 }
      )
      .toBe('merged')
    expect(git(repo, 'show', 'HEAD:a.txt')).toContain('agent')
    expect(fs.existsSync(workspace.path)).toBe(false)
    expect(repos.getRunCalls(db, run.runId)[0].status).toBe('done')
  },
  30000
)
