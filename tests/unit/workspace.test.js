import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const workspace = require('../../electron/main/agent/workspace')

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0
let dir
let repo
let root

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-wt-'))
  repo = path.join(dir, 'repo')
  root = path.join(dir, 'workspaces')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, 'init')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-m', 'init')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!hasGit)('Git worktree 工作区', () => {
  it('为每个 Run 创建独立工作区，并带出脏工作区快照', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'main changed\n')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'untracked\n')

    const ws = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-1234567890',
      rootDir: root
    })
    expect(ws).toMatchObject({ mode: 'worktree' })
    expect(ws.branch).toContain('miniagent/run-run-')
    expect(fs.readFileSync(path.join(ws.path, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'main changed\n'
    )
    expect(fs.readFileSync(path.join(ws.path, 'b.txt'), 'utf8')).toBe('untracked\n')

    // 主目录脏时不自动合并
    fs.writeFileSync(path.join(ws.path, 'c.txt'), 'agent\n')
    const skipped = await workspace.autoMerge({ projectPath: repo, workspace: ws })
    expect(skipped).toMatchObject({ status: 'skipped', reason: 'main_dirty' })
  }, 30000)

  it('主目录干净时提交工作区改动并自动合并', async () => {
    const ws = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-abcdefghijkl',
      rootDir: root
    })
    fs.writeFileSync(path.join(ws.path, 'a.txt'), 'agent changed\n')
    fs.writeFileSync(path.join(ws.path, 'new.txt'), 'new file\n')

    const merged = await workspace.autoMerge({ projectPath: repo, workspace: ws })
    expect(merged.status).toBe('merged')
    expect(git(repo, 'show', 'HEAD:a.txt').replace(/\r\n/g, '\n')).toBe('agent changed\n')
    expect(git(repo, 'show', 'HEAD:new.txt').replace(/\r\n/g, '\n')).toBe('new file\n')
    expect(fs.existsSync(ws.path)).toBe(false)
  }, 30000)

  it('非 Git 目录回退共享模式', async () => {
    const plain = path.join(dir, 'plain')
    fs.mkdirSync(plain)
    const ws = await workspace.prepare({
      projectPath: plain,
      projectId: 'p2',
      runId: 'run-plain',
      rootDir: root
    })
    expect(ws).toMatchObject({ mode: 'shared', reason: 'not_git_repo' })
  }, 30000)

  it('dispose 删除工作区和分支', async () => {
    const ws = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-dispose',
      rootDir: root
    })
    expect(fs.existsSync(ws.path)).toBe(true)
    expect(await workspace.dispose({ projectPath: repo, workspace: ws })).toBe(true)
    expect(fs.existsSync(ws.path)).toBe(false)
    expect(() => git(repo, 'rev-parse', ws.branch)).toThrow()
  }, 30000)
})
