import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeApp, launchApp, unexpectedErrors } from './helpers'

// 截图遮罩的取消路径：Esc 与鼠标右键都必须关闭遮罩窗口且不产生附件。
// 遮罩窗口是独立 BrowserWindow，Playwright 偶尔会拿到过期句柄，
// 因此这里用 electronApp 主进程视角判断窗口存在与否，键盘事件通过主窗口转发。
let ctx

function captureWindow(app) {
  for (const w of app.windows()) {
    if (w.url().includes('entries/screen-capture') && !w.isClosed()) return w
  }
  return null
}

async function openCapture(win) {
  await win.evaluate(() => window.api.app.captureStart())
  for (let i = 0; i < 60; i++) {
    const w = captureWindow(ctx.electronApp)
    if (w) {
      try {
        await w.waitForLoadState('domcontentloaded', { timeout: 2000 })
        if (!w.isClosed()) return w
      } catch {
        // 句柄已失效，继续等待
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('capture window not opened')
}

async function captureGone(app) {
  for (let i = 0; i < 50; i++) {
    if (!captureWindow(app)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

// 在主进程里向遮罩窗口发送真实输入事件，避免依赖 Playwright 的页面句柄
async function pressInCapture(app, key) {
  await app.evaluate(({ BrowserWindow, screen }, k) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      (w.webContents.getURL() || '').includes('entries/screen-capture')
    )
    if (!win) throw new Error('capture window missing')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k })
  }, key)
}

// 右键通过真实鼠标事件注入（button: 'right'），定位用窗口内坐标
async function rightClickInCapture(app, x, y) {
  await app.evaluate(
    ({ BrowserWindow }, pt) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        (w.webContents.getURL() || '').includes('entries/screen-capture')
      )
      if (!win) throw new Error('capture window missing')
      win.webContents.sendInputEvent({
        type: 'mouseDown',
        x: pt.x,
        y: pt.y,
        button: 'right',
        clickCount: 1
      })
      win.webContents.sendInputEvent({
        type: 'mouseUp',
        x: pt.x,
        y: pt.y,
        button: 'right',
        clickCount: 1
      })
    },
    { x, y }
  )
}

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('截图取消（Esc / 右键）', () => {
  it('Esc 取消：遮罩关闭且不产生附件', async () => {
    const { win } = ctx
    await win.getByTestId('nav-chat').waitFor({ timeout: 15000 })
    await openCapture(win)

    await pressInCapture(ctx.electronApp, 'Escape')
    expect(await captureGone(ctx.electronApp)).toBe(true)
    expect(await win.getByTestId('composer-attachment').count()).toBe(0)
    expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
  })

  it('鼠标右键取消：遮罩关闭且不产生附件', async () => {
    const { win } = ctx
    await win.getByTestId('nav-chat').waitFor({ timeout: 15000 })
    await openCapture(win)

    // 在遮罩任意位置按下右键（不是左键拖拽）
    await rightClickInCapture(ctx.electronApp, 300, 300)
    expect(await captureGone(ctx.electronApp)).toBe(true)
    expect(await win.getByTestId('composer-attachment').count()).toBe(0)
    expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
  })
})
