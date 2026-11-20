// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useKbStore } from '../../../src/stores/kb'

const kb1 = { id: 'kb1', name: '知识库一' }
const kb2 = { id: 'kb2', name: '知识库二' }

function stubApi() {
  const list = [kb1, kb2]
  const api = {
    kb: {
      list: vi.fn(async () => [...list]),
      create: vi.fn(async () => {
        const kb = { id: 'kbNew', name: '新库' }
        list.push(kb)
        return kb
      }),
      update: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      docs: vi.fn(async () => [{ id: 'd1', name: 'doc.md' }]),
      removeDoc: vi.fn(async () => ({})),
      import: vi.fn(async () => ({})),
      rebuild: vi.fn(async () => ({})),
      search: vi.fn(async () => ({ blocks: [{ id: 'b1', text: '命中' }] }))
    }
  }
  window.api = api
  return api
}

beforeEach(() => {
  setActivePinia(createPinia())
  stubApi()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('kb store 知识库操作', () => {
  it('load 拉取知识库列表', async () => {
    const s = useKbStore()
    await s.load()
    expect(s.kbs).toEqual([kb1, kb2])
  })

  it('select 设置 activeKbId 并加载文档', async () => {
    const s = useKbStore()
    await s.load()
    await s.select('kb1')
    expect(s.activeKbId).toBe('kb1')
    expect(s.docs).toEqual([{ id: 'd1', name: 'doc.md' }])
    expect(s.activeKb.name).toBe('知识库一')
  })

  it('create 新建后刷新列表并选中新库', async () => {
    const s = useKbStore()
    const kb = await s.create({ name: '新库' })
    expect(kb.id).toBe('kbNew')
    expect(s.kbs.map((k) => k.id)).toContain('kbNew')
    expect(s.activeKbId).toBe('kbNew')
  })

  it('update 提交更新并刷新列表', async () => {
    const s = useKbStore()
    await s.load()
    await s.update('kb1', { name: '改名' })
    expect(window.api.kb.update).toHaveBeenCalledWith({ id: 'kb1', patch: { name: '改名' } })
    expect(window.api.kb.list).toHaveBeenCalledTimes(2) // load + reload
  })

  it('remove 过滤列表；删除当前库时清空文档', async () => {
    const s = useKbStore()
    await s.load()
    await s.select('kb1')
    await s.remove('kb1')
    expect(s.kbs.map((k) => k.id)).toEqual(['kb2'])
    expect(s.activeKbId).toBeNull()
    expect(s.docs).toEqual([])
  })

  it('visibleKbs 按筛选文本过滤（F15）', async () => {
    const s = useKbStore()
    await s.load()
    s.filterText = '知识库一'
    expect(s.visibleKbs.map((k) => k.id)).toEqual(['kb1'])
    s.filterText = '  '
    expect(s.visibleKbs).toHaveLength(2)
  })
})

describe('kb store 导入与检索', () => {
  it('无 activeKbId 时导入/重建是安全空操作', async () => {
    const s = useKbStore()
    expect(s.importDocs(['a.md'])).toBeUndefined()
    expect(s.rebuild()).toBeUndefined()
    expect(window.api.kb.import).not.toHaveBeenCalled()
    expect(window.api.kb.rebuild).not.toHaveBeenCalled()
  })

  it('removeDoc 直接委托到后端（不受 activeKbId 限制）', async () => {
    const s = useKbStore()
    await s.removeDoc('d1')
    expect(window.api.kb.removeDoc).toHaveBeenCalledWith('d1')
  })

  it('有 activeKbId 时导入携带 kbId', async () => {
    const s = useKbStore()
    await s.select('kb1')
    await s.importDocs(['a.md', 'b.pdf'])
    expect(window.api.kb.import).toHaveBeenCalledWith({ kbId: 'kb1', paths: ['a.md', 'b.pdf'] })
  })

  it('search 无选中库时直接返回空数组', async () => {
    const s = useKbStore()
    expect(await s.search('问题')).toEqual([])
    expect(window.api.kb.search).not.toHaveBeenCalled()
  })

  it('search 命中后保存检索结果', async () => {
    const s = useKbStore()
    await s.select('kb1')
    const r = await s.search('问题')
    expect(r).toEqual([{ id: 'b1', text: '命中' }])
    expect(s.searchResults).toEqual([{ id: 'b1', text: '命中' }])
    expect(s.lastSearch).toEqual({ kbId: 'kb1', query: '问题' })
    expect(s.activeSearchResults).toEqual([{ id: 'b1', text: '命中' }])
  })

  it('select 切库清空检索结果与记录（F16）', async () => {
    const s = useKbStore()
    await s.load()
    await s.select('kb1')
    await s.search('问题')
    await s.select('kb2')
    expect(s.searchResults).toEqual([])
    expect(s.lastSearch).toBeNull()
    expect(s.activeSearchResults).toEqual([])
  })

  it('activeSearchResults 只在发起检索的库展示（防御式隔离，F16）', async () => {
    const s = useKbStore()
    await s.load()
    await s.select('kb1')
    await s.search('问题')
    s.activeKbId = 'kb2'
    expect(s.activeSearchResults).toEqual([])
  })

  it('removeDoc 同步移除本地文档并刷新库列表（F08）', async () => {
    const s = useKbStore()
    await s.load()
    await s.select('kb1')
    expect(s.docs).toHaveLength(1)
    const baseListCalls = window.api.kb.list.mock.calls.length
    await s.removeDoc('d1')
    expect(window.api.kb.removeDoc).toHaveBeenCalledWith('d1')
    expect(s.docs).toHaveLength(0)
    expect(window.api.kb.list.mock.calls.length).toBe(baseListCalls + 1)
  })

  it('handleProgress 保存进度；done 后延迟刷新列表与文档', async () => {
    vi.useFakeTimers()
    const s = useKbStore()
    await s.select('kb1')
    s.handleProgress({ done: true, pct: 100 })
    expect(s.progress).toEqual({ done: true, pct: 100 })
    await vi.advanceTimersByTimeAsync(800)
    expect(s.progress).toBeNull()
    expect(window.api.kb.list).toHaveBeenCalledTimes(1) // 定时器回调里的 load()
    expect(window.api.kb.docs).toHaveBeenCalledTimes(2) // select + 定时器刷新
  })

  it('handleProgress 未完成时只更新进度', () => {
    const s = useKbStore()
    s.handleProgress({ done: false, pct: 30 })
    expect(s.progress).toEqual({ done: false, pct: 30 })
  })
})
