import path from 'path'
import fs from 'fs'
import os from 'os'
import { _electron } from 'playwright-core'
import { createMockServer } from './mock-server'

export async function launchApp({
  reuseUserData = null,
  env = {},
  mock: providedMock = null
} = {}) {
  const userData = reuseUserData || fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-e2e-'))
  const mock = providedMock || (await createMockServer())
  const executablePath = process.env.MINIAGENT_E2E_EXECUTABLE
  const packaged = process.env.MINIAGENT_E2E_PACKAGED === '1'
  const electronApp = await _electron.launch({
    executablePath,
    args: packaged ? [] : ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      MINIAGENT_USER_DATA: userData,
      ELECTRON_ENABLE_LOGGING: '',
      ...env
    }
  })

  let win = null
  for (let i = 0; i < 60 && !win; i++) {
    for (const w of electronApp.windows()) {
      if (w.url().includes('entries/main-window')) {
        win = w
        break
      }
    }
    if (!win) await new Promise((r) => setTimeout(r, 250))
  }
  if (!win) throw new Error('main window not found')
  await win.waitForLoadState('domcontentloaded')

  const consoleErrors = []
  const consoleAll = []
  const pageErrors = []
  win.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
    consoleAll.push(`[${msg.type()}] ${msg.text()}`)
  })
  win.on('pageerror', (e) => {
    pageErrors.push(String(e))
    consoleErrors.push(String(e))
  })

  return { electronApp, win, mock, userData, consoleErrors, consoleAll, pageErrors }
}

export function unexpectedErrors(consoleErrors) {
  return consoleErrors.filter(
    (t) =>
      !t.includes('favicon') &&
      !t.includes('net::ERR') &&
      !t.includes('Not allowed to load local resource')
  )
}

export async function closeApp(electronApp, mock) {
  try {
    await electronApp.close()
  } catch {
    /* ignore */
  }
  if (mock) await mock.close()
}

// Patch native dialogs in the main process (standard Playwright electron pattern).
export async function patchOpenDialog(electronApp, filePath) {
  await electronApp.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, filePath)
}

// Configure provider + key through the real settings UI.
export async function setupProviderAndKey(win, mockUrl, keySecret) {
  await win.getByTestId('nav-settings').click()
  // 添加供应商走创建对话框（新版交互：取消新增不落库，创建后立即生效）
  await win.getByTestId('provider-add').click()
  await win.getByTestId('p-name').fill('Mock中转')
  await win.getByTestId('p-url').fill(mockUrl)
  await win.getByTestId('p-create').click()
  await win.getByText('编辑', { exact: true }).first().waitFor({ timeout: 10000 })
  // 打开编辑面板（拉取模型/一键探测需要面板处于打开状态）
  await win.getByText('编辑', { exact: true }).first().click()
  // 添加 Key（拉取模型需要供应商已有 Key）
  await win.getByTestId('k-add-toggle').click()
  await win.getByTestId('k-label').fill('主Key')
  await win.getByTestId('k-secret').fill(keySecret)
  await win.getByTestId('k-save').click()
  await win.getByText('主Key').waitFor({ timeout: 10000 })
  // 拉取模型列表（mock 返回 mock-model）→ 勾选 → 添加（拉取只展示候选，勾选后手动加入）
  await win.getByTestId('model-pull').click()
  await win
    .locator('[data-testid="pulled-item"]', { hasText: 'mock-model' })
    .waitFor({ timeout: 10000 })
  await win
    .locator('[data-testid="pulled-item"]', { hasText: 'mock-model' })
    .locator('input[type=checkbox]')
    .check()
  await win.getByTestId('model-add').click()
  await win
    .locator('[data-testid="model-chip"]', { hasText: 'mock-model' })
    .first()
    .waitFor({ timeout: 10000 })
  await win.getByTestId('p-save').click()
  // 保存成功后编辑面板自动收起，重新打开（终态：面板保持打开，供「一键探测」使用）
  await win.getByText('编辑', { exact: true }).first().click()
}

export async function startChat(win, content) {
  await win.getByTestId('nav-chat').click()
  await win.getByTestId('new-conv').click()
  await win.getByTestId('chat-input').fill(content)
  await win.keyboard.press('Enter')
}
