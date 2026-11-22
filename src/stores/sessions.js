import { defineStore } from 'pinia'

// Agent 子会话看板：界面侧走「游标轮询 + 事件驱动」双通道。
// - 事件驱动的实时事件仍由各 store 的 on(...) 处理；
// - 这里是可按 seq 游标补齐的轮询快照，用于主窗隐藏/重载后恢复状态。
export const useSessionsStore = defineStore('sessions', {
  state: () => ({
    list: [],
    cursor: 0,
    lastPolledAt: 0,
    polling: false,
    timer: null,
    error: ''
  }),
  getters: {
    childrenOf: (state) => (parentId) => state.list.filter((s) => s.parentId === parentId),
    running(state) {
      return state.list.filter((s) => ['running', 'streaming', 'pending'].includes(s.status))
    },
    finished(state) {
      return state.list.filter((s) => ['done', 'stopped', 'error'].includes(s.status))
    }
  },
  actions: {
    async load() {
      try {
        this.list = (await window.api.sessions.list({ limit: 50 })) || []
        this.error = ''
      } catch (e) {
        this.error = String((e && e.message) || e)
      }
      return this.list
    },
    // 拉取游标之后的新事件；返回是否有遗漏（历史已滚动）
    async drain() {
      if (!window.api.events) return { events: [], truncated: false }
      const r = await window.api.events.since({ cursor: this.cursor, limit: 200 })
      this.cursor = r.seq || this.cursor
      this.lastPolledAt = Date.now()
      return r
    },
    startPolling(intervalMs = 3000) {
      if (this.timer) return
      this.polling = true
      this.timer = setInterval(async () => {
        try {
          await this.load()
        } catch {
          // 单次失败不终止轮询
        }
      }, intervalMs)
    },
    stopPolling() {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      this.polling = false
    }
  }
})
