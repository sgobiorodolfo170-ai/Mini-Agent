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

const INPUT = '输入“/”使用技能'

let ctx

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('知识库 RAG 全链路', () => {
  it('建库 → UI 导入文档 → 检索问答带引用', async () => {
    const { electronApp, win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')

    const docFile = path.join(os.tmpdir(), 'e2e-doc.md')
    fs.writeFileSync(docFile, '# E2EKB 指南\n\n这是E2E知识库的关键内容。')

    await win.getByTestId('nav-kb').click()
    // 创建放入对话框（F15）：打开 → 填写 → 创建
    await win.getByTestId('kb-create-open').click()
    await win.getByTestId('kb-name').fill('E2E知识库')
    await win.getByTestId('kb-provider').selectOption({ label: 'Mock中转' })
    await win.getByPlaceholder('Embedding 模型名（如 text-embedding-3-small）').fill('emb-1')
    await win.getByText('创建知识库').click()
    await win.getByText('E2E知识库').first().waitFor({ timeout: 15000 })

    await patchOpenDialog(electronApp, docFile)
    await win.getByTestId('kb-import').click()
    await win.getByText('已就绪', { exact: true }).waitFor({ timeout: 45000 })

    await win.getByTestId('nav-chat').click()
    await win.getByTestId('new-conv').click()
    await win.getByTestId('kb-chip').click()
    await win.getByRole('checkbox').first().check()
    await win.getByPlaceholder(INPUT).fill('E2EKB 的内容说了什么')
    await win.keyboard.press('Enter')

    await win.getByText('根据知识库，答案是确定的 [1]。').waitFor({ timeout: 30000 })
    await win.getByText('引用 (1)').click()
    await win.getByText('e2e-doc.md').first().waitFor({ timeout: 10000 })
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})
