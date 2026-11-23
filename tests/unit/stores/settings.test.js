// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useSettingsStore } from '../../../src/stores/settings'

const providers = [
  { id: 'p1', name: 'A', enabled: 1 },
  { id: 'p2', name: 'B', enabled: 0 }
]

function stubApi() {
  const api = {
    settings: {
      all: vi.fn(async () => ({ theme: 'light', defaultProviderId: 'p1' })),
      set: vi.fn(async () => {})
    },
    providers: {
      list: vi.fn(async () => providers),
      save: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      addKey: vi.fn(async () => ({})),
      removeKey: vi.fn(async () => {}),
      probeKey: vi.fn(async () => ({ ok: true })),
      probeAll: vi.fn(async () => [{ ok: false }]),
      fetchModels: vi.fn(async () => ['m1'])
    },
    app: {
      info: vi.fn(async () => ({ version: '1.0.0' })),
      autostart: vi.fn(async () => false),
      hotkeys: vi.fn(async () => ({ quick: 'Alt+Space' })),
      setHotkeys: vi.fn(async () => ({ quick: { ok: true, reason: '' } })),
      setAutostart: vi.fn(async () => true)
    },
    models: {
      list: vi.fn(async () => [
        {
          id: 'bge-small-zh-v1.5:int8',
          model: 'bge-small-zh-v1.5',
          quant: 'int8',
          dim: 512,
          downloaded: true
        },
        {
          id: 'bge-base-zh-v1.5:fp32',
          model: 'bge-base-zh-v1.5',
          quant: 'fp32',
          dim: 768,
          downloaded: false
        }
      ]),
      download: vi.fn(async () => ({ started: true })),
      remove: vi.fn(async () => {})
    }
  }
  window.api = api
  return api
}

beforeEach(() => {
  setActivePinia(createPinia())
  stubApi()
})

describe('settings store 初始化', () => {
  it('init 一次性加载设置/应用信息/自启动/快捷键/供应商', async () => {
    const s = useSettingsStore()
    await s.init()
    expect(s.settings).toEqual({ theme: 'light', defaultProviderId: 'p1' })
    expect(s.info).toEqual({ version: '1.0.0' })
    expect(s.autostart).toBe(false)
    expect(s.hotkeys).toEqual({ quick: 'Alt+Space' })
    expect(s.providers).toEqual(providers)
  })

  it('showBall 默认开启，显式关闭时为 false', async () => {
    const s = useSettingsStore()
    await s.init()
    expect(s.showBall).toBe(true)

    window.api.settings.all.mockResolvedValue({ showBall: false })
    const s2 = useSettingsStore()
    await s2.init()
    expect(s2.showBall).toBe(false)
  })

  it('closeToTray 默认开启，显式关闭时为 false（关闭按钮改为退出软件）', async () => {
    const s = useSettingsStore()
    await s.init()
    expect(s.closeToTray).toBe(true)

    window.api.settings.all.mockResolvedValue({ closeToTray: false })
    const s2 = useSettingsStore()
    await s2.init()
    expect(s2.closeToTray).toBe(false)
  })

  it('init 完成后 initialized 置真（F09：表单初始化同步依赖此标志）', async () => {
    const s = useSettingsStore()
    expect(s.initialized).toBe(false)
    await s.init()
    expect(s.initialized).toBe(true)
  })
})

describe('settings store 计算属性', () => {
  // 默认供应商/默认模型设置已移除：服务与模型由用户在选择处手动指定
  it('不再暴露 defaultProviderId 计算属性', async () => {
    const s = useSettingsStore()
    await s.init()
    expect(s.defaultProviderId).toBeUndefined()
    expect(s.settings.defaultProviderId).toBe('p1')
  })

  it('enabledProviders 只返回启用的供应商', async () => {
    const s = useSettingsStore()
    await s.init()
    expect(s.enabledProviders.map((p) => p.id)).toEqual(['p1'])
  })
})

describe('settings store 修改操作', () => {
  it('set 更新本地状态并持久化', async () => {
    const s = useSettingsStore()
    await s.init()
    await s.set('theme', 'dark')
    expect(s.settings.theme).toBe('dark')
    expect(window.api.settings.set).toHaveBeenCalledWith('theme', 'dark')
  })

  it('saveProvider / removeProvider / addKey / removeKey 都会刷新供应商列表', async () => {
    const s = useSettingsStore()
    await s.init()
    const base = window.api.providers.list.mock.calls.length

    await s.saveProvider({ id: 'p1', name: 'A2' })
    expect(window.api.providers.save).toHaveBeenCalled()
    await s.removeProvider('p2')
    expect(window.api.providers.remove).toHaveBeenCalledWith('p2')
    await s.addKey({ providerId: 'p1', label: 'k', secret: 'sk' })
    expect(window.api.providers.addKey).toHaveBeenCalled()
    await s.removeKey('key1')
    expect(window.api.providers.removeKey).toHaveBeenCalledWith('key1')
    expect(window.api.providers.list.mock.calls.length).toBe(base + 4)
  })

  it('probeKey / probeAll 返回结果并刷新列表', async () => {
    const s = useSettingsStore()
    await s.init()
    expect(await s.probeKey('key1')).toEqual({ ok: true })
    expect(await s.probeAll('p1')).toEqual([{ ok: false }])
  })

  it('fetchModels 直接透传', async () => {
    const s = useSettingsStore()
    expect(await s.fetchModels('p1', 'https://x/v1')).toEqual(['m1'])
    expect(window.api.providers.fetchModels).toHaveBeenCalledWith('p1', 'https://x/v1')
  })

  it('saveHotkeys 保存映射并记录上报结果', async () => {
    const s = useSettingsStore()
    const map = { quick: 'Alt+Space', selection: '', capture: '' }
    const report = await s.saveHotkeys(map)
    expect(report).toEqual({ quick: { ok: true, reason: '' } })
    expect(s.hotkeys).toEqual(map)
    expect(s.hotkeyReport).toEqual(report)
  })

  it('setAutostart 同步开关状态', async () => {
    const s = useSettingsStore()
    await s.setAutostart(true)
    expect(s.autostart).toBe(true)
    expect(window.api.app.setAutostart).toHaveBeenCalledWith(true)
  })
})

describe('settings store 本地嵌入模型包', () => {
  it('loadModels 拉取包列表，downloadedModels 只含已下载项', async () => {
    const s = useSettingsStore()
    await s.loadModels()
    expect(s.modelPackages).toHaveLength(2)
    expect(s.downloadedModels.map((p) => p.id)).toEqual(['bge-small-zh-v1.5:int8'])
  })

  it('downloadModel / removeModel 调用后端并刷新列表', async () => {
    const s = useSettingsStore()
    await s.downloadModel('bge-base-zh-v1.5:fp32')
    expect(window.api.models.download).toHaveBeenCalledWith('bge-base-zh-v1.5:fp32')
    expect(window.api.models.list).toHaveBeenCalled()
    await s.removeModel('bge-small-zh-v1.5:int8')
    expect(window.api.models.remove).toHaveBeenCalledWith('bge-small-zh-v1.5:int8')
  })

  it('handleModelsProgress 记录进度；done 后刷新列表并延时清理', async () => {
    vi.useFakeTimers()
    const s = useSettingsStore()
    s.handleModelsProgress({
      id: 'p1',
      received: 50,
      totalBytes: 100,
      done: false,
      status: 'downloading'
    })
    expect(s.modelProgress.received).toBe(50)
    s.handleModelsProgress({ id: 'p1', done: true, status: 'done' })
    expect(s.modelProgress.done).toBe(true)
    expect(window.api.models.list).toHaveBeenCalled()
    vi.advanceTimersByTime(1600)
    expect(s.modelProgress).toBeNull()
    vi.useRealTimers()
  })
})
