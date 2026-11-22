import { defineStore } from 'pinia'
import { plain } from '../common/plain'

export const useChatStore = defineStore('chat', {
  state: () => ({
    conversations: [],
    activeId: null,
    messages: [],
    selectedKbIds: [],
    // 权限等级：default（普通对话）/ autonomous（自主模式，逐次确认）/ full（完整权限，不再逐次确认）
    permission: 'default',
    // Agent 集群：允许一次派发多个子 Agent 并行处理
    agentCluster: false,
    // 搜索筛选与完整会话数据分开存放：activeConv 始终从完整列表取值（F03）
    filterQuery: '',
    filterIds: []
  }),
  getters: {
    // 任务模式 = 任一非默认权限。保留旧字段名，避免既有调用点与测试失效
    agentMode(state) {
      return state.permission !== 'default'
    },
    activeConv(state) {
      return state.conversations.find((c) => c.id === state.activeId) || null
    },
    hasStreaming(state) {
      return state.messages.some((m) => m.status === 'streaming')
    },
    filtering(state) {
      return !!state.filterQuery
    },
    visibleConversations(state) {
      if (!state.filterQuery) return state.conversations
      const ids = state.filterIds
      return state.conversations.filter((c) => ids.includes(c.id))
    }
  },
  actions: {
    async loadConversations() {
      this.conversations = await window.api.conversations.list()
      // 列表异步刷新时保留筛选条件并重跑匹配（F03：事件刷新不重置筛选）
      if (this.filterQuery) await this.applyFilter(this.filterQuery)
    },
    // 后端 searchConversations 返回会话对象数组（不是 id 数组），这里按对象契约处理
    async setFilter(q) {
      const query = (q || '').trim()
      this.filterQuery = query
      if (!query) {
        this.filterIds = []
        return
      }
      await this.applyFilter(query)
    },
    async applyFilter(query) {
      const rows = await window.api.conversations.search(query)
      this.filterIds = rows.map((r) => r.id)
    },
    async select(id) {
      this.activeId = id
      this.messages = await window.api.conversations.messages(id)
    },
    async create(opts = {}) {
      const c = await window.api.conversations.create(plain(opts))
      await this.loadConversations()
      await this.select(c.id)
      return c
    },
    async updateConv(id, patch) {
      const c = await window.api.conversations.update({ id, patch: plain(patch) })
      const i = this.conversations.findIndex((x) => x.id === id)
      if (i >= 0 && c) this.conversations[i] = c
    },
    async removeConv(id) {
      await window.api.conversations.remove(id)
      this.conversations = this.conversations.filter((c) => c.id !== id)
      if (this.activeId === id) {
        this.activeId = null
        this.messages = []
      }
    },
    async send(content, attachments = []) {
      if (!this.activeId) await this.create()
      if (this.agentMode) {
        return window.api.agent.run({
          conversationId: this.activeId,
          goal: content,
          permission: this.permission,
          cluster: this.agentCluster
        })
      }
      return window.api.chat.send({
        conversationId: this.activeId,
        content,
        kbIds: [...this.selectedKbIds],
        attachments: plain(attachments)
      })
    },
    stop(msgId) {
      return window.api.chat.stop(msgId)
    },
    regenerate() {
      if (!this.activeId) return
      // 后端会软删最后一条 assistant；本地同步移除，避免旧回复残留
      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (this.messages[i].role === 'assistant') {
          this.messages.splice(i, 1)
          break
        }
      }
      return window.api.chat.regenerate(this.activeId)
    },
    editResend(msgId, content) {
      const idx = this.messages.findIndex((x) => x.id === msgId)
      if (idx >= 0) this.messages = this.messages.slice(0, idx + 1)
      return window.api.chat.editResend({ msgId, content })
    },
    async deleteMessage(msgId) {
      await window.api.chat.deleteMessage(msgId)
      // 本地同步移除（对齐 regenerate 的即时反馈），后端广播会兜底其他窗口
      this.messages = this.messages.filter((m) => m.id !== msgId)
      return true
    },
    upsert(m) {
      if (!m) return
      const i = this.messages.findIndex((x) => x.id === m.id)
      if (i >= 0) this.messages[i] = m
      else this.messages.push(m)
    },
    handleEvent(ev) {
      // 事件按会话分流：broadcast 会推给所有窗口，非当前会话的高频事件
      // （尤其逐 token 的 delta）必须在入口丢弃，否则每个 token 都要拉一次会话列表。
      const evConv = ev.conversationId || null
      if (ev.type === 'snapshot') {
        if (evConv === this.activeId) {
          for (const m of ev.messages || []) this.upsert(m)
        }
        this.loadConversations()
        return
      }
      if (ev.type === 'messageDeleted') {
        if (!evConv || evConv === this.activeId) {
          this.messages = this.messages.filter((m) => m.id !== ev.msgId)
        }
        return
      }
      if (evConv && evConv !== this.activeId) return
      const m = this.messages.find((x) => x.id === ev.msgId)
      if (!m) {
        // 只对终态事件兜底刷新；delta 丢一条不值得触发整表查询
        if (ev.type !== 'delta') this.loadConversations()
        return
      }
      if (ev.type === 'delta') {
        m.content += ev.delta
        m.status = 'streaming'
      } else if (ev.type === 'done') {
        m.content = ev.content
        m.status = 'done'
        if (ev.meta) m.meta = ev.meta
      } else if (ev.type === 'stopped') {
        m.status = 'stopped'
        if (typeof ev.content === 'string') m.content = ev.content
      } else if (ev.type === 'error') {
        m.status = 'error'
      }
    }
  }
})
