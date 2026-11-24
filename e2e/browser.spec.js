import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeApp, launchApp, unexpectedErrors } from './helpers'

let ctx
let pageServer
let pageUrl
let popupUrl
let pageState

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

beforeEach(async () => {
  pageState = { result: null }
  pageServer = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><title>Mini Agent Browser</title></head><body>
        <h1>内置浏览器测试页</h1>
        <input id="name" value="MiniAgent" />
        <button id="go">提交</button>
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
    if (req.url === '/popup') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Popup</title><body>POPUP_OK</body>')
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
    await win.getByTestId('nav-browser').click()
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
    await waitFor(
      async () => (await win.evaluate(() => window.api.browser.state())).attachedTabId === null
    )
    await win.getByTestId('nav-browser').click()
    await waitFor(async () => {
      const current = await win.evaluate(() => window.api.browser.state())
      return current.attachedTabId === current.activeTabId && !!current.activeTabId
    })

    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})
