// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useUiStore } from '../../../src/stores/ui'

function stubApi() {
  const api = {
    settings: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {})
    },
    conversations: {
      list: vi.fn(async () => []),
      messages: vi.fn(async () => [])
    }
  }
  window.api = api
  return api
}

const isDark = () => document.documentElement.classList.contains('dark')

beforeEach(() => {
  setActivePinia(createPinia())
  stubApi()
})

afterEach(() => {
  vi.useRealTimers()
  document.documentElement.classList.remove('dark')
})

describe('ui store 主题', () => {
  it('init 无设置时默认 dark 并应用', async () => {
    const s = useUiStore()
    await s.init()
    expect(s.theme).toBe('dark')
    expect(isDark()).toBe(true)
  })

  it('init 读取已保存的 light 主题', async () => {
    window.api.settings.get.mockResolvedValue('light')
    const s = useUiStore()
    await s.init()
    expect(s.theme).toBe('light')
    expect(isDark()).toBe(false)
  })

  it('setTheme 持久化并切换 dark 类', async () => {
    const s = useUiStore()
    s.setTheme('light')
    expect(window.api.settings.set).toHaveBeenCalledWith('theme', 'light')
    expect(s.theme).toBe('light')
    expect(isDark()).toBe(false)

    s.setTheme('dark')
    expect(isDark()).toBe(true)
  })

  it('setTheme system 跟随系统深色偏好', () => {
    window.matchMedia = vi.fn(() => ({ matches: true }))
    const s = useUiStore()
    s.setTheme('system')
    expect(s.theme).toBe('system')
    expect(isDark()).toBe(true)

    window.matchMedia = vi.fn(() => ({ matches: false }))
    s.setTheme('system')
    expect(isDark()).toBe(false)
  })
})

describe('ui store 其他交互', () => {
  it('toast 入队并在 4 秒后自动移除', async () => {
    vi.useFakeTimers()
    const s = useUiStore()
    s.toast('保存成功', 'ok')
    expect(s.toasts).toHaveLength(1)
    expect(s.toasts[0]).toMatchObject({ message: '保存成功', level: 'ok' })
    await vi.advanceTimersByTimeAsync(4000)
    expect(s.toasts).toHaveLength(0)
  })

  it('toast 默认 info 级别', () => {
    const s = useUiStore()
    s.toast('提示')
    expect(s.toasts[0].level).toBe('info')
  })

  it('goChat 切视图并按需跳转到指定会话', async () => {
    const s = useUiStore()
    s.view = 'settings'
    s.goChat()
    expect(s.view).toBe('chat')
    expect(window.api.conversations.messages).not.toHaveBeenCalled()

    s.view = 'settings'
    s.goChat('c1')
    expect(s.view).toBe('chat')
    expect(window.api.conversations.messages).toHaveBeenCalledWith('c1')
  })

  it('system 模式下监听系统主题变化并跟随（F22）', async () => {
    let changeCb = null
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: (_t, cb) => (changeCb = cb)
    }))
    const s = useUiStore()
    await s.init()
    s.setTheme('system')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    window.matchMedia = vi.fn(() => ({ matches: true }))
    changeCb()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})

describe('ui store 会话布局偏好与确认（F01/F04/F22）', () => {
  // 会话设置已迁入设置页「会话」选项卡，聊天区不再有右侧抽屉，相关偏好随之移除
  it('聊天区不再保留会话详情抽屉偏好', async () => {
    const s = useUiStore()
    await s.init()
    expect(s.showDetails).toBeUndefined()
    expect(s.detailsPinned).toBeUndefined()
    expect(typeof s.setShowDetails).toBe('undefined')
  })

  it('init 读取已保存的列表偏好，列表宽度夹取到 220–320', async () => {
    window.api.settings.get.mockImplementation(
      async (k) =>
        ({
          theme: 'light',
          chatListVisible: false,
          chatListWidth: 999
        })[k] ?? null
    )
    const s = useUiStore()
    await s.init()
    expect(s.chatListVisible).toBe(false)
    expect(s.chatListWidth).toBe(320)
    s.setChatListWidth(100)
    expect(s.chatListWidth).toBe(220)
  })

  it('error toast 常驻直到手动关闭，其余 4 秒自动消失（F22）', async () => {
    vi.useFakeTimers()
    const s = useUiStore()
    s.toast('失败了', 'error')
    s.toast('成功了', 'success')
    expect(s.toasts).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(4000)
    expect(s.toasts).toHaveLength(1)
    expect(s.toasts[0].level).toBe('error')
    s.dismissToast(s.toasts[0].id)
    expect(s.toasts).toHaveLength(0)
  })

  it('confirm 返回 Promise，resolveConfirm 决议并清理状态（F04）', async () => {
    const s = useUiStore()
    const p = s.confirm({ title: '删除会话', message: '确认？', impact: '影响范围' })
    expect(s.confirmState).toMatchObject({
      title: '删除会话',
      message: '确认？',
      impact: '影响范围'
    })
    s.resolveConfirm(true)
    await expect(p).resolves.toBe(true)
    expect(s.confirmState).toBeNull()

    const p2 = s.confirm({})
    s.resolveConfirm(false)
    await expect(p2).resolves.toBe(false)
  })

  it('toggleChatList 持久化列表状态', async () => {
    const s = useUiStore()
    await s.init()
    s.toggleChatList()
    expect(s.chatListVisible).toBe(false)
    expect(window.api.settings.set).toHaveBeenCalledWith('chatListVisible', false)
  })
})
