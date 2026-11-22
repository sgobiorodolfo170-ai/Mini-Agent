import { defineStore } from 'pinia'

// GitHub 更新状态：主进程 updater 单向推送（updater:changed），
// 渲染层只做展示与触发检查，判定逻辑集中在 electron/main/updater.js。
export const useUpdaterStore = defineStore('updater', {
  state: () => ({
    available: false,
    behind: null,
    reason: 'idle',
    checkedAt: 0,
    error: null,
    current: null,
    latest: null,
    checking: false
  }),
  getters: {
    // 侧栏按钮的显示条件：仅当 GitHub 上确实有本地没有的提交
    shouldShow: (s) => !!s.available && !!s.latest,
    behindText: (s) => (s.behind > 0 ? `落后 ${s.behind} 个提交` : '有新提交')
  },
  actions: {
    apply(next) {
      if (!next || typeof next !== 'object') return
      this.available = !!next.available
      this.behind = next.behind == null ? null : next.behind
      this.reason = next.reason || 'unknown'
      this.checkedAt = next.checkedAt || 0
      this.error = next.error || null
      this.current = next.current || this.current
      this.latest = next.latest || null
    },
    async init() {
      if (!window.api || !window.api.updater) return
      this.apply(await window.api.updater.state())
    },
    async check(force = true) {
      if (!window.api || !window.api.updater) return
      this.checking = true
      try {
        this.apply(await window.api.updater.check({ force }))
      } finally {
        this.checking = false
      }
    }
  }
})
