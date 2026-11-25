import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createBrowserService } from '../../electron/main/browser/service'

class FakeWebContents extends EventEmitter {
  constructor(url = 'about:blank') {
    super()
    this.url = url
    this.destroyed = false
    this.loads = []
    this.commands = []
    this.loadError = ''
    this.devToolsOpened = false
    this.devToolsFocused = false
    this.devToolsOptions = []
    this.devToolsWebContents = null
    this.pickerResult = null
    this.installGate = null
    this.selectedGate = null
    this.styleGate = null
    this.styleResult = undefined
    this.selectedInfo = null
    this.focusBlocked = false
    this.zoomFactor = 1
    this.zoomHistory = []
    this.debugger = {
      attached: false,
      commands: [],
      isAttached() {
        return this.attached
      },
      attach(version) {
        this.attached = true
        this.version = version
      },
      detach() {
        this.attached = false
      },
      async sendCommand(method, params) {
        this.commands.push({ method, params })
        return {}
      }
    }
  }

  isDestroyed() {
    return this.destroyed
  }

  getURL() {
    return this.url
  }

  async loadURL(url) {
    this.loads.push(url)
    this.url = url
    this.emit('did-start-loading')
    if (this.loadError) {
      this.emit('did-fail-load', {}, -105, this.loadError, url, true)
      this.emit('did-stop-loading')
      throw Object.assign(new Error(this.loadError), { code: -105 })
    }
    this.emit('did-navigate', {}, url)
    this.emit('did-stop-loading')
  }

  setWindowOpenHandler(handler) {
    this.openHandler = handler
  }

  setUserAgent(agent) {
    this.userAgent = agent
  }

  async executeJavaScript(code) {
    if (code.includes('function installController')) {
      if (this.installGate) await this.installGate
      return true
    }
    if (code.includes('.arm(')) return true
    if (code.includes('.wait()')) return this.pickerResult || { cancelled: true, reason: 'timeout' }
    if (code.includes('controller.setStyles') || code.includes('controller.resetStyles')) {
      if (this.styleGate) await this.styleGate
      return this.styleResult ?? { stale: true }
    }
    if (code.includes('controller.getSelected')) {
      if (this.selectedGate) await this.selectedGate
      return this.selectedInfo
    }
    if (code.includes('document.activeElement')) return { blocked: this.focusBlocked }
    if (code.includes('document.title')) {
      return {
        title: '测试页面',
        url: this.url,
        text: '页面正文',
        elements: [{ ref: 1, tag: 'button', text: '提交', disabled: false }]
      }
    }
    if (code.includes('el.click()') || code.includes('setter.call')) return { ok: true }
    if (code.trim().startsWith('!!(')) return true
    return true
  }

  goBack() {
    this.commands.push('back')
  }

  goForward() {
    this.commands.push('forward')
  }

  reload() {
    this.commands.push('reload')
  }

  stop() {
    this.commands.push('stop')
  }

  openDevTools(options) {
    this.devToolsOpened = true
    this.devToolsOptions.push(options)
    this.devToolsWebContents = new EventEmitter()
    this.devToolsWebContents.isDestroyed = () => false
    this.emit('devtools-opened')
  }

  closeDevTools() {
    if (!this.devToolsOpened) return
    this.devToolsOpened = false
    this.devToolsWebContents = null
    this.devToolsFocused = false
    this.emit('devtools-closed')
  }

  isDevToolsOpened() {
    return this.devToolsOpened
  }

  isDevToolsFocused() {
    return this.devToolsFocused
  }

  getZoomFactor() {
    return this.zoomFactor
  }

  setZoomFactor(value) {
    this.zoomFactor = value
    this.zoomHistory.push(value)
  }

  close() {
    this.closeDevTools()
    this.destroyed = true
    this.emit('destroyed')
  }

  destroy() {
    this.close()
  }
}

class FakeView {
  constructor(options = {}) {
    this.webContents = options.webContents || new FakeWebContents()
    this.visible = false
    this.bounds = { x: 0, y: 0, width: 0, height: 0 }
  }

  setBackgroundColor() {}
  setVisible(value) {
    this.visible = value
  }
  setBounds(value) {
    this.bounds = value
  }
  getBounds() {
    return this.bounds
  }
}

class FakeSession extends EventEmitter {
  constructor() {
    super()
    this.permissionRequest = null
    this.permissionCheck = null
    this.webRequest = new EventEmitter()
    this.webRequest.onBeforeRequest = (handler) => this.webRequest.on('before-request', handler)
  }

  setPermissionRequestHandler(handler) {
    this.permissionRequest = handler
  }

  setPermissionCheckHandler(handler) {
    this.permissionCheck = handler
  }

  async clearStorageData() {}
  async resolveHost() {
    return { endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] }
  }
  flushStorageData() {}
}

function harness({ allowPrivateNetwork = true } = {}) {
  const sessions = new Map()
  const children = []
  const mainWindow = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    contentView: {
      addChildView(view) {
        const index = children.indexOf(view)
        if (index >= 0) children.splice(index, 1)
        children.push(view)
      },
      removeChildView(view) {
        const index = children.indexOf(view)
        if (index >= 0) children.splice(index, 1)
      }
    }
  }
  const electronApi = {
    WebContentsView: FakeView,
    session: {
      fromPartition(partition) {
        if (!sessions.has(partition)) sessions.set(partition, new FakeSession())
        return sessions.get(partition)
      }
    },
    app: { getPath: () => process.cwd() }
  }
  const service = createBrowserService({
    electronApi,
    getMainWindow: () => mainWindow,
    getSetting: (key) => (key === 'browserAllowPrivateNetwork' ? allowPrivateNetwork : null),
    emit: () => {},
    downloadDir: process.cwd(),
    artifactDir: process.cwd()
  })
  return { service, children, sessions }
}

function emitKey(webContents, input) {
  let prevented = false
  webContents.emit(
    'before-input-event',
    {
      preventDefault() {
        prevented = true
      }
    },
    input
  )
  return prevented
}

describe('browser service', () => {
  it('opens, attaches, navigates and closes visible user tabs', async () => {
    const { service, children } = harness()
    const tab = service.open({ url: 'about:blank', kind: 'user' })
    expect(service.getState().tabs).toHaveLength(1)
    expect(children).toHaveLength(1)

    service.attach(tab.id, { x: 80, y: 120, width: 900, height: 600 })
    expect(children[0].visible).toBe(true)
    expect(children[0].bounds).toEqual({ x: 80, y: 120, width: 900, height: 600 })

    await service.navigate(tab.id, 'https://example.com/')
    expect(children[0].webContents.loads).toContain('https://example.com/')
    expect(service.getState().tabs[0].url).toBe('https://example.com/')

    service.detach()
    expect(children[0].visible).toBe(false)
    service.close(tab.id)
    expect(service.getState().tabs).toHaveLength(0)
    expect(children).toHaveLength(0)
  })

  it('follows an intercepted HTTP redirect without surfacing ERR_FAILED', async () => {
    const { service, children } = harness()
    const tab = service.open({ url: 'about:blank' })
    const wc = children[0].webContents
    let rejectRedirect
    wc.loadURL = async (url) => {
      wc.loads.push(url)
      wc.url = url
      wc.emit('did-start-loading')
      if (url === 'https://redirect.example/') {
        const pending = new Promise((_, reject) => {
          rejectRedirect = reject
        })
        let prevented = false
        wc.emit(
          'will-redirect',
          {
            preventDefault() {
              prevented = true
            }
          },
          'https://final.example/'
        )
        expect(prevented).toBe(true)
        setTimeout(() => {
          wc.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'https://final.example/', true)
          rejectRedirect(Object.assign(new Error('ERR_FAILED (-2)'), { code: -2 }))
        }, 0)
        return pending
      }
      wc.emit('did-navigate', {}, url)
      wc.emit('did-stop-loading')
    }

    await service.navigate(tab.id, 'https://redirect.example/')
    await vi.waitFor(() => {
      const current = service.getState().tabs[0]
      expect(current.url).toBe('https://final.example/')
      expect(current.loading).toBe(false)
      expect(current.error).toBe(null)
    })
    expect(wc.loads).toEqual(['https://redirect.example/', 'https://final.example/'])
  })

  it('cancels a slow navigation when a newer URL is submitted', async () => {
    const { service, children } = harness()
    const tab = service.open({ url: 'about:blank' })
    const wc = children[0].webContents
    let rejectSlow
    wc.loadURL = (url) => {
      wc.loads.push(url)
      wc.url = url
      wc.emit('did-start-loading')
      if (url === 'https://slow.example/') {
        return new Promise((_, reject) => {
          rejectSlow = reject
        })
      }
      wc.emit('did-navigate', {}, url)
      wc.emit('did-stop-loading')
      return Promise.resolve()
    }
    wc.stop = () => {
      wc.commands.push('stop')
      rejectSlow?.(Object.assign(new Error('ERR_ABORTED (-3)'), { code: -3 }))
    }

    const first = service.navigate(tab.id, 'https://slow.example/').catch(() => null)
    await vi.waitFor(() => expect(wc.loads).toContain('https://slow.example/'))
    const second = service.navigate(tab.id, 'https://fast.example/')
    let outcome
    try {
      outcome = await Promise.race([
        second.then(() => 'loaded'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 50))
      ])
    } finally {
      rejectSlow?.(Object.assign(new Error('ERR_ABORTED (-3)'), { code: -3 }))
    }
    await first
    await second

    expect(outcome).toBe('loaded')
    expect(wc.commands).toContain('stop')
    expect(service.getState().tabs[0]).toMatchObject({
      url: 'https://fast.example/',
      loading: false,
      error: null
    })
  })

  it('toggles detached native DevTools with F12 and the focused menu command', () => {
    const { service, children } = harness()
    const tab = service.open({ kind: 'user' })
    const wc = children[0].webContents

    expect(emitKey(wc, { type: 'keyUp', key: 'F12' })).toBe(false)
    expect(emitKey(wc, { type: 'keyDown', key: 'F12', isAutoRepeat: true })).toBe(false)
    expect(wc.isDevToolsOpened()).toBe(false)

    expect(emitKey(wc, { type: 'keyDown', key: 'F12' })).toBe(true)
    expect(wc.isDevToolsOpened()).toBe(true)
    expect(wc.devToolsOptions).toEqual([{ mode: 'detach', title: 'Mini Agent 开发者工具' }])
    expect(service.getState().tabs[0].devToolsOpened).toBe(true)

    wc.devToolsFocused = true
    expect(service.toggleFocusedDevTools()).toMatchObject({ id: tab.id })
    expect(wc.isDevToolsOpened()).toBe(false)
    expect(service.getState().tabs[0].devToolsOpened).toBe(false)

    service.toggleDevTools(tab.id)
    expect(wc.isDevToolsOpened()).toBe(true)
    expect(service.toggleFocusedDevTools()).toBe(null)
    service.toggleDevTools(tab.id)
    expect(wc.isDevToolsOpened()).toBe(false)
  })

  it('selects an element and applies validated style updates', async () => {
    const { service, children } = harness()
    const tab = service.open({ kind: 'user' })
    const wc = children[0].webContents
    const selected = {
      elementId: 'el-test-123',
      tagName: 'button',
      id: 'go',
      className: 'primary',
      selector: '#go',
      text: '提交',
      html: '<button id="go">提交</button>',
      href: '',
      url: 'https://example.com/',
      title: 'Example',
      rect: { x: 10, y: 20, width: 80, height: 32 },
      styles: { width: '80px', display: 'inline-block' },
      customStyles: {}
    }
    wc.pickerResult = { selected }
    expect(await service.selectElement(tab.id)).toEqual({ cancelled: false, selected })

    wc.selectedInfo = selected
    expect(await service.inspectorState(tab.id)).toEqual({ selecting: false, selected })
    wc.styleResult = {
      ...selected,
      styles: { ...selected.styles, width: '240px' },
      customStyles: { width: '240px' }
    }
    expect(
      await service.updateElementStyles(tab.id, selected.elementId, { width: '240px' })
    ).toMatchObject({ customStyles: { width: '240px' } })
    await expect(
      service.updateElementStyles(tab.id, selected.elementId, { width: '1px;color:red' })
    ).rejects.toThrow(/不安全/)
    await expect(
      service.updateElementStyles(tab.id, selected.elementId, { unknown: '1px' })
    ).rejects.toThrow(/不支持/)

    wc.styleResult = undefined
    await expect(
      service.updateElementStyles(tab.id, selected.elementId, { width: '300px' })
    ).rejects.toMatchObject({ code: 'BROWSER_ELEMENT_STALE' })
  })

  it('discards a selection result when cancelled during controller installation', async () => {
    const { service, children } = harness()
    const tab = service.open({ kind: 'user' })
    const wc = children[0].webContents
    let release
    wc.installGate = new Promise((resolve) => {
      release = resolve
    })
    const pending = service.selectElement(tab.id)
    await Promise.resolve()
    await service.cancelElementSelection(tab.id)
    release()

    expect(await pending).toEqual({ cancelled: true, reason: 'replaced', selected: null })
    expect(await service.inspectorState(tab.id)).toEqual({ selecting: false, selected: null })
  })

  it('discards an in-flight inspector result after a newer selection', async () => {
    const { service, children } = harness()
    const tab = service.open({ kind: 'user' })
    const wc = children[0].webContents
    const first = {
      elementId: 'el-first-123',
      tagName: 'button',
      selector: '#first',
      rect: {},
      styles: {},
      customStyles: {}
    }
    const second = { ...first, elementId: 'el-second-123', selector: '#second' }
    wc.pickerResult = { selected: first }
    await service.selectElement(tab.id)

    let release
    wc.styleGate = new Promise((resolve) => {
      release = resolve
    })
    wc.styleResult = { ...first, customStyles: { width: '240px' } }
    const update = service.updateElementStyles(tab.id, first.elementId, { width: '240px' })
    await Promise.resolve()
    wc.pickerResult = { selected: second }
    await service.selectElement(tab.id)
    release()

    await expect(update).rejects.toMatchObject({ code: 'BROWSER_ELEMENT_STALE' })
    wc.selectedInfo = second
    expect(await service.inspectorState(tab.id)).toMatchObject({ selected: second })
  })

  it('dispatches CDP mouse and keyboard input only to the visible user tab', async () => {
    const { service, children } = harness()
    const tab = service.open({ kind: 'user' })
    service.attach(tab.id, { x: 0, y: 0, width: 800, height: 600 })
    const debuggerApi = children[0].webContents.debugger

    await service.dispatchInput({
      type: 'mousePressed',
      x: 10,
      y: 20,
      button: 'left',
      clickCount: 1
    })
    await service.dispatchInput({ type: 'keyDown', key: 'a', code: 'KeyA' })
    await service.dispatchInput({ type: 'insertText', text: 'hello' })
    expect(debuggerApi.commands).toEqual([
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 }
      },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'a', code: 'KeyA' } },
      { method: 'Input.insertText', params: { text: 'hello' } }
    ])
    expect(debuggerApi.isAttached()).toBe(false)

    children[0].webContents.focusBlocked = true
    await expect(
      service.dispatchInput({ type: 'insertText', text: 'secret' })
    ).rejects.toMatchObject({
      code: 'BROWSER_PASSWORD_PROTECTED'
    })
    await expect(
      service.dispatchInput({ type: 'keyDown', key: 'a', code: 'KeyA' })
    ).rejects.toMatchObject({ code: 'BROWSER_PASSWORD_PROTECTED' })
    expect(debuggerApi.commands).toHaveLength(3)

    children[0].webContents.focusBlocked = false
    const agent = service.forRun('run-input')
    await agent.navigate({ url: 'https://agent.example/' })
    service.attach(agent.tabs()[0].id, { x: 0, y: 0, width: 800, height: 600 })
    await expect(service.dispatchInput({ type: 'insertText', text: 'no' })).rejects.toMatchObject({
      code: 'BROWSER_VIEW_UNAVAILABLE'
    })
  })

  it('times out stuck CDP input and detaches the debugger', async () => {
    vi.useFakeTimers()
    try {
      const { service, children } = harness()
      const tab = service.open({ kind: 'user' })
      service.attach(tab.id, { x: 0, y: 0, width: 800, height: 600 })
      const debuggerApi = children[0].webContents.debugger
      debuggerApi.sendCommand = () => new Promise(() => {})
      const rejection = expect(
        service.dispatchInput({ type: 'mouseMoved', x: 1, y: 2 })
      ).rejects.toMatchObject({ code: 'BROWSER_INPUT_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(10000)
      await rejection
      expect(debuggerApi.isAttached()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('normalizes device viewports, applies display zoom and restores the original zoom', () => {
    const { service, children } = harness()
    const tab = service.open({ kind: 'user' })
    const wc = children[0].webContents
    wc.zoomFactor = 1.25
    service.attach(tab.id, { x: 0, y: 0, width: 900, height: 600 })

    service.setDevice(tab.id, { width: 99999, height: 100, scale: 200 })
    expect(service.getState().tabs[0].device).toEqual({ width: 3840, height: 240, scale: 100 })
    service.attach(tab.id, { x: 0, y: 0, width: 400, height: 300 }, { displayScale: 0.5 })
    expect(wc.zoomFactor).toBe(0.5)

    service.clearDevice(tab.id)
    expect(service.getState().tabs[0].device).toBe(null)
    expect(wc.zoomFactor).toBe(1.25)
  })

  it('closes DevTools when switching, detaching or closing its tab', () => {
    const { service, children } = harness()
    const first = service.open({ kind: 'user' })
    service.attach(first.id, { x: 0, y: 0, width: 800, height: 600 })
    service.toggleDevTools(first.id)
    const second = service.open({ kind: 'user' })

    service.activate(second.id)
    expect(children[0].webContents.isDevToolsOpened()).toBe(false)
    service.toggleDevTools(second.id)
    expect(children[1].webContents.isDevToolsOpened()).toBe(true)

    service.detach()
    expect(children[1].webContents.isDevToolsOpened()).toBe(false)
    service.toggleDevTools(second.id)
    const secondContents = children[1].webContents
    service.close(second.id)
    expect(secondContents.isDevToolsOpened()).toBe(false)
  })

  it('treats F12 on a locked Agent tab as a human takeover', async () => {
    const { service, children } = harness()
    const agent = service.forRun('run-devtools')
    await agent.navigate({ url: 'https://agent.example/' })
    const tab = agent.tabs()[0]
    const wc = children[0].webContents

    expect(emitKey(wc, { type: 'keyDown', key: 'F12' })).toBe(true)
    expect(service.getState().tabs[0].owner).toBe('user')
    expect(wc.isDevToolsOpened()).toBe(true)
    await expect(agent.snapshot({ tabId: tab.id })).rejects.toMatchObject({
      code: 'BROWSER_TAKEN_OVER'
    })
  })

  it('使用 Chromium DNS 解析器并给出可读的页面加载错误', async () => {
    const { service, children, sessions } = harness()
    const tab = service.open({ url: 'about:blank' })
    children[0].webContents.loadError = 'ERR_NAME_NOT_RESOLVED'
    await expect(service.navigate(tab.id, 'example.com')).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/)
    expect(service.getState().tabs[0].error).toContain('无法解析域名')
    expect(children[0].webContents.userAgent).toContain('Chrome/')
    expect(sessions.get('persist:miniagent-browser').resolveHost).toBeTypeOf('function')
  })

  it('isolates Agent runs and enforces human takeover', async () => {
    const { service, children } = harness()
    const agent = service.forRun('run-1')
    await agent.navigate({ url: 'https://agent.example/' })
    const snapshot = await agent.snapshot()
    expect(JSON.parse(snapshot).untrusted).toBe(true)
    expect(JSON.parse(snapshot).text).toBe('页面正文')
    expect(agent.tabs()).toHaveLength(1)
    await agent.wait({ ms: 1 })
    await agent.scroll({ y: 120 })

    await expect(
      service.forRun('run-2').snapshot({ tabId: agent.tabs()[0].id })
    ).rejects.toMatchObject({
      code: 'BROWSER_RUN_MISMATCH'
    })

    const tab = agent.tabs()[0]
    const wc = children[0].webContents
    let prevented = false
    const mouse = {
      preventDefault() {
        prevented = true
      }
    }
    wc.emit('before-mouse-event', mouse)
    expect(prevented).toBe(true)
    let keyPrevented = false
    wc.emit(
      'before-input-event',
      {
        preventDefault() {
          keyPrevented = true
        }
      },
      { type: 'keyDown', key: 'a' }
    )
    expect(keyPrevented).toBe(true)
    wc.emit(
      'before-input-event',
      {
        preventDefault() {}
      },
      { type: 'keyDown', key: 'Escape' }
    )
    expect(service.getState().tabs[0].owner).toBe('user')

    service.takeover(tab.id)
    expect(service.getState().tabs[0].owner).toBe('user')
    prevented = false
    wc.emit('before-mouse-event', mouse)
    expect(prevented).toBe(false)
    await expect(agent.click({ tabId: tab.id, ref: 1 })).rejects.toMatchObject({
      code: 'BROWSER_TAKEN_OVER'
    })

    service.release(tab.id)
    await expect(agent.click({ tabId: tab.id, ref: 1 })).resolves.toMatchObject({ id: tab.id })
    await expect(agent.click({ tabId: tab.id })).rejects.toMatchObject({
      code: 'BROWSER_INVALID_TARGET'
    })
    await expect(agent.click({ tabId: tab.id, ref: 1, selector: '#go' })).rejects.toMatchObject({
      code: 'BROWSER_INVALID_TARGET'
    })

    agent.closeRun()
    expect(agent.tabs()).toHaveLength(0)
    expect(agent.close()).toBe(null)
    expect(children).toHaveLength(0)
    await expect(agent.snapshot()).rejects.toMatchObject({ code: 'BROWSER_SESSION_EXPIRED' })
  })

  it('keeps shared user session handlers until the last tab closes and enforces the tab limit', () => {
    const { service, sessions } = harness()
    const first = service.open({ kind: 'user' })
    const second = service.open({ kind: 'user' })
    const session = sessions.get('persist:miniagent-browser')
    expect(session.permissionRequest).toBeTypeOf('function')

    service.close(first.id)
    expect(session.permissionRequest).toBeTypeOf('function')
    service.close(second.id)
    expect(session.permissionRequest).toBe(null)

    for (let i = 0; i < 6; i++) service.open({ kind: 'user' })
    expect(() => service.open({ kind: 'user' })).toThrow(/最多/)
  })

  it('marks a crashed renderer and clears the crash state on reload', () => {
    const { service, children } = harness()
    const tab = service.open({ kind: 'user' })
    children[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(service.getState().tabs[0].crashed).toBe(true)
    expect(service.getState().tabs[0].error).toContain('crashed')

    service.command(tab.id, 'reload')
    expect(service.getState().tabs[0].crashed).toBe(false)
    expect(children[0].webContents.commands).toContain('reload')
  })

  it('blocks literal private subresource requests in Agent sessions unless explicitly allowed', async () => {
    const { service, sessions } = harness({ allowPrivateNetwork: false })
    await service.forRun('run-1').navigate({ url: 'about:blank' })
    const webRequest = sessions.get('miniagent-agent-run-1').webRequest
    let response
    webRequest.emit('before-request', { url: 'http://127.0.0.1/admin' }, (value) => {
      response = value
    })
    expect(response).toEqual({ cancel: true })
    webRequest.emit('before-request', { url: 'https://example.com/app.js' }, (value) => {
      response = value
    })
    expect(response).toEqual({})
    expect(service.getState().stats.agentTabCount).toBe(1)
  })

  it('denies downloads from Agent sessions', async () => {
    const { service, children, sessions } = harness()
    await service.forRun('run-1').navigate({ url: 'https://agent.example/' })
    const session = sessions.get('miniagent-agent-run-1')
    let canceled = false
    let savePath = null
    session.emit(
      'will-download',
      {},
      {
        getFilename: () => 'secret.bin',
        setSavePath: (value) => {
          savePath = value
        },
        cancel: () => {
          canceled = true
        }
      },
      children[0].webContents
    )
    expect(canceled).toBe(true)
    expect(savePath).toBe(null)
  })

  it('disabling the feature destroys every tab', async () => {
    const { service, children } = harness()
    service.open({ url: 'about:blank', kind: 'user' })
    await service.forRun('run-1').navigate({ url: 'https://agent.example/' })
    expect(service.getState().tabs).toHaveLength(2)

    service.setEnabled(false)
    expect(service.getState().enabled).toBe(false)
    expect(service.getState().tabs).toHaveLength(0)
    expect(children).toHaveLength(0)
    expect(() => service.open({ kind: 'user' })).toThrow(/停用/)
  })
})
