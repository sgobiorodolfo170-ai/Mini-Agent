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

describe('供应商配置与模型拉取（用户便携版反馈路径）', () => {
  it('创建供应商后加 Key、未点保存直接拉取模型（用户真实操作路径）', async () => {
    const { win, mock, consoleErrors } = ctx
    await win.getByTestId('nav-settings').click()
    // 创建对话框：取消新增不落库；此处直接创建（名称+地址）
    await win.getByTestId('provider-add').click()
    await win.getByTestId('p-name').fill('我的中转')
    await win.getByTestId('p-url').fill(mock.url)
    await win.getByTestId('p-create').click()
    await win.getByText('编辑', { exact: true }).first().click()
    await win.getByTestId('k-add-toggle').click()
    await win.getByTestId('k-secret').fill('sk-good')
    await win.getByTestId('k-save').click()
    await win.waitForTimeout(500)

    // 不点「保存供应商」，直接拉取模型——必须用编辑面板里的 URL 而不是数据库旧值
    await win.getByTestId('model-pull').click()
    await win
      .locator('[data-testid="pulled-item"]', { hasText: 'mock-model' })
      .waitFor({ timeout: 15000 })
    await win
      .locator('[data-testid="pulled-item"]', { hasText: 'mock-model' })
      .locator('input[type=checkbox]')
      .check()
    await win.getByTestId('model-add').click()
    await win
      .locator('[data-testid="model-chip"]', { hasText: 'mock-model' })
      .first()
      .waitFor({ timeout: 15000 })

    // 落盘后再拉取一次也应正常（回归路径）
    await win.getByTestId('p-save').click()
    await win.getByText('编辑', { exact: true }).first().click()
    await win.getByTestId('k-probe-all').click()
    // Key 状态改为中文徽标（F21）：ok → 正常
    await win.getByText('正常', { exact: true }).first().waitFor({ timeout: 15000 })
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

  it('保存后拉取模型 + 单 Key 探测走真实鉴权头', async () => {
    const { win, mock } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    // mock 拦截 [object 形态的坏鉴权头；此处断言拉取请求带真实 Key
    const badAuth = mock.state.requests.filter((r) => r.auth.includes('[object'))
    expect(badAuth).toEqual([])
    expect(
      mock.state.requests.some((r) => r.path.endsWith('/models') && r.auth === 'Bearer sk-good')
    ).toBe(true)
  })
})
