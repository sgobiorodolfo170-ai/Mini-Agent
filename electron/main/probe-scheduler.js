const dbm = require('../store/db')
const repos = require('../store/repos')

// 周期自动探测调度器：每分钟一跳，检查各供应商 probe_interval_min 到期即探测其全部 Key。
// 间隔 <= 0 表示关闭自动探测。probeProvider 由 ipc 注入（复用手动探测管线），
// 纯逻辑部分（dueProviders）可独立单测。

function dueProviders(providers, lastRuns, nowMs) {
  return providers
    .filter((p) => {
      const interval = Number(p.probe_interval_min) || 0
      if (interval <= 0) return false
      const last = lastRuns.get(p.id) || 0
      return nowMs - last >= interval * 60000
    })
    .map((p) => p.id)
}

function createProbeScheduler({ probeProvider, intervalMs = 60000, now = Date.now } = {}) {
  const lastRuns = new Map()
  let timer = null
  let running = false

  async function tick() {
    if (running) return
    running = true
    try {
      const db = dbm.get()
      const providers = repos.listProviders(db).filter((p) => p.enabled !== 0)
      const due = dueProviders(providers, lastRuns, now())
      for (const id of due) {
        lastRuns.set(id, now())
        await probeProvider(id)
      }
    } catch {
      // 数据库未打开等场景静默跳过，下个周期重试
    } finally {
      running = false
    }
  }

  function start() {
    if (!timer) {
      timer = setInterval(tick, intervalMs)
      if (timer.unref) timer.unref()
    }
  }
  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
  // 手动探测或修改配置后重置计时，避免刚探测完又立刻自动探测
  function reset(providerId) {
    lastRuns.delete(providerId)
  }
  return { tick, start, stop, reset }
}

let instance = null
function initProbeScheduler(opts) {
  instance = createProbeScheduler(opts)
  return instance
}
function getScheduler() {
  return instance
}
function stopProbeScheduler() {
  if (instance) instance.stop()
}

module.exports = {
  dueProviders,
  createProbeScheduler,
  initProbeScheduler,
  getScheduler,
  stopProbeScheduler
}
