const { globalShortcut } = require('electron')

// Register global hotkeys; returns a per-action report so the renderer can surface conflicts.
function applyHotkeys(map, handlers) {
  globalShortcut.unregisterAll()
  const report = {}
  for (const [action, accel] of Object.entries(map || {})) {
    if (!accel) {
      report[action] = { ok: false, reason: '未设置' }
      continue
    }
    try {
      const ok = globalShortcut.register(accel, () => {
        const fn = handlers[action]
        if (fn) fn()
      })
      report[action] = { ok, reason: ok ? '' : '注册失败（快捷键可能被其他程序占用）' }
    } catch (e) {
      report[action] = { ok: false, reason: String((e && e.message) || e) }
    }
  }
  return report
}

function unregisterAll() {
  globalShortcut.unregisterAll()
}

module.exports = { applyHotkeys, unregisterAll }
