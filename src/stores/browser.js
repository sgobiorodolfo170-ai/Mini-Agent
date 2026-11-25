import { defineStore } from 'pinia'

function applyState(store, state) {
  if (!state) return
  store.enabled = state.enabled !== false
  store.tabs = Array.isArray(state.tabs) ? state.tabs : []
  store.activeTabId = state.activeTabId || null
  store.attachedTabId = state.attachedTabId || null
  store.policy = state.policy || { allowPrivateNetwork: false, maxTabs: 6 }
}

export const useBrowserStore = defineStore('browser', {
  state: () => ({
    ready: false,
    enabled: true,
    tabs: [],
    activeTabId: null,
    attachedTabId: null,
    policy: { allowPrivateNetwork: false, maxTabs: 6 },
    attachOwner: null,
    lastEvent: null
  }),
  getters: {
    activeTab(state) {
      return state.tabs.find((tab) => tab.id === state.activeTabId) || null
    }
  },
  actions: {
    apply(state) {
      applyState(this, state)
    },
    async load() {
      const state = await window.api.browser.state()
      this.apply(state)
      this.ready = true
      return state
    },
    async setEnabled(enabled) {
      const state = await window.api.browser.setEnabled(enabled)
      this.apply(state)
      return state
    },
    async open(url = 'about:blank') {
      const tab = await window.api.browser.open({ url })
      await this.load()
      return tab
    },
    async navigate(url) {
      if (!this.activeTabId) return this.open(url)
      await window.api.browser.navigate({ tabId: this.activeTabId, url })
      return this.load()
    },
    async activate(tabId) {
      const state = await window.api.browser.activate(tabId)
      this.apply(state)
      return state
    },
    async close(tabId) {
      const state = await window.api.browser.close(tabId)
      this.apply(state)
      return state
    },
    async command(command) {
      if (!this.activeTabId) return null
      await window.api.browser.command(this.activeTabId, command)
      return this.load()
    },
    async toggleDevTools(tabId = this.activeTabId) {
      if (!tabId) return null
      const tab = await window.api.browser.toggleDevTools(tabId)
      await this.load()
      return tab
    },
    async selectElement(tabId = this.activeTabId) {
      if (!tabId) return null
      return window.api.browser.selectElement(tabId)
    },
    async cancelElementSelection(tabId = this.activeTabId) {
      if (!tabId) return null
      return window.api.browser.cancelElementSelection(tabId)
    },
    async inspectorState(tabId = this.activeTabId) {
      if (!tabId) return { selecting: false, selected: null }
      return window.api.browser.inspectorState(tabId)
    },
    async updateElementStyles(tabId, elementId, styles, resetProperties) {
      return window.api.browser.updateElementStyles(tabId, elementId, styles, resetProperties)
    },
    async resetElementStyles(tabId, elementId) {
      return window.api.browser.resetElementStyles(tabId, elementId)
    },
    async setDevice(tabId, device) {
      await window.api.browser.setDevice(tabId, device)
      return this.load()
    },
    async clearDevice(tabId) {
      await window.api.browser.clearDevice(tabId)
      return this.load()
    },
    async attach(tabId, bounds, options, owner = null) {
      const state = await window.api.browser.attach(tabId, bounds, options)
      if (owner) this.attachOwner = owner
      this.apply(state)
      return state
    },
    async detach(owner = null) {
      if (owner && this.attachOwner && this.attachOwner !== owner) return this.load()
      const state = await window.api.browser.detach()
      if (!owner || this.attachOwner === owner) this.attachOwner = null
      this.apply(state)
      return state
    },
    async takeover(tabId) {
      await window.api.browser.takeover(tabId)
      return this.load()
    },
    async release(tabId) {
      await window.api.browser.release(tabId)
      return this.load()
    },
    async screenshot() {
      return window.api.browser.screenshot(this.activeTabId)
    },
    async clearData() {
      await window.api.browser.clearData()
      return this.load()
    },
    handleEvent(event) {
      this.lastEvent = event || null
      if (event && event.state) this.apply(event.state)
    }
  }
})
