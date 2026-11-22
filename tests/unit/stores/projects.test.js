// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

import { useProjectsStore } from '../../../src/stores/projects'

function stubApi(overrides = {}) {
  const api = {
    projects: {
      list: vi.fn(async () => []),
      create: vi.fn(async (o) => ({ id: 1, ...o })),
      update: vi.fn(async ({ id, patch }) => ({ id, ...patch })),
      remove: vi.fn(async () => true),
      ...overrides
    }
  }
  window.api = api
  return api
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('projects store', () => {
  it('load 把列表写入 state', async () => {
    const rows = [
      { id: 1, name: 'A' },
      { id: 2, name: 'B' }
    ]
    stubApi({ list: vi.fn(async () => rows) })
    const s = useProjectsStore()
    await s.load()
    expect(s.projects).toEqual(rows)
  })

  it('byId 命中返回对象，未命中返回 null', async () => {
    stubApi({ list: vi.fn(async () => [{ id: 7, name: '工作' }]) })
    const s = useProjectsStore()
    await s.load()
    expect(s.byId(7)).toEqual({ id: 7, name: '工作' })
    expect(s.byId(999)).toBeNull()
  })

  it('create 传 plain 对象、写库后重新加载，并返回新项目', async () => {
    const api = stubApi({
      list: vi.fn(async () => [{ id: 1, name: '新项目' }]),
      create: vi.fn(async (o) => ({ id: 1, ...o }))
    })
    const s = useProjectsStore()
    // reactive Proxy 不能直接过 contextBridge，store 必须先 plain 化
    const created = await s.create(reactive({ name: '新项目', path: 'D:/work' }))
    expect(api.projects.create).toHaveBeenCalledWith({ name: '新项目', path: 'D:/work' })
    expect(created).toEqual({ id: 1, name: '新项目', path: 'D:/work' })
    expect(s.projects).toEqual([{ id: 1, name: '新项目' }])
  })

  it('update 把 id 与 patch 一起传下去并重新加载', async () => {
    const api = stubApi({
      list: vi.fn(async () => [{ id: 3, name: '改名后' }]),
      update: vi.fn(async ({ id, patch }) => ({ id, ...patch }))
    })
    const s = useProjectsStore()
    const p = await s.update(3, reactive({ name: '改名后' }))
    expect(api.projects.update).toHaveBeenCalledWith({ id: 3, patch: { name: '改名后' } })
    expect(p).toEqual({ id: 3, name: '改名后' })
    expect(s.projects).toEqual([{ id: 3, name: '改名后' }])
  })

  it('remove 删除后重新加载，列表同步收敛', async () => {
    const list = vi.fn(async () => [{ id: 1, name: 'A' }])
    const api = stubApi({ list })
    const s = useProjectsStore()
    s.projects = [
      { id: 1, name: 'A' },
      { id: 2, name: 'B' }
    ]
    await s.remove(2)
    expect(api.projects.remove).toHaveBeenCalledWith(2)
    expect(list).toHaveBeenCalled()
    expect(s.projects).toEqual([{ id: 1, name: 'A' }])
  })

  it('底层抛错时不吞异常（调用方可以提示用户）', async () => {
    stubApi({
      list: vi.fn(async () => []),
      remove: vi.fn(async () => {
        throw new Error('项目不存在')
      })
    })
    const s = useProjectsStore()
    await expect(s.remove(42)).rejects.toThrow('项目不存在')
  })
})
