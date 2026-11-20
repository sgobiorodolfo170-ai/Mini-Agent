const { app } = require('electron')
const path = require('path')
const dbm = require('../store/db')
const repos = require('../store/repos')
const notify = require('./notify')
const windows = require('./windows')
const tray = require('./tray')
const shortcutsMod = require('./shortcuts')
const { registerIpc, probeAllForProvider } = require('./ipc')
const { initProbeScheduler, stopProbeScheduler } = require('./probe-scheduler')

let forceQuit = false

// E2E test mode: isolated userData dir also acts as the test-mode switch
// (skips single-instance lock and global hotkey registration).
const isTestMode = !!process.env.MINIAGENT_USER_DATA
if (isTestMode) {
  app.setPath('userData', process.env.MINIAGENT_USER_DATA)
} else {
  // 显示名（productName）变更不应改变数据目录：固定沿用 miniagent，
  // 保证历史数据库、密钥与已下载模型继续可用。
  app.setPath('userData', path.join(app.getPath('appData'), 'miniagent'))
}

process.on('uncaughtException', (e) => {
  console.error('MINIAGENT_UNCAUGHT', e)
})
process.on('unhandledRejection', (e) => {
  console.error('MINIAGENT_UNHANDLED', e)
})

function requestQuit() {
  forceQuit = true
  app.quit()
}

function activateQuick() {
  windows.createQuickWindow()
  windows.show('quick')
  windows.sendTo('quick', 'quick:activated', {})
}

async function captureSelectionFlow() {
  const { captureSelectedText } = require('./sys/selection')
  const { clipboard } = require('electron')
  const text = await captureSelectedText(clipboard)
  if (text) {
    windows.createQuickWindow()
    windows.show('quick')
    windows.sendTo('quick', 'quick:selection', { text })
  } else {
    notify.broadcast('app:notice', {
      level: 'warn',
      message: '未捕获到选中文本（目标窗口可能不支持）'
    })
  }
}

function startCapture() {
  const { screen } = require('electron')
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  windows.createCaptureWindow(d)
}

function applyHotkeysNow() {
  const db = dbm.get()
  const map = repos.getSetting(db, 'hotkeys') || {
    quick: 'Alt+Space',
    selection: 'Alt+Q',
    capture: 'Alt+S'
  }
  const report = shortcutsMod.applyHotkeys(map, {
    quick: activateQuick,
    selection: captureSelectionFlow,
    capture: startCapture
  })
  notify.broadcast('hotkeys:report', report)
  return report
}

const gotLock = isTestMode ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => windows.show('main'))

  app.whenReady().then(() => {
    dbm.open(path.join(app.getPath('userData'), 'miniagent.db'))
    notify.setBroadcaster((ch, payload) => windows.broadcast(ch, payload))

    const main = windows.createMainWindow()
    main.on('close', (e) => {
      if (!forceQuit) {
        e.preventDefault()
        main.hide()
      }
    })

    const db = dbm.get()
    if (repos.getSetting(db, 'showBall') !== false) windows.createBallWindow()

    tray.createTray({
      onShowMain: () => windows.show('main'),
      onQuick: activateQuick,
      onQuit: requestQuit
    })

    if (!isTestMode) applyHotkeysNow()
    registerIpc({
      activateQuick,
      startCapture,
      requestQuit,
      applyHotkeysNow,
      version: app.getVersion()
    })

    // 周期自动探测（需求 4.2）：每分钟一跳，按供应商 probe_interval_min 到期探测。
    // 测试模式不启动，避免干扰 e2e 的确定性。首跳即对各到期供应商完成启动探测。
    if (!isTestMode) {
      initProbeScheduler({ probeProvider: (id) => probeAllForProvider(id) }).start()
    }

    // Unattended smoke mode: boot fully, then report and quit cleanly.
    if (process.env.MINIAGENT_SMOKE) {
      setTimeout(() => {
        console.log('SMOKE_OK')
        requestQuit()
      }, 2500)
    }
  })

  app.on('before-quit', () => {
    forceQuit = true
    shortcutsMod.unregisterAll()
    stopProbeScheduler()
    try {
      dbm.close()
    } catch {
      /* ignore */
    }
  })

  app.on('window-all-closed', () => {
    // Tray keeps the app alive; only a real quit request exits.
    if (forceQuit) app.quit()
  })
}
