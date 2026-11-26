import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchApp, setupProviderAndKey, unexpectedErrors } from './helpers'

let ctx

beforeEach(async () => {
  ctx = await launchApp()
})

afterEach(async () => {
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
})

describe('设置页「会话」分组（会话设置迁入）', () => {
  it('会话分组是全局设置：无「当前会话」选择器，也无按会话字段', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')

    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-chat').click()
    // 全局采样字段就位
    await win.getByTestId('chat-field-temperature').waitFor()

    // 不再有「当前会话」选择器（会话设置是全局的，不针对单个会话）
    expect(await win.getByTestId('chat-conv-pick').count()).toBe(0)
    expect(await win.getByText('当前会话', { exact: true }).count()).toBe(0)

    // 按会话的字段均已移除
    for (const t of ['所属项目', '供应商', '系统提示词', '默认供应商', '默认模型']) {
      expect(await win.getByText(t, { exact: true }).count()).toBe(0)
    }
    // 最大输出长度 / 上下文上限属于模型参数，不在会话分组
    expect(await win.getByText('最大输出长度', { exact: true }).count()).toBe(0)
    expect(await win.getByText('上下文上限（字符）', { exact: true }).count()).toBe(0)

    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

  it('随机性 / 核采样 / 保留轮数提供档位推荐，点击写入全局设置', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')

    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-chat').click()

    // 三个档位组都存在（各 3 档）
    for (const field of ['temperature', 'topP', 'keepTurns']) {
      const btns = win.locator(`[data-testid^="chat-preset-${field}-"]`)
      expect(await btns.count()).toBe(3)
    }

    // 点「严谨」档 → 全局 chatSampling.temperature 落库
    await win.getByTestId('chat-preset-temperature-0.2').click()
    await win.waitForTimeout(300)
    const readSampling = () => win.evaluate(() => window.api.settings.get('chatSampling'))
    expect((await readSampling()).temperature).toBe(0.2)

    // 切到「发散」档覆盖同一字段
    await win.getByTestId('chat-preset-temperature-1.1').click()
    await win.waitForTimeout(300)
    expect((await readSampling()).temperature).toBe(1.1)

    // 数值输入与档位共用同一字段
    await win.getByTestId('chat-input-keepTurns').fill('35')
    await win.getByTestId('chat-input-keepTurns').blur()
    await win.waitForTimeout(300)
    expect((await readSampling()).keepTurns).toBe(35)

    // 恢复默认清空全部全局采样参数
    await win.getByTestId('chat-sampling-reset').click()
    await win.waitForTimeout(300)
    expect(await readSampling()).toEqual({})

    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

  it('最大输出长度 / 上下文上限在供应商卡片的模型参数中保存', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')

    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-model').click()
    // 打开模型参数（模型 chip 上的齿轮）
    await win
      .locator('[data-testid="model-chip"]', { hasText: 'mock-model' })
      .first()
      .locator('button[aria-label^="配置模型参数"]')
      .click()
    await win.getByTestId('model-params').waitFor()
    await win.getByTestId('model-max-tokens').fill('256')
    await win.getByTestId('model-max-chars').fill('4000')
    await win.getByTestId('p-save').click()

    // 重新打开：参数已随供应商落库
    await win.getByText('编辑', { exact: true }).first().click()
    const providers = await win.evaluate(() => window.api.providers.list())
    const model = providers[0].models.find((m) => m.id === 'mock-model')
    expect(model.maxTokens).toBe(256)
    expect(model.maxChars).toBe(4000)

    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})

describe('设置页「智能任务安全」分组', () => {
  it('默认不授权，展示工作目录与命令特权提示', async () => {
    const { win, consoleErrors } = ctx
    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-agent').click()

    await win.getByTestId('agent-directory-security').waitFor()
    await win.getByTestId('agent-working-dir').waitFor()
    expect(await win.getByTestId('agent-authorized-dir').count()).toBe(0)
    expect(await win.getByTestId('agent-working-dir-status').textContent()).toContain('未授权')
    expect(await win.evaluate(() => window.api.settings.get('agentAuthorizedDirs'))).toBeFalsy()
    expect(await win.getByText(/run_command 不受上述目录 guard 限制/).count()).toBe(1)
    expect(await win.getByText(/不属于文件沙箱/).count()).toBeGreaterThan(0)
    expect(await win.getByText(/仍需逐次确认/).count()).toBeGreaterThan(0)
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

  it('仅在显式点击后授权当前项目目录，去重并持久化', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-e2e-work-'))
    try {
      await win.getByTestId('nav-chat').click()
      await win.getByTestId('project-add').click()
      await win.getByTestId('project-name').fill('授权验收')
      await win.getByTestId('project-path').fill(workDir)
      await win.getByTestId('project-worktree').uncheck()
      await win.getByTestId('project-workspace-index').uncheck()
      await win.getByTestId('project-confirm').click()
      await win.getByTestId('project-new-conv').click()

      await win.getByTestId('nav-settings').click()
      await win.getByTestId('settings-section-agent').click()
      expect(await win.getByTestId('agent-working-dir').textContent()).toBe(workDir)
      expect(await win.getByTestId('agent-authorized-dir').count()).toBe(0)

      await win.getByTestId('agent-authorize-working-dir').click()
      await win.waitForFunction(
        async (dir) => ((await window.api.settings.get('agentAuthorizedDirs')) || []).includes(dir),
        workDir
      )
      expect(await win.getByTestId('agent-authorized-dir').count()).toBe(1)
      expect(await win.getByTestId('agent-authorize-working-dir').isDisabled()).toBe(true)
      expect(await win.getByTestId('agent-working-dir-status').textContent()).toContain('已')

      // 通过目录选择器再次添加不同大小写的同一路径，不应产生重复授权。
      await ctx.electronApp.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
      }, workDir.toUpperCase())
      await win.getByTestId('agent-add-dir').click()
      await win.getByRole('status').filter({ hasText: '该目录已在有效授权列表中' }).waitFor()
      expect(await win.getByTestId('agent-authorized-dir').count()).toBe(1)
      const saved = await win.evaluate(() => window.api.settings.get('agentAuthorizedDirs'))
      expect(saved).toEqual([workDir])

      // 刷新后仍保持用户显式授权的结果。
      await win.reload()
      await win.getByTestId('nav-settings').click()
      await win.getByTestId('settings-section-agent').click()
      await win.getByTestId('agent-authorized-dir').waitFor()
      expect(await win.getByTestId('agent-authorized-dir').count()).toBe(1)
      expect(unexpectedErrors(consoleErrors)).toEqual([])
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('授权保存失败时回滚列表与 store', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-e2e-rollback-'))
    try {
      await win.getByTestId('nav-chat').click()
      await win.getByTestId('project-add').click()
      await win.getByTestId('project-name').fill('回滚验收')
      await win.getByTestId('project-path').fill(workDir)
      await win.getByTestId('project-worktree').uncheck()
      await win.getByTestId('project-workspace-index').uncheck()
      await win.getByTestId('project-confirm').click()
      await win.getByTestId('project-new-conv').click()
      await win.getByTestId('nav-settings').click()
      await win.getByTestId('settings-section-agent').click()
      await win.waitForFunction(
        (dir) =>
          document.querySelector('[data-testid="agent-working-dir"]')?.textContent.trim() === dir,
        workDir
      )

      await ctx.electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('settings:set')
        ipcMain.handle('settings:set', async () => {
          throw new Error('模拟持久化失败')
        })
      })
      await win.getByTestId('agent-authorize-working-dir').click()
      await win.getByRole('alert').filter({ hasText: '模拟持久化失败' }).waitFor()
      expect(await win.getByTestId('agent-authorized-dir').count()).toBe(0)
      expect(await win.getByTestId('agent-working-dir-status').textContent()).toContain('未授权')
      expect(await win.evaluate(() => window.api.settings.get('agentAuthorizedDirs'))).toBeFalsy()
      expect(unexpectedErrors(consoleErrors)).toEqual([])
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })
})

describe('设置页 MCP 配置校验', () => {
  it('只读校验 API 不返回配置正文，主进程拒绝保存无效配置', async () => {
    const { win } = ctx
    const raw = '{"docs":{"command":"node","args":["server.js"],"env":{"TOKEN":"sk-mcp-secret"}}}'
    const valid = await win.evaluate((value) => window.api.settings.validateMcp(value), raw)
    expect(valid).toEqual({ configured: true, valid: true, diagnostics: [] })
    expect(JSON.stringify(valid)).not.toContain('server.js')
    expect(JSON.stringify(valid)).not.toContain('sk-mcp-secret')
    expect(await win.evaluate(() => window.api.settings.validateMcp(null))).toEqual({
      configured: false,
      valid: true,
      diagnostics: []
    })

    const invalid =
      '{"broken":{"command":"","args":["server.js",42],"env":{"TOKEN":"sk-mcp-secret"}}'
    const result = await win.evaluate((value) => window.api.settings.validateMcp(value), invalid)
    expect(result.valid).toBe(false)
    expect(result.diagnostics[0].code).toBe('invalid_json')
    expect(JSON.stringify(result)).not.toContain('sk-mcp-secret')
    const error = await win.evaluate(async (value) => {
      try {
        await window.api.settings.set('agentMcpServers', value)
        return ''
      } catch (e) {
        return e.message
      }
    }, invalid)
    expect(error).toContain('MCP 配置不是合法 JSON')
    expect(error).not.toContain('sk-mcp-secret')
    expect(await win.evaluate(() => window.api.settings.get('agentMcpServers'))).toBeNull()
  })

  it('加载已存的非法配置时显示诊断且不自动改写', async () => {
    const { win, electronApp } = ctx
    const invalid = '{"broken":{"command":"node","args":["server.js",42]}}'
    await electronApp.evaluate((_electron, raw) => {
      const { createRequire } = process.getBuiltinModule('node:module')
      const require = createRequire(process.cwd() + '/e2e/settings.spec.js')
      const dbm = require('../electron/store/db')
      const repos = require('../electron/store/repos')
      repos.setSetting(dbm.get(), 'agentMcpServers', raw)
    }, invalid)
    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-agent').click()
    await win.getByTestId('mcp-diagnostics').waitFor()
    expect(await win.getByTestId('mcp-diagnostics').textContent()).toContain('args 无效')
    expect(await win.getByTestId('mcp-diagnostics').textContent()).toContain('args[1]')
    expect(await win.getByTestId('mcp-servers-json').inputValue()).toBe(invalid)
    expect(await win.evaluate(() => window.api.settings.get('agentMcpServers'))).toBe(invalid)
  })

  it('非法 JSON / command / args 可见且不覆盖已保存配置，null 可保存', async () => {
    const { win, consoleErrors } = ctx
    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-agent').click()
    const input = win.getByTestId('mcp-servers-json')
    const saved = '{"docs":{"command":"node","args":["server.js"]}}'

    await input.fill(saved)
    await input.blur()
    await win.waitForFunction(
      async (value) => (await window.api.settings.get('agentMcpServers')) === value,
      saved
    )

    await input.fill('{"token":"sk-mcp-secret"')
    await input.blur()
    await win.getByTestId('mcp-diagnostics').waitFor()
    expect(await win.getByTestId('mcp-diagnostics').textContent()).toContain('非法 JSON')
    expect(await win.evaluate(() => window.api.settings.get('agentMcpServers'))).toBe(saved)

    await input.fill(
      JSON.stringify({
        noCommand: { args: [] },
        badArgs: { command: 'node', args: ['server.js', 42] }
      })
    )
    await input.blur()
    await win.waitForFunction(() =>
      document.querySelector('[data-testid="mcp-diagnostics"]')?.textContent.includes('args[1]')
    )
    const diagnostics = await win.getByTestId('mcp-diagnostics').textContent()
    expect(diagnostics).toContain('command 无效')
    expect(diagnostics).toContain('args 无效')
    expect(await win.evaluate(() => window.api.settings.get('agentMcpServers'))).toBe(saved)

    await input.fill('')
    await input.blur()
    await win.waitForFunction(
      async () => (await window.api.settings.get('agentMcpServers')) === null
    )
    expect(await win.getByTestId('mcp-diagnostics').count()).toBe(0)
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

  it('加载时校验已存配置，合法配置与 null 重载后保持可编辑', async () => {
    const { win, consoleErrors } = ctx
    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-agent').click()
    const input = win.getByTestId('mcp-servers-json')
    const saved = '{"docs":{"command":"npx","args":["-y","server-docs"]}}'
    await input.fill(saved)
    await input.blur()
    await win.waitForFunction(
      async (value) => (await window.api.settings.get('agentMcpServers')) === value,
      saved
    )

    await win.reload()
    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-agent').click()
    await win.getByTestId('mcp-servers-json').waitFor()
    expect(await win.getByTestId('mcp-servers-json').inputValue()).toBe(saved)
    expect(await win.getByTestId('mcp-diagnostics').count()).toBe(0)
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

  it('Agent 接入详细诊断并在连续 Run 中去重且不记录配置正文', async () => {
    const { win, electronApp, mock } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    const invalid =
      '{"broken":{"command":"node","args":["server.js",42],"env":{"TOKEN":"sk-mcp-secret"}}}'
    await electronApp.evaluate((_electron, raw) => {
      const { createRequire } = process.getBuiltinModule('node:module')
      const require = createRequire(process.cwd() + '/e2e/settings.spec.js')
      const dbm = require('../electron/store/db')
      const repos = require('../electron/store/repos')
      repos.setSetting(dbm.get(), 'agentMcpServers', raw)
    }, invalid)

    for (let i = 0; i < 2; i++) {
      const runId = await win.evaluate(async (index) => {
        const conversation = await window.api.conversations.create({ title: `MCP 诊断 ${index}` })
        const run = await window.api.agent.run({
          conversationId: conversation.id,
          goal: 'MCP 诊断日志验收',
          permission: 'full'
        })
        return run.runId
      }, i)
      await win.waitForFunction(
        async (id) => (await window.api.agent.status(id)).status === 'done',
        runId,
        { timeout: 30000 }
      )
    }
    const entries = await win.evaluate(() => window.api.logs.list({ search: 'agent.mcp' }))
    expect(entries).toHaveLength(1)
    expect(entries[0].level).toBe('warn')
    expect(entries[0].data).toContain('invalid_args')
    expect(entries[0].data).toContain('broken')
    expect(JSON.stringify(entries)).not.toContain('sk-mcp-secret')
    expect(JSON.stringify(entries)).not.toContain('server.js')
  })

  it('无效 MCP 配置的工具错误包含具体诊断且不泄露配置正文', async () => {
    const { electronApp } = ctx
    const result = await electronApp.evaluate(async () => {
      const { createRequire } = process.getBuiltinModule('node:module')
      const require = createRequire(process.cwd() + '/e2e/settings.spec.js')
      const { defineTools } = require('../electron/main/agent/tools')
      const { parseMcpServersDetailed } = require('../electron/main/agent/mcp-client')
      const parsed = parseMcpServersDetailed(
        '{"broken":{"command":"node","args":["server.js",42],"env":{"TOKEN":"sk-mcp-secret"}}}'
      )
      const map = Object.fromEntries(
        defineTools({
          mcpServers: parsed.servers,
          mcpDiagnostics: parsed.diagnostics,
          todo: { seq: 0, items: [] }
        }).map((tool) => [tool.name, tool])
      )
      try {
        await map.mcp_list_tools.handler({ server: 'broken' })
        return ''
      } catch (e) {
        return e.message
      }
    })
    expect(result).toContain('MCP 配置无效')
    expect(result).toContain('args[1]')
    expect(result).toContain('不含 NUL 字符的字符串')
    expect(result).not.toContain('sk-mcp-secret')
    expect(result).not.toContain('server.js')
  })
})

describe('设置页「运行日志」分组', () => {
  it('展示 persistence 降级/错误/恢复与最近错误，healthy 不打扰', async () => {
    const { win, electronApp, consoleErrors } = ctx
    const mockStats = (persistence) =>
      electronApp.evaluate(({ ipcMain }, health) => {
        ipcMain.removeHandler('logs:stats')
        ipcMain.handle('logs:stats', () => ({
          size: 0,
          bytes: 0,
          path: '',
          dir: '',
          persistence: health
        }))
      }, persistence)
    const lastError = {
      operation: 'append',
      code: 'EACCES',
      reason: '无法追加运行日志',
      at: Date.now()
    }

    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-logs').click()
    if (await win.getByTestId('log-auto-refresh').isChecked()) {
      await win.getByTestId('log-auto-refresh').uncheck()
    }
    for (const status of ['degraded', 'error', 'recovered']) {
      await mockStats({
        enabled: true,
        status,
        lastError,
        recoveredAt: status === 'recovered' ? Date.now() : null
      })
      await win.getByTestId('log-refresh').click()
      const health = win.getByTestId('log-persistence-health')
      await health.waitFor()
      expect(await health.getAttribute('data-status')).toBe(status)
      expect(await win.getByTestId('log-persistence-error').textContent()).toContain(
        '无法追加运行日志'
      )
      expect(await win.getByTestId('log-persistence-error').textContent()).toContain('EACCES')
    }

    await mockStats({ enabled: true, status: 'healthy', lastError, recoveredAt: null })
    await win.getByTestId('log-refresh').click()
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="log-persistence-health"]')
    )

    // 真实 stats 用 healthy + recoveredAt 表示刚恢复；恢复提示只出现一次。
    await mockStats({ enabled: true, status: 'healthy', lastError, recoveredAt: Date.now() })
    await win.getByTestId('log-refresh').click()
    await win.getByTestId('log-persistence-health').waitFor()
    expect(await win.getByTestId('log-persistence-health').getAttribute('data-status')).toBe(
      'recovered'
    )
    await win.getByTestId('log-refresh').click()
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="log-persistence-health"]')
    )
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

  it('展示主进程运行日志，支持搜索筛选与清空', async () => {
    const { win, consoleErrors } = ctx
    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-logs').click()

    await win.getByTestId('log-row').first().waitFor({ timeout: 10000 })
    expect(await win.getByTestId('log-row').count()).toBeGreaterThan(0)
    // 启动日志已由主进程写入运行日志
    await win
      .getByTestId('log-row')
      .filter({ hasText: '应用启动' })
      .first()
      .waitFor({ timeout: 5000 })

    // 关键字过滤在已加载的日志上即时生效
    await win.getByTestId('log-search').fill('数据库已打开')
    await win
      .getByTestId('log-row')
      .filter({ hasText: '数据库已打开' })
      .first()
      .waitFor({ timeout: 5000 })
    expect(await win.getByTestId('log-row').count()).toBe(1)

    await win.getByTestId('log-search').fill('')
    // 关闭轮询，避免清空与后台刷新交叉造成断言抖动
    if (await win.getByTestId('log-auto-refresh').isChecked()) {
      await win.getByTestId('log-auto-refresh').uncheck()
    }
    await win.getByTestId('log-clear').click()
    await win.locator('button.btn-danger', { hasText: '清空' }).click()
    await win.waitForFunction(() => document.querySelector('[data-testid="log-row"]') === null)
    expect(await win.getByTestId('log-row').count()).toBe(0)
    expect(await win.evaluate(() => window.api.logs.list({ limit: 10 }))).toEqual([])

    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })

  it('清空返回 false 时提示失败、保留旧日志且不显示成功', async () => {
    const { win, electronApp, consoleErrors } = ctx
    await win.getByTestId('nav-settings').click()
    await win.getByTestId('settings-section-logs').click()
    await win
      .getByTestId('log-row')
      .filter({ hasText: '应用启动' })
      .first()
      .waitFor({ timeout: 10000 })
    if (await win.getByTestId('log-auto-refresh').isChecked()) {
      await win.getByTestId('log-auto-refresh').uncheck()
    }

    const before = await win.evaluate(async () => ({
      rows: await window.api.logs.list({ limit: 500 }),
      stats: await window.api.logs.stats()
    }))
    const startup = before.rows.find((entry) => entry.message === '应用启动')
    expect(startup).toBeTruthy()
    const diskBefore = await electronApp.evaluate(
      (_electron, file) => process.getBuiltinModule('node:fs').readFileSync(file, 'utf8'),
      before.stats.path
    )

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('logs:clear')
      ipcMain.handle('logs:clear', () => false)
    })
    await win.getByTestId('log-clear').click()
    await win.locator('button.btn-danger', { hasText: '清空' }).click()

    await win.getByText('清空失败：磁盘日志仍保留，请检查权限或磁盘空间', { exact: true }).waitFor()
    expect(await win.getByText('运行日志已清空', { exact: true }).count()).toBe(0)
    await win.getByTestId('log-row').filter({ hasText: '应用启动' }).first().waitFor()
    const after = await win.evaluate(() => window.api.logs.list({ limit: 500 }))
    expect(after.some((entry) => entry.id === startup.id)).toBe(true)
    const diskAfter = await electronApp.evaluate(
      (_electron, file) => process.getBuiltinModule('node:fs').readFileSync(file, 'utf8'),
      before.stats.path
    )
    expect(diskAfter).toContain(diskBefore)
    expect(diskAfter).toContain('应用启动')
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  })
})
