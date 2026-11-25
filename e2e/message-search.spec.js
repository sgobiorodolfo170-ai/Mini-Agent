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

describe('对话全文检索', () => {
  it('跨会话检索中文消息并定位高亮，短词回退与保留字符安全', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    const seeded = await win.evaluate(async () => {
      const first = await window.api.conversations.create({ title: '报销会话' })
      const second = await window.api.conversations.create({ title: '差旅会话' })
      await window.api.chat.send({
        conversationId: first.id,
        content: '报销流程怎么走？请提交发票。'
      })
      await window.api.chat.send({ conversationId: second.id, content: '差旅规范与住宿标准' })
      return { firstId: first.id, secondId: second.id }
    })

    await win.getByTestId('nav-chat').click()
    await win.getByTestId('conv-search-mode').click()
    await win.getByTestId('conv-search').fill('报销流程')
    const result = win.locator('[data-testid^="message-search-result-"]').first()
    await result.waitFor()
    expect(await result.innerText()).toContain('报销会话')
    await result.click()
    expect(
      await win.locator('[data-msg-id]').filter({ hasText: '报销流程怎么走' }).isVisible()
    ).toBe(true)
    expect(
      await win.locator('.bg-brand-soft.ring-2').filter({ hasText: '报销流程怎么走' }).isVisible()
    ).toBe(true)

    await win.getByTestId('conv-search').fill('报销')
    expect(
      await win.locator('[data-testid^="message-search-result-"]').first().innerText()
    ).toContain('报销会话')
    await win.getByTestId('conv-search').fill('" OR 1=1 --')
    await expect
      .poll(() => win.getByText('无匹配消息', { exact: true }).isVisible(), { timeout: 5000 })
      .toBe(true)
    expect(seeded.firstId).not.toBe(seeded.secondId)
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})
