import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createBrowserService } from '../../electron/main/browser/service'

class FakeWebContents extends EventEmitter {
  constructor(url = 'about:blank') {
    super()
    this.url = url
    this.destroyed = false
    this.loads = []
    this.commands = []
    this.loadError = ''
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

  close() {
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
