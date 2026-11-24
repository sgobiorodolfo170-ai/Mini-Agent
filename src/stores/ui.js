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

function clampBrowserPanelWidth(w) {
  const n = Number(w) || 480
  return Math.min(720, Math.max(360, n))
}

export const useUiStore = defineStore('ui', {
  state: () => ({
    view: 'chat',
    theme: 'dark',
    toasts: [],
    pendingAttachment: null,
    chatListVisible: true,
    chatListWidth: 240,
    browserPanelOpen: false,
    browserPanelWidth: 480,
    confirmState: null, // { title, message, impact, confirmText, danger, _resolve }
    settingsSection: 'model', // 设置页当前分组
    _media: null
  }),
  getters: {
    isToastSticky: () => (level) => level === 'error'
  },
  actions: {
    async init() {
      const t = await window.api.settings.get('theme')
      this.theme = t || 'dark'
      const [listVisible, listWidth, browserPanelOpen, browserPanelWidth] = await Promise.all([
        window.api.settings.get('chatListVisible'),
        window.api.settings.get('chatListWidth'),
        window.api.settings.get('browserPanelOpen'),
        window.api.settings.get('browserPanelWidth')
      ])
      this.chatListVisible = listVisible !== false
      this.chatListWidth = clampListWidth(listWidth)
      this.browserPanelOpen = browserPanelOpen === true
      this.browserPanelWidth = clampBrowserPanelWidth(browserPanelWidth)
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
    toggleChatList() {
      this.chatListVisible = !this.chatListVisible
      window.api.settings.set('chatListVisible', this.chatListVisible)
    },
    setChatListWidth(w) {
      this.chatListWidth = clampListWidth(w)
      window.api.settings.set('chatListWidth', this.chatListWidth)
    },
    toggleBrowserPanel() {
      this.browserPanelOpen = !this.browserPanelOpen
      window.api.settings.set('browserPanelOpen', this.browserPanelOpen)
    },
    setBrowserPanelWidth(w, persist = true) {
      this.browserPanelWidth = clampBrowserPanelWidth(w)
      if (persist) window.api.settings.set('browserPanelWidth', this.browserPanelWidth)
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
