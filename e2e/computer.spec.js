import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
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

describe('电脑操作', () => {
  it('通过真实 UIA 写入记事本并发送复制按键', async () => {
    const { win, consoleErrors } = ctx
    await setupProviderAndKey(win, ctx.mock.url, 'sk-good')
    const started = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Start-Process notepad.exe; $window = $null; for ($i = 0; $i -lt 50; $i++) { $window = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Sort-Object StartTime -Descending | Select-Object -First 1; if ($window) { break }; Start-Sleep -Milliseconds 100 }; if (-not $window) { throw "Notepad window not found" }; $window.Id'
      ],
      { encoding: 'utf8' }
    )
    const processId = Number(started.trim())
    const helperPath = path.resolve(
      'native/computer-uia/bin/Release/net10.0-windows/win-x64/publish/computer-uia.exe'
    )
    const helper = spawn(helperPath, { stdio: ['pipe', 'pipe', 'pipe'] })
    let pending = null
    let output = ''
    helper.stdout.on('data', (chunk) => {
      output += chunk.toString()
      const lines = output.split(/\r?\n/)
      output = lines.pop() || ''
      for (const line of lines) {
        if (!line || !pending) continue
        const resolve = pending
        pending = null
        resolve(JSON.parse(line))
      }
    })
    const request = (payload) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('UIA helper request timed out')), 10000)
        pending = (result) => {
          clearTimeout(timer)
          resolve(result)
        }
        helper.stdin.write(`${JSON.stringify(payload)}\n`)
      })
    try {
      await expect
        .poll(
          async () => {
            const result = await request({ command: 'list_windows' })
            return result.windows?.some((entry) => entry.processId === processId)
          },
          { timeout: 15000 }
        )
        .toBe(true)
      // SetForegroundWindow alone can be rejected by Windows foreground locks.
      // AppActivate targets the PID; attaching input threads is the fallback.
      await expect
        .poll(
          async () => {
            const activatedProcessId = Number(
              execFileSync(
                'powershell.exe',
                [
                  '-NoProfile',
                  '-Command',
                  `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${processId}; $window=$p.MainWindowHandle; if ($window -eq 0) { throw 'Notepad window not found' }; $shell=New-Object -ComObject WScript.Shell; $shell.AppActivate(${processId}) > $null; Add-Type -Namespace MiniAgentUia -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'; $foregroundProcessId=0; $foreground=[MiniAgentUia.Native]::GetForegroundWindow(); if ($foreground -eq 0 -or [MiniAgentUia.Native]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId) -eq 0) { $foregroundProcessId=0 }; if ($foregroundProcessId -ne ${processId}) { $targetProcessId=0; $targetThreadId=[MiniAgentUia.Native]::GetWindowThreadProcessId($window, [ref]$targetProcessId); $foregroundThreadId=0; if ($foreground -ne 0) { $foregroundThreadId=[MiniAgentUia.Native]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId) }; if ($targetThreadId -ne 0 -and $foregroundThreadId -ne 0 -and $targetThreadId -ne $foregroundThreadId -and [MiniAgentUia.Native]::AttachThreadInput($foregroundThreadId, $targetThreadId, $true)) { try { [MiniAgentUia.Native]::ShowWindow($window, 9) > $null; [MiniAgentUia.Native]::SetForegroundWindow($window) > $null } finally { [MiniAgentUia.Native]::AttachThreadInput($foregroundThreadId, $targetThreadId, $false) > $null } } }; Start-Sleep -Milliseconds 100; $foreground=[MiniAgentUia.Native]::GetForegroundWindow(); $foregroundProcessId=0; if ($foreground -eq 0 -or [MiniAgentUia.Native]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId) -eq 0) { $foregroundProcessId=0 }; $foregroundProcessId`
                ],
                { encoding: 'utf8' }
              )
            )
            if (activatedProcessId !== processId) return activatedProcessId
            const foreground = await request({ command: 'foreground' })
            return foreground.ok ? foreground.processId : 0
          },
          { timeout: 15000, interval: 250 }
        )
        .toBe(processId)
      const snapshot = await request({ command: 'snapshot', processId, maxNodes: 500 })
      expect(snapshot.ok).toBe(true)
      const editor = snapshot.elements.find(
        (element) =>
          element.isPassword === false &&
          element.patterns.includes('Value') &&
          ['Edit', 'Document'].includes(element.controlType)
      )
      expect(editor, JSON.stringify(snapshot.elements)).toBeDefined()
      const text = `MiniAgent UIA E2E ${Date.now()}`
      expect(await request({ command: 'set_value', ref: editor.ref, value: text })).toEqual({
        ok: true
      })
      expect(await request({ command: 'key', keys: '^a', processId })).toEqual({ ok: true })
      expect(await request({ command: 'key', keys: '^c', processId })).toEqual({ ok: true })
      const clipboard = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', 'Get-Clipboard'],
        {
          encoding: 'utf8'
        }
      )
      expect(clipboard.replace(/\r?\n$/, '')).toBe(text)
      expect(unexpectedErrors(consoleErrors)).toEqual([])
    } finally {
      try {
        await request({ command: 'dispose' })
      } catch {
        helper.kill()
      }
      helper.stdin.end()
      try {
        execFileSync('taskkill.exe', ['/PID', String(processId), '/F'], { stdio: 'ignore' })
      } catch {
        // 记事本可能已由测试环境提前关闭。
      }
    }
  }, 60000)

  it('通过真实 UIA 助手列出窗口、读取元素树并保存屏幕截图', async () => {
    const { win, mock, consoleErrors } = ctx
    await setupProviderAndKey(win, mock.url, 'sk-good')
    await win.evaluate(() => window.api.settings.set('computerUseEnabled', true))
    mock.state.computerRun = true
    const started = await win.evaluate(async () => {
      const [existing] = await window.api.conversations.list()
      const conversation =
        existing || (await window.api.conversations.create({ title: '电脑操作' }))
      return window.api.agent.run({
        conversationId: conversation.id,
        goal: '电脑操作验收',
        permission: 'full'
      })
    })

    await expect
      .poll(() => win.evaluate((runId) => window.api.agent.status(runId), started.runId), {
        timeout: 30000
      })
      .toMatchObject({ status: 'done' })
    const calls = await win.evaluate((runId) => window.api.agent.calls(runId), started.runId)
    expect(calls.map((call) => call.tool)).toEqual([
      'computer_list_windows',
      'computer_snapshot',
      'computer_capture'
    ])
    const capture = calls.find((call) => call.tool === 'computer_capture')
    const image = JSON.parse(capture.result)
    expect(image.width).toBeGreaterThan(0)
    expect(image.height).toBeGreaterThan(0)
    expect(fs.existsSync(image.path)).toBe(true)
    expect(unexpectedErrors(consoleErrors)).toEqual([])
  }, 60000)
})
