import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeApp, launchApp } from './helpers'

// 调试用：默认跳过，避免常规 e2e 白跑一遍且污染输出。
// 需要排查截屏窗口生命周期时：DEBUG_CAPTURE=1 npx vitest run e2e/zz-debug-capture.spec.js
const enabled = process.env.DEBUG_CAPTURE === '1'

let ctx

function listWindows(app) {
  return app.windows().map((w) => ({ url: w.url(), closed: w.isClosed() }))
}

beforeEach(async () => {
  if (!enabled) return
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe.skipIf(!enabled)('debug capture lifecycle', () => {
  it('trace', async () => {
    const { win } = ctx
    await win.getByTestId('nav-chat').waitFor({ timeout: 15000 })
    console.log('before', JSON.stringify(listWindows(ctx.electronApp)))
    await win.evaluate(() => window.api.app.captureStart())
    for (let i = 0; i < 30; i++) {
      console.log(i, JSON.stringify(listWindows(ctx.electronApp)))
      await new Promise((r) => setTimeout(r, 150))
    }
    expect(true).toBe(true)
  })
})
