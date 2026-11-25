/* global window, document, localStorage, sessionStorage, Event, URL */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeApp, launchApp, setupProviderAndKey, unexpectedErrors } from './helpers'
import {
  captureMobile,
  closeMobileBrowser,
  createMobileContext,
  installMobileSocketControl,
  launchMobileBrowser
} from './mobile-helpers'

let ctx
let browser
let mobile

async function expectVisible(locator, timeout = 10000) {
  await locator.waitFor({ state: 'visible', timeout })
  expect(await locator.isVisible()).toBe(true)
}

async function expectText(locator, expected, timeout = 10000) {
  await expect
    .poll(async () => (await locator.textContent()) || '', { timeout })
    .toContain(expected)
}

async function expectAttribute(locator, name, value, timeout = 10000) {
  await expect.poll(() => locator.getAttribute(name), { timeout }).toBe(value)
}

async function prepareRemote(title) {
  const { win } = ctx
  await setupProviderAndKey(win, ctx.mock.url, 'sk-good')
  const conversation = await win.evaluate(
    (name) => window.api.conversations.create({ title: name }),
    title
  )
  const remote = await win.evaluate(async () => {
    await window.api.settings.set('syncEnabled', true)
    const state = await window.api.remote.start({
      host: '127.0.0.1',
      port: 0,
      transport: 'tls'
    })
    const qr = await window.api.remote.qrcode()
    return { state, qr }
  })
  return { conversation, remote }
}

beforeEach(async () => {
  ctx = await launchApp()
  browser = await launchMobileBrowser()
})

afterEach(async () => {
  await closeMobileBrowser(browser)
  browser = null
  mobile = null
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('手机远程控制 UI E2E', () => {
  it('手机视口完成手动配对、会话消息、刷新恢复与四个页签验收', async () => {
    const { conversation, remote } = await prepareRemote('手机 UI 在线会话')
    mobile = await createMobileContext(browser, 'android')
    const { page, consoleErrors, httpErrors } = mobile
    const origin = new URL(remote.qr.url).origin
    const ticket = new URL(remote.qr.url).hash.replace('#ticket=', '')

    await page.goto(`${origin}/pair`, { waitUntil: 'domcontentloaded' })
    await page.getByTestId('remote-phase-pairing').waitFor()
    await captureMobile(page, 'mobile-pairing')
    await page.getByTestId('remote-pair-ticket').fill(ticket)
    await page.getByTestId('remote-pair-name').fill('Pixel 9 验收机')
    await page.getByTestId('remote-pair-submit').click()

    await page.getByTestId('remote-phase-app').waitFor({ timeout: 20000 })
    await page.getByTestId('remote-connection').filter({ hasText: '已连接' }).waitFor()
    expect(page.url()).not.toContain('ticket=')
    expect(await page.getByRole('tab').count()).toBe(4)
    await expectText(page.getByTestId('remote-conversation'), conversation.title)

    const onlineText = '手机在线消息：你好，桌面端。'
    await page.getByTestId('remote-chat-input').fill(onlineText)
    await page.getByTestId('remote-chat-send').click()
    const onlineMessage = page
      .locator('[data-testid^="remote-message-"]')
      .filter({ hasText: onlineText })
    await expectVisible(onlineMessage)
    await expectAttribute(onlineMessage, 'data-status', 'sent')
    await expectVisible(page.getByText('你好！这是E2E模拟回复。', { exact: true }), 20000)

    await page.getByTestId('remote-tab-runs').click()
    await expectVisible(page.getByText('任务列表', { exact: true }))
    await page.getByTestId('remote-tab-approvals').click()
    await expectVisible(page.getByText('待审批（0）', { exact: true }))
    await page.getByTestId('remote-tab-device').click()
    await expectVisible(page.getByTestId('remote-device-panel'))
    await expectText(page.getByTestId('remote-transport'), 'wss')
    await expectText(page.getByTestId('remote-device-panel'), 'Pixel 9 验收机')

    await page.getByTestId('remote-tab-chat').click()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByTestId('remote-phase-app').waitFor({ timeout: 20000 })
    await expectVisible(page.getByText(onlineText, { exact: true }))
    await expectVisible(page.getByText('你好！这是E2E模拟回复。', { exact: true }))

    await page.setViewportSize({ width: 320, height: 568 })
    const width = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth
    }))
    expect(width.scroll).toBeLessThanOrEqual(width.client + 1)
    await captureMobile(page, 'mobile-chat-320')
    expect(unexpectedErrors(consoleErrors)).toEqual([])
    expect(httpErrors).toEqual([])
  }, 120000)

  it('断线消息持久化并在重连后按原请求 ID 自动补发，刷新不重复', async () => {
    const { remote } = await prepareRemote('手机 UI 离线会话')
    mobile = await createMobileContext(browser, 'iphone')
    const { context, page, consoleErrors, httpErrors } = mobile
    await installMobileSocketControl(context)
    await page.goto(remote.qr.url, { waitUntil: 'domcontentloaded' })
    await page.getByTestId('remote-phase-app').waitFor({ timeout: 20000 })
    await page.getByTestId('remote-connection').filter({ hasText: '已连接' }).waitFor()

    await page.evaluate(() => {
      window.__miniAgentSocketOffline = true
      for (const socket of window.__miniAgentSockets) socket.close(1000, 'e2e offline')
    })
    await expect
      .poll(async () => (await page.getByTestId('remote-connection').textContent()) || '')
      .toMatch(/重连中|未连接/)
    const offlineText = '手机离线消息：重连后只能送达一次。'
    await page.getByTestId('remote-chat-input').fill(offlineText)
    await page.getByTestId('remote-chat-send').click()
    const queued = page.locator('[data-testid^="remote-message-"]').filter({ hasText: offlineText })
    await expectAttribute(queued, 'data-status', 'queued')
    await expectText(page.getByTestId('remote-connection'), '待同步 1')
    const queuedState = await page.evaluate(() => ({
      queue: JSON.parse(localStorage.getItem('miniagent_remote_offline_v1') || '[]'),
      credentials: Boolean(
        sessionStorage.getItem('miniagent.remote.deviceId') &&
        sessionStorage.getItem('miniagent.remote.deviceSecret')
      )
    }))
    expect(queuedState.queue).toHaveLength(1)
    expect(queuedState.queue[0]).toMatchObject({
      type: 'chat.message.send',
      payload: { content: offlineText }
    })
    expect(queuedState.credentials).toBe(true)
    await captureMobile(page, 'mobile-offline-queue')

    await page.evaluate(() => {
      window.__miniAgentSocketOffline = false
      window.dispatchEvent(new Event('focus'))
    })
    await expectAttribute(queued, 'data-status', 'sent', 20000)
    await expect
      .poll(async () => (await page.getByTestId('remote-connection').textContent()) || '', {
        timeout: 20000
      })
      .not.toContain('待同步')
    await expectVisible(page.getByText('你好！这是E2E模拟回复。', { exact: true }), 20000)
    const delivered = ctx.mock.state.requests
      .filter((request) => request.path.endsWith('/chat/completions'))
      .flatMap((request) => request.body.messages || [])
      .filter((message) => message.role === 'user' && message.content === offlineText)
    expect(delivered).toHaveLength(1)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByTestId('remote-phase-app').waitFor({ timeout: 20000 })
    await expect
      .poll(
        async () =>
          await page
            .locator('[data-testid^="remote-message-"]')
            .filter({ hasText: offlineText })
            .count(),
        { timeout: 20000 }
      )
      .toBe(1)
    expect(
      await page.evaluate(() =>
        JSON.parse(localStorage.getItem('miniagent_remote_offline_v1') || '[]')
      )
    ).toEqual([])
    await captureMobile(page, 'mobile-reconnected')
    expect(unexpectedErrors(consoleErrors)).toEqual([])
    expect(httpErrors).toEqual([])
  }, 120000)
})
