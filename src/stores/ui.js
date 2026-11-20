import { defineStore } from 'pinia'
import { useChatStore } from './chat'

function applyTheme(t) {
  const el = document.documentElement
  if (t === 'system') {
    el.classList.toggle('dark', window.matchMedia('(prefers-color-scheme: dark)').matches)
  } else {
    el.classList.toggle('dark', t === 'dark')
  }
}

function clampListWidth(w) {
  const n = Number(w) || 240
  return Math.min(320, Math.max(220, n))
}

export const useUiStore = defineStore('ui', {
  state: () => ({
    view: 'chat',
    theme: 'dark',
    toasts: [],
    pendingAttachment: null,
    // 会话详情默认收起（F01）；用户偏好持久化
    showDetails: false,
    detailsPinned: false,
    chatListVisible: true,
    chatListWidth: 240,
    confirmState: null, // { title, message, impact, confirmText, danger, _resolve }
    _media: null
  }),
  getters: {
    isToastSticky: () => (level) => level === 'error'
  },
  actions: {
    async init() {
      const t = await window.api.settings.get('theme')
      this.theme = t || 'dark'
      const [details, pinned, listVisible, listWidth] = await Promise.all([
        window.api.settings.get('chatDetailsOpen'),
        window.api.settings.get('chatDetailsPinned'),
        window.api.settings.get('chatListVisible'),
        window.api.settings.get('chatListWidth')
      ])
      this.showDetails = details === true
      this.detailsPinned = pinned === true
      this.chatListVisible = listVisible !== false
      this.chatListWidth = clampListWidth(listWidth)
      applyTheme(this.theme)
      this.watchSystemTheme()
    },
    // 跟随系统模式下监听系统主题变化（F22）
    watchSystemTheme() {
      if (this._media || typeof window.matchMedia !== 'function') return
      try {
        this._media = window.matchMedia('(prefers-color-scheme: dark)')
        if (typeof this._media.addEventListener === 'function') {
          this._media.addEventListener('change', () => {
            if (this.theme === 'system') applyTheme('system')
          })
        }
      } catch {
        this._media = null
      }
    },
    setTheme(t) {
      this.theme = t
      window.api.settings.set('theme', t)
      applyTheme(t)
    },
    setShowDetails(v) {
      this.showDetails = !!v
      window.api.settings.set('chatDetailsOpen', this.showDetails)
    },
    setDetailsPinned(v) {
      this.detailsPinned = !!v
      window.api.settings.set('chatDetailsPinned', this.detailsPinned)
    },
    toggleChatList() {
      this.chatListVisible = !this.chatListVisible
      window.api.settings.set('chatListVisible', this.chatListVisible)
    },
    setChatListWidth(w) {
      this.chatListWidth = clampListWidth(w)
      window.api.settings.set('chatListWidth', this.chatListWidth)
    },
    toast(message, level = 'info') {
      const id = Date.now() + Math.random()
      // 重要错误保留到用户手动关闭（F22）；其余 4 秒自动消失
      const sticky = level === 'error'
      this.toasts.push({ id, message, level, sticky })
      if (!sticky) {
        setTimeout(() => this.dismissToast(id), 4000)
      }
      return id
    },
    dismissToast(id) {
      this.toasts = this.toasts.filter((x) => x.id !== id)
    },
    // 删除等危险操作的统一确认入口（F04）；resolve(true) 仅在用户确认后发生
    confirm(opts = {}) {
      return new Promise((resolve) => {
        this.confirmState = {
          title: opts.title || '确认操作',
          message: opts.message || '',
          impact: opts.impact || '',
          confirmText: opts.confirmText || '删除',
          danger: opts.danger !== false,
          _resolve: resolve
        }
      })
    },
    resolveConfirm(v) {
      if (this.confirmState && this.confirmState._resolve) this.confirmState._resolve(v)
      this.confirmState = null
    },
    goChat(conversationId) {
      this.view = 'chat'
      if (conversationId) {
        const chat = useChatStore()
        chat.select(conversationId)
      }
    }
  }
})
