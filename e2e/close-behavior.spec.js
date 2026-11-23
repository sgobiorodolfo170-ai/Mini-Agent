import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeApp, launchApp, unexpectedErrors } from './helpers'

// 关闭按钮行为：默认隐藏到托盘，可在「设置 → 外观」改为直接退出软件。
let ctx

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

async function traySettingState(win) {
  return win.evaluate(() => window.api.settings.get('closeToTray'))
}

function mainWinAlive(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) =>
      x.webContents.getURL().includes('main-window')
    )
    return !!w && !w.isDestroyed()
  })
}

describe('关闭窗口行为可设置', () => {
  it('默认开启「隐藏到托盘」：点关闭只是隐藏，主窗口不销毁', async () => {
    const { win, electronApp } = ctx
    await win.getByTestId('title-bar').waitFor({ timeout: 15000 })

    // 未写入设置时按默认开启处理
    expect(await traySettingState(win)).toBeUndefined()

    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-appearance').click()
    const checkbox = win.getByTestId('close-to-tray')
    await checkbox.waitFor()
    expect(await checkbox.isChecked()).toBe(true)

    await win.getByTestId('title-close').click()
    await win.waitForTimeout(600)

    // 隐藏而非销毁：托盘/热键仍可再次唤起
    expect(await mainWinAlive(electronApp)).toBe(true)
    expect(
      await electronApp.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) =>
          x.webContents.getURL().includes('main-window')
        )
        return !!w && w.isVisible()
      })
    ).toBe(false)
    // 关闭动作本身不改写设置，保持默认（未显式写入）
    expect(await traySettingState(win)).toBeUndefined()
    expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
  })

  it('关闭该设置后，点关闭走统一回收流程并退出进程', async () => {
    const { win, electronApp } = ctx
    await win.getByTestId('title-bar').waitFor({ timeout: 15000 })
    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-appearance').click()

    const checkbox = win.getByTestId('close-to-tray')
    await checkbox.waitFor()
    await checkbox.uncheck()
    expect(await traySettingState(win)).toBe(false)

    const exited = new Promise((resolve) => {
      const child = electronApp.process()
      child.once('exit', (code, signal) => resolve({ code, signal }))
      // 退出清理卡住时让测试失败可见，而不是无限等待
      setTimeout(() => resolve({ code: null, signal: 'timeout' }), 30000)
    })

    await win.getByTestId('title-close').click()
    const result = await exited
    expect(result.signal).not.toBe('timeout')
    expect(result.code).toBe(0)

    // 进程已自行退出，这里只需关掉 mock 服务，避免句柄泄漏
    await ctx.mock.close()
    ctx = null
  })
})
