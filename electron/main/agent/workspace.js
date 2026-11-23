// Git worktree 隔离：每个 Agent Run 在独立工作区执行，成功后按安全条件自动合并。
//
// 安全原则：
// - 严格模式下，Git 不可用或快照失败返回 error，不静默共享目录；
// - 自动合并不覆盖脏主目录，冲突立即 abort；
// - 图节点封存分支成果，下游节点按依赖顺序继承，不直接改主库。

const fs = require('fs')
const path = require('path')
const { createHash } = require('node:crypto')
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

// 为一次 Run 准备工作区。strict 用于用户明确选择 worktree 的场景，失败不得降级。
async function prepare({
  projectPath,
  projectId,
  runId,
  rootDir,
  exec,
  fsImpl = fs,
  strict = false
} = {}) {
  const fallback = (reason) => ({
    mode: strict ? 'error' : 'shared',
    reason: String(reason || 'not_available')
  })
  if (!projectPath || !rootDir) return fallback('missing_project')
  if (!fsImpl.existsSync(projectPath)) return fallback('project_missing')
  const opts = { exec }
  if (!(await isGitRepo(projectPath, opts))) return fallback('not_git_repo')
  const baseCommit = await headCommit(projectPath, opts)
  if (!baseCommit) return fallback('no_head')

  const branchId = String(runId)
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, 48)
  const branchHash = createHash('sha1').update(String(runId)).digest('hex').slice(0, 8)
  const branch = `miniagent/run-${branchId}-${branchHash}`
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
    if (!added.ok) return { ...fallback('worktree_add_failed'), detail: added.stderr.slice(0, 500) }

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

async function commitWorktree({ workspace, exec } = {}) {
  if (
    !workspace ||
    workspace.mode !== 'worktree' ||
    !workspace.path ||
    !fs.existsSync(workspace.path)
  ) {
    return { status: 'failed', reason: 'worktree_missing' }
  }
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
  const head = await runGit(['rev-parse', 'HEAD'], wt)
  if (!head.ok) return { status: 'failed', reason: 'worktree_head_failed' }
  return { status: 'sealed', commit: head.stdout.trim(), branch: workspace.branch }
}

async function sealArtifact({ workspace, exec } = {}) {
  return commitWorktree({ workspace, exec })
}

function sameProject(a, b) {
  if (!a || !b) return false
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function normalizeConflictStrategy(value) {
  const strategy = String(value || 'manual')
  if (!['manual', 'ours', 'theirs'].includes(strategy)) throw new Error('非法的工作区冲突策略')
  return strategy
}

async function conflictedFiles(cwd, exec) {
  const result = await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd, exec })
  return result.ok
    ? result.stdout
        .split(/\r?\n/)
        .map((file) => file.trim())
        .filter(Boolean)
    : []
}

async function resolveMergeConflict({ cwd, strategy = 'manual', exec } = {}) {
  const normalized = normalizeConflictStrategy(strategy)
  const files = await conflictedFiles(cwd, exec)
  const resolution = { strategy: normalized, files, result: normalized, at: Date.now() }
  if (normalized === 'manual') return { ...resolution, status: 'manual' }
  if (!files.length) return { ...resolution, status: 'skipped', result: 'no_conflicts' }

  const side = normalized === 'ours' ? 'ours' : 'theirs'
  const ref = normalized === 'ours' ? 'HEAD' : 'MERGE_HEAD'
  for (const file of files) {
    const exists = await runGit(['cat-file', '-e', `${ref}:${file}`], { cwd, exec })
    const selected = exists.ok
      ? await runGit(['checkout', `--${side}`, '--', file], { cwd, exec })
      : await runGit(['rm', '-f', '--', file], { cwd, exec })
    if (!selected.ok) {
      return {
        ...resolution,
        status: 'failed',
        result: 'checkout_failed',
        detail: selected.stderr.slice(0, 500)
      }
    }
  }
  const added = await runGit(['add', '-A'], { cwd, exec })
  if (!added.ok)
    return {
      ...resolution,
      status: 'failed',
      result: 'add_failed',
      detail: added.stderr.slice(0, 500)
    }
  const remaining = await conflictedFiles(cwd, exec)
  if (remaining.length)
    return {
      ...resolution,
      status: 'failed',
      result: 'unresolved_files',
      files: remaining
    }
  const committed = await runGit(
    ['-c', 'user.name=Mini Agent', '-c', 'user.email=miniagent@local', 'commit', '--no-edit'],
    { cwd, exec }
  )
  if (!committed.ok)
    return {
      ...resolution,
      status: 'failed',
      result: 'commit_failed',
      detail: committed.stderr.slice(0, 500)
    }
  return { ...resolution, status: 'resolved', result: 'resolved' }
}

async function inheritArtifacts({
  projectPath,
  workspace,
  dependencies = [],
  conflictStrategy = 'manual',
  exec
} = {}) {
  conflictStrategy = normalizeConflictStrategy(conflictStrategy)
  if (!dependencies.length) return { status: 'skipped', reason: 'no_dependencies' }
  if (!workspace || workspace.mode !== 'worktree') {
    return { status: 'failed', reason: 'workspace_not_isolated' }
  }
  if (!sameProject(projectPath, workspace.projectPath)) {
    return { status: 'failed', reason: 'dependency_project_mismatch' }
  }
  const baseline = await commitWorktree({ workspace, exec })
  if (baseline.status !== 'sealed') return baseline

  const inheritance = []
  for (const dependency of dependencies) {
    const depWorkspace = dependency.workspace || null
    const artifact = depWorkspace && depWorkspace.artifact
    if (
      dependency.status !== 'done' ||
      !depWorkspace ||
      depWorkspace.mode !== 'worktree' ||
      !sameProject(projectPath, depWorkspace.projectPath)
    ) {
      return {
        status: 'failed',
        reason: 'dependency_artifact_missing',
        dependencyRunId: dependency.runId,
        inheritance
      }
    }
    if (artifact.status !== 'sealed' || !artifact.commit) {
      return {
        status: 'failed',
        reason: 'dependency_artifact_unsealed',
        dependencyRunId: dependency.runId,
        inheritance
      }
    }
    const wt = { cwd: workspace.path, exec }
    const ancestor = await runGit(['merge-base', '--is-ancestor', artifact.commit, 'HEAD'], wt)
    if (ancestor.ok) {
      inheritance.push({
        runId: dependency.runId,
        commit: artifact.commit,
        status: 'already_applied'
      })
      continue
    }
    const merged = await runGit(
      [
        '-c',
        'user.name=Mini Agent',
        '-c',
        'user.email=miniagent@local',
        'merge',
        '--no-ff',
        '--no-edit',
        artifact.commit
      ],
      wt
    )
    if (!merged.ok) {
      const resolution = await resolveMergeConflict({
        cwd: workspace.path,
        strategy: conflictStrategy,
        exec
      })
      if (resolution.status !== 'resolved') {
        await runGit(['merge', '--abort'], wt)
        return {
          status: 'failed',
          reason:
            resolution.status === 'manual'
              ? 'dependency_merge_conflict'
              : 'conflict_resolution_failed',
          dependencyRunId: dependency.runId,
          detail: merged.stderr.slice(0, 500),
          resolution,
          inheritance
        }
      }
      inheritance.push({
        runId: dependency.runId,
        commit: artifact.commit,
        status: 'merged_resolved',
        resolution
      })
      continue
    }
    inheritance.push({ runId: dependency.runId, commit: artifact.commit, status: 'merged' })
  }
  return { status: 'ready', inheritance }
}

async function verifyWorkspace({ projectPath, workspace, command = '', exec } = {}) {
  if (!workspace || workspace.mode !== 'worktree') {
    return { status: 'failed', reason: 'workspace_not_isolated', checks: [] }
  }
  if (!sameProject(projectPath, workspace.projectPath)) {
    return { status: 'failed', reason: 'workspace_project_mismatch', checks: [] }
  }
  const sealed = await commitWorktree({ workspace, exec })
  if (sealed.status !== 'sealed') return { ...sealed, checks: [] }
  const wt = { cwd: workspace.path, exec }
  const checks = []
  const diffCheck = await runGit(['diff', '--check', `${workspace.baseCommit}..HEAD`], wt)
  checks.push({ name: 'diff_check', ok: diffCheck.ok })
  if (!diffCheck.ok) {
    return {
      status: 'failed',
      reason: 'diff_check_failed',
      detail: diffCheck.stdout.slice(0, 1000) || diffCheck.stderr.slice(0, 1000),
      checks,
      commit: sealed.commit
    }
  }
  const markers = await runGit(['grep', '-n', '-E', '^(<<<<<<< |>>>>>>> )', 'HEAD', '--'], wt)
  if (markers.ok && markers.stdout.trim()) {
    checks.push({ name: 'conflict_markers', ok: false })
    return {
      status: 'failed',
      reason: 'conflict_markers_found',
      detail: markers.stdout.slice(0, 1000),
      checks,
      commit: sealed.commit
    }
  }
  checks.push({ name: 'conflict_markers', ok: true })

  const verifyCommand = String(command || '').trim()
  if (verifyCommand) {
    try {
      await exec(
        process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
        ['-NoProfile', '-NonInteractive', '-Command', verifyCommand],
        {
          cwd: workspace.path,
          windowsHide: true,
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024
        }
      )
      checks.push({ name: 'verify_command', ok: true })
    } catch (error) {
      checks.push({ name: 'verify_command', ok: false })
      return {
        status: 'failed',
        reason: 'verify_command_failed',
        detail: String((error && error.stderr) || (error && error.message) || error).slice(0, 2000),
        checks,
        commit: sealed.commit
      }
    }
  }
  return { status: 'passed', checks, commit: sealed.commit, at: Date.now() }
}

// 自动合并。调用方负责判断 Run 终态和验收状态。
async function autoMerge({ projectPath, workspace, conflictStrategy = 'manual', exec } = {}) {
  conflictStrategy = normalizeConflictStrategy(conflictStrategy)
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
  const sealed = await sealArtifact({ workspace, exec })
  if (sealed.status !== 'sealed') {
    return { status: 'failed', reason: sealed.reason }
  }
  const merged = await runGit(['merge', '--no-ff', '--no-edit', workspace.branch], opts)
  let resolution = null
  if (!merged.ok) {
    resolution = await resolveMergeConflict({
      cwd: projectPath,
      strategy: conflictStrategy,
      exec
    })
    if (resolution.status !== 'resolved') {
      await runGit(['merge', '--abort'], opts)
      return {
        status: resolution.status === 'manual' ? 'conflict' : 'failed',
        reason: resolution.status === 'manual' ? 'merge_conflict' : 'conflict_resolution_failed',
        detail: merged.stderr.slice(0, 300),
        resolution
      }
    }
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
    branch: workspace.branch,
    resolution
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
  commitWorktree,
  sealArtifact,
  inheritArtifacts,
  verifyWorkspace,
  autoMerge,
  dispose,
  isGitRepo,
  isClean,
  headCommit,
  MAX_UNTRACKED_FILES,
  MAX_UNTRACKED_BYTES
}
