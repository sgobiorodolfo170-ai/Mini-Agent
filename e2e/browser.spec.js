/* global Buffer, URL, process, setTimeout, window */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeApp, launchApp, setupProviderAndKey, unexpectedErrors } from './helpers'

let ctx
let pageServer
let pageUrl
let popupUrl
let pageState
let slowRequested = false

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function assertPngScreenshot(screenshot) {
  expect(screenshot.width).toBeGreaterThan(0)
  expect(screenshot.height).toBeGreaterThan(0)
  const png = fs.readFileSync(screenshot.path)
  expect(png.byteLength).toBeGreaterThan(24)
  expect(png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true)
  expect(png.readUInt32BE(16)).toBe(screenshot.width)
  expect(png.readUInt32BE(20)).toBe(screenshot.height)
  expect(png.readUInt32BE(png.length - 12)).toBe(0)
  expect(png.toString('ascii', png.length - 8, png.length - 4)).toBe('IEND')
  return png.byteLength
}

async function readNativeViewState(electronApp, url) {
  return electronApp.evaluate(({ BrowserWindow, webContents }, target) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === target)
    if (!guest) return null
    const view = BrowserWindow.getAllWindows()
      .flatMap((window) => window.contentView?.children || [])
      .find((candidate) => candidate.webContents === guest)
    if (!view) return null
    return { visible: view.getVisible(), bounds: view.getBounds() }
  }, url)
}

async function trackNativeViewTransitions(electronApp, url) {
  return electronApp.evaluate(({ BrowserWindow, webContents }, target) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === target)
    const win = BrowserWindow.getAllWindows().find((window) =>
      (window.contentView?.children || []).some((candidate) => candidate.webContents === guest)
    )
    const view = win?.contentView.children.find((candidate) => candidate.webContents === guest)
    if (!win || !view) throw new Error('native view not found')
    const tracking = {
      view,
      setBounds: view.setBounds,
      setVisible: view.setVisible,
      transitions: []
    }
    view.setBounds = function trackedBounds(bounds) {
      tracking.transitions.push({ visible: this.getVisible(), bounds: { ...bounds } })
      return tracking.setBounds.call(this, bounds)
    }
    view.setVisible = function trackedVisible(visible) {
      tracking.transitions.push({
        visible: this.getVisible(),
        requestedVisible: visible,
        bounds: { ...this.getBounds() }
      })
      return tracking.setVisible.call(this, visible)
    }
    globalThis.__miniagentScreenshotTracking = tracking
    return win.getContentSize()
  }, url)
}

async function finishNativeViewTracking(electronApp) {
  return electronApp.evaluate(() => {
    const tracking = globalThis.__miniagentScreenshotTracking
    if (!tracking) throw new Error('native view tracking not found')
    tracking.view.setBounds = tracking.setBounds
    tracking.view.setVisible = tracking.setVisible
    delete globalThis.__miniagentScreenshotTracking
    return tracking.transitions
  })
}

async function readCenterPixel(electronApp, png) {
  return electronApp.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
    const { width, height } = image.getSize()
    const bitmap = image.toBitmap()
    const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
    return { width, height, bgra: [...bitmap.subarray(offset, offset + 4)] }
  }, png.toString('base64'))
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      last = await check()
      if (last) return last
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`waitFor timeout: ${String(last && last.message ? last.message : last)}`)
}

async function readGuestBody(electronApp, url) {
  return electronApp.evaluate(({ webContents }, target) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === target)
    if (!guest) return null
    return guest.executeJavaScript('document.body ? document.body.innerText : ""')
  }, url)
}

async function isGuestDevToolsOpened(electronApp, url) {
  return electronApp.evaluate(({ webContents }, target) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === target)
    return guest ? guest.isDevToolsOpened() : false
  }, url)
}

async function sendF12(electronApp, url) {
  return electronApp.evaluate(({ webContents }, target) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === target)
    if (!guest) throw new Error('guest not found')
    guest.focus()
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'F12' })
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'F12' })
    return null
  }, url)
}

async function focusGuestDevTools(electronApp, url) {
  await waitFor(() =>
    electronApp.evaluate(({ webContents }, target) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === target)
      return !!guest?.devToolsWebContents
    }, url)
  )
  await electronApp.evaluate(({ webContents }, target) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === target)
    guest.devToolsWebContents.focus()
    return null
  }, url)
  await waitFor(() =>
    electronApp.evaluate(({ webContents }, target) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === target)
      return !!guest && guest.isDevToolsFocused()
    }, url)
  )
}

async function activateBrowserDevToolsMenu(electronApp) {
  return electronApp.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('browser-devtools')
    if (!item) throw new Error('browser DevTools menu item not found')
    const accelerator = item.accelerator
    item.click()
    return accelerator
  })
}

async function clickGuestElement(electronApp, url, selector) {
  return electronApp.evaluate(
    ({ webContents }, { target, query }) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === target)
      if (!guest) throw new Error('guest not found')
      const rect = guest.executeJavaScript(`(() => {
        const element = document.querySelector(${JSON.stringify(query)});
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })()`)
      return rect.then((point) => {
        if (!point) throw new Error('element not found')
        guest.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
        guest.sendInputEvent({
          type: 'mouseDown',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1
        })
        guest.sendInputEvent({
          type: 'mouseUp',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1
        })
        return point
      })
    },
    { target: url, query: selector }
  )
}

async function openBrowserPage(win) {
  // 左侧导航已移除浏览器入口：从会话页的内置浏览器面板启动独立浏览器页
  await win.getByTestId('nav-chat').click()
  const panel = win.getByTestId('chat-browser-panel')
  if (!(await panel.isVisible().catch(() => false))) {
    await win.getByTestId('chat-browser-panel-toggle').click()
  }
  await panel.waitFor({ timeout: 10000 })
  const standalone = win.getByTestId('browser-quick-standalone')
  if (await standalone.isVisible().catch(() => false)) await standalone.click()
  await win.getByTestId('browser-view').waitFor({ timeout: 10000 })
}

async function sendBrowserGoal(win) {
  await win.getByTestId('nav-chat').click()
  await win.getByTestId('new-conv').click()
  await win.getByTestId('agent-toggle').click()
  await win.getByRole('menuitemradio', { name: /完整权限/ }).click()
  await win.getByTestId('chat-input').fill('打开内置浏览器测试页，输入 MiniAgent 并提交')
  await win.keyboard.press('Enter')
}

async function screenshotOutcome(win, tabId) {
  return win.evaluate(async (id) => {
    try {
      return { ok: true, screenshot: await window.api.browser.screenshot(id) }
    } catch (error) {
      return { ok: false, name: error.name, code: error.code, message: error.message }
    }
  }, tabId)
}

async function openHiddenScreenshotTab(electronApp, win) {
  const url = pageUrl + 'screenshot-solid'
  const tab = await win.evaluate(async (target) => window.api.browser.open({ url: target }), url)
  await waitFor(async () =>
    (await readGuestBody(electronApp, url))?.includes('OFFSCREEN_SCREENSHOT_OK')
  )
  return { tab, url }
}

beforeEach(async () => {
  pageState = { result: null, userCookie: null, agentCookie: null }
  slowRequested = false
  pageServer = http.createServer((req, res) => {
    if (req.url === '/slow') {
      slowRequested = true
      setTimeout(() => {
        if (res.writableEnded || res.destroyed) return
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><title>Slow</title><body>SLOW_PAGE</body>')
      }, 4000)
      return
    }
    if (req.url === '/screenshot-solid') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><title>Screenshot Solid</title><style>
        html, body { margin: 0; width: 100%; height: 100%; background: #0c8852; }
      </style></head><body>OFFSCREEN_SCREENSHOT_OK</body></html>`)
      return
    }
    if (req.url === '/' || req.url.startsWith('/?')) {
      if (req.url.includes('agent=1')) pageState.agentCookie = req.headers.cookie || ''
      else pageState.userCookie = req.headers.cookie || ''
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'miniagent_user=secret; Path=/; Max-Age=3600; SameSite=Lax'
      })
      res.end(`<!doctype html><html><head><title>Mini Agent Browser</title></head><body>
        <h1>内置浏览器测试页</h1>
        <input id="name" value="MiniAgent" />
        <button id="go">提交</button>
        <a id="redirect-link" href="/redirect">重定向测试</a>
        <div id="result"></div>
        <script>
          document.querySelector('#go').addEventListener('click', () => {
            const value = document.querySelector('#name').value
            document.querySelector('#result').textContent = 'HELLO:' + value
            fetch('/result?name=' + encodeURIComponent(value))
          })
        </script>
      </body></html>`)
      return
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/popup' })
      res.end()
      return
    }
    if (req.url === '/popup') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Popup</title><body>POPUP_OK</body>')
      return
    }
    if (req.url === '/download') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="miniagent-download.txt"'
      })
      res.end('DOWNLOAD_OK')
      return
    }
    if (req.url.startsWith('/result')) {
      pageState.result = new URL(req.url, 'http://local').searchParams.get('name')
      res.writeHead(204)
      res.end()
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  const base = await listen(pageServer)
  pageUrl = base + '/'
  popupUrl = base + '/popup'
  ctx = await launchApp()
  await ctx.win.evaluate(() => window.api.settings.set('browserAllowPrivateNetwork', true))
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
  if (pageServer) await new Promise((resolve) => pageServer.close(resolve))
  pageServer = null
})

describe('内置浏览器 P1 技术 spike', () => {
  it('embeds a real WebContentsView, tracks resize and adopts popups as tabs', async () => {
    const { electronApp, win, consoleErrors } = ctx
    await openBrowserPage(win)
    await win.getByTestId('browser-view').waitFor()
    await waitFor(
      async () => (await win.evaluate(() => window.api.browser.state())).tabs.length === 1
    )

    await win.getByTestId('browser-address').fill(pageUrl)
    await win.getByTestId('browser-go').click()
    await waitFor(async () =>
      (await readGuestBody(electronApp, pageUrl))?.includes('内置浏览器测试页')
    )

    let state = await win.evaluate(() => window.api.browser.state())
    expect(state.attachedTabId).toBe(state.activeTabId)
    let rect = await win.getByTestId('browser-viewport').boundingBox()
    expect(Math.abs(state.tabs[0].bounds.x - rect.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(state.tabs[0].bounds.y - rect.y)).toBeLessThanOrEqual(2)
    expect(Math.abs(state.tabs[0].bounds.width - rect.width)).toBeLessThanOrEqual(2)

    const screenshot = await win.evaluate(async () => {
      const current = await window.api.browser.state()
      return window.api.browser.screenshot(current.activeTabId)
    })
    try {
      expect(assertPngScreenshot(screenshot)).toBeGreaterThan(24)
    } finally {
      fs.rmSync(screenshot.path, { force: true })
    }

    await win.setViewportSize({ width: 1100, height: 720 })
    await waitFor(async () => {
      const current = await win.evaluate(() => window.api.browser.state())
      const box = await win.getByTestId('browser-viewport').boundingBox()
      return Math.abs(current.tabs[0].bounds.width - box.width) <= 2 && box.width < rect.width
    })

    await electronApp.evaluate(
      async ({ webContents }, { source, target }) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === source)
        if (!guest) throw new Error('guest not found')
        await guest.executeJavaScript(`(() => { window.open(${JSON.stringify(target)}) })()`)
        return null
      },
      { source: pageUrl, target: popupUrl }
    )
    await waitFor(
      async () => (await win.evaluate(() => window.api.browser.state())).tabs.length === 2
    )
    await waitFor(async () => (await readGuestBody(electronApp, popupUrl)) === 'POPUP_OK')

    await win.getByTestId('nav-chat').click()
    await openBrowserPage(win)
    await waitFor(async () => {
      const current = await win.evaluate(() => window.api.browser.state())
      return current.attachedTabId === current.activeTabId && !!current.activeTabId
    })

    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
  it('captures an unmounted tab with one visible pixel and restores hidden state', async () => {
    const { electronApp, win, consoleErrors } = ctx
    const screenshotUrl = pageUrl + 'screenshot-solid'
    const tab = await win.evaluate(async (url) => window.api.browser.open({ url }), screenshotUrl)
    expect(tab.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect((await win.evaluate(() => window.api.browser.state())).attachedTabId).toBe(null)
    await waitFor(async () =>
      (await readGuestBody(electronApp, screenshotUrl))?.includes('OFFSCREEN_SCREENSHOT_OK')
    )
    expect(await readNativeViewState(electronApp, screenshotUrl)).toEqual({
      visible: false,
      bounds: { x: 0, y: 0, width: 0, height: 0 }
    })
    await trackNativeViewTransitions(electronApp, screenshotUrl)

    const screenshot = await win.evaluate(
      async (tabId) => window.api.browser.screenshot(tabId),
      tab.id
    )
    const transitions = await finishNativeViewTracking(electronApp)
    try {
      expect(assertPngScreenshot(screenshot)).toBeGreaterThan(24)
      const png = fs.readFileSync(screenshot.path)
      expect(await readCenterPixel(electronApp, png)).toEqual({
        width: screenshot.width,
        height: screenshot.height,
        bgra: [82, 136, 12, 255]
      })
      const visibleTransitions = transitions.filter(
        (entry) => entry.requestedVisible && entry.bounds.width > 0 && entry.bounds.height > 0
      )
      expect(visibleTransitions.length).toBeGreaterThan(0)
      for (const entry of visibleTransitions) {
        expect(entry.bounds.x).toBeLessThan(0)
        expect(entry.bounds.y).toBeLessThan(0)
        expect(entry.bounds.x + entry.bounds.width).toBe(1)
        expect(entry.bounds.y + entry.bounds.height).toBe(1)
      }
    } finally {
      fs.rmSync(screenshot.path, { force: true })
    }

    const state = await win.evaluate(() => window.api.browser.state())
    expect(state.attachedTabId).toBe(null)
    expect(state.tabs.find((item) => item.id === tab.id).bounds).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0
    })
    expect(await readNativeViewState(electronApp, screenshotUrl)).toEqual({
      visible: false,
      bounds: { x: 0, y: 0, width: 0, height: 0 }
    })
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
  it('times out a hung capturePage call and recovers after the native call settles', async () => {
    const { electronApp, win } = ctx
    const { tab, url } = await openHiddenScreenshotTab(electronApp, win)
    const bounds = { x: 10, y: 20, width: 800, height: 600 }
    await win.evaluate(({ id, rect }) => window.api.browser.attach(id, rect), {
      id: tab.id,
      rect: bounds
    })
    await electronApp.evaluate(({ webContents }, target) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === target)
      const capturePage = guest.capturePage.bind(guest)
      guest.capturePage = (options) =>
        new Promise((resolve) => {
          globalThis.__miniagentReleaseCapture = () => resolve(capturePage(options))
        })
      globalThis.__miniagentScreenshotPatch = { guest, capturePage }
    }, url)

    const failed = await screenshotOutcome(win, tab.id)
    expect(failed).toMatchObject({ ok: false })
    expect(failed.message).toContain('原生截图超时')
    expect(await readNativeViewState(electronApp, url)).toEqual({ visible: true, bounds })

    await electronApp.evaluate(() => {
      const { guest, capturePage } = globalThis.__miniagentScreenshotPatch
      guest.capturePage = capturePage
      globalThis.__miniagentReleaseCapture()
      delete globalThis.__miniagentReleaseCapture
      delete globalThis.__miniagentScreenshotPatch
    })
    const recovered = await screenshotOutcome(win, tab.id)
    expect(recovered.ok).toBe(true)
    try {
      expect(assertPngScreenshot(recovered.screenshot)).toBeGreaterThan(24)
    } finally {
      fs.rmSync(recovered.screenshot.path, { force: true })
    }
  }, 45000)

  it('honors detachment while an attached native capture is in flight', async () => {
    const { electronApp, win } = ctx
    const { tab, url } = await openHiddenScreenshotTab(electronApp, win)
    const bounds = { x: 10, y: 20, width: 800, height: 600 }
    await win.evaluate(({ id, rect }) => window.api.browser.attach(id, rect), {
      id: tab.id,
      rect: bounds
    })
    await electronApp.evaluate(({ webContents }, target) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === target)
      const capturePage = guest.capturePage.bind(guest)
      guest.capturePage = (options) =>
        new Promise((resolve) => {
          globalThis.__miniagentReleaseCapture = () => resolve(capturePage(options))
        })
    }, url)
    const pending = screenshotOutcome(win, tab.id)
    await waitFor(() =>
      electronApp.evaluate(() => typeof globalThis.__miniagentReleaseCapture === 'function')
    )
    await win.evaluate(() => window.api.browser.detach())
    await electronApp.evaluate(() => globalThis.__miniagentReleaseCapture())
    const outcome = await pending
    expect(outcome.ok).toBe(true)
    try {
      expect(assertPngScreenshot(outcome.screenshot)).toBeGreaterThan(24)
    } finally {
      fs.rmSync(outcome.screenshot.path, { force: true })
    }
    expect((await win.evaluate(() => window.api.browser.state())).attachedTabId).toBe(null)
    expect(await readNativeViewState(electronApp, url)).toEqual({ visible: false, bounds })
  })

  it('rejects a truncated PNG that has a valid signature and IHDR', async () => {
    const { electronApp, win } = ctx
    const { tab, url } = await openHiddenScreenshotTab(electronApp, win)
    await win.evaluate(
      ({ id }) => window.api.browser.attach(id, { x: 0, y: 0, width: 800, height: 600 }),
      { id: tab.id }
    )
    await electronApp.evaluate(({ webContents }, target) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === target)
      const capturePage = guest.capturePage.bind(guest)
      guest.capturePage = async () => ({
        getSize: () => ({ width: 1, height: 1 }),
        toPNG: () => {
          const png = Buffer.alloc(24)
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
          png.writeUInt32BE(13, 8)
          png.write('IHDR', 12)
          png.writeUInt32BE(1, 16)
          png.writeUInt32BE(1, 20)
          return png
        }
      })
      globalThis.__miniagentScreenshotPatch = { guest, capturePage }
    }, url)

    const failed = await screenshotOutcome(win, tab.id)
    expect(failed).toMatchObject({ ok: false })
    expect(failed.message).toContain('不是有效的 PNG')
    await electronApp.evaluate(() => {
      const { guest, capturePage } = globalThis.__miniagentScreenshotPatch
      guest.capturePage = capturePage
      delete globalThis.__miniagentScreenshotPatch
    })
  })

  it('rejects a PNG whose chunks are valid but compressed pixel data is corrupt', async () => {
    const { electronApp, win } = ctx
    const { tab, url } = await openHiddenScreenshotTab(electronApp, win)
    await win.evaluate(
      ({ id }) => window.api.browser.attach(id, { x: 0, y: 0, width: 800, height: 600 }),
      { id: tab.id }
    )
    const valid = await screenshotOutcome(win, tab.id)
    expect(valid.ok).toBe(true)
    const png = fs.readFileSync(valid.screenshot.path)
    fs.rmSync(valid.screenshot.path, { force: true })
    const damaged = Buffer.from(png)
    const idatLength = damaged.readUInt32BE(33)
    const dataOffset = 41
    const crcOffset = dataOffset + idatLength
    damaged[dataOffset] ^= 0xff
    damaged.writeUInt32BE(zlib.crc32(damaged.subarray(37, crcOffset)), crcOffset)

    await electronApp.evaluate(
      ({ webContents }, { target, png, width, height }) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === target)
        const capturePage = guest.capturePage.bind(guest)
        const damaged = Buffer.from(png, 'base64')
        guest.capturePage = async () => ({
          getSize: () => ({ width, height }),
          toPNG: () => damaged
        })
        globalThis.__miniagentScreenshotPatch = { guest, capturePage }
      },
      {
        target: url,
        png: damaged.toString('base64'),
        width: valid.screenshot.width,
        height: valid.screenshot.height
      }
    )

    const failed = await screenshotOutcome(win, tab.id)
    expect(failed).toMatchObject({ ok: false })
    expect(failed.message).toContain('PNG 解码失败')
    await electronApp.evaluate(() => {
      const { guest, capturePage } = globalThis.__miniagentScreenshotPatch
      guest.capturePage = capturePage
      delete globalThis.__miniagentScreenshotPatch
    })
  })

  it('follows a clicked link through an HTTP redirect without a stale error', async () => {
    const { electronApp, win, consoleErrors } = ctx
    await openBrowserPage(win)
    await win.getByTestId('browser-view').waitFor()
    await waitFor(
      async () => (await win.evaluate(() => window.api.browser.state())).tabs.length === 1
    )

    await win.getByTestId('browser-address').fill(pageUrl)
    await win.getByTestId('browser-go').click()
    await waitFor(async () =>
      (await readGuestBody(electronApp, pageUrl))?.includes('内置浏览器测试页')
    )

    await clickGuestElement(electronApp, pageUrl, '#redirect-link')
    await waitFor(async () => (await readGuestBody(electronApp, popupUrl)) === 'POPUP_OK')
    await waitFor(async () => {
      const state = await win.evaluate(() => window.api.browser.state())
      const tab = state.tabs.find((item) => item.id === state.activeTabId)
      return tab?.url === popupUrl && !tab.loading && !tab.error
    })

    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
  it('cancels a slow page when a newer URL is submitted in the address bar', async () => {
    const { electronApp, win, consoleErrors } = ctx
    const slowUrl = pageUrl + 'slow'
    await openBrowserPage(win)
    await win.getByTestId('browser-view').waitFor()
    await waitFor(
      async () => (await win.evaluate(() => window.api.browser.state())).tabs.length === 1
    )

    await win.getByTestId('browser-address').fill(slowUrl)
    await win.getByTestId('browser-go').click()
    await waitFor(() => slowRequested)

    const started = Date.now()
    await win.getByTestId('browser-address').fill(pageUrl)
    await win.getByTestId('browser-go').click()
    await waitFor(async () =>
      (await readGuestBody(electronApp, pageUrl))?.includes('内置浏览器测试页')
    )
    expect(Date.now() - started).toBeLessThan(3000)
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})

describe('内置浏览器原生开发者工具', () => {
  it('opens with F12 or the toolbar and closes from DevTools or browser navigation', async () => {
    const { electronApp, win, consoleErrors } = ctx
    await openBrowserPage(win)
    await win.getByTestId('browser-view').waitFor()
    await win.getByTestId('browser-address').fill(pageUrl)
    await win.getByTestId('browser-go').click()
    await waitFor(async () =>
      (await readGuestBody(electronApp, pageUrl))?.includes('内置浏览器测试页')
    )

    await sendF12(electronApp, pageUrl)
    await waitFor(() => isGuestDevToolsOpened(electronApp, pageUrl))
    await waitFor(
      async () =>
        (await win.getByTestId('browser-devtools').getAttribute('aria-pressed')) === 'true'
    )

    await focusGuestDevTools(electronApp, pageUrl)
    expect(await activateBrowserDevToolsMenu(electronApp)).toBe('F12')
    await waitFor(async () => !(await isGuestDevToolsOpened(electronApp, pageUrl)))

    await win.getByTestId('browser-address').focus()
    await win.keyboard.press('F12')
    await waitFor(() => isGuestDevToolsOpened(electronApp, pageUrl))
    await focusGuestDevTools(electronApp, pageUrl)
    expect(await activateBrowserDevToolsMenu(electronApp)).toBe('F12')
    await waitFor(async () => !(await isGuestDevToolsOpened(electronApp, pageUrl)))

    await win.getByTestId('browser-devtools').click()
    await waitFor(() => isGuestDevToolsOpened(electronApp, pageUrl))
    await win.getByTestId('nav-chat').click()
    await waitFor(async () => !(await isGuestDevToolsOpened(electronApp, pageUrl)))
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})

describe('内置浏览器元素检查器与设备工具栏', () => {
  it('selects an element, edits styles live, emulates a viewport and appends context to chat', async () => {
    const { electronApp, win, consoleErrors } = ctx
    await win.getByTestId('chat-input').fill('已有草稿')
    await openBrowserPage(win)
    await win.getByTestId('browser-view').waitFor()
    await win.getByTestId('browser-address').fill(pageUrl)
    await win.getByTestId('browser-go').click()
    await waitFor(async () =>
      (await readGuestBody(electronApp, pageUrl))?.includes('内置浏览器测试页')
    )

    await win.getByTestId('browser-select-element').click()
    await waitFor(() =>
      win.evaluate(async () => {
        const state = await window.api.browser.state()
        const inspector = await window.api.browser.inspectorState(state.activeTabId)
        return inspector.selecting === true
      })
    )
    await clickGuestElement(electronApp, pageUrl, '#go')
    await win.getByTestId('browser-element-menu').waitFor()
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(pageState.result).toBe(null)
    await win.getByTestId('browser-select-element').click()
    await waitFor(() =>
      win.evaluate(async () => {
        const state = await window.api.browser.state()
        const inspector = await window.api.browser.inspectorState(state.activeTabId)
        return inspector.selecting === true
      })
    )
    await clickGuestElement(electronApp, pageUrl, '#name')
    await win.getByTestId('browser-element-menu').waitFor()
    expect(await win.getByTestId('browser-element-add-comment').isVisible()).toBe(true)
    expect(await win.getByTestId('browser-element-add-chat').isVisible()).toBe(true)

    await win.getByTestId('browser-inspector-toggle').click()
    await win.getByTestId('browser-inspector').waitFor()
    expect(await win.getByTestId('browser-inspector-tag').textContent()).toBe('input')
    await win.getByTestId('browser-inspector-width').fill('240')
    await win.getByTestId('browser-inspector-width').press('Tab')
    await waitFor(async () => {
      const width = await electronApp.evaluate(({ webContents }, target) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === target)
        return guest?.executeJavaScript('getComputedStyle(document.querySelector("#name")).width')
      }, pageUrl)
      return width === '240px'
    })
    expect(
      await electronApp.evaluate(({ webContents }, target) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === target)
        return guest.executeJavaScript('getComputedStyle(document.querySelector("#name")).width')
      }, pageUrl)
    ).toBe('240px')

    await win.getByTestId('browser-inspector-tab-css').click()
    await win.getByTestId('browser-inspector-css').fill('background-color: rgb(255, 0, 0);')
    await win.getByTestId('browser-inspector-css-apply').click()
    await waitFor(async () => {
      const color = await electronApp.evaluate(({ webContents }, target) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === target)
        return guest?.executeJavaScript(
          'getComputedStyle(document.querySelector("#name")).backgroundColor'
        )
      }, pageUrl)
      return color === 'rgb(255, 0, 0)'
    })
    expect(
      await electronApp.evaluate(({ webContents }, target) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === target)
        return guest.executeJavaScript(
          'getComputedStyle(document.querySelector("#name")).backgroundColor'
        )
      }, pageUrl)
    ).toBe('rgb(255, 0, 0)')

    await win.getByTestId('browser-inspector-close').click()
    await win.getByTestId('browser-device-toggle').click()
    await win.getByTestId('browser-device-toolbar').waitFor()
    await win.getByTestId('browser-device-width').fill('800')
    await win.getByTestId('browser-device-width').press('Tab')
    await win.getByTestId('browser-device-height').fill('600')
    await win.getByTestId('browser-device-height').press('Tab')
    await waitFor(async () => {
      const viewport = await electronApp.evaluate(({ webContents }, target) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === target)
        return guest?.executeJavaScript('({ width: innerWidth, height: innerHeight })')
      }, pageUrl)
      return viewport?.width === 800 && viewport?.height === 600
    })
    expect(
      await electronApp.evaluate(({ webContents }, target) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === target)
        return guest.executeJavaScript('({ width: innerWidth, height: innerHeight })')
      }, pageUrl)
    ).toEqual({ width: 800, height: 600 })

    await win.getByTestId('browser-device-swap').click()
    await waitFor(async () => {
      const viewport = await electronApp.evaluate(({ webContents }, target) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === target)
        return guest?.executeJavaScript('({ width: innerWidth, height: innerHeight })')
      }, pageUrl)
      return viewport?.width === 600 && viewport?.height === 800
    })
    expect(
      await electronApp.evaluate(({ webContents }, target) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === target)
        return guest.executeJavaScript('({ width: innerWidth, height: innerHeight })')
      }, pageUrl)
    ).toEqual({ width: 600, height: 800 })

    await win.getByTestId('browser-device-close').click()
    await win.getByTestId('browser-element-add-chat').click()
    const draft = await win.getByTestId('chat-input').inputValue()
    expect(draft).toContain('已有草稿')
    expect(draft).toContain('网页元素上下文')
    expect(draft).toContain('#name')
    expect(pageState.result).toBe(null)
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})

describe('内置浏览器 P2 安全最小闭环', () => {
  it('runs a real Agent navigate/type/click chain in an isolated visible tab and redacts audit text', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    mock.state.browserRun = true
    mock.state.browserUrl = pageUrl + '?agent=1'
    mock.state.browserDelayMs = 1500

    await openBrowserPage(win)
    await win.getByTestId('browser-view').waitFor()
    await waitFor(
      async () => (await win.evaluate(() => window.api.browser.state())).tabs.length === 1
    )
    await win.getByTestId('browser-address').fill(pageUrl)
    await win.getByTestId('browser-go').click()
    await waitFor(async () =>
      (await readGuestBody(ctx.electronApp, pageUrl))?.includes('内置浏览器测试页')
    )
    await win.getByTestId('browser-reload').click()
    await waitFor(async () => pageState.userCookie === 'miniagent_user=secret')
    await sendBrowserGoal(win)

    await waitFor(async () => {
      const state = await win.evaluate(() => window.api.browser.state())
      return state.tabs.some((tab) => tab.kind === 'agent')
    })
    await openBrowserPage(win)
    await win.getByTestId('browser-agent-banner').waitFor()
    await waitFor(async () => pageState.result === 'MiniAgent')
    expect(pageState.userCookie).toBe('miniagent_user=secret')
    expect(pageState.agentCookie).toBe('')
    await win.getByTestId('nav-chat').click()
    await win.getByText('浏览器任务完成。').waitFor({ timeout: 45000 })

    await waitFor(async () => {
      const current = await win.evaluate(() => window.api.browser.state())
      return !current.tabs.some((tab) => tab.kind === 'agent')
    })
    const state = await win.evaluate(() => window.api.browser.state())
    expect(state.tabs.some((tab) => tab.kind === 'agent')).toBe(false)
    const audit = await win.evaluate(async () => {
      const runs = await window.api.agent.runs()
      const calls = await window.api.agent.calls(runs[0].id)
      return calls.map((call) => ({ tool: call.tool, args: call.args, error: call.error }))
    })
    const typeCall = audit.find((call) => call.tool === 'browser_type')
    expect(typeCall).toBeTruthy()
    expect(JSON.parse(typeCall.args).text).toBe('[redacted]')
    expect(audit.some((call) => call.tool === 'browser_navigate')).toBe(true)
    expect(audit.some((call) => call.tool === 'browser_click')).toBe(true)
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

  it('blocks subsequent Agent actions after human takeover', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    mock.state.browserRun = true
    mock.state.browserUrl = pageUrl
    mock.state.browserDelayMs = 3000

    await sendBrowserGoal(win)
    await waitFor(async () => {
      const state = await win.evaluate(() => window.api.browser.state())
      return state.tabs.some((tab) => tab.kind === 'agent')
    })
    await openBrowserPage(win)
    await win.getByTestId('browser-agent-banner').waitFor()
    await win.getByTestId('browser-takeover').click()
    await win.getByTestId('nav-chat').click()
    await win.getByText('浏览器任务已中止：用户人工接管。').waitFor({ timeout: 45000 })

    expect(pageState.result).toBe(null)
    const failedCall = await win.evaluate(async () => {
      const runs = await window.api.agent.runs()
      const calls = await window.api.agent.calls(runs[0].id)
      return (
        calls.find(
          (call) =>
            call.tool.startsWith('browser_') && String(call.error || '').includes('人工接管')
        ) || null
      )
    })
    expect(failedCall).toBeTruthy()
    expect(failedCall.error).toContain('人工接管')
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})

describe('内置浏览器 P5 登录态与文件能力', () => {
  it('persists user login across restart, clears it and stores downloads in a dedicated directory', async () => {
    let { electronApp, win, mock, userData, consoleErrors } = ctx
    await openBrowserPage(win)
    await win.getByTestId('browser-view').waitFor()
    await waitFor(
      async () => (await win.evaluate(() => window.api.browser.state())).tabs.length === 1
    )
    await win.getByTestId('browser-address').fill(pageUrl)
    await win.getByTestId('browser-go').click()
    await waitFor(async () =>
      (await readGuestBody(electronApp, pageUrl))?.includes('内置浏览器测试页')
    )
    await win.getByTestId('browser-reload').click()
    await waitFor(async () => pageState.userCookie === 'miniagent_user=secret')

    await closeApp(electronApp, mock)
    ctx = null
    pageState.userCookie = null
    ctx = await launchApp({ reuseUserData: userData })
    ;({ electronApp, win, mock, consoleErrors } = ctx)
    await win.evaluate(() => window.api.settings.set('browserAllowPrivateNetwork', true))

    await openBrowserPage(win)
    await win.getByTestId('browser-view').waitFor()
    await waitFor(
      async () => (await win.evaluate(() => window.api.browser.state())).tabs.length === 1
    )
    await win.getByTestId('browser-address').fill(pageUrl)
    await win.getByTestId('browser-go').click()
    await waitFor(async () => pageState.userCookie === 'miniagent_user=secret')
    await waitFor(async () =>
      (await readGuestBody(electronApp, pageUrl))?.includes('内置浏览器测试页')
    )

    const info = await win.evaluate(() => window.api.app.info())
    await electronApp.evaluate(({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === url)
      if (!guest) throw new Error('guest not found')
      return guest.executeJavaScript(
        `(() => { location.href = ${JSON.stringify(url + 'download')} })()`
      )
    }, pageUrl)
    const downloadPath = path.join(info.dataDir, 'browser-downloads', 'miniagent-download.txt')
    await waitFor(() => fs.existsSync(downloadPath))
    expect(fs.readFileSync(downloadPath, 'utf8')).toBe('DOWNLOAD_OK')

    await win.evaluate(() => window.api.browser.clearData())
    await win.getByTestId('browser-new-tab').click()
    await win.getByTestId('browser-address').fill(pageUrl)
    await win.getByTestId('browser-go').click()
    await waitFor(async () => pageState.userCookie === '')
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})

describe('内置浏览器 P6 韧性与可观测性', () => {
  it('blocks private navigation by default and the feature switch closes every tab', async () => {
    const { electronApp, win, consoleErrors } = ctx
    await win.evaluate(() => window.api.settings.set('browserAllowPrivateNetwork', false))
    await openBrowserPage(win)
    await win.getByTestId('browser-view').waitFor()
    await waitFor(
      async () => (await win.evaluate(() => window.api.browser.state())).tabs.length === 1
    )

    await win.getByTestId('browser-address').fill(pageUrl)
    await win.getByTestId('browser-go').click()
    await win.getByTestId('browser-error').waitFor()
    await waitFor(async () =>
      (await win.getByTestId('browser-error').textContent()).includes('禁止')
    )

    await win.evaluate(() => window.api.settings.set('browserAllowPrivateNetwork', true))
    await win.getByTestId('browser-retry').click()
    await waitFor(async () =>
      (await readGuestBody(electronApp, pageUrl))?.includes('内置浏览器测试页')
    )

    await win.getByTestId('browser-address').fill('not a url')
    await win.getByTestId('browser-go').click()
    await win.getByTestId('browser-error').waitFor()
    expect(await win.getByTestId('browser-error').textContent()).toContain('URL 格式无效')

    await win.getByTestId('browser-address').fill('http://127.0.0.1:65534/')
    await win.getByTestId('browser-go').click()
    await waitFor(async () =>
      (await win.getByTestId('browser-error').textContent()).includes('拒绝连接')
    )

    await win.getByTestId('browser-address').fill(pageUrl)
    await win.getByTestId('browser-go').click()
    await waitFor(async () =>
      (await readGuestBody(electronApp, pageUrl))?.includes('内置浏览器测试页')
    )
    await win.getByTestId('browser-error').waitFor({ state: 'detached' })

    await win.evaluate(() => window.api.browser.setEnabled(false))
    await win.getByTestId('browser-enable').waitFor()
    expect((await win.evaluate(() => window.api.browser.state())).tabs).toHaveLength(0)
    await win.getByTestId('browser-enable').click()
    await waitFor(
      async () => (await win.evaluate(() => window.api.browser.state())).tabs.length === 1
    )
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})

describe.skipIf(process.env.MINIAGENT_E2E_PUBLIC_BROWSER !== '1')('真实公网网站验收', () => {
  it('支持裸域名并打开常见公网网站', async () => {
    const { electronApp, win } = ctx
    await openBrowserPage(win)
    await win.getByTestId('browser-view').waitFor()
    await waitFor(
      async () => (await win.evaluate(() => window.api.browser.state())).tabs.length === 1
    )

    for (const [input, origin] of [
      ['example.com', 'https://example.com/'],
      ['baidu.com', 'https://www.baidu.com/'],
      ['https://www.baidu.com/', 'https://www.baidu.com/']
    ]) {
      await win.getByTestId('browser-address').fill(input)
      await win.getByTestId('browser-go').click()
      await waitFor(async () => {
        const state = await win.evaluate(() => window.api.browser.state())
        const tab = state.tabs.find((item) => item.id === state.activeTabId)
        return tab && tab.url.startsWith(origin) && !tab.loading && !tab.error
      }, 30000)
      const guest = await electronApp.evaluate(({ webContents }, target) => {
        const contents = webContents
          .getAllWebContents()
          .find((item) => !item.isDestroyed() && item.getURL().startsWith(target))
        if (!contents) return null
        return contents.executeJavaScript(
          '({title: document.title, text: document.body ? document.body.innerText.slice(0, 200) : ""})'
        )
      }, origin)
      expect(guest).toBeTruthy()
      expect(guest.title).toBeTruthy()
      expect(guest.text.length).toBeGreaterThan(0)
    }
  }, 90000)
})

describe('聊天右侧内置浏览器侧栏', () => {
  it('expands to the right by widening the window, keeps chat width and coexists with the standalone browser view', async () => {
    const { electronApp, win, consoleErrors } = ctx
    await win.bringToFront()
    await win.getByTestId('nav-chat').click()
    await win.getByTestId('new-conv').click()
    const before = await win.getByTestId('chat-main').boundingBox()

    await win.getByRole('button', { name: '更多操作' }).click()
    await win.getByRole('menuitem', { name: '导出 MD' }).waitFor()
    await win.getByRole('button', { name: '更多操作' }).click()
    await win.getByTestId('chat-browser-panel-toggle').click()
    await win.getByTestId('chat-browser-panel').waitFor()
    await win.getByTestId('browser-view').waitFor()
    await win.getByTestId('browser-address').fill(pageUrl)
    await win.getByTestId('browser-go').click()
    await waitFor(async () =>
      (await readGuestBody(electronApp, pageUrl))?.includes('内置浏览器测试页')
    )
    await waitFor(async () => {
      const state = await win.evaluate(() => window.api.browser.state())
      return !!state.attachedTabId
    })

    const after = await win.getByTestId('chat-main').boundingBox()
    // 展开时主窗口同步拓宽，会话区宽度保持不变
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(2)

    await win.getByTestId('browser-new-tab').click()
    await win.getByTestId('browser-quick-standalone').click()
    await win.getByTestId('browser-address').fill(pageUrl)
    await win.getByTestId('browser-go').click()
    await waitFor(async () =>
      (await readGuestBody(electronApp, pageUrl))?.includes('内置浏览器测试页')
    )
    await waitFor(async () => {
      const state = await win.evaluate(() => window.api.browser.state())
      return !!state.attachedTabId
    })
    expect(await win.getByTestId('chat-browser-panel').isVisible()).toBe(false)

    await win.getByTestId('nav-chat').click()
    await win.getByTestId('chat-browser-panel').waitFor()
    await win.getByTestId('chat-browser-panel-toggle').click()
    await waitFor(async () => {
      const state = await win.evaluate(() => window.api.browser.state())
      return state.attachedTabId === null
    })
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})
