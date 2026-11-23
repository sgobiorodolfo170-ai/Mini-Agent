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
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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

  it('按显式策略解决回并冲突并记录选择侧', async () => {
    const theirsWorkspace = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-merge-theirs',
      rootDir: root
    })
    const oursWorkspace = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-merge-ours',
      rootDir: root
    })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'main\n')
    git(repo, 'add', 'a.txt')
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-m', 'main')
    fs.writeFileSync(path.join(theirsWorkspace.path, 'a.txt'), 'agent theirs\n')
    fs.writeFileSync(path.join(oursWorkspace.path, 'a.txt'), 'agent ours\n')

    const theirs = await workspace.autoMerge({
      projectPath: repo,
      workspace: theirsWorkspace,
      conflictStrategy: 'theirs'
    })
    expect(theirs).toMatchObject({
      status: 'merged',
      resolution: { strategy: 'theirs', result: 'resolved', files: ['a.txt'] }
    })
    expect(git(repo, 'show', 'HEAD:a.txt')).toContain('agent theirs')

    const ours = await workspace.autoMerge({
      projectPath: repo,
      workspace: oursWorkspace,
      conflictStrategy: 'ours'
    })
    expect(ours).toMatchObject({
      status: 'merged',
      resolution: { strategy: 'ours', result: 'resolved', files: ['a.txt'] }
    })
    expect(git(repo, 'show', 'HEAD:a.txt')).toContain('agent theirs')
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

  it('严格模式在工作区创建失败时返回 error，不降级共享目录', async () => {
    const rootFile = path.join(dir, 'not-a-directory')
    fs.writeFileSync(rootFile, 'blocked')
    const ws = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-strict',
      rootDir: rootFile,
      strict: true
    })
    expect(ws.mode).toBe('error')
    expect(ws.reason).toMatch(/EEXIST|ENOTDIR/)
  }, 30000)

  it('封存节点成果并让下游工作区继承，重复继承不重复合并', async () => {
    const upstream = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-upstream',
      rootDir: root
    })
    const downstream = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-downstream',
      rootDir: root
    })
    fs.writeFileSync(path.join(upstream.path, 'from-a.txt'), 'A changed\n')
    const artifact = await workspace.sealArtifact({ workspace: upstream })
    expect(artifact.status).toBe('sealed')

    const inherited = await workspace.inheritArtifacts({
      projectPath: repo,
      workspace: downstream,
      dependencies: [
        {
          runId: 'a',
          status: 'done',
          workspace: { ...upstream, artifact }
        }
      ]
    })
    expect(inherited.status).toBe('ready')
    expect(
      fs.readFileSync(path.join(downstream.path, 'from-a.txt'), 'utf8').replace(/\r\n/g, '\n')
    ).toBe('A changed\n')

    const repeated = await workspace.inheritArtifacts({
      projectPath: repo,
      workspace: downstream,
      dependencies: [
        {
          runId: 'a',
          status: 'done',
          workspace: { ...upstream, artifact }
        }
      ]
    })
    expect(repeated.inheritance[0].status).toBe('already_applied')
  }, 30000)

  it('按依赖注册顺序合并多个成果，并在冲突时 abort', async () => {
    const first = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-first',
      rootDir: root
    })
    const second = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-second',
      rootDir: root
    })
    const downstream = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-merge',
      rootDir: root
    })
    fs.writeFileSync(path.join(first.path, 'first.txt'), 'first\n')
    fs.writeFileSync(path.join(second.path, 'second.txt'), 'second\n')
    const firstArtifact = await workspace.sealArtifact({ workspace: first })
    const secondArtifact = await workspace.sealArtifact({ workspace: second })
    const merged = await workspace.inheritArtifacts({
      projectPath: repo,
      workspace: downstream,
      dependencies: [
        { runId: 'second', status: 'done', workspace: { ...second, artifact: secondArtifact } },
        { runId: 'first', status: 'done', workspace: { ...first, artifact: firstArtifact } }
      ]
    })
    expect(merged.inheritance.map((item) => item.runId)).toEqual(['second', 'first'])
    expect(fs.existsSync(path.join(downstream.path, 'first.txt'))).toBe(true)
    expect(fs.existsSync(path.join(downstream.path, 'second.txt'))).toBe(true)

    const left = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-left',
      rootDir: root
    })
    const right = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-right',
      rootDir: root
    })
    const conflictTarget = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-conflict',
      rootDir: root
    })
    fs.writeFileSync(path.join(left.path, 'a.txt'), 'left\n')
    fs.writeFileSync(path.join(right.path, 'a.txt'), 'right\n')
    const leftArtifact = await workspace.sealArtifact({ workspace: left })
    const rightArtifact = await workspace.sealArtifact({ workspace: right })
    const conflict = await workspace.inheritArtifacts({
      projectPath: repo,
      workspace: conflictTarget,
      dependencies: [
        { runId: 'left', status: 'done', workspace: { ...left, artifact: leftArtifact } },
        { runId: 'right', status: 'done', workspace: { ...right, artifact: rightArtifact } }
      ]
    })
    expect(conflict).toMatchObject({
      status: 'failed',
      reason: 'dependency_merge_conflict',
      dependencyRunId: 'right'
    })
    expect(git(conflictTarget.path, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('')

    const oursTarget = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-conflict-ours',
      rootDir: root
    })
    expect(oursTarget.detail).toBeUndefined()
    expect(oursTarget.mode).toBe('worktree')
    const ours = await workspace.inheritArtifacts({
      projectPath: repo,
      workspace: oursTarget,
      conflictStrategy: 'ours',
      dependencies: [
        { runId: 'left', status: 'done', workspace: { ...left, artifact: leftArtifact } },
        { runId: 'right', status: 'done', workspace: { ...right, artifact: rightArtifact } }
      ]
    })
    expect(ours.reason).toBeUndefined()
    expect(ours.status).toBe('ready')
    expect(ours.inheritance[1].resolution).toMatchObject({
      strategy: 'ours',
      result: 'resolved',
      files: ['a.txt']
    })
    expect(fs.readFileSync(path.join(oursTarget.path, 'a.txt'), 'utf8')).toContain('left')

    const theirsTarget = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-conflict-theirs',
      rootDir: root
    })
    const theirs = await workspace.inheritArtifacts({
      projectPath: repo,
      workspace: theirsTarget,
      conflictStrategy: 'theirs',
      dependencies: [
        { runId: 'left', status: 'done', workspace: { ...left, artifact: leftArtifact } },
        { runId: 'right', status: 'done', workspace: { ...right, artifact: rightArtifact } }
      ]
    })
    expect(theirs.status).toBe('ready')
    expect(theirs.inheritance[1].resolution).toMatchObject({
      strategy: 'theirs',
      result: 'resolved',
      files: ['a.txt']
    })
    expect(fs.readFileSync(path.join(theirsTarget.path, 'a.txt'), 'utf8')).toContain('right')
  }, 60000)

  it('确定性验收拒绝冲突标记并在命令失败时给出检查结果', async () => {
    const ws = await workspace.prepare({
      projectPath: repo,
      projectId: 'p1',
      runId: 'run-verify',
      rootDir: root
    })
    fs.writeFileSync(path.join(ws.path, 'a.txt'), '<<<<<<< HEAD\nconflict\n>>>>>>> branch\n')
    const markers = await workspace.verifyWorkspace({ projectPath: repo, workspace: ws })
    expect(markers.status).toBe('failed')
    expect(['diff_check_failed', 'conflict_markers_found']).toContain(markers.reason)

    fs.writeFileSync(path.join(ws.path, 'a.txt'), 'clean\n')
    const command = await workspace.verifyWorkspace({
      projectPath: repo,
      workspace: ws,
      command: 'exit 1'
    })
    expect(command).toMatchObject({ status: 'failed', reason: 'verify_command_failed' })
    expect(command.checks).toContainEqual({ name: 'verify_command', ok: false })
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
