import path from 'path'
import fs from 'fs'
import os from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeApp, launchApp, patchOpenDialog, unexpectedErrors } from './helpers'

// Real-provider E2E against 端砚 (docs/test-提供商.md). Config is parsed from
// the file so no credentials live in code. Note: the relay rate-limits hard
// (a second rapid request can 429) and has NO embedding models, so the KB RAG
// chain is intentionally covered by the mock suite (kb.spec.js) instead.
const providerCfg = (() => {
  const text = fs.readFileSync(path.join(process.cwd(), 'docs', 'test-提供商.md'), 'utf8')
  const url = (text.match(/url：(\S+)/) || [])[1]
  const keys = [...text.matchAll(/^(sk-\S+)$/gm)].map((m) => m[1])
  return { name: '端砚', url, keys, chatModel: 'Sage-S2.1-Flash' }
})()

let ctx

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

// Configure the real provider through the UI: provider + all keys + pull
// models + pick chat model as default. Returns nothing; throws on failure.
async function configureRealProvider(win) {
  const { url, keys, name } = providerCfg
  await win.getByTestId('nav-settings').click()
  // 新版交互：provider-add 打开创建对话框，p-create 落库后卡片带「编辑」入口
  await win.getByTestId('provider-add').click()
  await win.getByTestId('p-name').fill(name)
  await win.getByTestId('p-url').fill(url)
  await win.getByTestId('p-create').click()
  await win.getByText('编辑', { exact: true }).first().click()

  for (let i = 0; i < keys.length; i++) {
    // 保存后表单保持展开（便于连续加 Key），只在首把 Key 前展开一次
    if (i === 0) await win.getByTestId('k-add-toggle').click()
    await win.getByTestId('k-label').fill(`Key${i + 1}`)
    await win.getByTestId('k-secret').fill(keys[i])
    await win.getByTestId('k-save').click()
    await win.getByText(`Key${i + 1}`).waitFor({ timeout: 10000 })
  }

  // Pull real model list (needs a saved key; baseUrl comes from the draft)
  // New interaction: pull shows a checkbox list — tick the chat model and add
  await win.getByTestId('model-pull').click()
  await win
    .locator('[data-testid="pulled-item"]', { hasText: providerCfg.chatModel })
    .first()
    .waitFor({ timeout: 30000 })
  await win
    .locator('[data-testid="pulled-item"]', { hasText: providerCfg.chatModel })
    .first()
    .locator('input[type=checkbox]')
    .check()
  await win.getByTestId('model-add').click()
  await win
    .locator('[data-testid="model-chip"]', { hasText: providerCfg.chatModel })
    .first()
    .waitFor({ timeout: 15000 })
  await win.getByTestId('p-save').click()

  // Set provider + chat model as defaults (non-reasoning fast model)，主页面原生 select
  await win.getByTestId('default-provider').selectOption({ label: name })
  await win.getByTestId('default-model').selectOption({ label: providerCfg.chatModel })
}

async function waitReplyDone(win, timeout) {
  await win.getByText('生成中…').first().waitFor({ timeout: 30000 })
  await win.getByText('生成中…').waitFor({ state: 'detached', timeout })
  await win.getByText('已停止').waitFor({ state: 'detached', timeout: 5000 })
  await win.getByText('出错').waitFor({ state: 'detached', timeout: 5000 })
}

describe('端砚真实提供商全链路（docs/test-提供商.md）', () => {
  it('配置 3 把 Key → 真实拉取模型 → 默认模型 → 一键探测', { timeout: 240000 }, async () => {
    const { win, consoleErrors } = ctx
    await configureRealProvider(win)

    // 保存后面板已收起，重开编辑面板才能一键探测
    await win.getByText('编辑', { exact: true }).first().click()
    await win.getByTestId('k-probe-all').click()
    await win
      .locator('[data-testid="key-status"]', { hasText: '正常' })
      .first()
      .waitFor({ timeout: 120000 })

    const statuses = await win.evaluate(() =>
      JSON.stringify(
        [...document.querySelectorAll('[data-testid="key-status"]')].map((el) =>
          el.textContent.trim()
        )
      )
    )
    console.log('REAL probe statuses:', statuses)
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

  it('真实流式对话 → 重新生成 → 持久化重启', { timeout: 300000 }, async () => {
    const { win, userData, consoleErrors } = ctx
    await configureRealProvider(win)

    await win.getByTestId('nav-chat').click()
    await win.getByTestId('new-conv').click()
    await win.getByTestId('chat-input').fill('请只回复四个字：测试成功')
    await win.keyboard.press('Enter')
    await waitReplyDone(win, 180000)

    const chatText = await win.evaluate(() => {
      const el = document.querySelectorAll('section')[0]
      return el ? el.innerText : ''
    })
    expect(chatText.length).toBeGreaterThan(20)
    console.log('REAL reply head:', JSON.stringify(chatText.slice(0, 160)))

    // Regenerate: old reply replaced, exactly one assistant bubble remains
    await win.getByText('重新生成').first().click()
    await waitReplyDone(win, 180000)
    const regenText = await win.evaluate(() => {
      const el = document.querySelectorAll('section')[0]
      return el ? el.innerText : ''
    })
    expect(regenText).not.toContain('生成中…')
    console.log('REAL regen head:', JSON.stringify(regenText.slice(0, 160)))

    // Restart with same userData → provider, conversation and message survive
    await closeApp(ctx.electronApp, ctx.mock)
    ctx = null
    const second = await launchApp({ reuseUserData: userData })
    ctx = second
    await second.win.getByTestId('nav-settings').click()
    await second.win.getByTestId('provider-name').waitFor({ timeout: 15000 })
    await second.win.getByTestId('nav-chat').click()
    await second.win.getByText('测试成功').first().waitFor({ timeout: 15000 })
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

  it('Agent 真实工具调用：write_file 确认后落盘', { timeout: 300000 }, async () => {
    const { electronApp, win, consoleErrors } = ctx
    await configureRealProvider(win)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-real-agent-'))
    await patchOpenDialog(electronApp, dir)
    await win.getByTestId('nav-settings').click()
    // 设置页分组导航：授权目录在「智能任务」分组内
    await win.getByTestId('settings-section-agent').click()
    await win.getByText('+ 添加目录').click()
    await win.getByText(dir).waitFor({ timeout: 15000 })

    const target = path.join(dir, 'real-e2e.txt')
    await win.getByTestId('nav-chat').click()
    await win.getByTestId('agent-toggle').click()
    await win
      .getByTestId('chat-input')
      .fill(
        `请使用 write_file 工具，在目录 ${dir} 下创建文件 real-e2e.txt，文件内容为：E2E真实验证。写完后回复：完成。`
      )
    await win.keyboard.press('Enter')

    await win.getByText('Agent 请求确认').waitFor({ timeout: 120000 })
    await win.getByText('write_file').first().waitFor({ timeout: 10000 })
    // 确认卡片主文案按工具具体化（方案 §6.4）：write_file → 允许写入
    await win.getByText('允许写入').click()
    await win.getByText('生成中…').waitFor({ state: 'detached', timeout: 180000 })

    expect(fs.readFileSync(target, 'utf8')).toContain('E2E真实验证')
    fs.rmSync(dir, { recursive: true, force: true })
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})
