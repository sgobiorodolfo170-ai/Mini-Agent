const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { processRegistry } = require('../lifecycle')

const REQUEST_TIMEOUT_MS = 10000
const MAX_STDOUT_LINE_BYTES = 1024 * 1024
const MAX_STDERR_TAIL_BYTES = 16 * 1024
const RATE_LIMIT = 30
const RATE_WINDOW_MS = 60000
const INPUT_FIELDS = [
  'type',
  'x',
  'y',
  'button',
  'clickCount',
  'key',
  'code',
  'text',
  'deltaX',
  'deltaY'
]

class ComputerError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ComputerError'
    this.code = code
  }
}

function fail(code, message) {
  throw new ComputerError(message, code)
}

function createComputerService(options = {}) {
  const helperPath = options.helperPath
  const artifactDir =
    options.artifactDir ||
    (options.electronApi && options.electronApi.app && options.electronApi.app.getPath
      ? path.join(options.electronApi.app.getPath('userData'), 'computer-artifacts')
      : null)
  const electronApi = options.electronApi
  const getSetting = options.getSetting || (() => null)
  const browser = options.browser
  const spawnImpl = options.spawnImpl || spawn
  const clock = options.now || Date.now

  let child = null
  let pending = null
  let stdoutBuffer = Buffer.alloc(0)
  let stderrTail = Buffer.alloc(0)
  let stopped = false
  let queue = Promise.resolve()
  let actionTimes = []
  const refs = new Map()

  function timestamp() {
    const value = Number(clock())
    return Number.isFinite(value) ? value : Date.now()
  }

  function ensureEnabled() {
    if (getSetting('computerUseEnabled') !== true) {
      fail('COMPUTER_DISABLED', '电脑操作未启用')
    }
  }

  function ensureActive() {
    ensureEnabled()
    if (stopped) fail('COMPUTER_STOPPED', '电脑操作已停止')
  }

  function enqueue(task) {
    const result = queue.then(task)
    queue = result.catch(() => {})
    return result
  }

  function clearRefs() {
    refs.clear()
  }

  function settlePending(error) {
    if (!pending) return
    const current = pending
    pending = null
    clearTimeout(current.timer)
    if (error) current.reject(error)
    else current.resolve(current.response)
  }

  function killHelper(current) {
    try {
      if (current && typeof current.kill === 'function') current.kill()
    } catch {
      // 进程可能已经退出。
    }
  }

  function detachHelper(current, error, terminate = false) {
    if (child !== current) return
    child = null
    stdoutBuffer = Buffer.alloc(0)
    stderrTail = Buffer.alloc(0)
    clearRefs()
    settlePending(error)
    processRegistry.untrack(current)
    if (terminate) killHelper(current)
  }

  function protocolError(message) {
    return new ComputerError(message, 'COMPUTER_PROTOCOL_ERROR')
  }

  function handleResponse(line) {
    let response
    try {
      response = JSON.parse(line.toString('utf8'))
    } catch {
      settlePending(protocolError('电脑助手返回了无效 JSON'))
      return
    }
    if (
      !response ||
      typeof response !== 'object' ||
      (response.ok !== true && response.ok !== false)
    ) {
      settlePending(protocolError('电脑助手返回了无效响应'))
      return
    }
    if (
      response.ok === false &&
      (!response.error ||
        typeof response.error.code !== 'string' ||
        !response.error.code ||
        typeof response.error.message !== 'string')
    ) {
      settlePending(protocolError('电脑助手返回了无效错误响应'))
      return
    }
    if (!pending) return
    if (response.ok === false) {
      settlePending(new ComputerError(response.error.message, response.error.code))
      return
    }
    pending.response = response
    settlePending()
  }

  function consumeStdout(current, chunk) {
    if (child !== current) return
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let start = 0
    while (start < data.length) {
      const newline = data.indexOf(0x0a, start)
      const end = newline < 0 ? data.length : newline
      let segment = data.subarray(start, end)
      if (segment.length > 0 && segment[segment.length - 1] === 0x0d) {
        segment = segment.subarray(0, segment.length - 1)
      }
      if (stdoutBuffer.length + segment.length > MAX_STDOUT_LINE_BYTES) {
        detachHelper(
          current,
          new ComputerError('电脑助手输出行超过 1MB', 'COMPUTER_PROTOCOL_ERROR'),
          true
        )
        return
      }
      stdoutBuffer = Buffer.concat([stdoutBuffer, segment])
      if (newline < 0) return
      const line = stdoutBuffer
      stdoutBuffer = Buffer.alloc(0)
      if (line.length > 0) handleResponse(line)
      if (child !== current) return
      start = newline + 1
    }
  }

  function startHelper() {
    if (child) return child
    if (stopped) fail('COMPUTER_STOPPED', '电脑操作已停止')
    if (typeof helperPath !== 'string' || !helperPath.trim()) {
      fail('COMPUTER_HELPER_UNAVAILABLE', '电脑助手路径未配置')
    }

    let current
    try {
      current = spawnImpl(helperPath, [], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch {
      fail('COMPUTER_HELPER_START_FAILED', '电脑助手启动失败')
    }
    if (!current || !current.stdin || !current.stdout) {
      killHelper(current)
      fail('COMPUTER_HELPER_START_FAILED', '电脑助手通信管道不可用')
    }

    child = current
    stdoutBuffer = Buffer.alloc(0)
    stderrTail = Buffer.alloc(0)
    current.stdout.on('data', (chunk) => consumeStdout(current, chunk))
    if (current.stderr) {
      // stderr 只保留有限尾部用于进程诊断，不输出请求、按键或输入值。
      current.stderr.on('data', (chunk) => {
        if (child !== current) return
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const tail =
          data.length > MAX_STDERR_TAIL_BYTES ? data.subarray(-MAX_STDERR_TAIL_BYTES) : data
        stderrTail = Buffer.concat([tail, stderrTail]).subarray(-MAX_STDERR_TAIL_BYTES)
      })
    }
    current.on('error', () => {
      detachHelper(
        current,
        new ComputerError('电脑助手进程错误', 'COMPUTER_HELPER_START_FAILED'),
        true
      )
    })
    current.on('exit', (code) => {
      detachHelper(
        current,
        new ComputerError(`电脑助手已退出（code=${code}）`, 'COMPUTER_HELPER_EXITED')
      )
    })
    current.on('close', (code) => {
      detachHelper(
        current,
        new ComputerError(`电脑助手已退出（code=${code}）`, 'COMPUTER_HELPER_EXITED')
      )
    })
    if (typeof current.stdin.on === 'function') {
      current.stdin.on('error', () => {
        detachHelper(current, new ComputerError('电脑助手写入失败', 'COMPUTER_WRITE_FAILED'), true)
      })
    }
    processRegistry.track(current)
    return current
  }

  function requestNative(command, args = {}) {
    const current = startHelper()
    return new Promise((resolve, reject) => {
      const item = { child: current, resolve, reject, timer: null, response: null }
      pending = item
      item.timer = setTimeout(() => {
        if (pending !== item) return
        detachHelper(
          current,
          new ComputerError('电脑助手请求超时（10s）', 'COMPUTER_TIMEOUT'),
          true
        )
      }, REQUEST_TIMEOUT_MS)
      if (item.timer.unref) item.timer.unref()

      try {
        current.stdin.write(`${JSON.stringify({ command, ...args })}\n`, (error) => {
          if (error && pending === item) {
            detachHelper(
              current,
              new ComputerError('电脑助手写入失败', 'COMPUTER_WRITE_FAILED'),
              true
            )
          }
        })
      } catch {
        detachHelper(current, new ComputerError('电脑助手写入失败', 'COMPUTER_WRITE_FAILED'), true)
      }
    })
  }

  function consumeRateLimit() {
    const at = timestamp()
    actionTimes = actionTimes.filter((time) => at - time < RATE_WINDOW_MS)
    if (actionTimes.length >= RATE_LIMIT) {
      fail('COMPUTER_RATE_LIMITED', '电脑操作超过每分钟 30 次限制')
    }
    actionTimes.push(at)
  }

  function normalizeSelector(args) {
    if (!args || typeof args !== 'object') fail('COMPUTER_INVALID_REQUEST', '快照参数无效')
    const selectors = ['windowRef', 'processId', 'name'].filter(
      (key) => args[key] !== undefined && args[key] !== null
    )
    if (selectors.length !== 1) {
      fail('COMPUTER_INVALID_REQUEST', '快照必须且只能指定 windowRef、processId 或 name')
    }
    const key = selectors[0]
    const value = args[key]
    if (key === 'processId') {
      if (!Number.isInteger(value) || value <= 0) {
        fail('COMPUTER_INVALID_REQUEST', 'processId 必须是正整数')
      }
    } else if (typeof value !== 'string' || !value.trim()) {
      fail('COMPUTER_INVALID_REQUEST', `${key} 必须是非空字符串`)
    }
    const selector = { [key]: value }
    if (args.maxNodes !== undefined && args.maxNodes !== null) {
      if (!Number.isInteger(args.maxNodes) || args.maxNodes <= 0) {
        fail('COMPUTER_INVALID_REQUEST', 'maxNodes 必须是正整数')
      }
      selector.maxNodes = args.maxNodes
    }
    return selector
  }

  function findSnapshotWindow(windows, selector) {
    const window = windows.find((entry) => {
      if (selector.windowRef !== undefined) return entry.ref === selector.windowRef
      if (selector.processId !== undefined) return Number(entry.processId) === selector.processId
      return entry.name === selector.name
    })
    if (!window) fail('COMPUTER_WINDOW_NOT_FOUND', '快照目标窗口不存在')
    if (!Number.isInteger(Number(window.processId)) || Number(window.processId) <= 0) {
      throw protocolError('电脑助手返回了无效窗口 processId')
    }
    if (!Number.isFinite(Number(window.handle))) {
      throw protocolError('电脑助手返回了无效窗口 handle')
    }
    return window
  }

  function listWindows() {
    ensureActive()
    return enqueue(async () => {
      ensureActive()
      const response = await requestNative('list_windows')
      if (!Array.isArray(response.windows)) {
        throw protocolError('电脑助手返回了无效窗口列表')
      }
      return response.windows
    })
  }

  function snapshot(args = {}) {
    ensureActive()
    return enqueue(async () => {
      ensureActive()
      const selector = normalizeSelector(args)
      const listing = await requestNative('list_windows')
      if (!Array.isArray(listing.windows)) {
        throw protocolError('电脑助手返回了无效窗口列表')
      }
      const window = findSnapshotWindow(listing.windows, selector)
      const response = await requestNative('snapshot', selector)
      if (!Array.isArray(response.elements)) {
        throw protocolError('电脑助手返回了无效快照')
      }
      clearRefs()
      for (const element of response.elements) {
        if (!element || typeof element.ref !== 'string') continue
        refs.set(element.ref, {
          processId: Number(window.processId),
          handle: Number(window.handle),
          windowRef: window.ref,
          name: element.name,
          automationId: element.automationId,
          controlType: element.controlType,
          isPassword: element.isPassword === true
        })
      }
      return response
    })
  }

  function foreground() {
    ensureActive()
    return enqueue(async () => {
      ensureActive()
      return requestNative('foreground')
    })
  }

  function requireRef(value) {
    const ref = typeof value === 'string' ? value : value && value.ref
    if (typeof ref !== 'string' || !ref) fail('COMPUTER_INVALID_REQUEST', 'ref 必须是非空字符串')
    const metadata = refs.get(ref)
    if (!metadata) fail('COMPUTER_UNKNOWN_REF', 'ref 未知或已失效，请重新快照')
    return { ref, metadata }
  }

  async function assertRefForeground(metadata) {
    const current = await requestNative('foreground')
    if (
      !Number.isInteger(Number(current.processId)) ||
      !Number.isFinite(Number(current.handle)) ||
      Number(current.processId) !== metadata.processId ||
      Number(current.handle) !== metadata.handle
    ) {
      fail('COMPUTER_FOREGROUND_MISMATCH', '目标窗口已不在前台')
    }
  }

  function invoke(args) {
    ensureActive()
    return enqueue(async () => {
      ensureActive()
      const { ref, metadata } = requireRef(args)
      consumeRateLimit()
      await assertRefForeground(metadata)
      return requestNative('invoke', { ref })
    })
  }

  function setValue(args, explicitValue) {
    ensureActive()
    return enqueue(async () => {
      ensureActive()
      const value = explicitValue !== undefined ? explicitValue : args && args.value
      if (typeof value !== 'string') fail('COMPUTER_INVALID_REQUEST', 'value 必须是字符串')
      const { ref, metadata } = requireRef(args)
      if (metadata.isPassword) {
        fail('COMPUTER_PASSWORD_PROTECTED', '禁止向密码控件输入值')
      }
      consumeRateLimit()
      await assertRefForeground(metadata)
      return requestNative('set_value', { ref, value })
    })
  }

  function key(args) {
    ensureActive()
    return enqueue(async () => {
      ensureActive()
      const keys = args && args.keys
      const processId = args && args.processId
      if (typeof keys !== 'string' || !keys) {
        fail('COMPUTER_INVALID_REQUEST', 'keys 必须是非空字符串')
      }
      if (!Number.isInteger(processId) || processId <= 0) {
        fail('COMPUTER_INVALID_REQUEST', 'key 操作必须提供正整数 processId')
      }
      consumeRateLimit()
      const current = await requestNative('foreground')
      if (!Number.isInteger(Number(current.processId)) || Number(current.processId) !== processId) {
        fail('COMPUTER_FOREGROUND_MISMATCH', '目标进程窗口已不在前台')
      }
      if (current.focusedIsPassword === true) {
        fail('COMPUTER_PASSWORD_PROTECTED', '禁止向密码控件发送按键')
      }
      // 原生层再次核对前台进程，收敛 Node/UIA 之间的时间窗。
      return requestNative('key', { keys, processId })
    })
  }

  function normalizeBrowserInput(args, options) {
    if (!args || typeof args !== 'object') fail('COMPUTER_INVALID_REQUEST', '输入参数无效')
    const backend = (options && options.backend) || args.backend || 'browser'
    if (backend !== 'browser') fail('COMPUTER_UNSUPPORTED_BACKEND', '不支持的输入后端')
    if (typeof args.type !== 'string' || !args.type) {
      fail('COMPUTER_INVALID_REQUEST', 'type 必须是非空字符串')
    }
    const input = { type: args.type }
    for (const field of INPUT_FIELDS.slice(1)) {
      if (args[field] !== undefined) input[field] = args[field]
    }
    for (const field of ['x', 'y', 'deltaX', 'deltaY']) {
      if (input[field] !== undefined && !Number.isFinite(input[field])) {
        fail('COMPUTER_INVALID_REQUEST', `${field} 必须是有限数字`)
      }
    }
    if (
      input.clickCount !== undefined &&
      (!Number.isInteger(input.clickCount) || input.clickCount <= 0)
    ) {
      fail('COMPUTER_INVALID_REQUEST', 'clickCount 必须是正整数')
    }
    for (const field of ['button', 'key', 'code', 'text']) {
      if (input[field] !== undefined && typeof input[field] !== 'string') {
        fail('COMPUTER_INVALID_REQUEST', `${field} 必须是字符串`)
      }
    }
    return input
  }

  function assertVisibleUserTab() {
    if (!browser || typeof browser.dispatchInput !== 'function') {
      fail('COMPUTER_BROWSER_INPUT_UNAVAILABLE', '浏览器输入后端不可用')
    }
    const state = typeof browser.getState === 'function' ? browser.getState() : null
    const tabId = state && state.attachedTabId
    const tab =
      state && Array.isArray(state.tabs) ? state.tabs.find((item) => item.id === tabId) : null
    if (!tabId || !tab || tab.kind !== 'user' || tab.destroyed || tab.crashed) {
      fail('COMPUTER_BROWSER_TAB_NOT_VISIBLE', '浏览器没有当前可见的用户标签')
    }
    const view = tab.view
    const visible =
      view && typeof view.getVisible === 'function'
        ? view.getVisible()
        : view && typeof view.visible === 'boolean'
          ? view.visible
          : tab.visible
    if (visible === false) {
      fail('COMPUTER_BROWSER_TAB_NOT_VISIBLE', '浏览器用户标签当前不可见')
    }
  }

  function input(args = {}, options = {}) {
    ensureActive()
    return enqueue(async () => {
      ensureActive()
      const payload = normalizeBrowserInput(args, options)
      consumeRateLimit()
      assertVisibleUserTab()
      return browser.dispatchInput(payload)
    })
  }

  async function captureScreen() {
    ensureActive()
    if (!electronApi || !electronApi.desktopCapturer) {
      fail('COMPUTER_CAPTURE_UNAVAILABLE', '屏幕捕获不可用')
    }
    const sourceOptions = { types: ['screen'] }
    if (electronApi.screen && typeof electronApi.screen.getPrimaryDisplay === 'function') {
      const display = electronApi.screen.getPrimaryDisplay()
      const scale = display.scaleFactor || 1
      sourceOptions.thumbnailSize = {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale)
      }
    }
    const sources = await electronApi.desktopCapturer.getSources(sourceOptions)
    ensureActive()
    const source =
      (Array.isArray(sources) &&
        sources.find(
          (item) =>
            item.thumbnail &&
            (typeof item.thumbnail.isEmpty !== 'function' || !item.thumbnail.isEmpty())
        )) ||
      (Array.isArray(sources) && sources[0])
    if (!source || !source.thumbnail) fail('COMPUTER_CAPTURE_UNAVAILABLE', '无可用屏幕源')
    const size = source.thumbnail.getSize()
    const png = source.thumbnail.toPNG()
    if (!size || size.width <= 0 || size.height <= 0 || !png || !png.length) {
      fail('COMPUTER_CAPTURE_FAILED', '屏幕截图无效')
    }
    if (typeof artifactDir !== 'string' || !artifactDir) {
      fail('COMPUTER_CAPTURE_UNAVAILABLE', '截图保存目录未配置')
    }
    ensureActive()
    fs.mkdirSync(artifactDir, { recursive: true })
    const file = path.join(
      artifactDir,
      `computer-${Math.trunc(timestamp())}-${crypto.randomUUID()}.png`
    )
    fs.writeFileSync(file, png)
    return { path: file, width: size.width, height: size.height }
  }

  function capture() {
    ensureActive()
    return captureScreen()
  }

  function stop() {
    if (stopped) return true
    stopped = true
    actionTimes = []
    clearRefs()
    const current = child
    child = null
    stdoutBuffer = Buffer.alloc(0)
    stderrTail = Buffer.alloc(0)
    settlePending(new ComputerError('电脑操作已停止', 'COMPUTER_STOPPED'))
    if (current) {
      processRegistry.untrack(current)
      try {
        if (current.stdin && !current.stdin.destroyed && !current.stdin.writableEnded) {
          current.stdin.end()
        }
      } catch {
        // EOF 失败不影响强制终止。
      }
      killHelper(current)
    }
    return true
  }

  return {
    listWindows,
    snapshot,
    foreground,
    invoke,
    setValue,
    key,
    input,
    capture,
    stop
  }
}

module.exports = { ComputerError, createComputerService }
