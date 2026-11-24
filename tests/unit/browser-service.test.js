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
    this.emit('did-navigate', {}, url)
    this.emit('did-stop-loading')
  }

  setWindowOpenHandler(handler) {
    this.openHandler = handler
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
  }

  setPermissionRequestHandler(handler) {
    this.permissionRequest = handler
  }

  setPermissionCheckHandler(handler) {
    this.permissionCheck = handler
  }

  async clearStorageData() {}
}

function harness() {
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
    getSetting: (key) => (key === 'browserAllowPrivateNetwork' ? true : null),
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

  it('isolates Agent runs and enforces human takeover', async () => {
    const { service, children } = harness()
    const agent = service.forRun('run-1')
    await agent.navigate({ url: 'https://agent.example/' })
    const snapshot = await agent.snapshot()
    expect(JSON.parse(snapshot).untrusted).toBe(true)
    expect(JSON.parse(snapshot).text).toBe('页面正文')
    expect(agent.tabs()).toHaveLength(1)

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

    agent.closeRun()
    expect(agent.tabs()).toHaveLength(0)
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
