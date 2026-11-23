// 关闭行为与退出清理。主窗口只负责发 close，托盘菜单的显式退出不走 closeToTray。
const { execFile } = require('child_process')
const CLOSE_TO_TRAY_KEY = 'closeToTray'

function shouldCloseToTray(value) {
  return value !== false
}

// 退出标志：批量后台任务（知识库导入/重建、模型下载）在每个检查点读取它，
// 从而「陆续停下」而不是继续向已关闭的数据库写入。
let shuttingDown = false

function isShuttingDown() {
  return shuttingDown
}

function markShuttingDown() {
  shuttingDown = true
  return shuttingDown
}

// 仅供测试复位单例状态
function _resetShuttingDown() {
  shuttingDown = false
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout(promise, ms, label) {
  let timer = null
  return Promise.race([
    Promise.resolve()
      .then(promise)
      .then(
        (value) => ({ status: 'ok', value }),
        (error) => ({ status: 'error', error: String((error && error.message) || error) })
      ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timeout', error: `${label} 超过 ${ms}ms` }), ms)
      if (timer.unref) timer.unref()
    })
  ]).finally(() => clearTimeout(timer))
}

// 统一编排、串行执行，单阶段失败不阻塞后续阶段，重复退出共享同一个 Promise。
async function runShutdownSteps(steps, { logger = console, timeoutMs = 5000 } = {}) {
  const results = []
  for (const step of steps) {
    const result = await withTimeout(step.run, step.timeoutMs || timeoutMs, step.name)
    results.push({ name: step.name, ...result })
    if (result.status !== 'ok' && logger && logger.warn) {
      logger.warn(`[shutdown] ${step.name}: ${result.error}`)
    }
  }
  return results
}

// 子进程登记处：工具/MCP 只需在创建时注册，事件退出或 finally 时自动注销。
function createProcessRegistry({ execFile, platform = process.platform } = {}) {
  const children = new Set()
  let closing = false

  function track(child) {
    if (!child) return child
    if (closing) {
      void terminateChild(child, { execFile, platform })
      return child
    }
    children.add(child)
    const release = () => children.delete(child)
    child.once('exit', release)
    child.once('close', release)
    return child
  }

  function untrack(child) {
    children.delete(child)
  }

  async function stopAll(options = {}) {
    closing = true
    const current = [...children]
    children.clear()
    await Promise.all(
      current.map((child) => terminateChild(child, { execFile, platform, ...options }))
    )
  }

  return {
    track,
    untrack,
    stopAll,
    get size() {
      return children.size
    },
    get closing() {
      return closing
    }
  }
}

function isRunning(child) {
  // ChildProcess.killed 只表示信号已发出，不能据此认定进程已经退出。
  return !!child && child.exitCode == null && child.signalCode == null
}

function waitForExit(child, ms) {
  if (!isRunning(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let timer = null
    const done = () => {
      clearTimeout(timer)
      child.removeListener('exit', done)
      child.removeListener('close', done)
      resolve(true)
    }
    child.once('exit', done)
    child.once('close', done)
    timer = setTimeout(() => {
      child.removeListener('exit', done)
      child.removeListener('close', done)
      resolve(false)
    }, ms)
    if (timer.unref) timer.unref()
  })
}

function treeKill(pid, execFile) {
  return new Promise((resolve) => {
    if (!pid || !execFile) return resolve()
    execFile('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () =>
      resolve()
    )
  })
}

// graceful 留给 MCP 等服务主动处理 stdin/通知；之后 SIGTERM → SIGKILL → taskkill 整树。
async function terminateChild(
  child,
  { execFile, platform = process.platform, graceMs = 600, killMs = 600 } = {}
) {
  if (!isRunning(child)) return 'exited'
  try {
    child.kill('SIGTERM')
  } catch {
    // 已退出或权限不足，继续等待事件确认
  }
  if (await waitForExit(child, graceMs)) return 'terminated'
  if (!isRunning(child)) return 'terminated'
  if (platform === 'win32' && child.pid && execFile) {
    await treeKill(child.pid, execFile)
    if (await waitForExit(child, killMs)) return 'tree-killed'
  } else {
    try {
      child.kill('SIGKILL')
    } catch {
      // 进程可能刚好退出
    }
    if (await waitForExit(child, killMs)) return 'killed'
  }
  return 'timeout'
}

const registry = createProcessRegistry({ execFile })

module.exports = {
  CLOSE_TO_TRAY_KEY,
  shouldCloseToTray,
  isShuttingDown,
  markShuttingDown,
  _resetShuttingDown,
  delay,
  withTimeout,
  runShutdownSteps,
  createProcessRegistry,
  terminateChild,
  waitForExit,
  processRegistry: registry
}
