import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeApp, launchApp, setupProviderAndKey, unexpectedErrors } from './helpers'

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

async function sendBrowserGoal(win) {
  await win.getByTestId('nav-chat').click()
  await win.getByTestId('new-conv').click()
  await win.getByTestId('agent-toggle').click()
  await win.getByRole('menuitemradio', { name: /完整权限/ }).click()
  await win.getByTestId('chat-input').fill('打开内置浏览器测试页，输入 MiniAgent 并提交')
  await win.keyboard.press('Enter')
}

beforeEach(async () => {
  pageState = { result: null, userCookie: null, agentCookie: null }
  pageServer = http.createServer((req, res) => {
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

    const screenshot = await win.evaluate(async () => {
      const current = await window.api.browser.state()
      return window.api.browser.screenshot(current.activeTabId)
    })
    expect(fs.existsSync(screenshot.path)).toBe(true)
    fs.rmSync(screenshot.path, { force: true })

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

describe('内置浏览器 P2 安全最小闭环', () => {
  it('runs a real Agent navigate/type/click chain in an isolated visible tab and redacts audit text', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    mock.state.browserRun = true
    mock.state.browserUrl = pageUrl + '?agent=1'
    mock.state.browserDelayMs = 1500

    await win.getByTestId('nav-browser').click()
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
    await win.getByTestId('nav-browser').click()
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
    await win.getByTestId('nav-browser').click()
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
    await win.getByTestId('browser-reload').click()
    await waitFor(async () => pageState.userCookie === 'miniagent_user=secret')

    await closeApp(electronApp, mock)
    ctx = null
    pageState.userCookie = null
    ctx = await launchApp({ reuseUserData: userData })
    ;({ electronApp, win, mock, consoleErrors } = ctx)
    await win.evaluate(() => window.api.settings.set('browserAllowPrivateNetwork', true))

    await win.getByTestId('nav-browser').click()
    await win.getByTestId('browser-view').waitFor()
    await waitFor(
      async () => (await win.evaluate(() => window.api.browser.state())).tabs.length === 1
    )
    await win.getByTestId('browser-address').fill(pageUrl)
    await win.getByTestId('browser-go').click()
    await waitFor(async () => pageState.userCookie === 'miniagent_user=secret')

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
    await win.getByTestId('nav-browser').click()
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
    await win.getByTestId('nav-browser').click()
    await win.getByTestId('browser-view').waitFor()
    await waitFor(
      async () => (await win.evaluate(() => window.api.browser.state())).tabs.length === 1
    )

    for (const [input, origin] of [
      ['example.com', 'https://example.com/'],
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
  it('expands to the right, shrinks chat and coexists with the standalone browser view', async () => {
    const { win, consoleErrors } = ctx
    await win.getByTestId('nav-chat').click()
    await win.getByTestId('new-conv').click()
    const before = await win.getByTestId('chat-main').boundingBox()

    await win.getByRole('button', { name: '更多操作' }).click()
    await win.getByRole('menuitem', { name: '导出 MD' }).waitFor()
    await win.getByRole('button', { name: '更多操作' }).click()
    await win.getByTestId('chat-browser-panel-toggle').click()
    await win.getByTestId('chat-browser-panel').waitFor()
    await win.getByTestId('browser-view').waitFor()
    await waitFor(async () => {
      const state = await win.evaluate(() => window.api.browser.state())
      return !!state.attachedTabId
    })

    const after = await win.getByTestId('chat-main').boundingBox()
    const panelBefore = await win.getByTestId('chat-browser-panel').boundingBox()
    expect(after.width).toBeLessThan(before.width)

    const divider = await win.getByTestId('chat-browser-divider').boundingBox()
    expect(divider).toBeTruthy()
    await win.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2)
    await win.mouse.down()
    await win.mouse.move(divider.x - 70, divider.y + divider.height / 2, { steps: 8 })
    await win.mouse.up()
    await waitFor(
      async () =>
        (await win.getByTestId('chat-browser-panel').boundingBox()).width > panelBefore.width + 40
    )
    const widened = await win.getByTestId('chat-main').boundingBox()
    const widenedPanel = await win.getByTestId('chat-browser-panel').boundingBox()
    expect(widened.width).toBeLessThan(after.width - 40)

    const movedDivider = await win.getByTestId('chat-browser-divider').boundingBox()
    await win.mouse.move(
      movedDivider.x + movedDivider.width / 2,
      movedDivider.y + movedDivider.height / 2
    )
    await win.mouse.down()
    await win.mouse.move(movedDivider.x + 50, movedDivider.y + movedDivider.height / 2, {
      steps: 6
    })
    await win.mouse.up()
    await waitFor(
      async () =>
        (await win.getByTestId('chat-browser-panel').boundingBox()).width < widenedPanel.width - 20
    )
    const narrowedPanel = await win.getByTestId('chat-browser-panel').boundingBox()

    await win.getByTestId('chat-browser-divider').focus()
    await win.keyboard.press('ArrowRight')
    await waitFor(
      async () =>
        (await win.getByTestId('chat-browser-panel').boundingBox()).width > narrowedPanel.width + 8
    )

    await win.getByTestId('nav-browser').click()
    await waitFor(async () => {
      const state = await win.evaluate(() => window.api.browser.state())
      return !!state.attachedTabId
    })
    expect(await win.getByTestId('chat-browser-panel').isVisible()).toBe(false)

    await win.getByTestId('nav-chat').click()
    await win.getByTestId('chat-browser-panel').waitFor()
    await win.getByTestId('chat-browser-panel-close').click()
    await waitFor(async () => {
      const state = await win.evaluate(() => window.api.browser.state())
      return state.attachedTabId === null
    })
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})
