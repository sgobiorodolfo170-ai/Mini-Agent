// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useUpdaterStore } from '../../../src/stores/updater'

const hasUpdate = {
  available: true,
  behind: 3,
  reason: 'commit-ahead',
  checkedAt: 1_700_000_000_000,
  error: null,
  current: { version: '1.2.0', commit: 'aaa1111', shortCommit: 'aaa1111' },
  latest: { version: '1.2.0', commit: 'bbb2222', shortCommit: 'bbb2222', message: '新提交' }
}

function stubApi(state = hasUpdate) {
  const api = {
    updater: {
      state: vi.fn(async () => state),
      check: vi.fn(async () => state)
    }
  }
  window.api = api
  return api
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('updater store', () => {
  it('默认不显示更新入口', () => {
    stubApi()
    const s = useUpdaterStore()
    expect(s.shouldShow).toBe(false)
  })

  it('init 拉取主进程缓存状态并允许显示入口', async () => {
    stubApi()
    const s = useUpdaterStore()
    await s.init()
    expect(s.available).toBe(true)
    expect(s.shouldShow).toBe(true)
    expect(s.behindText).toBe('落后 3 个提交')
    expect(s.latest.shortCommit).toBe('bbb2222')
  })

  it('apply 忽略空载荷，不把已有状态冲掉', async () => {
    stubApi()
    const s = useUpdaterStore()
    await s.init()
    s.apply(null)
    expect(s.available).toBe(true)
    s.apply(undefined)
    expect(s.shouldShow).toBe(true)
  })

  it('无更新时 shouldShow 为假（没有远端提交也不显示）', async () => {
    stubApi({ ...hasUpdate, available: false, behind: 0, latest: null })
    const s = useUpdaterStore()
    await s.init()
    expect(s.shouldShow).toBe(false)
  })

  it('check 期间 checking 为真，结束后回落', async () => {
    const api = stubApi()
    let release
    api.updater.check.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r(hasUpdate)
        })
    )
    const s = useUpdaterStore()
    const p = s.check(true)
    expect(s.checking).toBe(true)
    release()
    await p
    expect(s.checking).toBe(false)
    expect(api.updater.check).toHaveBeenCalledWith({ force: true })
  })

  it('缺失 updater 桥（旧版 preload）时静默跳过', async () => {
    window.api = {}
    const s = useUpdaterStore()
    await expect(s.init()).resolves.toBeUndefined()
    await expect(s.check()).resolves.toBeUndefined()
    expect(s.shouldShow).toBe(false)
  })
})
