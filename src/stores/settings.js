import { defineStore } from 'pinia'
import { plain } from '../common/plain'

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    settings: {},
    providers: [],
    info: null,
    autostart: false,
    hotkeys: { quick: 'Alt+Space', selection: 'Alt+Q', capture: 'Alt+S' },
    hotkeyReport: null,
    showBall: true,
    closeToTray: true,
    // 本地嵌入模型包（onnxruntime + BGE 中文系列）
    modelPackages: [],
    modelProgress: null, // { id, file, received, totalBytes, done, status, error }
    // 初始化完成前禁止表单提交，避免默认值覆盖已存配置（F09）
    initialized: false
  }),
  getters: {
    enabledProviders(state) {
      return state.providers.filter((p) => p.enabled)
    },
    downloadedModels(state) {
      return state.modelPackages.filter((p) => p.downloaded)
    }
  },
  actions: {
    async init() {
      this.settings = await window.api.settings.all()
      this.info = await window.api.app.info()
      this.autostart = await window.api.app.autostart()
      this.hotkeys = await window.api.app.hotkeys()
      this.showBall = this.settings.showBall !== false
      this.closeToTray = this.settings.closeToTray !== false
      await this.reloadProviders()
      this.initialized = true
    },
    async reloadProviders() {
      this.providers = await window.api.providers.list()
    },
    async set(key, value) {
      this.settings[key] = value
      await window.api.settings.set(key, plain(value))
    },
    async saveProvider(p) {
      await window.api.providers.save(plain(p))
      await this.reloadProviders()
    },
    async removeProvider(id) {
      await window.api.providers.remove(id)
      await this.reloadProviders()
    },
    async addKey(o) {
      await window.api.providers.addKey(plain(o))
      await this.reloadProviders()
    },
    async removeKey(id) {
      await window.api.providers.removeKey(id)
      await this.reloadProviders()
    },
    async probeKey(id) {
      const r = await window.api.providers.probeKey(id)
      await this.reloadProviders()
      return r
    },
    async probeAll(pid) {
      const r = await window.api.providers.probeAll(pid)
      await this.reloadProviders()
      return r
    },
    fetchModels(pid, baseUrl) {
      return window.api.providers.fetchModels(pid, plain(baseUrl))
    },
    async saveHotkeys(map) {
      this.hotkeyReport = await window.api.app.setHotkeys(plain(map))
      this.hotkeys = map
      return this.hotkeyReport
    },
    async setAutostart(v) {
      this.autostart = await window.api.app.setAutostart(v)
    },
    // ---------- 本地嵌入模型包 ----------
    async loadModels() {
      if (!window.api.models) return
      this.modelPackages = await window.api.models.list()
    },
    async downloadModel(id) {
      const r = await window.api.models.download(id)
      await this.loadModels()
      return r
    },
    async removeModel(id) {
      await window.api.models.remove(id)
      await this.loadModels()
    },
    // 主进程 models:progress 广播 → 下载进度条 + 完成后刷新包列表
    handleModelsProgress(p) {
      this.modelProgress = p
      if (p && (p.done || p.status === 'error')) {
        setTimeout(() => {
          if (this.modelProgress && this.modelProgress.id === p.id) this.modelProgress = null
        }, 1500)
        this.loadModels()
      }
    }
  }
})
