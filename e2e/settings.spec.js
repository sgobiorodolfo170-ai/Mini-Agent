import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeApp, launchApp, setupProviderAndKey, unexpectedErrors } from './helpers'

let ctx

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('设置页「会话」分组（会话设置迁入）', () => {
  it('会话分组是全局设置：无「当前会话」选择器，也无按会话字段', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')

    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-chat').click()
    // 全局采样字段就位
    await win.getByTestId('chat-field-temperature').waitFor()

    // 不再有「当前会话」选择器（会话设置是全局的，不针对单个会话）
    expect(await win.getByTestId('chat-conv-pick').count()).toBe(0)
    expect(await win.getByText('当前会话', { exact: true }).count()).toBe(0)

    // 按会话的字段均已移除
    for (const t of ['所属项目', '供应商', '系统提示词', '默认供应商', '默认模型']) {
      expect(await win.getByText(t, { exact: true }).count()).toBe(0)
    }
    // 最大输出长度 / 上下文上限属于模型参数，不在会话分组
    expect(await win.getByText('最大输出长度', { exact: true }).count()).toBe(0)
    expect(await win.getByText('上下文上限（字符）', { exact: true }).count()).toBe(0)

    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

  it('随机性 / 核采样 / 保留轮数提供档位推荐，点击写入全局设置', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')

    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-chat').click()

    // 三个档位组都存在（各 3 档）
    for (const field of ['temperature', 'topP', 'keepTurns']) {
      const btns = win.locator(`[data-testid^="chat-preset-${field}-"]`)
      expect(await btns.count()).toBe(3)
    }

    // 点「严谨」档 → 全局 chatSampling.temperature 落库
    await win.getByTestId('chat-preset-temperature-0.2').click()
    await win.waitForTimeout(300)
    const readSampling = () => win.evaluate(() => window.api.settings.get('chatSampling'))
    expect((await readSampling()).temperature).toBe(0.2)

    // 切到「发散」档覆盖同一字段
    await win.getByTestId('chat-preset-temperature-1.1').click()
    await win.waitForTimeout(300)
    expect((await readSampling()).temperature).toBe(1.1)

    // 数值输入与档位共用同一字段
    await win.getByTestId('chat-input-keepTurns').fill('35')
    await win.getByTestId('chat-input-keepTurns').blur()
    await win.waitForTimeout(300)
    expect((await readSampling()).keepTurns).toBe(35)

    // 恢复默认清空全部全局采样参数
    await win.getByTestId('chat-sampling-reset').click()
    await win.waitForTimeout(300)
    expect(await readSampling()).toEqual({})

    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

  it('最大输出长度 / 上下文上限在供应商卡片的模型参数中保存', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')

    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-model').click()
    // 打开模型参数（模型 chip 上的齿轮）
    await win
      .locator('[data-testid="model-chip"]', { hasText: 'mock-model' })
      .first()
      .locator('button[aria-label^="配置模型参数"]')
      .click()
    await win.getByTestId('model-params').waitFor()
    await win.getByTestId('model-max-tokens').fill('256')
    await win.getByTestId('model-max-chars').fill('4000')
    await win.getByTestId('p-save').click()

    // 重新打开：参数已随供应商落库
    await win.getByText('编辑', { exact: true }).first().click()
    const providers = await win.evaluate(() => window.api.providers.list())
    const model = providers[0].models.find((m) => m.id === 'mock-model')
    expect(model.maxTokens).toBe(256)
    expect(model.maxChars).toBe(4000)

    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})
