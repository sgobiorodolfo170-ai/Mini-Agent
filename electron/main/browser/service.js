const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  normalizeBrowserUrl,
  assertBrowserUrlAllowed,
  isPrivateBrowserUrl,
  safeFilename
} = require('./policy')
const {
  beginElementSelection,
  getSelectedElement,
  resetElementInspector,
  setSelectedElementStyles,
  resetSelectedElementStyles,
  sanitizeElementInfo,
  validateStyleChanges
} = require('./element-inspector')

const USER_PARTITION = 'persist:miniagent-browser'
const DEFAULT_LOAD_TIMEOUT_MS = 30000
const DEFAULT_MAX_TABS = 6
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'

function navigationErrorMessage(error, code, desc) {
  if (error instanceof BrowserError) return error.message
  const match = String((error && error.message) || '').match(/ERR_[A-Z_]+/)
  const key = String((match && match[0]) || code || '')
  const messages = {
    ERR_NAME_NOT_RESOLVED: '无法解析域名，请检查网络或 DNS',
    ERR_NAME_RESOLUTION_FAILED: '无法解析域名，请检查网络或 DNS',
    ERR_INTERNET_DISCONNECTED: '网络连接已断开，请检查网络',
    ERR_CONNECTION_REFUSED: '目标服务器拒绝连接',
    ERR_CONNECTION_TIMED_OUT: '连接目标服务器超时',
    ERR_CONNECTION_RESET: '与目标服务器的连接已重置',
    ERR_ADDRESS_UNREACHABLE: '目标服务器地址不可达',
    ERR_CERT_AUTHORITY_INVALID: '网站证书验证失败，已阻止访问',
    ERR_CERT_DATE_INVALID: '网站证书已过期或尚未生效',
    ERR_CERT_COMMON_NAME_INVALID: '网站证书与域名不匹配',
    ERR_SSL_PROTOCOL_ERROR: '网站 TLS 协议不受支持',
    ERR_EMPTY_RESPONSE: '目标服务器未返回有效响应',
    ERR_HTTP_RESPONSE_CODE_FAILURE: '目标服务器返回错误响应'
  }
  const message = messages[key] || String(desc || (error && error.message) || '页面加载失败')
  return key ? `${message} (${key})` : message
}

class BrowserError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'BrowserError'
    this.code = code
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cleanPartitionRunId(runId) {
  return String(runId || 'unknown')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80)
}

function createBrowserService(options = {}) {
  const electronApi = options.electronApi
  const getMainWindow = options.getMainWindow || (() => null)
  const getSetting = options.getSetting || (() => null)
  const emit = options.emit || (() => {})
  const now = options.now || Date.now
  const idFactory = options.idFactory || (() => `tab-${crypto.randomUUID()}`)
  const loadTimeoutMs = Number(options.loadTimeoutMs) || DEFAULT_LOAD_TIMEOUT_MS
  const maxTabs =
    Number(options.maxTabs) || Number(getSetting('browserMaxTabs')) || DEFAULT_MAX_TABS
  const downloadDir =
    options.downloadDir || path.join(electronApi.app.getPath('userData'), 'browser-downloads')
  const artifactDir =
    options.artifactDir || path.join(electronApi.app.getPath('userData'), 'browser-artifacts')

  const tabs = new Map()
  const runTabs = new Map()
  const configuredSessions = new Map()
  let activeTabId = null
  let attachedTabId = null
  let enabled = getSetting('browserEnabled') !== false

  function ensureAvailable() {
    if (!electronApi || !electronApi.WebContentsView) {
      throw new BrowserError('当前环境不支持内置浏览器', 'BROWSER_VIEW_UNAVAILABLE')
    }
    if (!enabled) throw new BrowserError('内置浏览器已停用', 'BROWSER_DISABLED')
    const main = getMainWindow()
    if (!main || main.isDestroyed()) {
      throw new BrowserError('主窗口不可用', 'BROWSER_VIEW_UNAVAILABLE')
    }
  }

  function allowPrivateNetwork() {
    return getSetting('browserAllowPrivateNetwork') === true
  }

  function summarize(tab) {
    if (!tab) return null
    return {
      id: tab.id,
      kind: tab.kind,
      runId: tab.runId,
      title: tab.title,
      url: tab.url,
      loading: tab.loading,
      error: tab.error,
      owner: tab.owner,
      crashed: tab.crashed,
      devToolsOpened: tab.webContents.isDevToolsOpened(),
      device: tab.device ? { ...tab.device } : null,
      createdAt: tab.createdAt,
      bounds: tab.view.getBounds()
    }
  }

  function getState() {
    return {
      enabled,
      activeTabId,
      attachedTabId,
      tabs: [...tabs.values()].map(summarize),
      stats: {
        tabCount: tabs.size,
        agentTabCount: [...tabs.values()].filter((tab) => tab.kind === 'agent').length,
        attached: !!attachedTabId
      },
      policy: { allowPrivateNetwork: allowPrivateNetwork(), maxTabs }
    }
  }

  function emitState(type, extra = {}) {
    emit('browser:event', { type, state: getState(), ...extra })
  }

  function requireTab(tabId) {
    const tab = tabs.get(String(tabId || ''))
    if (!tab || tab.destroyed)
      throw new BrowserError('浏览器标签不存在或已关闭', 'BROWSER_TAB_NOT_FOUND')
    return tab
  }

  function assertAgentAccess(tab, runId) {
    if (tab.kind !== 'agent' || tab.runId !== String(runId)) {
      throw new BrowserError('Agent 不能访问其他会话的浏览器标签', 'BROWSER_RUN_MISMATCH')
    }
    if (tab.owner !== 'agent') {
      throw new BrowserError('用户已人工接管该标签', 'BROWSER_TAKEN_OVER')
    }
  }

  function resolveRunTab(runId, tabId, { create = false } = {}) {
    const id = tabId || runTabs.get(String(runId))
    if (!id) {
      if (!create) {
        throw new BrowserError('浏览器临时会话已结束，请重新导航', 'BROWSER_SESSION_EXPIRED')
      }
      return openTab({ kind: 'agent', runId, url: 'about:blank' })
    }
    const tab = tabs.get(id)
    if (!tab || tab.destroyed) {
      throw new BrowserError('浏览器临时会话已结束，请重新导航', 'BROWSER_SESSION_EXPIRED')
    }
    assertAgentAccess(tab, runId)
    return tab
  }

  function partitionFor(kind, runId) {
    return kind === 'user' ? USER_PARTITION : `miniagent-agent-${cleanPartitionRunId(runId)}`
  }

  function removeSessionHandlers(partition) {
    const cleanup = configuredSessions.get(partition)
    if (cleanup) cleanup()
    configuredSessions.delete(partition)
  }

  function releaseSessionIfUnused(partition) {
    const inUse = [...tabs.values()].some(
      (tab) => !tab.destroyed && partitionFor(tab.kind, tab.runId) === partition
    )
    if (!inUse) removeSessionHandlers(partition)
  }

  function configureSession(partition, kind) {
    if (configuredSessions.has(partition)) return
    const sess = electronApi.session.fromPartition(partition)
    const handlers = []

    sess.setPermissionRequestHandler((_wc, permission, callback) => {
      const safe = kind === 'user' && ['fullscreen', 'pointerLock'].includes(permission)
      callback(safe)
    })
    sess.setPermissionCheckHandler(() => false)

    if (kind === 'agent') {
      const onBeforeRequest = (details, callback) => {
        if (!allowPrivateNetwork() && isPrivateBrowserUrl(details.url)) callback({ cancel: true })
        else callback({})
      }
      sess.webRequest.onBeforeRequest(onBeforeRequest)
      handlers.push(() => sess.webRequest.removeListener('before-request', onBeforeRequest))
    }

    const onDownload = (event, item, webContents) => {
      const tab = [...tabs.values()].find((entry) => entry.webContents === webContents)
      if (kind === 'agent' || !tab) {
        item.cancel()
        emitState('blocked', {
          tabId: tab && tab.id,
          reason: 'Agent 会话禁止下载文件'
        })
        return
      }
      fs.mkdirSync(downloadDir, { recursive: true })
      const original = safeFilename(item.getFilename())
      const ext = path.extname(original)
      const stem = ext ? original.slice(0, -ext.length) : original
      let filename = original
      let target = path.join(downloadDir, filename)
      let suffix = 1
      while (fs.existsSync(target)) {
        filename = `${stem}-${Date.now()}-${suffix++}${ext}`
        target = path.join(downloadDir, filename)
      }
      item.setSavePath(target)
      item.once('done', (_event, state) => {
        emitState('download', {
          tabId: tab.id,
          download: { filename, path: target, state }
        })
      })
    }
    sess.on('will-download', onDownload)
    handlers.push(() => sess.removeListener('will-download', onDownload))
    configuredSessions.set(partition, () => {
      for (const off of handlers) off()
      sess.setPermissionRequestHandler(null)
      sess.setPermissionCheckHandler(null)
    })
  }

  function updateTab(tab, patch, type = 'state') {
    if (!tab || tab.destroyed) return
    Object.assign(tab, patch)
    emitState(type, { tabId: tab.id })
  }

  function attachEvents(tab) {
    const wc = tab.webContents
    tab.cleanups.push(() => wc.removeAllListeners('before-mouse-event'))
    wc.on('before-mouse-event', (event) => {
      if (tab.kind === 'agent' && tab.owner === 'agent') event.preventDefault()
    })

    tab.cleanups.push(() => wc.removeAllListeners('before-input-event'))
    wc.on('before-input-event', (event, input) => {
      if (input && input.type === 'keyDown' && input.key === 'F12' && !input.isAutoRepeat) {
        event.preventDefault()
        toggleDevTools(tab.id)
        return
      }
      if (tab.kind !== 'agent' || tab.owner !== 'agent') return
      event.preventDefault()
      if (input && input.type === 'keyDown' && input.key === 'Escape') takeover(tab.id)
    })

    const onDevToolsOpened = () => emitState('state', { tabId: tab.id })
    const onDevToolsClosed = () => emitState('state', { tabId: tab.id })
    wc.on('devtools-opened', onDevToolsOpened)
    wc.on('devtools-closed', onDevToolsClosed)
    tab.cleanups.push(() => {
      wc.removeListener('devtools-opened', onDevToolsOpened)
      wc.removeListener('devtools-closed', onDevToolsClosed)
    })

    wc.setWindowOpenHandler(({ url }) => {
      if (tab.kind !== 'user' || !/^https?:$/.test(safeProtocol(url))) {
        emitState('blocked', { tabId: tab.id, reason: '已阻止 Agent 或非网页弹窗' })
        return { action: 'deny' }
      }
      return {
        action: 'allow',
        outlivesOpener: true,
        createWindow: () => {
          const popup = createTab({ kind: tab.kind, runId: tab.runId, url })
          activeTabId = popup.id
          emitState('tab.created', { tabId: popup.id })
          return popup.webContents
        }
      }
    })

    const onWillNavigate = (event, url) => {
      if (tab.destroyed) return
      event.preventDefault()
      navigateTab(tab, url).catch((error) => {
        updateTab(tab, { error: String(error.message || error), loading: false })
        emitState('blocked', { tabId: tab.id, reason: String(error.message || error) })
      })
    }
    wc.on('will-navigate', onWillNavigate)
    wc.on('will-redirect', onWillNavigate)
    tab.cleanups.push(() => {
      wc.removeListener('will-navigate', onWillNavigate)
      wc.removeListener('will-redirect', onWillNavigate)
    })

    const onFrameNavigate = (event, url) => {
      if (!/^https?:$/.test(safeProtocol(url))) event.preventDefault()
    }
    wc.on('will-frame-navigate', onFrameNavigate)
    tab.cleanups.push(() => wc.removeListener('will-frame-navigate', onFrameNavigate))

    const onStart = () => {
      cancelSelection(tab)
      tab.inspector.selected = null
      updateTab(tab, { loading: true, error: null })
    }
    const onStop = () => updateTab(tab, { loading: false })
    const onNavigate = (_event, url) => updateTab(tab, { url, error: null })
    const onTitle = (_event, title) => updateTab(tab, { title: String(title || '') })
    const onFail = (_event, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      updateTab(tab, {
        loading: false,
        error: navigationErrorMessage(null, code, desc)
      })
    }
    const onGone = (_event, details) => {
      cancelSelection(tab)
      tab.inspector.selected = null
      updateTab(tab, {
        loading: false,
        crashed: true,
        error: `页面进程已退出：${details && details.reason ? details.reason : 'unknown'}`
      })
    }
    const onDestroyed = () => {
      if (tabs.get(tab.id) !== tab) return
      tabs.delete(tab.id)
      if (runTabs.get(String(tab.runId)) === tab.id) runTabs.delete(String(tab.runId))
      if (activeTabId === tab.id) activeTabId = [...tabs.keys()].at(-1) || null
      if (attachedTabId === tab.id) attachedTabId = null
      tab.destroyed = true
      emitState('tab.closed', { tabId: tab.id })
    }
    wc.on('did-start-loading', onStart)
    wc.on('did-stop-loading', onStop)
    wc.on('did-navigate', onNavigate)
    wc.on('did-navigate-in-page', onNavigate)
    wc.on('page-title-updated', onTitle)
    wc.on('did-fail-load', onFail)
    wc.on('render-process-gone', onGone)
    wc.on('destroyed', onDestroyed)
    tab.cleanups.push(() => {
      wc.removeListener('did-start-loading', onStart)
      wc.removeListener('did-stop-loading', onStop)
      wc.removeListener('did-navigate', onNavigate)
      wc.removeListener('did-navigate-in-page', onNavigate)
      wc.removeListener('page-title-updated', onTitle)
      wc.removeListener('did-fail-load', onFail)
      wc.removeListener('render-process-gone', onGone)
      wc.removeListener('destroyed', onDestroyed)
    })
  }

  function safeProtocol(url) {
    try {
      return new URL(url).protocol
    } catch {
      return ''
    }
  }

  function createTab({
    kind = 'user',
    runId = null,
    url = 'about:blank',
    webContents = null
  } = {}) {
    ensureAvailable()
    if (!['user', 'agent'].includes(kind))
      throw new BrowserError('标签类型无效', 'BROWSER_TAB_NOT_FOUND')
    if (tabs.size >= maxTabs)
      throw new BrowserError(`最多只能打开 ${maxTabs} 个标签`, 'BROWSER_TAB_LIMIT')
    const partition = partitionFor(kind, runId)
    configureSession(partition, kind)
    const view = webContents
      ? new electronApi.WebContentsView({ webContents })
      : new electronApi.WebContentsView({
          webPreferences: {
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
            webviewTag: false,
            allowRunningInsecureContent: false,
            spellcheck: false,
            partition
          }
        })
    const wc = view.webContents
    if (!wc || wc.isDestroyed())
      throw new BrowserError('浏览器视图不可用', 'BROWSER_VIEW_UNAVAILABLE')
    wc.setUserAgent(USER_AGENT)
    const tab = {
      id: idFactory(),
      kind,
      runId: kind === 'agent' ? String(runId) : null,
      title: '',
      url,
      loading: false,
      error: null,
      owner: kind === 'agent' ? 'agent' : 'user',
      crashed: false,
      destroyed: false,
      createdAt: now(),
      view,
      webContents: wc,
      cleanups: [],
      navigationToken: 0,
      inspector: { selecting: false, selected: null, selectionToken: 0 },
      device: null,
      zoomBeforeDevice: null
    }
    tabs.set(tab.id, tab)
    if (kind === 'agent') runTabs.set(tab.runId, tab.id)
    view.setBackgroundColor('#ffffff')
    getMainWindow().contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    view.setVisible(false)
    attachEvents(tab)
    return tab
  }

  async function navigateTab(tab, rawUrl) {
    let url
    try {
      const session = electronApi.session.fromPartition(partitionFor(tab.kind, tab.runId))
      url = await assertBrowserUrlAllowed(rawUrl, {
        allowBlank: true,
        allowPrivateNetwork: allowPrivateNetwork(),
        resolveHost:
          typeof session.resolveHost === 'function' ? session.resolveHost.bind(session) : null
      })
    } catch (error) {
      updateTab(tab, { loading: false, error: navigationErrorMessage(error) })
      throw error
    }
    if (tab.destroyed || tab.webContents.isDestroyed()) {
      throw new BrowserError('浏览器标签已关闭', 'BROWSER_TAB_NOT_FOUND')
    }
    const token = ++tab.navigationToken
    updateTab(tab, { url, loading: true, error: null, crashed: false })
    let timer = null
    try {
      await Promise.race([
        tab.webContents.loadURL(url),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new BrowserError('页面加载超时', 'BROWSER_NAVIGATION_TIMEOUT'))
          }, loadTimeoutMs)
        })
      ])
      if (token !== tab.navigationToken) return summarize(tab)
      updateTab(tab, { url: tab.webContents.getURL() || url, loading: false })
    } catch (error) {
      if (token !== tab.navigationToken) return summarize(tab)
      if (error && error.code === 'BROWSER_NAVIGATION_TIMEOUT') {
        try {
          tab.webContents.stop()
        } catch {
          // 页面可能已经退出
        }
      }
      updateTab(tab, { loading: false, error: navigationErrorMessage(error) })
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
    return summarize(tab)
  }

  function openTab({ url = 'about:blank', kind = 'user', runId = null } = {}) {
    const normalized = normalizeBrowserUrl(url, { allowBlank: true })
    const tab = createTab({ kind, runId, url: normalized })
    activeTabId = tab.id
    emitState('tab.created', { tabId: tab.id })
    if (normalized !== 'about:blank') {
      navigateTab(tab, normalized).catch((error) => {
        updateTab(tab, { loading: false, error: String(error.message || error) })
        emitState('blocked', { tabId: tab.id, reason: String(error.message || error) })
      })
    }
    return tab
  }

  function closeTab(tabId) {
    const tab = requireTab(tabId)
    cancelSelection(tab)
    clearDevice(tab)
    closeDevTools(tab)
    tab.destroyed = true
    tabs.delete(tab.id)
    if (runTabs.get(String(tab.runId)) === tab.id) runTabs.delete(String(tab.runId))
    if (activeTabId === tab.id) activeTabId = [...tabs.keys()].at(-1) || null
    if (attachedTabId === tab.id) {
      attachedTabId = null
      tab.view.setVisible(false)
    }
    try {
      getMainWindow().contentView.removeChildView(tab.view)
    } catch {
      // 主窗口可能已经销毁
    }
    for (const cleanup of tab.cleanups.splice(0)) {
      try {
        cleanup()
      } catch {
        // 清理失败不阻断关闭
      }
    }
    try {
      if (!tab.webContents.isDestroyed()) tab.webContents.close()
    } catch {
      // 强制销毁兜底
    }
    setImmediate(() => {
      if (!tab.webContents.isDestroyed()) tab.webContents.destroy()
    })
    releaseSessionIfUnused(partitionFor(tab.kind, tab.runId))
    emitState('tab.closed', { tabId: tab.id })
    return getState()
  }

  function activateTab(tabId) {
    const tab = requireTab(tabId)
    activeTabId = tab.id
    if (attachedTabId) {
      const previous = tabs.get(attachedTabId)
      if (previous && previous.id !== tab.id) {
        previous.view.setVisible(false)
        cancelSelection(previous)
        closeDevTools(previous)
      }
      attachedTabId = tab.id
      tab.view.setVisible(true)
    }
    emitState('state')
    return getState()
  }

  function attachTab(tabId, bounds, options = {}) {
    const tab = requireTab(tabId)
    const rect = normalizeBounds(bounds)
    if (attachedTabId && attachedTabId !== tab.id) {
      const previous = tabs.get(attachedTabId)
      if (previous) {
        previous.view.setVisible(false)
        cancelSelection(previous)
        closeDevTools(previous)
      }
    }
    activeTabId = tab.id
    attachedTabId = tab.id
    getMainWindow().contentView.addChildView(tab.view)
    if (tab.device) {
      const displayScale = Number(options.displayScale)
      tab.webContents.setZoomFactor(
        Number.isFinite(displayScale) ? Math.max(0.25, Math.min(1, displayScale)) : 1
      )
    }
    tab.view.setBounds(rect)
    tab.view.setVisible(true)
    emitState('state')
    return getState()
  }

  function normalizeBounds(bounds) {
    const rect = {
      x: Math.round(Number(bounds && bounds.x) || 0),
      y: Math.round(Number(bounds && bounds.y) || 0),
      width: Math.round(Number(bounds && bounds.width) || 0),
      height: Math.round(Number(bounds && bounds.height) || 0)
    }
    if (rect.width < 1 || rect.height < 1) {
      throw new BrowserError('浏览器视图区域无效', 'BROWSER_VIEW_UNAVAILABLE')
    }
    return rect
  }

  function detach() {
    if (attachedTabId) {
      const tab = tabs.get(attachedTabId)
      if (tab) {
        tab.view.setVisible(false)
        cancelSelection(tab)
        closeDevTools(tab)
      }
    }
    attachedTabId = null
    emitState('state')
    return getState()
  }

  function commandTab(tabId, command) {
    const tab = requireTab(tabId)
    assertManualAccess(tab)
    if (!['back', 'forward', 'reload', 'stop'].includes(command)) {
      throw new BrowserError('未知浏览器命令', 'BROWSER_TAB_NOT_FOUND')
    }
    if (command === 'back') tab.webContents.goBack()
    if (command === 'forward') tab.webContents.goForward()
    if (command === 'reload') {
      tab.crashed = false
      tab.webContents.reload()
    }
    if (command === 'stop') tab.webContents.stop()
    emitState('state', { tabId: tab.id })
    return summarize(tab)
  }

  function takeover(tabId) {
    const tab = requireTab(tabId)
    if (tab.kind !== 'agent') return summarize(tab)
    tab.owner = 'user'
    emitState('state', { tabId: tab.id })
    return summarize(tab)
  }

  function release(tabId) {
    const tab = requireTab(tabId)
    if (tab.kind !== 'agent') return summarize(tab)
    tab.owner = 'agent'
    emitState('state', { tabId: tab.id })
    return summarize(tab)
  }

  function assertManualAccess(tab) {
    if (tab.kind === 'agent' && tab.owner !== 'user') {
      throw new BrowserError('请先人工接管 Agent 标签', 'BROWSER_TAKEN_OVER')
    }
  }

  function cancelSelection(tab) {
    if (!tab || tab.destroyed || tab.webContents.isDestroyed()) return
    tab.inspector.selectionToken += 1
    tab.inspector.selecting = false
    void resetElementInspector(tab.webContents)
  }

  function clearDevice(tab) {
    if (!tab || !tab.device || tab.destroyed || tab.webContents.isDestroyed()) return
    if (tab.zoomBeforeDevice != null) tab.webContents.setZoomFactor(tab.zoomBeforeDevice)
    tab.device = null
    tab.zoomBeforeDevice = null
  }

  function normalizeDevice(value = {}) {
    const width = Math.round(Number(value.width))
    const height = Math.round(Number(value.height))
    const scale = Math.round(Number(value.scale))
    return {
      width: Number.isFinite(width) ? Math.max(240, Math.min(3840, width)) : 1280,
      height: Number.isFinite(height) ? Math.max(240, Math.min(2160, height)) : 800,
      scale: Number.isFinite(scale) ? Math.max(25, Math.min(100, scale)) : 100
    }
  }

  async function selectElement(tabId) {
    const tab = requireTab(tabId)
    if (tab.kind === 'agent' && tab.owner === 'agent') takeover(tab.id)
    closeDevTools(tab)
    cancelSelection(tab)
    const token = ++tab.inspector.selectionToken
    tab.inspector.selecting = true
    const isCurrent = () =>
      !tab.destroyed && tabs.get(tab.id) === tab && tab.inspector.selectionToken === token
    try {
      const task = await beginElementSelection(tab.webContents)
      if (!isCurrent()) return { cancelled: true, reason: 'replaced', selected: null }
      const result = await task.result
      if (!isCurrent()) return { cancelled: true, reason: 'replaced', selected: null }
      if (result && result.selected) {
        tab.inspector.selected = sanitizeElementInfo(result.selected)
        if (!tab.inspector.selected)
          throw new BrowserError('元素信息无效', 'BROWSER_ELEMENT_INVALID')
        return { cancelled: false, selected: tab.inspector.selected }
      }
      return {
        cancelled: true,
        reason: String((result && result.reason) || 'cancelled'),
        selected: tab.inspector.selected
      }
    } finally {
      if (isCurrent()) tab.inspector.selecting = false
    }
  }

  async function cancelElementSelectionById(tabId) {
    const tab = requireTab(tabId)
    cancelSelection(tab)
    return { cancelled: true, selected: tab.inspector.selected }
  }

  async function inspectorState(tabId) {
    const tab = requireTab(tabId)
    const token = tab.inspector.selectionToken
    const selected = await getSelectedElement(tab.webContents)
    if (tab.destroyed || tabs.get(tab.id) !== tab || token !== tab.inspector.selectionToken) {
      return { selecting: tab.inspector.selecting, selected: tab.inspector.selected }
    }
    tab.inspector.selected = selected
    return { selecting: tab.inspector.selecting, selected }
  }

  async function updateElementStyles(tabId, elementId, styles = {}, resetProperties = []) {
    const tab = requireTab(tabId)
    assertManualAccess(tab)
    const changes = validateStyleChanges(styles, resetProperties)
    const id = String(elementId)
    if (!tab.inspector.selected || tab.inspector.selected.elementId !== id) {
      throw new BrowserError('选中元素已失效，请重新选择', 'BROWSER_ELEMENT_STALE')
    }
    const token = tab.inspector.selectionToken
    const selected = await setSelectedElementStyles(tab.webContents, id, changes)
    if (
      tab.destroyed ||
      tabs.get(tab.id) !== tab ||
      token !== tab.inspector.selectionToken ||
      tab.inspector.selected?.elementId !== id
    ) {
      throw new BrowserError('选中元素已失效，请重新选择', 'BROWSER_ELEMENT_STALE')
    }
    if (!selected) {
      tab.inspector.selected = null
      throw new BrowserError('选中元素已失效，请重新选择', 'BROWSER_ELEMENT_STALE')
    }
    tab.inspector.selected = selected
    return selected
  }

  async function resetElementStyles(tabId, elementId) {
    const tab = requireTab(tabId)
    assertManualAccess(tab)
    const id = String(elementId)
    if (!tab.inspector.selected || tab.inspector.selected.elementId !== id) {
      throw new BrowserError('选中元素已失效，请重新选择', 'BROWSER_ELEMENT_STALE')
    }
    const token = tab.inspector.selectionToken
    const selected = await resetSelectedElementStyles(tab.webContents, id)
    if (
      tab.destroyed ||
      tabs.get(tab.id) !== tab ||
      token !== tab.inspector.selectionToken ||
      tab.inspector.selected?.elementId !== id
    ) {
      throw new BrowserError('选中元素已失效，请重新选择', 'BROWSER_ELEMENT_STALE')
    }
    if (!selected) {
      tab.inspector.selected = null
      throw new BrowserError('选中元素已失效，请重新选择', 'BROWSER_ELEMENT_STALE')
    }
    tab.inspector.selected = selected
    return selected
  }

  function setDevice(tabId, value = {}) {
    const tab = requireTab(tabId)
    assertManualAccess(tab)
    if (!tab.device) tab.zoomBeforeDevice = tab.webContents.getZoomFactor()
    tab.device = normalizeDevice(value)
    emitState('state', { tabId: tab.id })
    return summarize(tab)
  }

  function clearDeviceById(tabId) {
    const tab = requireTab(tabId)
    clearDevice(tab)
    emitState('state', { tabId: tab.id })
    return summarize(tab)
  }

  function closeDevTools(tab) {
    if (!tab || tab.destroyed || tab.webContents.isDestroyed()) return
    if (tab.webContents.isDevToolsOpened()) tab.webContents.closeDevTools()
  }

  function toggleDevTools(tabId = attachedTabId || activeTabId) {
    if (!tabId) return null
    const tab = requireTab(tabId)
    if (tab.kind === 'agent' && tab.owner === 'agent') tab.owner = 'user'
    if (tab.webContents.isDevToolsOpened()) tab.webContents.closeDevTools()
    else {
      cancelSelection(tab)
      tab.webContents.openDevTools({ mode: 'detach', title: 'Mini Agent 开发者工具' })
    }
    return summarize(tab)
  }

  function toggleFocusedDevTools() {
    const tab = tabs.get(attachedTabId || activeTabId)
    if (!tab || !tab.webContents.isDevToolsOpened() || !tab.webContents.isDevToolsFocused())
      return null
    return toggleDevTools(tab.id)
  }

  async function snapshot(tab, maxChars = 20000) {
    const limit = Math.max(1000, Math.min(50000, Number(maxChars) || 20000))
    const info = await tab.webContents.executeJavaScript(`(() => {
      const visible = (el) => !!(el && el.getClientRects && el.getClientRects().length);
      const selector = 'a,button,input,textarea,select,[role="button"],[contenteditable="true"]';
      const elements = Array.from(document.querySelectorAll(selector)).filter(visible).slice(0, 80).map((el, i) => {
        const type = String(el.getAttribute('type') || el.tagName || '').toLowerCase();
        return {
          ref: i + 1,
          tag: el.tagName.toLowerCase(),
          type,
          text:
            type === 'password'
              ? ''
              : String(el.innerText || el.textContent || el.value || '').trim().slice(0, 160),
          label: String(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '').slice(0, 160),
          href: el.tagName.toLowerCase() === 'a' ? String(el.href || '').slice(0, 500) : undefined,
          disabled: !!el.disabled
        };
      });
      return {
        title: document.title || '',
        url: location.href,
        text: document.body ? document.body.innerText : '',
        elements
      };
    })()`)
    const text = String(info.text || '').slice(0, limit)
    return JSON.stringify({
      untrusted: true,
      title: info.title || '',
      url: info.url || tab.url,
      text: text || '(空页面)',
      truncated: String(info.text || '').length > text.length,
      elements: info.elements || []
    })
  }

  function targetScript({ ref, selector } = {}) {
    const hasSelector = typeof selector === 'string' && selector.trim().length > 0
    const hasRef = ref !== undefined && ref !== null
    if (hasSelector === hasRef) {
      throw new BrowserError('必须且只能提供 ref 或 selector', 'BROWSER_INVALID_TARGET')
    }
    if (hasSelector) return `document.querySelector(${JSON.stringify(selector.trim())})`
    const index = Number(ref)
    if (!Number.isInteger(index) || index < 1) {
      throw new BrowserError('ref 必须是正整数', 'BROWSER_INVALID_TARGET')
    }
    return `Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')).filter(el => el.getClientRects().length)[${index - 1}]`
  }

  async function click(tab, args) {
    const target = targetScript(args)
    const result = await tab.webContents.executeJavaScript(
      `(() => {
      const el = ${target};
      if (!el) return { ok: false, reason: '未找到目标元素' };
      if (el.disabled) return { ok: false, reason: '目标元素已禁用' };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true };
    })()`,
      true
    )
    if (!result || !result.ok)
      throw new BrowserError((result && result.reason) || '点击失败', 'BROWSER_TARGET_NOT_FOUND')
    await delay(150)
    return summarize(tab)
  }

  async function type(tab, args) {
    const target = targetScript(args)
    const value = JSON.stringify(String(args.text == null ? '' : args.text))
    const result = await tab.webContents.executeJavaScript(
      `(() => {
      const el = ${target};
      if (!el) return { ok: false, reason: '未找到目标元素' };
      if (el.disabled || el.readOnly) return { ok: false, reason: '目标元素不可编辑' };
      el.focus();
      if (el.isContentEditable) {
        el.textContent = ${value};
      } else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, ${value});
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (${args.submit === true}) {
        const form = el.closest && el.closest('form');
        if (form && form.requestSubmit) form.requestSubmit();
      }
      return { ok: true };
    })()`,
      true
    )
    if (!result || !result.ok)
      throw new BrowserError((result && result.reason) || '输入失败', 'BROWSER_TARGET_NOT_FOUND')
    await delay(100)
    return summarize(tab)
  }

  async function wait(tab, args) {
    const timeoutMs = Math.max(100, Math.min(30000, Number(args.timeoutMs) || 10000))
    if (args.ms != null) {
      await delay(Math.max(0, Math.min(30000, Number(args.ms) || 0)))
      return summarize(tab)
    }
    const target = targetScript(args)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = await tab.webContents.executeJavaScript(`!!(${target})`)
      if (found) return summarize(tab)
      await delay(150)
    }
    throw new BrowserError('等待页面元素超时', 'BROWSER_NAVIGATION_TIMEOUT')
  }

  async function scroll(tab, args) {
    const x = Number(args.x) || 0
    const y = Number(args.y) || 0
    await tab.webContents.executeJavaScript(`window.scrollBy(${x}, ${y})`)
    return summarize(tab)
  }

  async function dispatchInput(input = {}) {
    const tab = tabs.get(attachedTabId)
    if (!tab || tab.kind !== 'user' || tab.destroyed || tab.crashed) {
      throw new BrowserError('当前没有可见的用户浏览器标签', 'BROWSER_VIEW_UNAVAILABLE')
    }
    assertManualAccess(tab)
    closeDevTools(tab)
    const debuggerApi = tab.webContents.debugger
    if (!debuggerApi || typeof debuggerApi.sendCommand !== 'function') {
      throw new BrowserError('当前浏览器视图不支持 CDP 输入', 'BROWSER_VIEW_UNAVAILABLE')
    }
    const attachedHere = !debuggerApi.isAttached()
    if (attachedHere) debuggerApi.attach('1.3')
    const sendCommand = async (method, params) => {
      let timer
      try {
        return await Promise.race([
          debuggerApi.sendCommand(method, params),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new BrowserError('浏览器输入超时', 'BROWSER_INPUT_TIMEOUT')),
              10000
            )
          })
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      if (['keyDown', 'keyUp', 'char', 'insertText'].includes(input.type)) {
        const focus = await tab.webContents.executeJavaScript(`(() => {
          const element = document.activeElement;
          if (!element) return { blocked: true };
          const type = String(element.getAttribute('type') || '').toLowerCase();
          return { blocked: type === 'password' };
        })()`)
        if (!focus || focus.blocked !== false) {
          throw new BrowserError('禁止向密码控件输入', 'BROWSER_PASSWORD_PROTECTED')
        }
      }
      if (['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(input.type)) {
        await sendCommand('Input.dispatchMouseEvent', {
          type: input.type,
          x: Number(input.x) || 0,
          y: Number(input.y) || 0,
          button: input.button || 'none',
          clickCount: Number(input.clickCount) || 0,
          ...(input.type === 'mouseWheel'
            ? { deltaX: Number(input.deltaX) || 0, deltaY: Number(input.deltaY) || 0 }
            : {})
        })
      } else if (['keyDown', 'keyUp'].includes(input.type)) {
        await sendCommand('Input.dispatchKeyEvent', {
          type: input.type,
          key: input.key || '',
          code: input.code || ''
        })
      } else if (input.type === 'char') {
        await sendCommand('Input.dispatchKeyEvent', {
          type: 'char',
          key: input.key || '',
          text: input.text || ''
        })
      } else if (input.type === 'insertText') {
        await sendCommand('Input.insertText', { text: input.text || '' })
      } else {
        throw new BrowserError('不支持的 CDP 输入类型', 'BROWSER_INVALID_TARGET')
      }
      return { ok: true }
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach()
    }
  }

  async function screenshot(tabId) {
    const tab = requireTab(tabId)
    const image = await tab.webContents.capturePage()
    const size = image.getSize()
    fs.mkdirSync(artifactDir, { recursive: true })
    const file = path.join(artifactDir, `browser-${now()}-${tab.id}.png`)
    fs.writeFileSync(file, image.toPNG())
    return { path: file, width: size.width, height: size.height }
  }

  async function clearData() {
    detach()
    for (const tab of [...tabs.values()]) closeTab(tab.id)
    for (const partition of [...configuredSessions.keys()]) removeSessionHandlers(partition)
    await electronApi.session.fromPartition(USER_PARTITION).clearStorageData()
    emitState('state')
    return true
  }

  function shutdown() {
    detach()
    for (const tab of [...tabs.values()]) closeTab(tab.id)
    for (const partition of [...configuredSessions.keys()]) removeSessionHandlers(partition)
    runTabs.clear()
    try {
      electronApi.session.fromPartition(USER_PARTITION).flushStorageData()
    } catch {
      // 非 Electron 测试环境或会话尚未创建时无需刷新
    }
  }

  function setEnabled(value) {
    enabled = value === true
    if (!enabled) shutdown()
    emitState('state')
    return getState()
  }

  return {
    getState,
    setEnabled,
    open: ({ url, kind = 'user', runId = null } = {}) => summarize(openTab({ url, kind, runId })),
    navigate: async (tabId, url) => {
      const tab = requireTab(tabId)
      assertManualAccess(tab)
      return navigateTab(tab, url)
    },
    activate: activateTab,
    close: closeTab,
    command: commandTab,
    toggleDevTools,
    toggleFocusedDevTools,
    selectElement,
    cancelElementSelection: cancelElementSelectionById,
    inspectorState,
    updateElementStyles,
    resetElementStyles,
    setDevice,
    clearDevice: clearDeviceById,
    attach: attachTab,
    detach,
    takeover,
    release,
    dispatchInput,
    screenshot,
    clearData,
    shutdown,
    getBounds: (tabId) => requireTab(tabId).view.getBounds(),
    forRun(runId) {
      const id = String(runId)
      return {
        navigate: (args = {}) =>
          navigateTab(resolveRunTab(id, args.tabId, { create: true }), args.url),
        snapshot: async (args = {}) => snapshot(resolveRunTab(id, args.tabId), args.maxChars),
        click: async (args = {}) => click(resolveRunTab(id, args.tabId), args),
        type: async (args = {}) => type(resolveRunTab(id, args.tabId), args),
        wait: async (args = {}) => wait(resolveRunTab(id, args.tabId), args),
        scroll: async (args = {}) => scroll(resolveRunTab(id, args.tabId), args),
        screenshot: async (args = {}) => screenshot(resolveRunTab(id, args.tabId).id),
        tabs: () =>
          [...tabs.values()]
            .filter((tab) => tab.kind === 'agent' && tab.runId === id)
            .map(summarize),
        close: (args = {}) => {
          const tabId = args.tabId || runTabs.get(id)
          return tabId ? closeTab(tabId) : null
        },
        closeRun: () => {
          for (const tab of [...tabs.values()]) {
            if (tab.kind === 'agent' && tab.runId === id) closeTab(tab.id)
          }
          runTabs.delete(id)
        }
      }
    },
    closeRun(runId) {
      const id = String(runId)
      for (const tab of [...tabs.values()]) {
        if (tab.kind === 'agent' && tab.runId === id) closeTab(tab.id)
      }
      runTabs.delete(id)
    }
  }
}

let runtime = null

function initBrowser(options) {
  if (runtime) runtime.shutdown()
  runtime = createBrowserService(options)
  return runtime
}

function getBrowser() {
  return runtime
}

function shutdownBrowser() {
  if (runtime) runtime.shutdown()
  runtime = null
}

module.exports = {
  BrowserError,
  createBrowserService,
  initBrowser,
  getBrowser,
  shutdownBrowser
}
