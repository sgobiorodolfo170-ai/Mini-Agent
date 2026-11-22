import path from 'path'
import fs from 'fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeApp, launchApp, setupProviderAndKey, unexpectedErrors } from './helpers'

// 截图输出到被 .gitignore 忽略的目录：测试运行不再改写 docs/ 下已归档的验收截图
// （需要归档某次结果时，手动把需要的图拷到 docs/<批次>/ 再提交）
const OUT = path.join(process.cwd(), '.e2e-artifacts', 'composer-2026-11-20')

let ctx

async function box(win, testid) {
  const el = win.getByTestId(testid)
  return el.evaluate((n) => {
    const r = n.getBoundingClientRect()
    const cs = getComputedStyle(n)
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      radius: cs.borderRadius,
      border: cs.borderTopWidth + ' ' + cs.borderTopColor,
      bg: cs.backgroundColor
    }
  })
}

function rect(self, child) {
  return self.evaluate((n) => {
    const c = n.closest('.ac-card')
    const r = c.getBoundingClientRect()
    const list = [...c.querySelectorAll('.ac-actions .ac-left > *, .ac-actions .ac-right > *')]
    return {
      card: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height)
      },
      rowTop: Math.round(Math.min(...list.map((el) => el.getBoundingClientRect().top)) - r.top),
      rowBottom: Math.round(
        Math.max(...list.map((el) => el.getBoundingClientRect().bottom)) - r.top
      ),
      send: (() => {
        const s = c.querySelector('.ac-send, .ac-stop')
        const sr = s.getBoundingClientRect()
        return {
          right: Math.round(r.right - sr.right),
          bottom: Math.round(r.bottom - sr.bottom),
          w: Math.round(sr.width),
          h: Math.round(sr.height)
        }
      })()
    }
  })
}

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('AgentComposer 视觉与状态验收', () => {
  it('常规状态 / 任务状态：几何、控件、交互', async () => {
    const { win, mock } = ctx
    fs.mkdirSync(OUT, { recursive: true })
    await setupProviderAndKey(win, mock.url, 'sk-good')
    // 参考图为浅色主题，截图统一用浅色便于逐项对照
    await win.evaluate(() => document.documentElement.classList.remove('dark'))
    await win.getByTestId('nav-chat').click()
    await win.getByTestId('new-conv').click()
    // 等配置流程的提示 toast 自动消失（4s），避免遮挡截图
    await win.waitForTimeout(4500)

    // ---------- 状态 A：常规输入 ----------
    await win.getByTestId('composer-add').waitFor()
    // 截图阶段移出焦点，视觉对照不掺入键盘焦点环（焦点可见性另行断言）
    await win.evaluate(() => document.activeElement && document.activeElement.blur())
    const a = await rect(win.getByTestId('composer-add'))
    const aSend = await box(win, 'chat-send')
    const aPlaceholder = await win.getByTestId('chat-input').getAttribute('placeholder')
    const aMode = (await win.getByTestId('agent-toggle').innerText()).trim()
    const aModel = (await win.getByTestId('composer-model').innerText()).trim()
    const aStatusCount = await win.locator('.ac-pill').count()
    console.log(
      'A geometry',
      JSON.stringify({ ...a, aSend, aPlaceholder, aMode, aModel, aStatusCount })
    )

    await win.screenshot({ path: path.join(OUT, '01-standard.png') })

    // 视觉验收：单张卡片、106px 级高度、20–24px 圆角、32px 发送按钮、左右 13px 内边距
    expect(a.card.h).toBeGreaterThanOrEqual(104)
    expect(a.card.h).toBeLessThanOrEqual(112)
    expect(aSend.w).toBe(32)
    expect(aSend.h).toBe(32)
    expect(aSend.radius).toBe('9999px')
    expect(Math.abs(a.send.right - 12) <= 2).toBe(true)
    expect(Math.abs(a.send.bottom - 12) <= 2).toBe(true)
    const cardStyle = await win.locator('.ac-card').evaluate((n) => {
      const cs = getComputedStyle(n)
      return { radius: cs.borderTopLeftRadius, border: cs.borderTopWidth, bg: cs.backgroundColor }
    })
    console.log('A card style', JSON.stringify(cardStyle))
    expect(parseFloat(cardStyle.radius)).toBeGreaterThanOrEqual(20)
    expect(parseFloat(cardStyle.radius)).toBeLessThanOrEqual(24)
    expect(cardStyle.border).toBe('1px')
    expect(aPlaceholder).toBe('输入“/”使用技能')
    expect(aMode).toContain('默认权限')
    // 无真实后台任务时状态栏整体不渲染，不留空白占位
    expect(aStatusCount).toBe(0)

    // 空内容不可发送
    expect(await win.getByTestId('chat-send').isDisabled()).toBe(true)

    // Shift+Enter 换行不发送；Enter 发送
    await win.getByTestId('chat-input').fill('第一行')
    await win.getByTestId('chat-input').press('Shift+Enter')
    await win.getByTestId('chat-input').type('第二行')
    const multiline = await win.getByTestId('chat-input').inputValue()
    expect(multiline).toContain('\n')
    const grown = await rect(win.getByTestId('chat-input'))
    console.log('A multiline card', JSON.stringify(grown.card), JSON.stringify(multiline))
    // 多行时卡片自然增高，而不是固定高度裁切
    expect(grown.card.h).toBeGreaterThan(a.card.h)

    // 超过最大高度后在输入区内部滚动，卡片不再无限增高
    await win.getByTestId('chat-input').fill(Array.from({ length: 30 }, () => '行').join('\n'))
    const capped = await win.getByTestId('chat-input').evaluate((n) => ({
      h: n.clientHeight,
      scroll: n.scrollHeight,
      overflowY: getComputedStyle(n).overflowY
    }))
    console.log('A capped', JSON.stringify(capped))
    expect(capped.h).toBeLessThanOrEqual(162)
    expect(capped.overflowY).toBe('auto')

    // 纯空白不可发送
    await win.getByTestId('chat-input').fill('   \n  ')
    expect(await win.getByTestId('chat-send').isDisabled()).toBe(true)
    await win.getByTestId('chat-input').fill('你好')

    // IME 组合期间 Enter 不得误发送（中文候选确认）
    await win.getByTestId('chat-input').evaluate((n) => {
      n.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
      )
    })
    await win.waitForTimeout(200)
    expect(await win.getByTestId('chat-input').inputValue()).toBe('你好')
    expect(await win.getByTestId('chat-send').count()).toBe(1)

    // 模式菜单：展开截图 → Escape 关闭（不清空文本）
    await win.getByTestId('agent-toggle').click()
    await win.getByRole('menuitemradio', { name: /自主模式/ }).waitFor()
    await win.waitForTimeout(300)
    await win.screenshot({ path: path.join(OUT, '02-standard-menu.png') })

    // 菜单键盘可达：打开后焦点落在首项，方向键在项间移动，且焦点环可见
    const first = await win.evaluate(() => {
      const a = document.activeElement
      return a
        ? {
            role: a.getAttribute('role'),
            tag: a.tagName,
            cls: a.className,
            txt: (a.innerText || '').slice(0, 20)
          }
        : null
    })
    console.log('activeElement', JSON.stringify(first))
    expect(first && first.role).toBe('menuitemradio')
    const labelBefore = await win.evaluate(() => document.activeElement.innerText)
    await win.keyboard.press('ArrowDown')
    const labelAfter = await win.evaluate(() => document.activeElement.innerText)
    expect(labelAfter).not.toBe(labelBefore)
    const focusRing = await win.evaluate(
      () => getComputedStyle(document.activeElement).outlineStyle
    )
    console.log('menu item focus outline', focusRing)
    expect(focusRing).toBe('solid')

    await win.keyboard.press('Escape')
    await win.getByRole('menuitemradio', { name: /自主模式/ }).waitFor({ state: 'detached' })
    expect(await win.getByTestId('chat-input').inputValue()).toBe('你好')

    // 三级权限：默认 / 自主 / 完整
    await win.getByTestId('agent-toggle').click()
    const permItems = await win.getByRole('menuitemradio').allInnerTexts()
    console.log('permission options', JSON.stringify(permItems))
    expect(permItems.join(' ')).toContain('默认权限')
    expect(permItems.join(' ')).toContain('自主模式')
    expect(permItems.join(' ')).toContain('完整权限')

    // 默认权限下集群不可用
    expect(await win.getByTestId('composer-cluster').isDisabled()).toBe(true)
    await win.keyboard.press('Escape')

    // 上下文状态环：有真实历史字符数时出现
    await win.getByTestId('composer-usage').waitFor()
    const usageLabel = await win.getByTestId('composer-usage').getAttribute('aria-label')
    console.log('usage', usageLabel)
    expect(usageLabel).toMatch(/上下文已用 \d+%/)

    // ---------- 状态 B：任务后续输入 ----------
    await win.getByTestId('agent-toggle').click()
    await win.getByRole('menuitemradio', { name: /自主模式/ }).click()
    await win.getByTestId('chat-input').waitFor()
    const b = await rect(win.getByTestId('chat-input'))
    const bSend = await box(win, 'chat-send')
    const bPlaceholder = await win.getByTestId('chat-input').getAttribute('placeholder')
    const bMode = (await win.getByTestId('agent-toggle').innerText()).trim()
    // 过渡动画结束后读取稳定态颜色
    await win.waitForTimeout(400)
    const modeColor = await win
      .getByTestId('agent-toggle')
      .evaluate((n) => getComputedStyle(n).color)
    const brandInk = await win.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--brand-ink').trim()
    )
    console.log(
      'B geometry',
      JSON.stringify({ ...b, bSend, bPlaceholder, bMode, modeColor, brandInk })
    )
    expect(bPlaceholder).toBe('提出后续修改要求')
    expect(bMode).toContain('自主模式')
    // 自主模式使用品牌强调色（蓝色系）而非中性灰
    const [r, g, bl] = modeColor.match(/\d+/g).map(Number)
    expect(bl).toBeGreaterThan(r)
    expect(b.card.h).toBe(a.card.h)
    expect(bSend.w).toBe(32)
    await win.evaluate(() => document.activeElement && document.activeElement.blur())
    await win.screenshot({ path: path.join(OUT, '03-task-followup.png') })

    // 模型菜单：一级显示供应商，二级显示该供应商的模型
    await win.getByTestId('composer-model').click()
    await win.getByRole('menuitemradio', { name: /Mock中转/ }).waitFor()
    await win.waitForTimeout(300)
    await win.screenshot({ path: path.join(OUT, '04-model-menu-provider.png') })
    await win.getByRole('menuitemradio', { name: /Mock中转/ }).click()
    await win.getByRole('menuitemradio', { name: /mock-model/ }).waitFor()
    await win.waitForTimeout(300)
    await win.screenshot({ path: path.join(OUT, '04-model-menu-model.png') })
    // 返回一级目录
    await win.getByTestId('composer-menu-back').click()
    await win.getByRole('menuitemradio', { name: /Mock中转/ }).waitFor()
    await win.getByRole('menuitemradio', { name: /Mock中转/ }).click()
    await win.getByRole('menuitemradio', { name: /mock-model/ }).click()
    await win.getByRole('menuitemradio', { name: /mock-model/ }).waitFor({ state: 'detached' })

    // 任务态下集群可用；开启后写入 chat.agentCluster（传给 agent.run）
    const clusterBtn = win.getByTestId('composer-cluster')
    expect(await clusterBtn.isDisabled()).toBe(false)
    await clusterBtn.click()
    expect(await clusterBtn.getAttribute('aria-pressed')).toBe('true')
    await clusterBtn.click()
    expect(await clusterBtn.getAttribute('aria-pressed')).toBe('false')

    // 完整权限可选中，且回到默认权限时集群自动关闭
    await win.getByTestId('agent-toggle').click()
    await win.getByRole('menuitemradio', { name: /完整权限/ }).click()
    await win.getByTestId('composer-cluster').click()
    expect(await win.getByTestId('composer-cluster').getAttribute('aria-pressed')).toBe('true')
    await win.getByTestId('agent-toggle').click()
    await win.getByRole('menuitemradio', { name: /默认权限/ }).click()
    expect(await win.getByTestId('composer-cluster').isDisabled()).toBe(true)
    expect(await win.getByTestId('composer-cluster').getAttribute('aria-pressed')).toBe('false')
    // 回到任务态准备运行
    await win.getByTestId('agent-toggle').click()
    await win.getByRole('menuitemradio', { name: /自主模式/ }).click()

    // 输入并发送：真实流式 → 停止入口可见
    mock.state.mode = 'hang'
    await win.getByTestId('chat-input').fill('执行任务')
    await win.getByTestId('chat-send').click()
    await win.getByTestId('chat-stop').waitFor({ timeout: 15000 })
    await win.getByTestId('composer-runtime').waitFor()
    // 任务态徽标使用真实运行计数，可点击跳转到智能任务页
    const pill = win.locator('.ac-pill').first()
    await pill.waitFor()
    expect(await pill.innerText()).toContain('处理中')
    await win.screenshot({ path: path.join(OUT, '05-task-running.png') })
    await pill.click()
    await win.getByTestId('nav-agent').waitFor()
    expect(await win.locator('[data-testid="agent-run"]').count()).toBeGreaterThan(0)
    await win.getByTestId('nav-chat').click()
    await win.getByTestId('chat-stop').click()
    await win.getByText('已停止').first().waitFor({ timeout: 15000 })
    mock.state.mode = 'normal'

    // 状态环元素级截图，便于放大核对可见性
    await win.getByTestId('composer-usage').screenshot({
      path: path.join(OUT, '07-usage-ring.png')
    })
    const ringBox = await win.getByTestId('composer-usage').boundingBox()
    const ringStyle = await win
      .getByTestId('composer-usage')
      .locator('.ac-usage__ring')
      .evaluate((n) => {
        const cs = getComputedStyle(n)
        return { bg: cs.backgroundImage.slice(0, 120), w: cs.width, h: cs.height }
      })
    console.log('ring', JSON.stringify({ ringBox, ringStyle }))

    // 上下文环在真实消息存在时反映实际占用（分母 = 会话上下文预算）
    const usageWithHistory = await win.getByTestId('composer-usage').getAttribute('aria-label')
    console.log('usage with history', usageWithHistory)
    const pctNum = Number((usageWithHistory.match(/(\d+)%/) || [])[1])
    expect(pctNum).toBeGreaterThan(0)
    expect(usageWithHistory).not.toContain('0 / 12000')

    // ---------- 窄窗口：无横向溢出，发送按钮仍可见 ----------
    await win.setViewportSize({ width: 980, height: 700 })
    await win.getByTestId('chat-input').waitFor()
    const narrow = await win.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      send: (() => {
        const s = document.querySelector('.ac-send, .ac-stop')
        const r = s.getBoundingClientRect()
        return { right: Math.round(r.right), visible: r.right <= window.innerWidth }
      })()
    }))
    console.log('narrow', JSON.stringify(narrow))
    expect(narrow.overflow).toBe(0)
    expect(narrow.send.visible).toBe(true)
    await win.screenshot({ path: path.join(OUT, '06-narrow.png') })
    // 回归护栏：页头不再有「会话设置」按钮（业务已移入设置页），且设置页会话分组是全局配置
    await win.setViewportSize({ width: 1280, height: 840 })
    expect(await win.getByTestId('open-conv-settings').count()).toBe(0)
    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-chat').click()
    await win.getByTestId('chat-field-temperature').waitFor()
    expect(await win.getByTestId('chat-conv-pick').count()).toBe(0)
    await win.getByTestId('nav-chat').click()

    expect(unexpectedErrors(ctx.consoleErrors)).toEqual([])
  })
})
