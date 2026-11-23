import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeApp, launchApp, unexpectedErrors } from './helpers'

let ctx

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('应用基础', () => {
  it('启动：主窗口渲染导航与输入区，无控制台错误', async () => {
    await ctx.win.getByTestId('nav-chat').waitFor({ timeout: 15000 })
    await ctx.win.getByTestId('new-conv').waitFor()
    await ctx.win.getByPlaceholder('输入“/”使用技能').waitFor()
    expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
  })

  it('会话管理：新建 / 重命名 / 置顶 / 删除（删除需确认）', async () => {
    const win = ctx.win
    await win.getByTestId('new-conv').click()
    const firstRow = win.locator('[data-testid="conv-item"]').first()
    await firstRow.waitFor()

    // 行内「…」菜单是重命名 / 置顶 / 删除的唯一入口
    await firstRow.hover()
    await firstRow.getByRole('button', { name: '会话操作' }).click()
    await win.getByRole('menuitem', { name: '重命名' }).click()
    await win.locator('input.border-b').waitFor({ timeout: 5000 })
    await win.locator('input.border-b').fill('集成会话')
    await win.keyboard.press('Enter')
    await win.locator('[data-testid="conv-item"]', { hasText: '集成会话' }).first().waitFor()

    await firstRow.hover()
    await firstRow.getByRole('button', { name: '会话操作' }).click()
    await win.getByRole('menuitem', { name: '置顶' }).click()
    await expect
      .poll(() =>
        win.evaluate(async () => {
          const list = await window.api.conversations.list()
          return list.find((c) => c.title === '集成会话')?.pinned
        })
      )
      .toBe(1)

    await firstRow.hover()
    await firstRow.getByRole('button', { name: '会话操作' }).click()
    await win.getByRole('menuitem', { name: '删除' }).click()
    // F04：删除进入确认弹窗，取消不落库，确认后才移除
    await win.getByText('删除会话「集成会话」？').waitFor()
    await win.getByText('取消', { exact: true }).click()
    await win.locator('[data-testid="conv-item"]', { hasText: '集成会话' }).first().waitFor()
    await firstRow.hover()
    await firstRow.getByRole('button', { name: '会话操作' }).click()
    await win.getByRole('menuitem', { name: '删除' }).click()
    await win.getByText('删除会话「集成会话」？').waitFor()
    await win.getByText('删除', { exact: true }).last().click()
    await win
      .locator('[data-testid="conv-item"]', { hasText: '集成会话' })
      .waitFor({ state: 'detached' })
    expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
  })

  it('主题切换并持久化（重启后保持）', async () => {
    await ctx.win.getByTestId('nav-chat').waitFor()
    const isDark = () => ctx.win.evaluate(() => document.documentElement.classList.contains('dark'))
    await ctx.win.waitForFunction(() => document.documentElement.classList.contains('dark'), null, {
      timeout: 10000
    })
    expect(await isDark()).toBe(true)

    await ctx.win.locator('[title^="主题"]').click()
    expect(await isDark()).toBe(false)

    const userData = ctx.userData
    await closeApp(ctx.electronApp, ctx.mock)
    ctx = null

    const second = await launchApp({ reuseUserData: userData })
    await second.win.getByTestId('nav-chat').waitFor()
    const isDark2 = () =>
      second.win.evaluate(() => document.documentElement.classList.contains('dark'))
    expect(await isDark2()).toBe(false)
    await closeApp(second.electronApp, second.mock)
  })
})
