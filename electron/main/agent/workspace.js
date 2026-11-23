// Git worktree 隔离：每个 Agent Run 在独立工作区执行，成功后按安全条件自动合并。
//
// 安全原则：
// - 非 Git 仓库、git 不可用、快照失败都回退 shared，不阻塞任务；
// - 自动合并不覆盖脏主目录，冲突立即 abort；
// - 脏工作区启动时把已跟踪改动和未跟踪文件快照进 worktree。

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)
const MAX_UNTRACKED_FILES = 500
const MAX_UNTRACKED_BYTES = 50 * 1024 * 1024

async function runGit(args, { cwd, exec = execFileAsync, maxBuffer = 10 * 1024 * 1024 } = {}) {
  try {
    const result = await exec('git', args, { cwd, windowsHide: true, maxBuffer })
    return { ok: true, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') }
  } catch (error) {
    return {
      ok: false,
      stdout: String((error && error.stdout) || ''),
      stderr: String((error && error.stderr) || (error && error.message) || '')
    }
  }
}

async function isGitRepo(projectPath, opts) {
  if (!projectPath || !fs.existsSync(projectPath)) return false
  const r = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: projectPath, ...opts })
  return r.ok && r.stdout.trim() === 'true'
}

async function headCommit(projectPath, opts) {
  const r = await runGit(['rev-parse', 'HEAD'], { cwd: projectPath, ...opts })
  return r.ok ? r.stdout.trim() : ''
}

async function isClean(projectPath, opts) {
  const r = await runGit(['status', '--porcelain'], { cwd: projectPath, ...opts })
  return r.ok && !r.stdout.trim()
}

async function removeWorktree({ projectPath, worktreePath, branch, exec }) {
  const opts = { cwd: projectPath, exec }
  await runGit(['worktree', 'remove', '--force', worktreePath], opts)
  if (branch) await runGit(['branch', '-D', branch], opts)
  await runGit(['worktree', 'prune'], opts)
}

// 把主工作区未提交的已跟踪改动和未跟踪文件复制到 worktree。
async function snapshotDirty({ projectPath, worktreePath, tempDir, exec }) {
  const opts = { cwd: projectPath, exec }
  const diff = await runGit(['diff', 'HEAD', '--binary'], opts)
  if (!diff.ok) return { ok: false, reason: 'diff_failed' }
  if (diff.stdout.trim()) {
    fs.mkdirSync(tempDir, { recursive: true })
    const patchFile = path.join(tempDir, `dirty-${Date.now()}.patch`)
    fs.writeFileSync(patchFile, diff.stdout, 'utf8')
    try {
      const applied = await runGit(['apply', '--whitespace=nowarn', patchFile], {
        cwd: worktreePath,
        exec
      })
      if (!applied.ok) return { ok: false, reason: 'patch_failed' }
    } finally {
      try {
        fs.rmSync(patchFile, { force: true })
      } catch {
        // 临时文件清理失败不影响任务
      }
    }
  }

  const listed = await runGit(['ls-files', '--others', '--exclude-standard'], opts)
  if (!listed.ok) return { ok: false, reason: 'untracked_list_failed' }
  const files = listed.stdout
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
  if (files.length > MAX_UNTRACKED_FILES) return { ok: false, reason: 'untracked_too_many' }
  let bytes = 0
  for (const rel of files) {
    const src = path.join(projectPath, rel)
    try {
      const stat = fs.statSync(src)
      if (!stat.isFile()) continue
      bytes += stat.size
      if (bytes > MAX_UNTRACKED_BYTES) return { ok: false, reason: 'untracked_too_large' }
      const dest = path.join(worktreePath, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
    } catch {
      return { ok: false, reason: 'untracked_copy_failed' }
    }
  }
  return { ok: true }
}

// 为一次 Run 准备工作区。永远返回 { mode: 'worktree'|'shared', ... }，不抛错。
async function prepare({ projectPath, projectId, runId, rootDir, exec, fsImpl = fs } = {}) {
  const fallback = (reason) => ({ mode: 'shared', reason: String(reason || 'not_available') })
  if (!projectPath || !rootDir) return fallback('missing_project')
  if (!fsImpl.existsSync(projectPath)) return fallback('project_missing')
  const opts = { exec }
  if (!(await isGitRepo(projectPath, opts))) return fallback('not_git_repo')
  const baseCommit = await headCommit(projectPath, opts)
  if (!baseCommit) return fallback('no_head')

  const branch = `miniagent/run-${String(runId).slice(0, 12)}`
  const worktreePath = path.join(rootDir, String(projectId), String(runId))
  try {
    fsImpl.mkdirSync(path.dirname(worktreePath), { recursive: true })
    if (fsImpl.existsSync(worktreePath)) {
      await runGit(['worktree', 'remove', '--force', worktreePath], { cwd: projectPath, exec })
    }
    const added = await runGit(['worktree', 'add', '-b', branch, worktreePath, baseCommit], {
      cwd: projectPath,
      exec
    })
    if (!added.ok) return fallback('worktree_add_failed')

    const snap = await snapshotDirty({
      projectPath,
      worktreePath,
      tempDir: path.join(rootDir, '.tmp'),
      exec
    })
    if (!snap.ok) {
      await removeWorktree({ projectPath, worktreePath, branch, exec })
      return fallback(`dirty_snapshot_${snap.reason}`)
    }
    return {
      mode: 'worktree',
      path: worktreePath,
      branch,
      baseCommit,
      projectPath,
      projectId,
      createdAt: Date.now()
    }
  } catch (error) {
    await removeWorktree({ projectPath, worktreePath, branch, exec })
    return fallback(String((error && error.message) || error))
  }
}

// 自动合并。调用方负责判断 Run 终态和验收状态。
async function autoMerge({ projectPath, workspace, exec } = {}) {
  if (!workspace || workspace.mode !== 'worktree')
    return { status: 'skipped', reason: 'no_worktree' }
  if (!projectPath || !fs.existsSync(projectPath)) {
    return { status: 'skipped', reason: 'project_missing' }
  }
  const opts = { cwd: projectPath, exec }
  if (!(await isGitRepo(projectPath, opts))) {
    return { status: 'skipped', reason: 'not_git_repo' }
  }
  if (!(await isClean(projectPath, opts))) {
    return { status: 'skipped', reason: 'main_dirty' }
  }
  // Agent 在 worktree 中的改动通常未提交；先落到工作区分支，再合并。
  if (workspace.path && fs.existsSync(workspace.path)) {
    const wt = { cwd: workspace.path, exec }
    const status = await runGit(['status', '--porcelain'], wt)
    if (!status.ok) return { status: 'failed', reason: 'worktree_status_failed' }
    if (status.stdout.trim()) {
      const added = await runGit(['add', '-A'], wt)
      if (!added.ok) return { status: 'failed', reason: 'worktree_add_failed' }
      const committed = await runGit(
        [
          '-c',
          'user.name=Mini Agent',
          '-c',
          'user.email=miniagent@local',
          'commit',
          '-m',
          `miniagent: run ${workspace.branch}`
        ],
        wt
      )
      if (!committed.ok) return { status: 'failed', reason: 'worktree_commit_failed' }
    }
  }
  const merged = await runGit(['merge', '--no-ff', '--no-edit', workspace.branch], opts)
  if (!merged.ok) {
    await runGit(['merge', '--abort'], opts)
    return { status: 'conflict', reason: merged.stderr.slice(0, 300) || 'merge_failed' }
  }
  const head = await runGit(['rev-parse', 'HEAD'], opts)
  try {
    await runGit(['worktree', 'remove', '--force', workspace.path], opts)
    await runGit(['worktree', 'prune'], opts)
  } catch {
    // 合并已成功，工作区清理失败只影响磁盘占用
  }
  return {
    status: 'merged',
    at: Date.now(),
    commit: head.ok ? head.stdout.trim() : '',
    branch: workspace.branch
  }
}

// 删除单个工作区（UI/项目删除时使用）；不删除已合并的主目录改动。
async function dispose({ projectPath, workspace, exec } = {}) {
  if (!workspace || workspace.mode !== 'worktree') return false
  await removeWorktree({
    projectPath: projectPath || workspace.projectPath,
    worktreePath: workspace.path,
    branch: workspace.branch,
    exec
  })
  return true
}

module.exports = {
  prepare,
  autoMerge,
  dispose,
  isGitRepo,
  isClean,
  headCommit,
  MAX_UNTRACKED_FILES,
  MAX_UNTRACKED_BYTES
}
