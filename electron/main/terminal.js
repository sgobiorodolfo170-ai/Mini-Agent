const { spawn, execFile } = require('child_process')
const { broadcast } = require('./notify')
const { processRegistry } = require('./lifecycle')

// 终端控制台：每条命令独立进程执行，stdout/stderr 分块回传渲染层；
// 不依赖 PTY，因此不支持交互式程序（vim、read-host 等）。
const runs = new Map() // id -> { child, timer }
const MAX_TIMEOUT_MS = 10 * 60 * 1000

function killTree(child) {
  if (!child || child.killed) return
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    try {
      child.kill()
    } catch {
      // 进程可能已退出
    }
  }
}

function emit(id, payload) {
  broadcast('terminal:event', { id, ...payload })
}

function run({ id, command, cwd } = {}) {
  const runId = String(id || '')
  const text = String(command == null ? '' : command).trim()
  if (!runId) throw new Error('缺少终端会话 id')
  if (!text) throw new Error('命令不能为空')
  if (runs.has(runId)) throw new Error('上一条命令仍在执行，请先停止或等待结束')
  // 统一输出编码，避免中文乱码
  const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${text}`
  const child = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      cwd: cwd || undefined,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    }
  )
  processRegistry.track(child)
  const timer = setTimeout(() => {
    emit(runId, { type: 'data', stream: 'stderr', text: '\n[已超过 10 分钟，命令被终止]\n' })
    killTree(child)
  }, MAX_TIMEOUT_MS)
  runs.set(runId, { child, timer })
  child.stdout.on('data', (b) =>
    emit(runId, { type: 'data', stream: 'stdout', text: b.toString('utf8') })
  )
  child.stderr.on('data', (b) =>
    emit(runId, { type: 'data', stream: 'stderr', text: b.toString('utf8') })
  )
  child.on('error', (e) => {
    clearTimeout(timer)
    runs.delete(runId)
    emit(runId, { type: 'error', message: String((e && e.message) || e) })
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    runs.delete(runId)
    emit(runId, { type: 'exit', code })
  })
  return { ok: true }
}

function stop({ id } = {}) {
  const entry = runs.get(String(id || ''))
  if (!entry) return { stopped: false }
  clearTimeout(entry.timer)
  killTree(entry.child)
  return { stopped: true }
}

function stopAll() {
  for (const entry of runs.values()) {
    clearTimeout(entry.timer)
    killTree(entry.child)
  }
  runs.clear()
}

module.exports = { run, stop, stopAll }
