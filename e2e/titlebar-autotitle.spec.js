import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeApp, launchApp, setupProviderAndKey, startChat, unexpectedErrors } from './helpers'

// 自绘标题栏 + 会话自动命名（第一轮提示词优化后作为标题）的端到端验证。
let ctx

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('自绘标题栏', () => {
  it('标题栏存在、背景与左侧导航一致、窗口控制按钮齐备', async () => {
    const { win } = ctx
    const bar = win.getByTestId('title-bar')
    await bar.waitFor({ timeout: 15000 })
    await bar.getByLabel('最小化窗口').waitFor()
    await bar.getByLabel('最大化窗口').waitFor()
    await bar.getByLabel('关闭窗口（隐藏到托盘）').waitFor()

    // 标题栏背景取 --bg-chrome，与左侧导航（bg-chrome）完全一致
    const bg = await bar.evaluate((el) => getComputedStyle(el).backgroundColor)
    const nav = await win
      .locator('nav[aria-label="主导航"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(bg).toBe(nav)
    expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
  })

  it('最大化切换：主窗口最大化后图标切为还原，点按钮可还原', async () => {
    const { win, electronApp } = ctx
    const bar = win.getByTestId('title-bar')
    await bar.waitFor({ timeout: 15000 })
    const mainWin = () =>
      electronApp.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) =>
          x.webContents.getURL().includes('main-window')
        )
        return w && !w.isDestroyed()
      })
    expect(await mainWin()).toBe(true)
    await electronApp.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) =>
        x.webContents.getURL().includes('main-window')
      )
      w.maximize()
    })
    await win.waitForFunction(
      () => document.querySelector('[aria-label="还原窗口"]') !== null,
      null,
      { timeout: 5000 }
    )
    const isMax = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('main-window'))
        .isMaximized()
    )
    expect(isMax).toBe(true)
    // 点击还原按钮回到窗口化
    await win.getByLabel('还原窗口').click()
    await win.waitForFunction(
      () => document.querySelector('[aria-label="最大化窗口"]') !== null,
      null,
      { timeout: 5000 }
    )
  })
})

describe('会话自动命名（第一轮提示词优化后作为标题）', () => {
  it('首轮消息后侧栏标题变为优化后标题（非原文、非「新会话」）', async () => {
    const { win, mock } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    await startChat(win, '帮我把这周的工作整理成周报')

    // e2e 测试模式走回退：原文压缩截断作为标题；流式回复正常完成
    await win.getByText('E2E模拟回复').waitFor({ timeout: 25000 })
    const row = win.locator('[data-testid="conv-item"]').first()
    await row.waitFor({ timeout: 15000 })
    const title = await row.locator('span').first().textContent()
    expect(title).not.toBe('新会话')
    expect(title).toContain('周报')
  })
})
