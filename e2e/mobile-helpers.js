/* global process, window, DOMException, sessionStorage, fetch */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

export const MOBILE_DEVICES = Object.freeze({
  android: Object.freeze({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
  }),
  iphone: Object.freeze({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  })
})

export async function launchMobileBrowser() {
  const candidates = [
    process.env.MINIAGENT_E2E_BROWSER,
    chromium.executablePath(),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean)
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate))
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  })
}

export async function createMobileContext(browser, device = 'android') {
  const descriptor = MOBILE_DEVICES[device] || MOBILE_DEVICES.android
  const context = await browser.newContext({
    ...descriptor,
    ignoreHTTPSErrors: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light'
  })
  const page = await context.newPage()
  const consoleErrors = []
  const pageErrors = []
  const httpErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => {
    pageErrors.push(String(error))
    consoleErrors.push(String(error))
  })
  page.on('response', (response) => {
    if (response.status() >= 400) {
      httpErrors.push({ status: response.status(), url: response.url() })
    }
  })
  return { context, page, consoleErrors, pageErrors, httpErrors }
}

export async function installMobileSocketControl(context) {
  await context.addInitScript(() => {
    if (window.__miniAgentSocketControlInstalled) return
    window.__miniAgentSocketControlInstalled = true
    window.__miniAgentSocketOffline = false
    window.__miniAgentSockets = new Set()
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        if (window.__miniAgentSocketOffline) {
          throw new DOMException('E2E offline', 'AbortError')
        }
        super(url, protocols)
        window.__miniAgentSockets.add(this)
        this.addEventListener('close', () => window.__miniAgentSockets.delete(this))
      }
    }
  })
}

export async function pairMobilePage(page, qrUrl) {
  await page.goto(qrUrl, { waitUntil: 'domcontentloaded' })
  try {
    await page.getByTestId('remote-phase-app').waitFor({ timeout: 20000 })
    await page.getByTestId('remote-connection').filter({ hasText: '已连接' }).waitFor({
      timeout: 20000
    })
  } catch (error) {
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => '')
    throw new Error(`mobile pairing failed: ${error.message}; url=${page.url()}; body=${body}`)
  }
  if (page.url().includes('ticket=') || page.url().includes('#t=')) {
    throw new Error(`pairing ticket remained in URL: ${page.url()}`)
  }
  return page
}

export async function mobileApi(page, requestPath, { method = 'GET', body, csrf = true } = {}) {
  return page.evaluate(
    async ({ requestPath, method, body, csrf }) => {
      const headers = { accept: 'application/json' }
      if (body !== undefined) headers['content-type'] = 'application/json'
      if (csrf && !['GET', 'HEAD'].includes(method)) {
        const token = sessionStorage.getItem('miniagent.remote.csrf') || ''
        if (token) headers['x-csrf-token'] = token
      }
      const response = await fetch(`/api/v1${requestPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store'
      })
      const raw = await response.text()
      let data = null
      if (raw) {
        try {
          data = JSON.parse(raw)
        } catch {
          data = { raw }
        }
      }
      return { status: response.status, body: data }
    },
    { requestPath, method, body, csrf }
  )
}

export async function captureMobile(page, name) {
  const dir = path.resolve('.e2e-artifacts')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  return file
}

export async function closeMobileBrowser(browser) {
  if (browser) await browser.close()
}
