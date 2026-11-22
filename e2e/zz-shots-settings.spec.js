import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeApp, launchApp, setupProviderAndKey, unexpectedErrors } from './helpers'

const OUT = path.join(process.cwd(), '.e2e-artifacts', 'settings-2026-11-20')

let ctx

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('设置页会话分组视觉', () => {
  it('会话分组：全局采样档位', async () => {
    const { win, mock, consoleErrors } = ctx
    fs.mkdirSync(OUT, { recursive: true })
    await setupProviderAndKey(win, mock.url, 'sk-good')
    await win.evaluate(() => document.documentElement.classList.remove('dark'))

    // 会话设置已改为全局：直接进设置页「会话」分组
    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-chat').click()
    await win.getByTestId('chat-preset-temperature-0.7').click()
    await win.getByTestId('chat-preset-keepTurns-20').click()
    // 等提示 toast 自动消失，避免遮挡标题与说明文字
    await win.waitForTimeout(4600)
    await win.evaluate(() => document.activeElement && document.activeElement.blur())
    await win.screenshot({ path: path.join(OUT, '01-settings-chat.png') })

    // 分组导航：模型服务 / 会话 / 本地嵌入模型 均一次点击可达
    expect(await win.getByTestId('settings-section-chat').count()).toBe(1)
    expect(await win.getByTestId('settings-section-model').count()).toBe(1)

    // 模型参数面板
    await win.getByTestId('settings-section-model').click()
    await win
      .locator('[data-testid="model-chip"]', { hasText: 'mock-model' })
      .first()
      .locator('button[aria-label^="配置模型参数"]')
      .click()
    await win.getByTestId('model-params').waitFor()
    await win.waitForTimeout(4600)
    await win.evaluate(() => document.activeElement && document.activeElement.blur())
    await win.screenshot({ path: path.join(OUT, '02-settings-model-params.png') })

    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})
