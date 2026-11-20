import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'

import { closeApp, launchApp, setupProviderAndKey, unexpectedErrors } from './helpers'

// 胶水层冒烟：单元测试测不到的 Electron 主进程装配（窗口/托盘环境/全局快捷键/
// safeStorage 落盘），在真实应用里做最小断言。
let ctx

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('Electron 胶水层（窗口 / 快捷键 / 落盘加密）', () => {
  it('启动窗口清单：主窗口 + 悬浮球；测试模式不注册全局快捷键', async () => {
    const urls = await ctx.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => w.webContents.getURL())
    )
    expect(urls.some((u) => u.includes('entries/main-window'))).toBe(true)
    expect(urls.some((u) => u.includes('entries/floating-ball'))).toBe(true)

    const registered = await ctx.electronApp.evaluate(({ globalShortcut }) => ({
      quick: globalShortcut.isRegistered('Alt+Space'),
      selection: globalShortcut.isRegistered('Alt+Q'),
      capture: globalShortcut.isRegistered('Alt+S')
    }))
    expect(Object.values(registered).some(Boolean)).toBe(false)
    expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
  })

  it('hotkeys:set 经 IPC 注册全局快捷键并生效，重置后全部注销', async () => {
    const report = await ctx.win.evaluate((m) => window.api.app.setHotkeys(m), {
      quick: 'Ctrl+Alt+F9',
      selection: '',
      capture: ''
    })
    expect(report.quick.ok).toBe(true)
    expect(report.selection.ok).toBe(false) // 未设置

    expect(
      await ctx.electronApp.evaluate(({ globalShortcut }) =>
        globalShortcut.isRegistered('Ctrl+Alt+F9')
      )
    ).toBe(true)

    // 重置为空映射 → unregisterAll
    await ctx.win.evaluate(() =>
      window.api.app.setHotkeys({ quick: '', selection: '', capture: '' })
    )
    expect(
      await ctx.electronApp.evaluate(({ globalShortcut }) =>
        globalShortcut.isRegistered('Ctrl+Alt+F9')
      )
    ).toBe(false)
    expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
  })

  it('Key 落盘加密：api_keys.secret_enc 以 enc: 前缀存储（真实 DPAPI）', async () => {
    await setupProviderAndKey(ctx.win, ctx.mock.url, 'sk-e2e-glue-key')
    const userData = ctx.userData
    await closeApp(ctx.electronApp, ctx.mock)
    ctx = null

    const db = new DatabaseSync(path.join(userData, 'miniagent.db'))
    try {
      const rows = db.prepare('SELECT secret_enc FROM api_keys WHERE deleted_at IS NULL').all()
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) expect(String(r.secret_enc).startsWith('enc:')).toBe(true)
    } finally {
      db.close()
    }
  })
})
