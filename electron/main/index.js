const { app } = require('electron')
const path = require('path')
const dbm = require('../store/db')
const repos = require('../store/repos')
const notify = require('./notify')
const windows = require('./windows')
const browser = require('./browser')
const tray = require('./tray')
const shortcutsMod = require('./shortcuts')
const updaterMod = require('./updater')
const buildInfo = require('./build-info')
const { registerIpc, probeAllForProvider } = require('./ipc')
const { initProbeScheduler, stopProbeScheduler } = require('./probe-scheduler')
const { getHub } = require('./events/hub')
const runtimeLog = require('./runtime-log')
const { initUpdater, getUpdater, stopUpdater } = updaterMod

let forceQuit = false
let remoteManager = null
let shutdownPromise = null

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
  if (shutdownPromise) return shutdownPromise
  forceQuit = true
  const { runShutdownSteps, processRegistry, markShuttingDown } = require('./lifecycle')
  markShuttingDown()
  // 看门狗：所有阶段均有超时（默认 5s，共 6 段 + 1 段 4s ≈ 29s），
  // 总预算取 35s 留出余量，兜底任何失控的单步。
  const watchdog = setTimeout(() => {
    console.error('[shutdown] 清理总预算耗尽，强制退出')
    app.exit(0)
  }, 35000)
  if (watchdog.unref) watchdog.unref()
  const gateway = require('./gateway/index')
  const agent = require('./agent/index')
  const embedLocal = require('./rag/embed-local')
  const faissIndex = require('./rag/faiss-index')

  shutdownPromise = runShutdownSteps([
    {
      name: '停止定时任务',
      run: () => {
        stopProbeScheduler()
        stopUpdater()
      }
    },
    { name: '关闭远程服务', run: () => (remoteManager ? remoteManager.stop() : undefined) },
    {
      name: '中止会话与智能任务',
      timeoutMs: 4000,
      run: async () => {
        await Promise.all([gateway.stopAllStreams(), agent.stopAllRuns()])
      }
    },
    { name: '回收子进程', run: () => processRegistry.stopAll() },
    {
      name: '释放模型与窗口',
      run: async () => {
        await embedLocal.disposeSessions()
        faissIndex.invalidateAll()
        tray.destroyTray()
        browser.shutdownBrowser()
        windows.destroyAll()
      }
    },
    {
      name: '关闭数据库',
      run: () => {
        try {
          dbm.close()
        } catch (e) {
          console.warn('[shutdown] 数据库关闭失败', e)
        }
      }
    }
  ])
    .then((results) => {
      for (const r of results) {
        if (r.status === 'ok') console.log(`[shutdown] ${r.name}: 完成`)
      }
    })
    .finally(() => {
      clearTimeout(watchdog)
      shortcutsMod.unregisterAll()
      app.exit(0)
    })
  return shutdownPromise
}

function activateQuick() {
  if (forceQuit) return
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
  if (forceQuit) return
  const { screen } = require('electron')
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  windows.createCaptureWindow(d)
}

// 更新检查的离线数据源（仅 e2e/离线调试用）：环境变量指向本地 JSON，
// 内容形如 { latest: {...}, compare: {...} }。未配置时返回 null，走真实 GitHub 请求。
function readUpdateFeed(file) {
  if (!file) return null
  const fs = require('fs')
  return async () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      throw new Error('读取更新数据源失败：' + ((e && e.message) || e))
    }
  }
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
    // 运行日志尽早初始化：启动、数据库、退出清理的控制台输出都进入设置页可回看的日志。
    const log = runtimeLog.initRuntimeLog({
      dir: path.join(app.getPath('userData'), 'logs')
    })
    log.installConsoleCapture()
    log.log('info', 'app', '应用启动', {
      version: app.getVersion(),
      platform: process.platform,
      testMode: isTestMode
    })

    dbm.open(path.join(app.getPath('userData'), 'miniagent.db'))
    const dbInfo = dbm.info() || {}
    log.log('info', 'db', '数据库已打开', { path: dbInfo.path, driver: dbInfo.driver })

    // 所有推送同时进入事件中枢：界面可见即历史可见，前端可按 seq 游标补齐漏收。
    // 事件同时写入运行日志，设置页可回看任务、工具调用、通知等运行轨迹。
    const hub = getHub()
    hub.on('*', (record) => log.event(record))
    notify.setBroadcaster((ch, payload) => {
      hub.emit(ch, payload || {})
      if (remoteManager) remoteManager.events.bridge(ch, payload || {})
      windows.broadcast(ch, payload)
    })

    const main = windows.createMainWindow()
    browser.initBrowser({
      electronApi: require('electron'),
      getMainWindow: () => windows.get('main'),
      getSetting: (key) => repos.getSetting(dbm.get(), key),
      emit: (channel, payload) => notify.broadcast(channel, payload)
    })
    main.on('close', (e) => {
      if (forceQuit) return
      const { shouldCloseToTray } = require('./lifecycle')
      e.preventDefault()
      if (shouldCloseToTray(repos.getSetting(dbm.get(), 'closeToTray'))) main.hide()
      else void requestQuit()
    })

    const db = dbm.get()
    const { RemoteControlManager } = require('./remote')
    remoteManager = new RemoteControlManager({
      db,
      userData: app.getPath('userData'),
      notify: (state) => notify.broadcast('remote:changed', state),
      mobileRoot: isTestMode ? null : undefined
    })
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
      version: app.getVersion(),
      remote: () => remoteManager,
      browser: () => browser.getBrowser(),
      buildInfo: buildInfo.getBuildInfo()
    })

    require('./agent').resumeQueuedRuns()

    // 周期自动探测（需求 4.2）：每分钟一跳，按供应商 probe_interval_min 到期探测。
    // 测试模式不启动，避免干扰 e2e 的确定性。首跳即对各到期供应商完成启动探测。
    if (!isTestMode) {
      initProbeScheduler({ probeProvider: (id) => probeAllForProvider(id) }).start()
    }

    // GitHub 更新检查：启动 3s 后静默检查一次，之后每 6 小时一跳；
    // 命中新提交时推送 updater:changed，左侧栏据此显示「更新」入口。
    // MINIAGENT_UPDATE_FEED 指向本地 JSON（e2e 用），避免测试触网。
    const updateFeed = readUpdateFeed(process.env.MINIAGENT_UPDATE_FEED)
    initUpdater({
      currentVersion: app.getVersion(),
      currentCommit: buildInfo.getBuildCommit(),
      feed: updateFeed,
      onState: (state) => notify.broadcast('updater:changed', state)
    })
    // 测试模式默认不联网；给了离线数据源才启动，让 e2e 能覆盖真实判定链路
    if (!isTestMode || updateFeed) getUpdater().start()
    // Unattended smoke mode: boot fully, then report and quit cleanly.
    if (process.env.MINIAGENT_SMOKE) {
      setTimeout(() => {
        console.log('SMOKE_OK')
        requestQuit()
      }, 2500)
    }
  })

  app.on('before-quit', (event) => {
    // 系统关机、外部 app.quit() 都必须走完整回收流程；清理结束后由 requestQuit 统一 app.exit。
    event.preventDefault()
    void requestQuit()
  })

  app.on('will-quit', () => shortcutsMod.unregisterAll())

  app.on('window-all-closed', () => {
    // 不在这里直接退出：窗口销毁只是清理的一步，最终退出由 requestQuit 统一完成。
  })
}
