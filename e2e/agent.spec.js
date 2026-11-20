import path from 'path'
import fs from 'fs'
import os from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closeApp,
  launchApp,
  patchOpenDialog,
  setupProviderAndKey,
  unexpectedErrors
} from './helpers'

const INPUT = '输入消息，Enter 发送，Shift+Enter 换行'

let ctx

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('Agent 全链路（工具调用 + 分级确认 + 执行日志）', () => {
  it('写文件任务：确认卡片允许后真实落盘，日志可回放', async () => {
    const { electronApp, win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-agent-'))
    await patchOpenDialog(electronApp, dir)
    await win.getByTestId('nav-settings').click()
    // 设置拆为分组导航（F10）：先切到「智能任务」分组
    await win.getByTestId('settings-section-agent').click()
    await win.getByText('+ 添加目录').click()
    await win.getByText(dir).waitFor({ timeout: 15000 })
    mock.state.agentFile = path.join(dir, 'e2e-out.txt')

    await win.getByTestId('nav-chat').click()
    await win.getByTestId('new-conv').click()
    await win.getByTestId('agent-toggle').click()
    await win.getByPlaceholder(INPUT).fill('把结果写入文件')
    await win.keyboard.press('Enter')

    await win.getByText('Agent 请求确认').waitFor({ timeout: 45000 })
    await win.getByText('write_file').first().waitFor({ timeout: 10000 })
    // 主操作文案具体到动作（write_file → 允许写入）
    await win.getByText('允许写入').click()
    await win.getByText('文件已写入，任务完成。').waitFor({ timeout: 45000 })

    expect(fs.readFileSync(mock.state.agentFile, 'utf8')).toBe('E2E写入内容')

    await win.getByTestId('nav-agent').click()
    await win.getByTestId('agent-run').click()
    await win.getByText('write_file').first().waitFor({ timeout: 15000 })
    // 步骤卡参数默认折叠（F17）：写入内容在参数 JSON 中，展开后断言回放
    await win.getByText('参数', { exact: true }).click()
    await win.getByText('E2E写入内容').first().waitFor({ timeout: 15000 })

    expect(unexpectedErrors(consoleErrors)).toEqual([])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
