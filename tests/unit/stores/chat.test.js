// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useChatStore } from '../../../src/stores/chat'

const c1 = { id: 'c1', title: '会话一', pinned: 0, updated_at: 2, permission: 'default' }
const c2 = { id: 'c2', title: '会话二', pinned: 0, updated_at: 1, permission: 'readonly' }
const m1 = { id: 'm1', role: 'user', content: '你好', status: 'done' }
const m2 = { id: 'm2', role: 'assistant', content: '旧回复', status: 'done' }

function stubApi() {
  const list = [c1, c2]
  const api = {
    conversations: {
      list: vi.fn(async () => [...list]),
      create: vi.fn(async () => {
        const c = { id: 'cNew', title: '新会话' }
        list.push(c)
        return c
      }),
      messages: vi.fn(async () => [m1, m2]),
      update: vi.fn(async ({ id, patch }) => ({ ...(id === 'c1' ? c1 : c2), ...patch })),
      remove: vi.fn(async () => {}),
      // 后端返回会话对象数组（非 id 数组）
      search: vi.fn(async (q) => (q === '会话二' ? [c2] : []))
    },
    chat: {
      send: vi.fn(async () => ({})),
      stop: vi.fn(async () => ({})),
      regenerate: vi.fn(async () => ({})),
      editResend: vi.fn(async () => ({})),
      deleteMessage: vi.fn(async () => true),
      searchMessages: vi.fn(async ({ query, cursor }) => ({
        results: [{ messageId: `m-${query}-${cursor}`, conversationId: 'c1', snippet: query }],
        nextCursor: cursor ? null : 1
      }))
    },
    agent: { run: vi.fn(async () => ({})) }
  }
  window.api = api
  return api
}

beforeEach(() => {
  setActivePinia(createPinia())
  stubApi()
})

describe('chat store 会话操作', () => {
  it('loadConversations 拉取会话列表', async () => {
    const s = useChatStore()
    await s.loadConversations()
    expect(s.conversations).toEqual([c1, c2])
  })

  it('全文检索保留查询、分页与错误状态', async () => {
    const s = useChatStore()
    await s.searchMessages('报销')
    expect(window.api.chat.searchMessages).toHaveBeenCalledWith({
      query: '报销',
      cursor: 0,
      limit: 50
    })
    expect(s.messageSearch.results[0].snippet).toBe('报销')
    await s.searchMessages('报销', 1, true)
    expect(s.messageSearch.results).toHaveLength(2)
    expect(s.messageSearch.nextCursor).toBe(null)
    s.clearMessageSearch()
    expect(s.messageSearch.results).toEqual([])
  })

  it('select 设置 activeId 并加载消息', async () => {
    const s = useChatStore()
    await s.loadConversations()
    await s.select('c1')
    expect(s.activeId).toBe('c1')
    expect(s.messages).toEqual([m1, m2])
    expect(s.activeConv.title).toBe('会话一')
  })

  it('select 恢复会话级权限记忆（含非法值回退 default）', async () => {
    const s = useChatStore()
    await s.loadConversations()
    // c2 带 readonly：切回恢复为只读任务
    await s.select('c2')
    expect(s.permission).toBe('readonly')
    // 非法权限值收敛 default
    s.conversations[1].permission = 'hacker'
    await s.select('c2')
    expect(s.permission).toBe('default')
    // c1 显式 default
    await s.select('c1')
    expect(s.permission).toBe('default')
  })

  it('setPermission 乐观更新并按会话持久化，readonly 时 agentMode 走 agent.run', async () => {
    const s = useChatStore()
    await s.loadConversations()
    await s.select('c1')
    await s.setPermission('full')
    expect(s.permission).toBe('full')
    expect(window.api.conversations.update).toHaveBeenCalledWith({
      id: 'c1',
      patch: { permission: 'full' }
    })
    // 非法值被拒绝
    await s.setPermission('godmode')
    expect(s.permission).toBe('full')

    // readonly 属任务模式：send 走 agent.run 并透传权限
    await s.setPermission('readonly')
    expect(s.agentMode).toBe(true)
    await s.send('只读任务')
    expect(window.api.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({ permission: 'readonly' })
    )
    expect(window.api.chat.send).not.toHaveBeenCalled()
  })

  it('create 新建会话后自动加载列表并选中', async () => {
    const s = useChatStore()
    await s.create()
    expect(s.activeId).toBe('cNew')
    expect(s.conversations.map((c) => c.id)).toContain('cNew')
    expect(s.messages).toEqual([m1, m2])
  })

  it('updateConv 提交 plain patch 并同步列表项', async () => {
    const s = useChatStore()
    await s.loadConversations()
    await s.updateConv('c1', { title: '改名' })
    expect(window.api.conversations.update).toHaveBeenCalledWith({
      id: 'c1',
      patch: { title: '改名' }
    })
    expect(s.conversations[0].title).toBe('改名')
  })

  it('removeConv 过滤列表；删除当前会话时清空消息', async () => {
    const s = useChatStore()
    await s.loadConversations()
    await s.select('c1')
    await s.removeConv('c1')
    expect(s.conversations.map((c) => c.id)).toEqual(['c2'])
    expect(s.activeId).toBeNull()
    expect(s.messages).toEqual([])
  })

  it('removeConv 删除非当前会话时保持选中不变', async () => {
    const s = useChatStore()
    await s.loadConversations()
    await s.select('c1')
    await s.removeConv('c2')
    expect(s.activeId).toBe('c1')
    expect(s.messages).toEqual([m1, m2])
  })
})

describe('chat store 搜索筛选（F03）', () => {
  it('setFilter 按后端返回的会话对象过滤列表，完整数据不受影响', async () => {
    const s = useChatStore()
    await s.loadConversations()
    await s.select('c1')
    await s.setFilter('会话二')
    expect(window.api.conversations.search).toHaveBeenCalledWith('会话二')
    expect(s.filtering).toBe(true)
    expect(s.visibleConversations.map((c) => c.id)).toEqual(['c2'])
    // activeConv 仍从完整列表解析，会话设置不消失
    expect(s.activeConv.title).toBe('会话一')
    expect(s.conversations).toHaveLength(2)
  })

  it('setFilter 清空后立即恢复完整列表', async () => {
    const s = useChatStore()
    await s.loadConversations()
    await s.setFilter('会话二')
    await s.setFilter('')
    expect(s.filtering).toBe(false)
    expect(s.visibleConversations).toHaveLength(2)
    expect(window.api.conversations.search).toHaveBeenCalledTimes(1)
  })

  it('列表刷新保留筛选条件并重跑匹配（事件刷新不重置筛选）', async () => {
    const s = useChatStore()
    await s.loadConversations()
    await s.setFilter('会话二')
    window.api.conversations.search.mockClear()
    await s.loadConversations()
    expect(window.api.conversations.search).toHaveBeenCalledWith('会话二')
    expect(s.visibleConversations.map((c) => c.id)).toEqual(['c2'])
  })
})

describe('chat store 发送路径', () => {
  it('无 activeId 时发送会先自动建会话', async () => {
    const s = useChatStore()
    await s.send('第一条')
    expect(window.api.conversations.create).toHaveBeenCalledTimes(1)
    expect(window.api.chat.send).toHaveBeenCalledWith({
      conversationId: 'cNew',
      content: '第一条',
      kbIds: [],
      attachments: []
    })
  })

  it('携带选中的知识库 id 与附件', async () => {
    const s = useChatStore()
    await s.select('c1')
    s.selectedKbIds = ['kb1', 'kb2']
    await s.send('带知识库', [{ name: 'a.txt' }])
    expect(window.api.chat.send).toHaveBeenCalledWith({
      conversationId: 'c1',
      content: '带知识库',
      kbIds: ['kb1', 'kb2'],
      attachments: [{ name: 'a.txt' }]
    })
  })

  it('agentMode 时走 agent.run 而不是 chat.send', async () => {
    const s = useChatStore()
    await s.select('c1')
    s.permission = 'autonomous'
    s.selectedKbIds = ['kb-project']
    await s.send('帮我建个文件')
    expect(window.api.agent.run).toHaveBeenCalledWith({
      conversationId: 'c1',
      goal: '帮我建个文件',
      permission: 'autonomous',
      cluster: false,
      kbIds: ['kb-project']
    })
    expect(window.api.chat.send).not.toHaveBeenCalled()
  })

  it('stop 委托到 chat.stop', async () => {
    const s = useChatStore()
    await s.stop('m2')
    expect(window.api.chat.stop).toHaveBeenCalledWith('m2')
  })

  it('regenerate 本地先移除最后一条 assistant，避免旧回复残留', async () => {
    const s = useChatStore()
    await s.select('c1')
    await s.regenerate()
    expect(s.messages.map((m) => m.id)).toEqual(['m1'])
    expect(window.api.chat.regenerate).toHaveBeenCalledWith('c1')
  })

  it('regenerate 无 activeId 时不调用后端', async () => {
    const s = useChatStore()
    await s.regenerate()
    expect(window.api.chat.regenerate).not.toHaveBeenCalled()
  })

  it('editResend 截断到被编辑消息（含）并重新发送', async () => {
    const s = useChatStore()
    await s.select('c1')
    await s.editResend('m1', '改一下再发')
    expect(s.messages.map((m) => m.id)).toEqual(['m1'])
    expect(window.api.chat.editResend).toHaveBeenCalledWith({ msgId: 'm1', content: '改一下再发' })
  })

  it('editResend 未知消息 id 时不截断', async () => {
    const s = useChatStore()
    await s.select('c1')
    await s.editResend('nope', 'x')
    expect(s.messages).toEqual([m1, m2])
    expect(window.api.chat.editResend).toHaveBeenCalled()
  })

  it('deleteMessage 调用后端并本地同步移除', async () => {
    const s = useChatStore()
    await s.select('c1')
    await s.deleteMessage('m2')
    expect(window.api.chat.deleteMessage).toHaveBeenCalledWith('m2')
    expect(s.messages.map((m) => m.id)).toEqual(['m1'])
  })
})

describe('chat store 消息事件流', () => {
  it('upsert 按 id 替换或追加', () => {
    const s = useChatStore()
    s.upsert(m1)
    s.upsert({ ...m1, content: '覆盖' })
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0].content).toBe('覆盖')
    s.upsert(m2)
    expect(s.messages).toHaveLength(2)
  })

  it('upsert 忽略空消息', () => {
    const s = useChatStore()
    s.upsert(null)
    expect(s.messages).toHaveLength(0)
  })

  it('delta 追加内容并标记 streaming', () => {
    const s = useChatStore()
    s.messages = [m2]
    s.handleEvent({ type: 'delta', msgId: 'm2', delta: '新' })
    expect(s.messages[0]).toMatchObject({ content: '旧回复新', status: 'streaming' })
    expect(s.hasStreaming).toBe(true)
  })

  it('done 覆盖内容、置为 done 并保留 meta', () => {
    const s = useChatStore()
    s.messages = [m2]
    s.handleEvent({ type: 'done', msgId: 'm2', content: '完整回复', meta: { refs: [1] } })
    expect(s.messages[0]).toMatchObject({
      content: '完整回复',
      status: 'done',
      meta: { refs: [1] }
    })
    expect(s.hasStreaming).toBe(false)
  })

  it('stopped 标记停止并接受可选内容', () => {
    const s = useChatStore()
    s.messages = [m2]
    s.handleEvent({ type: 'stopped', msgId: 'm2', content: '已中断' })
    expect(s.messages[0]).toMatchObject({ content: '已中断', status: 'stopped' })
  })

  it('error 标记错误状态', () => {
    const s = useChatStore()
    s.messages = [m2]
    s.handleEvent({ type: 'error', msgId: 'm2' })
    expect(s.messages[0].status).toBe('error')
  })

  it('未知 msgId 的 delta 不触发整表刷新（避免每 token 一次查询）', () => {
    const s = useChatStore()
    s.handleEvent({ type: 'delta', msgId: 'ghost', delta: 'x' })
    expect(window.api.conversations.list).not.toHaveBeenCalled()
  })

  it('未知 msgId 的终态事件仍刷新会话列表兜底', () => {
    const s = useChatStore()
    s.handleEvent({ type: 'done', msgId: 'ghost', content: 'x' })
    expect(window.api.conversations.list).toHaveBeenCalled()
  })

  it('非当前会话的 delta 直接丢弃，不触发列表刷新', () => {
    const s = useChatStore()
    s.activeId = 'c1'
    s.messages = [{ id: 'm9', role: 'assistant', content: '旧回复', status: 'done' }]
    s.handleEvent({ type: 'delta', conversationId: 'c2', msgId: 'm9', delta: '别人的' })
    expect(s.messages[0].content).toBe('旧回复')
    expect(window.api.conversations.list).not.toHaveBeenCalled()
  })

  it('当前会话带 conversationId 的 delta 正常追加', () => {
    const s = useChatStore()
    s.activeId = 'c1'
    s.messages = [{ id: 'm9', role: 'assistant', content: '旧回复', status: 'done' }]
    s.handleEvent({ type: 'delta', conversationId: 'c1', msgId: 'm9', delta: '追加' })
    expect(s.messages[0]).toMatchObject({ content: '旧回复追加', status: 'streaming' })
  })

  it('snapshot 对当前会话做全量 upsert 并刷新列表', () => {
    const s = useChatStore()
    s.activeId = 'c1'
    s.handleEvent({
      type: 'snapshot',
      conversationId: 'c1',
      messages: [m1, { ...m2, content: '快照' }]
    })
    expect(s.messages.map((m) => m.content)).toEqual(['你好', '快照'])
    expect(window.api.conversations.list).toHaveBeenCalled()
  })

  it('snapshot 属于其他会话时只刷新列表，不动当前消息', () => {
    const s = useChatStore()
    s.activeId = 'c1'
    s.messages = [m1]
    s.handleEvent({ type: 'snapshot', conversationId: 'c2', messages: [{ id: 'x', role: 'user' }] })
    expect(s.messages).toEqual([m1])
    expect(window.api.conversations.list).toHaveBeenCalled()
  })

  it('messageDeleted 从当前会话移除对应消息', () => {
    const s = useChatStore()
    s.activeId = 'c1'
    s.messages = [m1, m2]
    s.handleEvent({ type: 'messageDeleted', conversationId: 'c1', msgId: 'm2' })
    expect(s.messages.map((m) => m.id)).toEqual(['m1'])
  })

  it('messageDeleted 属于其他会话时忽略', () => {
    const s = useChatStore()
    s.activeId = 'c1'
    s.messages = [m1, m2]
    s.handleEvent({ type: 'messageDeleted', conversationId: 'c2', msgId: 'm2' })
    expect(s.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })
})
