import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeApp, launchApp, unexpectedErrors } from './helpers'

// 更新源：主进程支持 MINIAGENT_UPDATE_FEED 指向本地 JSON，避免 e2e 触网。
// 用真实 GitHub 响应结构（commits → compare），判定逻辑仍走 electron/main/updater.js。
function writeFeed(payload) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-feed-')), 'feed.json')
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8')
  return file
}

function feedWithUpdate() {
  return writeFeed({
    latest: {
      commit: 'ffffffffffffffffffffffffffffffffffffffff',
      shortCommit: 'fffffff',
      version: '1.2.0',
      message: 'e2e：远端新提交',
      date: '2026-11-22T02:00:00Z',
      url: 'https://github.com/sgobiorodolfo170-ai/Mini-Agent/commit/fffffff',
      compareUrl: 'https://github.com/sgobiorodolfo170-ai/Mini-Agent/compare/aaa...fff'
    },
    compare: { ahead_by: 2, behind_by: 0 }
  })
}

let ctx = null

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('GitHub 更新入口', () => {
  it('有更新时主题按钮下方出现更新按钮，点击打开详情', async () => {
    ctx = await launchApp({ env: { MINIAGENT_UPDATE_FEED: feedWithUpdate() } })
    const win = ctx.win
    await win.getByTestId('nav-chat').waitFor({ timeout: 15000 })

    const updateBtn = win.getByTestId('nav-update')
    await updateBtn.waitFor({ timeout: 15000 })

    // 位置约束：更新按钮在主题按钮之下（用户要求）
    const themeTitle = await win.locator('[title^="主题"]').boundingBox()
    const updateBox = await updateBtn.boundingBox()
    expect(updateBox.y).toBeGreaterThan(themeTitle.y)

    // 文案与可访问性
    await expect(updateBtn.innerText()).resolves.toContain('更新')
    expect(await updateBtn.getAttribute('aria-label')).toBe('有可用更新')

    await updateBtn.click()
    await win.getByText('GitHub 上有新提交').waitFor({ timeout: 10000 })
    // 落后提交数来自 compare.ahead_by
    await win.getByText(/落后 2 个提交/).waitFor()
    await win.getByText('e2e：远端新提交').waitFor()

    // 关闭后按钮仍在（状态未丢失）
    await win.getByText('关闭', { exact: true }).click()
    await updateBtn.waitFor()
    expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
  })

  it('无更新时不显示更新按钮', async () => {
    const feed = writeFeed({
      latest: { commit: 'abcabcabcabc', shortCommit: 'abcabc', version: '1.2.0', message: 'same' },
      compare: { ahead_by: 0, behind_by: 0 }
    })
    ctx = await launchApp({ env: { MINIAGENT_UPDATE_FEED: feed } })
    const win = ctx.win
    await win.getByTestId('nav-chat').waitFor({ timeout: 15000 })
    await win.locator('[title^="主题"]').waitFor()
    // 给检查留出窗口（启动后 3s 首查），确认确实不渲染而不是尚未检查
    await win.waitForTimeout(4500)
    expect(await win.getByTestId('nav-update').count()).toBe(0)
    expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
  })
})
