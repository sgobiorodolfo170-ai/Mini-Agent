import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeApp, launchApp, setupProviderAndKey, startChat, unexpectedErrors } from './helpers'

let ctx

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('对话全链路（真实 UI → IPC → 网关 → mock 模型服务）', () => {
  it('配置供应商+Key → 探测 ok → 流式对话完成', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')

    await win.getByText('一键探测').click()
    // Key 状态改为中文徽标（F21）：ok → 正常
    await win.getByText('正常', { exact: true }).first().waitFor({ timeout: 15000 })

    await startChat(win, '你好')
    await win.getByText('E2E模拟回复').waitFor({ timeout: 25000 })
    await win.getByText('生成中…').waitFor({ state: 'detached', timeout: 20000 })

    expect(mock.state.requests.some((r) => r.path.includes('/chat/completions'))).toBe(true)
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

  it('当前 Key 429 自动切换下一把，回答不受影响', async () => {
    const { win, mock } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-bad')
    mock.state.failKeys.add('sk-bad')

    await win.getByText('添加 Key', { exact: true }).click()
    await win.getByPlaceholder('备注（可选）').fill('好Key')
    await win.getByPlaceholder('sk-...').fill('sk-good')
    await win.getByTestId('k-save').click()

    await startChat(win, '问题一句话')
    await win.getByText('E2E模拟回复').waitFor({ timeout: 30000 })

    const chatReqs = mock.state.requests.filter(
      (r) => r.path.includes('/chat/completions') && r.body.stream
    )
    expect(chatReqs.length).toBeGreaterThanOrEqual(2)
    expect(chatReqs[0].auth).toBe('Bearer sk-bad')
    expect(chatReqs[chatReqs.length - 1].auth).toBe('Bearer sk-good')
  })

  it('停止生成：流式中点击停止后消息标记已停止', async () => {
    const { win, mock } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    mock.state.mode = 'hang'

    await startChat(win, '一个很长的回答')
    await win.getByText('停止', { exact: true }).waitFor({ timeout: 20000 })
    await win.getByText('停止', { exact: true }).click()
    await win.getByText('已停止').waitFor({ timeout: 20000 })
    await win.getByText('部分回答').waitFor({ timeout: 10000 })

    mock.state.mode = 'normal'
  })

  it('重新生成：旧回复被替换为新回答', async () => {
    const { win } = ctx
    await setupProviderAndKey(win, ctx.mock.url, 'sk-good')

    await startChat(win, '你好')
    await win.getByText('E2E模拟回复').waitFor({ timeout: 25000 })
    await win.getByText('生成中…').waitFor({ state: 'detached', timeout: 20000 })

    await win.getByText('重新生成').click()
    await win.getByText('生成中…').waitFor({ state: 'detached', timeout: 25000 })
    expect(await win.getByText('E2E模拟回复').count()).toBe(1)
  })

  it('重启后：供应商/Key/会话/消息全部持久化', async () => {
    await setupProviderAndKey(ctx.win, ctx.mock.url, 'sk-good')
    await startChat(ctx.win, '持久化问题')
    await ctx.win.getByText('E2E模拟回复').waitFor({ timeout: 25000 })
    // 等 done 落库（delta 已完整渲染但 done 事件可能滞后；不等的话关闭会留 streaming 僵尸消息）
    await ctx.win.getByText('生成中…').waitFor({ state: 'detached', timeout: 20000 })
    const userData = ctx.userData
    await closeApp(ctx.electronApp, ctx.mock)
    ctx = null

    const second = await launchApp({ reuseUserData: userData })
    await second.win.getByText('新会话', { exact: true }).first().waitFor({ timeout: 15000 })
    await second.win.getByTestId('nav-settings').click()
    await second.win.getByTestId('provider-name').waitFor({ timeout: 15000 })
    await second.win.getByTestId('nav-chat').click()
    // 显式点击侧栏会话（启动自动恢复是异步竞态；真实用户行为是点击会话项查看历史）
    await second.win.getByText('新会话', { exact: true }).first().click()
    await second.win.getByText('E2E模拟回复').waitFor({ timeout: 30000 })
    await closeApp(second.electronApp, second.mock)
  })
})
