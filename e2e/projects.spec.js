import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  closeApp,
  launchApp,
  patchOpenDialog,
  setupProviderAndKey,
  unexpectedErrors
} from './helpers'

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
    await win.getByTestId('project-workspace-index').uncheck()
    await win.getByTestId('project-name').fill('测试项目')
    await win.getByTestId('project-pick').click()
    await win.getByTestId('project-verify-command').fill('npm test')
    await win.getByTestId('project-conflict-strategy').selectOption('theirs')
    await win.screenshot({ path: '.e2e-artifacts/p8-project-verify-dialog.png' })
    await win.getByTestId('project-confirm').click()
    await win
      .locator('[data-testid="project-item"]', { hasText: '测试项目' })
      .waitFor({ timeout: 10000 })
    expect(
      await win.evaluate(async () => {
        const projects = await window.api.projects.list()
        return projects.find((project) => project.name === '测试项目')?.workspaceVerifyCommand
      })
    ).toBe('npm test')
    expect(
      await win.evaluate(async () => {
        const projects = await window.api.projects.list()
        return projects.find((project) => project.name === '测试项目')?.workspaceConflictStrategy
      })
    ).toBe('theirs')

    // 项目内新建会话 → 会话归入项目分组（整表只有这一条会话）
    await win.locator('[data-testid="project-item"] [data-testid="project-new-conv"]').click()
    await win.locator('[data-testid="project-item"] [data-testid="conv-item"]').first().waitFor()
    expect(await win.locator('[data-testid="conv-item"]').count()).toBe(1)

    // 从项目列表内的会话行置顶 → 会话移入「置顶」组，项目组内清空
    const projectConv = win
      .locator('[data-testid="project-item"]', { hasText: '测试项目' })
      .locator('[data-testid="conv-item"]')
      .first()
    await projectConv.hover()
    await projectConv.getByRole('button', { name: '会话操作' }).click()
    await win.getByRole('menuitem', { name: '置顶' }).click()
    await expect
      .poll(() =>
        win.evaluate(async () => {
          const list = await window.api.conversations.list()
          return list[0]?.pinned
        })
      )
      .toBe(1)
    expect(
      await win.locator('[data-testid="project-item"] [data-testid="conv-item"]').count()
    ).toBe(0)

    // 取消置顶回归项目组
    const pinnedRow = win.locator('[data-testid="conv-item"]').first()
    await pinnedRow.hover()
    await pinnedRow.getByRole('button', { name: '会话操作' }).click()
    await win.getByRole('menuitem', { name: '取消置顶' }).click()
    await win.locator('[data-testid="project-item"] [data-testid="conv-item"]').first().waitFor()

    // 删除项目（需确认）→ 项目行消失，会话回归「最近」
    const projectRow = win.locator('[data-testid="project-item"]', { hasText: '测试项目' })
    await projectRow.hover()
    await projectRow.getByRole('button', { name: '项目操作', exact: true }).click()
    await win.getByRole('menuitem', { name: '删除项目' }).click()
    await win.getByText('删除项目「测试项目」？').waitFor()
    await win.getByText('删除', { exact: true }).last().click()
    await win.locator('[data-testid="project-item"]').waitFor({ state: 'detached' })
    await win.locator('[data-testid="conv-item"]').first().waitFor()
    expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
  })

  it('创建工作区索引后，知识库入库且 Agent 自动检索项目源码', async () => {
    const { win, mock } = ctx
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-indexed-project-'))
    try {
      fs.mkdirSync(path.join(dir, 'src'))
      fs.writeFileSync(
        path.join(dir, 'README.md'),
        '# WORKSPACE_INDEX_MARKER\n\n项目索引入口与架构说明。'
      )
      fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const indexed = true')
      await setupProviderAndKey(win, mock.url, 'sk-good')

      await win.getByTestId('nav-kb').click()
      await win.getByTestId('kb-create-open').click()
      await win.getByTestId('kb-name').fill('Embedding配置')
      await win.getByTestId('kb-provider').selectOption({ label: 'Mock中转' })
      await win.getByPlaceholder('Embedding 模型名（如 text-embedding-3-small）').fill('emb-1')
      await win.getByText('创建知识库').click()
      await win.getByText('Embedding配置').first().waitFor()

      await win.getByTestId('nav-chat').click()
      await patchOpenDialog(ctx.electronApp, dir)
      await win.getByTestId('project-add').click()
      expect(await win.getByTestId('project-workspace-index').isChecked()).toBe(true)
      expect(
        await win
          .getByText('建立工作区索引可增强上下文理解能力，从而提升智能体回复准确性。')
          .isVisible()
      ).toBe(true)
      await win.getByTestId('project-name').fill('已索引项目')
      await win.getByTestId('project-pick').click()
      await win.getByTestId('project-worktree').uncheck()
      await win.screenshot({ path: '.e2e-artifacts/workspace-index-project-dialog.png' })
      await win.getByTestId('project-confirm').click()
      await win.locator('[data-testid="project-item"]', { hasText: '已索引项目' }).waitFor()

      await expect
        .poll(
          () =>
            win.evaluate(async () => {
              const kbs = await window.api.kb.list()
              const kb = kbs.find((item) => item.kind === 'workspace')
              if (!kb) return null
              const docs = await window.api.kb.docs(kb.id)
              return { stats: kb.stats, statuses: docs.map((doc) => doc.status) }
            }),
          { timeout: 45000 }
        )
        .toEqual({ stats: { docs: 2, chunks: 2 }, statuses: ['ready', 'ready'] })

      const run = await win.evaluate(async () => {
        const projects = await window.api.projects.list()
        const project = projects.find((item) => item.name === '已索引项目')
        const conversation = await window.api.conversations.create({
          title: '工作区索引验收',
          projectId: project.id
        })
        return window.api.agent.run({
          conversationId: conversation.id,
          goal: 'WORKSPACE_INDEX_MARKER 的项目架构说明是什么？',
          permission: 'readonly'
        })
      })
      await expect
        .poll(() => win.evaluate((runId) => window.api.agent.result({ runId }), run.runId), {
          timeout: 30000
        })
        .toMatchObject({ status: 'done', content: '已根据项目工作区索引回答。' })

      const request = mock.state.requests
        .filter((item) => item.path.endsWith('/chat/completions') && item.body.stream)
        .map((item) => item.body)
        .find((body) =>
          body.messages.some((message) =>
            String(message.content || '').includes('WORKSPACE_INDEX_MARKER')
          )
        )
      expect(request).toBeTruthy()
      expect(request.tools.map((tool) => tool.function.name)).toContain('search_workspace_index')

      await expect
        .poll(
          () =>
            win.evaluate(async () => {
              const kb = (await window.api.kb.list()).find((item) => item.kind === 'workspace')
              return kb?.stats?.docs
            }),
          { timeout: 45000 }
        )
        .toBe(2)

      await win.getByTestId('nav-kb').click()
      await win.getByText('已索引项目 · 工作区索引').first().click()
      await win.getByText('项目文件自动维护').waitFor()
      await win.getByText('2 文档 · 2 分块 · 工作区索引', { exact: false }).waitFor()
      await expect.poll(() => win.locator('[data-testid="kb-doc-row"]').count()).toBe(2)
      await win.screenshot({ path: '.e2e-artifacts/workspace-index-kb.png' })
      expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('取消创建工作区索引时不会生成知识库', async () => {
    const { win } = ctx
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-unindexed-project-'))
    try {
      await patchOpenDialog(ctx.electronApp, dir)
      await win.getByTestId('project-add').click()
      await win.getByTestId('project-workspace-index').uncheck()
      await win.getByTestId('project-name').fill('无索引项目')
      await win.getByTestId('project-pick').click()
      await win.getByTestId('project-confirm').click()
      await win.locator('[data-testid="project-item"]', { hasText: '无索引项目' }).waitFor()
      const state = await win.evaluate(async () => {
        const projects = await window.api.projects.list()
        const kbs = await window.api.kb.list()
        return {
          project: projects.find((item) => item.name === '无索引项目'),
          workspaceKbs: kbs.filter((kb) => kb.kind === 'workspace')
        }
      })
      expect(state.project.workspaceIndexKbId).toBeNull()
      expect(state.workspaceKbs).toEqual([])
      expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
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
