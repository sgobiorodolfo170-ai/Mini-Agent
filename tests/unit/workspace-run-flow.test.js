import { createRequire } from 'node:module'
import { spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
require('electron')
const dbm = require('../../electron/store/db')
const repos = require('../../electron/store/repos')
const agent = require('../../electron/main/agent')

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0
let originalElectron
let db
let dir
let repo
let conversationId

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
