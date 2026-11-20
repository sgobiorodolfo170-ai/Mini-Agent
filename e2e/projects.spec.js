import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchApp, patchOpenDialog, unexpectedErrors } from './helpers'

let ctx

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('项目工作目录', () => {
  it('添加项目、组内新建会话、置顶归组、删除项目后会话回归最近', async () => {
    const win = ctx.win
    await win.getByTestId('nav-chat').waitFor({ timeout: 15000 })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-proj-'))

    // 「+」打开添加项目对话框；选择目录走真实 IPC（主进程 dialog 已打桩）
    await patchOpenDialog(ctx.electronApp, dir)
    await win.getByTestId('project-add').click()
    await win.getByTestId('project-name').fill('测试项目')
    await win.getByTestId('project-pick').click()
    await win.getByTestId('project-confirm').click()
    await win
      .locator('[data-testid="project-item"]', { hasText: '测试项目' })
      .waitFor({ timeout: 10000 })

    // 项目内新建会话 → 会话归入项目分组（整表只有这一条会话）
    await win.locator('[data-testid="project-item"] [data-testid="project-new-conv"]').click()
    await win.locator('[data-testid="project-item"] [data-testid="conv-item"]').first().waitFor()
    expect(await win.locator('[data-testid="conv-item"]').count()).toBe(1)

    // 从项目列表内的会话行置顶 → 会话移入「置顶」组，项目组内清空
    await win.locator('[data-testid="project-item"] [title="置顶/取消置顶"]').click()
    await win.locator('[title="已置顶"]').first().waitFor()
    expect(
      await win.locator('[data-testid="project-item"] [data-testid="conv-item"]').count()
    ).toBe(0)

    // 取消置顶回归项目组
    await win.locator('[title="置顶/取消置顶"]').first().click()
    await win.locator('[data-testid="project-item"] [data-testid="conv-item"]').first().waitFor()

    // 删除项目（需确认）→ 项目行消失，会话回归「最近」
    await win.locator('[title="删除项目"]').click()
    await win.getByText('删除项目「测试项目」？').waitFor()
    await win.getByText('删除', { exact: true }).last().click()
    await win.locator('[data-testid="project-item"]').waitFor({ state: 'detached' })
    await win.locator('[data-testid="conv-item"]').first().waitFor()
    expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
  })

  it('设置页不再有「命令工作目录」，智能任务组显示去向提示', async () => {
    const win = ctx.win
    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-agent').click()
    await win.getByText('命令工作目录已移至会话页「项目」分组').waitFor()
    // 旧输入框已移除（去向提示文字包含该词，需用精确匹配排除）
    expect(await win.getByText('命令工作目录', { exact: true }).count()).toBe(0)
    expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
  })
})
